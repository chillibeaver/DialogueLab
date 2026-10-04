import type { Engine } from "../catalog";
import { ApiError } from "../errors";
import { base64ToBytes, bytesToBase64Url } from "../lib/base64";

/**
 * Google authentication for Workers (no Node SDK). Which credential works
 * depends on the engine, and this was established by testing against Google:
 *
 * - Chirp 3: HD accepts `GOOGLE_TTS_API_KEY` as the `key` query parameter.
 *   Preferred when set, since it costs no round trip.
 * - Gemini-TTS does not. Even though the request goes to the same
 *   `texttospeech.googleapis.com` endpoint, Google routes it to Vertex AI and
 *   checks `aiplatform.endpoints.predict`. An API key only identifies a
 *   project, so it cannot hold that role and the call fails 403
 *   ("API keys ... Expected OAuth2 access token or other authentication
 *   credentials that assert a principal"). Gemini therefore requires
 *   `GOOGLE_SERVICE_ACCOUNT_JSON`: sign an RS256 JWT with WebCrypto, exchange
 *   it for an OAuth access token, and keep the token in isolate memory until
 *   shortly before it expires.
 */

const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const TOKEN_LIFETIME_S = 3600;
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

interface ServiceAccount {
  client_email: string;
  private_key: string;
  private_key_id?: string;
  token_uri?: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

// Only settled values are cached. Sharing an in-flight promise across requests
// is unsafe on Workers (I/O started by one request can't be awaited by another).
const tokenCache = new Map<string, CachedToken>();

export function clearTokenCache(): void {
  tokenCache.clear();
}

/** How a Google request proves who it is. */
export type Credential = { kind: "apiKey"; value: string } | { kind: "bearer"; value: string };

function misconfigured(reason: string): ApiError {
  console.error(`GOOGLE_SERVICE_ACCOUNT_JSON: ${reason}`);
  return new ApiError(500, "server_misconfigured", "Google Cloud credentials are not configured correctly.");
}

export function parseServiceAccount(json: string | undefined): ServiceAccount {
  if (!json) throw misconfigured("secret is not set");
  let parsed: Partial<ServiceAccount>;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw misconfigured("secret is not valid JSON");
  }
  if (typeof parsed.client_email !== "string" || typeof parsed.private_key !== "string") {
    throw misconfigured("client_email or private_key is missing");
  }
  return parsed as ServiceAccount;
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      base64ToBytes(body),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch {
    throw misconfigured("private_key could not be imported");
  }
}

function encodeSegment(value: object): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

export async function createSignedJwt(account: ServiceAccount, nowSeconds: number): Promise<string> {
  const header = { alg: "RS256", typ: "JWT", ...(account.private_key_id ? { kid: account.private_key_id } : {}) };
  const claims = {
    iss: account.client_email,
    scope: SCOPE,
    aud: account.token_uri ?? DEFAULT_TOKEN_URI,
    iat: nowSeconds,
    exp: nowSeconds + TOKEN_LIFETIME_S,
  };
  const unsigned = `${encodeSegment(header)}.${encodeSegment(claims)}`;
  const key = await importPrivateKey(account.private_key);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

async function requestToken(account: ServiceAccount): Promise<CachedToken> {
  const assertion = await createSignedJwt(account, Math.floor(Date.now() / 1000));
  const response = await fetch(account.token_uri ?? DEFAULT_TOKEN_URI, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!response.ok) {
    console.error("Google token exchange failed", response.status, await response.text());
    throw new ApiError(502, "upstream_auth_failed", "Could not authenticate with Google Cloud.");
  }
  const body = (await response.json()) as { access_token: string; expires_in: number };
  return { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
}

/** Returns a valid access token for the service account in `json`, reusing a cached one when possible. */
export async function getAccessToken(json: string | undefined): Promise<string> {
  const account = parseServiceAccount(json);
  const cacheKey = `${account.client_email}#${account.private_key_id ?? ""}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt - REFRESH_MARGIN_MS > Date.now()) return cached.token;

  const fresh = await requestToken(account);
  tokenCache.set(cacheKey, fresh);
  return fresh.token;
}

/**
 * Picks the credential for `engine`.
 *
 * Chirp 3: HD prefers the API key (no round trip) and falls back to the service
 * account. Gemini-TTS only works with a service account, so a missing one is
 * reported as a configuration error rather than passed to Google as a 403.
 */
export async function resolveCredential(
  env: { GOOGLE_TTS_API_KEY?: string; GOOGLE_SERVICE_ACCOUNT_JSON?: string },
  engine: Engine,
): Promise<Credential> {
  const serviceAccount = env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();

  if (engine === "gemini") {
    if (!serviceAccount) {
      console.error("Gemini-TTS needs GOOGLE_SERVICE_ACCOUNT_JSON: an API key cannot hold roles/aiplatform.user");
      throw new ApiError(
        503,
        "engine_unavailable",
        "Gemini-TTS is not configured on this server. Use the chirp3-hd engine.",
      );
    }
    return { kind: "bearer", value: await getAccessToken(serviceAccount) };
  }

  const apiKey = env.GOOGLE_TTS_API_KEY?.trim();
  if (apiKey) return { kind: "apiKey", value: apiKey };

  if (!serviceAccount) {
    console.error("Neither GOOGLE_TTS_API_KEY nor GOOGLE_SERVICE_ACCOUNT_JSON is set");
    throw new ApiError(500, "server_misconfigured", "Google Cloud credentials are not configured correctly.");
  }
  return { kind: "bearer", value: await getAccessToken(serviceAccount) };
}

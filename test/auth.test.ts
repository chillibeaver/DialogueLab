import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../server/errors";
import { clearTokenCache, getAccessToken, resolveCredential } from "../server/google/auth";
import { makeServiceAccount, stubFetch } from "./helpers";

let account: Awaited<ReturnType<typeof makeServiceAccount>>;

beforeAll(async () => {
  account = await makeServiceAccount();
});

beforeEach(() => clearTokenCache());
afterEach(() => vi.unstubAllGlobals());

function decodeSegment(segment: string) {
  return JSON.parse(atob(segment.replace(/-/g, "+").replace(/_/g, "/")));
}

function base64UrlToBytes(segment: string) {
  const binary = atob(segment.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

describe("getAccessToken", () => {
  it("exchanges a correctly signed JWT for an access token", async () => {
    const fetches = stubFetch();
    expect(await getAccessToken(account.json)).toBe("token-abc");

    const [call] = fetches.tokenCalls();
    const body = call.body as Record<string, string>;
    expect(body.grant_type).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");

    const [header, claims, signature] = body.assertion.split(".");
    expect(decodeSegment(header)).toEqual({ alg: "RS256", typ: "JWT", kid: "key-1" });
    const payload = decodeSegment(claims);
    expect(payload.iss).toBe("tts@test-project.iam.gserviceaccount.com");
    expect(payload.aud).toBe("https://oauth2.googleapis.com/token");
    expect(payload.scope).toBe("https://www.googleapis.com/auth/cloud-platform");
    expect(payload.exp - payload.iat).toBe(3600);

    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      account.publicKey,
      base64UrlToBytes(signature),
      new TextEncoder().encode(`${header}.${claims}`),
    );
    expect(valid).toBe(true);
  });

  it("reuses the cached token until it is close to expiry", async () => {
    const fetches = stubFetch();
    await getAccessToken(account.json);
    await getAccessToken(account.json);
    expect(fetches.tokenCalls()).toHaveLength(1);

    clearTokenCache();
    stubFetch({ token: () => Response.json({ access_token: "short-lived", expires_in: 60 }) });
    await getAccessToken(account.json);
    const again = stubFetch();
    expect(await getAccessToken(account.json)).toBe("token-abc"); // 60s token is inside the refresh margin
    expect(again.tokenCalls()).toHaveLength(1);
  });

  it("reports a missing or broken secret as server misconfiguration", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(getAccessToken(undefined)).rejects.toMatchObject({ status: 500, code: "server_misconfigured" });
    await expect(getAccessToken("{not json")).rejects.toMatchObject({ code: "server_misconfigured" });
    await expect(
      getAccessToken(JSON.stringify({ client_email: "a@b", private_key: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----" })),
    ).rejects.toMatchObject({ code: "server_misconfigured" });
  });

  it("maps a rejected token exchange to a 502", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch({ token: () => Response.json({ error: "invalid_grant" }, { status: 400 }) });
    const error = await getAccessToken(account.json).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 502, code: "upstream_auth_failed" });
  });
});

describe("resolveCredential", () => {
  it("uses the API key for chirp3-hd, without a token exchange", async () => {
    const fetches = stubFetch();
    const credential = await resolveCredential({ GOOGLE_TTS_API_KEY: "  key-123  " }, "chirp3-hd");

    expect(credential).toEqual({ kind: "apiKey", value: "key-123" });
    expect(fetches.tokenCalls()).toHaveLength(0);
  });

  it("falls back to the service account for chirp3-hd when no API key is set", async () => {
    stubFetch();
    expect(await resolveCredential({ GOOGLE_SERVICE_ACCOUNT_JSON: account.json }, "chirp3-hd")).toEqual({
      kind: "bearer",
      value: "token-abc",
    });
  });

  it("ignores the API key for gemini, which Google rejects without a principal", async () => {
    stubFetch();
    expect(
      await resolveCredential({ GOOGLE_TTS_API_KEY: "key-123", GOOGLE_SERVICE_ACCOUNT_JSON: account.json }, "gemini"),
    ).toEqual({ kind: "bearer", value: "token-abc" });
  });

  it("reports gemini as unavailable when only an API key is configured", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(resolveCredential({ GOOGLE_TTS_API_KEY: "key-123" }, "gemini")).rejects.toMatchObject({
      status: 503,
      code: "engine_unavailable",
    });
  });

  it("reports missing credentials as server misconfiguration", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(resolveCredential({}, "chirp3-hd")).rejects.toMatchObject({
      status: 500,
      code: "server_misconfigured",
    });
  });
});

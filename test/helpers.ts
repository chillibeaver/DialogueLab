import { vi } from "vitest";

import type { Bindings } from "../server/config";

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Generates a throwaway RSA key and returns a service-account JSON string plus the public key. */
export async function makeServiceAccount() {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const pem = `-----BEGIN PRIVATE KEY-----\n${toBase64(pkcs8).replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----\n`;
  const json = JSON.stringify({
    type: "service_account",
    project_id: "test-project",
    private_key_id: "key-1",
    private_key: pem,
    client_email: "tts@test-project.iam.gserviceaccount.com",
    token_uri: "https://oauth2.googleapis.com/token",
  });
  return { json, publicKey: pair.publicKey };
}

export interface RecordedCall {
  url: string;
  body: unknown;
  headers: Headers;
}

type Handler = (call: RecordedCall) => Response | Promise<Response>;

/**
 * Stubs global fetch with per-host handlers and records every call.
 * Defaults: OAuth token exchange succeeds, TTS returns `audio`, Turnstile passes.
 */
export function stubFetch(overrides: { tts?: Handler; token?: Handler; turnstile?: Handler } = {}) {
  const calls: RecordedCall[] = [];
  let ttsCount = 0;
  const handlers: Record<string, Handler> = {
    "oauth2.googleapis.com": overrides.token ?? (() => Response.json({ access_token: "token-abc", expires_in: 3600 })),
    "texttospeech.googleapis.com":
      overrides.tts ??
      (() => Response.json({ audioContent: toBase64(new TextEncoder().encode(`audio-${++ttsCount}`)) })),
    "challenges.cloudflare.com": overrides.turnstile ?? (() => Response.json({ success: true })),
  };

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const rawBody = init?.body;
    let body: unknown = rawBody;
    if (typeof rawBody === "string") body = JSON.parse(rawBody);
    else if (rawBody instanceof URLSearchParams || rawBody instanceof FormData) body = Object.fromEntries(rawBody);
    const call = { url: url.toString(), body, headers: new Headers(init?.headers) };
    calls.push(call);
    const handler = handlers[url.hostname];
    if (!handler) throw new Error(`Unexpected fetch to ${url}`);
    return handler(call);
  });
  vi.stubGlobal("fetch", fetchMock);

  const callsTo = (host: string) => calls.filter((c) => new URL(c.url).hostname === host);
  return {
    calls,
    ttsCalls: () => callsTo("texttospeech.googleapis.com"),
    tokenCalls: () => callsTo("oauth2.googleapis.com"),
    turnstileCalls: () => callsTo("challenges.cloudflare.com"),
  };
}

/** Minimal in-memory stand-in for a KV namespace (only the methods the cache uses). */
export function fakeKv() {
  const store = new Map<string, { value: ArrayBuffer; metadata: unknown; ttl?: number }>();
  const kv = {
    async getWithMetadata(key: string) {
      const entry = store.get(key);
      return { value: entry?.value ?? null, metadata: entry?.metadata ?? null };
    },
    async put(key: string, value: Uint8Array, options: { expirationTtl?: number; metadata?: unknown }) {
      store.set(key, { value: value.slice().buffer, metadata: options.metadata, ttl: options.expirationTtl });
    },
  };
  return { kv: kv as unknown as KVNamespace, store };
}

export function fakeRateLimiter(allow: boolean) {
  const keys: string[] = [];
  const limiter = {
    async limit({ key }: { key: string }) {
      keys.push(key);
      return { success: allow };
    },
  };
  return { limiter: limiter as unknown as RateLimit, keys };
}

/** ExecutionContext stand-in that collects waitUntil promises so tests can await them. */
export function fakeExecutionContext() {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => void pending.push(promise),
    passThroughOnException: () => {},
    props: {},
  };
  return { ctx: ctx as unknown as ExecutionContext, settle: () => Promise.all(pending) };
}

export function baseEnv(serviceAccountJson: string, overrides: Partial<Bindings> = {}): Bindings {
  return {
    GOOGLE_SERVICE_ACCOUNT_JSON: serviceAccountJson,
    TURNSTILE_DISABLED: "true",
    DEFAULT_ENGINE: "chirp3-hd",
    DEFAULT_LANGUAGE: "fr-FR",
    MAX_CHARS: "5000",
    GOOGLE_TTS_ENDPOINT: "https://texttospeech.googleapis.com",
    CACHE_TTL_SECONDS: "2592000",
    ...overrides,
  };
}

import { ENGINES, type Engine } from "./catalog";

/**
 * Worker bindings used by the API. Declared here (instead of relying only on the
 * generated `Env`) so secrets and optional bindings are typed explicitly.
 */
export interface Bindings {
  // Secrets
  /** Chirp 3: HD only. Preferred when set: sent as the `key` query parameter. */
  GOOGLE_TTS_API_KEY?: string;
  GOOGLE_SERVICE_ACCOUNT_JSON?: string;
  TURNSTILE_SECRET_KEY?: string;
  /** Local development only: set to "true" in .dev.vars to skip Turnstile. */
  TURNSTILE_DISABLED?: string;

  /** Public Turnstile site key. Safe to send to the browser; empty disables the widget. */
  TURNSTILE_SITE_KEY?: string;

  // Plain vars (wrangler.jsonc)
  DEFAULT_ENGINE?: string;
  DEFAULT_LANGUAGE?: string;
  MAX_CHARS?: string;
  GOOGLE_TTS_ENDPOINT?: string;
  CACHE_TTL_SECONDS?: string;

  // Bindings (optional so the API degrades gracefully when one is missing)
  TTS_RATE_LIMITER?: RateLimit;
  TTS_CACHE?: KVNamespace;
}

export interface Config {
  defaultEngine: Engine;
  defaultLanguage: string;
  maxChars: number;
  googleEndpoint: string;
  cacheTtlSeconds: number;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function readConfig(env: Bindings): Config {
  const engine = env.DEFAULT_ENGINE as Engine | undefined;
  return {
    defaultEngine: engine && ENGINES.includes(engine) ? engine : "chirp3-hd",
    defaultLanguage: env.DEFAULT_LANGUAGE || "fr-FR",
    maxChars: positiveInt(env.MAX_CHARS, 5000),
    googleEndpoint: (env.GOOGLE_TTS_ENDPOINT || "https://texttospeech.googleapis.com").replace(/\/+$/, ""),
    // KV requires an expiration TTL of at least 60 seconds.
    cacheTtlSeconds: Math.max(60, positiveInt(env.CACHE_TTL_SECONDS, 2_592_000)),
  };
}

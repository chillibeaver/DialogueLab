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
  /**
   * Keys for the clips API, comma-separated, each "name:secret" (the name shows
   * in logs and quotas, so each collaborator can get, and lose, their own).
   */
  API_KEYS?: string;

  // Plain vars (wrangler.jsonc)
  DEFAULT_ENGINE?: string;
  DEFAULT_LANGUAGE?: string;
  MAX_CHARS?: string;
  GOOGLE_TTS_ENDPOINT?: string;
  CACHE_TTL_SECONDS?: string;
  /** Characters each API key may send to Google per UTC day. */
  API_DAILY_CHARS?: string;
  /** Subrequests (Google calls, KV and R2 operations) one request may make. */
  SUBREQUEST_BUDGET?: string;
  /** Canonical origin, such as https://tts.example.org; the request's origin when unset. */
  SITE_URL?: string;
  /** Most the site may spend at Google per month, in US dollars. Unset: no cap. */
  MONTHLY_BUDGET_USD?: string;
  /** Chirp 3: HD characters Google does not bill each month (its free tier). */
  CHIRP_FREE_CHARS?: string;

  // Bindings (optional so the API degrades gracefully when one is missing)
  /** The reader's limit, per client IP. */
  TTS_RATE_LIMITER?: RateLimit;
  /** The clips API's limit, per key; higher, for building pages with many clips. */
  CLIPS_RATE_LIMITER?: RateLimit;
  TTS_CACHE?: KVNamespace;
  /** Published clips: permanent audio files behind public URLs. */
  CLIPS?: R2Bucket;
  /** The monthly spending ledger (workers/budget.ts); required when MONTHLY_BUDGET_USD is set. */
  BUDGET?: DurableObjectNamespace;
}

export interface Config {
  defaultEngine: Engine;
  defaultLanguage: string;
  maxChars: number;
  googleEndpoint: string;
  cacheTtlSeconds: number;
  apiDailyChars: number;
  subrequestBudget: number;
  /** Null when no monthly budget is set. */
  monthlyBudgetMicros: number | null;
  chirpFreeChars: number;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** A budget in dollars, as micro-dollars; null when unset or not a number. "0" is a valid budget. */
function dollarsToMicros(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 1e6) : null;
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
    // About US$6 a day on Chirp 3: HD, US$30 per million characters.
    apiDailyChars: positiveInt(env.API_DAILY_CHARS, 200_000),
    // The Workers free plan allows 50 per request; raise to ~9000 on a paid plan.
    subrequestBudget: positiveInt(env.SUBREQUEST_BUDGET, 40),
    monthlyBudgetMicros: dollarsToMicros(env.MONTHLY_BUDGET_USD),
    // "0" means none are free, e.g. when other projects share the billing account.
    chirpFreeChars: env.CHIRP_FREE_CHARS === "0" ? 0 : positiveInt(env.CHIRP_FREE_CHARS, 1_000_000),
  };
}

import type { Bindings } from "./config";
import { ApiError } from "./errors";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Per-IP limit via the Workers Rate Limiting binding. Skipped when the binding is absent. */
export async function enforceRateLimit(limiter: RateLimit | undefined, clientIp: string): Promise<void> {
  if (!limiter) return;
  const { success } = await limiter.limit({ key: clientIp });
  if (!success) {
    throw new ApiError(429, "rate_limited", "Too many requests. Please wait a minute and try again.", {
      headers: { "retry-after": "60" },
    });
  }
}

/**
 * Verifies a Cloudflare Turnstile token (sent by the browser in `X-Turnstile-Token`).
 * Fails closed: without TURNSTILE_SECRET_KEY every request is refused, unless
 * TURNSTILE_DISABLED=true is set (intended for local development only).
 */
export async function verifyTurnstile(env: Bindings, token: string | undefined, clientIp: string): Promise<void> {
  if (env.TURNSTILE_DISABLED === "true") return;
  if (!env.TURNSTILE_SECRET_KEY) {
    console.error("TURNSTILE_SECRET_KEY is not set; refusing synthesis requests");
    throw new ApiError(500, "server_misconfigured", "Bot protection is not configured on the server.");
  }
  if (!token) {
    throw new ApiError(403, "turnstile_required", "Missing Turnstile token (X-Turnstile-Token header).");
  }

  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET_KEY);
  form.append("response", token);
  if (clientIp !== "unknown") form.append("remoteip", clientIp);

  let outcome: { success?: boolean; "error-codes"?: string[] };
  try {
    const response = await fetch(SITEVERIFY_URL, { method: "POST", body: form });
    outcome = await response.json();
  } catch (error) {
    console.error("Turnstile siteverify request failed", error);
    throw new ApiError(503, "turnstile_unavailable", "Bot protection check is unavailable. Try again shortly.");
  }
  if (!outcome.success) {
    console.warn("Turnstile rejected token", outcome["error-codes"]);
    throw new ApiError(403, "turnstile_failed", "Bot protection check failed. Refresh the challenge and try again.");
  }
}

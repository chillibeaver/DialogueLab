import type { GeminiModel } from "./catalog";
import type { Bindings, Config } from "./config";
import { ApiError } from "./errors";
import type { SynthesisOptions } from "./google/tts";

/**
 * A hard cap on what the site spends at Google each month.
 *
 * The API key and the service account live only in this Worker, so every
 * synthesis passes through it. Before calling Google, a request reserves the
 * cost of what it is about to synthesize in a ledger (one Durable Object, so
 * reservations are checked and recorded one at a time, however many requests
 * arrive at once); once the month's budget is spent, nothing new is
 * synthesized until the next month. Cached audio and published clips cost
 * nothing and keep playing.
 *
 * Costs are estimated from Google's list prices, rounding up where the real
 * figure is only known afterwards, so the real bill stays at or under the cap.
 */

/** What a month has used: Chirp 3: HD characters, and Gemini-TTS spend in millionths of a US dollar. */
export interface Usage {
  chirpChars: number;
  geminiMicros: number;
}

/** What one synthesis will use, in the same units. */
export type Cost = Usage;

export interface BudgetLimits {
  budgetMicros: number;
  /** Chirp 3: HD characters each month that Google does not bill. */
  chirpFreeChars: number;
}

/** The ledger's methods, as the Worker calls them (implemented by workers/budget.ts). */
export interface BudgetLedger {
  reserve(month: string, costs: Cost[], limits: BudgetLimits): Promise<{ granted: number; spentMicros: number }>;
  refund(month: string, costs: Cost[]): Promise<void>;
}

// Google's list prices, from cloud.google.com/text-to-speech/pricing (October 2026).

/** Chirp 3: HD: US$30 per million characters, past the month's free characters. */
const CHIRP_MICROS_PER_CHAR = 30;

/** Gemini-TTS: US$ per million tokens, which is micro-dollars per token. There is no free tier. */
const GEMINI_PRICES: Record<GeminiModel, { input: number; audio: number }> = {
  "gemini-2.5-flash-tts": { input: 0.5, audio: 10 },
  "gemini-2.5-flash-lite-preview-tts": { input: 0.5, audio: 10 },
  "gemini-2.5-pro-tts": { input: 1, audio: 20 },
  "gemini-3.1-flash-tts-preview": { input: 1, audio: 20 },
};

/**
 * Gemini bills the audio it returns, at 25 tokens per second, which is known
 * only afterwards. Speech runs at about 15 characters a second; assuming a
 * slow 10 gives 2.5 audio tokens per character. Text tokens run near 4
 * characters each; assume 2. Both err towards spending less than the cap.
 */
const AUDIO_TOKENS_PER_CHAR = 2.5;
const TEXT_TOKENS_PER_CHAR = 0.5;

const EMPTY: Usage = { chirpChars: 0, geminiMicros: 0 };

/**
 * What synthesizing `characters` will cost. A Gemini style prompt is sent,
 * and billed, with each of the `calls` the text is split into.
 */
export function estimateCost(options: SynthesisOptions, characters: number, calls = 1): Cost {
  if (options.engine === "chirp3-hd") return { chirpChars: characters, geminiMicros: 0 };
  const price = GEMINI_PRICES[options.model] ?? { input: 1, audio: 20 };
  const promptChars = options.prompt ? Array.from(options.prompt).length * calls : 0;
  const micros =
    characters * AUDIO_TOKENS_PER_CHAR * price.audio + (characters + promptChars) * TEXT_TOKENS_PER_CHAR * price.input;
  return { chirpChars: 0, geminiMicros: Math.ceil(micros) };
}

export function addCosts(costs: readonly Cost[]): Cost {
  return costs.reduce(
    (sum, cost) => ({ chirpChars: sum.chirpChars + cost.chirpChars, geminiMicros: sum.geminiMicros + cost.geminiMicros }),
    EMPTY,
  );
}

/** What Google bills for a month's usage, in micro-dollars. */
export function spentMicros(usage: Usage, limits: BudgetLimits): number {
  return Math.max(0, usage.chirpChars - limits.chirpFreeChars) * CHIRP_MICROS_PER_CHAR + usage.geminiMicros;
}

/**
 * Grants `costs` in order, for as long as the month stays within budget: the
 * longest prefix that fits. Returns how many, and the usage with them.
 */
export function grant(usage: Usage, costs: readonly Cost[], limits: BudgetLimits): { granted: number; usage: Usage } {
  let next = usage;
  let granted = 0;
  for (const cost of costs) {
    const candidate = addCosts([next, cost]);
    if (spentMicros(candidate, limits) > limits.budgetMicros) break;
    next = candidate;
    granted++;
  }
  return { granted, usage: next };
}

/** Gives back reserved costs that were not spent, because Google failed. */
export function refund(usage: Usage, costs: readonly Cost[]): Usage {
  const back = addCosts(costs);
  return {
    chirpChars: Math.max(0, usage.chirpChars - back.chirpChars),
    geminiMicros: Math.max(0, usage.geminiMicros - back.geminiMicros),
  };
}

/** Google bills by calendar month in US Pacific time; its free characters reset with it. */
export function billingMonth(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${part("year")}-${part("month")}`;
}

/** The first day of the month after `month` ("2026-10" gives "2026-11-01"). */
export function nextMonthStart(month: string): string {
  const [year, m] = month.split("-").map(Number);
  return m === 12 ? `${year + 1}-01-01` : `${year}-${String(m + 1).padStart(2, "0")}-01`;
}

/* ---------- the Worker's side ---------- */

const limitsOf = (config: Config): BudgetLimits => ({
  budgetMicros: config.monthlyBudgetMicros!,
  chirpFreeChars: config.chirpFreeChars,
});

/** The ledger, or null when no budget is set. A budget without its ledger fails closed. */
function ledgerOf(env: Bindings, config: Config): BudgetLedger | null {
  if (config.monthlyBudgetMicros === null) return null;
  if (!env.BUDGET) {
    console.error("MONTHLY_BUDGET_USD is set but the BUDGET Durable Object binding is missing");
    throw new ApiError(503, "budget_unavailable", "Spending protection is not configured on the server.");
  }
  return env.BUDGET.get(env.BUDGET.idFromName("site")) as unknown as BudgetLedger;
}

/**
 * Reserves `costs` in order and returns how many fit in this month's budget.
 * Every cost granted must be spent at Google or given back with
 * `refundBudget`. If the ledger cannot be reached, nothing is synthesized.
 */
export async function reserveBudget(env: Bindings, config: Config, costs: readonly Cost[]): Promise<number> {
  const ledger = ledgerOf(env, config);
  if (!ledger || !costs.length) return costs.length;
  const month = billingMonth();
  let result: { granted: number; spentMicros: number };
  try {
    result = await ledger.reserve(month, [...costs], limitsOf(config));
  } catch (error) {
    console.error("Budget reservation failed", error);
    throw new ApiError(503, "budget_unavailable", "Spending protection is unavailable. Try again shortly.");
  }
  const dollars = (micros: number) => `US$${(micros / 1e6).toFixed(4)}`;
  console.log(
    `Budget ${month}: ${dollars(result.spentMicros)} of ${dollars(config.monthlyBudgetMicros!)}, ` +
      `${result.granted} of ${costs.length} granted`,
  );
  return result.granted;
}

/** Best effort: a refund that fails leaves the month counted as spent, which only errs low. */
export async function refundBudget(env: Bindings, config: Config, costs: readonly Cost[]): Promise<void> {
  if (!costs.length) return;
  try {
    const ledger = ledgerOf(env, config);
    await ledger?.refund(billingMonth(), [...costs]);
  } catch (error) {
    console.warn("Budget refund failed", error);
  }
}

export function budgetExhausted(): ApiError {
  const resetsAt = nextMonthStart(billingMonth());
  return new ApiError(
    429,
    "budget_exhausted",
    `This site has used its budget for new audio this month. Audio made before still plays; new lines can be made again from ${resetsAt}.`,
    { details: { resetsAt } },
  );
}

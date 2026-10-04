import type { Context } from "hono";

import type { Credential } from "./google/auth";
import { synthesizeChunk, type SynthesisOptions } from "./google/tts";
import { concatAudio } from "./lib/audio";
import { splitText } from "./lib/chunk";

/** Per-request text limits are 5,000 bytes (Chirp 3: HD) and 4,000 bytes (Gemini-TTS); keep a margin. */
export const CHUNK_BYTES = { "chirp3-hd": 4500, gemini: 3800 } as const;

/** Parallel Google requests per synthesis (keeps well under subrequest and RPM limits). */
export const SYNTHESIS_CONCURRENCY = 4;

export const MAX_BODY_BYTES = 64 * 1024;

/** Lets a cache or storage write finish after the response is sent. */
export function runInBackground(c: Context, task: Promise<unknown>): void {
  try {
    c.executionCtx.waitUntil(task);
  } catch {
    // No ExecutionContext (e.g. unit tests): the task still runs, just unawaited.
  }
}

export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Google calls a text needs: one per chunk that fits the engine's request limit. */
export function synthesisCalls(text: string, options: SynthesisOptions): number {
  return splitText(text, CHUNK_BYTES[options.engine], options.language).length;
}

/** Synthesizes text of any length: split into chunks Google accepts, synthesized in order, joined. */
export async function synthesizeText(
  text: string,
  options: SynthesisOptions,
  context: { endpoint: string; credential: Credential },
): Promise<Uint8Array<ArrayBuffer>> {
  const audio: Uint8Array<ArrayBuffer>[] = [];
  for (const chunk of splitText(text, CHUNK_BYTES[options.engine], options.language)) {
    audio.push(await synthesizeChunk({ kind: "text", text: chunk }, options, context));
  }
  return concatAudio(options.format, audio);
}

/**
 * Subrequests every request may need besides its items: the Turnstile check,
 * an OAuth token exchange, and the spending ledger's reservation and refund
 * in the last wave (server/budget.ts; earlier waves count theirs as they go).
 * Calls to Google, to the ledger, and every KV or R2 operation count toward
 * the Workers limit of 50 per request on the free plan (10,000 on paid), so
 * each endpoint spends a budget and returns the rest of its work as pending,
 * for the client to ask again.
 */
export const BUDGET_OVERHEAD = 4;

/**
 * Runs `items` in order, in waves, while the budget lasts. Each wave reserves
 * the worst case per item (`worstCost`); `run` returns what the wave really
 * spent, and whatever a cheap wave saved (cache hits, clips that already
 * exist) funds the next one. Returns how many items were run; the caller must
 * treat 0 as "the first item alone is over budget", or clients would loop.
 */
export async function withinBudget<T>(
  items: readonly T[],
  budget: number,
  worstCost: (item: T) => number,
  run: (wave: T[]) => Promise<number>,
): Promise<number> {
  let left = budget;
  let next = 0;
  while (next < items.length) {
    const wave: T[] = [];
    let reserved = 0;
    while (next < items.length && reserved + worstCost(items[next]) <= left) {
      reserved += worstCost(items[next]);
      wave.push(items[next++]);
    }
    if (!wave.length) break;
    left -= await run(wave);
  }
  return next;
}

import type { Context } from "hono";

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

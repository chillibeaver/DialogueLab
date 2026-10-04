import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";

import { buildCatalog } from "./catalog-view";
import { readConfig, type Bindings } from "./config";
import { ApiError, errorResponse, handleError } from "./errors";
import { resolveCredential, type Credential } from "./google/auth";
import { AUDIO_FORMATS, synthesizeChunk, type AudioFormat, type SynthesisPayload } from "./google/tts";
import { concatAudio } from "./lib/audio";
import { bytesToBase64 } from "./lib/base64";
import { cacheKey, readCachedAudio, writeCachedAudio, type CachedAudioMeta } from "./lib/cache";
import { splitText } from "./lib/chunk";
import { enforceRateLimit, verifyTurnstile } from "./protection";
import { parseBatchRequest, parseTtsRequest } from "./request";

type AppEnv = { Bindings: Bindings };

/** Per-request text limits are 5,000 bytes (Chirp 3: HD) and 4,000 bytes (Gemini-TTS); keep a margin. */
const CHUNK_BYTES = { "chirp3-hd": 4500, gemini: 3800 } as const;
/** Parallel Google requests per synthesis (keeps well under subrequest and RPM limits). */
const SYNTHESIS_CONCURRENCY = 4;
const MAX_BODY_BYTES = 64 * 1024;

export const api = new Hono<AppEnv>();
api.onError(handleError);

api.get("/health", (c) => c.json({ ok: true }));

api.get("/catalog", (c) => {
  const catalog = buildCatalog(readConfig(c.env));
  return c.json(catalog, 200, { "cache-control": "public, max-age=3600" });
});

api.post(
  "/tts",
  bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => errorResponse(c, new ApiError(413, "payload_too_large", "Request body is too large.")),
  }),
  async (c) => {
    const config = readConfig(c.env);
    const clientIp = c.req.header("cf-connecting-ip") ?? "unknown";

    await enforceRateLimit(c.env.TTS_RATE_LIMITER, clientIp);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new ApiError(400, "invalid_json", "Request body must be a JSON object.");
    }
    const { payload, characters, options } = parseTtsRequest(body, config);

    // A dialogue is one Google request; only plain text is split and rejoined.
    const parts: SynthesisPayload[] =
      payload.kind === "dialogue"
        ? [payload]
        : splitText(payload.text, CHUNK_BYTES[options.engine], options.language).map((text) => ({
            kind: "text" as const,
            text,
          }));
    if (options.format === "ogg_opus" && parts.length > 1) {
      throw new ApiError(
        413,
        "text_too_long_for_format",
        `ogg_opus output is limited to about ${CHUNK_BYTES[options.engine]} bytes of text. Use mp3 or wav for longer text.`,
      );
    }

    // Validate everything cheap first: a Turnstile token can only be redeemed once.
    await verifyTurnstile(c.env, c.req.header("x-turnstile-token"), clientIp);

    const key = await cacheKey({ ...options, payload });
    const cached = await readCachedAudio(c.env.TTS_CACHE, key);
    if (cached) return audioResponse(cached.audio, options.format, cached.meta, "HIT");

    const credential = await resolveCredential(c.env, options.engine);
    const audioParts = await mapWithConcurrency(parts, SYNTHESIS_CONCURRENCY, (part) =>
      synthesizeChunk(part, options, { endpoint: config.googleEndpoint, credential }),
    );
    const audio = concatAudio(options.format, audioParts);
    const meta: CachedAudioMeta = { chunks: parts.length, characters };

    runInBackground(c, writeCachedAudio(c.env.TTS_CACHE, key, audio, meta, config.cacheTtlSeconds));
    return audioResponse(audio, options.format, meta, "MISS");
  },
);

/**
 * Synthesizes many short lines in one call. A reader plays a script line by
 * line; doing that as one request per line would exhaust the per-IP rate limit
 * within seconds, so the whole script is one request and one rate-limit unit.
 * Each line is cached on its own, so editing one line only re-bills that line.
 */
api.post(
  "/tts/batch",
  bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => errorResponse(c, new ApiError(413, "payload_too_large", "Request body is too large.")),
  }),
  async (c) => {
    const config = readConfig(c.env);
    const clientIp = c.req.header("cf-connecting-ip") ?? "unknown";

    await enforceRateLimit(c.env.TTS_RATE_LIMITER, clientIp);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new ApiError(400, "invalid_json", "Request body must be a JSON object.");
    }
    const { items, characters } = parseBatchRequest(body, config);

    await verifyTurnstile(c.env, c.req.header("x-turnstile-token"), clientIp);

    const keys = await Promise.all(items.map((item) => cacheKey({ ...item.options, payload: item.payload })));
    const cached = await Promise.all(keys.map((key) => readCachedAudio(c.env.TTS_CACHE, key)));

    // Only the misses reach Google, and only once per distinct line.
    const pending = items.map((_, index) => index).filter((index) => !cached[index]);
    let credential: Credential | undefined;
    if (pending.length > 0) credential = await resolveCredential(c.env, items[0].options.engine);

    const fresh = new Map<number, Uint8Array<ArrayBuffer>>();
    await mapWithConcurrency(pending, SYNTHESIS_CONCURRENCY, async (index) => {
      const { payload, options } = items[index];
      const audio = await synthesizeChunk(payload, options, {
        endpoint: config.googleEndpoint,
        credential: credential!,
      });
      fresh.set(index, audio);
      const meta: CachedAudioMeta = { chunks: 1, characters: items[index].characters };
      runInBackground(c, writeCachedAudio(c.env.TTS_CACHE, keys[index], audio, meta, config.cacheTtlSeconds));
    });

    const format = items[0].options.format;
    return c.json({
      format,
      contentType: AUDIO_FORMATS[format].contentType,
      characters,
      synthesized: pending.length,
      items: items.map((item, index) => {
        const hit = cached[index];
        const audio = hit ? new Uint8Array(hit.audio) : fresh.get(index)!;
        return { audio: bytesToBase64(audio), characters: item.characters, cache: hit ? "HIT" : "MISS" };
      }),
    });
  },
);

// Unknown /api/* paths get a JSON 404 instead of falling through to the page renderer.
api.all("*", () => {
  throw new ApiError(404, "not_found", "Unknown API endpoint.");
});

function audioResponse(
  audio: ArrayBuffer | Uint8Array<ArrayBuffer>,
  format: AudioFormat,
  meta: CachedAudioMeta,
  cacheStatus: "HIT" | "MISS",
): Response {
  const { contentType, extension } = AUDIO_FORMATS[format];
  return new Response(audio, {
    headers: {
      "content-type": contentType,
      "content-disposition": `inline; filename="speech.${extension}"`,
      "x-tts-characters": String(meta.characters),
      "x-tts-chunks": String(meta.chunks),
      "x-cache": cacheStatus,
    },
  });
}

function runInBackground(c: Context, task: Promise<unknown>): void {
  try {
    c.executionCtx.waitUntil(task);
  } catch {
    // No ExecutionContext (e.g. unit tests): the task still runs, just unawaited.
  }
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
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

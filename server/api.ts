import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import { buildCatalog } from "./catalog-view";
import { clips } from "./clips";
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
import {
  BUDGET_OVERHEAD,
  CHUNK_BYTES,
  MAX_BODY_BYTES,
  mapWithConcurrency,
  runInBackground,
  SYNTHESIS_CONCURRENCY,
  synthesisCalls,
  synthesizeText,
  withinBudget,
} from "./synthesis";

type AppEnv = { Bindings: Bindings };


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

    const format = items[0].options.format;
    const engine = items[0].options.engine;
    const textOf = (item: (typeof items)[number]) => (item.payload.kind === "text" ? item.payload.text : "");

    // Each distinct line once, in order: the client sends lines in playback order.
    const work: { indexes: number[]; key: string; calls: number }[] = [];
    const byKey = new Map<string, (typeof work)[number]>();
    for (const [index, item] of items.entries()) {
      const key = await cacheKey({ ...item.options, payload: item.payload });
      const existing = byKey.get(key);
      if (existing) {
        existing.indexes.push(index);
        continue;
      }
      const entry = { indexes: [index], key, calls: synthesisCalls(textOf(item), item.options) };
      byKey.set(key, entry);
      work.push(entry);
    }
    if (format === "ogg_opus" && work.some((w) => w.calls > 1)) {
      throw new ApiError(413, "text_too_long_for_format", "A line is too long for ogg_opus. Use mp3 or wav.");
    }

    await verifyTurnstile(c.env, c.req.header("x-turnstile-token"), clientIp);

    const audio = new Map<string, { bytes: Uint8Array<ArrayBuffer>; cache: "HIT" | "MISS" }>();
    let credential: Credential | undefined;
    const done = await withinBudget(
      work,
      config.subrequestBudget - BUDGET_OVERHEAD,
      (w) => 1 + w.calls + 1, // cache read, Google calls, cache write
      async (wave) => {
        const hits = await Promise.all(wave.map((w) => readCachedAudio(c.env.TTS_CACHE, w.key)));
        wave.forEach((w, i) => hits[i] && audio.set(w.key, { bytes: new Uint8Array(hits[i].audio), cache: "HIT" }));
        const misses = wave.filter((_, i) => !hits[i]);
        if (misses.length) credential ??= await resolveCredential(c.env, engine);
        await mapWithConcurrency(misses, SYNTHESIS_CONCURRENCY, async (w) => {
          const item = items[w.indexes[0]];
          const bytes = await synthesizeText(textOf(item), item.options, {
            endpoint: config.googleEndpoint,
            credential: credential!,
          });
          audio.set(w.key, { bytes, cache: "MISS" });
          const meta: CachedAudioMeta = { chunks: w.calls, characters: item.characters };
          runInBackground(c, writeCachedAudio(c.env.TTS_CACHE, w.key, bytes, meta, config.cacheTtlSeconds));
        });
        return wave.length + misses.reduce((n, w) => n + w.calls + 1, 0);
      },
    );
    if (done === 0) {
      console.error(`SUBREQUEST_BUDGET ${config.subrequestBudget} cannot fit a single line`);
      throw new ApiError(500, "server_misconfigured", "The server's subrequest budget is too small.");
    }

    const ready = (index: number) => audio.get(work.find((w) => w.indexes.includes(index))!.key);
    const results = items.map((item, index) => {
      const clip = ready(index);
      return clip
        ? { status: "ready", audio: bytesToBase64(clip.bytes), characters: item.characters, cache: clip.cache }
        : { status: "pending", characters: item.characters };
    });
    return c.json({
      format,
      contentType: AUDIO_FORMATS[format].contentType,
      characters,
      synthesized: [...audio.values()].filter((a) => a.cache === "MISS").length,
      // Lines past the budget: send them again.
      complete: done === work.length,
      pending: results.filter((r) => r.status === "pending").length,
      items: results,
    });
  },
);

// Clips: audio for pages built elsewhere, made once with an API key and served from permanent URLs.
api.route("/v1", clips);

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

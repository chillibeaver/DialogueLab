import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";

import { DEFAULT_GEMINI_MODEL, DEFAULT_VOICE, GEMINI_MODELS, listLanguages, VOICES } from "./catalog";
import { readConfig, type Bindings } from "./config";
import { ApiError, errorResponse, handleError } from "./errors";
import { getAccessToken } from "./google/auth";
import { AUDIO_FORMATS, synthesizeChunk, type AudioFormat } from "./google/tts";
import { concatAudio } from "./lib/audio";
import { cacheKey, readCachedAudio, writeCachedAudio, type CachedAudioMeta } from "./lib/cache";
import { splitText } from "./lib/chunk";
import { enforceRateLimit, verifyTurnstile } from "./protection";
import { MAX_PROMPT_CHARS, parseTtsRequest, SPEAKING_RATE } from "./request";

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
  const config = readConfig(c.env);
  const catalog = {
    defaults: { engine: config.defaultEngine, language: config.defaultLanguage, format: "mp3" },
    limits: { maxChars: config.maxChars, maxPromptChars: MAX_PROMPT_CHARS },
    formats: Object.keys(AUDIO_FORMATS),
    voices: VOICES,
    engines: {
      "chirp3-hd": {
        name: "Chirp 3: HD",
        defaultVoice: DEFAULT_VOICE["chirp3-hd"],
        speakingRate: SPEAKING_RATE,
        languages: listLanguages("chirp3-hd", config.defaultLanguage),
      },
      gemini: {
        name: "Gemini-TTS",
        defaultVoice: DEFAULT_VOICE.gemini,
        defaultModel: DEFAULT_GEMINI_MODEL,
        models: Object.entries(GEMINI_MODELS).map(([id, availability]) => ({ id, availability })),
        languages: listLanguages("gemini", config.defaultLanguage),
      },
    },
  };
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
    const { text, characters, options } = parseTtsRequest(body, config);

    const chunks = splitText(text, CHUNK_BYTES[options.engine], options.language);
    if (options.format === "ogg_opus" && chunks.length > 1) {
      throw new ApiError(
        413,
        "text_too_long_for_format",
        `ogg_opus output is limited to about ${CHUNK_BYTES[options.engine]} bytes of text. Use mp3 or wav for longer text.`,
      );
    }

    // Validate everything cheap first: a Turnstile token can only be redeemed once.
    await verifyTurnstile(c.env, c.req.header("x-turnstile-token"), clientIp);

    const key = await cacheKey({ ...options, text });
    const cached = await readCachedAudio(c.env.TTS_CACHE, key);
    if (cached) return audioResponse(cached.audio, options.format, cached.meta, "HIT");

    const accessToken = await getAccessToken(c.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const parts = await mapWithConcurrency(chunks, SYNTHESIS_CONCURRENCY, (chunk) =>
      synthesizeChunk(chunk, options, { endpoint: config.googleEndpoint, accessToken }),
    );
    const audio = concatAudio(options.format, parts);
    const meta: CachedAudioMeta = { chunks: chunks.length, characters };

    runInBackground(c, writeCachedAudio(c.env.TTS_CACHE, key, audio, meta, config.cacheTtlSeconds));
    return audioResponse(audio, options.format, meta, "MISS");
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

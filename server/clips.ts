import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { z } from "zod";

import {
  DEFAULT_GEMINI_MODEL,
  DEFAULT_VOICE,
  ENGINES,
  GEMINI_MODELS,
  resolveLanguage,
  resolveVoice,
  type Engine,
  type GeminiModel,
} from "./catalog";
import { readConfig, type Bindings, type Config } from "./config";
import { ApiError, errorResponse, handleError } from "./errors";
import { resolveCredential, type Credential } from "./google/auth";
import type { SynthesisOptions } from "./google/tts";
import { authenticate } from "./keys";
import { concatAudio } from "./lib/audio";
import { splitText } from "./lib/chunk";
import { enforceRateLimit } from "./protection";
import { BATCH, invalid, MAX_PROMPT_CHARS, normalize, SPEAKING_RATE, tooLong, unsupportedLanguage } from "./request";
import {
  BUDGET_OVERHEAD,
  CHUNK_BYTES,
  mapWithConcurrency,
  runInBackground,
  SYNTHESIS_CONCURRENCY,
  synthesizeText,
  withinBudget,
} from "./synthesis";

/**
 * Clips: audio for pages built elsewhere, such as a course's HTML exercises.
 *
 * Synthesis happens once, at authoring time, with an API key:
 * `POST /api/v1/clips` turns sentences (or whole dialogues) into permanent
 * clips and returns a URL for each. The page then only ever plays those URLs:
 * `GET /api/v1/clips/<id>.mp3` is public, never calls Google, and is cached by
 * browsers for a year. So the key never has to appear in a page, and a student
 * pressing play a hundred times costs nothing.
 *
 * A clip's id is a hash of everything that shapes its sound, so the same
 * request always yields the same URL and asking again is free. Clips live in
 * R2 without expiry: unlike the 30-day synthesis cache, a published exercise
 * must keep working.
 */

export const CLIPS = {
  /** Items per request. Fewer than a batch, because each also costs a storage lookup. */
  maxItems: 100,
  maxTurns: 100,
  maxBodyBytes: 256 * 1024,
} as const;

const IMMUTABLE = "public, max-age=31536000, immutable";
const objectKey = (id: string) => `clips/v1/${id}.mp3`;

const rate = z.number().min(SPEAKING_RATE.min).max(SPEAKING_RATE.max);
const prompt = z.string().max(MAX_PROMPT_CHARS);

const turnSchema = z.strictObject({
  text: z.string(),
  voice: z.string().optional(),
  prompt: prompt.optional(),
  speakingRate: rate.optional(),
});

const itemSchema = z.strictObject({
  ref: z.string().max(200).optional(),
  text: z.string().optional(),
  turns: z.array(turnSchema).min(1).max(CLIPS.maxTurns).optional(),
  voice: z.string().optional(),
  prompt: prompt.optional(),
  speakingRate: rate.optional(),
});

const requestSchema = z.strictObject({
  engine: z.enum(ENGINES).optional(),
  language: z.string().optional(),
  model: z.enum(Object.keys(GEMINI_MODELS) as [GeminiModel, ...GeminiModel[]]).optional(),
  voice: z.string().optional(),
  items: z.array(itemSchema).min(1).max(CLIPS.maxItems),
});

interface ClipPart {
  text: string;
  options: SynthesisOptions;
}

interface ClipItem {
  ref: string | null;
  id: string;
  parts: ClipPart[];
  characters: number;
  /** Google calls needed to make the clip, if it does not exist yet. */
  calls: number;
}

async function clipId(engine: Engine, language: string, model: string, parts: ClipPart[]): Promise<string> {
  const canonical = JSON.stringify({
    v: 1,
    format: "mp3",
    engine,
    language,
    model: engine === "gemini" ? model : "",
    parts: parts.map(({ text, options }) => [
      options.voice,
      options.engine === "gemini" ? (options.prompt ?? "") : "",
      options.engine === "chirp3-hd" ? (options.speakingRate ?? 1) : 1,
      text,
    ]),
  });
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
  return Array.from(digest.subarray(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function parseClipsRequest(body: unknown, config: Config) {
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
    const first = issues[0];
    throw invalid(first.path ? `${first.path}: ${first.message}` : first.message, issues);
  }
  const input = parsed.data;
  const engine = input.engine ?? config.defaultEngine;
  const requestedLanguage = input.language ?? config.defaultLanguage;
  const language = resolveLanguage(engine, requestedLanguage);
  if (!language) throw unsupportedLanguage(engine, requestedLanguage);
  if (engine === "chirp3-hd" && input.model !== undefined) {
    throw invalid("model is only supported by the gemini engine.");
  }
  const model = input.model ?? DEFAULT_GEMINI_MODEL;

  const items: ClipItem[] = [];
  let characters = 0;

  for (const [index, item] of input.items.entries()) {
    if ((item.text === undefined) === (item.turns === undefined)) {
      throw invalid(`items[${index}]: give either text or turns, not both.`);
    }
    const sources = item.turns ?? [{ text: item.text!, voice: undefined, prompt: undefined, speakingRate: undefined }];
    const parts: ClipPart[] = [];
    let count = 0;
    let calls = 0;

    for (const [t, turn] of sources.entries()) {
      const where = item.turns ? `items[${index}].turns[${t}]` : `items[${index}]`;
      const text = normalize(turn.text);
      if (!text) throw invalid(`${where}: text must not be empty.`);
      const length = Array.from(text).length;
      if (length > config.maxChars) throw tooLong(length, config.maxChars);

      const requestedVoice = turn.voice ?? item.voice ?? input.voice ?? DEFAULT_VOICE[engine];
      const voice = resolveVoice(requestedVoice);
      if (!voice) {
        throw new ApiError(400, "unknown_voice", `${where}: voice "${requestedVoice}" does not exist. See GET /api/catalog.`);
      }
      const direction = (turn.prompt ?? item.prompt)?.trim() || undefined;
      const speakingRate = turn.speakingRate ?? item.speakingRate;
      if (engine === "chirp3-hd" && direction) throw invalid(`${where}: prompt is only supported by the gemini engine.`);
      if (engine === "gemini" && speakingRate !== undefined) {
        throw invalid(`${where}: speakingRate is only supported by the chirp3-hd engine.`);
      }

      const options: SynthesisOptions =
        engine === "chirp3-hd"
          ? { engine, language, voice, format: "mp3", speakingRate }
          : { engine, language, voice, format: "mp3", model, prompt: direction };
      parts.push({ text, options });
      count += length;
      calls += splitText(text, CHUNK_BYTES[engine], language).length;
    }

    characters += count;
    if (characters > BATCH.maxChars) {
      throw new ApiError(
        413,
        "text_too_long",
        `This request is over ${BATCH.maxChars} characters. Send the items in several requests.`,
        { details: { characters, maxChars: BATCH.maxChars } },
      );
    }
    items.push({ ref: item.ref ?? null, id: await clipId(engine, language, model, parts), parts, characters: count, calls });
  }

  return { engine, items, characters };
}

/* ---------- daily quota per key ---------- */

/**
 * Characters each key may send to Google per UTC day, counted in KV. KV is
 * eventually consistent, so this is a brake against a leaked key or a runaway
 * loop rather than exact accounting; Google-side quotas remain the hard cap.
 */
const today = () => new Date().toISOString().slice(0, 10);
const quotaKey = (name: string) => `quota:v1:${name}:${today()}`;

function nextUtcMidnight(): string {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.toISOString();
}

async function readQuota(kv: KVNamespace | undefined, name: string): Promise<number> {
  if (!kv) return 0;
  try {
    return Number(await kv.get(quotaKey(name))) || 0;
  } catch (error) {
    console.warn("Quota read failed", error);
    return 0;
  }
}

async function writeQuota(kv: KVNamespace | undefined, name: string, used: number): Promise<void> {
  if (!kv) return;
  try {
    await kv.put(quotaKey(name), String(used), { expirationTtl: 2 * 86_400 });
  } catch (error) {
    console.warn("Quota write failed", error);
  }
}

/* ---------- synthesis ---------- */

/** One clip: each part (a sentence, or a dialogue turn) in its own voice, joined in order. */
async function synthesizeClip(config: Config, credential: Credential, item: ClipItem) {
  const audio = [];
  for (const part of item.parts) {
    audio.push(await synthesizeText(part.text, part.options, { endpoint: config.googleEndpoint, credential }));
  }
  return concatAudio("mp3", audio);
}

/* ---------- routes ---------- */

export const clips = new Hono<{ Bindings: Bindings }>();
clips.onError(handleError);

// Clip URLs are played from other sites; creating clips may happen from a browser-based authoring tool.
clips.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "HEAD", "POST", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type", "Range"],
    exposeHeaders: ["Content-Length", "Content-Range", "Accept-Ranges", "ETag"],
    maxAge: 86_400,
  }),
);

function storage(env: Bindings): R2Bucket {
  if (!env.CLIPS) {
    console.error("The CLIPS R2 binding is missing");
    throw new ApiError(503, "clips_unavailable", "Clip storage is not configured on this server.");
  }
  return env.CLIPS;
}

clips.post(
  "/clips",
  bodyLimit({
    maxSize: CLIPS.maxBodyBytes,
    onError: (c) => errorResponse(c, new ApiError(413, "payload_too_large", "Request body is too large.")),
  }),
  async (c) => {
    const config = readConfig(c.env);
    const key = await authenticate(c.env.API_KEYS, c.req.header("authorization"));
    await enforceRateLimit(c.env.TTS_RATE_LIMITER, `apikey:${key.name}`);
    const bucket = storage(c.env);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new ApiError(400, "invalid_json", "Request body must be a JSON object.");
    }
    const { engine, items, characters } = await parseClipsRequest(body, config);

    // Each clip once: two refs for the same sound share it.
    const distinct = [...new Map(items.map((item) => [item.id, item])).values()];
    const budget = config.subrequestBudget - BUDGET_OVERHEAD;
    const worstCost = (item: ClipItem) => 1 + item.calls + 1; // existence check, Google calls, store

    const ready = new Set<string>();
    const created = new Set<string>();
    const failed = new Map<string, ApiError>();
    for (const item of distinct) {
      if (worstCost(item) > budget) {
        failed.set(
          item.id,
          new ApiError(
            413,
            "too_many_parts",
            `This clip needs ${item.calls} calls to Google, more than one request may make here. Split it into shorter dialogues.`,
          ),
        );
      }
    }

    const used = await readQuota(c.env.TTS_CACHE, key.name);
    const limit = config.apiDailyChars;
    let room = limit - used;
    let overQuota = 0;
    let credential: Credential | undefined;

    await withinBudget(
      distinct.filter((item) => !failed.has(item.id)),
      budget,
      worstCost,
      async (wave) => {
        const found = await Promise.all(wave.map((item) => bucket.head(objectKey(item.id))));
        wave.forEach((item, i) => found[i] && ready.add(item.id));
        const affordable = wave.filter((item, i) => {
          if (found[i]) return false;
          if (item.characters > room) {
            overQuota++;
            return false;
          }
          room -= item.characters;
          return true;
        });
        if (affordable.length) credential ??= await resolveCredential(c.env, engine);
        await mapWithConcurrency(affordable, SYNTHESIS_CONCURRENCY, async (item) => {
          try {
            await bucket.put(objectKey(item.id), await synthesizeClip(config, credential!, item), {
              httpMetadata: { contentType: "audio/mpeg", cacheControl: IMMUTABLE },
              customMetadata: { characters: String(item.characters), key: key.name, created: new Date().toISOString() },
            });
            created.add(item.id);
            ready.add(item.id);
          } catch (error) {
            if (!(error instanceof ApiError)) console.error("Clip synthesis failed", error);
            failed.set(
              item.id,
              error instanceof ApiError ? error : new ApiError(502, "synthesis_failed", "This clip could not be made."),
            );
          }
        });
        return wave.length + affordable.reduce((n, item) => n + item.calls + 1, 0);
      },
    );

    // Nothing could be made, and the daily budget is why: say so instead of returning "pending" forever.
    if (overQuota && !created.size) {
      throw new ApiError(
        429,
        "quota_exceeded",
        `The key "${key.name}" has used ${used} of its ${limit} characters for today. It resets at midnight UTC.`,
        { details: { used, limit, resetsAt: nextUtcMidnight() } },
      );
    }
    // When nothing succeeded, the cause (credentials, quota at Google…) is the answer.
    const failures = [...failed.values()].filter((e) => e.code !== "too_many_parts");
    if (!created.size && !ready.size && failures.length) throw failures[0];

    const synthesized = distinct.filter((item) => created.has(item.id)).reduce((n, item) => n + item.characters, 0);
    if (synthesized) runInBackground(c, writeQuota(c.env.TTS_CACHE, key.name, used + synthesized));

    const origin = new URL(c.req.url).origin;
    const results = items.map((item) => {
      const base = { ref: item.ref, id: item.id, characters: item.characters };
      if (ready.has(item.id)) {
        return { ...base, status: "ready", url: `${origin}/api/v1/clips/${item.id}.mp3`, created: created.has(item.id) };
      }
      const error = failed.get(item.id);
      if (error) return { ...base, status: "failed", error: { code: error.code, message: error.message } };
      return { ...base, status: "pending" };
    });

    return c.json({
      complete: results.every((r) => r.status === "ready"),
      pending: results.filter((r) => r.status === "pending").length,
      failed: results.filter((r) => r.status === "failed").length,
      characters,
      synthesized,
      quota: { used: used + synthesized, limit },
      items: results,
    });
  },
);

/** Public: plays a clip. Never synthesizes, so it costs nothing however often it is played. */
clips.get("/clips/:file{[0-9a-f]{32}\\.mp3}", async (c) => {
  const bucket = storage(c.env);
  const id = c.req.param("file").slice(0, 32);
  // Range and If-None-Match are passed straight through: Safari will not play audio without range support.
  const object = await bucket.get(objectKey(id), { range: c.req.raw.headers, onlyIf: c.req.raw.headers });
  if (!object) throw new ApiError(404, "not_found", "No clip with this id. Create it with POST /api/v1/clips.");

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("content-type", "audio/mpeg");
  headers.set("cache-control", IMMUTABLE);
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("cross-origin-resource-policy", "cross-origin");

  if (!("body" in object)) return new Response(null, { status: 304, headers });

  const range = c.req.header("range") ? (object.range as { offset?: number; length?: number; suffix?: number }) : undefined;
  if (range) {
    // Test the value, not the key: R2 reports `suffix: undefined` on ordinary ranges.
    const suffix = range.suffix;
    const offset = suffix !== undefined ? object.size - suffix : (range.offset ?? 0);
    const length = suffix !== undefined ? suffix : (range.length ?? object.size - offset);
    headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set("content-length", String(length));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set("content-length", String(object.size));
  return new Response(object.body, { headers });
});

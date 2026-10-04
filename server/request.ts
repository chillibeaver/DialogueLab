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
import type { Config } from "./config";
import { ApiError } from "./errors";
import {
  AUDIO_FORMATS,
  type AudioFormat,
  type DialogueSpeaker,
  type DialogueTurn,
  type SynthesisOptions,
  type SynthesisPayload,
} from "./google/tts";

export const MAX_PROMPT_CHARS = 1000;
export const SPEAKING_RATE = { min: 0.25, max: 2 } as const;

/**
 * Multi-speaker limits. Exactly two speakers: three or more is rejected by
 * Google with "Multi-speaker synthesis requires two distinct speakers"
 * (tested, not inferred). The dialogue is capped at 4,000 bytes and we keep a
 * margin, because a dialogue cannot be split across requests the way plain
 * text can.
 */
export const DIALOGUE = { speakers: 2, maxTurns: 100, maxBytes: 3800 } as const;

/**
 * Batch limits. A reader plays a script line by line, which would trip the
 * per-IP rate limit within seconds if each line were its own request, so the
 * whole script is synthesized in one call and these caps bound its cost.
 */
export const BATCH = { maxItems: 300, maxChars: 20_000 } as const;
/** Google requires speaker aliases to be alphanumeric with no whitespace. */
const SPEAKER_ALIAS = /^[A-Za-z0-9]+$/;

const ttsRequestSchema = z.strictObject({
  text: z.string().optional(),
  speakers: z
    .array(z.strictObject({ alias: z.string(), voice: z.string() }))
    .length(DIALOGUE.speakers)
    .optional(),
  turns: z
    .array(z.strictObject({ speaker: z.string(), text: z.string() }))
    .min(1)
    .max(DIALOGUE.maxTurns)
    .optional(),
  engine: z.enum(ENGINES).optional(),
  language: z.string().optional(),
  voice: z.string().optional(),
  format: z.enum(Object.keys(AUDIO_FORMATS) as [AudioFormat, ...AudioFormat[]]).optional(),
  speakingRate: z.number().min(SPEAKING_RATE.min).max(SPEAKING_RATE.max).optional(),
  model: z.enum(Object.keys(GEMINI_MODELS) as [GeminiModel, ...GeminiModel[]]).optional(),
  prompt: z.string().max(MAX_PROMPT_CHARS).optional(),
});

export interface TtsRequest {
  /** What to synthesize: plain text (chunkable) or a dialogue (one request). */
  payload: SynthesisPayload;
  /** Length of the spoken text in Unicode code points. */
  characters: number;
  options: SynthesisOptions;
}

export function invalid(message: string, details?: unknown): ApiError {
  return new ApiError(400, "invalid_request", message, { details });
}

export function unsupportedLanguage(engine: Engine, language: string): ApiError {
  return new ApiError(
    400,
    "unsupported_language",
    `Language "${language}" is not supported by the ${engine} engine. See GET /api/catalog.`,
  );
}

export const normalize = (value: string) => value.normalize("NFC").replace(/\r\n?/g, "\n").trim();

const utf8Bytes = (value: string) => new TextEncoder().encode(value).length;

export function tooLong(characters: number, maxChars: number): ApiError {
  return new ApiError(413, "text_too_long", `text has ${characters} characters; the limit is ${maxChars}.`, {
    details: { characters, maxChars },
  });
}

/**
 * Validates `speakers` and `turns` into a dialogue payload. Google requires
 * alphanumeric speaker aliases, and every turn must name a declared one.
 */
function parseDialogue(
  speakers: readonly { alias: string; voice: string }[],
  turns: readonly { speaker: string; text: string }[],
  maxChars: number,
): { payload: SynthesisPayload; characters: number; speakers: DialogueSpeaker[] } {
  const resolved: DialogueSpeaker[] = [];
  const seen = new Set<string>();
  for (const { alias, voice: requested } of speakers) {
    if (!SPEAKER_ALIAS.test(alias)) {
      throw invalid(`speakers: alias "${alias}" must be alphanumeric with no spaces.`);
    }
    if (seen.has(alias)) throw invalid(`speakers: alias "${alias}" is used twice.`);
    seen.add(alias);

    const voice = resolveVoice(requested);
    if (!voice) {
      throw new ApiError(400, "unknown_voice", `Voice "${requested}" does not exist. See GET /api/catalog.`);
    }
    resolved.push({ alias, voice });
  }

  const parsedTurns: DialogueTurn[] = [];
  let characters = 0;
  for (const [index, turn] of turns.entries()) {
    if (!seen.has(turn.speaker)) {
      throw invalid(`turns[${index}]: speaker "${turn.speaker}" is not declared in speakers.`);
    }
    const text = normalize(turn.text);
    if (!text) throw invalid(`turns[${index}]: text must not be empty.`);
    characters += Array.from(text).length;
    parsedTurns.push({ speaker: turn.speaker, text });
  }

  if (characters > maxChars) throw tooLong(characters, maxChars);

  // A dialogue is one Google request: it cannot be split the way plain text is.
  const bytes = parsedTurns.reduce((total, turn) => total + utf8Bytes(turn.text), 0);
  if (bytes > DIALOGUE.maxBytes) {
    throw new ApiError(
      413,
      "text_too_long",
      `The dialogue is ${bytes} bytes; the limit is ${DIALOGUE.maxBytes}, because a dialogue is synthesized in one request.`,
      { details: { bytes, maxBytes: DIALOGUE.maxBytes } },
    );
  }

  return { payload: { kind: "dialogue", turns: parsedTurns, speakers: resolved }, characters, speakers: resolved };
}

/** Validates a POST /api/tts body and fills in defaults. Throws ApiError on bad input. */
export function parseTtsRequest(body: unknown, config: Config): TtsRequest {
  const parsed = ttsRequestSchema.safeParse(body);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
    const first = issues[0];
    throw invalid(first.path ? `${first.path}: ${first.message}` : first.message, issues);
  }
  const input = parsed.data;
  const engine = input.engine ?? config.defaultEngine;
  const isDialogue = input.turns !== undefined || input.speakers !== undefined;

  if (isDialogue) {
    if (input.text !== undefined) throw invalid("Use either text or turns, not both.");
    if (input.turns === undefined || input.speakers === undefined) {
      throw invalid("A dialogue needs both speakers and turns.");
    }
    if (input.voice !== undefined) throw invalid("voice is not used for a dialogue; each speaker declares its own.");
    if (engine !== "gemini") {
      throw invalid(`Dialogue synthesis is only supported by the gemini engine, not ${engine}.`);
    }
  } else if (input.text === undefined) {
    throw invalid("text is required.");
  }

  const requestedLanguage = input.language ?? config.defaultLanguage;
  const language = resolveLanguage(engine, requestedLanguage);
  if (!language) throw unsupportedLanguage(engine, requestedLanguage);

  const format = input.format ?? "mp3";

  if (engine === "chirp3-hd") {
    if (input.model !== undefined || input.prompt !== undefined) {
      throw invalid("model and prompt are only supported by the gemini engine.");
    }
    const text = normalize(input.text!);
    if (!text) throw invalid("text: must not be empty");
    const characters = Array.from(text).length;
    if (characters > config.maxChars) throw tooLong(characters, config.maxChars);

    const voice = resolveVoice(input.voice ?? DEFAULT_VOICE[engine]);
    if (!voice) {
      throw new ApiError(400, "unknown_voice", `Voice "${input.voice}" does not exist. See GET /api/catalog.`);
    }
    return {
      payload: { kind: "text", text },
      characters,
      options: { engine, language, voice, format, speakingRate: input.speakingRate },
    };
  }

  if (input.speakingRate !== undefined) {
    throw invalid("speakingRate is only supported by the chirp3-hd engine; describe the pace in prompt instead.");
  }

  let payload: SynthesisPayload;
  let characters: number;
  let voice: string;

  if (isDialogue) {
    let speakers: DialogueSpeaker[];
    ({ payload, characters, speakers } = parseDialogue(input.speakers!, input.turns!, config.maxChars));
    // Unused when building a dialogue body, but kept so the cache key is complete.
    voice = speakers[0].voice;
  } else {
    const text = normalize(input.text!);
    if (!text) throw invalid("text: must not be empty");
    characters = Array.from(text).length;
    if (characters > config.maxChars) throw tooLong(characters, config.maxChars);
    payload = { kind: "text", text };

    const resolvedVoice = resolveVoice(input.voice ?? DEFAULT_VOICE[engine]);
    if (!resolvedVoice) {
      throw new ApiError(400, "unknown_voice", `Voice "${input.voice}" does not exist. See GET /api/catalog.`);
    }
    voice = resolvedVoice;
  }

  const prompt = input.prompt?.trim() || undefined;
  if (prompt && utf8Bytes(prompt) > DIALOGUE.maxBytes) {
    throw invalid(`prompt is too long: ${utf8Bytes(prompt)} bytes, the limit is ${DIALOGUE.maxBytes}.`);
  }

  return {
    payload,
    characters,
    options: { engine, language, voice, format, model: input.model ?? DEFAULT_GEMINI_MODEL, prompt },
  };
}

const batchItemSchema = z.strictObject({
  text: z.string(),
  voice: z.string().optional(),
  prompt: z.string().max(MAX_PROMPT_CHARS).optional(),
  speakingRate: z.number().min(SPEAKING_RATE.min).max(SPEAKING_RATE.max).optional(),
});

const batchRequestSchema = z.strictObject({
  engine: z.enum(ENGINES).optional(),
  language: z.string().optional(),
  format: z.enum(Object.keys(AUDIO_FORMATS) as [AudioFormat, ...AudioFormat[]]).optional(),
  model: z.enum(Object.keys(GEMINI_MODELS) as [GeminiModel, ...GeminiModel[]]).optional(),
  items: z.array(batchItemSchema).min(1).max(BATCH.maxItems),
});

export interface BatchItem {
  payload: SynthesisPayload;
  options: SynthesisOptions;
  characters: number;
}

export interface BatchRequest {
  items: BatchItem[];
  characters: number;
}

/**
 * Validates `POST /api/tts/batch`. Shared settings live on the body and each
 * item only carries what differs per line, so a script is mostly its text.
 */
export function parseBatchRequest(body: unknown, config: Config): BatchRequest {
  const parsed = batchRequestSchema.safeParse(body);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
    const first = issues[0];
    throw invalid(first.path ? `${first.path}: ${first.message}` : first.message, issues);
  }
  const input = parsed.data;
  const engine = input.engine ?? config.defaultEngine;
  const format = input.format ?? "mp3";

  const requestedLanguage = input.language ?? config.defaultLanguage;
  const language = resolveLanguage(engine, requestedLanguage);
  if (!language) throw unsupportedLanguage(engine, requestedLanguage);

  if (engine === "chirp3-hd" && input.model !== undefined) {
    throw invalid("model is only supported by the gemini engine.");
  }
  const model = input.model ?? DEFAULT_GEMINI_MODEL;

  const items: BatchItem[] = [];
  let characters = 0;

  for (const [index, item] of input.items.entries()) {
    const text = normalize(item.text);
    if (!text) throw invalid(`items[${index}]: text must not be empty.`);

    const count = Array.from(text).length;
    if (count > config.maxChars) throw tooLong(count, config.maxChars);
    characters += count;
    if (characters > BATCH.maxChars) {
      throw new ApiError(
        413,
        "text_too_long",
        `The batch is over ${BATCH.maxChars} characters. Split the script, or synthesize fewer lines at a time.`,
        { details: { characters, maxChars: BATCH.maxChars } },
      );
    }

    const voice = resolveVoice(item.voice ?? DEFAULT_VOICE[engine]);
    if (!voice) {
      throw new ApiError(400, "unknown_voice", `Voice "${item.voice}" does not exist. See GET /api/catalog.`);
    }

    if (engine === "chirp3-hd") {
      if (item.prompt !== undefined) throw invalid(`items[${index}]: prompt is only supported by the gemini engine.`);
      items.push({
        payload: { kind: "text", text },
        characters: count,
        options: { engine, language, voice, format, speakingRate: item.speakingRate },
      });
      continue;
    }

    if (item.speakingRate !== undefined) {
      throw invalid(`items[${index}]: speakingRate is only supported by the chirp3-hd engine.`);
    }
    items.push({
      payload: { kind: "text", text },
      characters: count,
      options: { engine, language, voice, format, model, prompt: item.prompt?.trim() || undefined },
    });
  }

  return { items, characters };
}

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
import { AUDIO_FORMATS, type AudioFormat, type SynthesisOptions } from "./google/tts";

export const MAX_PROMPT_CHARS = 1000;
export const SPEAKING_RATE = { min: 0.25, max: 2 } as const;

const ttsRequestSchema = z.strictObject({
  text: z.string(),
  engine: z.enum(ENGINES).optional(),
  language: z.string().optional(),
  voice: z.string().optional(),
  format: z.enum(Object.keys(AUDIO_FORMATS) as [AudioFormat, ...AudioFormat[]]).optional(),
  speakingRate: z.number().min(SPEAKING_RATE.min).max(SPEAKING_RATE.max).optional(),
  model: z.enum(Object.keys(GEMINI_MODELS) as [GeminiModel, ...GeminiModel[]]).optional(),
  prompt: z.string().max(MAX_PROMPT_CHARS).optional(),
});

export interface TtsRequest {
  /** NFC-normalized, trimmed input text. */
  text: string;
  /** Length of `text` in Unicode code points. */
  characters: number;
  options: SynthesisOptions;
}

function invalid(message: string, details?: unknown): ApiError {
  return new ApiError(400, "invalid_request", message, { details });
}

export function unsupportedLanguage(engine: Engine, language: string): ApiError {
  return new ApiError(
    400,
    "unsupported_language",
    `Language "${language}" is not supported by the ${engine} engine. See GET /api/catalog.`,
  );
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

  const text = input.text.normalize("NFC").replace(/\r\n?/g, "\n").trim();
  if (!text) throw invalid("text: must not be empty");
  const characters = Array.from(text).length;
  if (characters > config.maxChars) {
    throw new ApiError(413, "text_too_long", `text has ${characters} characters; the limit is ${config.maxChars}.`, {
      details: { characters, maxChars: config.maxChars },
    });
  }

  const requestedLanguage = input.language ?? config.defaultLanguage;
  const language = resolveLanguage(engine, requestedLanguage);
  if (!language) throw unsupportedLanguage(engine, requestedLanguage);

  const requestedVoice = input.voice ?? DEFAULT_VOICE[engine];
  const voice = resolveVoice(requestedVoice);
  if (!voice) {
    throw new ApiError(400, "unknown_voice", `Voice "${requestedVoice}" does not exist. See GET /api/catalog.`);
  }

  const format = input.format ?? "mp3";

  if (engine === "chirp3-hd") {
    if (input.model !== undefined || input.prompt !== undefined) {
      throw invalid("model and prompt are only supported by the gemini engine.");
    }
    return { text, characters, options: { engine, language, voice, format, speakingRate: input.speakingRate } };
  }

  if (input.speakingRate !== undefined) {
    throw invalid("speakingRate is only supported by the chirp3-hd engine; describe the pace in prompt instead.");
  }
  return {
    text,
    characters,
    options: {
      engine,
      language,
      voice,
      format,
      model: input.model ?? DEFAULT_GEMINI_MODEL,
      prompt: input.prompt?.trim() || undefined,
    },
  };
}

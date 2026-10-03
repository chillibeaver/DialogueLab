import type { GeminiModel } from "../catalog";
import { ApiError } from "../errors";
import { base64ToBytes } from "../lib/base64";
import { clearTokenCache } from "./auth";

export const AUDIO_FORMATS = {
  mp3: { encoding: "MP3", contentType: "audio/mpeg", extension: "mp3" },
  wav: { encoding: "LINEAR16", contentType: "audio/wav", extension: "wav" },
  ogg_opus: { encoding: "OGG_OPUS", contentType: "audio/ogg", extension: "ogg" },
} as const;
export type AudioFormat = keyof typeof AUDIO_FORMATS;

interface CommonOptions {
  /** Catalog language code, e.g. "fr-FR". */
  language: string;
  /** Catalog voice name, e.g. "Charon". */
  voice: string;
  format: AudioFormat;
}

export type SynthesisOptions =
  | (CommonOptions & { engine: "chirp3-hd"; speakingRate?: number })
  | (CommonOptions & { engine: "gemini"; model: GeminiModel; prompt?: string });

/** Builds the JSON body for `POST /v1/text:synthesize`. */
export function buildSynthesizeBody(text: string, options: SynthesisOptions) {
  const audioConfig: { audioEncoding: string; speakingRate?: number } = {
    audioEncoding: AUDIO_FORMATS[options.format].encoding,
  };

  if (options.engine === "chirp3-hd") {
    if (options.speakingRate !== undefined) audioConfig.speakingRate = options.speakingRate;
    return {
      input: { text },
      voice: { languageCode: options.language, name: `${options.language}-Chirp3-HD-${options.voice}` },
      audioConfig,
    };
  }

  return {
    input: options.prompt ? { prompt: options.prompt, text } : { text },
    voice: { languageCode: options.language, name: options.voice, modelName: options.model },
    audioConfig,
  };
}

async function toApiError(response: Response): Promise<ApiError> {
  let message = "";
  let status = "";
  try {
    const body = (await response.json()) as { error?: { message?: string; status?: string } };
    message = body.error?.message ?? "";
    status = body.error?.status ?? "";
  } catch {
    // Non-JSON error body; the HTTP status is enough to classify it.
  }
  console.error("Google TTS error", response.status, status, message);

  switch (response.status) {
    case 400:
      // INVALID_ARGUMENT messages describe the input (e.g. "sentences are too long") and are useful to clients.
      return new ApiError(422, "synthesis_rejected", message || "Google rejected the synthesis request.");
    case 401:
      clearTokenCache();
      return new ApiError(502, "upstream_auth_failed", "The server's Google Cloud credentials were rejected.");
    case 403:
      return new ApiError(502, "upstream_auth_failed", "The server's Google Cloud credentials were rejected.");
    case 429:
      return new ApiError(503, "upstream_busy", "Google Cloud quota exceeded. Try again shortly.", {
        headers: { "retry-after": "30" },
      });
    default:
      return new ApiError(502, "upstream_error", "Google Cloud Text-to-Speech failed. Try again later.");
  }
}

/** Synthesizes one chunk of text (must already fit the engine's byte limit). */
export async function synthesizeChunk(
  text: string,
  options: SynthesisOptions,
  context: { endpoint: string; accessToken: string },
): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetch(`${context.endpoint}/v1/text:synthesize`, {
    method: "POST",
    headers: { authorization: `Bearer ${context.accessToken}`, "content-type": "application/json" },
    body: JSON.stringify(buildSynthesizeBody(text, options)),
  });
  if (!response.ok) throw await toApiError(response);

  const body = (await response.json()) as { audioContent?: string };
  if (!body.audioContent) {
    throw new ApiError(502, "upstream_error", "Google Cloud Text-to-Speech returned no audio.");
  }
  return base64ToBytes(body.audioContent);
}

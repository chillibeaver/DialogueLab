import type { GeminiModel } from "../catalog";
import { ApiError } from "../errors";
import { base64ToBytes } from "../lib/base64";
import { clearTokenCache, type Credential } from "./auth";

export const AUDIO_FORMATS = {
  mp3: { encoding: "MP3", contentType: "audio/mpeg", extension: "mp3" },
  wav: { encoding: "LINEAR16", contentType: "audio/wav", extension: "wav" },
  ogg_opus: { encoding: "OGG_OPUS", contentType: "audio/ogg", extension: "ogg" },
} as const;
export type AudioFormat = keyof typeof AUDIO_FORMATS;

/** One line of a multi-speaker dialogue. `speaker` is a declared speaker alias. */
export interface DialogueTurn {
  speaker: string;
  text: string;
}

/** Binds a speaker alias in the dialogue to a catalog voice. */
export interface DialogueSpeaker {
  alias: string;
  voice: string;
}

/**
 * What one Google request synthesizes. Plain text can be split across several
 * requests and joined; a dialogue cannot, because splitting it would break
 * speaker continuity, so it is always a single request.
 */
export type SynthesisPayload =
  | { kind: "text"; text: string }
  | { kind: "dialogue"; turns: readonly DialogueTurn[]; speakers: readonly DialogueSpeaker[] };

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
export function buildSynthesizeBody(payload: SynthesisPayload, options: SynthesisOptions) {
  const audioConfig: { audioEncoding: string; speakingRate?: number } = {
    audioEncoding: AUDIO_FORMATS[options.format].encoding,
  };

  if (options.engine === "chirp3-hd") {
    if (payload.kind !== "text") {
      throw new ApiError(400, "invalid_request", "Dialogue synthesis is only supported by the gemini engine.");
    }
    if (options.speakingRate !== undefined) audioConfig.speakingRate = options.speakingRate;
    return {
      input: { text: payload.text },
      voice: { languageCode: options.language, name: `${options.language}-Chirp3-HD-${options.voice}` },
      audioConfig,
    };
  }

  const prompt = options.prompt ? { prompt: options.prompt } : {};

  if (payload.kind === "dialogue") {
    return {
      input: { ...prompt, multiSpeakerMarkup: { turns: payload.turns } },
      voice: {
        languageCode: options.language,
        modelName: options.model,
        // `name` is omitted: each speaker's voice comes from its speaker config.
        multiSpeakerVoiceConfig: {
          speakerVoiceConfigs: payload.speakers.map(({ alias, voice }) => ({
            speakerAlias: alias,
            speakerId: voice,
          })),
        },
      },
      audioConfig,
    };
  }

  return {
    input: { ...prompt, text: payload.text },
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

/** Synthesizes one payload (must already fit the engine's byte limit). */
export async function synthesizeChunk(
  payload: SynthesisPayload,
  options: SynthesisOptions,
  context: { endpoint: string; credential: Credential },
): Promise<Uint8Array<ArrayBuffer>> {
  const { credential } = context;
  const url = new URL(`${context.endpoint}/v1/text:synthesize`);
  if (credential.kind === "apiKey") url.searchParams.set("key", credential.value);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(credential.kind === "bearer" ? { authorization: `Bearer ${credential.value}` } : {}),
    },
    body: JSON.stringify(buildSynthesizeBody(payload, options)),
  });
  if (!response.ok) throw await toApiError(response);

  const body = (await response.json()) as { audioContent?: string };
  if (!body.audioContent) {
    throw new ApiError(502, "upstream_error", "Google Cloud Text-to-Speech returned no audio.");
  }
  return base64ToBytes(body.audioContent);
}

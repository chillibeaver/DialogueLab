import { DEFAULT_GEMINI_MODEL, DEFAULT_VOICE, GEMINI_MODELS, listLanguages, VOICES } from "./catalog";
import type { Config } from "./config";
import { AUDIO_FORMATS } from "./google/tts";
import { BATCH, DIALOGUE, MAX_PROMPT_CHARS, SPEAKING_RATE } from "./request";

/**
 * Everything a client needs to build its controls. Served by `GET /api/catalog`
 * and also read directly by the page loader, so the first render already has
 * the voices and languages instead of waiting for a second round trip.
 */
export function buildCatalog(config: Config) {
  return {
    defaults: { engine: config.defaultEngine, language: config.defaultLanguage, format: "mp3" as const },
    limits: {
      maxChars: config.maxChars,
      maxPromptChars: MAX_PROMPT_CHARS,
      // Per request to POST /api/tts/batch; a client splits longer scripts itself.
      batch: { maxItems: BATCH.maxItems, maxChars: BATCH.maxChars },
    },
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
        // Multi-speaker dialogue: send `speakers` and `turns` instead of `text`.
        dialogue: { speakers: DIALOGUE.speakers, maxTurns: DIALOGUE.maxTurns, maxBytes: DIALOGUE.maxBytes },
      },
    },
  };
}

export type Catalog = ReturnType<typeof buildCatalog>;

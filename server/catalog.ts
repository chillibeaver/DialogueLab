/**
 * Static catalog of engines, voices, languages and models.
 *
 * Kept in code (rather than fetched from Google's voices:list endpoint) so that
 * catalog lookups are free, instant, and usable for request validation.
 *
 * Sources (checked October 2026):
 *   https://docs.cloud.google.com/text-to-speech/docs/chirp3-hd
 *   https://docs.cloud.google.com/text-to-speech/docs/gemini-tts
 */

export const ENGINES = ["chirp3-hd", "gemini"] as const;
export type Engine = (typeof ENGINES)[number];

export type Availability = "ga" | "preview";
export type Gender = "female" | "male";

export interface Voice {
  name: string;
  gender: Gender;
}

/** Both Chirp 3: HD and Gemini-TTS expose the same 30 named voices. */
export const VOICES: readonly Voice[] = [
  { name: "Achernar", gender: "female" },
  { name: "Achird", gender: "male" },
  { name: "Algenib", gender: "male" },
  { name: "Algieba", gender: "male" },
  { name: "Alnilam", gender: "male" },
  { name: "Aoede", gender: "female" },
  { name: "Autonoe", gender: "female" },
  { name: "Callirrhoe", gender: "female" },
  { name: "Charon", gender: "male" },
  { name: "Despina", gender: "female" },
  { name: "Enceladus", gender: "male" },
  { name: "Erinome", gender: "female" },
  { name: "Fenrir", gender: "male" },
  { name: "Gacrux", gender: "female" },
  { name: "Iapetus", gender: "male" },
  { name: "Kore", gender: "female" },
  { name: "Laomedeia", gender: "female" },
  { name: "Leda", gender: "female" },
  { name: "Orus", gender: "male" },
  { name: "Pulcherrima", gender: "female" },
  { name: "Puck", gender: "male" },
  { name: "Rasalgethi", gender: "male" },
  { name: "Sadachbia", gender: "male" },
  { name: "Sadaltager", gender: "male" },
  { name: "Schedar", gender: "male" },
  { name: "Sulafat", gender: "female" },
  { name: "Umbriel", gender: "male" },
  { name: "Vindemiatrix", gender: "female" },
  { name: "Zephyr", gender: "female" },
  { name: "Zubenelgenubi", gender: "male" },
];

export const DEFAULT_VOICE: Record<Engine, string> = {
  "chirp3-hd": "Charon",
  gemini: "Kore",
};

export const GEMINI_MODELS = {
  "gemini-2.5-flash-tts": "ga",
  "gemini-2.5-pro-tts": "ga",
  "gemini-3.1-flash-tts-preview": "preview",
  "gemini-2.5-flash-lite-preview-tts": "preview",
} as const satisfies Record<string, Availability>;
export type GeminiModel = keyof typeof GEMINI_MODELS;
export const DEFAULT_GEMINI_MODEL: GeminiModel = "gemini-2.5-flash-tts";

function codes(availability: Availability, list: string): Record<string, Availability> {
  return Object.fromEntries(list.trim().split(/\s+/).map((code) => [code, availability]));
}

export const LANGUAGES: Record<Engine, Record<string, Availability>> = {
  "chirp3-hd": {
    ...codes(
      "ga",
      `ar-XA bn-IN bg-BG hr-HR cs-CZ da-DK nl-BE nl-NL en-AU en-IN en-GB en-US
       et-EE fi-FI fr-CA fr-FR de-DE el-GR gu-IN he-IL hi-IN hu-HU id-ID it-IT
       ja-JP kn-IN ko-KR lv-LV lt-LT ml-IN cmn-CN mr-IN nb-NO pl-PL pt-BR ro-RO
       ru-RU sr-RS sk-SK sl-SI es-ES es-US sw-KE sv-SE ta-IN te-IN th-TH tr-TR
       uk-UA ur-IN vi-VN`,
    ),
    ...codes("preview", "yue-HK pa-IN"),
  },
  gemini: {
    ...codes(
      "ga",
      `ar-EG bn-BD nl-NL en-IN en-US fr-FR de-DE hi-IN id-ID it-IT ja-JP ko-KR
       mr-IN pl-PL pt-BR ro-RO ru-RU es-ES ta-IN te-IN th-TH tr-TR uk-UA vi-VN`,
    ),
    ...codes(
      "preview",
      `af-ZA sq-AL am-ET ar-001 hy-AM az-AZ eu-ES be-BY bg-BG my-MM ca-ES ceb-PH
       cmn-CN cmn-TW hr-HR cs-CZ da-DK en-AU en-GB et-EE fil-PH fi-FI fr-CA gl-ES
       ka-GE el-GR gu-IN ht-HT he-IL hu-HU is-IS jv-JV kn-IN kok-IN lo-LA la-VA
       lv-LV lt-LT lb-LU mk-MK mai-IN mg-MG ms-MY ml-IN mn-MN ne-NP nb-NO nn-NO
       or-IN ps-AF fa-IR pt-PT pa-IN sr-RS sd-IN si-LK sk-SK sl-SI es-419 es-MX
       sw-KE sv-SE ur-PK`,
    ),
  },
};

/** Returns the catalog spelling of a language code (case-insensitive match), or undefined. */
export function resolveLanguage(engine: Engine, code: string): string | undefined {
  const wanted = code.toLowerCase();
  return Object.keys(LANGUAGES[engine]).find((known) => known.toLowerCase() === wanted);
}

/** Returns the catalog spelling of a voice name (case-insensitive match), or undefined. */
export function resolveVoice(name: string): string | undefined {
  const wanted = name.toLowerCase();
  return VOICES.find((voice) => voice.name.toLowerCase() === wanted)?.name;
}

/** Language list for one engine, with `first` (the default language) at the top. */
export function listLanguages(engine: Engine, first: string) {
  return Object.entries(LANGUAGES[engine])
    .map(([code, availability]) => ({ code, availability }))
    .sort((a, b) => {
      if (a.code === first) return -1;
      if (b.code === first) return 1;
      return a.code.localeCompare(b.code);
    });
}

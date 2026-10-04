/**
 * The script model and its browser storage.
 *
 * Everything here is client-side. Audio comes from `POST /api/tts/batch`, so a
 * speaker's speed and volume are applied during playback rather than baked
 * into the synthesis: changing them is then instant and free, and the cached
 * audio keeps matching.
 */

export type Engine = "chirp3-hd" | "gemini";
export type SpeakerMode = "speak" | "skip";

export interface Speaker {
  id: string;
  name: string;
  color: string;
  /** Catalog voice name, e.g. "Charon". Empty means the automatic pick. */
  voice: string;
  /** Playback rate, applied by the audio element. */
  rate: number;
  volume: number;
  mode: SpeakerMode;
  /** Gemini only: how this character should be delivered. */
  prompt: string;
}

export interface Line {
  id: string;
  sp: string;
  text: string;
  /** A translation or gloss shown under the line. Never spoken. */
  note?: string;
}

export interface Script {
  id: string;
  title: string;
  lang: string;
  engine: Engine;
  model: string;
  speakers: Speaker[];
  lines: Line[];
  updated: number;
}

export interface Prefs {
  speed: number;
  slow: boolean;
  /** Seconds of silence between lines. */
  gap: number;
  repeat: number;
  /** Pause after each line, as a multiple of its length, to repeat it aloud. */
  shadow: number;
  loop: boolean;
  follow: boolean;
  hide: boolean;
  theme: "auto" | "light" | "dark";
  sideCollapsed: boolean;
  dict: DictRule[];
  currentId: string | null;
  /** Show each line's translation under it. */
  notes: boolean;
  /** Which version of DEFAULT_DICT has been added to `dict`. */
  dictDefaults: number;
}

export interface DictRule {
  from: string;
  to: string;
  on: boolean;
  /** Primary language subtag the rule is for, such as "fr"; absent means every language. */
  lang?: string;
}

/**
 * Common French abbreviations, which speech engines may spell out letter by
 * letter. They only apply to French scripts, so "Dr Smith" stays English.
 * Order matters where one spelling contains another: "Dr." before "Dr".
 */
export const DEFAULT_DICT: readonly DictRule[] = [
  ["Mme", "Madame"],
  ["Mmes", "Mesdames"],
  ["Mlle", "Mademoiselle"],
  ["Mlles", "Mesdemoiselles"],
  ["M.", "Monsieur"],
  ["MM.", "Messieurs"],
  ["Dr.", "Docteur"],
  ["Dr", "Docteur"],
  ["Dre", "Docteure"],
  ["Pr", "Professeur"],
  ["St", "Saint"],
  ["Ste", "Sainte"],
  ["qch", "quelque chose"],
  ["qqch", "quelque chose"],
  ["qn", "quelqu'un"],
  ["qqn", "quelqu'un"],
  ["c.-à-d.", "c'est-à-dire"],
  ["p. ex.", "par exemple"],
  ["env.", "environ"],
  ["n°", "numéro"],
  ["svp", "s'il vous plaît"],
  ["SVP", "s'il vous plaît"],
  ["stp", "s'il te plaît"],
  ["rdv", "rendez-vous"],
  ["RDV", "rendez-vous"],
].map(([from, to]) => ({ from, to, on: true, lang: "fr" }));

/** Bump when DEFAULT_DICT gains rules, so existing libraries are offered the new ones once. */
export const DICT_DEFAULTS_VERSION = 1;

/** The default rules missing from `dict`, matched by spelling. */
export function missingDefaults(dict: readonly DictRule[]): DictRule[] {
  const have = new Set(dict.map((rule) => rule.from));
  return DEFAULT_DICT.filter((rule) => !have.has(rule.from)).map((rule) => ({ ...rule }));
}

export interface Store {
  scripts: Record<string, Script>;
  prefs: Prefs;
}

export const LS_KEY = "tts-studio:reader:v1";

export const COLORS = [
  "#2346C8", "#0E7C7B", "#8A3B78", "#B0700E", "#4C7A1F", "#B0413E", "#4A5A8C", "#7A5A2E",
  "#C2185B", "#00838F", "#5E35B1", "#827717", "#D84315", "#37474F", "#6D4C41", "#AD1457",
];

export const uid = () => Math.random().toString(36).slice(2, 10);
export const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
export const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o)) as T;

const colorKey = (c: string) => (c || "").toUpperCase();

function hslHex(hh: number, ss: number, ll: number): string {
  const s = ss / 100;
  const l = ll / 100;
  const k = (n: number) => (n + hh / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) =>
    Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))))
      .toString(16)
      .padStart(2, "0");
  return ("#" + f(0) + f(8) + f(4)).toUpperCase();
}

/** First colour no other speaker uses; generates more once the palette runs out. */
export function nextColor(speakers: Speaker[], except?: Speaker): string {
  const used = new Set(speakers.filter((s) => s !== except).map((s) => colorKey(s.color)));
  const free = COLORS.find((c) => !used.has(colorKey(c)));
  if (free) return free;
  for (let k = 0; k < 720; k++) {
    const c = hslHex(Math.round((k * 137.508) % 360), 55, 38 + (k % 3) * 6);
    if (!used.has(c)) return c;
  }
  return "#555555";
}

export function nextSpeakerName(speakers: Speaker[]): string {
  const names = new Set(speakers.map((s) => (s.name || "").trim().toUpperCase()));
  for (let i = 0; i < 26; i++) {
    const n = String.fromCharCode(65 + i);
    if (!names.has(n)) return n;
  }
  let k = speakers.length + 1;
  while (names.has("SPEAKER " + k)) k++;
  return "Speaker " + k;
}

export function makeSpeaker(name: string, color: string, voice = ""): Speaker {
  return { id: uid(), name, color, voice, rate: 1, volume: 1, mode: "speak", prompt: "" };
}

export const NARRATOR_NAMES = new Set([
  "narrator", "narrateur", "narratrice", "narrador", "erzähler", "narratore", "旁白", "ナレーター", "내레이터",
]);

export const isNarrator = (sp: Speaker) => NARRATOR_NAMES.has((sp.name || "").trim().toLowerCase());

export function makeScript(
  title: string,
  lang: string,
  engine: Engine,
  model: string,
  pairs: [string, string][] = [],
  voices: string[] = [],
): Script {
  const speakers: Speaker[] = [];
  const byName: Record<string, Speaker> = {};
  const lines: Line[] = pairs.map(([name, text]) => {
    if (!byName[name]) {
      const sp = makeSpeaker(name, nextColor(speakers), voices[speakers.length] ?? "");
      byName[name] = sp;
      speakers.push(sp);
    }
    return { id: uid(), sp: byName[name].id, text };
  });
  if (!speakers.length) {
    speakers.push(makeSpeaker("A", COLORS[0], voices[0] ?? ""), makeSpeaker("B", COLORS[1], voices[1] ?? ""));
  }
  return { id: uid(), title, lang, engine, model, speakers, lines, updated: Date.now() };
}

export function defaultPrefs(): Prefs {
  return {
    speed: 1,
    slow: false,
    gap: 0.4,
    repeat: 1,
    shadow: 0,
    loop: false,
    follow: true,
    hide: false,
    theme: "dark",
    sideCollapsed: false,
    dict: DEFAULT_DICT.map((rule) => ({ ...rule })),
    currentId: null,
    notes: true,
    dictDefaults: DICT_DEFAULTS_VERSION,
  };
}

/**
 * Settings read back from storage. Rules added to DEFAULT_DICT since they were
 * saved are offered once; a default the user deleted afterwards stays deleted.
 */
export function restorePrefs(saved: Partial<Prefs> | undefined): Prefs {
  const prefs: Prefs = { ...defaultPrefs(), ...saved };
  if ((saved?.dictDefaults ?? 0) < DICT_DEFAULTS_VERSION) {
    const dict = saved?.dict ?? [];
    prefs.dict = [...dict, ...missingDefaults(dict)];
    prefs.dictDefaults = DICT_DEFAULTS_VERSION;
  }
  return prefs;
}

export function speakerOf(script: Script, id: string): Speaker {
  return script.speakers.find((s) => s.id === id) ?? script.speakers[0];
}

export function loadStore(): Store | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as Store) : null;
  } catch {
    return null;
  }
}

export function saveStore(store: Store): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(store));
  } catch {
    // Private mode or a full quota: the session still works, it just will not persist.
  }
}

/** A speaker's effective playback rate, including the global speed and slow mode. */
export function effectiveRate(sp: Speaker, prefs: Prefs): number {
  return clamp((sp.rate || 1) * prefs.speed * (prefs.slow ? 0.7 : 1), 0.25, 4);
}

/**
 * The TTS Studio script format, version 1: plain text for listening material.
 *
 * It is written by people, or by a model on their behalf, and imported here.
 * The full specification with examples is collaborators/listening-format.md; this module
 * is its reference implementation.
 *
 *   #tts-studio 1                 header, the first line of a file
 *   @lang fr-FR                   defaults for every item below
 *   ## Au café                    starts an item: one script in the library
 *   @speaker Claire: female       the cast, before the first line
 *   Claire: Bonjour !             a spoken line
 *   > Hello!                      a translation of the line above, never spoken
 *   # a note to yourself          a comment
 *
 * Plain text rather than JSON or YAML, on purpose: each line stands on its
 * own, so a mistake is reported against one line instead of breaking the whole
 * file, and the text survives word processors, chat windows and model output.
 *
 * Speaker names are only recognized when declared. French puts a space before
 * a colon ("Attention : le train part."), so guessing that whatever precedes a
 * colon is a name would turn ordinary sentences into dialogue.
 */

import { makeSpeaker, nextColor, uid, type Engine, type Script, type Speaker } from "./model";
import { PAUSE_RE } from "./text";

export const FORMAT_VERSION = 1;
export const FORMAT_HEADER = `#tts-studio ${FORMAT_VERSION}`;

export type Gender = "female" | "male";
export type ItemKind = "dialogue" | "monologue" | "single";

/** The part of the catalog the format needs. The server's catalog satisfies it. */
export interface FormatCatalog {
  defaults: { engine: string; language: string };
  limits: { maxChars: number; maxPromptChars: number };
  voices: readonly { name: string; gender: string }[];
  engines: {
    "chirp3-hd": { name: string; defaultVoice: string; languages: readonly { code: string }[] };
    gemini: {
      name: string;
      defaultVoice: string;
      defaultModel: string;
      models: readonly { id: string }[];
      languages: readonly { code: string }[];
    };
  };
}

export interface Diagnostic {
  /** 1-based line in the text that was parsed. */
  line: number;
  message: string;
}

export interface ParsedSpeaker {
  name: string;
  voice: string;
  gender: Gender;
  /** Where the voice came from, so a merge can tell a choice from a default. */
  source: "voice" | "gender" | "auto";
  prompt: string;
}

export interface ParsedLine {
  /** Index into the item's speakers. */
  speaker: number;
  text: string;
  /** Translation or gloss, shown under the line and never spoken. */
  note: string;
  line: number;
}

export interface ParsedItem {
  line: number;
  title: string;
  id: string | null;
  lang: string;
  engine: Engine;
  model: string;
  speakers: ParsedSpeaker[];
  lines: ParsedLine[];
  kind: ItemKind;
}

export interface ParseResult {
  items: ParsedItem[];
  errors: Diagnostic[];
  warnings: Diagnostic[];
}

export interface ParseOptions {
  /**
   * "pack": a file of items under `##` headings, as sent for import.
   * "script": a single item whose header and heading are optional, as edited
   * in the Plain text view.
   */
  mode: "pack" | "script";
  /** Used where the text says nothing. Falls back to the catalog defaults. */
  defaults?: { lang?: string; engine?: Engine; model?: string; title?: string };
}

/* ---------- vocabulary ---------- */

const GENDERS: Record<string, Gender> = {
  female: "female",
  f: "female",
  woman: "female",
  femme: "female",
  女: "female",
  女性: "female",
  male: "male",
  m: "male",
  man: "male",
  homme: "male",
  男: "male",
  男性: "male",
};

/** Google's documented Gemini-TTS markup tags. */
const GEMINI_TAGS = new Set([
  "sigh",
  "laughing",
  "uhm",
  "sarcasm",
  "robotic",
  "shouting",
  "whispering",
  "extremely fast",
  "short pause",
  "medium pause",
  "long pause",
  "scared",
  "curious",
  "bored",
]);

const NARRATOR: Record<string, string> = {
  fr: "Narrateur",
  en: "Narrator",
  es: "Narrador",
  pt: "Narrador",
  de: "Erzähler",
  it: "Narratore",
  zh: "旁白",
  cmn: "旁白",
  ja: "ナレーター",
  ko: "내레이터",
};

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_NAME = 24;

/** Whitespace a word processor may put before a French colon. */
const GAP = "[\\s\\u00a0\\u202f]*";
const COLON = "[:：]";

/** Some keyboards produce full-width structural characters. */
function normalizeLead(text: string): string {
  return text.replace(/^[＠＞＃]+/, (lead) =>
    [...lead].map((c) => ({ "＠": "@", "＞": ">", "＃": "#" })[c] ?? c).join(""),
  );
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const codePoints = (s: string) => [...s].length;
const lower = (s: string) => s.toLocaleLowerCase();

export function normalizeEngine(value: string): Engine | null {
  const v = value.toLowerCase().replace(/[\s_:]+/g, "-").replace(/-+/g, "-");
  if (["chirp3-hd", "chirp-3-hd", "chirp3hd", "chirp3", "chirp"].includes(v)) return "chirp3-hd";
  if (["gemini", "gemini-tts"].includes(v)) return "gemini";
  return null;
}

function resolveLanguage(code: string, engine: Engine, catalog: FormatCatalog): string | null {
  const want = code.trim().replace(/_/g, "-").toLowerCase();
  return catalog.engines[engine].languages.find((l) => l.code.toLowerCase() === want)?.code ?? null;
}

export function genderOf(voice: string, catalog: FormatCatalog): Gender | null {
  const found = catalog.voices.find((v) => v.name === voice)?.gender;
  return found === "female" || found === "male" ? found : null;
}

function narratorName(lang: string): string {
  return NARRATOR[lang.split("-")[0].toLowerCase()] ?? "Narrator";
}

function nameProblem(name: string): string | null {
  if (!name) return "A speaker needs a name.";
  if (codePoints(name) > MAX_NAME) return `"${name}" is longer than ${MAX_NAME} characters.`;
  if (/[:：[\]]/.test(name)) return `"${name}" cannot contain a colon or square brackets.`;
  if (/^[@#>]/.test(name)) return `"${name}" cannot start with @, # or >.`;
  return null;
}

/**
 * A `Name:` prefix that looks like a person rather than the start of a
 * sentence: letters, at most three words, no digits or sentence punctuation.
 * Used to auto-detect undeclared dialogue and to word helpful errors; it never
 * decides on its own that a line has a speaker.
 */
const LOOSE_NAME = new RegExp(`^([^:：\\[\\]@#>]{1,${MAX_NAME}}?)${GAP}${COLON}${GAP}(.*)$`, "u");

function looseName(text: string): { name: string; rest: string } | null {
  const m = LOOSE_NAME.exec(text);
  if (!m) return null;
  const name = m[1].trim();
  if (!/\p{L}/u.test(name)) return null;
  if (/[\d.!?,;…«»"“”¿¡]/.test(name)) return null;
  if (name.split(/\s+/).length > 3) return null;
  if (/^(https?|ftp|mailto)$/i.test(name)) return null;
  return { name, rest: m[2] };
}

/** Matches declared names at the start of a line, longest first ("Marie-Claire" before "Marie"). */
function declaredMatcher(names: string[]) {
  const patterns = names
    .map((name, index) => ({ index, re: new RegExp(`^${escapeRe(name)}${GAP}${COLON}${GAP}`, "iu"), length: name.length }))
    .sort((a, b) => b.length - a.length);
  return (text: string): { index: number; rest: string } | null => {
    for (const { index, re } of patterns) {
      const m = re.exec(text);
      if (m) return { index, rest: text.slice(m[0].length) };
    }
    return null;
  };
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const kept = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = kept;
    }
  }
  return row[b.length];
}

/* ---------- voices ---------- */

/**
 * Gives every speaker a voice. A named voice is kept; a gender gets the first
 * free voice of that gender; otherwise the rarer gender so far is used, so two
 * undeclared speakers come out one male and one female. Picks follow catalog
 * order, so importing the same file twice gives the same voices.
 */
export function assignVoices(
  requests: { voice?: string; gender?: Gender }[],
  catalog: FormatCatalog,
  taken: Iterable<string> = [],
): { voice: string; gender: Gender; source: ParsedSpeaker["source"] }[] {
  const used = new Set(taken);
  const count: Record<Gender, number> = { female: 0, male: 0 };
  for (const r of requests) {
    if (r.voice) used.add(r.voice);
    const g = r.voice ? genderOf(r.voice, catalog) : r.gender;
    if (g) count[g]++;
  }

  return requests.map((r) => {
    if (r.voice) return { voice: r.voice, gender: genderOf(r.voice, catalog) ?? "male", source: "voice" as const };
    const gender: Gender = r.gender ?? (count.male <= count.female ? "male" : "female");
    if (!r.gender) count[gender]++;
    const pool = catalog.voices.filter((v) => v.gender === gender);
    // With its gender's voices all taken, an undeclared speaker takes any free
    // voice; a voice repeats only when none is free, or the gender was asked for.
    const pick =
      pool.find((v) => !used.has(v.name)) ??
      (r.gender ? undefined : catalog.voices.find((v) => !used.has(v.name))) ??
      pool[0];
    used.add(pick.name);
    return {
      voice: pick.name,
      gender: genderOf(pick.name, catalog) ?? gender,
      source: r.gender ? ("gender" as const) : ("auto" as const),
    };
  });
}

/**
 * The voice for a speaker added to a cast: one nobody in it uses yet, of the
 * gender it has fewer of. A speaker without a voice of their own speaks with
 * the engine's default, so that one counts as taken too. Only when every
 * voice of that gender is taken does a voice repeat.
 */
export function voiceForNewSpeaker(
  speakers: readonly { voice: string }[],
  engine: Engine,
  catalog: FormatCatalog,
): string {
  const voices = speakers.map((sp) => sp.voice || catalog.engines[engine].defaultVoice);
  return assignVoices([...voices.map((voice) => ({ voice })), {}], catalog).at(-1)!.voice;
}

/* ---------- parsing ---------- */

interface Setting<T> {
  value: T;
  line: number;
}

interface DeclaredSpeaker {
  name: string;
  gender?: Gender;
  voice?: string;
  line: number;
}

interface Draft {
  line: number;
  title: string;
  id: Setting<string> | null;
  lang: Setting<string> | null;
  engine: Setting<Engine> | null;
  model: Setting<string> | null;
  speakers: DeclaredSpeaker[];
  directions: { name: string; text: string; line: number }[];
  body: { line: number; text: string; notes: string[] }[];
}

const newDraft = (line: number, title: string): Draft => ({
  line,
  title,
  id: null,
  lang: null,
  engine: null,
  model: null,
  speakers: [],
  directions: [],
  body: [],
});

export function parseScriptText(input: string, catalog: FormatCatalog, options: ParseOptions): ParseResult {
  const errors: Diagnostic[] = [];
  const warnings: Diagnostic[] = [];
  const error = (line: number, message: string) => errors.push({ line, message });
  const warn = (line: number, message: string) => warnings.push({ line, message });

  const fileScope: Pick<Draft, "lang" | "engine" | "model"> = { lang: null, engine: null, model: null };
  const drafts: Draft[] = [];
  let current: Draft | null = null;
  let sawHeader = false;
  let first = true;

  const voiceList = catalog.voices.map((v) => v.name).join(", ");
  const rows = input
    .replace(/^﻿/, "")
    .normalize("NFC")
    .split(/\r\n|\r|\n/)
    .map((raw, index) => ({ n: index + 1, text: normalizeLead(raw.trim()) }));

  for (const { n, text } of rows) {
    if (!text) continue;

    if (first) {
      first = false;
      const header = /^#\s*tts-studio\s+v?(\d+)\s*$/i.exec(text);
      if (header) {
        sawHeader = true;
        const version = Number(header[1]);
        if (version > FORMAT_VERSION) {
          error(n, `This file is format version ${version}; this version of DialogueLab reads version ${FORMAT_VERSION}.`);
        }
        continue;
      }
      if (/^#\s*tts-studio\b/i.test(text)) {
        error(n, `The header should read "${FORMAT_HEADER}".`);
        continue;
      }
    }

    const heading = /^##(?!#)\s*(.*)$/.exec(text);
    if (heading) {
      current = newDraft(n, heading[1].trim());
      drafts.push(current);
      if (!current.title) error(n, 'A ## heading needs a title, for example "## Au café".');
      continue;
    }

    if (text.startsWith("#")) continue;

    // In the Plain text view there is one item, so its heading is optional.
    if (!current && options.mode === "script") {
      current = newDraft(n, options.defaults?.title?.trim() || "Untitled script");
      drafts.push(current);
    }

    if (text.startsWith("@")) {
      const m = /^@([A-Za-z][\w-]*)\s*(.*)$/.exec(text);
      if (!m) {
        error(n, `"${text}" is not a setting. Settings look like "@lang fr-FR".`);
        continue;
      }
      const key = m[1].toLowerCase();
      const value = m[2].trim();

      if (current && current.body.length && ["lang", "engine", "model", "speaker", "direction", "id"].includes(key)) {
        error(n, `@${key} must come before the first line of "${current.title}".`);
        continue;
      }

      if (key === "lang" || key === "language" || key === "engine" || key === "model") {
        const field = key === "language" ? "lang" : key;
        const scope = current ?? fileScope;
        if (!value) {
          error(n, `@${key} needs a value.`);
        } else if (scope[field]) {
          error(n, `@${field} is set twice ${current ? `in "${current.title}"` : "at the top of the file"}.`);
        } else if (field === "engine") {
          const engine = normalizeEngine(value);
          if (!engine) error(n, `Unknown engine "${value}". Use chirp3-hd or gemini.`);
          else scope.engine = { value: engine, line: n };
        } else {
          scope[field] = { value, line: n };
        }
        continue;
      }

      if (key === "speaker" || key === "direction" || key === "id") {
        if (!current) {
          error(n, `@${key} belongs under a ## heading.`);
          continue;
        }
        if (key === "id") {
          if (!ID_RE.test(value)) {
            error(n, `"${value}" is not a usable id: letters, digits, dot, dash and underscore, up to 64.`);
          } else if (current.id) {
            error(n, `@id is set twice in "${current.title}".`);
          } else if (drafts.some((d) => d !== current && d.id?.value === value)) {
            error(n, `The id "${value}" is already used by another item in this file.`);
          } else {
            current.id = { value, line: n };
          }
          continue;
        }

        const colon = value.search(/[:：]/);
        const name = (colon < 0 ? value : value.slice(0, colon)).trim();
        const rest = colon < 0 ? "" : value.slice(colon + 1).trim();
        const problem = nameProblem(name);
        if (problem) {
          error(n, problem);
          continue;
        }

        if (key === "direction") {
          if (!rest) {
            error(n, `Write the direction after the name: "@direction ${name}: calm and slow".`);
          } else if (codePoints(rest) > catalog.limits.maxPromptChars) {
            error(n, `This direction is longer than ${catalog.limits.maxPromptChars} characters.`);
          } else if (current.directions.some((d) => lower(d.name) === lower(name))) {
            error(n, `${name} already has a direction in "${current.title}".`);
          } else {
            current.directions.push({ name, text: rest, line: n });
          }
          continue;
        }

        if (current.speakers.some((s) => lower(s.name) === lower(name))) {
          error(n, `${name} is declared twice in "${current.title}".`);
          continue;
        }
        const speaker: DeclaredSpeaker = { name, line: n };
        let ok = true;
        for (const token of rest.split(/[\s,，、]+/).filter(Boolean)) {
          const gender = GENDERS[token.toLowerCase()];
          if (gender) {
            if (speaker.gender && speaker.gender !== gender) {
              error(n, `${name} is given two genders.`);
              ok = false;
            }
            speaker.gender = gender;
            continue;
          }
          const voice = catalog.voices.find((v) => v.name.toLowerCase() === token.toLowerCase());
          if (voice) {
            if (speaker.voice) {
              error(n, `${name} is given two voices; choose one.`);
              ok = false;
            }
            speaker.voice = voice.name;
            continue;
          }
          error(n, `"${token}" is neither a gender nor a voice. Use female or male, or one of: ${voiceList}.`);
          ok = false;
        }
        if (speaker.voice && speaker.gender) {
          const actual = genderOf(speaker.voice, catalog);
          if (actual && actual !== speaker.gender) {
            error(n, `${speaker.voice} is a ${actual} voice, but ${name} is marked ${speaker.gender}.`);
            ok = false;
          }
        }
        if (ok) current.speakers.push(speaker);
        continue;
      }

      if (key === "title") {
        warn(n, "Ignored @title: an item's title is its ## heading.");
      } else {
        warn(n, `Ignored unknown setting @${key}.`);
      }
      continue;
    }

    if (!current) {
      error(n, 'Text before the first item. Start each item with a heading, for example "## Au café".');
      continue;
    }

    if (text.startsWith(">")) {
      const note = text.slice(1).trim();
      const last = current.body.at(-1);
      if (!last) error(n, "A > translation goes under the line it translates.");
      else if (note) last.notes.push(note);
      continue;
    }

    current.body.push({ line: n, text, notes: [] });
  }

  if (options.mode === "pack") {
    if (!drafts.length) {
      error(1, 'No items found. Start each item with a heading, for example "## Au café".');
    } else if (!sawHeader) {
      warn(1, `The first line should be "${FORMAT_HEADER}", so the file is recognized and versioned.`);
    }
  } else if (drafts.length > 1) {
    error(drafts[1].line, "This view holds one script. Import files with several ## items from Library → Import.");
  } else if (!drafts.length) {
    error(1, "Write at least one line.");
  }

  const items: ParsedItem[] = [];
  for (const draft of drafts) {
    const item = resolveDraft(draft, fileScope, catalog, options, error, warn);
    if (item) items.push(item);
  }

  const byLine = (a: Diagnostic, b: Diagnostic) => a.line - b.line;
  return { items, errors: errors.sort(byLine), warnings: warnings.sort(byLine) };
}

function resolveDraft(
  draft: Draft,
  fileScope: Pick<Draft, "lang" | "engine" | "model">,
  catalog: FormatCatalog,
  options: ParseOptions,
  error: (line: number, message: string) => void,
  warn: (line: number, message: string) => void,
): ParsedItem | null {
  const title = draft.title || "Untitled script";
  const engine: Engine =
    draft.engine?.value ??
    fileScope.engine?.value ??
    options.defaults?.engine ??
    normalizeEngine(catalog.defaults.engine) ??
    "chirp3-hd";
  const engineName = catalog.engines[engine].name;

  const langSetting = draft.lang ?? fileScope.lang;
  const wanted = langSetting?.value ?? options.defaults?.lang ?? catalog.defaults.language;
  const lang = resolveLanguage(wanted, engine, catalog);
  if (!lang) error(langSetting?.line ?? draft.line, `"${wanted}" is not available on ${engineName}.`);

  let model = options.defaults?.model ?? catalog.engines.gemini.defaultModel;
  const modelSetting = draft.model ?? fileScope.model;
  if (engine === "gemini" && modelSetting) {
    const found = catalog.engines.gemini.models.find((m) => m.id.toLowerCase() === modelSetting.value.toLowerCase());
    if (found) model = found.id;
    else {
      const ids = catalog.engines.gemini.models.map((m) => m.id).join(", ");
      error(modelSetting.line, `Unknown model "${modelSetting.value}". Use one of: ${ids}.`);
    }
  } else if (engine === "chirp3-hd" && draft.model) {
    warn(draft.model.line, "Ignored @model: models only apply to the gemini engine.");
  }

  if (!draft.body.length) {
    error(draft.line, `"${title}" has no lines.`);
    return null;
  }

  /* ---- who says each line ---- */

  let speakers: DeclaredSpeaker[] = draft.speakers;
  const lines: ParsedLine[] = [];
  let narrator = false;
  const pushLine = (speaker: number, text: string, row: Draft["body"][number]) =>
    lines.push({ speaker, text: text.trim(), note: row.notes.join("\n"), line: row.line });

  if (!speakers.length) {
    const loose = draft.body.map((row) => looseName(row.text));
    const names: string[] = [];
    for (const match of loose) {
      if (match && !names.some((x) => lower(x) === lower(match.name))) names.push(match.name);
    }
    const prefixed = loose.filter(Boolean).length;

    if (prefixed === draft.body.length && names.length >= 2) {
      // Every line names its speaker: unambiguous dialogue, just undeclared.
      speakers = names.map((name) => ({ name, line: draft.line }));
      warn(
        draft.line,
        `"${title}" declares no speakers, so ${names.join(", ")} got voices automatically. ` +
          "Declare them with @speaker to choose gender or voice.",
      );
      draft.body.forEach((row, i) => {
        const match = loose[i]!;
        pushLine(names.findIndex((x) => lower(x) === lower(match.name)), match.rest, row);
      });
    } else {
      if (names.length >= 2 && prefixed >= 2) {
        const unnamed = draft.body.find((_, i) => !loose[i])!;
        warn(
          unnamed.line,
          `"${title}" looks like dialogue (${names.slice(0, 3).join(", ")}), but this line has no speaker, ` +
            "so the whole item is read by one voice with the names spoken aloud. Declare the speakers with @speaker.",
        );
      } else if (names.length === 1 && prefixed === draft.body.length && draft.body.length >= 2) {
        warn(
          draft.body[0].line,
          `Every line starts with "${names[0]}:", which will be read aloud. ` +
            `If ${names[0]} is the speaker, declare "@speaker ${names[0]}".`,
        );
      }
      narrator = true;
      speakers = [{ name: narratorName(lang ?? wanted), line: draft.line }];
      for (const row of draft.body) pushLine(0, row.text, row);
    }
  } else if (speakers.length === 1) {
    const match = declaredMatcher([speakers[0].name]);
    for (const row of draft.body) pushLine(0, match(row.text)?.rest ?? row.text, row);
  } else {
    const names = speakers.map((s) => s.name);
    const match = declaredMatcher(names);
    for (const row of draft.body) {
      const found = match(row.text);
      if (found) {
        pushLine(found.index, found.rest, row);
        continue;
      }
      const loose = looseName(row.text);
      if (loose) {
        const near = names.find((name) => distance(lower(name), lower(loose.name)) <= 2);
        error(
          row.line,
          `"${loose.name}" is not a declared speaker${near ? `; did you mean "${near}"?` : "."} ` +
            `"${title}" declares ${names.join(", ")}.`,
        );
      } else {
        error(row.line, `Start the line with who says it, for example "${names[0]}: …". "${title}" has several speakers.`);
      }
    }
  }

  /* ---- what is said ---- */

  const seenTags = new Set<string>();
  const pauseOnly = new RegExp(`^${PAUSE_RE.source}$`, "i");
  for (const line of lines) {
    if (!line.text) {
      error(line.line, `${speakers[line.speaker].name} has nothing to say on this line.`);
      continue;
    }
    if (codePoints(line.text) > catalog.limits.maxChars) {
      error(line.line, `This line is longer than ${catalog.limits.maxChars} characters; split it into several.`);
    }
    for (const m of line.text.matchAll(/\[([^\]]+)\]/g)) {
      if (pauseOnly.test(m[0])) continue;
      const tag = m[1].trim().toLowerCase();
      if (seenTags.has(tag)) continue;
      seenTags.add(tag);
      const known = GEMINI_TAGS.has(tag);
      if (engine === "chirp3-hd") {
        warn(
          line.line,
          known
            ? `Chirp 3: HD reads "[${tag}]" aloud; markup tags only work with the gemini engine.`
            : `"[${tag}]" is not a pause and will be read aloud.`,
        );
      } else if (!known) {
        warn(line.line, `"[${tag}]" is neither a pause nor a known Gemini tag; it may be read aloud.`);
      }
    }
  }

  /* ---- cast ---- */

  const prompts = speakers.map(() => "");
  for (const direction of draft.directions) {
    const index = draft.speakers.findIndex((s) => lower(s.name) === lower(direction.name));
    if (index < 0) error(direction.line, `@direction is for ${direction.name}, who is not declared with @speaker.`);
    else prompts[index] = direction.text;
  }
  if (engine === "chirp3-hd" && draft.directions.length) {
    warn(draft.directions[0].line, "@direction only affects the gemini engine; Chirp 3: HD ignores it.");
  }

  const spoken = new Set(lines.map((l) => l.speaker));
  draft.speakers.forEach((s, index) => {
    if (!spoken.has(index)) warn(s.line, `${s.name} is declared but has no lines.`);
  });

  const assigned = narrator
    ? [{ voice: catalog.engines[engine].defaultVoice, gender: genderOf(catalog.engines[engine].defaultVoice, catalog) ?? "male", source: "auto" as const }]
    : assignVoices(speakers.map((s) => ({ voice: s.voice, gender: s.gender })), catalog);

  const explicit = new Map<string, string>();
  speakers.forEach((s, index) => {
    if (!s.voice) return;
    const other = explicit.get(s.voice);
    if (other) warn(s.line, `${other} and ${s.name} both use ${s.voice}, so they will sound the same.`);
    else explicit.set(s.voice, s.name);
  });

  return {
    line: draft.line,
    title,
    id: draft.id?.value ?? null,
    lang: lang ?? catalog.defaults.language,
    engine,
    model,
    speakers: speakers.map((s, index) => ({ name: s.name, ...assigned[index], prompt: prompts[index] })),
    lines,
    kind: lines.length === 1 ? "single" : spoken.size >= 2 ? "dialogue" : "monologue",
  };
}

/* ---------- writing ---------- */

const oneLine = (s: string) => s.replace(/\s*\n\s*/g, " ").trim();

/** Speaker names made safe to write back: no colons or brackets, unique, at most 24 characters. */
function exportNames(speakers: Speaker[]): string[] {
  const used = new Set<string>();
  return speakers.map((sp, index) => {
    let name = sp.name.replace(/[:：[\]]/g, "").replace(/^[@#>＠＃＞\s]+/, "").trim();
    name = [...name].slice(0, MAX_NAME).join("").trim() || `Speaker ${index + 1}`;
    let unique = name;
    for (let k = 2; used.has(lower(unique)); k++) unique = `${[...name].slice(0, MAX_NAME - 3).join("")} ${k}`;
    used.add(lower(unique));
    return unique;
  });
}

/**
 * Writes one script as an item. Every line carries its speaker's name, even in
 * a monologue, so a line that happens to begin with @, # or > is never misread.
 */
export function serializeScript(script: Script, catalog: FormatCatalog, options: { id?: boolean } = {}): string {
  const out: string[] = [];
  const title = oneLine(script.title).replace(/^#+\s*/, "") || "Untitled script";
  out.push(`## ${title}`);
  if (options.id && ID_RE.test(script.id)) out.push(`@id ${script.id}`);
  out.push(`@lang ${script.lang}`, `@engine ${script.engine}`);
  if (script.engine === "gemini") out.push(`@model ${script.model}`);

  const names = exportNames(script.speakers);
  script.speakers.forEach((sp, index) => {
    const tokens = [genderOf(sp.voice, catalog), sp.voice].filter(Boolean);
    out.push(tokens.length ? `@speaker ${names[index]}: ${tokens.join(" ")}` : `@speaker ${names[index]}`);
  });
  script.speakers.forEach((sp, index) => {
    if (sp.prompt.trim()) out.push(`@direction ${names[index]}: ${oneLine(sp.prompt)}`);
  });

  out.push("");
  for (const line of script.lines) {
    if (!line.text.trim()) continue;
    const index = Math.max(0, script.speakers.findIndex((sp) => sp.id === line.sp));
    out.push(`${names[index]}: ${oneLine(line.text)}`);
    for (const note of (line.note ?? "").split("\n")) {
      if (note.trim()) out.push(`> ${note.trim()}`);
    }
  }
  return out.join("\n");
}

/** A whole file: the header, then one item per script that has lines. */
export function serializePack(scripts: Script[], catalog: FormatCatalog): string {
  const items = scripts.filter((s) => s.lines.some((l) => l.text.trim()));
  return [FORMAT_HEADER, "", ...items.map((s) => serializeScript(s, catalog, { id: true }) + "\n")].join("\n");
}

/* ---------- into the library ---------- */

export function itemToScript(item: ParsedItem, id = item.id ?? uid()): Script {
  const speakers: Speaker[] = [];
  for (const ps of item.speakers) {
    const sp = makeSpeaker(ps.name, nextColor(speakers), ps.voice);
    sp.prompt = ps.prompt;
    speakers.push(sp);
  }
  return {
    id,
    title: item.title,
    lang: item.lang,
    engine: item.engine,
    model: item.model,
    speakers,
    lines: item.lines.map((l) => ({
      id: uid(),
      sp: speakers[l.speaker].id,
      text: l.text,
      ...(l.note ? { note: l.note } : {}),
    })),
    updated: Date.now(),
  };
}

/**
 * Applies an item edited in the Plain text view to an existing script. Speakers
 * are matched by name and keep their colour, speed, volume and skip setting,
 * and their voice unless the text chose a different one or a different gender.
 */
export function mergeIntoScript(
  script: Script,
  item: ParsedItem,
  catalog: FormatCatalog,
  mode: "replace" | "append",
): Script {
  const byName = new Map(script.speakers.map((sp) => [lower(sp.name), sp]));

  if (mode === "replace") {
    const requests = item.speakers.map((ps) => {
      const old = byName.get(lower(ps.name));
      if (ps.source === "voice") return { voice: ps.voice };
      if (old?.voice && (ps.source === "auto" || genderOf(old.voice, catalog) === ps.gender)) return { voice: old.voice };
      return ps.source === "gender" ? { gender: ps.gender } : {};
    });
    const voices = assignVoices(requests, catalog);
    const speakers: Speaker[] = [];
    item.speakers.forEach((ps, index) => {
      const old = byName.get(lower(ps.name));
      const base = old ?? makeSpeaker(ps.name, nextColor(speakers), voices[index].voice);
      speakers.push({ ...base, name: ps.name, voice: voices[index].voice, prompt: ps.prompt });
    });
    return {
      ...script,
      title: item.title,
      lang: item.lang,
      engine: item.engine,
      model: item.model,
      speakers,
      lines: item.lines.map((l) => ({
        id: uid(),
        sp: speakers[l.speaker].id,
        text: l.text,
        ...(l.note ? { note: l.note } : {}),
      })),
    };
  }

  // Append: existing speakers stay as they are; newcomers get unused voices.
  const speakers = [...script.speakers];
  const fresh = item.speakers.filter((ps) => !byName.has(lower(ps.name)));
  const voices = assignVoices(
    fresh.map((ps) => (ps.source === "voice" ? { voice: ps.voice } : ps.source === "gender" ? { gender: ps.gender } : {})),
    catalog,
    speakers.map((sp) => sp.voice),
  );
  fresh.forEach((ps, index) => {
    const sp = makeSpeaker(ps.name, nextColor(speakers), voices[index].voice);
    sp.prompt = ps.prompt;
    speakers.push(sp);
  });
  const idOf = (index: number) => {
    const name = lower(item.speakers[index].name);
    return speakers.find((sp) => lower(sp.name) === name)!.id;
  };
  return {
    ...script,
    speakers,
    lines: [
      ...script.lines,
      ...item.lines.map((l) => ({ id: uid(), sp: idOf(l.speaker), text: l.text, ...(l.note ? { note: l.note } : {}) })),
    ],
  };
}

/* ---------- files ---------- */

/**
 * Decodes an imported file. UTF-8 is expected; UTF-16 with a byte-order mark
 * (Windows Notepad's "Unicode") is accepted too. Anything else is refused
 * rather than guessed, because a wrong guess silently garbles every accent.
 */
export function decodeText(bytes: Uint8Array, fileName: string): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`"${fileName}" is not UTF-8 text. Save it as UTF-8 and import it again.`);
  }
}

/** What a pasted or opened text is: a JSON backup, a file of items, or one script. */
export function detectInput(text: string): "json" | "pack" | "script" {
  const t = text.replace(/^﻿/, "").trimStart();
  if (t.startsWith("{") || t.startsWith("[")) return "json";
  if (/^#\s*tts-studio\b/i.test(t) || /^[ \t]*(##(?!#)|＃＃)/m.test(t)) return "pack";
  return "script";
}

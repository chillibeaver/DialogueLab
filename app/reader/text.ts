/**
 * Turning written lines into something the API can synthesize.
 *
 * A line is split into speech segments and silences at its pause markers, so
 * `[1.5]` becomes real silence during playback instead of being read aloud.
 * Each speech segment is one item in the batch request and is cached on its
 * own, which is why editing one line only re-bills that line.
 */

import type { DictRule, Line, Script, Speaker } from "./model";
import { isNarrator, makeSpeaker, nextColor, uid } from "./model";

/** `[1.5]`, `[pause 2]`, `[停顿 3]`, `[p 0.5]` — the number is seconds. */
export const PAUSE_RE = /\[(?:pause|停顿|停|p)?\s*(\d+(?:\.\d+)?)\s*(?:s|秒)?\]/gi;

export type Segment = { kind: "speech"; text: string; start: number; end: number } | { kind: "pause"; ms: number };

/** Splits a line at its pause markers. Offsets point back into the original text. */
export function segmentsOf(text: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  PAUSE_RE.lastIndex = 0;

  const pushSpeech = (from: number, to: number) => {
    const raw = text.slice(from, to);
    const trimmed = raw.trim();
    if (!trimmed) return;
    const lead = raw.length - raw.trimStart().length;
    out.push({ kind: "speech", text: trimmed, start: from + lead, end: from + lead + trimmed.length });
  };

  while ((m = PAUSE_RE.exec(text))) {
    pushSpeech(last, m.index);
    out.push({ kind: "pause", ms: Math.min(30, parseFloat(m[1])) * 1000 });
    last = m.index + m[0].length;
  }
  pushSpeech(last, text.length);
  return out;
}

export const stripPauses = (text: string) => text.replace(PAUSE_RE, " ");

export function pauseTotalMs(text: string): number {
  let total = 0;
  let m: RegExpExecArray | null;
  PAUSE_RE.lastIndex = 0;
  while ((m = PAUSE_RE.exec(text))) total += Math.min(30, parseFloat(m[1])) * 1000;
  return total;
}

/**
 * Applies the pronunciation dictionary. Latin-script entries match whole words
 * only, so a rule for "Mme" does not fire inside another word.
 */
export function applyDict(text: string, dict: DictRule[]): string {
  let out = text;
  for (const rule of dict) {
    if (!rule.on || !rule.from) continue;
    try {
      const escaped = rule.from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const wordLike =
        /^[\p{L}\p{N}]/u.test(rule.from) &&
        /[\p{L}\p{N}.]$/u.test(rule.from) &&
        !/[぀-鿿가-힯]/.test(rule.from);
      const re = new RegExp(wordLike ? `(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])` : escaped, "gu");
      out = out.replace(re, () => rule.to);
    } catch {
      // A rule that cannot compile is skipped rather than breaking playback.
    }
  }
  return out;
}

/** Rough spoken length, used only for the estimated running time. */
const CJK_RE = /[぀-ヿ㐀-鿿가-힯豈-﫿]/g;

export function weightedLength(text: string): number {
  const cjk = text.match(CJK_RE);
  return text.length + (cjk ? cjk.length * 1.8 : 0);
}

export function estimateMs(text: string, rate: number): number {
  return (weightedLength(stripPauses(text).trim()) * 68) / rate + pauseTotalMs(text) + 400;
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${s % 60} s`;
}

/* ---------- Plain text import and export ---------- */

export function scriptToText(script: Script, speakerOf: (id: string) => Speaker): string {
  return script.lines.map((l) => `${speakerOf(l.sp).name}: ${l.text.replace(/\n/g, " ")}`).join("\n");
}

const NARRATOR_LABEL: Record<string, string> = {
  fr: "Narrateur", en: "Narrator", zh: "旁白", es: "Narrador", de: "Erzähler",
  it: "Narratore", pt: "Narrador", ja: "ナレーター", ko: "내레이터",
};

function findOrCreateSpeaker(name: string, script: Script): Speaker {
  const key = name.trim().toLowerCase();
  let sp = script.speakers.find((s) => (s.name || "").trim().toLowerCase() === key);
  if (!sp && NARRATOR_LABEL[key]) sp = script.speakers.find(isNarrator);
  if (!sp) {
    sp = makeSpeaker(name.trim(), nextColor(script.speakers));
    script.speakers.push(sp);
  }
  return sp;
}

/**
 * Parses `Name: line` rows. Lines with no name go to the narrator or continue
 * the previous speaker, depending on `mode`.
 */
export function parseScriptText(text: string, script: Script, mode: "narr" | "prev"): Line[] {
  const out: Line[] = [];
  let prev: Speaker | null = null;
  const narratorName = NARRATOR_LABEL[script.lang.split("-")[0]] ?? "Narrator";

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^([^:：[\]]{1,24}?)\s*[:：]\s*(.*)$/);
    let sp: Speaker;
    let body = line;
    if (m && !/^(https?|ftp)$/i.test(m[1].trim()) && !/\d$/.test(m[1].trim())) {
      sp = findOrCreateSpeaker(m[1], script);
      body = m[2];
    } else if (mode === "prev" && prev) {
      sp = prev;
    } else {
      sp = findOrCreateSpeaker(narratorName, script);
    }
    out.push({ id: uid(), sp: sp.id, text: body });
    prev = sp;
  }
  return out;
}

/** Best-effort language guess, used when pasting a whole script. */
export function guessLanguage(text: string): string | null {
  const sample = text.slice(0, 3000);
  if (/[぀-ヿ]/.test(sample)) return "ja";
  if (/[가-힯]/.test(sample)) return "ko";
  const han = (sample.match(/[一-鿿]/g) || []).length;
  if (han > sample.length * 0.15) return "zh";

  const words = " " + sample.toLowerCase().replace(/[^\p{L}' ]+/gu, " ") + " ";
  const score = (list: string[]) => list.reduce((n, w) => n + (words.split(" " + w + " ").length - 1), 0);
  const scores: Record<string, number> = {
    fr: score(["le", "la", "les", "est", "vous", "je", "une", "des", "pas", "et", "que", "bonjour", "merci"]),
    en: score(["the", "and", "you", "is", "are", "to", "of", "what", "a", "in", "hello"]),
    es: score(["el", "los", "que", "usted", "está", "es", "una", "por", "gracias", "hola"]),
    de: score(["der", "die", "und", "ich", "nicht", "ist", "sie", "das", "danke", "ein"]),
    it: score(["il", "che", "non", "sono", "una", "per", "grazie", "ciao"]),
  };
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return best[1] >= 3 ? best[0] : null;
}

export function safeFileName(title: string): string {
  return (title || "script").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 60);
}

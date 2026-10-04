/**
 * Turning written lines into something the API can synthesize.
 *
 * A line is split into speech segments and silences at its pause markers, so
 * `[1.5]` becomes real silence during playback instead of being read aloud.
 * Each speech segment is one item in the batch request and is cached on its
 * own, which is why editing one line only re-bills that line.
 */

import type { DictRule } from "./model";

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
 * only, so a rule for "Mme" does not fire inside another word, and a rule tied
 * to a language only applies to scripts in that language.
 */
export function applyDict(text: string, dict: readonly DictRule[], lang: string): string {
  const primary = lang.split("-")[0].toLowerCase();
  let out = text;
  for (const rule of dict) {
    if (!rule.on || !rule.from) continue;
    if (rule.lang && rule.lang !== primary) continue;
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

export function safeFileName(title: string): string {
  return (title || "script").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 60);
}

/**
 * The first word of a line: "mai" for "mai, le mai". Pause markers and the
 * punctuation around the word are skipped; an apostrophe or a hyphen inside
 * it is kept, as in "Qu'est-ce".
 */
export function firstWord(text: string): string {
  return /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/u.exec(stripPauses(text))?.[0] ?? "";
}

/** What one line downloads as: its first word in lower case, or its number when it has none. */
export function lineFileName(text: string, index: number): string {
  return `${safeFileName(firstWord(text).toLowerCase() || `line ${index + 1}`)}.mp3`;
}

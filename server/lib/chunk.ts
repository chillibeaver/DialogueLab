/**
 * Splits text into chunks that each fit a UTF-8 byte budget, preferring
 * sentence boundaries, then clause boundaries, then word boundaries.
 * Concatenating the returned chunks (with whitespace) restores the input.
 */

const encoder = new TextEncoder();
const byteLength = (s: string) => encoder.encode(s).length;

function sentences(text: string, locale: string): string[] {
  let segmenter: Intl.Segmenter;
  try {
    segmenter = new Intl.Segmenter(locale, { granularity: "sentence" });
  } catch {
    segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
  }
  // French typography puts a space before closing quotes ("? »"), and the segmenter
  // then breaks *before* the "»". Move leading closers back onto the previous sentence.
  const merged: string[] = [];
  for (const { segment } of segmenter.segment(text)) {
    const closer = merged.length > 0 ? LEADING_CLOSER.exec(segment) : null;
    if (!closer) {
      merged.push(segment);
      continue;
    }
    merged[merged.length - 1] += closer[0];
    if (segment.length > closer[0].length) merged.push(segment.slice(closer[0].length));
  }
  return merged;
}

const LEADING_CLOSER = /^[\s  ]*[»”’)\]]+/;

// Each level splits a piece that is still too large into smaller pieces,
// keeping separators attached so no characters are lost.
const LEVELS: Array<(text: string, locale: string) => string[]> = [
  sentences,
  (text) => text.split(/(?<=[,;:–—])/), // clauses: , ; : – —
  (text) => text.split(/(?<=\s)/), // words
  (text) => Array.from(text), // code points (last resort: one enormous "word")
];

function split(text: string, maxBytes: number, locale: string, level: number): string[] {
  const pieces = LEVELS[level](text, locale).flatMap((piece) =>
    byteLength(piece) > maxBytes && level + 1 < LEVELS.length ? split(piece, maxBytes, locale, level + 1) : [piece],
  );

  // Greedy packing. UTF-8 lengths are additive because pieces never split a code point.
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const piece of pieces) {
    const pieceBytes = byteLength(piece);
    if (current && currentBytes + pieceBytes > maxBytes) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += piece;
    currentBytes += pieceBytes;
  }
  if (current) chunks.push(current);
  return chunks;
}

export function splitText(text: string, maxBytes: number, locale = "fr-FR"): string[] {
  if (maxBytes < 4) throw new RangeError("maxBytes must be at least 4");
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];
  if (byteLength(normalized) <= maxBytes) return [normalized];
  return split(normalized, maxBytes, locale, 0)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
}

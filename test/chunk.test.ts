import { describe, expect, it } from "vitest";

import { splitText } from "../server/lib/chunk";

const bytes = (s: string) => new TextEncoder().encode(s).length;
const squash = (s: string) => s.replace(/\s+/g, "");

describe("splitText", () => {
  it("returns short text as a single trimmed chunk", () => {
    expect(splitText("  Bonjour tout le monde !  ", 100)).toEqual(["Bonjour tout le monde !"]);
  });

  it("returns nothing for blank input", () => {
    expect(splitText(" \n\t ", 100)).toEqual([]);
  });

  it("splits French prose on sentence boundaries within the byte budget", () => {
    const sentence = "« Où est la bibliothèque ? » demanda-t-elle, l'air inquiet. ";
    const text = sentence.repeat(40);
    const chunks = splitText(text, 300, "fr-FR");

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(bytes(chunk)).toBeLessThanOrEqual(300);
      expect(chunk).toMatch(/(inquiet\.|\? »)$/); // only cut at sentence ends
      expect(chunk.startsWith("»")).toBe(false); // closing quote stays with its sentence
    }
    expect(squash(chunks.join(" "))).toBe(squash(text));
  });

  it("keeps a spaced French closing guillemet with its sentence", () => {
    expect(splitText("« Où est la bibliothèque ? » demanda-t-elle.", 35, "fr-FR")).toEqual([
      "« Où est la bibliothèque ? »",
      "demanda-t-elle.",
    ]);
  });

  it("falls back to clause and word boundaries for an over-long sentence", () => {
    const text = Array.from({ length: 60 }, (_, i) => `élément numéro ${i}`).join(", ") + ".";
    const chunks = splitText(text, 200, "fr-FR");

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(bytes(chunk)).toBeLessThanOrEqual(200);
    expect(squash(chunks.join(" "))).toBe(squash(text));
  });

  it("never splits a multi-byte character, even without any boundaries", () => {
    const text = "é".repeat(500) + "😀".repeat(50); // 1000 + 200 bytes, no spaces
    const chunks = splitText(text, 101, "fr-FR");

    for (const chunk of chunks) {
      expect(bytes(chunk)).toBeLessThanOrEqual(101);
      expect(chunk).not.toContain("�");
    }
    expect(chunks.join("")).toBe(text);
  });

  it("normalizes Windows line endings", () => {
    expect(splitText("Ligne un.\r\nLigne deux.", 100)).toEqual(["Ligne un.\nLigne deux."]);
  });
});

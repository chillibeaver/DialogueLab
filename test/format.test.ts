import { describe, expect, it } from "vitest";

import {
  decodeText,
  detectInput,
  FORMAT_HEADER,
  itemToScript,
  mergeIntoScript,
  parseScriptText,
  serializePack,
  serializeScript,
} from "../app/reader/format";
import { makeScript } from "../app/reader/model";
import { buildCatalog } from "../server/catalog-view";
import { readConfig } from "../server/config";
import examplePack from "../collaborators/listening-pack.txt?raw";
import formatGuide from "../collaborators/listening-format.md?raw";

const catalog = buildCatalog(readConfig({}));
const pack = (text: string) => parseScriptText(text, catalog, { mode: "pack" });
const script = (text: string) =>
  parseScriptText(text, catalog, { mode: "script", defaults: { title: "Current", lang: "fr-FR" } });

/** A pack around one item body, with the header so no warning is expected for it. */
const one = (body: string) => pack(`${FORMAT_HEADER}\n## Test\n${body}`);
const messages = (list: { message: string }[]) => list.map((d) => d.message).join("\n");

describe("the example pack", () => {
  const result = pack(examplePack);

  it("parses with no errors and no warnings", () => {
    expect(messages(result.errors)).toBe("");
    expect(messages(result.warnings)).toBe("");
  });

  it("covers every kind of item", () => {
    expect(result.items.map((i) => [i.id, i.kind, i.lines.length])).toEqual([
      ["cafe-01", "dialogue", 5],
      ["gare-01", "monologue", 2],
      ["phrases-01", "monologue", 3],
      ["dictee-01", "single", 1],
      ["rdv-01", "dialogue", 3],
    ]);
  });

  it("applies file-level settings and item overrides", () => {
    expect(result.items.every((i) => i.lang === "fr-FR")).toBe(true);
    expect(result.items.map((i) => i.engine)).toEqual(["chirp3-hd", "chirp3-hd", "chirp3-hd", "chirp3-hd", "gemini"]);
  });
});

describe("the format guide", () => {
  // Every complete example in the guide must import cleanly, or the guide misleads.
  const blocks = [...formatGuide.matchAll(/```text\n([\s\S]*?)```/g)].map((m) => m[1]);
  const examples = blocks
    .map((block) => {
      // The header at the start of a line: the model prompt also quotes it mid-sentence.
      const header = block.search(/^#tts-studio 1$/m);
      if (header >= 0) return block.slice(header);
      return block.startsWith("##") ? `${FORMAT_HEADER}\n${block}` : null;
    })
    .filter((example): example is string => example !== null);

  it("has examples to check", () => {
    expect(examples.length).toBeGreaterThanOrEqual(6);
  });

  it.each(examples.map((example) => [example.split("\n").find((l) => l.startsWith("##")), example]))(
    "example %s imports with no errors or notes",
    (_, example) => {
      const { errors, warnings } = pack(example);
      expect(messages(errors)).toBe("");
      expect(messages(warnings)).toBe("");
    },
  );
});

describe("speakers", () => {
  it("attaches lines and translations to declared speakers", () => {
    const { items, errors } = one(
      "@speaker Serveur: male\n@speaker Claire: female\nServeur: Bonjour !\n> Hello!\nClaire: Salut.\n> Hi.\n> (casual)",
    );
    expect(errors).toEqual([]);
    const [item] = items;
    expect(item.speakers.map((s) => [s.name, s.gender])).toEqual([
      ["Serveur", "male"],
      ["Claire", "female"],
    ]);
    expect(item.lines).toMatchObject([
      { speaker: 0, text: "Bonjour !", note: "Hello!" },
      { speaker: 1, text: "Salut.", note: "Hi.\n(casual)" },
    ]);
  });

  it("does not mistake a French colon for a speaker in a monologue or a single line", () => {
    const single = one("Attention : le train part à huit heures.");
    expect(single.errors).toEqual([]);
    expect(single.warnings).toEqual([]);
    expect(single.items[0].kind).toBe("single");
    expect(single.items[0].lines[0].text).toBe("Attention : le train part à huit heures.");
    expect(single.items[0].speakers[0].name).toBe("Narrateur");

    const announcer = one("@speaker Annonce: female\nMesdames et messieurs.\nAttention : le quai est glissant.");
    expect(announcer.errors).toEqual([]);
    expect(announcer.items[0].lines.map((l) => l.text)).toEqual([
      "Mesdames et messieurs.",
      "Attention : le quai est glissant.",
    ]);
  });

  it("matches a declared name with French spacing and keeps the rest of the line", () => {
    const { items, errors } = one(
      "@speaker Claire: female\n@speaker Paul: male\nClaire : Attention : il arrive.\nPaul : Ah bon ?",
    );
    expect(errors).toEqual([]);
    expect(items[0].lines.map((l) => [l.speaker, l.text])).toEqual([
      [0, "Attention : il arrive."],
      [1, "Ah bon ?"],
    ]);
  });

  it("prefers the longest declared name", () => {
    const { items } = one("@speaker Marie\n@speaker Marie-Claire\nMarie-Claire: Oui.\nMarie: Non.");
    expect(items[0].lines.map((l) => items[0].speakers[l.speaker].name)).toEqual(["Marie-Claire", "Marie"]);
  });

  it("detects an undeclared dialogue when every line names a speaker, and says so", () => {
    const { items, errors, warnings } = one("Claire: Bonjour.\nPaul: Salut.\nClaire: Ça va ?");
    expect(errors).toEqual([]);
    expect(messages(warnings)).toMatch(/declares no speakers/);
    expect(items[0].kind).toBe("dialogue");
    expect(items[0].speakers.map((s) => s.gender)).toEqual(["male", "female"]);
  });

  it("warns when dialogue is half-labelled and would be read by one voice", () => {
    const { items, warnings } = one("Claire: Bonjour.\nPaul: Salut.\nIls entrent dans le café.");
    expect(items[0].kind).toBe("monologue");
    expect(warnings[0]).toMatchObject({ line: 5 });
    expect(messages(warnings)).toMatch(/looks like dialogue/);
  });

  it("reports an undeclared name with a suggestion and its line number", () => {
    const { errors } = one("@speaker Claire\n@speaker Paul\nClaire: Bonjour.\nClare: Salut.");
    expect(errors).toEqual([expect.objectContaining({ line: 6 })]);
    expect(errors[0].message).toMatch(/did you mean "Claire"/);
  });

  it("requires a name on every line once there are several speakers", () => {
    const { errors } = one("@speaker Claire\n@speaker Paul\nClaire: Bonjour.\nSalut.");
    expect(errors).toEqual([expect.objectContaining({ line: 6 })]);
    expect(errors[0].message).toMatch(/Start the line with who says it/);
  });

  it("gives distinct voices by gender and keeps a named voice", () => {
    const { items } = one("@speaker A: female\n@speaker B: female\n@speaker C: Charon\nA: x\nB: y\nC: z");
    const [a, b, c] = items[0].speakers;
    expect(a.gender).toBe("female");
    expect(b.gender).toBe("female");
    expect(a.voice).not.toBe(b.voice);
    expect(c).toMatchObject({ voice: "Charon", gender: "male", source: "voice" });
  });

  it("accepts genders in several languages and voice names in any case", () => {
    // Errors block the import, but what did parse is still returned for the preview.
    const { errors } = one("@speaker A: 女\n@speaker B: homme kORe\nA: x\nB: y");
    expect(messages(errors)).toMatch(/Kore is a female voice, but B is marked male/);
    const ok = one("@speaker A: 女\n@speaker B: kORe\nA: x\nB: y");
    expect(ok.errors).toEqual([]);
    expect(ok.items[0].speakers.map((s) => s.voice)[1]).toBe("Kore");
  });

  it("rejects an unknown voice and lists the real ones", () => {
    const { errors } = one("@speaker A: Bob\nA: x");
    expect(errors[0].message).toMatch(/"Bob" is neither a gender nor a voice.*Achernar/);
  });

  it("warns about a declared speaker who never speaks", () => {
    const { warnings } = one("@speaker A\n@speaker B\nA: x");
    expect(messages(warnings)).toMatch(/B is declared but has no lines/);
  });
});

describe("structure", () => {
  it("warns when the header is missing but still reads the file", () => {
    const { items, warnings } = pack("## A\nBonjour.");
    expect(items).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ line: 1 });
  });

  it("refuses a newer format version", () => {
    expect(pack("#tts-studio 2\n## A\nx").errors[0].message).toMatch(/version 2/);
  });

  it("reports text before the first heading and settings out of place", () => {
    const { errors } = pack(`${FORMAT_HEADER}\nBonjour.\n@speaker A\n## B\nx\n@lang fr-FR`);
    expect(errors.map((e) => e.line)).toEqual([2, 3, 6]);
  });

  it("requires a translation to follow a line", () => {
    expect(one("> Hello\nBonjour.").errors[0]).toMatchObject({ line: 3 });
  });

  it("rejects an item with no lines and duplicate ids", () => {
    const { errors } = pack(`${FORMAT_HEADER}\n## A\n@id x\n## B\n@id x\ny`);
    expect(messages(errors)).toMatch(/"A" has no lines/);
    expect(messages(errors)).toMatch(/already used/);
  });

  it("checks the language against the engine", () => {
    expect(one("@lang xx-XX\nBonjour.").errors[0].message).toMatch(/not available on Chirp 3: HD/);
    expect(one("@lang FR_fr\n@engine Chirp 3: HD\nBonjour.").items[0].lang).toBe("fr-FR");
  });

  it("warns that Chirp reads Gemini tags aloud, and ignores pause markers", () => {
    const chirp = one("Bonjour [sigh] et [2] puis [pause 1.5].");
    expect(chirp.warnings).toHaveLength(1);
    expect(chirp.warnings[0].message).toMatch(/Chirp 3: HD reads "\[sigh\]" aloud/);
    expect(one("@engine gemini\nBonjour [sigh].").warnings).toEqual([]);
  });

  it("survives a word processor: BOM, CRLF, full-width marks, non-breaking spaces", () => {
    const text = `﻿${FORMAT_HEADER}\r\n## A\r\n＠speaker Claire: female\r\n＠speaker Paul\r\nClaire ： Bonjour !\r\n＞ Hello!\r\nPaul: Salut.`;
    const { items, errors } = pack(text);
    expect(errors).toEqual([]);
    expect(items[0].lines[0]).toMatchObject({ text: "Bonjour !", note: "Hello!" });
  });

  it("reads the Plain text view as one script with an optional heading", () => {
    const plain = script("@speaker A\nA: Bonjour.");
    expect(plain.errors).toEqual([]);
    expect(plain.items[0].title).toBe("Current");
    expect(script("## Renamed\nBonjour.").items[0].title).toBe("Renamed");
    expect(script("## A\nx\n## B\ny").errors[0].message).toMatch(/one script/);
  });
});

describe("writing and reading back", () => {
  it("round-trips a script through the format", () => {
    const original = makeScript("Au café", "fr-FR", "gemini", "gemini-2.5-pro-tts", [
      ["Claire", "Bonjour : un café, s'il vous plaît."],
      ["Serveur", "> Tout de suite."],
      ["Claire", "# Merci !"],
    ]);
    original.speakers[0].voice = "Kore";
    original.speakers[1].voice = "Charon";
    original.speakers[1].prompt = "souriant";
    original.lines[0].note = "Hello: a coffee, please.\n(polite)";

    const text = serializePack([original], catalog);
    const { items, errors, warnings } = pack(text);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);

    const back = itemToScript(items[0]);
    expect(back).toMatchObject({
      id: original.id,
      title: "Au café",
      lang: "fr-FR",
      engine: "gemini",
      model: "gemini-2.5-pro-tts",
    });
    expect(back.speakers.map((s) => [s.name, s.voice, s.prompt])).toEqual([
      ["Claire", "Kore", ""],
      ["Serveur", "Charon", "souriant"],
    ]);
    expect(back.lines.map((l) => [l.text, l.note])).toEqual([
      ["Bonjour : un café, s'il vous plaît.", "Hello: a coffee, please.\n(polite)"],
      ["> Tout de suite.", undefined],
      ["# Merci !", undefined],
    ]);
  });

  it("makes awkward speaker names safe to write", () => {
    const s = makeScript("x", "fr-FR", "chirp3-hd", "", [
      ["A: B", "un"],
      ["a b", "deux"],
    ]);
    const text = serializeScript(s, catalog);
    expect(text).toMatch(/^@speaker A B$/m);
    expect(text).toMatch(/^@speaker a b 2$/m);
    expect(script(text).errors).toEqual([]);
  });

  it("merges an edit into a script, keeping each speaker's settings", () => {
    const current = makeScript("x", "fr-FR", "chirp3-hd", "", [["Claire", "Bonjour."]]);
    current.speakers[0].voice = "Leda";
    current.speakers[0].rate = 1.4;
    const color = current.speakers[0].color;

    const item = script("@speaker Claire\n@speaker Paul: male\nClaire: Bonjour.\nPaul: Salut.\n> Hi.").items[0];
    const merged = mergeIntoScript(current, item, catalog, "replace");
    expect(merged.id).toBe(current.id);
    expect(merged.speakers[0]).toMatchObject({ name: "Claire", voice: "Leda", rate: 1.4, color });
    expect(merged.speakers[1].voice).not.toBe("Leda");
    expect(merged.lines.map((l) => l.note)).toEqual([undefined, "Hi."]);

    const appended = mergeIntoScript(current, item, catalog, "append");
    expect(appended.lines).toHaveLength(3);
    expect(appended.speakers).toHaveLength(2);
  });
});

describe("files", () => {
  it("decodes UTF-8 with or without a BOM and UTF-16 with one", () => {
    const utf8 = new TextEncoder().encode("Café");
    expect(decodeText(utf8, "a.txt")).toBe("Café");
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8]), "a.txt")).toBe("Café");
    const utf16 = new Uint8Array([0xff, 0xfe, 0x43, 0x00, 0xe9, 0x00]);
    expect(decodeText(utf16, "a.txt")).toBe("Cé");
  });

  it("refuses text that is not UTF-8 instead of guessing", () => {
    expect(() => decodeText(new Uint8Array([0x43, 0x61, 0x66, 0xe9]), "old.txt")).toThrow(/not UTF-8/);
  });

  it("tells a backup, a pack and a bare script apart", () => {
    expect(detectInput('{"lines":[]}')).toBe("json");
    expect(detectInput("#tts-studio 1\n")).toBe("pack");
    expect(detectInput("@lang fr-FR\n## A\nx")).toBe("pack");
    expect(detectInput("Claire: Bonjour.\nPaul: Salut.")).toBe("script");
  });
});

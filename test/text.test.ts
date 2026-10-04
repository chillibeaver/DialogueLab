import { describe, expect, it } from "vitest";

import { DEFAULT_DICT, DICT_DEFAULTS_VERSION, missingDefaults, restorePrefs, type DictRule } from "../app/reader/model";
import { applyDict, firstWord, lineFileName } from "../app/reader/text";

const fr = (text: string, dict: readonly DictRule[] = DEFAULT_DICT) => applyDict(text, dict, "fr-FR");

describe("the built-in French abbreviations", () => {
  it("expands titles", () => {
    expect(fr("Mme Dupont et Mmes Martin")).toBe("Madame Dupont et Mesdames Martin");
    expect(fr("Mlle Roy et Mlles Roy")).toBe("Mademoiselle Roy et Mesdemoiselles Roy");
    expect(fr("M. Dubois et MM. Durand")).toBe("Monsieur Dubois et Messieurs Durand");
    expect(fr("Le Dr. Martin, le Dr Petit et la Dre Leblanc")).toBe(
      "Le Docteur Martin, le Docteur Petit et la Docteure Leblanc",
    );
  });

  it("expands dictionary shorthand without touching the longer forms", () => {
    expect(fr("Demander qch à qn.")).toBe("Demander quelque chose à quelqu'un.");
    expect(fr("Tu as qqch pour qqn ?")).toBe("Tu as quelque chose pour quelqu'un ?");
    expect(fr("Un fruit, p. ex. une pomme, c.-à-d. un fruit rond.")).toBe(
      "Un fruit, par exemple une pomme, c'est-à-dire un fruit rond.",
    );
  });

  it("expands places and messages", () => {
    expect(fr("rue Ste-Catherine, boulevard St-Laurent")).toBe("rue Sainte-Catherine, boulevard Saint-Laurent");
    expect(fr("RDV demain, svp. Réponds stp !")).toBe(
      "rendez-vous demain, s'il vous plaît. Réponds s'il te plaît !",
    );
  });

  it("never fires inside a word", () => {
    expect(fr("Un drôle de Drone au Stade, AM. Pr.")).toBe("Un drôle de Drone au Stade, AM. Professeur.");
    expect(fr("Me voici, Monsieur.")).toBe("Me voici, Monsieur.");
  });

  it("leaves scripts in other languages alone", () => {
    expect(applyDict("Dr Smith meets Mme Curie.", DEFAULT_DICT, "en-US")).toBe("Dr Smith meets Mme Curie.");
    expect(applyDict("Mme Tremblay", DEFAULT_DICT, "fr-CA")).toBe("Madame Tremblay");
  });

  it("applies the user's own rules in every language, and skips disabled ones", () => {
    const dict: DictRule[] = [
      { from: "Siobhan", to: "Shivawn", on: true },
      { from: "Mme", to: "Madame", on: false, lang: "fr" },
    ];
    expect(applyDict("Siobhan et Mme", dict, "fr-FR")).toBe("Shivawn et Mme");
    expect(applyDict("Siobhan", dict, "en-GB")).toBe("Shivawn");
  });
});

describe("restoring saved settings", () => {
  const spellings = (dict: DictRule[]) => dict.map((rule) => rule.from);

  it("gives a new library every default rule", () => {
    const prefs = restorePrefs(undefined);
    expect(spellings(prefs.dict)).toEqual(spellings([...DEFAULT_DICT]));
    expect(prefs.dictDefaults).toBe(DICT_DEFAULTS_VERSION);
  });

  it("adds the defaults once to a library saved before they existed, keeping its own rules first", () => {
    const prefs = restorePrefs({ dict: [{ from: "Siobhan", to: "Shivawn", on: true }] });
    expect(prefs.dict[0].from).toBe("Siobhan");
    expect(prefs.dict).toHaveLength(1 + DEFAULT_DICT.length);
  });

  it("does not bring back a default the user deleted", () => {
    const dict = DEFAULT_DICT.filter((rule) => rule.from !== "Mme").map((rule) => ({ ...rule }));
    const prefs = restorePrefs({ dict, dictDefaults: DICT_DEFAULTS_VERSION });
    expect(spellings(prefs.dict)).not.toContain("Mme");
    expect(missingDefaults(prefs.dict).map((rule) => rule.from)).toEqual(["Mme"]);
  });

  it("does not duplicate a default the user already had", () => {
    const prefs = restorePrefs({ dict: [{ from: "Mme", to: "Madame", on: false }] });
    expect(prefs.dict.filter((rule) => rule.from === "Mme")).toHaveLength(1);
    expect(prefs.dict[0].on).toBe(false);
  });
});

describe("naming a line's download", () => {
  it("takes the first word, without the punctuation after it", () => {
    expect(lineFileName("mai, le mai", 0)).toBe("mai.mp3");
    expect(lineFileName("Bonjour madame, qu'est-ce que je vous sers ?", 0)).toBe("Bonjour.mp3");
  });

  it("keeps an apostrophe or a hyphen inside the word, in either apostrophe", () => {
    expect(firstWord("Qu'est-ce que c'est ?")).toBe("Qu'est-ce");
    expect(firstWord("Aujourd’hui il pleut.")).toBe("Aujourd’hui");
    expect(firstWord("L'école est fermée.")).toBe("L'école");
  });

  it("skips what comes before the first word: dashes, quotes, pause markers", () => {
    expect(firstWord("— Oui, bien sûr.")).toBe("Oui");
    expect(firstWord("« Mai » est un mois.")).toBe("Mai");
    expect(firstWord("[1.5] Et voilà.")).toBe("Et");
    expect(firstWord("[pause 2] 2024 était une bonne année.")).toBe("2024");
  });

  it("falls back to the line's number when there is no word", () => {
    expect(lineFileName("… ?", 2)).toBe("line 3.mp3");
    expect(lineFileName("", 0)).toBe("line 1.mp3");
  });
});

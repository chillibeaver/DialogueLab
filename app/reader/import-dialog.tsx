/**
 * Import: paste or open listening material, see every problem by line, and
 * preview what will be added before anything changes. Doubles as a checker:
 * whoever writes the material can paste it here to validate it.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import type { Catalog } from "../../server/catalog-view";
import {
  decodeText,
  detectInput,
  FORMAT_HEADER,
  itemToScript,
  parseScriptText,
  type Diagnostic,
  type ItemKind,
  type ParsedItem,
} from "./format";
import { clone, uid, type Script } from "./model";
import { BTN, BTN_PRIMARY, Diagnostics, IconButton, ICONS, jumpToLine } from "./ui";

interface Preview {
  title: string;
  kind: ItemKind | "backup";
  lines: number;
  speakers: { name: string; voice: string }[];
  /** Title of the library script this item would replace, matched by id. */
  replaces: string | null;
}

interface Analysis {
  previews: Preview[];
  errors: Diagnostic[];
  warnings: Diagnostic[];
  /** Builds the scripts to add. Called once, on import, so ids are fresh. */
  build: () => Script[];
}

const KIND_LABEL: Record<Preview["kind"], string> = {
  dialogue: "Dialogue",
  monologue: "Monologue",
  single: "Single line",
  backup: "Backup",
};

const PLACEHOLDER = `${FORMAT_HEADER}
@lang fr-FR

## Au café
@speaker Serveur: male
@speaker Claire: female
Serveur: Bonjour madame, qu'est-ce que je vous sers ?
> Good morning, madam. What can I get you?
Claire: Un café crème, s'il vous plaît.

## Dictée 1
Il fait beau aujourd'hui, mais demain il va pleuvoir.`;

const EMPTY: Analysis = { previews: [], errors: [], warnings: [], build: () => [] };

function analyze(text: string, fileName: string, catalog: Catalog, existing: Record<string, Script>): Analysis {
  if (!text.trim()) return EMPTY;
  const input = detectInput(text);
  return input === "json"
    ? analyzeJson(text, catalog, existing)
    : analyzeText(text, input, fileName, catalog, existing);
}

function analyzeText(
  text: string,
  input: "pack" | "script",
  fileName: string,
  catalog: Catalog,
  existing: Record<string, Script>,
): Analysis {
  // Text without headings is taken as one script, titled after its file.
  const result = parseScriptText(text, catalog, {
    mode: input,
    defaults: { title: fileName.replace(/\.[^.]+$/, "") || "Imported script" },
  });
  const previews = result.items.map((item: ParsedItem) => ({
    title: item.title,
    kind: item.kind,
    lines: item.lines.length,
    speakers: item.speakers.map((s) => ({ name: s.name, voice: s.voice })),
    replaces: item.id && existing[item.id] ? existing[item.id].title : null,
  }));
  return { ...result, previews, build: () => result.items.map((item) => itemToScript(item)) };
}

/** A backup exported from the Library: one script, a list, or `{ scripts: [...] }`. */
function analyzeJson(text: string, catalog: Catalog, existing: Record<string, Script>): Analysis {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (caught) {
    return { ...EMPTY, errors: [{ line: 1, message: `This is not valid JSON: ${(caught as Error).message}` }] };
  }
  const list = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as { scripts?: unknown }).scripts)
      ? (data as { scripts: unknown[] }).scripts
      : [data];

  const voiceNames = catalog.voices.map((v) => v.name);
  const usable = list.filter(
    (s): s is Script =>
      !!s &&
      typeof s === "object" &&
      Array.isArray((s as Script).lines) &&
      Array.isArray((s as Script).speakers) &&
      (s as Script).speakers.length > 0,
  );
  if (!usable.length) {
    return { ...EMPTY, errors: [{ line: 1, message: "No scripts found in this JSON. Expected a TTS Studio backup." }] };
  }

  const normalize = (source: Script): Script => {
    const s = clone(source);
    s.id = typeof s.id === "string" && s.id ? s.id : uid();
    s.title = String(s.title || "Imported script");
    s.engine = s.engine === "gemini" ? "gemini" : "chirp3-hd";
    s.model ||= catalog.engines.gemini.defaultModel;
    s.lang ||= catalog.defaults.language;
    s.updated = Date.now();
    s.speakers.forEach((sp, index) => {
      sp.id ||= uid();
      sp.name = String(sp.name || `Speaker ${index + 1}`);
      sp.prompt ??= "";
      sp.rate ||= 1;
      sp.volume ??= 1;
      sp.mode = sp.mode === "skip" ? "skip" : "speak";
      if (!voiceNames.includes(sp.voice)) sp.voice = voiceNames[index % voiceNames.length];
    });
    const ids = new Set(s.speakers.map((sp) => sp.id));
    s.lines = s.lines
      .filter((l) => l && typeof l.text === "string")
      .map((l) => ({ ...l, id: l.id || uid(), sp: ids.has(l.sp) ? l.sp : s.speakers[0].id }));
    return s;
  };

  return {
    previews: usable.map((s) => ({
      title: String(s.title || "Imported script"),
      kind: "backup" as const,
      lines: s.lines.length,
      speakers: s.speakers.map((sp) => ({ name: String(sp.name), voice: String(sp.voice) })),
      replaces: s.id && existing[s.id] ? existing[s.id].title : null,
    })),
    errors: [],
    warnings:
      usable.length < list.length
        ? [{ line: 1, message: `${list.length - usable.length} entries were not scripts and will be skipped.` }]
        : [],
    build: () => usable.map(normalize),
  };
}

export function ImportDialog({
  catalog,
  existing,
  onImport,
  onClose,
}: {
  catalog: Catalog;
  existing: Record<string, Script>;
  onImport: (scripts: Script[]) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  const [fileError, setFileError] = useState("");
  const areaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => areaRef.current?.focus(), []);

  const analysis = useMemo(() => analyze(text, fileName, catalog, existing), [text, fileName, catalog, existing]);
  const count = analysis.previews.length;
  const canImport = count > 0 && analysis.errors.length === 0;

  async function openFile(file: File | undefined) {
    if (!file) return;
    setFileError("");
    try {
      const decoded = decodeText(new Uint8Array(await file.arrayBuffer()), file.name);
      setFileName(file.name);
      setText(decoded);
    } catch (caught) {
      setFileError((caught as Error).message);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[70] grid place-items-center bg-black/50 p-3 sm:p-6"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
      // A file dropped anywhere here is read, instead of the browser opening it and losing the page.
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        void openFile(event.dataTransfer.files[0]);
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-title"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
        className="flex max-h-[92vh] w-full max-w-3xl flex-col gap-3 rounded-xl border border-rule bg-surface p-4 shadow-2xl sm:p-5"
      >
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 id="import-title" className="text-lg font-semibold">
              Import scripts
            </h2>
            <p className="text-sm text-muted">
              Paste listening material or choose a file in the TTS Studio format; a JSON backup works too. Nothing
              changes until you press Import, so this is also the place to check a file.
            </p>
          </div>
          <IconButton label="Close" path={ICONS.x} onClick={onClose} />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className={`${BTN} cursor-pointer`}>
            Choose a file…
            <input
              type="file"
              accept=".txt,.md,.json,text/plain,application/json"
              className="hidden"
              onChange={(event) => {
                void openFile(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
          </label>
          <span className="min-w-0 truncate text-sm text-muted">{fileName || "or drop one here"}</span>
        </div>

        <textarea
          ref={areaRef}
          value={text}
          spellCheck={false}
          aria-label="Script text to import"
          placeholder={PLACEHOLDER}
          onChange={(event) => setText(event.target.value)}
          className="min-h-[28vh] flex-1 resize-none rounded-lg border border-rule bg-bg px-3 py-2.5 font-mono text-[13px] leading-relaxed focus:border-accent focus:outline-none"
        />

        {fileError && <p className="text-sm text-danger">{fileError}</p>}

        <Diagnostics
          errors={analysis.errors}
          warnings={analysis.warnings}
          onJump={(line) => jumpToLine(areaRef.current, line)}
        />

        {count > 0 && (
          <ul className="max-h-44 divide-y divide-rule overflow-auto rounded-lg border border-rule text-sm">
            {analysis.previews.map((preview, index) => (
              <li key={index} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2">
                <b className="min-w-0 truncate">{preview.title}</b>
                <span className="text-muted">
                  {KIND_LABEL[preview.kind]}, {preview.lines} {preview.lines === 1 ? "line" : "lines"}
                </span>
                {preview.replaces && <span className="text-danger">replaces “{preview.replaces}”</span>}
                <span className="w-full truncate text-muted">
                  {preview.speakers.map((s) => `${s.name} (${s.voice})`).join(", ")}
                </span>
              </li>
            ))}
          </ul>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2">
          <button type="button" className={BTN} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={BTN_PRIMARY}
            disabled={!canImport}
            onClick={() => onImport(analysis.build())}
          >
            {count ? `Import ${count} ${count === 1 ? "script" : "scripts"}` : "Import"}
          </button>
        </div>
      </div>
    </div>
  );
}

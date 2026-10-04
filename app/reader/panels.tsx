/** The sidebar panels: cast, playback, dictionary and library. */

import type { Catalog } from "../../server/catalog-view";
import {
  clone,
  COLORS,
  makeSpeaker,
  nextColor,
  nextSpeakerName,
  type Engine,
  type Prefs,
  type Script,
  type Speaker,
  type Store,
} from "./model";
import {
  BTN,
  BTN_DANGER,
  BTN_PRIMARY,
  Check,
  Code,
  Field,
  Heading,
  Icon,
  IconButton,
  ICONS,
  INPUT,
  Note,
  Rule,
  SEGMENT,
  SEGMENT_OFF,
  SEGMENT_ON,
  SEGMENTS,
  Slider,
} from "./ui";

export interface Reader {
  catalog: Catalog;
  store: Store;
  script: Script;
  prefs: Prefs;
  editScript: (fn: (draft: Script) => Script | void) => void;
  editPrefs: (fn: (draft: Prefs) => void) => void;
  editStore: (fn: (draft: Store) => void) => void;
  openScript: (id: string) => void;
  toast: (message: string, undo?: () => void) => void;
  previewSpeaker: (speaker: Speaker) => void;
  exportAudio: () => void;
  busy: boolean;
}

/* ---------- Cast ---------- */

export function CastPanel({ reader }: { reader: Reader }) {
  const { script, catalog, editScript, toast } = reader;
  const engines = Object.keys(catalog.engines) as Engine[];
  const languages = catalog.engines[script.engine].languages;
  const used = new Set(script.lines.map((l) => l.sp));
  const unused = script.speakers.filter((s) => !used.has(s.id));

  function switchEngine(engine: Engine) {
    editScript((draft) => {
      draft.engine = engine;
      if (!catalog.engines[engine].languages.some((l) => l.code === draft.lang)) {
        draft.lang = catalog.defaults.language;
      }
    });
  }

  return (
    <div>
      <Field label="Voice engine" hint={engineHint(script.engine)}>
        <select value={script.engine} onChange={(e) => switchEngine(e.target.value as Engine)} className={INPUT}>
          {engines.map((id) => (
            <option key={id} value={id}>
              {catalog.engines[id].name}
            </option>
          ))}
        </select>
      </Field>

      {script.engine === "gemini" && (
        <Field label="Model">
          <select
            value={script.model}
            onChange={(e) => editScript((draft) => void (draft.model = e.target.value))}
            className={INPUT}
          >
            {catalog.engines.gemini.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
                {m.availability === "preview" ? " (preview)" : ""}
              </option>
            ))}
          </select>
        </Field>
      )}

      <Field label="Script language">
        <select
          value={languages.some((l) => l.code === script.lang) ? script.lang : catalog.defaults.language}
          onChange={(e) => editScript((draft) => void (draft.lang = e.target.value))}
          className={INPUT}
        >
          {languages.map((l) => (
            <option key={l.code} value={l.code}>
              {l.code}
              {l.availability === "preview" ? " (preview)" : ""}
            </option>
          ))}
        </select>
      </Field>

      {script.speakers.map((speaker, index) => (
        <SpeakerCard key={speaker.id} speaker={speaker} index={index} reader={reader} />
      ))}

      <div className="mt-1 flex flex-wrap gap-2">
        <button
          type="button"
          className={BTN}
          onClick={() =>
            editScript((draft) => {
              const voice = catalog.voices[draft.speakers.length % catalog.voices.length].name;
              draft.speakers.push(makeSpeaker(nextSpeakerName(draft.speakers), nextColor(draft.speakers), voice));
            })
          }
        >
          <Icon path={ICONS.plus} size={16} />
          Add speaker
        </button>
        {unused.length > 0 && script.speakers.length > 1 && (
          <button
            type="button"
            className={BTN}
            onClick={() => {
              const snapshot = clone(script.speakers);
              editScript((draft) => {
                draft.speakers = draft.speakers.filter((s) => used.has(s.id));
                if (!draft.speakers.length) draft.speakers = [snapshot[0]];
              });
              toast(`Removed ${unused.length} unused ${unused.length === 1 ? "speaker" : "speakers"}`, () =>
                editScript((draft) => void (draft.speakers = snapshot)),
              );
            }}
          >
            Remove unused ({unused.length})
          </button>
        )}
      </div>

      <Rule />
      <Note>
        <p>Skip leaves a speaker out of playback entirely.</p>
        <p>
          Speed and volume are applied while playing, so changing them is instant and costs nothing. Only the words,
          the voice and the engine decide what gets synthesized.
        </p>
      </Note>
    </div>
  );
}

function engineHint(engine: Engine) {
  return engine === "chirp3-hd"
    ? "30 HD voices. The straightforward choice for clear narration."
    : "Each speaker can carry a direction such as “anxious, speaking quickly”.";
}

function SpeakerCard({ speaker, index, reader }: { speaker: Speaker; index: number; reader: Reader }) {
  const { script, catalog, editScript, toast, previewSpeaker } = reader;

  const edit = (fn: (draft: Speaker) => void) =>
    editScript((draft) => {
      const target = draft.speakers.find((s) => s.id === speaker.id);
      if (target) fn(target);
    });

  function cycleColor() {
    const others = new Set(script.speakers.filter((s) => s.id !== speaker.id).map((s) => s.color.toUpperCase()));
    const available = COLORS.filter((c) => !others.has(c.toUpperCase()));
    if (!available.length) return toast("Every colour in the palette is taken");
    const at = available.findIndex((c) => c.toUpperCase() === speaker.color.toUpperCase());
    edit((draft) => void (draft.color = available[(at + 1) % available.length]));
  }

  function remove() {
    const snapshot = clone(script);
    const target = script.speakers.find((s) => s.id !== speaker.id)!;
    const moved = script.lines.filter((l) => l.sp === speaker.id).length;
    editScript((draft) => {
      draft.lines.forEach((l) => {
        if (l.sp === speaker.id) l.sp = target.id;
      });
      draft.speakers = draft.speakers.filter((s) => s.id !== speaker.id);
    });
    toast(
      moved
        ? `Deleted ${speaker.name}; ${moved} ${moved === 1 ? "line moves" : "lines move"} to ${target.name}`
        : `Deleted ${speaker.name}`,
      () => editScript(() => snapshot),
    );
  }

  return (
    <div
      className="mb-2.5 rounded-lg border border-rule border-l-4 bg-surface p-2.5 pl-3"
      style={{ borderLeftColor: speaker.color }}
    >
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={cycleColor}
          aria-label={`Change colour for ${speaker.name}`}
          title="Change colour"
          className="h-5 w-5 shrink-0 rounded-full ring-1 ring-rule"
          style={{ backgroundColor: speaker.color }}
        />
        <input
          type="text"
          value={speaker.name}
          maxLength={24}
          aria-label={`Speaker ${index + 1} name`}
          onChange={(e) => edit((draft) => void (draft.name = e.target.value))}
          onBlur={(e) => {
            if (!e.target.value.trim()) edit((draft) => void (draft.name = `Speaker ${index + 1}`));
          }}
          className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1.5 py-1 font-semibold hover:border-rule focus:border-accent focus:outline-none"
        />
        <IconButton label={`Preview ${speaker.name}`} path={ICONS.hear} onClick={() => previewSpeaker(speaker)} />
        {script.speakers.length > 1 && (
          <IconButton label={`Delete ${speaker.name}`} path={ICONS.x} onClick={remove} />
        )}
      </div>

      <select
        value={speaker.voice}
        aria-label={`Voice for ${speaker.name}`}
        onChange={(e) => edit((draft) => void (draft.voice = e.target.value))}
        className={`${INPUT} my-1.5`}
      >
        {catalog.voices.map((v) => (
          <option key={v.name} value={v.name}>
            {v.name} — {v.gender}
          </option>
        ))}
      </select>

      {script.engine === "gemini" && (
        <input
          type="text"
          value={speaker.prompt}
          maxLength={catalog.limits.maxPromptChars}
          placeholder="Direction, e.g. “warm and unhurried”"
          aria-label={`Direction for ${speaker.name}`}
          onChange={(e) => edit((draft) => void (draft.prompt = e.target.value))}
          className={`${INPUT} mb-1.5`}
        />
      )}

      <div role="radiogroup" aria-label={`How to handle ${speaker.name}`} className={`inline-flex ${SEGMENTS}`}>
        {(["speak", "skip"] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={speaker.mode === mode}
            onClick={() => edit((draft) => void (draft.mode = mode))}
            className={`${SEGMENT} py-1 ${speaker.mode === mode ? SEGMENT_ON : SEGMENT_OFF}`}
          >
            {mode === "speak" ? "Read aloud" : "Skip"}
          </button>
        ))}
      </div>

      <details className="mt-1">
        <summary className="cursor-pointer py-1 text-sm text-muted">Speed and volume</summary>
        <Slider
          label="Speed"
          value={speaker.rate}
          min={0.5}
          max={2}
          step={0.05}
          format={(v) => "×" + v.toFixed(2)}
          onChange={(v) => edit((draft) => void (draft.rate = v))}
        />
        <Slider
          label="Volume"
          value={speaker.volume}
          min={0}
          max={1}
          step={0.05}
          format={(v) => Math.round(v * 100) + "%"}
          onChange={(v) => edit((draft) => void (draft.volume = v))}
        />
      </details>
    </div>
  );
}

/* ---------- Playback ---------- */

export function PlaybackPanel({ reader }: { reader: Reader }) {
  const { prefs, editPrefs } = reader;
  return (
    <div>
      <Heading>Pacing</Heading>
      <Slider
        label="Speed"
        value={prefs.speed}
        min={0.5}
        max={2}
        step={0.05}
        format={(v) => "×" + v.toFixed(2)}
        onChange={(v) => editPrefs((d) => void (d.speed = v))}
      />
      <Slider
        label="Gap"
        value={prefs.gap}
        min={0}
        max={3}
        step={0.1}
        format={(v) => v.toFixed(1) + " s"}
        onChange={(v) => editPrefs((d) => void (d.gap = v))}
      />
      <Slider
        label="Repeat"
        value={prefs.repeat}
        min={1}
        max={5}
        step={1}
        format={(v) => v + "×"}
        onChange={(v) => editPrefs((d) => void (d.repeat = v))}
      />

      <Field label="Shadowing: after each line, leave time to repeat it aloud">
        <select
          value={String(prefs.shadow)}
          onChange={(e) => editPrefs((d) => void (d.shadow = Number(e.target.value)))}
          className={INPUT}
        >
          {[
            [0, "Off"],
            [0.6, "Short (0.6 × the line)"],
            [1, "Same as the line"],
            [1.5, "Relaxed (1.5 ×)"],
            [2, "Very relaxed (2 ×)"],
          ].map(([value, label]) => (
            <option key={String(value)} value={String(value)}>
              {label}
            </option>
          ))}
        </select>
      </Field>

      <Check checked={prefs.loop} onChange={(v) => editPrefs((d) => void (d.loop = v))}>
        Start over when the script ends
      </Check>

      <Rule />
      <Heading>Display</Heading>
      <Check checked={prefs.follow} onChange={(v) => editPrefs((d) => void (d.follow = v))}>
        Scroll to the current line while playing
      </Check>
      <Check checked={prefs.notes} onChange={(v) => editPrefs((d) => void (d.notes = v))}>
        Show translations under each line
      </Check>
      <Check checked={prefs.hide} onChange={(v) => editPrefs((d) => void (d.hide = v))}>
        Dictation mode: blur the text, then reveal lines one by one
      </Check>

      <Field label="Appearance">
        <select
          value={prefs.theme}
          onChange={(e) => editPrefs((d) => void (d.theme = e.target.value as Prefs["theme"]))}
          className={INPUT}
        >
          <option value="auto">Match system</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </Field>

      <Rule />
      <Heading>Keyboard</Heading>
      <Note>
        <p>
          <Code>Space</Code> play or pause, <Code>←</Code> <Code>→</Code> previous or next line, <Code>Esc</Code> stop,{" "}
          <Code>S</Code> slow mode, <Code>[</Code> the sidebar.
        </p>
        <p>
          While editing: <Code>Enter</Code> starts the next line with the other speaker, <Code>Shift+Enter</Code> adds
          a line break, <Code>Backspace</Code> on an empty line deletes it, <Code>↑</Code> <Code>↓</Code> move between
          lines.
        </p>
      </Note>

      <Rule />
      <Heading>About the audio</Heading>
      <Note>
        <p>
          Voices come from Google Cloud Text-to-Speech, so they sound the same in every browser. Each distinct line is
          synthesized once and then cached, which is why replaying, repeating and looping are instant and free.
        </p>
        <p>Editing one line only re-synthesizes that line.</p>
      </Note>
    </div>
  );
}

/* ---------- Dictionary ---------- */

export function DictionaryPanel({ reader }: { reader: Reader }) {
  const { prefs, editPrefs, script, previewSpeaker } = reader;
  return (
    <div>
      <Note>
        <p>
          Before a line is read, each spelling on the left is replaced by the pronunciation on the right. The text on
          screen does not change. Useful for abbreviations and names, for example <Code>Mme</Code> read as{" "}
          <Code>Madame</Code>. Matching is case-sensitive, and Latin-script entries match whole words only.
        </p>
      </Note>

      <div className="mt-3">
        {prefs.dict.map((rule, index) => (
          <div key={index} className="mb-2 flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={rule.on}
              aria-label="Enable this rule"
              onChange={(e) => editPrefs((d) => void (d.dict[index].on = e.target.checked))}
              className="accent-accent"
            />
            <input
              type="text"
              value={rule.from}
              placeholder="Spelling"
              aria-label="Spelling in the text"
              onChange={(e) => editPrefs((d) => void (d.dict[index].from = e.target.value))}
              className={INPUT}
            />
            <span className="shrink-0 text-sm text-muted">reads as</span>
            <input
              type="text"
              value={rule.to}
              placeholder="Pronunciation"
              aria-label="Read it as"
              onChange={(e) => editPrefs((d) => void (d.dict[index].to = e.target.value))}
              className={INPUT}
            />
            <IconButton
              label="Preview pronunciation"
              path={ICONS.hear}
              onClick={() => previewSpeaker({ ...script.speakers[0], prompt: "" })}
            />
            <IconButton
              label="Delete this rule"
              path={ICONS.x}
              onClick={() => editPrefs((d) => void d.dict.splice(index, 1))}
            />
          </div>
        ))}
      </div>

      <button
        type="button"
        className={BTN}
        onClick={() => editPrefs((d) => void d.dict.push({ from: "", to: "", on: true }))}
      >
        <Icon path={ICONS.plus} size={16} />
        Add a rule
      </button>
    </div>
  );
}

/* ---------- Library ---------- */

export function LibraryPanel({
  reader,
  onNew,
  onDuplicate,
  onDelete,
  onImport,
  onExportScript,
  onExportLibrary,
  onExportJson,
}: {
  reader: Reader;
  onNew: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onImport: () => void;
  onExportScript: () => void;
  onExportLibrary: () => void;
  onExportJson: () => void;
}) {
  const { store, script, openScript, busy, exportAudio } = reader;
  const list = Object.values(store.scripts).sort((a, b) => (b.updated || 0) - (a.updated || 0));

  return (
    <div>
      <Note>
        <p>Scripts are saved in this browser. Clearing browser data deletes them, so export anything important.</p>
      </Note>

      <div className="mt-3">
        {list.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-current={item.id === script.id}
            onClick={() => openScript(item.id)}
            className={`mb-2 flex w-full items-center gap-2.5 rounded-lg border bg-surface px-3 py-2 text-left ${
              item.id === script.id ? "border-ink" : "border-rule hover:border-muted"
            }`}
          >
            <span className="min-w-0 flex-1">
              <b className="block truncate">{item.title || "Untitled script"}</b>
              <span className="text-sm text-muted">
                {item.lang}, {item.lines.length} {item.lines.length === 1 ? "line" : "lines"}
              </span>
            </span>
          </button>
        ))}
      </div>

      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" className={BTN_PRIMARY} onClick={onNew}>
          New script
        </button>
        <button type="button" className={BTN} onClick={onDuplicate}>
          Duplicate
        </button>
      </div>

      <Rule />
      <Heading>Import</Heading>
      <button type="button" className={BTN} onClick={onImport}>
        Import scripts…
      </button>
      <Note>
        <p className="mt-2">
          Paste or open listening material in the TTS Studio format, or a JSON backup. Every problem is listed by line
          before anything is added.
        </p>
      </Note>

      <Rule />
      <Heading>Export</Heading>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={BTN} onClick={onExportScript}>
          This script (.txt)
        </button>
        <button type="button" className={BTN} onClick={onExportLibrary}>
          All scripts (.txt)
        </button>
        <button type="button" className={BTN} onClick={onExportJson}>
          Backup (.json)
        </button>
        <button type="button" className={BTN} onClick={exportAudio} disabled={busy}>
          <Icon path={ICONS.download} size={16} />
          {busy ? "Preparing…" : "Audio (.mp3)"}
        </button>
      </div>
      <Note>
        <p className="mt-2">
          Text exports use the same format as import, so they can be edited and imported again. Audio joins every line
          into one MP3, in order, leaving out skipped speakers.
        </p>
      </Note>

      <Rule />
      <button type="button" className={BTN_DANGER} onClick={onDelete}>
        Delete this script
      </button>
    </div>
  );
}

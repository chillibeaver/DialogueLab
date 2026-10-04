/** The script itself: the line editor and the plain-text view. */

import { useEffect, useRef, useState } from "react";

import { clone, isNarrator, speakerOf, uid, type Line, type Script } from "./model";
import type { Reader } from "./panels";
import type { PlayerState } from "./player";
import { guessLanguage, parseScriptText, PAUSE_RE, scriptToText } from "./text";
import { BTN, BTN_PRIMARY, Code, IconButton, ICONS, INPUT, Note } from "./ui";

/**
 * Renders a line, showing pause markers as chips and tinting the segment being
 * spoken. Google returns no word timings, so the highlight follows whole
 * segments rather than individual words.
 */
function LineText({ text, range, color }: { text: string; range: [number, number] | null; color: string }) {
  const marks: [number, number, string][] = [];
  let m: RegExpExecArray | null;
  PAUSE_RE.lastIndex = 0;
  while ((m = PAUSE_RE.exec(text))) marks.push([m.index, m.index + m[0].length, m[1]]);

  const cuts = new Set<number>([0, text.length]);
  for (const [a, b] of marks) {
    cuts.add(a);
    cuts.add(b);
  }
  if (range) {
    cuts.add(range[0]);
    cuts.add(range[1]);
  }
  const points = [...cuts].filter((x) => x >= 0 && x <= text.length).sort((a, b) => a - b);

  const parts: React.ReactNode[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (a === b) continue;
    const mark = marks.find((x) => a >= x[0] && b <= x[1]);
    if (mark) {
      if (a === mark[0]) {
        parts.push(
          <span
            key={a}
            className="mx-0.5 align-middle rounded-full border border-rule bg-soft px-1.5 py-0.5 font-ui text-xs text-muted"
          >
            pause {mark[2]} s
          </span>,
        );
      }
      continue;
    }
    const slice = text.slice(a, b);
    const lit = range && a >= range[0] && b <= range[1];
    parts.push(
      lit ? (
        <span key={a} className="rounded-sm" style={{ backgroundColor: `color-mix(in srgb, ${color} 18%, transparent)` }}>
          {slice}
        </span>
      ) : (
        <span key={a}>{slice}</span>
      ),
    );
  }
  return <>{parts}</>;
}

export function ScriptLines({
  reader,
  state,
  onPlayLine,
  onPlayFrom,
}: {
  reader: Reader;
  state: PlayerState;
  onPlayLine: (index: number) => void;
  onPlayFrom: (index: number) => void;
}) {
  const { script, prefs, editScript, toast } = reader;
  const [editing, setEditing] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Set<string>>(() => new Set());
  const currentRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!prefs.follow || state.status === "idle" || !currentRef.current) return;
    currentRef.current.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [state.line, state.status, prefs.follow]);

  function insertAfter(index: number, speakerId: string) {
    const line: Line = { id: uid(), sp: speakerId, text: "" };
    editScript((draft) => void draft.lines.splice(index + 1, 0, line));
    setEditing(line.id);
  }

  /** The other speaker in the most recent exchange, so dialogue alternates. */
  function nextSpeaker(index: number): string {
    const me = script.lines[index].sp;
    for (let i = index - 1; i >= 0; i--) {
      const sp = speakerOf(script, script.lines[i].sp);
      if (script.lines[i].sp !== me && !isNarrator(sp)) return script.lines[i].sp;
    }
    const other = script.speakers.find((s) => s.id !== me && !isNarrator(s));
    return other ? other.id : me;
  }

  function removeLine(index: number) {
    const snapshot = clone(script.lines);
    editScript((draft) => void draft.lines.splice(index, 1));
    toast("Line deleted", () => editScript((draft) => void (draft.lines = snapshot)));
  }

  return (
    <div className="max-w-[820px]">
      {!script.lines.length && (
        <div className="mb-3 rounded-xl border border-dashed border-rule px-4 py-6">
          <p className="mb-1.5">This script is empty.</p>
          <Note>
            <p>
              Pick a speaker below to write the first line. Press <Code>Enter</Code> when you finish a line and the
              other speaker takes over. Or open <b>Plain text</b> and paste a whole dialogue at once.
            </p>
          </Note>
        </div>
      )}

      {script.lines.map((line, index) => {
        const speaker = speakerOf(script, line.sp);
        const active = state.line === index && state.status !== "idle";
        const cued = state.line === index && state.status === "idle";
        const hidden = prefs.hide && !revealed.has(line.id);

        return (
          <div
            key={line.id}
            ref={state.line === index ? currentRef : null}
            className={`group relative grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 rounded-r-lg border-l-4 py-2.5 pl-3 pr-2 sm:grid-cols-[132px_minmax(0,1fr)_auto] ${
              active ? "bg-now" : "hover:bg-soft"
            }`}
            style={{ borderLeftColor: active || cued ? speaker.color : "transparent" }}
          >
            <div className="flex items-center gap-1 pt-0.5 sm:flex-col sm:items-start">
              <select
                value={line.sp}
                aria-label={`Who says line ${index + 1}`}
                onChange={(e) => editScript((draft) => void (draft.lines[index].sp = e.target.value))}
                className="max-w-full truncate rounded border-0 bg-transparent px-1 py-0.5 text-sm font-semibold focus:outline-none"
                style={{ color: speaker.color }}
              >
                {script.speakers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              {speaker.mode === "skip" && (
                <span className="rounded-full border border-rule px-1.5 text-xs text-muted">skipped</span>
              )}
            </div>

            <div className="col-span-2 sm:col-span-1">
              {editing === line.id ? (
                <LineEditor
                  value={line.text}
                  onChange={(value) => editScript((draft) => void (draft.lines[index].text = value))}
                  onDone={() => setEditing(null)}
                  onEnter={() => {
                    setEditing(null);
                    insertAfter(index, nextSpeaker(index));
                  }}
                  onBackspaceEmpty={() => {
                    if (script.lines.length <= 1) return false;
                    setEditing(script.lines[Math.max(0, index - 1)]?.id ?? null);
                    editScript((draft) => void draft.lines.splice(index, 1));
                    return true;
                  }}
                  onUp={() => index > 0 && setEditing(script.lines[index - 1].id)}
                  onDown={() => index < script.lines.length - 1 && setEditing(script.lines[index + 1].id)}
                />
              ) : (
                <div
                  role="button"
                  tabIndex={0}
                  aria-label={`Line ${index + 1}, press Enter to edit`}
                  onClick={() => (hidden ? setRevealed(new Set(revealed).add(line.id)) : setEditing(line.id))}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter") return;
                    e.preventDefault();
                    setEditing(line.id);
                  }}
                  className={`min-h-[1.7em] cursor-text whitespace-pre-wrap break-words rounded font-read text-[1.14rem] leading-[1.7] ${
                    speaker.mode === "skip" ? "opacity-45" : ""
                  } ${hidden ? "select-none blur-[7px]" : ""}`}
                >
                  {line.text ? (
                    <LineText text={line.text} range={active ? state.range : null} color={speaker.color} />
                  ) : (
                    <span className="text-muted">(empty, click to edit)</span>
                  )}
                </div>
              )}

              {active && state.waiting && (
                <div className="mt-1 flex items-center gap-2.5 text-xs text-muted">
                  <span>Repeat after it</span>
                  <i
                    className="h-1 flex-1 origin-left rounded"
                    style={{
                      backgroundColor: speaker.color,
                      animation: `shrink ${Math.round(state.waiting.ms)}ms linear forwards`,
                    }}
                  />
                </div>
              )}
            </div>

            <div className="col-start-2 row-start-1 flex opacity-100 sm:col-start-3 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
              {prefs.hide && (
                <IconButton
                  label="Show or hide this line"
                  path={ICONS.eye}
                  onClick={() => {
                    const next = new Set(revealed);
                    if (next.has(line.id)) next.delete(line.id);
                    else next.add(line.id);
                    setRevealed(next);
                  }}
                />
              )}
              <IconButton label="Play this line only" path={ICONS.play} onClick={() => onPlayLine(index)} />
              <IconButton label="Play from this line" path={ICONS.from} onClick={() => onPlayFrom(index)} />
              <IconButton
                label="Move up"
                path={ICONS.up}
                disabled={index === 0}
                onClick={() =>
                  editScript((draft) => {
                    [draft.lines[index - 1], draft.lines[index]] = [draft.lines[index], draft.lines[index - 1]];
                  })
                }
              />
              <IconButton
                label="Move down"
                path={ICONS.down}
                disabled={index === script.lines.length - 1}
                onClick={() =>
                  editScript((draft) => {
                    [draft.lines[index + 1], draft.lines[index]] = [draft.lines[index], draft.lines[index + 1]];
                  })
                }
              />
              <IconButton label="Delete this line" path={ICONS.x} onClick={() => removeLine(index)} />
            </div>
          </div>
        );
      })}

      <div className="ml-4 mt-3.5 flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted">Add a line:</span>
        {script.speakers.map((speaker) => (
          <button
            key={speaker.id}
            type="button"
            className={`${BTN} border-l-4`}
            style={{ borderLeftColor: speaker.color }}
            onClick={() => insertAfter(script.lines.length - 1, speaker.id)}
          >
            {speaker.name}
          </button>
        ))}
      </div>
    </div>
  );
}

function LineEditor({
  value,
  onChange,
  onDone,
  onEnter,
  onBackspaceEmpty,
  onUp,
  onDown,
}: {
  value: string;
  onChange: (value: string) => void;
  onDone: () => void;
  onEnter: () => void;
  onBackspaceEmpty: () => boolean;
  onUp: () => void;
  onDown: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  function fit(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }

  return (
    <textarea
      ref={(el) => {
        ref.current = el;
        if (el) fit(el);
      }}
      value={value}
      rows={1}
      aria-label="Edit line"
      onChange={(e) => {
        onChange(e.target.value);
        fit(e.target);
      }}
      onBlur={onDone}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        const el = e.currentTarget;
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          onEnter();
        } else if (e.key === "Backspace" && el.value === "") {
          if (onBackspaceEmpty()) e.preventDefault();
        } else if (e.key === "Escape") {
          e.preventDefault();
          el.blur();
        } else if (e.key === "ArrowUp" && el.selectionStart === 0 && el.selectionEnd === 0) {
          e.preventDefault();
          onUp();
        } else if (e.key === "ArrowDown" && el.selectionStart === el.value.length) {
          e.preventDefault();
          onDown();
        }
      }}
      className="-mx-1.5 block w-[calc(100%+0.75rem)] resize-none overflow-hidden rounded-md border border-accent bg-surface px-1.5 font-read text-[1.14rem] leading-[1.7] focus:outline-none"
    />
  );
}

/* ---------- Plain text ---------- */

export function BulkText({ reader, onApplied }: { reader: Reader; onApplied: () => void }) {
  const { script, catalog, prefs, editScript, editPrefs, toast } = reader;
  const [text, setText] = useState(() => scriptToText(script, (id) => speakerOf(script, id)));

  function apply(append: boolean) {
    const draft = clone(script);
    let switched = "";
    if (!append) {
      const guess = guessLanguage(text);
      const match = guess && catalog.engines[draft.engine].languages.find((l) => l.code.startsWith(guess + "-"));
      if (match && match.code !== draft.lang) {
        draft.lang = match.code;
        switched = match.code;
      }
      draft.speakers = [];
    }
    const lines = parseScriptText(text, draft, prefs.narrMode);
    draft.lines = append ? [...script.lines, ...lines] : lines;

    // Give every speaker the parser invented a distinct catalog voice.
    draft.speakers.forEach((sp, index) => {
      if (!sp.voice) sp.voice = catalog.voices[index % catalog.voices.length].name;
    });
    if (!draft.speakers.length) draft.speakers = clone(script.speakers);

    editScript(() => draft);
    onApplied();
    toast(
      append
        ? `Added ${lines.length} ${lines.length === 1 ? "line" : "lines"}`
        : `Created ${lines.length} ${lines.length === 1 ? "line" : "lines"}` +
            (switched ? `; language set to ${switched}` : ""),
    );
  }

  return (
    <div>
      <Note>
        <p>
          One line per row, written as <Code>Name: line</Code> (a full-width colon works too). New names become
          speakers and each gets its own voice. To pause inside a line, write <Code>[1.5]</Code> or{" "}
          <Code>[pause 2]</Code>, in seconds.
        </p>
      </Note>
      <textarea
        value={text}
        spellCheck={false}
        aria-label="Script text, one line per row"
        onChange={(e) => setText(e.target.value)}
        className="mt-3 min-h-[52vh] w-full resize-y rounded-lg border border-rule bg-surface px-3.5 py-3 font-read leading-[1.7]"
      />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" className={BTN_PRIMARY} onClick={() => apply(false)}>
          Replace the script
        </button>
        <button type="button" className={BTN} onClick={() => apply(true)}>
          Append
        </button>
        <span className="ml-auto text-sm text-muted">Lines without a name:</span>
        <select
          value={prefs.narrMode}
          aria-label="Lines without a speaker name"
          onChange={(e) => editPrefs((d) => void (d.narrMode = e.target.value as "narr" | "prev"))}
          className={`${INPUT} w-auto`}
        >
          <option value="narr">go to the narrator</option>
          <option value="prev">continue the previous speaker</option>
        </select>
      </div>
    </div>
  );
}

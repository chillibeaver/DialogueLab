/** Small presentational pieces shared by the reader's panels. */

import type { ReactNode } from "react";

export const INPUT =
  "w-full min-w-0 rounded-md border border-rule bg-surface px-2.5 py-1.5 text-sm " +
  "placeholder:text-muted focus:border-accent focus:outline-none";

export const BTN =
  "inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-rule bg-surface " +
  "px-3 py-1.5 text-sm leading-tight transition hover:border-muted " +
  "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-rule";

export const BTN_PRIMARY =
  "inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-accent bg-accent " +
  "px-3 py-1.5 text-sm font-semibold leading-tight text-accent-ink transition hover:opacity-90 " +
  "disabled:cursor-not-allowed disabled:opacity-40";

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="mb-3.5 grid gap-1">
      <span className="text-sm text-muted">{label}</span>
      {children}
      {hint && <p className="text-sm leading-snug text-muted">{hint}</p>}
    </div>
  );
}

export function Check({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label className="mb-2.5 flex cursor-pointer items-start gap-2 text-sm">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-1 accent-accent"
      />
      <span>{children}</span>
    </label>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="my-1 grid grid-cols-[4.5em_1fr_3.6em] items-center gap-2 text-sm">
      <span className="text-muted">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full accent-accent"
      />
      <output className="text-right tabular-nums text-muted">{format(value)}</output>
    </label>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return <div className="space-y-2 text-sm leading-relaxed text-muted">{children}</div>;
}

export function Rule() {
  return <hr className="my-4 border-0 border-t border-rule" />;
}

export function Heading({ children }: { children: ReactNode }) {
  return <h3 className="mb-2.5 text-base font-semibold">{children}</h3>;
}

export function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-soft px-1.5 py-0.5 text-[0.9em]">{children}</code>;
}

/**
 * A segmented control used for every tab bar. It never scrolls: the labels are
 * short enough to fit the sidebar, and a scroll container here produced stray
 * scrollbars (overflow on one axis forces the other to scroll too).
 */
export function Tabs<T extends string>({
  tabs,
  active,
  onSelect,
  stretch = false,
  label,
}: {
  tabs: [T, string][];
  active: T;
  onSelect: (tab: T) => void;
  /** Fill the width, for the sidebar; otherwise the control fits its labels. */
  stretch?: boolean;
  label: string;
}) {
  function onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next = tabs[(index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length][0];
    onSelect(next);
    const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role=tab]");
    buttons?.[tabs.findIndex(([id]) => id === next)]?.focus();
  }

  return (
    <div
      role="tablist"
      aria-label={label}
      className={`mb-4 rounded-lg border border-rule bg-surface p-0.5 ${stretch ? "flex" : "inline-flex"}`}
    >
      {tabs.map(([id, text], index) => {
        const selected = active === id;
        // A divider sits between two unselected tabs; the selected pill needs none.
        const divider = index > 0 && !selected && tabs[index - 1][0] !== active;
        return (
          <button
            key={id}
            role="tab"
            type="button"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(id)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={`relative min-w-0 truncate rounded-md px-2.5 py-1.5 text-sm transition-colors ${
              stretch ? "flex-auto" : ""
            } ${selected ? "bg-ink font-semibold text-surface" : "text-muted hover:bg-soft hover:text-ink"} ${
              divider
                ? "before:absolute before:inset-y-2 before:left-0 before:w-px before:bg-rule before:content-['']"
                : ""
            }`}
          >
            {text}
          </button>
        );
      })}
    </div>
  );
}

export function Icon({ path, size = 18 }: { path: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true" className="shrink-0">
      <path d={path} />
    </svg>
  );
}

export function IconButton({
  label,
  onClick,
  path,
  disabled,
  size = 18,
  className = "",
}: {
  label: string;
  onClick: () => void;
  path: string;
  disabled?: boolean;
  size?: number;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-soft hover:text-ink disabled:cursor-not-allowed disabled:opacity-30 ${className}`}
    >
      <Icon path={path} size={size} />
    </button>
  );
}

export const ICONS = {
  play: "M8 5v14l11-7z",
  pause: "M7 5h4v14H7zM13 5h4v14h-4z",
  stop: "M7.5 7.5h9v9h-9z",
  prev: "M6 5h2v14H6zM19 5v14L9 12z",
  next: "M16 5h2v14h-2zM5 5v14l10-7z",
  from: "M3 6v12l8-6zM12 6v12l8-6z",
  up: "M12 5l-6 6h4v7h4v-7h4z",
  down: "M12 19l6-6h-4V6h-4v7H6z",
  x: "M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4 17.6 5 12 10.6z",
  plus: "M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z",
  hear: "M4 9v6h4l5 4V5L8 9zM16 8.5a5 5 0 0 1 0 7l-1.4-1.4a3 3 0 0 0 0-4.2z",
  eye: "M12 5C6.5 5 3 12 3 12s3.5 7 9 7 9-7 9-7-3.5-7-9-7zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8z",
  sidebar: "M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm1 2v12h4V6zm6 0v12h8V6z",
  download: "M11 5h2v7h4l-5 5-5-5h4zM5 18h14v2H5z",
};

/** Selects a 1-based line in a textarea and scrolls it into view. */
export function jumpToLine(area: HTMLTextAreaElement | null, line: number): void {
  if (!area) return;
  const rows = area.value.split("\n");
  const start = rows.slice(0, line - 1).reduce((offset, row) => offset + row.length + 1, 0);
  area.focus();
  area.setSelectionRange(start, start + (rows[line - 1]?.length ?? 0));
  const height = parseFloat(getComputedStyle(area).lineHeight) || 20;
  area.scrollTop = Math.max(0, (line - 3) * height);
}

/**
 * Problems found in a script text, by line. Errors block the import or the
 * change; notes are worth a look but do not. Clicking a row jumps to its line.
 */
export function Diagnostics({
  errors,
  warnings,
  onJump,
  limit = 50,
}: {
  errors: { line: number; message: string }[];
  warnings: { line: number; message: string }[];
  onJump?: (line: number) => void;
  limit?: number;
}) {
  if (!errors.length && !warnings.length) return null;
  const rows = [
    ...errors.map((d) => ({ ...d, error: true })),
    ...warnings.map((d) => ({ ...d, error: false })),
  ];
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

  return (
    <div className="rounded-lg border border-rule bg-surface text-sm" role={errors.length ? "alert" : "status"}>
      <p className={`border-b border-rule px-3 py-2 font-semibold ${errors.length ? "text-danger" : ""}`}>
        {errors.length ? plural(errors.length, "problem to fix", "problems to fix") : "No problems"}
        {warnings.length ? <span className="font-normal text-muted">, {plural(warnings.length, "note", "notes")}</span> : null}
      </p>
      <ul className="max-h-48 overflow-auto py-1">
        {rows.slice(0, limit).map((d, index) => (
          <li key={index}>
            <button
              type="button"
              onClick={() => onJump?.(d.line)}
              className="flex w-full gap-3 px-3 py-1 text-left hover:bg-soft"
            >
              <span className={`w-16 shrink-0 tabular-nums ${d.error ? "text-danger" : "text-muted"}`}>
                Line {d.line}
              </span>
              <span className={d.error ? "" : "text-muted"}>{d.message}</span>
            </button>
          </li>
        ))}
      </ul>
      {rows.length > limit && <p className="px-3 pb-2 text-muted">and {rows.length - limit} more</p>}
    </div>
  );
}

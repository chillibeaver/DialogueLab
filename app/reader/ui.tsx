/** Small presentational pieces shared by the reader's panels. */

import type { ReactNode } from "react";

/** A text field without a width, for layouts that size it themselves. */
export const FIELD =
  "min-w-0 rounded-md border border-rule bg-surface px-2.5 py-1.5 text-sm " +
  "placeholder:text-muted focus:border-accent focus:outline-none";

export const INPUT = `w-full ${FIELD}`;

const BUTTON =
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border px-3 py-1.5 text-sm " +
  "font-medium leading-tight transition-colors disabled:cursor-not-allowed disabled:opacity-45";

/** The everyday button: the surface colour, with ink text at full contrast. */
export const BTN = `${BUTTON} border-rule bg-surface text-ink hover:border-muted/50 hover:bg-soft`;

/** One per view, for the action the view is for. */
export const BTN_PRIMARY = `${BUTTON} border-transparent bg-accent font-semibold text-accent-ink hover:brightness-110`;

/** For actions that delete something. */
export const BTN_DANGER = `${BUTTON} border-rule bg-surface text-danger hover:border-danger/50 hover:bg-danger/10`;

/**
 * A toggle (aria-pressed). Each variant is a complete class list: appending a
 * second colour class to BTN would not override it, because which of two
 * same-property utilities wins depends on Tailwind's output order.
 */
export const toggleButton = (on: boolean) =>
  on ? `${BUTTON} border-accent/60 bg-accent/15 text-accent hover:bg-accent/20` : BTN;

/**
 * Segmented controls: a recessed track holding the options; the chosen one
 * is a raised card with ink text, so it reads clearly in both themes.
 */
export const SEGMENTS = "rounded-lg border border-rule bg-bg p-0.5";
export const SEGMENT =
  "relative rounded-md px-2.5 text-sm transition-colors focus-visible:z-10";
export const SEGMENT_ON = "bg-surface font-semibold text-ink shadow-sm ring-1 ring-rule";
export const SEGMENT_OFF = "text-muted hover:text-ink";

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
    <div role="tablist" aria-label={label} className={`mb-4 ${SEGMENTS} ${stretch ? "flex" : "inline-flex"}`}>
      {tabs.map(([id, text], index) => {
        const selected = active === id;
        // A divider sits between two unselected tabs; the raised card needs none.
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
            className={`${SEGMENT} min-w-0 truncate py-1.5 ${stretch ? "flex-auto" : ""} ${
              selected ? SEGMENT_ON : SEGMENT_OFF
            } ${
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
  large = false,
  strong = false,
}: {
  label: string;
  onClick: () => void;
  path: string;
  disabled?: boolean;
  size?: number;
  /** The transport's larger hit area. */
  large?: boolean;
  /** Ink instead of muted, for primary controls. */
  strong?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={`grid shrink-0 place-items-center rounded-lg transition-colors hover:bg-soft hover:text-ink disabled:cursor-not-allowed disabled:opacity-30 ${
        large ? "h-10 w-10" : "h-8 w-8"
      } ${strong ? "text-ink" : "text-muted"}`}
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
  // A matching pair from Material Icons (visibility, visibility_off; Apache 2.0).
  eye: "M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z",
  eyeOff:
    "M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z",
  sidebar: "M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm1 2v12h4V6zm6 0v12h8V6z",
  download: "M11 5h2v7h4l-5 5-5-5h4zM5 18h14v2H5z",
  // GitHub's mark (Octicons mark-github-24).
  github:
    "M12 1C5.923 1 1 5.923 1 12c0 4.867 3.149 8.979 7.521 10.436.55.096.756-.233.756-.522 0-.262-.013-1.128-.013-2.049-2.764.509-3.479-.674-3.699-1.292-.124-.317-.66-1.293-1.127-1.554-.385-.207-.936-.715-.014-.729.866-.014 1.485.797 1.691 1.128.99 1.663 2.571 1.196 3.204.907.096-.715.385-1.196.701-1.471-2.448-.275-5.005-1.224-5.005-5.432 0-1.196.426-2.186 1.128-2.956-.111-.275-.496-1.402.11-2.915 0 0 .921-.288 3.024 1.128a10.193 10.193 0 0 1 2.75-.371c.936 0 1.871.123 2.75.371 2.104-1.43 3.025-1.128 3.025-1.128.605 1.513.221 2.64.111 2.915.701.77 1.127 1.747 1.127 2.956 0 4.222-2.571 5.157-5.019 5.432.399.344.743 1.004.743 2.035 0 1.471-.014 2.654-.014 3.025 0 .289.206.632.756.522C19.851 20.979 23 16.854 23 12c0-6.077-4.922-11-11-11Z",
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

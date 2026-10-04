import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { buildCatalog } from "../../server/catalog-view";
import { readConfig } from "../../server/config";
import { envContext } from "../context";
import {
  clone,
  defaultPrefs,
  effectiveRate,
  loadStore,
  makeScript,
  restorePrefs,
  saveStore,
  speakerOf,
  uid,
  type Prefs,
  type Script,
  type Speaker,
  type Store,
} from "../reader/model";
import { CastPanel, DictionaryPanel, LibraryPanel, PlaybackPanel, type Reader } from "../reader/panels";
import { IDLE_STATE, Player, type PlayerState } from "../reader/player";
import { BulkText, ScriptLines } from "../reader/script-panel";
import { serializePack } from "../reader/format";
import { ImportDialog } from "../reader/import-dialog";
import { estimateMs, formatDuration, safeFileName } from "../reader/text";
import { Icon, IconButton, ICONS, Tabs, toggleButton } from "../reader/ui";
import type { Route } from "./+types/home";

const TITLE = "TTS Studio — read dialogue aloud with Google Cloud voices";
const DESCRIPTION =
  "Write a dialogue, give each character a Google Cloud voice, and play it back line by line. Built for language " +
  "practice: repeat a line, leave a gap to shadow it, blur the text for dictation, and export the scene as one MP3. " +
  "French first, 50+ languages, no sign-up.";

export function meta({ loaderData }: Route.MetaArgs) {
  const url = loaderData?.siteUrl;
  return [
    { title: TITLE },
    { name: "description", content: DESCRIPTION },
    { property: "og:title", content: TITLE },
    { property: "og:description", content: DESCRIPTION },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary_large_image" },
    ...(url ? [{ property: "og:url", content: url }, { tagName: "link", rel: "canonical", href: url }] : []),
  ];
}

export function loader({ context, request }: Route.LoaderArgs) {
  const env = context.get(envContext);
  const url = new URL(request.url);
  return {
    catalog: buildCatalog(readConfig(env)),
    turnstileSiteKey: env.TURNSTILE_SITE_KEY ?? "",
    siteUrl: `${url.origin}${url.pathname}`,
  };
}

/**
 * What the page shows before the browser's own library loads. Its ids are
 * fixed rather than random so the server and the first client render agree,
 * and its content is a real scene so the page is not an empty shell.
 */
function seedStore(defaultLanguage: string): Store {
  const script = makeScript(
    "Au café",
    defaultLanguage,
    "chirp3-hd",
    "gemini-2.5-flash-tts",
    [
      ["Narrateur", "Un samedi matin, dans un petit café près de la gare."],
      ["Serveur", "Bonjour madame, qu'est-ce que je vous sers ?"],
      ["Claire", "Bonjour ! Un café crème et un croissant, s'il vous plaît."],
      ["Serveur", "Sur place ou à emporter ?"],
      ["Claire", "Sur place. Est-ce que vous avez le wifi ?"],
      ["Serveur", "Oui, bien sûr. Le code est sur le ticket. [1] Et voilà, ça fait quatre euros cinquante."],
      ["Claire", "Je peux payer par carte ?"],
      ["Serveur", "Pas de problème. Bonne journée !"],
      ["Claire", "Merci, à vous aussi !"],
    ],
    // Narrateur, Serveur, Claire: two men and a woman.
    ["Charon", "Achird", "Kore"],
  );

  const idOf = new Map(script.speakers.map((sp, index) => [sp.id, `sample-sp-${index}`]));
  script.id = "sample-cafe";
  script.speakers.forEach((sp) => (sp.id = idOf.get(sp.id)!));
  script.lines.forEach((line, index) => {
    line.id = `sample-line-${index}`;
    line.sp = idOf.get(line.sp)!;
  });
  script.updated = 0;

  return { scripts: { [script.id]: script }, prefs: { ...defaultPrefs(), currentId: script.id } };
}

type SideTab = "cast" | "play" | "dict" | "lib";
type MainTab = "lines" | "bulk";

const SIDE_TABS: [SideTab, string][] = [
  ["cast", "Cast"],
  ["play", "Playback"],
  ["dict", "Dictionary"],
  ["lib", "Library"],
];

const MAIN_TABS: [MainTab, string][] = [
  ["lines", "Script"],
  ["bulk", "Plain text"],
];

export default function Home({ loaderData }: Route.ComponentProps) {
  const { catalog, turnstileSiteKey } = loaderData;
  const voiceNames = useMemo(() => catalog.voices.map((v) => v.name), [catalog.voices]);

  const [store, setStore] = useState<Store>(() => seedStore(catalog.defaults.language));
  const [hydrated, setHydrated] = useState(false);
  const [sideTab, setSideTab] = useState<SideTab>("cast");
  const [mainTab, setMainTab] = useState<MainTab>("lines");
  const [sideOpen, setSideOpen] = useState(false);
  const [toastMsg, setToastMsg] = useState<{ text: string; undo?: () => void } | null>(null);
  const [busy, setBusy] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  // The saved library replaces the seed only after hydration, so the first
  // client render still matches the HTML the server sent.
  useEffect(() => {
    const saved = loadStore();
    if (saved?.scripts && Object.keys(saved.scripts).length) {
      setStore({ scripts: saved.scripts, prefs: restorePrefs(saved.prefs) });
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (hydrated) saveStore(store);
  }, [store, hydrated]);

  // The sticky header and the fixed transport bar change height with the
  // viewport (the bar wraps on phones); the sidebar and the page's bottom
  // padding are sized from these, so content never hides behind either bar.
  const headerRef = useRef<HTMLElement | null>(null);
  const footerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const root = document.documentElement;
    const measure = () => {
      if (headerRef.current) root.style.setProperty("--toph", `${headerRef.current.offsetHeight}px`);
      if (footerRef.current) root.style.setProperty("--tbh", `${footerRef.current.offsetHeight}px`);
    };
    const observer = new ResizeObserver(measure);
    if (headerRef.current) observer.observe(headerRef.current);
    if (footerRef.current) observer.observe(footerRef.current);
    measure();
    return () => observer.disconnect();
  }, []);

  const prefs = store.prefs;
  const script = store.scripts[prefs.currentId ?? ""] ?? Object.values(store.scripts)[0];

  useEffect(() => {
    const root = document.documentElement;
    if (prefs.theme === "auto") root.removeAttribute("data-theme");
    else root.dataset.theme = prefs.theme;
  }, [prefs.theme]);

  const editStore = useCallback((fn: (draft: Store) => void) => {
    setStore((current) => {
      const draft = clone(current);
      fn(draft);
      return draft;
    });
  }, []);

  const editPrefs = useCallback((fn: (draft: Prefs) => void) => editStore((draft) => fn(draft.prefs)), [editStore]);

  const editScript = useCallback(
    (fn: (draft: Script) => Script | void) =>
      editStore((draft) => {
        const id = draft.prefs.currentId ?? Object.keys(draft.scripts)[0];
        const result = fn(draft.scripts[id]);
        if (result) draft.scripts[id] = result;
        draft.scripts[id].updated = Date.now();
      }),
    [editStore],
  );

  const toast = useCallback((text: string, undo?: () => void) => setToastMsg({ text, undo }), []);

  useEffect(() => {
    if (!toastMsg) return;
    const timer = setTimeout(() => setToastMsg(null), toastMsg.undo ? 7000 : 3500);
    return () => clearTimeout(timer);
  }, [toastMsg]);

  /* ---------- player ---------- */

  const turnstileToken = useCallback(
    async () => (turnstileSiteKey ? requestTurnstileToken(turnstileSiteKey) : ""),
    [turnstileSiteKey],
  );

  const playerRef = useRef<Player | null>(null);
  playerRef.current ??= new Player({ script, prefs, limits: catalog.limits.batch, turnstileToken });
  const player = playerRef.current;
  player.update({ script, prefs, limits: catalog.limits.batch, turnstileToken });

  useEffect(() => () => player.dispose(), [player]);

  const state = useSyncExternalStore<PlayerState>(
    useCallback((fn) => player.subscribe(fn), [player]),
    () => player.getState(),
    () => IDLE_STATE,
  );

  /* ---------- library ---------- */

  function download(name: string, blob: Blob) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  function openScript(id: string) {
    player.stop();
    editStore((draft) => void (draft.prefs.currentId = id));
    setSideOpen(false);
  }

  function newScript() {
    const created = makeScript("Untitled script", script.lang, script.engine, script.model, [], voiceNames);
    player.stop();
    editStore((draft) => {
      draft.scripts[created.id] = created;
      draft.prefs.currentId = created.id;
    });
  }

  function duplicateScript() {
    const copy = clone(script);
    copy.id = uid();
    copy.title = `${copy.title} (copy)`;
    copy.updated = Date.now();
    editStore((draft) => {
      draft.scripts[copy.id] = copy;
      draft.prefs.currentId = copy.id;
    });
    toast("Duplicated");
  }

  function deleteScript() {
    const snapshot = clone(script);
    player.stop();
    editStore((draft) => {
      delete draft.scripts[snapshot.id];
      const remaining = Object.keys(draft.scripts);
      if (remaining.length) {
        draft.prefs.currentId = remaining[0];
      } else {
        const fresh = makeScript("Untitled script", snapshot.lang, snapshot.engine, snapshot.model, [], voiceNames);
        draft.scripts[fresh.id] = fresh;
        draft.prefs.currentId = fresh.id;
      }
    });
    toast(`Deleted “${snapshot.title}”`, () =>
      editStore((draft) => {
        draft.scripts[snapshot.id] = snapshot;
        draft.prefs.currentId = snapshot.id;
      }),
    );
  }

  /** Adds imported scripts; one whose id is already in the library replaces it. Undoable. */
  function importScripts(scripts: Script[]) {
    if (!scripts.length) return;
    const before = clone(store);
    const replaced = scripts.filter((s) => store.scripts[s.id]).length;
    player.stop();
    editStore((draft) => {
      for (const s of scripts) draft.scripts[s.id] = s;
      draft.prefs.currentId = scripts[0].id;
    });
    setImportOpen(false);
    const added = scripts.length - replaced;
    const parts = [added && `added ${added}`, replaced && `updated ${replaced}`].filter(Boolean).join(", ");
    toast(`Import done: ${parts}`, () => setStore(before));
  }

  function exportText(name: string, scripts: Script[]) {
    const empty = scripts.filter((s) => !s.lines.some((l) => l.text.trim())).length;
    download(name, new Blob([serializePack(scripts, catalog)], { type: "text/plain;charset=utf-8" }));
    if (empty) toast(`Left out ${empty} empty ${empty === 1 ? "script" : "scripts"}`);
  }

  async function exportAudio() {
    setBusy(true);
    try {
      download(`${safeFileName(script.title)}.mp3`, await player.exportAudio());
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : "Could not prepare the audio");
    } finally {
      setBusy(false);
    }
  }

  function previewSpeaker(speaker: Speaker) {
    const index = script.lines.findIndex((line) => line.sp === speaker.id);
    player.unlock();
    void player.play(index >= 0 ? index : 0, true);
  }

  const reader: Reader = {
    catalog,
    store,
    script,
    prefs,
    editScript,
    editPrefs,
    editStore,
    openScript,
    toast,
    previewSpeaker,
    previewText: (text: string) => void player.say(text, script.speakers[0]),
    exportAudio,
    busy,
  };

  /* ---------- keyboard ---------- */

  const toggleSidebar = useCallback(() => {
    if (window.matchMedia("(max-width: 767px)").matches) setSideOpen((open) => !open);
    else editPrefs((draft) => void (draft.sideCollapsed = !draft.sideCollapsed));
  }, [editPrefs]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable], [role=dialog]")) return;

      if (event.key === " ") {
        if (target?.tagName === "BUTTON") return;
        event.preventDefault();
        player.toggle();
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        player.skip(1);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        player.skip(-1);
      } else if (event.key === "Escape") {
        player.stop();
      } else if (event.key === "[") {
        event.preventDefault();
        toggleSidebar();
      } else if (event.key === "s" || event.key === "S") {
        editPrefs((draft) => void (draft.slow = !draft.slow));
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [player, editPrefs, toggleSidebar]);

  /* ---------- derived ---------- */

  const total = script.lines.reduce((ms, line) => {
    const speaker = speakerOf(script, line.sp);
    if (speaker.mode === "skip") return ms;
    const one = estimateMs(line.text, effectiveRate(speaker, prefs));
    return ms + one * prefs.repeat * (1 + prefs.shadow) + prefs.gap * 1000;
  }, 0);

  const currentSpeaker = state.line >= 0 ? speakerOf(script, script.lines[state.line]?.sp ?? "") : null;
  const collapsed = prefs.sideCollapsed;

  return (
    <>
      <header ref={headerRef} className="sticky top-0 z-20 border-b border-rule bg-surface">
        <div className="mx-auto flex max-w-[1280px] items-center gap-3 px-5 py-2.5">
          <IconButton
            label={sideOpen || !collapsed ? "Hide sidebar" : "Show sidebar"}
            path={ICONS.sidebar}
            onClick={toggleSidebar}
            size={22}
            strong
          />
          <input
            value={script.title}
            maxLength={80}
            aria-label="Script title"
            onChange={(event) => editScript((draft) => void (draft.title = event.target.value))}
            className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 py-1.5 text-xl font-bold hover:border-rule focus:border-accent focus:bg-bg focus:outline-none"
          />
          <span className="hidden whitespace-nowrap text-sm text-muted sm:block">
            {script.lines.length
              ? `${script.lines.length} ${script.lines.length === 1 ? "line" : "lines"}, about ${formatDuration(total)}`
              : "No lines yet"}
          </span>
        </div>
      </header>

      <div
        className={`mx-auto grid max-w-[1280px] ${collapsed ? "" : "md:grid-cols-[352px_minmax(0,1fr)]"}`}
        style={{ paddingBottom: "calc(var(--tbh) + 24px)" }}
      >
        <aside
          aria-label="Cast and settings"
          className={`fixed bottom-0 left-0 top-[var(--toph)] z-50 w-[min(390px,92vw)] overflow-auto border-r border-rule bg-surface px-4 pb-6 pt-4 transition-transform md:sticky md:top-[var(--toph)] md:z-0 md:max-h-[calc(100vh-var(--toph)-var(--tbh))] md:w-auto md:translate-x-0 md:self-start md:px-[18px] ${
            sideOpen ? "translate-x-0" : "-translate-x-[105%]"
          } ${collapsed ? "md:hidden" : ""}`}
        >
          <Tabs tabs={SIDE_TABS} active={sideTab} onSelect={setSideTab} stretch label="Settings" />

          {sideTab === "cast" && <CastPanel reader={reader} />}
          {sideTab === "play" && <PlaybackPanel reader={reader} />}
          {sideTab === "dict" && <DictionaryPanel reader={reader} />}
          {sideTab === "lib" && (
            <LibraryPanel
              reader={reader}
              onNew={newScript}
              onDuplicate={duplicateScript}
              onDelete={deleteScript}
              onImport={() => setImportOpen(true)}
              onExportScript={() => exportText(`${safeFileName(script.title)}.txt`, [script])}
              onExportLibrary={() =>
                exportText(
                  "tts-studio-library.txt",
                  Object.values(store.scripts).sort((a, b) => (b.updated || 0) - (a.updated || 0)),
                )
              }
              onExportJson={() =>
                download(
                  `${safeFileName(script.title)}.json`,
                  new Blob([JSON.stringify(script, null, 2)], { type: "application/json" }),
                )
              }
            />
          )}
        </aside>

        {sideOpen && (
          <button
            type="button"
            aria-label="Close sidebar"
            onClick={() => setSideOpen(false)}
            className="fixed inset-x-0 bottom-0 top-[var(--toph)] z-[45] bg-black/40 md:hidden"
          />
        )}

        <main className={`min-w-0 px-4 py-5 sm:px-8 ${collapsed ? "mx-auto w-full max-w-[1000px]" : ""}`}>
          <h1 className="sr-only">{TITLE}</h1>

          {state.error && (
            <p
              role="alert"
              className="mb-4 rounded-lg border border-rule border-l-4 border-l-danger bg-surface px-3.5 py-2.5 text-sm"
            >
              {state.error}
            </p>
          )}

          <Tabs tabs={MAIN_TABS} active={mainTab} onSelect={setMainTab} label="Script view" />

          {mainTab === "lines" ? (
            <ScriptLines
              reader={reader}
              state={state}
              onPlayLine={(index) => {
                player.unlock();
                void player.play(index, true);
              }}
              onPlayFrom={(index) => {
                player.unlock();
                void player.play(index, false);
              }}
            />
          ) : (
            <BulkText key={script.id} reader={reader} onApplied={() => setMainTab("lines")} />
          )}

          <p className="mt-10 border-t border-rule pt-5 text-sm leading-relaxed text-muted">
            Every line is synthesized by Google Cloud Text-to-Speech and then cached, so replaying a scene costs
            nothing after the first pass, and editing one line only re-synthesizes that line. Credentials stay on the
            server and never reach the browser.
          </p>
        </main>
      </div>

      <footer ref={footerRef} className="fixed inset-x-0 bottom-0 z-30 border-t border-rule bg-surface">
        <div
          className="relative h-1.5 cursor-pointer bg-soft"
          onClick={(event) => {
            if (!script.lines.length) return;
            const rect = event.currentTarget.getBoundingClientRect();
            const ratio = (event.clientX - rect.left) / rect.width;
            player.unlock();
            player.seek(Math.min(script.lines.length - 1, Math.max(0, Math.floor(ratio * script.lines.length))));
          }}
        >
          <i
            className="absolute inset-y-0 left-0 bg-accent transition-[width]"
            style={{
              width: script.lines.length
                ? `${((state.line + (state.status === "idle" ? 0 : 1)) / script.lines.length) * 100}%`
                : 0,
            }}
          />
        </div>

        {/* Phones: status and settings on top, transport centred below. Wider: one row. */}
        <div className="mx-auto grid max-w-[1280px] grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 px-3 py-2 sm:grid-cols-[1fr_auto_1fr] sm:gap-3 sm:px-5 sm:py-2.5">
          <div className="col-start-1 row-start-1 flex min-w-0 items-center gap-2.5 text-sm">
            <span
              className="h-3 w-3 shrink-0 rounded-full"
              style={{ backgroundColor: currentSpeaker?.color ?? "var(--color-rule)" }}
            />
            <span className="truncate">
              {state.status === "loading"
                ? `Synthesizing… ${state.pending} to go`
                : currentSpeaker
                  ? `${state.status === "paused" ? "Paused. " : ""}${currentSpeaker.name}, line ${state.line + 1} of ${script.lines.length}`
                  : script.lines.length
                    ? `${script.lines.length} lines. Press Space to start`
                    : "The script is empty"}
            </span>
          </div>

          <div className="col-span-2 row-start-2 flex items-center justify-center gap-1 sm:col-span-1 sm:col-start-2 sm:row-start-1">
            <IconButton
              label="Previous line"
              path={ICONS.prev}
              onClick={() => player.skip(-1)}
              size={22}
              large
              strong
            />
            <button
              type="button"
              onClick={() => player.toggle()}
              disabled={state.status === "loading"}
              aria-label={state.status === "playing" ? "Pause" : "Play"}
              className="grid h-12 w-12 place-items-center rounded-full bg-accent text-accent-ink disabled:opacity-50"
            >
              <Icon path={state.status === "playing" ? ICONS.pause : ICONS.play} size={24} />
            </button>
            <IconButton
              label="Stop"
              path={ICONS.stop}
              onClick={() => player.stop()}
              size={22}
              large
              strong
            />
            <IconButton
              label="Next line"
              path={ICONS.next}
              onClick={() => player.skip(1)}
              size={22}
              large
              strong
            />
          </div>

          <div className="col-start-2 row-start-1 flex items-center justify-end gap-1.5 sm:col-start-3">
            <select
              value={String(prefs.speed)}
              aria-label="Overall speed"
              onChange={(event) => editPrefs((draft) => void (draft.speed = Number(event.target.value)))}
              className="rounded-md border border-rule bg-surface px-1.5 py-1.5 text-sm"
            >
              {[0.5, 0.6, 0.75, 0.85, 1, 1.15, 1.3, 1.5, 1.75, 2].map((value) => (
                <option key={value} value={String(value)}>
                  ×{value}
                </option>
              ))}
            </select>
            <button
              type="button"
              aria-pressed={prefs.slow}
              onClick={() => editPrefs((draft) => void (draft.slow = !draft.slow))}
              className={toggleButton(prefs.slow)}
            >
              Slow
            </button>
            <button
              type="button"
              aria-pressed={prefs.loop}
              onClick={() => editPrefs((draft) => void (draft.loop = !draft.loop))}
              className={toggleButton(prefs.loop)}
            >
              Loop
            </button>
          </div>
        </div>
      </footer>

      {importOpen && (
        <ImportDialog
          catalog={catalog}
          existing={store.scripts}
          onImport={importScripts}
          onClose={() => setImportOpen(false)}
        />
      )}

      {toastMsg && (
        <div
          role="status"
          className="fixed left-1/2 z-[60] flex max-w-[min(92vw,520px)] -translate-x-1/2 items-center gap-3.5 rounded-lg bg-ink px-3.5 py-2.5 text-sm text-surface"
          style={{ bottom: "calc(var(--tbh) + 12px)" }}
        >
          <span>{toastMsg.text}</span>
          {toastMsg.undo && (
            <button
              type="button"
              className="font-semibold underline"
              onClick={() => {
                toastMsg.undo?.();
                setToastMsg(null);
              }}
            >
              Undo
            </button>
          )}
        </div>
      )}
    </>
  );
}

/* ---------- Turnstile ---------- */

interface Turnstile {
  render: (
    element: HTMLElement,
    options: { sitekey: string; callback: (token: string) => void; "error-callback": () => void },
  ) => string | undefined;
  remove?: (widget: string) => void;
}

/**
 * Tokens are single use, so a fresh widget is rendered for every request, and
 * removed once it has answered, or the page would collect one per request.
 */
async function requestTurnstileToken(siteKey: string): Promise<string> {
  const scope = window as unknown as { turnstile?: Turnstile };
  if (!scope.turnstile) {
    const loaded = await new Promise<boolean>((resolve) => {
      const script = document.createElement("script");
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.onload = () => resolve(true);
      script.onerror = () => resolve(false);
      document.head.appendChild(script);
    });
    if (!loaded || !scope.turnstile) return "";
  }
  const turnstile = scope.turnstile;
  const container = document.createElement("div");
  container.style.display = "none";
  document.body.appendChild(container);
  let widget: string | undefined;
  const token = await new Promise<string>((resolve) => {
    widget = turnstile.render(container, {
      sitekey: siteKey,
      callback: resolve,
      "error-callback": () => resolve(""),
    });
  });
  if (widget) turnstile.remove?.(widget);
  container.remove();
  return token;
}

import { useMemo, useRef, useState } from "react";

import { buildCatalog, type Catalog } from "../../server/catalog-view";
import { readConfig } from "../../server/config";
import { envContext } from "../context";
import type { Route } from "./+types/home";

const TITLE = "TTS Studio — French text to speech with Google Cloud voices";
const DESCRIPTION =
  "Turn French text into natural speech with Google Cloud Chirp 3: HD and Gemini-TTS voices. " +
  "Choose a voice, steer the delivery with a plain-language style prompt, or write a two-speaker " +
  "dialogue. No sign-up, 30 voices, 50+ languages.";

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

type Engine = "chirp3-hd" | "gemini";
type Mode = "single" | "dialogue";

interface Turn {
  speaker: string;
  text: string;
}

interface Speaker {
  alias: string;
  voice: string;
}

interface Result {
  url: string;
  format: string;
  characters: string;
  chunks: string;
  cache: string;
}

const SAMPLE = "Bonjour ! Bienvenue sur TTS Studio. Choisissez une voix, puis écoutez le résultat.";

const SAMPLE_TURNS: Turn[] = [
  { speaker: "Marie", text: "Bonjour Paul ! Ça fait tellement longtemps." },
  { speaker: "Paul", text: "Marie ! Quelle surprise. Tu as vraiment bonne mine." },
];

const STYLE_HINTS = [
  "Lis lentement, comme un conteur.",
  "Ton enthousiaste et chaleureux.",
  "Voix de documentaire, calme et posée.",
];

/** Google markup tags; they are spoken as actions, not read aloud. */
const MARKUP_TAGS = ["[sigh]", "[laughing]", "[whispering]", "[sarcasm]", "[short pause]", "[long pause]"];

const INPUT =
  "w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500 focus:outline-none";

export default function Home({ loaderData }: Route.ComponentProps) {
  const { catalog, turnstileSiteKey } = loaderData;
  const defaultEngine = catalog.defaults.engine as Engine;

  const [engine, setEngine] = useState<Engine>(defaultEngine);
  const [mode, setMode] = useState<Mode>("single");
  const [language, setLanguage] = useState(catalog.defaults.language);
  const [voice, setVoice] = useState(catalog.engines[defaultEngine].defaultVoice);
  const [model, setModel] = useState<string>(catalog.engines.gemini.defaultModel);
  const [format, setFormat] = useState<string>(catalog.defaults.format);
  const [speakingRate, setSpeakingRate] = useState(1);
  const [prompt, setPrompt] = useState("");
  const [text, setText] = useState(SAMPLE);
  const [speakers, setSpeakers] = useState<Speaker[]>([
    { alias: "Marie", voice: "Kore" },
    { alias: "Paul", voice: "Charon" },
  ]);
  const [turns, setTurns] = useState<Turn[]>(SAMPLE_TURNS);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const lastUrl = useRef("");

  const isDialogue = engine === "gemini" && mode === "dialogue";
  const engineInfo = catalog.engines[engine];
  const languages = engineInfo.languages;
  const characters = isDialogue
    ? turns.reduce((total, turn) => total + [...turn.text].length, 0)
    : [...text].length;
  const overLimit = characters > catalog.limits.maxChars;

  // Switching engines can orphan the current language, so fall back cleanly.
  const languageOk = useMemo(() => languages.some((item) => item.code === language), [languages, language]);

  function switchEngine(next: Engine) {
    setEngine(next);
    setVoice(catalog.engines[next].defaultVoice);
    if (!catalog.engines[next].languages.some((item) => item.code === language)) {
      setLanguage(catalog.defaults.language);
    }
    if (next === "chirp3-hd") setMode("single");
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const body: Record<string, unknown> = { engine, language, format };
      if (isDialogue) {
        body.speakers = speakers;
        body.turns = turns;
      } else {
        body.text = text;
        body.voice = voice;
      }
      if (engine === "gemini") {
        body.model = model;
        if (prompt.trim()) body.prompt = prompt.trim();
      } else if (speakingRate !== 1) {
        body.speakingRate = speakingRate;
      }

      const headers: Record<string, string> = { "content-type": "application/json" };
      if (turnstileSiteKey) {
        const token = await turnstileToken(turnstileSiteKey);
        if (token) headers["x-turnstile-token"] = token;
      }

      const response = await fetch("/api/tts", { method: "POST", headers, body: JSON.stringify(body) });
      if (!response.ok) {
        const problem = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(problem?.error?.message ?? `Request failed with status ${response.status}.`);
      }

      const blob = await response.blob();
      if (lastUrl.current) URL.revokeObjectURL(lastUrl.current);
      lastUrl.current = URL.createObjectURL(blob);
      setResult({
        url: lastUrl.current,
        format,
        characters: response.headers.get("x-tts-characters") ?? "?",
        chunks: response.headers.get("x-tts-chunks") ?? "?",
        cache: response.headers.get("x-cache") ?? "?",
      });
    } catch (caught) {
      setResult(null);
      setError(caught instanceof Error ? caught.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-10 sm:py-14">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-100 sm:text-3xl">TTS Studio</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-400">
          French-first text to speech, powered by Google Cloud{" "}
          <strong className="font-medium text-zinc-300">Chirp 3: HD</strong> and{" "}
          <strong className="font-medium text-zinc-300">Gemini-TTS</strong>. Pick a voice, steer the delivery with a
          plain-language style prompt, or write a two-speaker dialogue. No sign-up.
        </p>
      </header>

      <form onSubmit={submit} className="space-y-6">
        <Field label="Engine">
          <div className="flex flex-wrap gap-2">
            {(Object.keys(catalog.engines) as Engine[]).map((id) => (
              <Choice key={id} active={engine === id} onClick={() => switchEngine(id)}>
                {catalog.engines[id].name}
              </Choice>
            ))}
          </div>
          <Hint>
            {engine === "chirp3-hd"
              ? "30 HD voices with an adjustable speaking rate. Best for straight narration."
              : "Steerable delivery through a style prompt, plus two-speaker dialogue."}
          </Hint>
        </Field>

        {engine === "gemini" && (
          <Field label="Mode">
            <div className="flex flex-wrap gap-2">
              <Choice active={mode === "single"} onClick={() => setMode("single")}>
                Single voice
              </Choice>
              <Choice active={mode === "dialogue"} onClick={() => setMode("dialogue")}>
                Dialogue (2 speakers)
              </Choice>
            </div>
          </Field>
        )}

        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Language">
            <Select value={languageOk ? language : catalog.defaults.language} onChange={setLanguage}>
              {languages.map((item) => (
                <option key={item.code} value={item.code}>
                  {item.code}
                  {item.availability === "preview" ? " (preview)" : ""}
                </option>
              ))}
            </Select>
          </Field>

          {!isDialogue && (
            <Field label="Voice">
              <Select value={voice} onChange={setVoice}>
                {catalog.voices.map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.name} — {item.gender}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          {engine === "gemini" && (
            <Field label="Model">
              <Select value={model} onChange={setModel}>
                {catalog.engines.gemini.models.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.id}
                    {item.availability === "preview" ? " (preview)" : ""}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          <Field label="Format">
            <Select value={format} onChange={setFormat}>
              {catalog.formats.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </Select>
          </Field>

          {engine === "chirp3-hd" && (
            <Field label={`Speaking rate — ${speakingRate.toFixed(2)}x`}>
              <input
                type="range"
                min={catalog.engines["chirp3-hd"].speakingRate.min}
                max={catalog.engines["chirp3-hd"].speakingRate.max}
                step={0.05}
                value={speakingRate}
                onChange={(event) => setSpeakingRate(Number(event.target.value))}
                className="w-full accent-emerald-400"
              />
            </Field>
          )}
        </div>

        {engine === "gemini" && (
          <Field label="Style prompt" optional>
            <input
              type="text"
              value={prompt}
              maxLength={catalog.limits.maxPromptChars}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Lis doucement, comme un conteur."
              className={INPUT}
            />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {STYLE_HINTS.map((hint) => (
                <Tag key={hint} onClick={() => setPrompt(hint)}>
                  {hint}
                </Tag>
              ))}
            </div>
          </Field>
        )}

        {isDialogue ? (
          <DialogueEditor
            catalog={catalog}
            speakers={speakers}
            setSpeakers={setSpeakers}
            turns={turns}
            setTurns={setTurns}
          />
        ) : (
          <Field label="Text">
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              rows={8}
              className={`${INPUT} resize-y leading-relaxed`}
              placeholder="Write or paste your text here…"
            />
            {engine === "gemini" && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {MARKUP_TAGS.map((tag) => (
                  <Tag key={tag} onClick={() => setText((current) => `${current}${current ? " " : ""}${tag}`)}>
                    {tag}
                  </Tag>
                ))}
              </div>
            )}
          </Field>
        )}

        <div className="flex flex-wrap items-center gap-4">
          <button
            type="submit"
            disabled={busy || overLimit || characters === 0}
            className="rounded-md bg-emerald-500 px-5 py-2.5 text-sm font-medium text-zinc-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
          >
            {busy ? "Synthesizing…" : "Generate speech"}
          </button>
          <span className={`text-xs tabular-nums ${overLimit ? "text-red-400" : "text-zinc-500"}`}>
            {/* Explicit locale: the browser's default would differ from the server's and break hydration. */}
            {characters.toLocaleString("en-US")} / {catalog.limits.maxChars.toLocaleString("en-US")} characters
          </span>
        </div>
      </form>

      {error && (
        <p
          role="alert"
          className="mt-6 rounded-md border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-300"
        >
          {error}
        </p>
      )}

      {result && (
        <section className="mt-6 rounded-md border border-zinc-800 bg-zinc-900/60 p-4">
          <audio controls src={result.url} className="w-full" />
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-500">
            <a
              href={result.url}
              download={`speech.${result.format === "ogg_opus" ? "ogg" : result.format}`}
              className="font-medium text-emerald-400 hover:text-emerald-300"
            >
              Download
            </a>
            <span>{result.characters} characters</span>
            <span>
              {result.chunks} request{result.chunks === "1" ? "" : "s"} to Google
            </span>
            <span>{result.cache === "HIT" ? "served from cache" : "freshly synthesized"}</span>
          </div>
        </section>
      )}

      <footer className="mt-12 border-t border-zinc-900 pt-6 text-xs leading-relaxed text-zinc-600">
        <p>
          Audio is generated by Google Cloud Text-to-Speech. Identical requests are cached, so the same text and voice
          are billed only once.
        </p>
      </footer>
    </main>
  );
}

function Field({ label, optional, children }: { label: string; optional?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-zinc-500">
        {label}
        {optional && <span className="ml-1.5 normal-case tracking-normal text-zinc-600">optional</span>}
      </span>
      {children}
    </label>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="mt-2 text-xs text-zinc-500">{children}</p>;
}

function Choice({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-md border px-3 py-1.5 text-sm transition ${
        active
          ? "border-emerald-500 bg-emerald-500/10 text-emerald-300"
          : "border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
      }`}
    >
      {children}
    </button>
  );
}

function Tag({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs text-zinc-400 transition hover:border-zinc-700 hover:text-zinc-200"
    >
      {children}
    </button>
  );
}

function Select({
  value,
  onChange,
  children,
}: {
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)} className={INPUT}>
      {children}
    </select>
  );
}

function DialogueEditor({
  catalog,
  speakers,
  setSpeakers,
  turns,
  setTurns,
}: {
  catalog: Catalog;
  speakers: Speaker[];
  setSpeakers: (value: Speaker[]) => void;
  turns: Turn[];
  setTurns: (value: Turn[]) => void;
}) {
  const { maxTurns } = catalog.engines.gemini.dialogue;

  function renameSpeaker(index: number, alias: string) {
    const previous = speakers[index].alias;
    setSpeakers(speakers.map((speaker, i) => (i === index ? { ...speaker, alias } : speaker)));
    // Keep existing lines pointing at the speaker the user just renamed.
    setTurns(turns.map((turn) => (turn.speaker === previous ? { ...turn, speaker: alias } : turn)));
  }

  return (
    <div className="space-y-5">
      <Field label="Speakers">
        <div className="grid gap-3 sm:grid-cols-2">
          {speakers.map((speaker, index) => (
            <div key={index} className="flex gap-2">
              <input
                type="text"
                value={speaker.alias}
                onChange={(event) => renameSpeaker(index, event.target.value)}
                placeholder="Name"
                aria-label={`Speaker ${index + 1} name`}
                className={`${INPUT} w-1/2`}
              />
              <select
                value={speaker.voice}
                onChange={(event) =>
                  setSpeakers(speakers.map((s, i) => (i === index ? { ...s, voice: event.target.value } : s)))
                }
                aria-label={`Speaker ${index + 1} voice`}
                className={`${INPUT} w-1/2`}
              >
                {catalog.voices.map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.name} — {item.gender}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
        <Hint>Exactly two speakers, with alphanumeric names. Google rejects three or more.</Hint>
      </Field>

      <Field label="Dialogue">
        <div className="space-y-2">
          {turns.map((turn, index) => (
            <div key={index} className="flex gap-2">
              <select
                value={turn.speaker}
                onChange={(event) =>
                  setTurns(turns.map((t, i) => (i === index ? { ...t, speaker: event.target.value } : t)))
                }
                aria-label={`Line ${index + 1} speaker`}
                className={`${INPUT} w-32 shrink-0`}
              >
                {speakers.map((speaker) => (
                  <option key={speaker.alias} value={speaker.alias}>
                    {speaker.alias}
                  </option>
                ))}
              </select>
              <input
                type="text"
                value={turn.text}
                onChange={(event) =>
                  setTurns(turns.map((t, i) => (i === index ? { ...t, text: event.target.value } : t)))
                }
                placeholder="What they say…"
                aria-label={`Line ${index + 1} text`}
                className={INPUT}
              />
              <button
                type="button"
                onClick={() => setTurns(turns.filter((_, i) => i !== index))}
                disabled={turns.length === 1}
                aria-label={`Remove line ${index + 1}`}
                className="shrink-0 rounded-md border border-zinc-800 px-3 text-sm text-zinc-500 transition hover:border-zinc-700 hover:text-zinc-300 disabled:cursor-not-allowed disabled:opacity-40"
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setTurns([...turns, { speaker: speakers[turns.length % speakers.length].alias, text: "" }])}
          disabled={turns.length >= maxTurns}
          className="mt-2 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-400 transition hover:border-zinc-700 hover:text-zinc-200 disabled:opacity-40"
        >
          Add line
        </button>
      </Field>
    </div>
  );
}

interface Turnstile {
  render: (
    element: HTMLElement,
    options: { sitekey: string; callback: (token: string) => void; "error-callback": () => void },
  ) => void;
}

/**
 * Renders an invisible Turnstile widget and resolves its token. Tokens are
 * single use, so a fresh widget is rendered for every request.
 */
async function turnstileToken(siteKey: string): Promise<string> {
  const turnstile = await loadTurnstile();
  if (!turnstile) return "";
  return new Promise((resolve) => {
    const container = document.createElement("div");
    container.style.display = "none";
    document.body.appendChild(container);
    turnstile.render(container, {
      sitekey: siteKey,
      callback: resolve,
      "error-callback": () => resolve(""),
    });
  });
}

function loadTurnstile(): Promise<Turnstile | null> {
  const scope = window as unknown as { turnstile?: Turnstile };
  if (scope.turnstile) return Promise.resolve(scope.turnstile);
  return new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.onload = () => resolve(scope.turnstile ?? null);
    script.onerror = () => resolve(null);
    document.head.appendChild(script);
  });
}

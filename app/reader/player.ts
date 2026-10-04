/**
 * Playback engine.
 *
 * Audio is fetched from `POST /api/tts/batch` in as few requests as the limits
 * allow, because one request per line would exhaust the per-IP rate limit on
 * any real script. Clips are kept in memory for the session, so repeating,
 * looping and replaying cost nothing and are instant.
 *
 * Speed and volume are applied to the audio element rather than sent to
 * Google: changing them never re-synthesizes, so it is free and immediate, and
 * every clip stays cache-identical however the listener sets them.
 */

import { effectiveRate, speakerOf, type Prefs, type Script, type Speaker } from "./model";
import { applyDict, segmentsOf, type Segment } from "./text";

export type Status = "idle" | "loading" | "playing" | "paused";

export interface PlayerState {
  status: Status;
  /** Index into `script.lines`, or -1 when nothing is cued. */
  line: number;
  /** Character range of the segment being spoken, for highlighting. */
  range: [number, number] | null;
  /** A deliberate silence the listener should see a countdown for. */
  waiting: { kind: "shadow"; ms: number; at: number } | null;
  /** Clips still to fetch, so the UI can show progress on first play. */
  pending: number;
  error: string;
}

export const IDLE_STATE: PlayerState = {
  status: "idle",
  line: -1,
  range: null,
  waiting: null,
  pending: 0,
  error: "",
};

interface Context {
  script: Script;
  prefs: Prefs;
  /** Server batch caps, from the catalog, so the client never oversends. */
  limits: { maxItems: number; maxChars: number };
  turnstileToken: () => Promise<string>;
}

interface ClipRequest {
  key: string;
  text: string;
  voice: string;
  prompt?: string;
}

interface BatchResponseItem {
  audio: string;
  characters: number;
  cache: "HIT" | "MISS";
}

/** One silent frame, played on the user's click so later programmatic plays are allowed. */
const SILENCE =
  "data:audio/mpeg;base64,//uQxAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAACcQCA" +
  "gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgP////////" +
  "////////////////////////////////////////8AAAAATGF2YzU4LjEzAAAAAAAAAAAAAAAA" +
  "JAAAAAAAAAAAAnGMHkkIAAAAAAAAAAAAAAAAAAAA";

function clipKey(script: Script, voice: string, prompt: string, spoken: string): string {
  return JSON.stringify([script.engine, script.lang, script.engine === "gemini" ? script.model : "", voice, prompt, spoken]);
}

export class Player {
  private ctx: Context;
  private listeners = new Set<(state: PlayerState) => void>();
  private state: PlayerState = { ...IDLE_STATE };

  private audio: HTMLAudioElement | null = null;
  private clips = new Map<string, string>();
  private inflight = new Map<string, Promise<void>>();

  /** Bumped on every interruption; stale callbacks compare against it and stop. */
  private token = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** What a resume should run, captured when playback is paused mid-wait. */
  private resumeStep: (() => void) | null = null;

  private lineIndex = -1;
  private segments: Segment[] = [];
  private segIndex = 0;
  private repeat = 0;
  private single = false;

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  update(ctx: Context): void {
    this.ctx = ctx;
    // Speed changes take effect on the clip already playing.
    if (this.audio && this.lineIndex >= 0) {
      const line = this.ctx.script.lines[this.lineIndex];
      if (line) this.applyVoiceSettings(speakerOf(this.ctx.script, line.sp));
    }
  }

  subscribe(fn: (state: PlayerState) => void): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  getState(): PlayerState {
    return this.state;
  }

  private set(patch: Partial<PlayerState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.state);
  }

  dispose(): void {
    this.halt();
    for (const url of this.clips.values()) URL.revokeObjectURL(url);
    this.clips.clear();
    this.listeners.clear();
    if (this.audio) {
      this.audio.src = "";
      this.audio = null;
    }
  }

  /* ---------- audio element ---------- */

  /**
   * Must run inside the click handler: browsers only allow later programmatic
   * playback on an element the user has already started once.
   */
  unlock(): void {
    if (this.audio) return;
    const audio = new Audio();
    audio.preload = "auto";
    audio.src = SILENCE;
    void audio.play().catch(() => {
      // Still fine: the element is created, and the first real clip may prompt.
    });
    this.audio = audio;
  }

  private applyVoiceSettings(sp: Speaker): void {
    if (!this.audio) return;
    this.audio.playbackRate = effectiveRate(sp, this.ctx.prefs);
    this.audio.volume = Math.min(1, Math.max(0, sp.volume ?? 1));
  }

  /* ---------- fetching ---------- */

  /** Every clip the script needs, in playback order and without duplicates. */
  private requestsFor(script: Script): ClipRequest[] {
    const seen = new Set<string>();
    const out: ClipRequest[] = [];
    for (const line of script.lines) {
      const sp = speakerOf(script, line.sp);
      if (sp.mode === "skip") continue;
      for (const seg of segmentsOf(line.text)) {
        if (seg.kind !== "speech") continue;
        const spoken = applyDict(seg.text, this.ctx.prefs.dict, this.ctx.script.lang);
        const prompt = script.engine === "gemini" ? sp.prompt.trim() : "";
        const key = clipKey(script, sp.voice, prompt, spoken);
        if (seen.has(key) || this.clips.has(key)) continue;
        seen.add(key);
        out.push({ key, text: spoken, voice: sp.voice, prompt: prompt || undefined });
      }
    }
    return out;
  }

  /** Splits into requests that each fit the server's batch limits. */
  private groupRequests(requests: ClipRequest[]): ClipRequest[][] {
    const groups: ClipRequest[][] = [];
    let group: ClipRequest[] = [];
    let chars = 0;
    for (const request of requests) {
      const length = [...request.text].length;
      const { maxItems, maxChars } = this.ctx.limits;
      if (group.length >= maxItems || (group.length > 0 && chars + length > maxChars)) {
        groups.push(group);
        group = [];
        chars = 0;
      }
      group.push(request);
      chars += length;
    }
    if (group.length) groups.push(group);
    return groups;
  }

  private async fetchGroup(group: ClipRequest[]): Promise<void> {
    const script = this.ctx.script;
    const headers: Record<string, string> = { "content-type": "application/json" };
    const token = await this.ctx.turnstileToken();
    if (token) headers["x-turnstile-token"] = token;

    const response = await fetch("/api/tts/batch", {
      method: "POST",
      headers,
      body: JSON.stringify({
        engine: script.engine,
        language: script.lang,
        format: "mp3",
        ...(script.engine === "gemini" ? { model: script.model } : {}),
        items: group.map((r) => ({
          text: r.text,
          ...(r.voice ? { voice: r.voice } : {}),
          ...(r.prompt ? { prompt: r.prompt } : {}),
        })),
      }),
    });

    if (!response.ok) {
      const problem = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
      throw new Error(problem?.error?.message ?? `Synthesis failed with status ${response.status}.`);
    }

    const body = (await response.json()) as { contentType: string; items: BatchResponseItem[] };
    body.items.forEach((item, index) => {
      const bytes = Uint8Array.from(atob(item.audio), (ch) => ch.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: body.contentType }));
      this.clips.set(group[index].key, url);
    });
  }

  /**
   * Fetches the first group before returning so playback can start, then keeps
   * fetching the rest in the background while the opening lines play.
   */
  private async prepare(): Promise<void> {
    const groups = this.groupRequests(this.requestsFor(this.ctx.script));
    if (!groups.length) return;

    this.set({ status: "loading", pending: groups.reduce((n, g) => n + g.length, 0), error: "" });
    const first = groups.shift()!;
    await this.run(first);

    void (async () => {
      for (const group of groups) {
        try {
          await this.run(group);
        } catch {
          // Reported when a clip is actually needed; earlier lines still play.
        }
      }
    })();
  }

  private run(group: ClipRequest[]): Promise<void> {
    const key = group.map((r) => r.key).join("|");
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const promise = this.fetchGroup(group)
      .then(() => {
        this.set({ pending: Math.max(0, this.state.pending - group.length) });
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  /** Waits for a clip that a later background group is still fetching. */
  private async clipFor(key: string): Promise<string | null> {
    if (this.clips.has(key)) return this.clips.get(key)!;
    const waits = [...this.inflight.values()];
    if (!waits.length) return null;
    await Promise.allSettled(waits);
    return this.clips.get(key) ?? null;
  }

  /* ---------- transport ---------- */

  private halt(): void {
    this.token++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.resumeStep = null;
    if (this.audio) {
      this.audio.pause();
      this.audio.onended = null;
      this.audio.onerror = null;
    }
  }

  private wait(ms: number, step: () => void, shadow = false): void {
    if (this.timer) clearTimeout(this.timer);
    this.resumeStep = step;
    const at = Date.now();
    this.set({ waiting: shadow ? { kind: "shadow", ms, at } : null });
    const token = this.token;
    this.timer = setTimeout(() => {
      if (token !== this.token || this.state.status !== "playing") return;
      this.resumeStep = null;
      this.set({ waiting: null });
      step();
    }, Math.max(0, ms));
  }

  private playableFrom(index: number, dir: 1 | -1, inclusive: boolean): number {
    const lines = this.ctx.script.lines;
    let i = inclusive ? index : index + dir;
    while (i >= 0 && i < lines.length) {
      if (speakerOf(this.ctx.script, lines[i].sp).mode !== "skip") return i;
      i += dir;
    }
    return -1;
  }

  async play(from?: number, single = false): Promise<void> {
    const lines = this.ctx.script.lines;
    if (!lines.length) {
      this.set({ error: "The script is empty. Write a line first." });
      return;
    }
    let index = from ?? (this.lineIndex >= 0 ? this.lineIndex : 0);
    if (!single) {
      index = this.playableFrom(index, 1, true);
      if (index < 0) index = this.playableFrom(0, 1, true);
    }
    if (index < 0) {
      this.set({ error: "Every speaker is set to skip." });
      return;
    }

    this.halt();
    this.single = single;
    this.set({ status: "loading", error: "" });

    const token = this.token;
    try {
      await this.prepare();
    } catch (caught) {
      if (token !== this.token) return;
      this.set({ status: "idle", pending: 0, error: caught instanceof Error ? caught.message : "Synthesis failed." });
      return;
    }
    if (token !== this.token) return;

    this.set({ status: "playing" });
    void this.beginLine(index);
  }

  private async beginLine(index: number): Promise<void> {
    this.lineIndex = index;
    this.repeat = 0;
    const line = this.ctx.script.lines[index];
    if (!line) return this.finish(false);
    this.set({ line: index, range: null });
    void this.beginPass();
  }

  private async beginPass(): Promise<void> {
    const line = this.ctx.script.lines[this.lineIndex];
    if (!line) return this.finish(false);
    this.segments = segmentsOf(line.text);
    this.segIndex = 0;
    this.passStarted = Date.now();
    void this.nextSegment();
  }

  private passStarted = 0;

  private async nextSegment(): Promise<void> {
    if (this.state.status !== "playing") return;
    const segment = this.segments[this.segIndex];
    if (!segment) {
      this.set({ range: null });
      return this.afterPass();
    }
    if (segment.kind === "pause") {
      this.segIndex++;
      this.set({ range: null });
      return this.wait(segment.ms / Math.min(1.5, this.ctx.prefs.speed), () => void this.nextSegment());
    }

    const script = this.ctx.script;
    const line = script.lines[this.lineIndex];
    const sp = speakerOf(script, line.sp);
    const spoken = applyDict(segment.text, this.ctx.prefs.dict, this.ctx.script.lang);
    const prompt = script.engine === "gemini" ? sp.prompt.trim() : "";
    const key = clipKey(script, sp.voice, prompt, spoken);

    this.set({ range: [segment.start, segment.end] });

    const token = this.token;
    const url = await this.clipFor(key);
    if (token !== this.token || this.state.status !== "playing") return;
    if (!url) {
      this.set({ status: "idle", error: "Some audio could not be loaded. Press play to try again." });
      return;
    }

    const audio = this.audio ?? (this.audio = new Audio());
    audio.onended = null;
    audio.onerror = null;
    audio.src = url;
    this.applyVoiceSettings(sp);

    audio.onended = () => {
      if (token !== this.token) return;
      this.segIndex++;
      void this.nextSegment();
    };
    audio.onerror = () => {
      if (token !== this.token) return;
      this.segIndex++;
      void this.nextSegment();
    };

    try {
      await audio.play();
    } catch {
      if (token !== this.token) return;
      this.set({ status: "paused", error: "The browser blocked playback. Press play again." });
    }
  }

  private afterPass(): void {
    const prefs = this.ctx.prefs;
    const elapsed = Date.now() - this.passStarted;
    this.repeat++;

    const more = !this.single && this.repeat < prefs.repeat;
    const next = () => (more ? this.wait(Math.max(300, prefs.gap * 1000), () => void this.beginPass()) : this.goNext());

    if (!this.single && prefs.shadow > 0) this.wait(elapsed * prefs.shadow + 400, next, true);
    else next();
  }

  private goNext(): void {
    if (this.single) return this.finish(true);
    let next = this.playableFrom(this.lineIndex, 1, false);
    if (next < 0) {
      if (this.ctx.prefs.loop) next = this.playableFrom(0, 1, true);
      if (next < 0) return this.finish(false);
    }
    this.wait(this.ctx.prefs.gap * 1000, () => void this.beginLine(next));
  }

  private finish(keepCursor: boolean): void {
    const at = this.lineIndex;
    this.halt();
    this.lineIndex = keepCursor ? at : -1;
    this.set({ status: "idle", line: this.lineIndex, range: null, waiting: null });
  }

  pause(): void {
    if (this.state.status !== "playing") return;
    const step = this.resumeStep;
    this.halt();
    this.resumeStep = step;
    this.set({ status: "paused", waiting: null });
  }

  resume(): void {
    if (this.state.status !== "paused") return;
    this.set({ status: "playing", error: "" });
    const step = this.resumeStep;
    this.resumeStep = null;
    if (step) step();
    else void this.nextSegment();
  }

  toggle(): void {
    this.unlock();
    if (this.state.status === "playing") this.pause();
    else if (this.state.status === "paused") this.resume();
    else void this.play(this.lineIndex >= 0 ? this.lineIndex : 0);
  }

  stop(): void {
    this.finish(true);
  }

  skip(dir: 1 | -1): void {
    const lines = this.ctx.script.lines;
    if (!lines.length) return;
    let next = this.lineIndex < 0 ? (dir > 0 ? this.playableFrom(0, 1, true) : -1) : this.playableFrom(this.lineIndex, dir, false);
    if (next < 0) next = dir > 0 ? -1 : this.playableFrom(0, 1, true);
    if (next < 0) return;
    this.seek(next);
  }

  seek(index: number): void {
    if (this.state.status === "idle") {
      this.lineIndex = index;
      this.set({ line: index, range: null });
      return;
    }
    this.halt();
    this.single = false;
    this.set({ status: "playing", error: "" });
    void this.beginLine(index);
  }

  /**
   * Speaks a piece of text in a speaker's voice, outside the script, with the
   * dictionary applied: how the dictionary previews a rule. It goes through
   * the same batch endpoint and clip cache as the script, so hearing a preview
   * twice costs one synthesis.
   */
  async say(text: string, sp: Speaker): Promise<void> {
    this.unlock();
    this.halt();
    const script = this.ctx.script;
    const spoken = applyDict(text, this.ctx.prefs.dict, script.lang).trim();
    if (!spoken) return;
    const prompt = script.engine === "gemini" ? sp.prompt.trim() : "";
    const key = clipKey(script, sp.voice, prompt, spoken);

    this.set({ status: "loading", error: "" });
    const token = this.token;
    try {
      if (!this.clips.has(key)) await this.run([{ key, text: spoken, voice: sp.voice, prompt: prompt || undefined }]);
    } catch (caught) {
      this.set({ status: "idle", error: caught instanceof Error ? caught.message : "Synthesis failed." });
      return;
    }
    // Playback started meanwhile owns the status now; leave it alone.
    if (token !== this.token) return;
    this.set({ status: "idle", pending: 0 });

    const audio = this.audio!;
    audio.onended = null;
    audio.onerror = null;
    audio.src = this.clips.get(key)!;
    this.applyVoiceSettings(sp);
    await audio.play().catch(() => this.set({ error: "The browser blocked playback. Try again." }));
  }

  clearError(): void {
    if (this.state.error) this.set({ error: "" });
  }

  /** Clips for the whole script, in order, for the audio export. */
  async collectClips(): Promise<Blob[] | null> {
    try {
      await this.prepare();
      await Promise.allSettled([...this.inflight.values()]);
    } catch {
      return null;
    }
    const script = this.ctx.script;
    const out: Blob[] = [];
    for (const line of script.lines) {
      const sp = speakerOf(script, line.sp);
      if (sp.mode === "skip") continue;
      for (const seg of segmentsOf(line.text)) {
        if (seg.kind !== "speech") continue;
        const spoken = applyDict(seg.text, this.ctx.prefs.dict, this.ctx.script.lang);
        const prompt = script.engine === "gemini" ? sp.prompt.trim() : "";
        const url = this.clips.get(clipKey(script, sp.voice, prompt, spoken));
        if (!url) return null;
        out.push(await (await fetch(url)).blob());
      }
    }
    this.set({ status: this.state.status === "loading" ? "idle" : this.state.status, pending: 0 });
    return out;
  }
}

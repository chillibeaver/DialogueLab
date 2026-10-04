/**
 * Playback engine.
 *
 * Audio comes from `POST /api/tts/batch`. Only what is about to play is
 * fetched: the line the listener starts on jumps the queue, and continuous
 * playback keeps a dozen lines ahead, in batches, so playing one line never
 * pays for the whole script and a long script never sends one request per
 * line. The server does as much as its per-request budget allows and returns
 * the rest as pending, which simply goes back on the queue. Clips stay in
 * memory for the session, so repeating, looping and replaying are free.
 *
 * Speed and volume are applied to the audio element rather than sent to
 * Google: changing them never re-synthesizes, so it is free and immediate, and
 * every clip stays cache-identical however the listener sets them.
 */

import { mp3Silence, stripMp3Headers } from "../../server/lib/audio";
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
  /** Clips still to fetch, so the UI can show progress while it waits. */
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
  status: "ready" | "pending";
  audio?: string;
}

class RateLimited extends Error {
  constructor(readonly seconds: number) {
    super(`Rate limited for ${seconds} s`);
  }
}

/** One silent frame, played on the user's click so later programmatic plays are allowed. */
const SILENCE =
  "data:audio/mpeg;base64,//uQxAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAACcQCA" +
  "gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgP////////" +
  "////////////////////////////////////////8AAAAATGF2YzU4LjEzAAAAAAAAAAAAAAAA" +
  "JAAAAAAAAAAAAnGMHkkIAAAAAAAAAAAAAAAAAAAA";

/** Lines continuous playback keeps ready ahead of the one playing. */
const AHEAD = 12;

/**
 * Lines per request. The server only works through what its per-request
 * budget allows and returns the rest as pending, so sending far more than it
 * can do in one go only wastes the upload.
 */
const MAX_GROUP = 40;

/** Rate-limit waits before giving up, so a stuck server cannot hold playback forever. */
const MAX_RATE_LIMIT_WAITS = 3;

function clipKey(script: Script, voice: string, prompt: string, spoken: string): string {
  return JSON.stringify([script.engine, script.lang, script.engine === "gemini" ? script.model : "", voice, prompt, spoken]);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class Player {
  private ctx: Context;
  private listeners = new Set<(state: PlayerState) => void>();
  private state: PlayerState = { ...IDLE_STATE };

  private audio: HTMLAudioElement | null = null;
  /** Fetched clips, as object URLs, by key. */
  private clips = new Map<string, string>();

  /** Clips waiting to be fetched, most urgent first. */
  private queue: ClipRequest[] = [];
  /** Keys in a request that has not answered yet. */
  private inflight = new Set<string>();
  /** Callers waiting for a clip, by key. */
  private waiters = new Map<string, { resolve: () => void; reject: (error: Error) => void }[]>();
  private pumping = false;

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
  private passStarted = 0;

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  update(ctx: Context): void {
    // Another script was opened: what was queued for the old one is no longer wanted.
    if (ctx.script.id !== this.ctx.script.id) this.cancelQueue();
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
    this.cancelQueue();
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

  /* ---------- what to fetch ---------- */

  /** The clip for one piece of a line, in its speaker's voice, with the dictionary applied. */
  private request(sp: Speaker, text: string): ClipRequest {
    const script = this.ctx.script;
    const spoken = applyDict(text, this.ctx.prefs.dict, script.lang);
    const prompt = script.engine === "gemini" ? sp.prompt.trim() : "";
    return { key: clipKey(script, sp.voice, prompt, spoken), text: spoken, voice: sp.voice, prompt: prompt || undefined };
  }

  /** Every clip the given lines need, in order and without duplicates. */
  private requestsFor(indexes: number[]): ClipRequest[] {
    const script = this.ctx.script;
    const seen = new Set<string>();
    const out: ClipRequest[] = [];
    for (const index of indexes) {
      const line = script.lines[index];
      if (!line) continue;
      const sp = speakerOf(script, line.sp);
      for (const seg of segmentsOf(line.text)) {
        if (seg.kind !== "speech") continue;
        const request = this.request(sp, seg.text);
        if (seen.has(request.key)) continue;
        seen.add(request.key);
        out.push(request);
      }
    }
    return out;
  }

  private playableLines(): number[] {
    const script = this.ctx.script;
    return script.lines.map((_, i) => i).filter((i) => speakerOf(script, script.lines[i].sp).mode !== "skip");
  }

  /** The playable lines after `index`, in playback order, wrapping round when looping. */
  private upcoming(index: number, count: number): number[] {
    const out: number[] = [];
    let at = index;
    while (out.length < count) {
      let next = this.playableFrom(at, 1, false);
      if (next < 0 && this.ctx.prefs.loop) next = this.playableFrom(0, 1, true);
      if (next < 0 || out.includes(next) || next === index) break;
      out.push(next);
      at = next;
    }
    return out;
  }

  /**
   * Keeps the next lines coming while one plays. It tops up only when fewer
   * than half the window is ready, so lines are fetched in batches rather than
   * one request per line, which would exhaust the rate limit.
   */
  private prefetchAfter(index: number): void {
    const ahead = this.upcoming(index, AHEAD);
    let ready = 0;
    for (const line of ahead) {
      if (!this.requestsFor([line]).every((r) => this.clips.has(r.key))) break;
      ready++;
    }
    if (ready >= AHEAD / 2) return;
    void this.need(this.requestsFor(ahead), false).catch(() => {
      // Reported when one of these lines is actually reached.
    });
  }

  /* ---------- fetching ---------- */

  /**
   * Resolves once every clip in `requests` is available. Urgent requests (the
   * line about to play) jump the queue; the others take their turn.
   */
  private need(requests: ClipRequest[], urgent: boolean): Promise<void> {
    const missing = requests.filter((r) => !this.clips.has(r.key));
    if (!missing.length) return Promise.resolve();

    const promises = missing.map(
      (r) =>
        new Promise<void>((resolve, reject) => {
          const list = this.waiters.get(r.key) ?? [];
          list.push({ resolve, reject });
          this.waiters.set(r.key, list);
        }),
    );
    const toQueue = missing.filter((r) => !this.inflight.has(r.key));
    const keys = new Set(toQueue.map((r) => r.key));
    const rest = this.queue.filter((r) => !keys.has(r.key));
    this.queue = urgent ? [...toQueue, ...rest] : [...rest, ...toQueue];
    this.set({ pending: this.queue.length + this.inflight.size });
    void this.pump();
    return Promise.all(promises).then(() => undefined);
  }

  private settle(key: string, error?: Error): void {
    for (const waiter of this.waiters.get(key) ?? []) {
      if (error) waiter.reject(error);
      else waiter.resolve();
    }
    this.waiters.delete(key);
  }

  private cancelQueue(): void {
    const cancelled = new Error("Cancelled");
    for (const r of this.queue) this.settle(r.key, cancelled);
    this.queue = [];
  }

  private takeGroup(): ClipRequest[] {
    const { maxItems, maxChars } = this.ctx.limits;
    const group: ClipRequest[] = [];
    let chars = 0;
    while (this.queue.length && group.length < Math.min(maxItems, MAX_GROUP)) {
      const length = [...this.queue[0].text].length;
      if (group.length && chars + length > maxChars) break;
      group.push(this.queue.shift()!);
      chars += length;
    }
    return group;
  }

  /** Sends the queue in batches until it is empty. One pump runs at a time. */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    let waits = 0;
    try {
      while (this.queue.length) {
        const group = this.takeGroup();
        for (const r of group) this.inflight.add(r.key);
        try {
          const pending = await this.fetchGroup(group);
          // What the server did not get to this time goes back first, in order.
          const back = new Set(pending.map((r) => r.key));
          this.queue = [...pending, ...this.queue.filter((r) => !back.has(r.key))];
          waits = 0;
        } catch (caught) {
          if (caught instanceof RateLimited && waits < MAX_RATE_LIMIT_WAITS) {
            waits++;
            this.set({ error: `The server is busy; trying again in ${caught.seconds} s.` });
            this.queue = [...group, ...this.queue];
            await sleep(caught.seconds * 1000);
            this.set({ error: "" });
            continue;
          }
          const error = caught instanceof Error ? caught : new Error("Synthesis failed.");
          for (const r of group) this.settle(r.key, error);
        } finally {
          for (const r of group) this.inflight.delete(r.key);
          this.set({ pending: this.queue.length + this.inflight.size });
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  /** One batch request. Stores what came back ready and returns what is still pending. */
  private async fetchGroup(group: ClipRequest[]): Promise<ClipRequest[]> {
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
      const problem = (await response.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
      if (response.status === 429 && problem?.error?.code === "rate_limited") {
        throw new RateLimited(Number(response.headers.get("retry-after")) || 60);
      }
      throw new Error(problem?.error?.message ?? `Synthesis failed with status ${response.status}.`);
    }

    const body = (await response.json()) as { contentType: string; items: BatchResponseItem[] };
    const pending: ClipRequest[] = [];
    body.items.forEach((item, index) => {
      const request = group[index];
      if (item.status !== "ready" || !item.audio) {
        pending.push(request);
        return;
      }
      const bytes = Uint8Array.from(atob(item.audio), (ch) => ch.charCodeAt(0));
      this.clips.set(request.key, URL.createObjectURL(new Blob([bytes], { type: body.contentType })));
      this.settle(request.key);
    });
    // The server always finishes at least one item; if not, stop rather than ask forever.
    if (pending.length === group.length) throw new Error("The server returned no audio. Try again later.");
    return pending;
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

    // Only the line playback starts on: playing one line must not pay for the rest.
    const token = this.token;
    try {
      await this.need(this.requestsFor([index]), true);
    } catch (caught) {
      if (token !== this.token) return;
      this.set({ status: "idle", error: caught instanceof Error ? caught.message : "Synthesis failed." });
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
    if (!this.single) this.prefetchAfter(index);
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
    const request = this.request(sp, segment.text);
    this.set({ range: [segment.start, segment.end] });

    const token = this.token;
    if (!this.clips.has(request.key)) {
      // Not prefetched yet (an edit, a jump, a slow server): wait for it.
      this.set({ status: "loading" });
      try {
        await this.need([request], true);
      } catch (caught) {
        if (token === this.token) {
          this.set({ status: "idle", error: caught instanceof Error ? caught.message : "Some audio could not be loaded." });
        }
        return;
      }
      if (token !== this.token) return;
      this.set({ status: "playing" });
    }
    if (token !== this.token || this.state.status !== "playing") return;

    const audio = this.audio ?? (this.audio = new Audio());
    audio.onended = null;
    audio.onerror = null;
    audio.src = this.clips.get(request.key)!;
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
    else if (this.state.status === "idle") void this.play(this.lineIndex >= 0 ? this.lineIndex : 0);
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
    const request = this.request(sp, text);
    if (!request.text.trim()) return;

    this.set({ status: "loading", error: "" });
    const token = this.token;
    try {
      await this.need([request], true);
    } catch (caught) {
      if (token === this.token) {
        this.set({ status: "idle", error: caught instanceof Error ? caught.message : "Synthesis failed." });
      }
      return;
    }
    // Playback started meanwhile owns the status now; leave it alone.
    if (token !== this.token) return;
    this.set({ status: "idle" });

    const audio = this.audio!;
    audio.onended = null;
    audio.onerror = null;
    audio.src = this.clips.get(request.key)!;
    this.applyVoiceSettings(sp);
    await audio.play().catch(() => this.set({ error: "The browser blocked playback. Try again." }));
  }

  clearError(): void {
    if (this.state.error) this.set({ error: "" });
  }

  /**
   * Lines as one MP3: by default the whole script, skipped speakers left out.
   * Pause markers and the gap between lines become real silence. Each clip's
   * leading tag and header frame are dropped, or players would take the first
   * clip's header as the duration of the whole file.
   */
  async exportAudio(lines = this.playableLines()): Promise<Blob> {
    const script = this.ctx.script;
    const requests = this.requestsFor(lines);
    await this.need(requests, true);

    const bytes = new Map<string, Uint8Array<ArrayBuffer>>();
    for (const r of requests) {
      bytes.set(r.key, new Uint8Array(await (await fetch(this.clips.get(r.key)!)).arrayBuffer()));
    }
    // Silence is made in the clips' own MPEG format, so that it joins cleanly.
    const sample = bytes.values().next().value;
    const silence = (ms: number) => (sample ? mp3Silence(sample, ms) : new Uint8Array(0));

    const parts: Uint8Array<ArrayBuffer>[] = [];
    for (const [k, index] of lines.entries()) {
      if (k > 0) parts.push(silence(this.ctx.prefs.gap * 1000));
      const sp = speakerOf(script, script.lines[index].sp);
      for (const seg of segmentsOf(script.lines[index].text)) {
        parts.push(seg.kind === "pause" ? silence(seg.ms) : stripMp3Headers(bytes.get(this.request(sp, seg.text).key)!));
      }
    }
    return new Blob(parts, { type: "audio/mpeg" });
  }
}

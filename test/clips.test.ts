import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import clipsGuide from "../docs/clips-api.md?raw";
import { api } from "../server/api";
import { CLIPS, parseClipsRequest } from "../server/clips";
import { readConfig, type Bindings } from "../server/config";
import { clearTokenCache } from "../server/google/auth";
import { cacheKey } from "../server/lib/cache";
import { baseEnv, fakeExecutionContext, fakeKv, fakeR2, fakeRateLimiter, makeServiceAccount, stubFetch } from "./helpers";

let serviceAccountJson: string;

beforeAll(async () => {
  serviceAccountJson = (await makeServiceAccount()).json;
});

beforeEach(() => {
  clearTokenCache();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const KEY = "s3cret-for-tests";

function setup(overrides: Partial<Bindings> = {}) {
  const r2 = fakeR2();
  const kv = fakeKv();
  const env = baseEnv(serviceAccountJson, {
    API_KEYS: `teammate:${KEY}`,
    CLIPS: r2.bucket,
    TTS_CACHE: kv.kv,
    ...overrides,
  });
  return { env, r2, kv };
}

function create(body: unknown, env: Bindings, key: string | null = KEY, ctx?: ExecutionContext) {
  return api.request(
    "/v1/clips",
    {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(body),
    },
    env,
    ctx,
  );
}

/** Clip URLs are absolute (…/api/v1/clips/<id>.mp3); the app under test is mounted without /api. */
const play = (url: string, env: Bindings, headers: Record<string, string> = {}) =>
  api.request(new URL(url).pathname.replace(/^\/api/, ""), { headers }, env);

const bytes = async (response: Response) => new TextDecoder().decode(await response.arrayBuffer());

type Body = {
  complete: boolean;
  pending: number;
  failed: number;
  synthesized: number;
  characters: number;
  quota: { used: number; limit: number };
  items: { ref: string | null; id: string; url?: string; status: string; created?: boolean; error?: { code: string } }[];
};

describe("POST /v1/clips: keys", () => {
  it("refuses a request without a key, with a wrong key, and when no keys are configured", async () => {
    stubFetch();
    const { env } = setup();
    const body = { items: [{ text: "Bonjour." }] };

    const missing = await create(body, env, null);
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toMatch(/Bearer/);
    expect((await create(body, env, "wrong")).status).toBe(401);
    expect((await create(body, setup({ API_KEYS: "" }).env)).status).toBe(401);
  });

  it("does not need Turnstile, which a page on another site could never pass", async () => {
    stubFetch();
    const { env } = setup({ TURNSTILE_DISABLED: undefined, TURNSTILE_SECRET_KEY: "set" });
    expect((await create({ items: [{ text: "Bonjour." }] }, env)).status).toBe(200);
  });

  it("rate-limits per key rather than per IP", async () => {
    stubFetch();
    const { limiter, keys } = fakeRateLimiter(true);
    const { env } = setup({ TTS_RATE_LIMITER: limiter });
    await create({ items: [{ text: "Bonjour." }] }, env);
    expect(keys).toEqual(["apikey:teammate"]);
  });
});

describe("POST /v1/clips: making clips", () => {
  it("returns a permanent URL per item, echoing each ref", async () => {
    const fetches = stubFetch();
    const { env } = setup();
    const response = await create(
      {
        language: "fr-FR",
        items: [
          { ref: "q1", text: "Bonjour, je m'appelle Claire.", voice: "Kore" },
          { ref: "q2", text: "Où est la gare ?" },
        ],
      },
      env,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Body;
    expect(body).toMatchObject({ complete: true, pending: 0, failed: 0 });
    expect(body.items.map((i) => [i.ref, i.status, i.created])).toEqual([
      ["q1", "ready", true],
      ["q2", "ready", true],
    ]);
    expect(body.items[0].url).toMatch(/^http:\/\/localhost\/api\/v1\/clips\/[0-9a-f]{32}\.mp3$/);
    expect(fetches.ttsCalls().map((call: any) => call.body.voice.name)).toEqual([
      "fr-FR-Chirp3-HD-Kore",
      "fr-FR-Chirp3-HD-Charon",
    ]);
    expect(body.synthesized).toBe("Bonjour, je m'appelle Claire.".length + "Où est la gare ?".length);
  });

  it("serves a clip publicly with long-lived caching and open CORS", async () => {
    stubFetch();
    const { env } = setup();
    const { items } = (await (await create({ items: [{ text: "Bonjour." }] }, env)).json()) as Body;

    const response = await play(items[0].url!, env, { origin: "https://course.example" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(await bytes(response)).toBe("audio-1");
  });

  it("is free the second time: same input, same URL, no Google call", async () => {
    const fetches = stubFetch();
    const { env } = setup();
    const body = { items: [{ ref: "a", text: "Bonjour." }] };
    const first = (await (await create(body, env)).json()) as Body;
    const second = (await (await create({ items: [{ ref: "b", text: "Bonjour." }] }, env)).json()) as Body;

    expect(fetches.ttsCalls()).toHaveLength(1);
    expect(second.items[0]).toMatchObject({ ref: "b", url: first.items[0].url, created: false });
    expect(second.synthesized).toBe(0);
  });

  it("synthesizes a repeated sentence once within one request", async () => {
    const fetches = stubFetch();
    const { env } = setup();
    const body = (await (
      await create({ items: [{ ref: "x", text: "Merci." }, { ref: "y", text: "Merci." }] }, env)
    ).json()) as Body;
    expect(fetches.ttsCalls()).toHaveLength(1);
    expect(body.items[0].url).toBe(body.items[1].url);
  });

  it("gives a different clip for a different voice, language or speed", async () => {
    stubFetch();
    const { env } = setup();
    const body = (await (
      await create(
        {
          items: [
            { text: "Bonjour." },
            { text: "Bonjour.", voice: "Kore" },
            { text: "Bonjour.", speakingRate: 0.8 },
          ],
        },
        env,
      )
    ).json()) as Body;
    expect(new Set(body.items.map((i) => i.id)).size).toBe(3);
  });

  it("joins a dialogue into one clip, each turn in its own voice", async () => {
    const fetches = stubFetch();
    const { env } = setup();
    const body = (await (
      await create(
        {
          items: [
            {
              ref: "dialogue-1",
              turns: [
                { voice: "Charon", text: "Bonjour madame." },
                { voice: "Kore", text: "Bonjour !" },
              ],
            },
          ],
        },
        env,
      )
    ).json()) as Body;

    expect(fetches.ttsCalls().map((call: any) => call.body.voice.name)).toEqual([
      "fr-FR-Chirp3-HD-Charon",
      "fr-FR-Chirp3-HD-Kore",
    ]);
    expect(await bytes(await play(body.items[0].url!, env))).toBe("audio-1audio-2");
  });

  it("reuses a line the reader already synthesized", async () => {
    const fetches = stubFetch();
    const { env, kv } = setup();
    const key = await cacheKey({
      engine: "chirp3-hd",
      language: "fr-FR",
      voice: "Charon",
      format: "mp3",
      payload: { kind: "text", text: "Déjà fait." },
    });
    await kv.kv.put(key, new TextEncoder().encode("from-cache"), { metadata: { chunks: 1, characters: 10 } });

    const body = (await (await create({ items: [{ text: "Déjà fait." }] }, env)).json()) as Body;
    expect(fetches.ttsCalls()).toHaveLength(0);
    expect(await bytes(await play(body.items[0].url!, env))).toBe("from-cache");
  });

  it("stops at the per-request budget and finishes on the next call", async () => {
    const fetches = stubFetch();
    const { env } = setup();
    const items = Array.from({ length: CLIPS.maxSynthesisCalls + 5 }, (_, i) => ({ ref: `s${i}`, text: `Phrase ${i}.` }));

    const first = (await (await create({ items }, env)).json()) as Body;
    expect(first).toMatchObject({ complete: false, pending: 5 });
    expect(fetches.ttsCalls()).toHaveLength(CLIPS.maxSynthesisCalls);

    const second = (await (await create({ items }, env)).json()) as Body;
    expect(second).toMatchObject({ complete: true, pending: 0 });
    expect(fetches.ttsCalls()).toHaveLength(CLIPS.maxSynthesisCalls + 5);
  });
});

describe("POST /v1/clips: cost limits", () => {
  it("refuses once a key has used its daily characters, and says when it resets", async () => {
    stubFetch();
    const { env } = setup({ API_DAILY_CHARS: "12" });
    const ctx = fakeExecutionContext();
    expect((await create({ items: [{ text: "Bonjour." }] }, env, KEY, ctx.ctx)).status).toBe(200); // 8 characters
    await ctx.settle();

    const response = await create({ items: [{ text: "Au revoir." }] }, env); // 10 more: over 12
    expect(response.status).toBe(429);
    const error = ((await response.json()) as any).error;
    expect(error.code).toBe("quota_exceeded");
    expect(error.details).toMatchObject({ used: 8, limit: 12 });
    expect(error.details.resetsAt).toMatch(/T00:00:00\.000Z$/);
  });

  it("does the part that fits and leaves the rest pending", async () => {
    stubFetch();
    const { env } = setup({ API_DAILY_CHARS: "10" });
    const body = (await (await create({ items: [{ text: "Oui." }, { text: "Bonjour madame." }] }, env)).json()) as Body;
    expect(body.items.map((i) => i.status)).toEqual(["ready", "pending"]);
  });

  it("does not count clips that already exist", async () => {
    stubFetch();
    const { env } = setup({ API_DAILY_CHARS: "8" });
    const ctx = fakeExecutionContext();
    await create({ items: [{ text: "Bonjour." }] }, env, KEY, ctx.ctx);
    await ctx.settle();
    expect((await create({ items: [{ text: "Bonjour." }] }, env)).status).toBe(200);
  });
});

describe("POST /v1/clips: validation", () => {
  it("needs exactly one of text or turns", async () => {
    stubFetch();
    const { env } = setup();
    for (const item of [{}, { text: "a", turns: [{ text: "b" }] }]) {
      const response = await create({ items: [item] }, env);
      expect(response.status).toBe(400);
      expect(((await response.json()) as any).error.message).toMatch(/either text or turns/);
    }
  });

  it("keeps engine-specific options to their engine", async () => {
    stubFetch();
    const { env } = setup();
    expect((await create({ items: [{ text: "a", prompt: "calm" }] }, env)).status).toBe(400);
    expect((await create({ engine: "gemini", items: [{ text: "a", speakingRate: 1.2 }] }, env)).status).toBe(400);
  });

  it("names the item with an unknown voice", async () => {
    stubFetch();
    const { env } = setup();
    const response = await create({ items: [{ text: "a" }, { turns: [{ text: "b", voice: "Bob" }] }] }, env);
    expect(((await response.json()) as any).error).toMatchObject({ code: "unknown_voice" });
  });

  it("reports missing storage clearly", async () => {
    stubFetch();
    const response = await create({ items: [{ text: "a" }] }, setup({ CLIPS: undefined }).env);
    expect(response.status).toBe(503);
    expect(((await response.json()) as any).error.code).toBe("clips_unavailable");
  });

  it("answers a CORS preflight", async () => {
    const { env } = setup();
    const response = await api.request(
      "/v1/clips",
      {
        method: "OPTIONS",
        headers: {
          origin: "https://course.example",
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization,content-type",
        },
      },
      env,
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-headers")).toMatch(/Authorization/i);
  });
});

describe("the guide for AI agents", () => {
  it("shows a request the API accepts", async () => {
    const example = /```json\n([\s\S]*?)```/.exec(clipsGuide)![1];
    const { items } = await parseClipsRequest(JSON.parse(example), readConfig({}));
    expect(items.map((item) => [item.ref, item.parts.length])).toEqual([
      ["ex1-q1", 1],
      ["ex1-q2", 1],
      ["ex2-dialogue", 2],
    ]);
  });

  it("states the limits the code enforces", () => {
    expect(clipsGuide).toContain(`1 to ${CLIPS.maxItems} clips`);
    expect(clipsGuide).toContain(`about ${CLIPS.maxSynthesisCalls} new clips`);
  });
});

describe("GET /v1/clips/:id.mp3", () => {
  async function oneClip() {
    stubFetch({ tts: () => Response.json({ audioContent: btoa("0123456789") }) });
    const setupResult = setup();
    const body = (await (await create({ items: [{ text: "Bonjour." }] }, setupResult.env)).json()) as Body;
    return { ...setupResult, url: body.items[0].url! };
  }

  it("serves byte ranges, which Safari needs to play audio", async () => {
    const { env, url } = await oneClip();
    const response = await play(url, env, { range: "bytes=2-5" });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(response.headers.get("content-length")).toBe("4");
    expect(await bytes(response)).toBe("2345");

    const tail = await play(url, env, { range: "bytes=-3" });
    expect(tail.status).toBe(206);
    expect(tail.headers.get("content-range")).toBe("bytes 7-9/10");
    expect(await bytes(tail)).toBe("789");
  });

  it("answers a revalidation with 304", async () => {
    const { env, url } = await oneClip();
    const etag = (await play(url, env)).headers.get("etag")!;
    expect((await play(url, env, { "if-none-match": etag })).status).toBe(304);
  });

  it("returns 404 for an unknown or malformed id, and never synthesizes", async () => {
    const fetches = stubFetch();
    const { env } = setup();
    expect((await api.request(`/v1/clips/${"0".repeat(32)}.mp3`, {}, env)).status).toBe(404);
    expect((await api.request("/v1/clips/not-an-id.mp3", {}, env)).status).toBe(404);
    expect(fetches.ttsCalls()).toHaveLength(0);
  });
});

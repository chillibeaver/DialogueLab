import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "../server/api";
import type { Bindings } from "../server/config";
import { clearTokenCache } from "../server/google/auth";
import {
  baseEnv,
  fakeExecutionContext,
  fakeKv,
  fakeRateLimiter,
  makeServiceAccount,
  stubFetch,
  toBase64,
} from "./helpers";

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

function postTts(body: unknown, env: Bindings, headers: Record<string, string> = {}, ctx?: ExecutionContext) {
  return api.request(
    "/tts",
    {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
    env,
    ctx,
  );
}

async function errorOf(response: Response) {
  return ((await response.json()) as { error: { code: string; message: string } }).error;
}

describe("GET /catalog", () => {
  it("lists French first and exposes defaults", async () => {
    const response = await api.request("/catalog", {}, baseEnv(serviceAccountJson));
    expect(response.status).toBe(200);
    const catalog = (await response.json()) as any;

    expect(catalog.defaults).toEqual({ engine: "chirp3-hd", language: "fr-FR", format: "mp3" });
    expect(catalog.engines["chirp3-hd"].languages[0]).toEqual({ code: "fr-FR", availability: "ga" });
    expect(catalog.engines.gemini.languages[0]).toEqual({ code: "fr-FR", availability: "ga" });
    expect(catalog.voices).toHaveLength(30);
    expect(catalog.engines.gemini.defaultModel).toBe("gemini-2.5-flash-tts");
  });
});

describe("POST /tts", () => {
  it("synthesizes French with Chirp 3: HD by default", async () => {
    const fetches = stubFetch();
    const response = await postTts({ text: "Bonjour tout le monde." }, baseEnv(serviceAccountJson));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(response.headers.get("x-cache")).toBe("MISS");
    expect(response.headers.get("x-tts-characters")).toBe("22");
    expect(await response.text()).toBe("audio-1");

    const [call] = fetches.ttsCalls();
    expect(call.url).toBe("https://texttospeech.googleapis.com/v1/text:synthesize");
    expect(call.headers.get("authorization")).toBe("Bearer token-abc");
    expect(call.body).toEqual({
      input: { text: "Bonjour tout le monde." },
      voice: { languageCode: "fr-FR", name: "fr-FR-Chirp3-HD-Charon" },
      audioConfig: { audioEncoding: "MP3" },
    });
  });

  it("passes speaking rate, voice and language through for Chirp", async () => {
    const fetches = stubFetch();
    const response = await postTts(
      { text: "Hello.", language: "en-gb", voice: "kore", speakingRate: 0.8, format: "wav" },
      baseEnv(serviceAccountJson),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/wav");
    expect(fetches.ttsCalls()[0].body).toMatchObject({
      voice: { languageCode: "en-GB", name: "en-GB-Chirp3-HD-Kore" },
      audioConfig: { audioEncoding: "LINEAR16", speakingRate: 0.8 },
    });
  });

  it("sends model and style prompt for Gemini-TTS", async () => {
    const fetches = stubFetch();
    const response = await postTts(
      { text: "Il était une fois…", engine: "gemini", prompt: "Lis comme un conteur, doucement." },
      baseEnv(serviceAccountJson),
    );
    expect(response.status).toBe(200);
    expect(fetches.ttsCalls()[0].body).toEqual({
      input: { prompt: "Lis comme un conteur, doucement.", text: "Il était une fois…" },
      voice: { languageCode: "fr-FR", name: "Kore", modelName: "gemini-2.5-flash-tts" },
      audioConfig: { audioEncoding: "MP3" },
    });
  });

  it("splits long text into chunks and joins the audio", async () => {
    const fetches = stubFetch();
    const text = "Voici une phrase française assez ordinaire pour le test. ".repeat(110); // ~6,300 chars
    const response = await postTts({ text }, baseEnv(serviceAccountJson, { MAX_CHARS: "10000" }));

    expect(response.status).toBe(200);
    expect(response.headers.get("x-tts-chunks")).toBe("2");
    expect(fetches.ttsCalls()).toHaveLength(2);
    expect(fetches.tokenCalls()).toHaveLength(1);
    expect((await response.text()).split("audio-").sort()).toEqual(["", "1", "2"]);
  });

  it("serves identical requests from the KV cache", async () => {
    const fetches = stubFetch();
    const { kv, store } = fakeKv();
    const env = baseEnv(serviceAccountJson, { TTS_CACHE: kv });

    const first = fakeExecutionContext();
    const miss = await postTts({ text: "Mise en cache." }, env, {}, first.ctx);
    expect(miss.headers.get("x-cache")).toBe("MISS");
    await first.settle();
    expect([...store.values()][0].ttl).toBe(2592000);

    const hit = await postTts({ text: "  Mise en cache.  " }, env, {}, fakeExecutionContext().ctx);
    expect(hit.headers.get("x-cache")).toBe("HIT");
    expect(await hit.text()).toBe("audio-1");
    expect(fetches.ttsCalls()).toHaveLength(1);

    const otherVoice = await postTts({ text: "Mise en cache.", voice: "Leda" }, env, {}, fakeExecutionContext().ctx);
    expect(otherVoice.headers.get("x-cache")).toBe("MISS");
  });

  describe("validation", () => {
    const cases: Array<[string, unknown, number, string]> = [
      ["empty text", { text: "   " }, 400, "invalid_request"],
      ["missing text", {}, 400, "invalid_request"],
      ["unknown field", { text: "Salut", speed: 2 }, 400, "invalid_request"],
      ["rate out of range", { text: "Salut", speakingRate: 3 }, 400, "invalid_request"],
      ["prompt on chirp", { text: "Salut", prompt: "gaiement" }, 400, "invalid_request"],
      ["rate on gemini", { text: "Salut", engine: "gemini", speakingRate: 1.2 }, 400, "invalid_request"],
      ["unknown model", { text: "Salut", engine: "gemini", model: "gemini-9" }, 400, "invalid_request"],
      ["unsupported language", { text: "Salut", language: "xx-XX" }, 400, "unsupported_language"],
      ["gemini-only language on chirp", { text: "Salut", language: "pt-PT" }, 400, "unsupported_language"],
      ["unknown voice", { text: "Salut", voice: "Nobody" }, 400, "unknown_voice"],
      ["text too long", { text: "a".repeat(5001) }, 413, "text_too_long"],
      ["not JSON", "{oops", 400, "invalid_json"],
    ];

    it.each(cases)("rejects %s", async (_name, body, status, code) => {
      const fetches = stubFetch();
      const response = await postTts(body, baseEnv(serviceAccountJson));
      expect(response.status).toBe(status);
      expect((await errorOf(response)).code).toBe(code);
      expect(fetches.calls).toHaveLength(0);
    });

    it("rejects ogg_opus when the text needs more than one chunk", async () => {
      stubFetch();
      const response = await postTts(
        { text: "Une phrase. ".repeat(500), format: "ogg_opus" },
        baseEnv(serviceAccountJson, { MAX_CHARS: "10000" }),
      );
      expect(response.status).toBe(413);
      expect((await errorOf(response)).code).toBe("text_too_long_for_format");
    });

    it("rejects oversized bodies", async () => {
      stubFetch();
      const response = await postTts({ text: "a".repeat(70_000) }, baseEnv(serviceAccountJson));
      expect(response.status).toBe(413);
      expect((await errorOf(response)).code).toBe("payload_too_large");
    });
  });

  describe("abuse protection", () => {
    it("returns 429 when the rate limiter refuses", async () => {
      const fetches = stubFetch();
      const { limiter, keys } = fakeRateLimiter(false);
      const response = await postTts({ text: "Salut" }, baseEnv(serviceAccountJson, { TTS_RATE_LIMITER: limiter }));
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("60");
      expect(keys).toEqual(["203.0.113.7"]);
      expect(fetches.calls).toHaveLength(0);
    });

    const turnstileEnv = () =>
      baseEnv(serviceAccountJson, { TURNSTILE_DISABLED: undefined, TURNSTILE_SECRET_KEY: "secret-xyz" });

    it("requires a Turnstile token", async () => {
      const fetches = stubFetch();
      const response = await postTts({ text: "Salut" }, turnstileEnv());
      expect(response.status).toBe(403);
      expect((await errorOf(response)).code).toBe("turnstile_required");
      expect(fetches.ttsCalls()).toHaveLength(0);
    });

    it("verifies the Turnstile token before synthesizing", async () => {
      const fetches = stubFetch();
      const response = await postTts({ text: "Salut" }, turnstileEnv(), { "x-turnstile-token": "tok-1" });
      expect(response.status).toBe(200);
      expect(fetches.turnstileCalls()[0].body).toEqual({
        secret: "secret-xyz",
        response: "tok-1",
        remoteip: "203.0.113.7",
      });
    });

    it("rejects a failed Turnstile check", async () => {
      const fetches = stubFetch({ turnstile: () => Response.json({ success: false, "error-codes": ["invalid-input-response"] }) });
      const response = await postTts({ text: "Salut" }, turnstileEnv(), { "x-turnstile-token": "bad" });
      expect(response.status).toBe(403);
      expect((await errorOf(response)).code).toBe("turnstile_failed");
      expect(fetches.ttsCalls()).toHaveLength(0);
    });

    it("fails closed when Turnstile is not configured", async () => {
      const fetches = stubFetch();
      const response = await postTts({ text: "Salut" }, baseEnv(serviceAccountJson, { TURNSTILE_DISABLED: undefined }));
      expect(response.status).toBe(500);
      expect((await errorOf(response)).code).toBe("server_misconfigured");
      expect(fetches.ttsCalls()).toHaveLength(0);
    });
  });

  describe("upstream errors", () => {
    it("passes Google's input errors through as 422", async () => {
      stubFetch({
        tts: () =>
          Response.json(
            { error: { code: 400, status: "INVALID_ARGUMENT", message: "This request contains sentences that are too long." } },
            { status: 400 },
          ),
      });
      const response = await postTts({ text: "Salut" }, baseEnv(serviceAccountJson));
      expect(response.status).toBe(422);
      expect(await errorOf(response)).toEqual({
        code: "synthesis_rejected",
        message: "This request contains sentences that are too long.",
      });
    });

    it("hides credential problems behind a generic 502", async () => {
      stubFetch({ tts: () => Response.json({ error: { message: "Permission denied on project 123" } }, { status: 403 }) });
      const response = await postTts({ text: "Salut" }, baseEnv(serviceAccountJson));
      expect(response.status).toBe(502);
      const error = await errorOf(response);
      expect(error.code).toBe("upstream_auth_failed");
      expect(error.message).not.toContain("123");
    });

    it("maps Google quota errors to 503 with Retry-After", async () => {
      stubFetch({ tts: () => Response.json({ error: { status: "RESOURCE_EXHAUSTED" } }, { status: 429 }) });
      const response = await postTts({ text: "Salut" }, baseEnv(serviceAccountJson));
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("30");
    });

    it("reports a missing service account as misconfiguration", async () => {
      stubFetch();
      const response = await postTts({ text: "Salut" }, baseEnv(""));
      expect(response.status).toBe(500);
      expect((await errorOf(response)).code).toBe("server_misconfigured");
    });
  });
});

it("returns JSON 404 for unknown API paths", async () => {
  const response = await api.request("/nope", {}, baseEnv(serviceAccountJson));
  expect(response.status).toBe(404);
  expect((await errorOf(response)).code).toBe("not_found");
});

it("decodes real base64 audio bytes", async () => {
  const bytes = new Uint8Array([0, 255, 128, 7]);
  stubFetch({ tts: () => Response.json({ audioContent: toBase64(bytes) }) });
  const response = await postTts({ text: "Salut" }, baseEnv(serviceAccountJson));
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
});

describe("POST /tts multi-speaker dialogue", () => {
  const dialogue = {
    engine: "gemini" as const,
    prompt: "Une conversation amicale.",
    speakers: [
      { alias: "Marie", voice: "Kore" },
      { alias: "Paul", voice: "Charon" },
    ],
    turns: [
      { speaker: "Marie", text: "Bonjour Paul !" },
      { speaker: "Paul", text: "Salut Marie." },
    ],
  };

  it("sends the multi-speaker body Google documents, in one request", async () => {
    const fetches = stubFetch();
    const response = await postTts(dialogue, baseEnv(serviceAccountJson));

    expect(response.status).toBe(200);
    const calls = fetches.ttsCalls();
    // A dialogue is never split: splitting it would break speaker continuity.
    expect(calls).toHaveLength(1);
    expect(response.headers.get("x-tts-chunks")).toBe("1");
    expect(calls[0].body).toEqual({
      input: {
        prompt: "Une conversation amicale.",
        multiSpeakerMarkup: {
          turns: [
            { speaker: "Marie", text: "Bonjour Paul !" },
            { speaker: "Paul", text: "Salut Marie." },
          ],
        },
      },
      voice: {
        languageCode: "fr-FR",
        modelName: "gemini-2.5-flash-tts",
        multiSpeakerVoiceConfig: {
          speakerVoiceConfigs: [
            { speakerAlias: "Marie", speakerId: "Kore" },
            { speakerAlias: "Paul", speakerId: "Charon" },
          ],
        },
      },
      audioConfig: { audioEncoding: "MP3" },
    });
  });

  it("counts characters across all turns", async () => {
    stubFetch();
    const response = await postTts(dialogue, baseEnv(serviceAccountJson));
    expect(response.headers.get("x-tts-characters")).toBe(String("Bonjour Paul !".length + "Salut Marie.".length));
  });

  it("caches a dialogue separately from the same text spoken by one voice", async () => {
    const { kv } = fakeKv();
    const fetches = stubFetch();
    const env = baseEnv(serviceAccountJson, { TTS_CACHE: kv });

    const first = fakeExecutionContext();
    expect((await postTts(dialogue, env, {}, first.ctx)).headers.get("x-cache")).toBe("MISS");
    await first.settle();

    const again = await postTts(dialogue, env, {}, fakeExecutionContext().ctx);
    expect(again.headers.get("x-cache")).toBe("HIT");
    expect(fetches.ttsCalls()).toHaveLength(1);

    const changed = await postTts(
      { ...dialogue, turns: [{ speaker: "Marie", text: "Autre chose." }] },
      env,
      {},
      fakeExecutionContext().ctx,
    );
    expect(changed.headers.get("x-cache")).toBe("MISS");
    expect(fetches.ttsCalls()).toHaveLength(2);
  });

  it("rejects a dialogue on the chirp3-hd engine", async () => {
    stubFetch();
    const response = await postTts({ ...dialogue, engine: "chirp3-hd" }, baseEnv(serviceAccountJson));
    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toMatch(/only supported by the gemini engine/);
  });

  it("rejects text and turns together, and turns without speakers", async () => {
    stubFetch();
    const both = await postTts({ ...dialogue, text: "Bonjour" }, baseEnv(serviceAccountJson));
    expect((await errorOf(both)).message).toMatch(/either text or turns/);

    const { speakers, ...noSpeakers } = dialogue;
    const lone = await postTts(noSpeakers, baseEnv(serviceAccountJson));
    expect((await errorOf(lone)).message).toMatch(/both speakers and turns/);
  });

  it("requires exactly two speakers, as Google does", async () => {
    stubFetch();
    const three = await postTts(
      { ...dialogue, speakers: [...dialogue.speakers, { alias: "Zoe", voice: "Leda" }] },
      baseEnv(serviceAccountJson),
    );
    expect(three.status).toBe(400);
  });

  it("rejects aliases that are not alphanumeric, and duplicates", async () => {
    stubFetch();
    const spaced = await postTts(
      { ...dialogue, speakers: [{ alias: "Marie C", voice: "Kore" }, dialogue.speakers[1]] },
      baseEnv(serviceAccountJson),
    );
    expect((await errorOf(spaced)).message).toMatch(/alphanumeric/);

    const duplicate = await postTts(
      { ...dialogue, speakers: [dialogue.speakers[0], { alias: "Marie", voice: "Charon" }] },
      baseEnv(serviceAccountJson),
    );
    expect((await errorOf(duplicate)).message).toMatch(/used twice/);
  });

  it("rejects a turn whose speaker was never declared", async () => {
    stubFetch();
    const response = await postTts(
      { ...dialogue, turns: [{ speaker: "Zoe", text: "Bonjour" }] },
      baseEnv(serviceAccountJson),
    );
    expect((await errorOf(response)).message).toMatch(/not declared in speakers/);
  });

  it("rejects a dialogue past the byte cap instead of splitting it", async () => {
    stubFetch();
    const response = await postTts(
      { ...dialogue, turns: [{ speaker: "Marie", text: "Bonjour. ".repeat(500) }] },
      baseEnv(serviceAccountJson),
    );
    expect(response.status).toBe(413);
    expect((await errorOf(response)).message).toMatch(/synthesized in one request/);
  });

  it("rejects a single voice alongside speakers", async () => {
    stubFetch();
    const response = await postTts({ ...dialogue, voice: "Kore" }, baseEnv(serviceAccountJson));
    expect((await errorOf(response)).message).toMatch(/each speaker declares its own/);
  });
});

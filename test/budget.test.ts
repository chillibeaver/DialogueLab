import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "../server/api";
import {
  billingMonth,
  estimateCost,
  grant,
  nextMonthStart,
  refund,
  spentMicros,
  type BudgetLimits,
} from "../server/budget";
import { readConfig, type Bindings } from "../server/config";
import { clearTokenCache } from "../server/google/auth";
import {
  baseEnv,
  fakeBudget,
  fakeExecutionContext,
  fakeKv,
  fakeR2,
  makeServiceAccount,
  stubFetch,
} from "./helpers";

let serviceAccountJson: string;

beforeAll(async () => {
  serviceAccountJson = (await makeServiceAccount()).json;
});

beforeEach(() => {
  clearTokenCache();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const chirp = { engine: "chirp3-hd", language: "fr-FR", voice: "Charon", format: "mp3" } as const;
const gemini = (model: "gemini-2.5-flash-tts" | "gemini-2.5-pro-tts", prompt?: string) =>
  ({ engine: "gemini", language: "fr-FR", voice: "Kore", format: "mp3", model, prompt }) as const;

describe("the cost model", () => {
  it("counts Chirp 3: HD in characters, billed at US$30 a million past the free ones", () => {
    expect(estimateCost(chirp, 10)).toEqual({ chirpChars: 10, geminiMicros: 0 });
    const limits: BudgetLimits = { budgetMicros: 0, chirpFreeChars: 1_000_000 };
    expect(spentMicros({ chirpChars: 1_000_000, geminiMicros: 0 }, limits)).toBe(0);
    expect(spentMicros({ chirpChars: 1_000_010, geminiMicros: 0 }, limits)).toBe(300);
  });

  it("estimates Gemini-TTS high: 2.5 audio tokens and 0.5 text tokens a character, a prompt per call", () => {
    // 10 × 2.5 × US$10 + 10 × 0.5 × US$0.50, per million tokens
    expect(estimateCost(gemini("gemini-2.5-flash-tts"), 10)).toEqual({ chirpChars: 0, geminiMicros: 253 });
    // 10 × 2.5 × US$20 + (10 + 2 × 14) × 0.5 × US$1
    expect(estimateCost(gemini("gemini-2.5-pro-tts", "Lis lentement."), 10, 2).geminiMicros).toBe(519);
    expect(spentMicros({ chirpChars: 0, geminiMicros: 253 }, { budgetMicros: 0, chirpFreeChars: 1_000_000 })).toBe(253);
  });

  it("grants costs in order while they fit, and nothing past the first that does not", () => {
    const limits: BudgetLimits = { budgetMicros: 600, chirpFreeChars: 0 };
    const costs = [10, 11, 1].map((n) => estimateCost(chirp, n)); // 300, 330, 30
    // The 30 would fit after the 300, but lines are granted in playback order.
    expect(grant({ chirpChars: 0, geminiMicros: 0 }, costs, limits)).toEqual({
      granted: 1,
      usage: { chirpChars: 10, geminiMicros: 0 },
    });
    expect(grant({ chirpChars: 0, geminiMicros: 0 }, costs, { ...limits, budgetMicros: 630 }).granted).toBe(2);
    expect(grant({ chirpChars: 0, geminiMicros: 0 }, costs, { ...limits, budgetMicros: 660 }).granted).toBe(3);
  });

  it("gives back refunds without going below zero", () => {
    expect(refund({ chirpChars: 5, geminiMicros: 100 }, [{ chirpChars: 10, geminiMicros: 40 }])).toEqual({
      chirpChars: 0,
      geminiMicros: 60,
    });
  });

  it("runs by calendar month in US Pacific time, as Google bills", () => {
    expect(billingMonth(new Date("2026-11-01T05:00:00Z"))).toBe("2026-10"); // 10 pm on October 31 in California
    expect(billingMonth(new Date("2026-11-01T09:00:00Z"))).toBe("2026-11");
    expect(nextMonthStart("2026-10")).toBe("2026-11-01");
    expect(nextMonthStart("2026-12")).toBe("2027-01-01");
  });

  it("reads the budget in dollars, with no budget meaning no cap", () => {
    expect(readConfig({}).monthlyBudgetMicros).toBeNull();
    expect(readConfig({ MONTHLY_BUDGET_USD: "4" }).monthlyBudgetMicros).toBe(4_000_000);
    expect(readConfig({ MONTHLY_BUDGET_USD: "0" }).monthlyBudgetMicros).toBe(0);
    expect(readConfig({ MONTHLY_BUDGET_USD: "four" }).monthlyBudgetMicros).toBeNull();
    expect(readConfig({}).chirpFreeChars).toBe(1_000_000);
    expect(readConfig({ CHIRP_FREE_CHARS: "0" }).chirpFreeChars).toBe(0);
  });
});

/* ---------- the endpoints ---------- */

const LINES = ["Ligne une.", "Ligne deux.", "Ligne trois."]; // 10, 11 and 12 characters: 300, 330, 360 micro-dollars

function setup(overrides: Partial<Bindings> = {}) {
  const budget = fakeBudget();
  const kv = fakeKv();
  const r2 = fakeR2();
  const env = baseEnv(serviceAccountJson, {
    BUDGET: budget.namespace,
    TTS_CACHE: kv.kv,
    CLIPS: r2.bucket,
    API_KEYS: "teammate:s3cret",
    CHIRP_FREE_CHARS: "0",
    MONTHLY_BUDGET_USD: "0.0006",
    ...overrides,
  });
  return { env, budget, kv, r2 };
}

async function post(path: string, body: unknown, env: Bindings, headers: Record<string, string> = {}) {
  const ctx = fakeExecutionContext();
  const response = await api.request(
    path,
    {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7", ...headers },
      body: JSON.stringify(body),
    },
    env,
    ctx.ctx,
  );
  await ctx.settle();
  return response;
}

const batch = (texts: string[], env: Bindings, extra: Record<string, unknown> = {}) =>
  post("/tts/batch", { ...extra, items: texts.map((text) => ({ text })) }, env);

const errorOf = async (response: Response) =>
  ((await response.json()) as { error: { code: string; message: string; details?: { resetsAt: string } } }).error;

describe("the monthly budget", () => {
  it("makes lines while the month's budget lasts, then refuses with when it renews", async () => {
    const s = setup();
    let fetches = stubFetch();
    const first = (await (await batch(LINES, s.env)).json()) as any;
    expect(first.items.map((i: any) => i.status)).toEqual(["ready", "pending", "pending"]);
    expect(fetches.ttsCalls()).toHaveLength(1);
    expect(s.budget.usage(billingMonth())).toEqual({ chirpChars: 10, geminiMicros: 0 });

    fetches = stubFetch();
    const again = await batch(LINES.slice(1), s.env);
    expect(again.status).toBe(429);
    const error = await errorOf(again);
    expect(error.code).toBe("budget_exhausted");
    expect(error.details?.resetsAt).toBe(nextMonthStart(billingMonth()));
    expect(error.message).toContain(error.details!.resetsAt);
    expect(fetches.ttsCalls()).toHaveLength(0);
  });

  it("still plays what is cached once the budget is spent", async () => {
    const s = setup({ MONTHLY_BUDGET_USD: "0.0003" });
    stubFetch();
    await batch(LINES.slice(0, 1), s.env);
    expect((await batch(LINES.slice(1, 2), s.env)).status).toBe(429);

    const fetches = stubFetch();
    const body = (await (await batch(LINES.slice(0, 1), s.env)).json()) as any;
    expect(body.items[0]).toMatchObject({ status: "ready", cache: "HIT" });
    expect(fetches.ttsCalls()).toHaveLength(0);
  });

  it("applies a raised budget from the next request", async () => {
    const s = setup({ MONTHLY_BUDGET_USD: "0.0003" });
    stubFetch();
    await batch(LINES.slice(0, 1), s.env);
    expect((await batch(LINES.slice(1, 2), s.env)).status).toBe(429);
    expect((await batch(LINES.slice(1, 2), { ...s.env, MONTHLY_BUDGET_USD: "1" })).status).toBe(200);
  });

  it("lets the free Chirp 3: HD characters through at no cost, and Gemini-TTS has none", async () => {
    const s = setup({ MONTHLY_BUDGET_USD: "0", CHIRP_FREE_CHARS: "21" });
    stubFetch();
    const body = (await (await batch(LINES, s.env)).json()) as any;
    expect(body.items.map((i: any) => i.status)).toEqual(["ready", "ready", "pending"]);
    expect((await batch(LINES.slice(2), s.env)).status).toBe(429);
    expect((await batch(["Bonjour."], s.env, { engine: "gemini" })).status).toBe(429);
  });

  it("gives the reservation back when Google fails", async () => {
    const s = setup();
    stubFetch({ tts: () => Response.json({ error: { message: "Backend error" } }, { status: 500 }) });
    expect((await batch(LINES.slice(0, 1), s.env)).ok).toBe(false);
    expect(s.budget.usage(billingMonth())).toEqual({ chirpChars: 0, geminiMicros: 0 });

    stubFetch();
    expect((await batch(LINES.slice(0, 1), s.env)).status).toBe(200);
  });

  it("guards POST /tts the same way", async () => {
    const s = setup({ MONTHLY_BUDGET_USD: "0.0003" });
    let fetches = stubFetch();
    expect((await post("/tts", { text: LINES[0] }, s.env)).status).toBe(200);
    fetches = stubFetch();
    const refused = await post("/tts", { text: LINES[1] }, s.env);
    expect(refused.status).toBe(429);
    expect((await errorOf(refused)).code).toBe("budget_exhausted");
    expect(fetches.ttsCalls()).toHaveLength(0);
  });

  it("guards clips the same way, keeping the clips already made", async () => {
    const s = setup();
    stubFetch();
    const auth = { authorization: "Bearer s3cret" };
    const items = LINES.map((text, i) => ({ ref: `s${i}`, text }));
    const first = (await (await post("/v1/clips", { items }, s.env, auth)).json()) as any;
    expect(first.items.map((i: any) => i.status)).toEqual(["ready", "pending", "pending"]);

    const fetches = stubFetch();
    const again = await post("/v1/clips", { items: items.slice(1) }, s.env, auth);
    expect(again.status).toBe(429);
    expect((await errorOf(again)).code).toBe("budget_exhausted");
    expect(fetches.ttsCalls()).toHaveLength(0);
    expect((await api.request(new URL(first.items[0].url).pathname.replace(/^\/api/, ""), {}, s.env)).status).toBe(200);
  });

  it("fails closed: with a budget set, no ledger means no synthesis", async () => {
    const fetches = stubFetch();
    const missing = setup({ BUDGET: undefined });
    const response = await batch(LINES.slice(0, 1), missing.env);
    expect(response.status).toBe(503);
    expect((await errorOf(response)).code).toBe("budget_unavailable");

    const broken = {
      idFromName: () => "site",
      get: () => ({
        reserve: () => Promise.reject(new Error("Durable Object reset")),
        refund: () => Promise.resolve(),
      }),
    } as unknown as DurableObjectNamespace;
    expect((await batch(LINES.slice(0, 1), setup({ BUDGET: broken }).env)).status).toBe(503);
    expect(fetches.ttsCalls()).toHaveLength(0);
  });

  it("is off without MONTHLY_BUDGET_USD, and never calls the ledger", async () => {
    const s = setup({ MONTHLY_BUDGET_USD: undefined });
    stubFetch();
    expect((await batch(LINES, s.env)).status).toBe(200);
    expect(s.budget.ops.count).toBe(0);
  });

  it("keeps a long script within 50 subrequests a request, ledger calls included", async () => {
    const s = setup({ MONTHLY_BUDGET_USD: "100" });
    let left = Array.from({ length: 60 }, (_, i) => `Réplique numéro ${i}.`);
    let rounds = 0;
    while (left.length) {
      const fetches = stubFetch();
      const before = s.kv.ops.count + s.budget.ops.count;
      const body = (await (await batch(left, s.env)).json()) as any;
      expect(fetches.calls.length + s.kv.ops.count + s.budget.ops.count - before).toBeLessThanOrEqual(50);
      left = left.filter((_, i) => body.items[i].status !== "ready");
      expect(++rounds).toBeLessThan(10);
    }
  });
});

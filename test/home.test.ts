import { describe, expect, it } from "vitest";
import { RouterContextProvider } from "react-router";

import { envContext } from "../app/context";
import { loader } from "../app/routes/home";
import type { Bindings } from "../server/config";

function load(env: Bindings, url: string) {
  const context = new RouterContextProvider();
  context.set(envContext, env);
  return loader({ context, request: new Request(url), params: {} } as unknown as Parameters<typeof loader>[0]);
}

describe("the home page loader", () => {
  // The page is prerendered at build time by a preview server on localhost,
  // whose address must not end up in the page.
  it("takes the canonical address from SITE_URL, not the request", () => {
    expect(load({ SITE_URL: "https://tts.example.org" }, "http://localhost:4173/").siteUrl).toBe(
      "https://tts.example.org/",
    );
    expect(load({ SITE_URL: "https://tts.example.org/" }, "http://localhost:4173/").siteUrl).toBe(
      "https://tts.example.org/",
    );
  });

  it("falls back to the request's address without SITE_URL", () => {
    expect(load({}, "https://tts-studio.example.workers.dev/").siteUrl).toBe("https://tts-studio.example.workers.dev/");
  });

  it("only needs plain vars, so it prerenders where no secret is set", () => {
    const data = load({ TURNSTILE_SITE_KEY: "0x4AAAAtest" }, "http://localhost:4173/");
    expect(data.turnstileSiteKey).toBe("0x4AAAAtest");
    expect(data.catalog.defaults.language).toBe("fr-FR");
  });
});

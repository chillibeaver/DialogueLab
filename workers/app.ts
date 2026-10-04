import { Hono } from "hono";
import { createRequestHandler, RouterContextProvider } from "react-router";

import { envContext } from "../app/context";
import { api } from "../server/api";
import type { Bindings } from "../server/config";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

const app = new Hono<{ Bindings: Bindings }>();

// JSON API first; every other path is server-rendered by React Router.
app.route("/api", api);

// Built from the request host, so they stay correct on any domain.
app.get("/robots.txt", (c) => {
  const origin = new URL(c.req.url).origin;
  return c.text(`User-agent: *
Allow: /
Disallow: /api/

Sitemap: ${origin}/sitemap.xml
`);
});

app.get("/sitemap.xml", (c) => {
  const origin = new URL(c.req.url).origin;
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${origin}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>
</urlset>
`;
  return c.body(body, 200, { "content-type": "application/xml; charset=utf-8" });
});
app.all("*", (c) => {
  // Loaders read bindings from this context, so pages can be rendered from the
  // same data the API serves without a round trip back to ourselves.
  const context = new RouterContextProvider();
  context.set(envContext, c.env);
  return requestHandler(c.req.raw, context);
});

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;

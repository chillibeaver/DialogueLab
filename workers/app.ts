import { Hono } from "hono";
import { createRequestHandler } from "react-router";

import { api } from "../server/api";
import type { Bindings } from "../server/config";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

const app = new Hono<{ Bindings: Bindings }>();

// JSON API first; every other path is server-rendered by React Router.
app.route("/api", api);
app.all("*", (c) => requestHandler(c.req.raw));

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;

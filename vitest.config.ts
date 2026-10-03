import { defineConfig } from "vitest/config";

// Kept separate from vite.config.ts so tests don't load the React Router / Cloudflare plugins.
// Server code only uses web-standard APIs, so it runs under Node with fakes for bindings.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});

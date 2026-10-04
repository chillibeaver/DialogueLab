import type { Config } from "@react-router/dev/config";

export default {
  // Server-side render by default, to enable SPA mode set this to `false`
  ssr: true,
  // The home page is the same for every visitor (each one's scripts load from
  // their own browser afterwards), so it is rendered once at build time and
  // served as a static file: page views never run the Worker. Its loader runs
  // in the build's local preview of the Worker, with the vars in wrangler.jsonc.
  prerender: ["/"],
} satisfies Config;

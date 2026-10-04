// Makes an API key for the clips API and prints how to install it.
// usage: npm run api-key -- <name>
import { randomBytes } from "node:crypto";

const name = (process.argv[2] ?? "").trim();
if (!/^[A-Za-z0-9._-]{1,40}$/.test(name)) {
  console.error("usage: npm run api-key -- <name>   (letters, digits, dot, dash, underscore)");
  process.exit(1);
}
const secret = randomBytes(24).toString("hex");
const entry = `${name}:${secret}`;

console.log(`
New API key for "${name}"

  Give ${name} this key (they set it as TTS_STUDIO_KEY):

    ${secret}

  Install it on the server. API_KEYS holds every key, comma-separated, and
  "wrangler secret put" REPLACES the whole value, so enter all of them:

    npx wrangler secret put API_KEYS
    -> ${entry}            (first key)
    -> other:…,${entry}    (adding to existing keys)

  Cloudflare never shows a secret again, so keep the full list somewhere
  safe, such as a password manager. To revoke someone, put the list back
  without their entry.

  For local development, add the same entry to API_KEYS in .dev.vars.
`);

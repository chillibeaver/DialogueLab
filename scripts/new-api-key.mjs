// Makes a collaborator's API key, and the folder to send them.
//
//   npm run api-key -- <name> [--site https://your-site]
//
// - A new name gets a new random key, added to api-keys.txt: the admin's copy
//   of the API_KEYS secret, kept out of git.
// - A name that already has a key keeps it; only the folder is rebuilt, for
//   instance once the site's address is known.
// - handover/<name>/ (also kept out of git) is everything to send them: the
//   files in collaborators/, with the site's address filled in, plus KEY.txt.
//   Zip it and send it.
//
// Then `npm run api-keys:push` puts api-keys.txt on the server.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LIST = "api-keys.txt";
const SOURCE = "collaborators";
const PLACEHOLDER = "https://tts.example.com";

function fail(message) {
  console.error(message);
  console.error("usage: npm run api-key -- <name> [--site https://your-site]");
  process.exit(1);
}

const args = process.argv.slice(2);
let site;
const at = args.indexOf("--site");
if (at >= 0) {
  site = (args.splice(at, 2)[1] ?? "").replace(/\/+$/, "");
  if (!/^https?:\/\/[^/\s]+$/.test(site)) fail("--site needs an address such as https://tts.example.org");
}
const name = (args[0] ?? "").trim();
if (!/^[A-Za-z0-9._-]{1,40}$/.test(name)) fail("The name may use letters, digits, dot, dash and underscore.");

// api-keys.txt is the exact value of the API_KEYS secret: "name:secret" entries, comma-separated.
const entries = existsSync(LIST)
  ? readFileSync(LIST, "utf8").split(/[,\r\n]+/).map((e) => e.trim()).filter(Boolean)
  : [];
let entry = entries.find((e) => e.startsWith(`${name}:`));
const created = !entry;
if (!entry) {
  entry = `${name}:${randomBytes(24).toString("hex")}`;
  entries.push(entry);
  writeFileSync(LIST, entries.join(",") + "\n");
}
const secret = entry.slice(name.length + 1);

// The hand-over folder, rebuilt from scratch so it never holds stale files.
const out = join("handover", name);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const file of readdirSync(SOURCE)) {
  const text = readFileSync(join(SOURCE, file), "utf8");
  writeFileSync(join(out, file), site ? text.replaceAll(PLACEHOLDER, site) : text);
}
writeFileSync(
  join(out, "KEY.txt"),
  `Your TTS Studio API key. It is personal: keep it private, and never put it
in a page you publish.

    ${secret}

The build script reads it from the environment variable TTS_STUDIO_KEY:

    Windows (PowerShell):  $env:TTS_STUDIO_KEY = "${secret}"
    macOS or Linux:        export TTS_STUDIO_KEY="${secret}"

Site: ${site ?? "(not set yet)"}
${site ? `The guide for AI agents is also online at ${site}/llms.txt\n` : ""}`,
);

console.log(`
${created ? `New key for "${name}", added to ${LIST}.` : `"${name}" already has a key; kept it.`}

Send this folder (zip it):  ${out}${site ? "" : `

  Note: the guide still says ${PLACEHOLDER}. Once the site is deployed, run
  npm run api-key -- ${name} --site https://your-site   to fill in the address.`}
${created ? `
Then put the updated list on the server:  npm run api-keys:push
` : ""}`);

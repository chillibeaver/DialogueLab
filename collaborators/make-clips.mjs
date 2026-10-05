// make-clips.mjs — usage: TTS_STUDIO_KEY=… node make-clips.mjs items.json > audio-map.json
import { readFile } from "node:fs/promises";

const API = "https://tts.example.com/api/v1/clips";
const key = process.env.TTS_STUDIO_KEY;
if (!key) throw new Error("Set TTS_STUDIO_KEY to the API key.");

const { items, ...shared } = JSON.parse(await readFile(process.argv[2], "utf8"));
if (items.some((item) => !item.ref)) throw new Error("Every item needs a ref.");
const urls = {};
let left = items;

// Rounds in a row that made nothing ready, waits included: a long list goes on as long as it moves.
let idle = 0;
while (left.length) {
  if (idle >= 20) throw new Error(`${left.length} clips are still pending.`);
  const response = await fetch(API, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ ...shared, items: left.slice(0, 100) }),
  });
  const body = await response.json();

  if (response.status === 429 && body.error.code === "rate_limited") {
    const seconds = Number(response.headers.get("retry-after")) || 60;
    console.error(`Rate limited; waiting ${seconds} s…`);
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    idle++;
    continue;
  }
  if (!response.ok) throw new Error(`${body.error.code}: ${body.error.message}`);

  for (const item of body.items) {
    if (item.status === "failed") throw new Error(`${item.ref}: ${item.error.code}: ${item.error.message}`);
    if (item.status === "ready") urls[item.ref] = item.url;
  }
  // Send again only what is not ready yet.
  const before = left.length;
  left = left.filter((item) => !(item.ref in urls));
  idle = left.length < before ? 0 : idle + 1;
  console.error(`${items.length - left.length} of ${items.length} ready`);
}

console.log(JSON.stringify(urls, null, 2));

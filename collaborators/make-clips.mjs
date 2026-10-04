// make-clips.mjs — usage: TTS_STUDIO_KEY=… node make-clips.mjs items.json > audio-map.json
import { readFile } from "node:fs/promises";

const API = "https://tts.example.com/api/v1/clips";
const key = process.env.TTS_STUDIO_KEY;
if (!key) throw new Error("Set TTS_STUDIO_KEY to the API key.");

const { items, ...shared } = JSON.parse(await readFile(process.argv[2], "utf8"));
if (items.some((item) => !item.ref)) throw new Error("Every item needs a ref.");
const urls = {};
let left = items;

for (let round = 1; left.length; round++) {
  if (round > 60) throw new Error(`${left.length} clips are still pending.`);
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
    continue;
  }
  if (!response.ok) throw new Error(`${body.error.code}: ${body.error.message}`);

  for (const item of body.items) {
    if (item.status === "failed") throw new Error(`${item.ref}: ${item.error.code}: ${item.error.message}`);
    if (item.status === "ready") urls[item.ref] = item.url;
  }
  // Send again only what is not ready yet.
  left = left.filter((item) => !(item.ref in urls));
  console.error(`${items.length - left.length} of ${items.length} ready`);
}

console.log(JSON.stringify(urls, null, 2));

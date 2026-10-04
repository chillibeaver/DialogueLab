# DialogueLab clips API: instructions for AI agents

You are building HTML listening exercises (or any page that plays spoken
sentences). DialogueLab turns text into natural speech with Google Cloud voices
and gives you a **permanent URL for each sentence**. Your page plays those URLs.

This document is everything you need. Base URL: `https://tts.example.com`.

## The rule that matters

**Make the audio once, while building the exercise. The page only plays URLs.**

1. Collect every sentence the exercise needs.
2. Send them all to `POST /api/v1/clips` with the API key. Repeat until the
   response says `"complete": true`.
3. Write the returned URLs into the page.

Then:

- **Never put the API key in the page**, in its JavaScript, or in any file you
  hand over. Students can read page source. Read the key from the environment
  variable `TTS_STUDIO_KEY` at build time. If it is not set, ask the human for it.
- **Never call `POST /api/v1/clips` from the page itself.** Playback never needs
  the key or the POST endpoint.
- **Do not generate audio "on click".** The URLs are permanent: the same text,
  voice, language and speed always give the same URL, and playing it costs
  nothing. Browsers cache each clip for a year.
- **Send sentences in bulk**, up to 100 per request, not one request per
  sentence.

## Authentication

```http
Authorization: Bearer <TTS_STUDIO_KEY>
```

Only `POST /api/v1/clips` needs it. Clip URLs are public.

Keys are issued by whoever runs this DialogueLab site, one per collaborator. If
`TTS_STUDIO_KEY` is not set, ask the human to get one from them. Never invent a
key, and never write one into a file you deliver.

## Making clips

`POST https://tts.example.com/api/v1/clips` with a JSON body:

```json
{
  "language": "fr-FR",
  "items": [
    { "ref": "ex1-q1", "text": "Bonjour, je m'appelle Claire.", "voice": "Kore" },
    { "ref": "ex1-q2", "text": "Où se trouve la gare, s'il vous plaît ?" },
    {
      "ref": "ex2-dialogue",
      "turns": [
        { "voice": "Charon", "text": "Bonjour madame, qu'est-ce que je vous sers ?" },
        { "voice": "Kore", "text": "Un café crème, s'il vous plaît." }
      ]
    }
  ]
}
```

### Request fields

| Field | Required | Meaning |
| --- | --- | --- |
| `items` | yes | 1 to 100 clips to make. |
| `language` | no | BCP-47 code, default `fr-FR`. Applies to every item. |
| `engine` | no | `chirp3-hd` (default) or `gemini`. |
| `model` | no | Gemini model, with `"engine": "gemini"` only. |
| `voice` | no | Default voice for items that do not name one. Default `Charon`. |

Each **item** has either `text` or `turns`, not both:

| Field | Meaning |
| --- | --- |
| `ref` | Your own label, up to 200 characters, returned unchanged. Use it to match results to questions. |
| `text` | One sentence or paragraph, up to 5,000 characters, read by one voice. |
| `turns` | A dialogue joined into **one** clip, in order, up to 100 turns. Each turn is `{ "text", "voice" }`. |
| `voice` | Voice for this item, or default for its turns. |
| `speakingRate` | 0.25 to 2, Chirp 3: HD only. Prefer the default; a different speed is a different clip. |
| `prompt` | Delivery in plain words, Gemini only, for example `"calm, slow"`. |

Use `turns` when the learner should hear a whole conversation as one track.
Use separate `text` items when each line needs its own play button.

The whole request may hold at most 20,000 characters. Split larger sets into
several requests.

### Response

```json
{
  "complete": true,
  "pending": 0,
  "failed": 0,
  "characters": 137,
  "synthesized": 137,
  "quota": { "used": 137, "limit": 200000 },
  "items": [
    {
      "ref": "ex1-q1",
      "id": "16eedb01e42ae4d3d4da6b2255f3143c",
      "status": "ready",
      "url": "https://tts.example.com/api/v1/clips/16eedb01e42ae4d3d4da6b2255f3143c.mp3",
      "created": true,
      "characters": 29
    }
  ]
}
```

- `status` is `ready` (has a `url`), `pending` (not made yet: send the same
  request again) or `failed` (has an `error`; send the same request again later).
- `created: false` means the clip already existed and nothing was billed.
- `synthesized` is the number of characters billed by this call.
- Each request does only as much as the server allows per request: on
  Cloudflare's free plan, roughly 10 new clips, or about 30 that already exist.
  The rest come back `pending`. **Send again only the items that are not
  ready**, until none are left; the build scripts below do this. Do not resend
  items that are already ready: checking them again uses up the next request's
  allowance, and a large set would stop making progress.

## Playing clips in the page

A clip URL is a normal MP3 with open CORS. The simplest page code:

```html
<button type="button" data-audio="https://tts.example.com/api/v1/clips/16eedb01e42ae4d3d4da6b2255f3143c.mp3">▶ Écouter</button>

<script>
  // One player for the whole page: starting a clip stops the one playing.
  const player = new Audio();
  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-audio]");
    if (!button) return;
    if (player.src === button.dataset.audio && !player.paused) {
      player.pause();
      return;
    }
    player.src = button.dataset.audio;
    player.play();
  });
</script>
```

`<audio controls src="…"></audio>` works too, when a visible player is wanted.

### Offline instead

If the exercise must work without internet, download each URL once and ship the
MP3 files next to the HTML, referencing them by relative path:

```sh
curl -s -o audio/ex1-q1.mp3 "https://tts.example.com/api/v1/clips/16eedb01e42ae4d3d4da6b2255f3143c.mp3"
```

## Converting a page that uses the browser's speech

Many exercise pages speak with the browser (`speechSynthesis`), passing the
sentence itself to a function such as `parler(texte)`. Convert them like this:

1. **Collect every string the page can speak** from its data: each sentence,
   each worked example, each line of each document.
2. **Use the text itself as the `ref`**, exactly as the page's data holds it. The build script then returns a map
   from sentence to URL, which is exactly what the page looks things up by.
   When one page has several voices, use `"Voice|text"` as the `ref` instead
   (for example `"Kore|Bonjour !"`), so that the same words in two voices do
   not collide.
3. **Look clips up by the same string you sent**, never by the text as
   displayed. Pages often reformat text for display (a non-breaking space
   before `?` and `!`, curly apostrophes); a key taken from the displayed text
   will not match. Keep the raw string next to whatever displays it.
4. **Write the map into the page** and replace the speech call:

```js
// Written by the build step: every sentence the page can say, and its clip.
const AUDIO = {
  "Tu attends le bus ?": "https://tts.example.com/api/v1/clips/….mp3",
  // …
};

const player = new Audio();

/**
 * Plays one clip and resolves when it ends, so clips can be chained. The speed
 * is set on every call: changing `src` resets it, so a speed left over from a
 * slow replay would otherwise carry into the next clip.
 */
function jouer(url, vitesse = 1) {
  return new Promise((resolve) => {
    player.src = url;
    // Slow playback is free: the same clip, played slower, at the same pitch.
    player.defaultPlaybackRate = player.playbackRate = vitesse;
    player.onended = resolve;
    player.play();
  });
}

function parler(texte, lent) {
  const url = AUDIO[texte];
  if (!url) return console.warn("No clip for:", texte);
  jouer(url, lent ? 0.75 : 1);
}
```

5. **Remove the browser voice picker.** Voices are chosen at build time, so
   it no longer does anything. Offering a choice would mean making every clip
   once per voice, multiplying the cost.

### Slow versions

**Never request a second, slower clip.** Play the normal clip with
`playbackRate` (0.75 is a good "slow"). Browsers keep the pitch, it costs
nothing, and the learner hears the same recording at both speeds.

### Documents: several speakers, replayable sentences

A listening document with speakers (for example `{ s: 0, t: "…" }` turns) that
is played whole, and whose sentences can then be clicked to hear again:

- **Make one clip per piece the page can play on its own**, in that piece's
  speaker's voice. If the page splits each turn into sentences for clicking,
  make clips for exactly those sentences, splitting them **with the page's own
  function** at build time so that the refs match what the page looks up.
- **Play the whole document by chaining those clips**, with a short silence
  between turns:

```js
async function jouerDocument(morceaux) { // [{ voix, texte }, …] in order
  for (const { voix, texte } of morceaux) {
    await jouer(AUDIO[`${voix}|${texte}`]);
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}
```

Do not also make the whole document as one `turns` clip: that pays for the same
words twice. Use `turns` only when the document is never broken into
sentences.

Give each speaker a fixed voice for the whole page, and a different gender
where possible, so learners can tell them apart.

### Language

Content set in Quebec or Canada can use `fr-CA` voices instead of `fr-FR`;
ask the human which accent the course wants. A clip in one is a different clip
from the other.

### What it costs

Characters are billed once per distinct clip, at about US$30 per million on
Chirp 3: HD. Count the characters of the unique strings you send. For scale: a
week of daily exercises with about 45 sentences and two short documents a day
is roughly 10,000 to 15,000 characters, about US$0.30 to 0.45, paid once. After
that, every play is free.

## A complete build script

Node 18 or later, no dependencies. Input: a JSON file in the request format
above, with any number of items, each with its own `ref`. If you received this
guide in a folder, both scripts are there as files: `make-clips.mjs` and
`make_clips.py`. Output: a JSON map
from `ref` to URL. Progress goes to the terminal; the map goes to the file.

If you cannot make HTTP requests yourself (in a chat without tools, for
example), write the items file and this script, ask the human to run it, and use
the map it produces.

```js
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
```

Python 3, standard library only:

```python
# make_clips.py — usage: TTS_STUDIO_KEY=… python make_clips.py items.json > audio-map.json
import json, os, sys, time, urllib.error, urllib.request

API = "https://tts.example.com/api/v1/clips"
key = os.environ["TTS_STUDIO_KEY"]
request = json.load(open(sys.argv[1], encoding="utf-8"))
items = request.pop("items")
if any("ref" not in item for item in items):
    sys.exit("Every item needs a ref.")
urls = {}
left = items

def call(batch):
    body = json.dumps({**request, "items": batch}).encode()
    req = urllib.request.Request(API, data=body, method="POST", headers={
        "authorization": f"Bearer {key}", "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req) as response:
            return 200, json.load(response), response.headers
    except urllib.error.HTTPError as error:
        return error.code, json.load(error), error.headers

for round in range(1, 61):
    if not left:
        break
    status, body, headers = call(left[:100])
    if status == 429 and body["error"]["code"] == "rate_limited":
        seconds = int(headers.get("retry-after") or 60)
        print(f"Rate limited; waiting {seconds} s…", file=sys.stderr)
        time.sleep(seconds)
        continue
    if status != 200:
        sys.exit(f'{body["error"]["code"]}: {body["error"]["message"]}')
    for item in body["items"]:
        if item["status"] == "failed":
            sys.exit(f'{item["ref"]}: {item["error"]["code"]}: {item["error"]["message"]}')
        if item["status"] == "ready":
            urls[item["ref"]] = item["url"]
    # Send again only what is not ready yet.
    left = [item for item in left if item["ref"] not in urls]
    print(f"{len(items) - len(left)} of {len(items)} ready", file=sys.stderr)
else:
    sys.exit(f"{len(left)} clips are still pending.")

print(json.dumps(urls, indent=2, ensure_ascii=False))
```

A large set takes several requests and, past ten a minute, a pause for the rate
limit: a few minutes for a few hundred new sentences. That happens once; later
runs find the clips already made.

## Voices

Every voice speaks every supported language.

| Female | Male |
| --- | --- |
| Achernar, Aoede, Autonoe, Callirrhoe, Despina, Erinome, Gacrux, Kore, Laomedeia, Leda, Pulcherrima, Sulafat, Vindemiatrix, Zephyr | Achird, Algenib, Algieba, Alnilam, Charon, Enceladus, Fenrir, Iapetus, Orus, Puck, Rasalgethi, Sadachbia, Sadaltager, Schedar, Umbriel, Zubenelgenubi |

Give different speakers in a dialogue clearly different voices, for example
`Charon` and `Kore`. Keep one voice per character across an exercise.

Languages include `fr-FR`, `fr-CA`, `en-US`, `en-GB`, `es-ES`, `de-DE`,
`it-IT`, `pt-BR`, `ja-JP` and `ko-KR`. The full list, per engine, is at
`GET https://tts.example.com/api/catalog` (no key needed).

## In the text

- Text is read exactly as written. A changed comma is a new clip.
- **Write abbreviations out in full**: `Madame`, not `Mme`; `quelque chose`,
  not `qch`; `Monsieur Dubois`, not `M. Dubois`. Nothing expands them here, and
  a voice may spell them letter by letter.
- `[1.5]` is **not** a pause in this API; it would be read aloud. To separate
  sentences, use punctuation, or make separate clips.
- With `"engine": "gemini"` only, markup such as `[sigh]` or `[whispering]`
  changes the delivery. Chirp 3: HD reads it aloud.

## Errors

Errors are JSON: `{ "error": { "code": "…", "message": "…" } }`.

| HTTP | `code` | What to do |
| --- | --- | --- |
| 400 | `invalid_request`, `invalid_json`, `unknown_voice`, `unsupported_language` | Fix the request; the message names the item. |
| 401 | `unauthorized` | The key is missing or wrong. Ask the human. |
| 413 | `text_too_long`, `payload_too_large` | Split the text or the request. |
| item `failed` | `too_many_parts` | A dialogue too long for one request. Split it into shorter `turns` items. |
| 429 | `rate_limited` | Wait `Retry-After` seconds, then repeat the request. |
| 429 | `quota_exceeded` | **Stop.** The key's daily character budget is spent; `details.resetsAt` says when it renews. Tell the human. |
| 429 | `budget_exhausted` | **Stop.** The site's monthly budget for new audio is spent; `details.resetsAt` says when it renews. Clips already made keep working. Tell the human. |
| 502, 503 | `upstream_*`, `engine_unavailable`, `clips_unavailable`, `budget_unavailable` | A service problem. Retry later, or tell the human. |

## Checklist

- [ ] The key comes from `TTS_STUDIO_KEY` and appears in no delivered file.
- [ ] All sentences went out in bulk; only items not yet ready were sent again.
- [ ] The page looks clips up by the raw strings that were sent, not the displayed text.
- [ ] Every item has a `ref`, and the page uses the URLs those refs map to.
- [ ] The page only plays URLs; it never calls `POST`.
- [ ] Dialogue characters keep the same voice throughout.

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
| `turns` | A dialogue as **one** clip, in order, up to 100 turns. Each turn is `{ "text", "voice" }`. With `"engine": "gemini"`, exactly two voices and up to 3,800 bytes in all, it is spoken in one go, as a conversation; otherwise each turn is made on its own and joined. |
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

### Pages that only play their own audio

Some places refuse media from other sites, with no error shown: **pages
published by Claude** are one, and every play button there stays silent while
the page links to this site. The same holds for a page that must work offline.
The audio then has to travel with the page.

**If the human runs the build script for you** (you cannot reach this site
yourself), have it pack the audio too: `python make_clips.py items.json --pack`
also writes `audio-pack.zip`, every clip as `audio/<id>.mp3` plus
`audio-map.json` from each ref to its file. Ask the human to upload that one
zip, then build the page from its files: publish them with the page, referenced
by relative path, or embed them as `data:audio/mpeg;base64,` URIs. For someone
who does not use a terminal, write a script they can double-click instead, with
the key inside it (they keep it private), a pause before the window closes, and
the same packing.

**If you can reach this site**, build the page with clip URLs as usual, then
put the audio inside it with `bundle_audio.py` (in the folder beside this
guide, Python 3.8 or later):

```sh
python bundle_audio.py exercise.html           # exercise.bundled.html, one file with the audio inside
python bundle_audio.py exercise.html --files   # exercise-bundle/: index.html and audio/<id>.mp3
```

Publish `exercise.bundled.html` instead of the page. It holds every clip, so it
grows by 10 to 30 KB per sentence, by its length; Claude's pages take at most
16 MB, so give a very long exercise several pages, or use `--files` and publish
`index.html` together with the `audio` folder. The script finds every clip URL in the page, also in
JSON with escaped slashes, and leaves the original page as it was.

Without the script: download each URL once, ship the MP3 files next to the
HTML, and reference them by relative path:

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

Chained clips are each spoken on their own, which sounds slower and stiffer
than people talking. For a two-person dialogue, Gemini can do better: a
`turns` item with `"engine": "gemini"` and two voices is spoken in one go, each
line with the whole conversation in mind. Play that clip when the whole
dialogue is played, and the sentence clips only when one sentence is clicked.
It pays for the dialogue's words a second time, which is usually worth it.

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
A long list takes many rounds and some waits; the script keeps going as long
as rounds make progress, and gives up only after 20 in a row that make none.

If you cannot make HTTP requests yourself (in a chat without tools, for
example), write the items file and this script, ask the human to run it, and use
the map it produces. If the page will be published by Claude, ask for `--pack`
and the zip it makes (see "Pages that only play their own audio").

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
```

Python 3, standard library only:

```python
# make_clips.py — usage: TTS_STUDIO_KEY=… python make_clips.py items.json [--pack] > audio-map.json
# --pack also downloads every clip into audio-pack.zip, for pages that only play their own files.
import json, os, sys, time, urllib.error, urllib.request, zipfile

API = "https://tts.example.com/api/v1/clips"
key = os.environ["TTS_STUDIO_KEY"]
pack = "--pack" in sys.argv
request = json.load(open([a for a in sys.argv[1:] if a != "--pack"][0], encoding="utf-8"))
items = request.pop("items")
if any("ref" not in item for item in items):
    sys.exit("Every item needs a ref.")
urls = {}
left = items

def call(batch):
    body = json.dumps({**request, "items": batch}).encode()
    # Cloudflare refuses Python's own User-Agent (error 1010), so send another.
    req = urllib.request.Request(API, data=body, method="POST", headers={
        "authorization": f"Bearer {key}", "content-type": "application/json",
        "user-agent": "dialoguelab-clips/1.0"})
    try:
        with urllib.request.urlopen(req) as response:
            return 200, json.load(response), response.headers
    except urllib.error.HTTPError as error:
        return error.code, json.load(error), error.headers

# Rounds in a row that made nothing ready, waits included: a long list goes on as long as it moves.
idle = 0
while left:
    if idle >= 20:
        sys.exit(f"{len(left)} clips are still pending.")
    status, body, headers = call(left[:100])
    if status == 429 and body["error"]["code"] == "rate_limited":
        seconds = int(headers.get("retry-after") or 60)
        print(f"Rate limited; waiting {seconds} s…", file=sys.stderr)
        time.sleep(seconds)
        idle += 1
        continue
    if status != 200:
        sys.exit(f'{body["error"]["code"]}: {body["error"]["message"]}')
    for item in body["items"]:
        if item["status"] == "failed":
            sys.exit(f'{item["ref"]}: {item["error"]["code"]}: {item["error"]["message"]}')
        if item["status"] == "ready":
            urls[item["ref"]] = item["url"]
    # Send again only what is not ready yet.
    before = len(left)
    left = [item for item in left if item["ref"] not in urls]
    idle = 0 if len(left) < before else idle + 1
    print(f"{len(items) - len(left)} of {len(items)} ready", file=sys.stderr)

if pack:
    # Every clip, and audio-map.json from each ref to its file, in one zip to hand over.
    files = {url: "audio/" + url.rsplit("/", 1)[1] for url in urls.values()}
    with zipfile.ZipFile("audio-pack.zip", "w") as z:
        for url, name in files.items():
            with urllib.request.urlopen(urllib.request.Request(url, headers={"user-agent": "dialoguelab-clips/1.0"})) as response:
                z.writestr(name, response.read())
        z.writestr("audio-map.json", json.dumps({ref: files[url] for ref, url in urls.items()}, indent=2, ensure_ascii=False))
    print(f"audio-pack.zip: {len(files)} clips", file=sys.stderr)

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
- [ ] A page published by Claude, or meant to work offline, was bundled with `bundle_audio.py`, and that is the file published.

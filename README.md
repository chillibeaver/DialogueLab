# TTS Studio

French-first text-to-speech web tool backed by Google Cloud Text-to-Speech, running entirely on a single Cloudflare Worker.

- **Voices:** [Chirp 3: HD](https://docs.cloud.google.com/text-to-speech/docs/chirp3-hd) (default) and, when a service account is configured, [Gemini-TTS](https://docs.cloud.google.com/text-to-speech/docs/gemini-tts) (style prompts such as *"read slowly, like a storyteller"*, and two-speaker dialogue).
- **Language:** French (`fr-FR`) by default; ~50 languages on Chirp 3: HD and ~90 on Gemini-TTS.
- **No sign-up:** anyone can use it. Google credentials stay on the server, and abuse is limited by Turnstile, per-IP rate limits, a length cap and a response cache.

## Stack

| Layer | Choice |
| --- | --- |
| Runtime | Cloudflare Workers |
| API | [Hono](https://hono.dev) under `/api/*` (`server/`) |
| Pages | [React Router v8](https://reactrouter.com) framework mode with SSR (`app/`) |
| Build | Vite + `@cloudflare/vite-plugin` |
| Styles | Tailwind CSS; every component is hand-written, no UI or component library |
| Tests | Vitest (`test/`) |

`workers/app.ts` is the Worker entry: requests to `/api/*` go to Hono, and everything else is server-rendered by React Router.

## The reader

One page at `/`: a dialogue reader for language practice, not a one-shot text
box. You write a scene, give each character a voice, and play it back line by
line.

- **Cast** — any number of speakers, each with a name, a colour, a catalog
  voice and, on Gemini, a direction such as *"anxious, speaking quickly"*.
  A speaker can be set to skip, which leaves them out of playback.
- **Script** — a line editor. `Enter` starts the next line with the other
  speaker, so typing a dialogue is uninterrupted. Write `[1.5]` or
  `[pause 2]` inside a line for real silence at that point.
- **Plain text** — the script as text in the TTS Studio format, editable, with
  every problem listed by line.
- **Playback** — repeat each line, leave a gap, or leave a shadowing pause
  proportional to the line so you can say it back. Loop, per-speaker speed and
  volume, and a dictation mode that blurs the text until you reveal each line.
- **Dictionary** — spelling to pronunciation, applied before synthesis only, so
  the text on screen never changes.
- **Translations** — each line can carry a translation, shown under it and
  never read aloud.
- **Library** — several scripts in the browser. Import listening material, and
  export a script or the whole library as text, a JSON backup, or **audio**
  (every line joined into one MP3).

### Listening material

Material is written in the **TTS Studio format**, a plain-text format for
dialogues, monologues and single sentences with optional translations. The
specification, with a prompt for converting existing material with a chat
model, is [docs/listening-format.md](docs/listening-format.md); a working
sample is [docs/examples/listening-pack.txt](docs/examples/listening-pack.txt).
**Library → Import scripts…** checks a file line by line before importing it,
and items carrying an `@id` replace their earlier version on re-import.

The page is server-rendered: the sample scene, the cast, the 30 voices and
every language are in the first HTML response, from the same `buildCatalog()`
the API serves. The browser's saved library replaces the sample only after
hydration, so the first client render still matches the server's HTML.

Speed and volume are applied to the audio element rather than sent to Google,
so changing them is instant, free, and leaves every clip cache-identical.
Google returns no word timings, so the highlight follows whole segments rather
than individual words.

`/robots.txt` and `/sitemap.xml` are generated from the request host, so they
are correct on whatever domain the Worker is deployed to.

## API

### Clips: audio for other sites

`POST /api/v1/clips` and `GET /api/v1/clips/<id>.mp3` give pages built
elsewhere, such as a course's HTML exercises, permanent audio URLs. The full
guide, written for the AI agents that build those pages, is
[docs/clips-api.md](docs/clips-api.md); a deployment serves it at `/llms.txt`
with its own address filled in.

- **Made once, with a key.** `POST /api/v1/clips` takes up to 100 sentences or
  whole dialogues (`turns`, joined into one clip) and returns a URL for each. It
  needs `Authorization: Bearer <key>` and no Turnstile, since a page on another
  site could never pass a Turnstile check bound to this one.
- **Played forever, without one.** `GET /api/v1/clips/<id>.mp3` is public, has
  open CORS, supports byte ranges (Safari needs them to play audio), is cached
  by browsers for a year, and **never calls Google**. The key therefore never
  has to appear in a page, and replaying costs nothing.
- **Same input, same URL.** A clip's id hashes everything that shapes its
  sound, so asking again is free (`created: false`). A line the reader already
  synthesized is reused from the KV cache.
- **Bounded.** One request makes at most 40 new clips, within the Workers
  subrequest limit; the rest return `pending` and are finished by repeating the
  request. Each key has a daily character budget (`API_DAILY_CHARS`) and its
  own rate limit.

Clips live in R2 without expiry. Unlike the 30-day synthesis cache, a published
exercise must keep working.

### `GET /api/health`

`{ "ok": true }`

### `GET /api/catalog`

Everything a client needs to build its controls: defaults, limits, output formats, the 30 voices, and the languages and models for each engine. The default language is listed first. The data is static, so this endpoint costs nothing and is cacheable.

### `POST /api/tts/batch`

Synthesizes many short lines in one call. A reader plays a script line by line;
one request per line would exhaust the per-IP rate limit within seconds, so the
whole script is **one request and one rate-limit unit**.

```jsonc
{
  "engine": "chirp3-hd",      // shared by every item
  "language": "fr-FR",
  "format": "mp3",
  "items": [
    { "text": "Bonjour madame.", "voice": "Charon" },
    { "text": "Un cafe, merci.", "voice": "Kore" }
  ]
}
```

Each item may carry `voice`, and `prompt` (Gemini) or `speakingRate` (Chirp).
At most 300 items and 20,000 characters per request; a client splits longer
scripts itself, guided by `limits.batch` in the catalog.

The response is JSON, with base64 audio per item:

```jsonc
{
  "format": "mp3",
  "contentType": "audio/mpeg",
  "characters": 30,
  "synthesized": 1,           // how many actually reached Google
  "items": [
    { "audio": "<base64>", "characters": 15, "cache": "HIT" },
    { "audio": "<base64>", "characters": 15, "cache": "MISS" }
  ]
}
```

Every line is cached on its own, so **editing one line only re-bills that
line**.

### `POST /api/tts`

Request headers:

- `Content-Type: application/json`
- `X-Turnstile-Token: <token>`: required in production. Tokens are single-use, so reset the widget after every request.

Body (only `text` is required):

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `text` | string | — | Up to `MAX_CHARS` characters (default 5,000). Longer text is split at sentence boundaries and the audio is joined. |
| `engine` | `"chirp3-hd"` \| `"gemini"` | `chirp3-hd` | |
| `language` | string | `fr-FR` | Must be supported by the engine (see catalog). Case-insensitive. |
| `voice` | string | `Charon` (Chirp), `Kore` (Gemini) | One of the 30 catalog voices. Case-insensitive. |
| `format` | `"mp3"` \| `"wav"` \| `"ogg_opus"` | `mp3` | `ogg_opus` only for text that fits in a single chunk (~4.5 KB). |
| `speakingRate` | number 0.25–2 | 1 | Chirp 3: HD only. |
| `model` | string | `gemini-2.5-flash-tts` | Gemini only. Also `gemini-2.5-pro-tts`, `gemini-3.1-flash-tts-preview`, `gemini-2.5-flash-lite-preview-tts`. |
| `prompt` | string ≤ 1,000 chars | — | Gemini only. A natural-language style instruction. |
| `speakers` | array of 2 | — | Gemini only. Dialogue mode; replaces `text`. See below. |
| `turns` | array | — | Gemini only. Dialogue mode; replaces `text`. See below. |

Unknown fields are rejected, so a typo like `speed` returns an error instead of being silently ignored.

#### Dialogue (two speakers)

Send `speakers` and `turns` instead of `text`. Gemini-TTS only.

```jsonc
{
  "engine": "gemini",
  "prompt": "A relaxed conversation between two friends in a cafe.",
  "speakers": [
    { "alias": "Marie", "voice": "Kore" },
    { "alias": "Paul",  "voice": "Charon" }
  ],
  "turns": [
    { "speaker": "Marie", "text": "Bonjour Paul !" },
    { "speaker": "Paul",  "text": "Salut Marie." }
  ]
}
```

- **Exactly two speakers.** Three or more is rejected by Google with
  *"Multi-speaker synthesis requires two distinct speakers"*.
- Aliases must be alphanumeric with no spaces, must be unique, and every
  `turns[].speaker` must name one of them.
- `voice` is not used: each speaker carries its own.
- A dialogue is **one** Google request and is never split, because splitting it
  would break speaker continuity. The combined turn text is therefore capped at
  3,800 bytes (Google's limit is 4,000) and longer input returns `413`.

On success, the response body is the audio (`audio/mpeg`, `audio/wav` or `audio/ogg`), with these headers:

- `X-Cache: HIT | MISS`: whether Google was called.
- `X-TTS-Characters`: number of characters synthesized.
- `X-TTS-Chunks`: number of Google requests the text was split into.

Errors are returned as JSON: `{ "error": { "code": "...", "message": "..." } }`.

| Status | `code` | Meaning |
| --- | --- | --- |
| 400 | `invalid_request`, `invalid_json`, `unsupported_language`, `unknown_voice` | Fix the request. |
| 401 | `unauthorized` | Clips API: missing or wrong API key. |
| 403 | `turnstile_required`, `turnstile_failed` | Get a fresh Turnstile token. |
| 413 | `text_too_long`, `text_too_long_for_format`, `payload_too_large` | Shorten the text or use `mp3`/`wav`. |
| 422 | `synthesis_rejected` | Google refused the input. The message comes from Google, e.g. a sentence that is too long. |
| 429 | `rate_limited` | Per-IP (or per-key) limit hit. Respect `Retry-After`. |
| 429 | `quota_exceeded` | Clips API: the key's daily characters are spent; `details.resetsAt` says when they renew. |
| 500 | `server_misconfigured` | A secret is missing or invalid. Check the Worker logs. |
| 503 | `engine_unavailable` | The requested engine has no usable credential on this server (Gemini-TTS without a service account). |
| 502 / 503 | `upstream_*` | Google failed, rejected the credentials, or ran out of quota. |

Example:

```sh
curl -X POST http://localhost:5173/api/tts \
  -H 'content-type: application/json' \
  -d '{"text":"Bonjour ! Comment allez-vous ?"}' \
  -o bonjour.mp3
```

## Setup

### 1. Google Cloud

Create or choose a project and link a billing account, then enable the
**Cloud Text-to-Speech API**.

Which credential you need depends on which engines you want. This was
established by testing against Google, not guessed:

| Engine | Credential | Why |
| --- | --- | --- |
| Chirp 3: HD | **API key** (`GOOGLE_TTS_API_KEY`) | An ordinary Cloud TTS call. The key identifying the project is enough. |
| Gemini-TTS | **Service account** (`GOOGLE_SERVICE_ACCOUNT_JSON`) | The request goes to the same endpoint, but Google routes it to Vertex AI and checks `aiplatform.endpoints.predict`. An API key only identifies a project, so it cannot hold that role: Google answers *"API keys are not supported by this API. Expected OAuth2 access token or other authentication credentials that assert a principal."* |

**API key** (Chirp 3: HD): APIs & Services -> Credentials -> Create credentials
-> API key. Restrict it to the Cloud Text-to-Speech API.

**Service account** (adds Gemini-TTS): also enable the **Vertex AI API**
(`aiplatform.googleapis.com`, shown as *Agent Platform* in the console). Then
IAM & Admin -> Service Accounts -> create one, grant it **Vertex AI User**
(`roles/aiplatform.user`), and create a JSON key (Keys -> Add key -> JSON).

Without a service account, `POST /api/tts` with `"engine":"gemini"` returns
`503 engine_unavailable`; Chirp 3: HD keeps working.

**Cost guardrails (strongly recommended for a public tool):**

- Billing -> Budgets & alerts: create a budget with email alerts. Budgets
  *notify*; they do not stop spending.
- APIs & Services -> Cloud Text-to-Speech API -> Quotas: lower the per-minute
  request quotas to a level you are comfortable paying for. This is a hard cap.

### 2. Cloudflare

```sh
npx wrangler login

# Audio cache: create the namespace, then paste the printed id into wrangler.jsonc (kv_namespaces[0].id)
npx wrangler kv namespace create tts-studio-cache

# Turnstile: create a widget in the dashboard (Turnstile → Add widget, mode "Invisible" or "Managed")
# for your domain. The site key goes into the frontend; the secret key goes here:
npx wrangler secret put TURNSTILE_SECRET_KEY

# Google credentials: the API key covers Chirp 3: HD
npx wrangler secret put GOOGLE_TTS_API_KEY

# Only if you want Gemini-TTS: paste the whole JSON key file content
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON

# Clips API: storage for published clips, and one key per collaborator.
# Generate each key with e.g. `openssl rand -hex 24`, then enter
# "name:key,name2:key2" when prompted. Remove an entry to revoke that person.
npx wrangler r2 bucket create tts-studio-clips
npx wrangler secret put API_KEYS

npm run deploy
```

Without `TURNSTILE_SECRET_KEY`, `/api/tts` refuses every request (it fails closed) unless `TURNSTILE_DISABLED=true` is set. That flag is for local development only.

### 3. Configuration (`wrangler.jsonc` → `vars`)

| Var | Default | Purpose |
| --- | --- | --- |
| `DEFAULT_ENGINE` | `chirp3-hd` | Engine used when the request omits `engine`. |
| `DEFAULT_LANGUAGE` | `fr-FR` | Language used when the request omits `language`; listed first in the catalog. |
| `MAX_CHARS` | `5000` | Maximum characters per request. |
| `GOOGLE_TTS_ENDPOINT` | `https://texttospeech.googleapis.com` | Regional endpoint. See the caveat below before changing it. |
| `CACHE_TTL_SECONDS` | `2592000` (30 days) | How long synthesized audio stays in KV. |
| `TURNSTILE_SITE_KEY` | — | Public Turnstile key. Sent to the browser; leave unset to skip the widget. |
| `API_DAILY_CHARS` | `200000` | Characters each clips API key may send to Google per UTC day (about US$6 on Chirp 3: HD). |

A regional endpoint such as `https://eu-texttospeech.googleapis.com` keeps
processing in that region, but regions do not carry every model: only the
default global endpoint serves `gemini-3.1-flash-tts-preview`, and
`northamerica-northeast1` serves neither that nor `gemini-2.5-pro-tts`. The two
settings are validated independently, so an unsupported pairing fails at Google
rather than at request validation. See
[Available regions](https://docs.cloud.google.com/text-to-speech/docs/gemini-tts#available-regions).

The rate limit (10 requests per 60 s per IP) is set under `ratelimits` in `wrangler.jsonc`. Cloudflare applies it per location and treats it as approximate, so it is a brake, not exact accounting.

## Development

```sh
npm install
cp .dev.vars.example .dev.vars   # then fill in GOOGLE_TTS_API_KEY
npm run dev                      # http://localhost:5173 (runs in workerd, with local KV and rate limiter)
npm test                         # unit + API tests (Google, Turnstile and KV are faked)
npm run typecheck
```

In `.dev.vars`, wrap the service account JSON in **single quotes** on one line. Double quotes make dotenv rewrite the `\n` escapes in the private key.

## Security and cost model

- Google credentials exist only as Worker secrets. The browser talks only to `/api/*` on this domain, and the Worker calls Google, so the key is never sent to the client.
- The real risk for a public tool is someone calling `/api/tts` directly to run up your bill. The layers against that are:
  1. Turnstile on every synthesis request (invisible to most humans, blocks scripts).
  2. A per-IP rate limit.
  3. A per-request character cap.
  4. A KV cache: identical requests (same text, voice, engine, options) are billed once.
  5. Google-side quota caps and budget alerts (see setup).
- Google errors that mention credentials or project details are logged on the server and replaced by generic messages in responses.

## Project layout

```
workers/app.ts         Worker entry: Hono /api + React Router SSR
server/api.ts          Routes
server/clips.ts        Clips API: authenticated creation, public permanent URLs
server/keys.ts         API keys (constant-time check)
server/request.ts      Request validation and defaults (zod), including dialogue rules
server/catalog.ts      Engines, voices, languages, models
server/config.ts       Bindings and vars
server/protection.ts   Rate limiting and Turnstile
server/google/auth.ts  Per-engine credential: API key, or service-account JWT → OAuth token (WebCrypto, cached)
server/google/tts.ts   Google request bodies and error mapping
server/lib/chunk.ts    Sentence-aware splitting by UTF-8 byte budget
server/lib/audio.ts    MP3/WAV concatenation
server/lib/cache.ts    KV audio cache
app/routes/home.tsx    The page: loader, layout, transport bar
app/reader/model.ts    Script and speaker model, browser storage
app/reader/player.ts   Playback: batching, prefetch, repeat, shadowing
app/reader/text.ts     Pause markers, dictionary, time estimates
app/reader/format.ts   The TTS Studio format: parse, check, write, merge
app/reader/import-dialog.tsx  Import with line-by-line checks and a preview
app/reader/*.tsx       Cast, playback, dictionary, library and script panels
app/context.ts         Worker bindings handed to loaders
test/                  Vitest suites
```

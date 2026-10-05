# DialogueLab

French-first text-to-speech web tool backed by Google Cloud Text-to-Speech, running entirely on a single Cloudflare Worker.

- **Voices:** [Chirp 3: HD](https://docs.cloud.google.com/text-to-speech/docs/chirp3-hd) (default) and, when a service account is configured, [Gemini-TTS](https://docs.cloud.google.com/text-to-speech/docs/gemini-tts) (style prompts such as *"read slowly, like a storyteller"*, and two-speaker dialogue).
- **Language:** French (`fr-FR`) by default; ~50 languages on Chirp 3: HD and ~90 on Gemini-TTS.
- **No sign-up:** anyone can use it. Google credentials stay on the server, and abuse is limited by Turnstile, per-IP rate limits, a length cap and a response cache.

## Stack

| Layer | Choice |
| --- | --- |
| Runtime | Cloudflare Workers |
| API | [Hono](https://hono.dev) under `/api/*` (`server/`) |
| Pages | [React Router v8](https://reactrouter.com) framework mode, home page prerendered at build time (`app/`) |
| Build | Vite + `@cloudflare/vite-plugin` |
| Styles | Tailwind CSS; every component is hand-written, no UI or component library |
| Tests | Vitest (`test/`) |

`workers/app.ts` is the Worker entry: requests to `/api/*` go to Hono, and everything else is server-rendered by React Router.

The home page is the same for every visitor, since each one's scripts load
from their own browser afterwards, so it is **prerendered at build time**
(`prerender` in `react-router.config.ts`). The build starts a local preview of
the Worker, renders `/` once, and writes `build/client/index.html`, which
Cloudflare then serves as a static file: a page view never runs the Worker,
costs no CPU time, and does not count against the Workers request quota. Only
the API, `robots.txt`, `sitemap.xml`, `llms.txt` and unknown paths reach it.

Two consequences:

- **The page holds the vars it was built with.** Change one in `wrangler.jsonc`
  and the next build picks it up; a local build also reads `.dev.vars`, so
  deploy from CI, where there is none.
- **Its canonical address comes from `SITE_URL`**, because the build renders it
  on localhost.

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
- **Plain text** — the script as text in the DialogueLab format, editable, with
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

Material is written in the **DialogueLab format**, a plain-text format for
dialogues, monologues and single sentences with optional translations. The
specification, with a prompt for converting existing material with a chat
model, is [collaborators/listening-format.md](collaborators/listening-format.md); a working
sample is [collaborators/listening-pack.txt](collaborators/listening-pack.txt).
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
[collaborators/clips-api.md](collaborators/clips-api.md); a deployment serves it at `/llms.txt`
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
  sound, so asking again is free (`created: false`). Clips do not read the
  reader's KV cache: an existence check in R2 is all a repeat costs, which
  keeps each request's subrequest budget for new clips.
- **Bounded.** Each request stays within a subrequest budget (see below); what
  does not fit comes back `pending`, and the client sends those items again.
  Each key has a daily character budget (`API_DAILY_CHARS`) and its own rate
  limit.

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

A request only does as much as the subrequest budget allows. Lines it did not
reach come back as `{ "status": "pending" }`, with `"complete": false`; send
those again. The reader does this on its own.

#### The subrequest budget

On Workers, every call to Google and **every KV or R2 operation** counts as a
subrequest, and the free plan allows 50 per request (10,000 on paid). A batch
line can cost three (cache read, synthesis, cache write), so an unbounded batch
fails on the free plan beyond about fifteen new lines. Both batch endpoints
therefore spend at most `SUBREQUEST_BUDGET` (default 40) per request: they work
in order, reserve the worst case per item, and let cache hits fund more items.
They always finish at least one item, so a client that resends the pending ones
cannot loop forever. On a paid plan, raise the budget and one request does
everything.

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

# Audio cache. --binding writes the new namespace's id into wrangler.jsonc.
npx wrangler kv namespace create tts-studio-cache --binding TTS_CACHE

# Storage for published clips. --binding matches the existing CLIPS binding;
# without it Wrangler offers to add a second one.
npx wrangler r2 bucket create tts-studio-clips --binding CLIPS

# First deploy: prints the site's address. Synthesis stays refused until the
# secrets below are set, since bot protection fails closed.
npm run deploy

# Turnstile: in the dashboard, Turnstile → Add widget, mode "Managed", for that
# hostname. The site key is public: set TURNSTILE_SITE_KEY in wrangler.jsonc
# vars. The secret key goes here:
npx wrangler secret put TURNSTILE_SECRET_KEY

# Google credentials: the API key covers Chirp 3: HD
npx wrangler secret put GOOGLE_TTS_API_KEY

# Only if you want Gemini-TTS: the whole JSON key file, piped in
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON < service-account.json

# Clips API: one key per collaborator (see "API keys" below).
npm run api-key -- teammate https://your-site
npm run api-keys:push

# Again, to publish TURNSTILE_SITE_KEY. Secrets carry over between deploys.
npm run deploy
```

The reader's Turnstile widget stays invisible unless Cloudflare wants the
visitor to tick a box; it then appears above the transport bar.

Without `TURNSTILE_SECRET_KEY`, `/api/tts` refuses every request (it fails closed) unless `TURNSTILE_DISABLED=true` is set. That flag is for local development only.

#### Deploying from GitHub instead

Workers Builds can deploy every push to `main`. In the dashboard, open the
Worker, then Settings → Build → Connect, and pick the repository:

| Setting | Value |
| --- | --- |
| Build command | `npm test && npm run build` |
| Deploy command | `npx wrangler deploy` (the default) |
| Builds for non-production branches | Off: a preview URL would fail the Turnstile hostname check anyway |

The Worker's name must match `name` in `wrangler.jsonc`. Secrets are not part
of the repository: set them in the dashboard (Settings → Variables and
Secrets) or with `wrangler secret put`, which changes only the secret and
keeps the deployed code. Plain `vars` come from `wrangler.jsonc` on every
deploy, so `TURNSTILE_SITE_KEY` must be committed there.

### 3. Configuration (`wrangler.jsonc` → `vars`)

| Var | Default | Purpose |
| --- | --- | --- |
| `DEFAULT_ENGINE` | `chirp3-hd` | Engine used when the request omits `engine`. |
| `DEFAULT_LANGUAGE` | `fr-FR` | Language used when the request omits `language`; listed first in the catalog. |
| `MAX_CHARS` | `5000` | Maximum characters per request. |
| `GOOGLE_TTS_ENDPOINT` | `https://texttospeech.googleapis.com` | Regional endpoint. See the caveat below before changing it. |
| `CACHE_TTL_SECONDS` | `2592000` (30 days) | How long synthesized audio stays in KV. |
| `TURNSTILE_SITE_KEY` | — | Public Turnstile key, sent to the browser. Required in production: without it the reader sends no token and is refused. Leave it unset locally, with `TURNSTILE_DISABLED=true`. |
| `API_DAILY_CHARS` | `200000` | Characters each clips API key may send to Google per UTC day (about US$6 on Chirp 3: HD). |
| `SUBREQUEST_BUDGET` | `40` | Google calls plus KV and R2 operations one request may make. The free plan allows 50; on a paid plan use e.g. `9000`. |
| `SITE_URL` | the request's origin | Canonical address, used for the home page's canonical link and `og:url` and for the sitemap. Set it: the home page is rendered at build time on localhost. |
| `MONTHLY_BUDGET_USD` | none (no cap) | Most the site may spend at Google per calendar month, in US dollars. Needs the `BUDGET` Durable Object binding; without it, synthesis is refused. See "Security and cost model". |
| `CHIRP_FREE_CHARS` | `1000000` | Chirp 3: HD characters Google does not bill each month. Set `0` if other projects on the billing account use Chirp 3: HD. |

#### API keys and collaborators

Everything a collaborator needs lives in [collaborators/](collaborators/): the
listening format, the guide for AI agents, and the build scripts. Keys are made
here, by you:

```sh
npm run api-key -- teammate https://your-site
```

- A new name gets a random key, added to `api-keys.txt`: your copy of the
  `API_KEYS` secret, one line of `name:secret` entries. It is kept out of git;
  Cloudflare never shows a secret again, so this file is the only copy.
- It builds `handover/teammate/`, also kept out of git: the files from
  `collaborators/` with your site's address filled in, plus their `KEY.txt`.
  Zip that folder and send it.
- A name that already has a key keeps it; only the folder is rebuilt. Run it
  again with the address once the site is deployed, or after the docs change.

`npm run api-keys:push` then puts `api-keys.txt` on the server. To revoke
someone, delete their `name:secret` entry (and its comma) from `api-keys.txt`
and push again. Clips they already made keep working.

A regional endpoint such as `https://eu-texttospeech.googleapis.com` keeps
processing in that region, but regions do not carry every model: only the
default global endpoint serves `gemini-3.1-flash-tts-preview`, and
`northamerica-northeast1` serves neither that nor `gemini-2.5-pro-tts`. The two
settings are validated independently, so an unsupported pairing fails at Google
rather than at request validation. See
[Available regions](https://docs.cloud.google.com/text-to-speech/docs/gemini-tts#available-regions).

The rate limits are set under `ratelimits` in `wrangler.jsonc`, counted apart: the reader allows 10 requests per 60 s per IP, and the clips API 100 per 60 s per key, since a course page needs hundreds of clips and a request makes only a few. Cloudflare applies them per location and treats them as approximate, so they are a brake, not exact accounting.

Google has its own limit per project, 200 requests a minute for Chirp 3: HD. A
batch that runs into it answers `429 rate_limited` with `Retry-After`, as for
our own limit, so the reader and the build scripts wait and send it again; in
the clips API, the clips not yet made stay `pending`.

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
  5. **A hard monthly budget** (`MONTHLY_BUDGET_USD`), the one cap that cannot be outrun. See below.
  6. Google-side quota caps and budget alerts (see setup).
- Google's own controls do not cap Text-to-Speech spending: budgets only send
  alerts, the spend caps in preview since July 2026 do not cover Text-to-Speech,
  and quotas only limit the rate. So the Worker caps it. Every synthesis passes
  through it, since only it holds the credentials. Before calling Google, a
  request reserves its estimated cost in a ledger, a single Durable Object
  (`workers/budget.ts`, `server/budget.ts`) that handles one reservation at a
  time, so concurrent requests cannot both spend the last dollar. Once the
  month is spent, the reader, `POST /api/tts` and the clips API answer
  `429 budget_exhausted` until the next calendar month (US Pacific, as Google
  bills); cached audio and published clips still play. Costs come from
  Google's list prices: Chirp 3: HD exactly, after its free characters
  (`CHIRP_FREE_CHARS`), and Gemini-TTS, which bills the audio it returns, from
  a deliberately slow 10 characters a second, so the real bill stays at or
  under the cap. A reservation is given back when Google fails. If the ledger
  cannot be reached, nothing is synthesized.
- The cap guards what goes through the site. A leaked Google API key could be
  used directly, around it: keep the key a secret, restrict it to the
  Text-to-Speech API, and rotate it if it leaks.
- Google errors that mention credentials or project details are logged on the server and replaced by generic messages in responses.

## Project layout

```
workers/app.ts         Worker entry: Hono /api + React Router (the home page is prerendered)
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
app/reader/format.ts   The DialogueLab format: parse, check, write, merge
app/reader/import-dialog.tsx  Import with line-by-line checks and a preview
app/reader/*.tsx       Cast, playback, dictionary, library and script panels
app/context.ts         Worker bindings handed to loaders
test/                  Vitest suites
```

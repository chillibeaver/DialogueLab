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
| Pages | [React Router v8](https://reactrouter.com) framework mode with SSR (`app/`); the frontend is not built yet |
| Build | Vite + `@cloudflare/vite-plugin` |
| Tests | Vitest (`test/`) |

`workers/app.ts` is the Worker entry: requests to `/api/*` go to Hono, and everything else is server-rendered by React Router.

## API

### `GET /api/health`

`{ "ok": true }`

### `GET /api/catalog`

Everything a client needs to build its controls: defaults, limits, output formats, the 30 voices, and the languages and models for each engine. The default language is listed first. The data is static, so this endpoint costs nothing and is cacheable.

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
| 403 | `turnstile_required`, `turnstile_failed` | Get a fresh Turnstile token. |
| 413 | `text_too_long`, `text_too_long_for_format`, `payload_too_large` | Shorten the text or use `mp3`/`wav`. |
| 422 | `synthesis_rejected` | Google refused the input. The message comes from Google, e.g. a sentence that is too long. |
| 429 | `rate_limited` | Per-IP limit hit. Respect `Retry-After`. |
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
server/request.ts      Request validation and defaults (zod), including dialogue rules
server/catalog.ts      Engines, voices, languages, models
server/config.ts       Bindings and vars
server/protection.ts   Rate limiting and Turnstile
server/google/auth.ts  Per-engine credential: API key, or service-account JWT → OAuth token (WebCrypto, cached)
server/google/tts.ts   Google request bodies and error mapping
server/lib/chunk.ts    Sentence-aware splitting by UTF-8 byte budget
server/lib/audio.ts    MP3/WAV concatenation
server/lib/cache.ts    KV audio cache
app/                   React Router pages (frontend, to be built)
test/                  Vitest suites
```

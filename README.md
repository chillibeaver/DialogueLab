# TTS Studio

French-first text-to-speech web tool backed by Google Cloud Text-to-Speech, running entirely on a single Cloudflare Worker.

- **Voices:** [Chirp 3: HD](https://docs.cloud.google.com/text-to-speech/docs/chirp3-hd) (default) and [Gemini-TTS](https://docs.cloud.google.com/text-to-speech/docs/gemini-tts) (style prompts such as *"read slowly, like a storyteller"*).
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

Unknown fields are rejected, so a typo like `speed` returns an error instead of being silently ignored.

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

1. Create or choose a project and link a billing account.
2. Enable the **Cloud Text-to-Speech API**.
3. Create a service account (IAM & Admin → Service Accounts) and grant it **Vertex AI User** (`roles/aiplatform.user`). The Gemini-TTS docs require this role (`aiplatform.endpoints.predict`). If Google still answers `PERMISSION_DENIED`, the Worker log line `Google TTS error 403 …` contains Google's exact message, including the missing permission.
4. Create a JSON key for the service account (Keys → Add key → JSON) and keep the file somewhere safe.
5. **Cost guardrails (strongly recommended for a public tool):**
   - Billing → Budgets & alerts: create a budget with email alerts. Note that budgets *notify*; they do not stop spending.
   - APIs & Services → Cloud Text-to-Speech API → Quotas: lower the per-minute request quotas (for example the Chirp 3 limit) to a level you are comfortable paying for. This is a hard cap.

### 2. Cloudflare

```sh
npx wrangler login

# Audio cache: create the namespace, then paste the printed id into wrangler.jsonc (kv_namespaces[0].id)
npx wrangler kv namespace create tts-studio-cache

# Turnstile: create a widget in the dashboard (Turnstile → Add widget, mode "Invisible" or "Managed")
# for your domain. The site key goes into the frontend; the secret key goes here:
npx wrangler secret put TURNSTILE_SECRET_KEY

# Google credentials: paste the whole JSON key file content when prompted
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
| `GOOGLE_TTS_ENDPOINT` | `https://texttospeech.googleapis.com` | Use `https://eu-texttospeech.googleapis.com` to keep processing in the EU. |
| `CACHE_TTL_SECONDS` | `2592000` (30 days) | How long synthesized audio stays in KV. |

The rate limit (10 requests per 60 s per IP) is set under `ratelimits` in `wrangler.jsonc`. Cloudflare applies it per location and treats it as approximate, so it is a brake, not exact accounting.

## Development

```sh
npm install
cp .dev.vars.example .dev.vars   # then fill in GOOGLE_SERVICE_ACCOUNT_JSON
npm run dev                      # http://localhost:5173 (runs in workerd, with local KV and rate limiter)
npm test                         # unit + API tests (Google, Turnstile and KV are faked)
npm run typecheck
```

In `.dev.vars`, wrap the service account JSON in **single quotes** on one line. Double quotes make dotenv rewrite the `\n` escapes in the private key.

## Security and cost model

- The Google key exists only as a Worker secret. The browser talks only to `/api/*` on this domain, and the Worker calls Google, so the key is never sent to the client.
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
server/request.ts      Request validation and defaults (zod)
server/catalog.ts      Engines, voices, languages, models
server/config.ts       Bindings and vars
server/protection.ts   Rate limiting and Turnstile
server/google/auth.ts  Service-account JWT → OAuth token (WebCrypto, cached)
server/google/tts.ts   Google request bodies and error mapping
server/lib/chunk.ts    Sentence-aware splitting by UTF-8 byte budget
server/lib/audio.ts    MP3/WAV concatenation
server/lib/cache.ts    KV audio cache
app/                   React Router pages (frontend, to be built)
test/                  Vitest suites
```

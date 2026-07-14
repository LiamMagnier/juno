# Juno

A production-grade, multimodal AI chatbot built with the Anthropic Messages API — streaming chat, conversation history, memory, a Canvas for artifacts, file/image uploads, voice mode, settings, and Stripe billing.

> **Design:** Juno implements a Claude × ChatGPT × Perplexity identity — warm cream/paper light theme, warm-charcoal dark theme, a **coral** primary (`#D97757`), a serif (Newsreader) for human moments, and a **monospace dot/ASCII** signature layer: a cursor-reactive dot-field background, an ASCII/dot-matrix wordmark, a dot-wave "thinking" indicator, a monospace streaming caret, dot-matrix identicons, dot-fill quota bars, and a particle voice orb. Five selectable accents (coral default · teal · violet · amber · sage), app-wide film grain, and `prefers-reduced-motion` support. One stack deviation: **Tailwind v3.4** (not v4) for the well-trodden shadcn token workflow.

---

## Features

- **Streaming chat** with `claude-opus-4-8` (default) or `claude-sonnet-4-6`, message persistence, and per-message actions (copy, regenerate, edit, 👍/👎).
- **Conversation history** — create, date-grouped list, search, rename, pin, folders, delete.
- **Settings** — theme (light/dark/system) + accent, default model, custom instructions, language, data export, account deletion (all persisted).
- **Auth** — email + password and Google OAuth (NextAuth v5 / Auth.js).
- **Memory** — Juno saves durable facts, injects them into context, with a manager UI (view/search/edit/delete) and a master on/off toggle plus an inline "memory updated" indicator.
- **Canvas / artifacts** — side panel with Preview + Code tabs, version history, edit, copy, download, fullscreen — rendered in a sandboxed iframe.
- **File + image upload** — drag-and-drop or button, validation, progress, S3 storage, multimodal (images + PDFs + text passed to the model).
- **Voice** — Web Speech dictation baseline, plus a full voice-conversation mode (listening/thinking/speaking with interrupt) and optional server STT/TTS.
- **Billing** — Stripe Checkout, customer portal, webhooks, and **server-side** plan gating (message quotas, model access, upload size, voice).

## Tech stack

Next.js 15 (App Router) · TypeScript · Tailwind CSS v3.4 · shadcn/ui · Prisma 6 + PostgreSQL · NextAuth v5 · Anthropic SDK · Stripe · AWS SDK v3 (S3-compatible storage).

---

## 1. Prerequisites

| Tool | Version |
|------|---------|
| Node.js | **20+** (built and tested on 20/22/24) |
| npm | 10+ |
| PostgreSQL | A hosted database — [Neon](https://neon.tech) or [Supabase](https://supabase.com) (free tiers work) |

You'll also want accounts for: **Anthropic** (required), and optionally **Google Cloud** (OAuth), an **S3-compatible bucket** (uploads), **Stripe** (billing), and a **voice provider** (OpenAI / Deepgram / ElevenLabs).

---

## 2. Install & run locally

```bash
# 1. Install dependencies (also generates the Prisma client)
npm install

# 2. Create your env file and fill it in (see section 3)
cp .env.example .env

# 3. Create the database schema
npx prisma migrate dev --name init      # creates + applies the first migration
#   (or, for a quick start without migration files: npx prisma db push)

# 4. Start the dev server
npm run dev
```

Open <http://localhost:3000>. Create an account on `/sign-up` and start chatting.

---

## 3. Environment variables

Copy `.env.example` to `.env` and fill these in. **Required** variables must be set; everything else is optional and the related feature degrades gracefully when absent.

### Required

| Variable | Where to get it |
|----------|-----------------|
| `DATABASE_URL` | Neon/Supabase → connection string (Postgres URI). Use the **pooled** host for the app. |
| `ANTHROPIC_API_KEY` | <https://console.anthropic.com/settings/keys> → **Create Key**. Paste into `ANTHROPIC_API_KEY`. |
| `AUTH_SECRET` | Generate one: `openssl rand -base64 32`. Paste into `AUTH_SECRET`. |
| `NEXT_PUBLIC_APP_URL` | `http://localhost:3000` locally; your live URL in production. |

> Neon note: if `DATABASE_URL` uses the pooled (`-pooler`) host, also set `DIRECT_URL` to the **direct** (non-pooled) connection — Prisma migrations use it.

### Optional — Google OAuth (the "Continue with Google" button)

1. <https://console.cloud.google.com/apis/credentials> → **Create credentials → OAuth client ID → Web application**.
2. Authorized redirect URI: `http://localhost:3000/api/auth/callback/google` (and your prod URL).
3. Paste the client ID/secret into `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

### Email — required for password recovery

The **Forgot your password?** flow sends a one-hour, single-use link through Resend. Without these variables the recovery page shows that email recovery is unavailable instead of pretending a message was sent.

| Variable | Notes |
|----------|-------|
| `RESEND_API_KEY` | Create an API key in Resend. |
| `EMAIL_FROM` | Sender on a domain you verified in Resend, for example `Juno <hello@your-domain.com>`. |

Set `NEXT_PUBLIC_APP_URL` to the exact public origin so reset links point back to the deployed site. The token is kept in the URL fragment, is stored only as a SHA-256 digest, expires after one hour, and invalidates older signed-in sessions when used.

### Optional — Storage (file & image uploads), S3-compatible

Works with AWS S3, Cloudflare R2, Supabase Storage (S3), or MinIO.

| Variable | Notes |
|----------|-------|
| `S3_BUCKET` | Bucket name. |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | Access keys. |
| `S3_REGION` | e.g. `us-east-1`. |
| `S3_ENDPOINT` | Leave blank for AWS S3. For R2/Supabase/MinIO set the S3 endpoint URL. |
| `S3_FORCE_PATH_STYLE` | `true` for R2/Supabase/MinIO, `false` for AWS S3. |
| `S3_PUBLIC_URL` | Optional CDN/base URL. If blank, the app serves files via short-lived signed URLs. |

**Supabase:** Project Settings → Storage → **S3 connection** gives you the endpoint, region, and keys. Create a bucket and put its name in `S3_BUCKET`.

### Optional — Stripe (billing)

| Variable | Where |
|----------|-------|
| `STRIPE_SECRET_KEY` | <https://dashboard.stripe.com/apikeys> → Secret key (`sk_...`). |
| `STRIPE_PRICE_PRO` | Price ID (`price_...`) of your **Pro** product (see section 5). |
| `STRIPE_PRICE_MAX` | Price ID of your **Max** product. |
| `STRIPE_WEBHOOK_SECRET` | Signing secret from the webhook endpoint (see section 5). |

### Optional — Voice (without these, voice uses the browser only)

| Variable | Notes |
|----------|-------|
| `STT_PROVIDER` | `openai` or `deepgram` (speech-to-text). |
| `TTS_PROVIDER` | `openai` or `elevenlabs` (text-to-speech). |
| `OPENAI_API_KEY` | For OpenAI Whisper STT and/or OpenAI TTS. |
| `DEEPGRAM_API_KEY` | For Deepgram STT. |
| `ELEVENLABS_API_KEY` / `ELEVENLABS_VOICE_ID` | For ElevenLabs TTS. |

---

## 4. Database setup & migrations

```bash
# Local — create and apply a migration (records migration history in prisma/migrations)
npx prisma migrate dev --name init

# Inspect data with a GUI
npx prisma studio
```

Commit the generated `prisma/migrations/` folder so the same schema can be applied in production with `npx prisma migrate deploy`.

> Quick alternative (no migration history): `npx prisma db push` syncs the schema directly. Fine for prototypes; use migrations for anything you'll maintain.

---

## 5. Stripe setup (products, prices, webhook)

1. **Create two products** at <https://dashboard.stripe.com/products> — "Juno Pro" and "Juno Max", each with a **recurring monthly price**. Copy each **Price ID** (`price_...`) into `STRIPE_PRICE_PRO` and `STRIPE_PRICE_MAX`. (Prices default to $20 and $100 in the UI — change the display in `src/lib/plans.ts` to match yours.)
2. **Webhook** — <https://dashboard.stripe.com/webhooks> → **Add endpoint**:
   - URL: `https://YOUR_DOMAIN/api/stripe/webhook`
   - Events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`.
   - Copy the **Signing secret** into `STRIPE_WEBHOOK_SECRET`.
3. **Test locally** with the Stripe CLI:
   ```bash
   stripe listen --forward-to localhost:3000/api/stripe/webhook
   # use the printed whsec_... as STRIPE_WEBHOOK_SECRET while developing
   ```
   Use card `4242 4242 4242 4242` at checkout.

Plan gating (message quota, model access, upload size, voice) is enforced **server-side** from the plan stored on the user's `Subscription`, which the webhook keeps in sync.

---

## 6. Deploy to Vercel

1. Push this repo to GitHub and **import it** at <https://vercel.com/new>. Framework preset: **Next.js** (auto-detected).
2. **Add every environment variable** from section 3 in **Project → Settings → Environment Variables** (Production + Preview). Set `NEXT_PUBLIC_APP_URL` to your live URL (e.g. `https://juno.vercel.app`).
3. **Deploy.** The build runs `prisma generate && next build` automatically (see `package.json`).
4. **Run migrations against the production database** (one time, and after schema changes). From your machine, with the production `DATABASE_URL` exported:
   ```bash
   DATABASE_URL="<prod-url>" npx prisma migrate deploy
   ```
5. **Stripe webhook for the live domain:** in the Stripe dashboard create/update the webhook endpoint to `https://YOUR_DOMAIN/api/stripe/webhook` and put its signing secret in `STRIPE_WEBHOOK_SECRET` on Vercel. Redeploy if you changed env vars.
6. **Google OAuth:** add `https://YOUR_DOMAIN/api/auth/callback/google` to the authorized redirect URIs.

---

## 7. Verify it works

- [ ] `npm run dev` starts with no errors; `/sign-up` creates an account and redirects to `/chat`.
- [ ] Sending a message **streams** a reply token-by-token and persists after reload.
- [ ] The conversation appears in the sidebar; rename, pin, move to a folder, search, and delete all work.
- [ ] Ask for "a React counter component as an artifact" → the **Canvas** opens with a live Preview + Code, version history after an edit, and download.
- [ ] Drag an image or PDF into the composer → it uploads with progress and the model can discuss it.
- [ ] Tell Juno "remember that I prefer concise answers" → the **memory updated** chip appears and the fact shows under `/memory`.
- [ ] Settings: switch theme/accent, change default model, edit custom instructions, export data — all persist across reload.
- [ ] (If Stripe configured) `/upgrade` → Checkout with `4242…` card → webhook flips your plan; `/settings` → **Manage subscription** opens the portal.
- [ ] (If voice configured/supported) the mic dictates into the composer and voice mode holds a spoken conversation.

### Automatic interface language

Juno resolves the browser/computer language from `Accept-Language` on the server and falls back to `navigator.languages` in stripped-header webviews. Standard ISO 639-1 web languages are accepted, including regional and script variants such as `pt-BR` and `zh-Hant`; right-to-left direction is set automatically.

Static interface copy is extracted at build time with `npm run i18n:extract`. For non-English locales, only opaque catalog IDs are sent to `/api/i18n/translations`; the server translates the corresponding fixed UI copy with the configured Anthropic model. Conversations, account data, typed text, and other user content are never sent for interface translation. Results are cached in the browser, at the CDN, and in the warm server process. If translation is unavailable, the original English remains usable.

---

## Project structure

```
prisma/schema.prisma         # Data model (users, conversations, messages, memory, artifacts, billing…)
src/
  app/
    (auth)/                  # sign-in / sign-up
    (app)/                   # authed shell: chat, chat/[id], settings, memory, upgrade
    api/                     # route handlers: chat (SSE), conversations, messages, upload,
                             #   memory, settings, account, artifacts, voice, stripe, auth
    layout.tsx globals.css   # root layout + Juno design tokens
  components/
    ui/                      # shadcn-style primitives (button, dialog, dropdown, …)
    app/                     # provider, sidebar, shell, user menu
    chat/                    # composer, message list/item, markdown, model selector
    canvas/                  # canvas panel + sandboxed artifact renderer
    voice/                   # voice-conversation mode
  hooks/                     # use-chat, use-uploads, use-speech-recognition, use-tts
  lib/                       # anthropic, prisma, auth, storage, stripe, usage, plans, rate-limit…
```

## Security notes

- The Anthropic, Stripe, storage, and voice keys are **only ever used server-side** in route handlers — never shipped to the browser.
- Every mutating route authorizes the session user and scopes queries to their data.
- Chat and upload endpoints are **rate-limited** (Postgres fixed-window).
- Artifact previews run in a **sandboxed iframe** with an opaque origin (`allow-scripts` only — no same-origin access to the app, cookies, or storage).
- User input is validated with Zod; Markdown is rendered without raw HTML.

## Known limitations

- **Vercel upload size:** server-side uploads go through a serverless function, which on Vercel caps request bodies at ~4.5 MB. Files up to that size work out of the box; for larger files on Vercel, switch to presigned direct-to-S3 uploads (other hosts / self-hosting are not affected). Plan upload limits live in `src/lib/plans.ts`.
- **Memory relevance** injects your most recent saved memories (capped) rather than doing semantic retrieval.
- Voice mode's speech recognition uses the browser Web Speech API (best in Chrome/Edge); server STT/TTS are used for playback when configured.

## Useful scripts

```bash
npm run dev        # start dev server
npm run build      # prisma generate + next build
npm run start      # run the production build
npm run lint       # eslint
npm run test:auth  # password-reset token + locale helper checks
npm run i18n:extract # regenerate the static UI translation catalog
npm run db:studio  # Prisma Studio
npm run db:migrate # prisma migrate dev
npm run db:deploy  # prisma migrate deploy (production)
```

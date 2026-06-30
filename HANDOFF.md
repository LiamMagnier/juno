# Juno — Project Handoff

> Paste this whole file into a new Claude Code chat to continue working on Juno. It's self-contained: it explains what the app is, how it's built, how to run it, what's done, what's pending, and the conventions to follow.

## What Juno is

A **production-grade, multi-provider AI chatbot** (think Claude × ChatGPT × Perplexity with a warm coral + monospace/dot "Juno" identity). Built from scratch in `/Users/liammagnier/Desktop/Liam`. It runs locally now and is ready to deploy to Vercel.

**Owner / current user:** app account email is `liam.magnier25@icloud.com` (set as `OWNER_EMAILS` → "Owner" plan, unlimited).

## Status: everything below is BUILT and working

- **Auth** — NextAuth v5 (Auth.js), email+password (bcrypt) + Google OAuth, JWT sessions.
- **Streaming chat** — SSE, message persistence, copy/regenerate/edit/feedback.
- **Multi-provider models** — Anthropic (native SDK) + OpenAI-compatible (OpenAI, Google Gemini, Zhipu GLM, Moonshot Kimi, DeepSeek, Mistral, xAI Grok). One adapter for all OpenAI-compatible ones. **Models are discovered live from each provider's `/models` API**, curated to the latest per family (junk filtered out), shown in a T3-style picker with a left rail of lab logos.
- **Conversation history** — sidebar grouped by date, search, rename, pin, folders (+ folder delete).
- **Settings** — theme (light/dark/system) + 5 accents, default model, custom instructions, language, data export, account deletion (all persisted).
- **Memory** — (1) inline `<juno:memory>` tags the model emits, AND (2) a **background auto-extraction** pass (`after()`) that saves durable facts even when not asked. Manager UI at `/memory`, master toggle, "memory updated" chip.
- **Canvas / artifacts** — `<juno:artifact>` tags → side panel with Preview/Code tabs, version history, edit, copy, download, fullscreen; sandboxed iframe (React/HTML/SVG/Mermaid via CDN). Parser is lenient (handles quotes/missing id, salvages truncated artifacts).
- **File/image upload** — drag-drop + the `+` menu, validation, progress, multimodal to vision models. **Storage works two ways**: local disk (`./.uploads`, dev, zero setup) OR any S3-compatible bucket (production) — automatic based on whether `S3_*` env vars are set.
- **Voice** — Web Speech dictation + full voice-conversation mode (orb, listening/thinking/speaking, interrupt) + optional server STT/TTS.
- **Billing** — Stripe Checkout + portal + webhook + server-side plan gating. Plans: FREE / PRO / MAX, plus a non-purchasable **OWNER** plan (via `OWNER_EMAILS`, unlimited + no rate limits).
- **Design system** — coral `#D97757` primary, warm paper/charcoal themes, Newsreader serif for headings, JetBrains Mono for labels, dot/ASCII signature layer (reactive dot-field, dot-matrix wordmark/identicon, dot-wave thinking, particle voice orb), film grain, motion polish, reduced-motion support.

## Tech stack (deliberate version choices)

Next.js 15.5 (App Router) · React 19 · TypeScript 5.7 · Tailwind v3.4 + shadcn-style UI · Prisma 6 (`prisma-client-js`) · NextAuth v5 beta · `@anthropic-ai/sdk` · `openai` SDK (for all OpenAI-compatible providers) · Stripe · AWS SDK v3 (S3). Pinned intentionally for API correctness — don't bump majors without checking.

## How to run it RIGHT NOW (already set up on this machine)

PostgreSQL 16 is installed via Homebrew and running; the `juno` DB exists and is migrated; `.env` is filled with a local `DATABASE_URL`, a generated `AUTH_SECRET`, `OWNER_EMAILS`, and some provider keys.

```bash
cd /Users/liammagnier/Desktop/Liam
npm install
npm run dev          # http://localhost:3000
```

If Postgres isn't running: `brew services start postgresql@16`.
Dev server tips: it's been launched with `nohup … & disown`. To restart after editing `.env` (env is read once at startup): `pkill -f "next dev"; npm run dev`.

**CRITICAL:** never run `npm run build` while `npm run dev` is running — they share `.next` and the build corrupts the dev server (causes a 500). If it happens: `rm -rf .next && npm run dev`.

**Verify changes:** `npx tsc --noEmit` (must be clean). A production build is `npm run build` (stop dev first).

## Architecture & key files

```
prisma/schema.prisma            # data model: User/Account/Session, Settings, Folder,
                                # Conversation, Message, Attachment, MemoryEntry,
                                # Artifact/ArtifactVersion, Subscription, Usage, RateLimit
src/
  app/
    (auth)/sign-in|sign-up      # auth pages
    (app)/layout.tsx            # requireUser + getAppBootstrap → AppProvider + AppShell
    (app)/chat, chat/[id]       # chat pages (ChatView)
    (app)/settings|memory|upgrade
    api/
      chat/route.ts             # ⭐ streaming heart: model resolve+gate, SSE, persist,
                                #   artifacts, memory (inline + after() extraction), quota
      models/route.ts           # live model discovery
      conversations, messages, folders, memory, settings, account, artifacts
      upload, files/[...key]    # upload + local-file serving
      voice/stt|tts, stripe/checkout|portal|webhook, auth/[...nextauth]|register
  components/
    app/        # app-provider (context), app-shell, app-sidebar, user-menu
    chat/       # chat-view, composer (+ menu, mic-right-of-send), message-list/item,
                # markdown, model-selector (T3-style), artifact-inline-card, empty-state
    canvas/     # canvas-panel, sandbox-frame (sandboxed iframe)
    voice/      # voice-mode
    signature/  # dot-field, voice-orb, dot-matrix, thinking-dots, ascii-hero, dotted-divider
    brand/      # logo (JunoMark), provider-logo (lab logos)
    ui/         # shadcn-style primitives
  lib/
    models.ts          # ⭐ model registry. IDs are "provider:model". resolveModel(),
                       #   prettifyModelName(), guessVision/guessPlan(), MAX_OUTPUT_TOKENS=8192
    model-discovery.ts # fetch /models per provider, curate to latest-per-family (FAMILIES), drop junk
    providers.ts       # ⭐ 8 providers: label, apiKeyEnv, baseUrlEnv, defaultBaseUrl, kind
    llm.ts             # streamChat() dispatcher → anthropic.ts | openai-compat.ts
    anthropic.ts       # buildSystemPrompt(), toAnthropicMessages(), streamAnthropic()
    openai-compat.ts   # toOpenAIMessages() (vision via image_url), streamOpenAICompat()
    plans.ts           # PLANS (incl OWNER), planRank(), canUseModel()
    usage.ts           # getUserPlan() (owner override), getQuota, consume/refundMessage
    owner.ts           # isOwnerEmail() reads OWNER_EMAILS
    memory.ts          # getMemoriesForContext, saveAutoMemories, autoExtractMemories()
    storage.ts         # ⭐ dual: S3 OR local disk; putObject/getObjectBytes/getViewUrl
    message-content.ts # ⭐ artifact/memory tag parsing (lenient), splitMessageContent()
    rate-limit.ts      # atomic Postgres fixed-window
    accents.ts, env.ts, prisma.ts, queries.ts, serializers.ts, chat-stream.ts, uploads.ts
```

## Key implementation notes (important for continuing)

- **Model IDs are `provider:model`** (e.g. `anthropic:claude-sonnet-4-6`, `google:models/gemini-2.5-flash`). `resolveModel(id)` handles namespaced + legacy bare ids (alias). The provider API model param = `providerModel` (kept raw, incl. Gemini's `models/` prefix).
- **Adding a provider:** add to `PROVIDERS` (providers.ts), add a logo case in `provider-logo.tsx`, add a `FAMILIES` entry in `model-discovery.ts`, add curated fallbacks in `models.ts`, document the key in `.env.example`. It's OpenAI-compatible if it has a `/chat/completions` + `/models` endpoint.
- **Owner plan:** `getUserPlan()` returns `"OWNER"` when the user's email is in `OWNER_EMAILS`. Rate limits are bypassed for owners in chat/upload/voice routes. OWNER is not in `PLAN_LIST` (not shown on /upgrade).
- **Storage dual:** `isStorageConfigured()` = S3 vars set; `isStorageAvailable()` = S3 set OR not on Vercel (local disk). `features.storage` uses the latter. Local files serve via `/api/files/[...key]`.
- **Memory:** inline tags parsed in the chat route's done handler (fires the chip); plus `autoExtractMemories()` runs in `after()` with a cheap configured model. Both dedupe via `saveAutoMemories`.
- **Artifacts:** robust parsing in `message-content.ts`. Inline card shows "Writing…" only while `message.streaming`. Don't require `identifier` — a content hash is the fallback.
- **New-chat navigation:** new chats stream on `/chat`, then `router.replace('/chat/[id]')` in `onDone` (NOT shallow `history.replaceState` — that broke clicking conversations).
- **Hydration:** client-only/`window`/`Date`-based UI is mount-gated or `suppressHydrationWarning` (mic button, greeting, sidebar date groups).

## Environment variables

See `.env.example` (fully commented). Required: `DATABASE_URL`, `ANTHROPIC_API_KEY`, `AUTH_SECRET`, `NEXT_PUBLIC_APP_URL`. Optional: provider keys (`OPENAI_API_KEY`, `GOOGLE_API_KEY`, `ZHIPU_API_KEY`, `MOONSHOT_API_KEY`, `DEEPSEEK_API_KEY`, `MISTRAL_API_KEY`, `XAI_API_KEY` + `*_BASE_URL`), `OWNER_EMAILS`, `S3_*`, `STRIPE_*`, voice (`STT_PROVIDER`/`TTS_PROVIDER` + keys), `GOOGLE_CLIENT_ID/SECRET`.

## Going to production (the pending setup)

The app is code-ready for cloud; these are account-creation steps the user must do, then paste credentials.

### 1. Cloud database (so memory/data is shared local ↔ prod) — Neon
1. Create a free project at https://neon.tech → copy the **pooled** connection string.
2. Set `DATABASE_URL="postgres://…-pooler…?sslmode=require"` in `.env` (and Vercel). (Optional `DIRECT_URL` = non-pooled, for migrations.)
3. `npx prisma migrate deploy` (or `npx prisma db push`).
   Now the same DB is used from localhost and production — memory persists across both.

### 2. Cloud storage bucket — Cloudflare R2 (recommended; free tier, S3-compatible)
1. Cloudflare dashboard → R2 → create a bucket (e.g. `juno-uploads`).
2. R2 → Manage API Tokens → create token (Object Read & Write) → note Access Key ID + Secret + the account's S3 endpoint `https://<accountid>.r2.cloudflarestorage.com`.
3. In `.env` (and Vercel):
   ```
   S3_ENDPOINT="https://<accountid>.r2.cloudflarestorage.com"
   S3_REGION="auto"
   S3_BUCKET="juno-uploads"
   S3_ACCESS_KEY_ID="…"
   S3_SECRET_ACCESS_KEY="…"
   S3_FORCE_PATH_STYLE="true"
   # optional public bucket/CDN base: S3_PUBLIC_URL="https://pub-….r2.dev"
   ```
4. Restart. Uploads now go to R2 (local disk fallback is bypassed automatically). Works identically on Vercel.
   (Supabase Storage or AWS S3 work too — same vars; for AWS set `S3_FORCE_PATH_STYLE="false"` and a real region.)

### 3. Deploy to Vercel
Push to GitHub → import in Vercel → add ALL env vars → deploy. The build runs `prisma generate && next build`. Run `prisma migrate deploy` against the prod DB. For Stripe, set the live webhook to `https://DOMAIN/api/stripe/webhook`. For Google OAuth, add `https://DOMAIN/api/auth/callback/google`.

## Pending / good next steps

- User must do the Neon + R2 setup above for full cloud (code is ready).
- Voice STT/TTS providers are optional (browser fallback works); wire OpenAI/Deepgram/ElevenLabs keys if desired.
- Image **generation** models are intentionally excluded (Juno is chat-only); could add a separate image flow later.
- Consider a periodic memory "consolidation/summary" (Claude-style nightly) if per-message extraction feels noisy.

## Conventions

- After any change: `npx tsc --noEmit` must be clean. Don't run `next build` while `next dev` is running.
- Restart dev after `.env` edits or Prisma client regen. Migrate with `npx prisma migrate dev --name X` (Postgres on PATH: `export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"`).
- Match the existing style: coral tokens, mono labels, serif for human moments, no purple/AI-gradients, keep it warm and calm.

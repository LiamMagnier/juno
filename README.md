# Juno

A production-grade, multimodal AI chat website: streaming chat across a large model
catalog, durable history, long-term memory, a Canvas for live artifacts,
file/image/PDF uploads, tool connectors (MCP), voice (read-aloud, dictation, and
realtime speech-to-speech), cloud & device "Code" agent sessions, an interface that
auto-translates itself, and Stripe billing with server-side plan gating.

Built with **Next.js 15** (App Router) · TypeScript · Tailwind CSS v3.4 · shadcn/ui ·
Prisma 6 + PostgreSQL · NextAuth v5 · the Anthropic SDK plus 13 OpenAI-compatible
providers · Stripe · S3-compatible storage.

> **📖 Full documentation:** [`docs/JUNO.md`](docs/JUNO.md) — the single source of
> truth for design, front-end, back-end, data model, security, configuration, the
> full API surface, and deployment. Start there.

---

## Quick start

```bash
# 1. Install (also generates the Prisma client)
npm install

# 2. Configure — copy the example env and fill in the required vars
cp .env.example .env
#    Required: DATABASE_URL, ANTHROPIC_API_KEY, AUTH_SECRET, NEXT_PUBLIC_APP_URL
#    (see docs/JUNO.md §19 for the full matrix; everything else is optional and
#     the related feature degrades gracefully when absent.)

# 3. Create the database schema
npx prisma migrate dev --name init

# 4. Run
npm run dev            # → http://localhost:3000
```

Create an account at `/sign-up` and start chatting. The default chat model is
`claude-sonnet-5`; the model picker and Auto mode expose the rest.

## Useful scripts

```bash
npm run build          # prisma generate + next build
npm run lint           # eslint
npm test               # unit tests (auth, crypto, moderation, memory, …)
npm run db:studio      # Prisma Studio
npm run validate:models
npm run sync:models    # discover new provider models (sync:models:write to apply)
npm run i18n:extract   # regenerate the static UI translation catalog
```

## Where things live

- `docs/JUNO.md` — complete documentation (read this first).
- `prisma/schema.prisma` — the data model (49 models, migrations in `prisma/migrations/`).
- `src/app/api/` — ~120 route handlers; `src/lib/` — all backend logic.
- `relay/` — the standalone realtime-voice WebSocket service (see `relay/README.md`).
- `runner/agent-core/` — vendored agent core for cloud Code (see its `VENDORED.md`).
- `deploy/` — `deploy.sh`, PM2 config, nginx template, and the VM setup guides
  ([Oracle](deploy/VM_SETUP_GUIDE.md) · [GCP](deploy/GCP_SETUP_GUIDE.md)).
- `contracts/openapi/juno-native-v1.yaml` — the versioned `/api/v1` backend contract.

## Deployment

Two shapes are supported: UI on Vercel/Cloudflare with `/api/*` rewritten to a VM
backend, or everything on an always-free VM (nginx → Next.js + voice relay +
scheduler, under PM2). See [`docs/JUNO.md` §20](docs/JUNO.md#20-deployment--operations)
and the `deploy/` runbooks.

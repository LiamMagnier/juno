# Contributing

Juno is built and run by one person. Contributions are welcome; the notes below
exist so a change does not fail in a way that is expensive to discover.

## Before you start

Read [`docs/JUNO.md`](docs/JUNO.md). It is the source of truth for the website —
architecture, data model, the chat pipeline, security, configuration and
deployment — and it is kept current. `docs/native/README.md` indexes the native
client docs.

## Setup

```bash
npm install                     # also runs prisma generate
cp .env.example .env            # fill in the REQUIRED block
npx prisma migrate dev          # against a dev database, not production
npm run dev                     # → http://localhost:3000
```

`.env` in this repository points at the **production** database. `.env.local`
takes precedence over it and is gitignored — point `DATABASE_URL` and
`DIRECT_URL` there at a local Postgres before you run anything that writes.

For voice, run the relay with `RELAY_ENABLE_MOCK=1` and set
`NEXT_PUBLIC_VOICE_RELAY_URL=ws://localhost:8787`.

## Before you push

```bash
npm run i18n:extract   # regenerates src/lib/i18n-catalog.generated.ts (not tracked)
npx tsc --noEmit       # the real type gate — `next build` deliberately skips it
npm run lint
npm test
```

CI runs exactly these on every pull request. `next build` sets
`typescript.ignoreBuildErrors` because the 1 GB deploy VM OOMs on the type-check
worker, so `tsc --noEmit` locally is not optional.

Touching `native/` or `contracts/`? `native.yml` additionally builds both apps
and checks that the generated Swift contract has not drifted
(`npm run native:contract:check`).

## Conventions

- **TypeScript is strict.** There are five `any` sites and zero `@ts-ignore` in
  `src/`. Keep it that way; if you need an escape hatch, explain it in a comment.
- **Never hardcode a colour.** All tokens are CSS variables in
  `src/app/globals.css`, mapped by `tailwind.config.ts`.
- **The transcript stays flat.** Depth, gloss and glass are for chrome and
  controls only — see `docs/JUNO.md` §3.5.
- **Every user-owned query is scoped to `userId`.** `src/lib/db.ts` enforces this
  at the Prisma layer: it throws in development. Intentionally global queries
  must use `prismaUnguarded` so the intent is explicit at the call site.
- **Comments explain *why*.** This codebase is unusually good at recording the
  bug that motivated a piece of code. Match that.
- **Money and auth code needs a test.** `src/lib/spend.ts`, `src/lib/usage.ts`
  and anything under `src/app/api/stripe/` change real charges.

## Generated files

Do not hand-edit:

- `src/lib/i18n-catalog.generated.ts` — written by `npm run i18n:extract`, not
  tracked.
- `src/lib/models.generated.ts`, `src/lib/benchmarks.generated.ts` — written by
  the nightly `sync-models` workflow. These **are** tracked, because they hold
  curated registry state that cannot be reproduced without provider API keys.
  Promote worthwhile `DISCOVERED` entries into `CURATED` in `src/lib/models.ts`
  by hand, then run `npm run validate:models`.

## Commits and pull requests

Conventional-commit prefixes (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`).
Write commit messages that say what changed and why; several existing messages
in this repository are the best documentation of a subtle decision, which is the
bar.

One logical change per pull request, and say in the description what you ran.

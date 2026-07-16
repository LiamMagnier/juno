# Juno web/backend contributor guide

This repository is Juno's canonical web application, account backend, database schema, entitlements, model catalog, and shared native-client contract. Read `docs/rebuild/STATUS.md` and the relevant `docs/rebuild/` decision records before changing a rebuild surface.

## Safe setup and verification

Use Node 20 or newer; CI must eventually pin one version. Install exactly from the lockfile:

```sh
npm ci
```

Baseline checks:

```sh
npx tsc --noEmit
npm run validate:models
npm run test:auth
AUTH_SECRET=juno-test-only-auth-secret \
DATA_ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 \
  npx tsx scripts/test-message-crypto.ts
npm run build
npm ci --prefix relay
npm run typecheck --prefix relay
npm run build --prefix relay
```

`npm run lint` is currently not a usable gate: the Next 15 command enters interactive ESLint setup because no configuration is checked in. Treat that as a known failure to fix, not a passing test. There is no unified safe web test command. Do not run `scripts/test-memory.ts`, provider relay/clarify/moderation probes, or anything that can mutate a shared database or incur provider spend unless the target is an explicitly disposable environment.

`predev` and `build` regenerate `src/lib/i18n-catalog.generated.ts`; inspect the diff and commit it only when source UI strings changed. Never expose `.env`, `.env.local`, cookies, tokens, provider keys, database URLs, or real user content in logs, fixtures, screenshots, commits, or reviews.

For a local development server:

```sh
npm run dev
```

Before starting or exercising it, assert that `DATABASE_URL` targets a disposable non-production database, `NEXT_PUBLIC_APP_URL` is the intended local/development origin, and storage/relay/provider settings are non-production or disabled. Stop if that cannot be proven. Use a disposable development account for mutation tests. Redact Authorization/Cookie headers and private payloads from traces.

## Database safety

- `prisma/schema.prisma` plus reviewed migrations are the database source of truth.
- Migrations must be additive/backward-compatible during rollout and include rollback/recovery notes.
- Create and test migrations only against a disposable or sanitized production-like database.
- Never run `prisma db push`, destructive SQL, backfills, or migration repair against production from an agent session.
- Production deployment must converge on `prisma migrate deploy`; the current workflow's `prisma db push` is a documented blocker, not precedent.
- Do not rotate credentials, encryption keys, or Auth.js secrets without explicit approval and a tested data/key migration.

## Architecture and source-of-truth rules

1. The running web product, current server behavior, Prisma schema, authorization/entitlement logic, and tests outrank stale README claims.
2. `juno` is the only canonical account backend. Do not create a native-only account database or duplicate business rules in the app.
3. New native transport lives under versioned `/api/v1` contracts and calls shared domain logic where possible. Preserve existing web endpoints until compatibility tests and rollout gates permit retirement.
4. Native app credentials are app-scoped device sessions. Never return an Auth.js cookie/session token in a URL or give it to a sidecar.
5. Server account data is authoritative. Mutations require stable idempotency keys, revisions, receipts, cursor changes, and tombstones as defined in `docs/rebuild/03-api-and-sync-protocol.md`.
6. Backend model metadata and exact supported effort values are authoritative. Native/offline manifests are generated, never curated separately.
7. Semantic design tokens should come from one machine-readable source with generated web and Swift bindings.
8. Hidden chain-of-thought must not be exposed or persisted as such. Contracts may carry only explicitly safe, concise user-facing reasoning summaries and observable actions.

## Authorization and privacy

- Every account query/mutation must derive identity server-side and prove entity ownership. A database ownership warning is not an authorization boundary.
- Treat requests without Origin as non-browser clients, not automatically trusted clients; authenticate and scope them explicitly.
- Files/downloads require authorization or a deliberate revocable share capability; object-key secrecy is insufficient.
- Never silently substitute models, discard mutation/storage failures, or continue unbilled after accounting failures without a durable recovery record.
- Production telemetry excludes credentials, cookies, provider keys, source files, raw prompts/responses, attachment bodies, terminal output, screenshots, and voice transcripts.

## Change discipline

Work on a non-`main` branch or isolated worktree. Keep commits staged and reviewable: audit/docs, schema/contract, server behavior, generated clients, and migration/backfill changes should be separable. Update `docs/rebuild/STATUS.md` with branch, exact checks, failures, decisions, affected endpoints/migrations, and the next slice. Do not mark a parity or security item complete without the evidence required by `docs/rebuild/07-test-and-acceptance-plan.md`.

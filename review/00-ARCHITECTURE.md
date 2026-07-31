# 00 — Architecture: the system as it actually is

Verified against the tree at `main`, commit state of 2026-07-31. Every claim cites `path:line`.

---

## 1. What actually runs

Juno is **one Next.js 15 process** plus two sidecars. There is no separate API service — `src/app/api/**/route.ts` (127 route files, `find src/app/api -name route.ts`) serves both the JSON/SSE API and the RSC UI from the same Node process.

| Process | Source | Port | Managed by |
|---|---|---|---|
| `juno-backend` | Next.js standalone | 3000 | PM2 (`deploy/ecosystem.config.js`) |
| `juno-voice-relay` | `relay/src/server.ts` | 8787 | PM2 |
| `juno-scheduler` | `scripts/scheduled-task-runner.ts` | — | PM2 |

Fronted by nginx (`deploy/nginx.conf.template`), TLS via Certbot. A fourth compute surface exists but is ephemeral: **GitHub Actions**, dispatched per Cloud Code task (`.github/workflows/code-runner.yml:1`).

Data: PostgreSQL — **Supabase**, not Neon. `.env` `DATABASE_URL` resolves to `aws-0-eu-west-1.pooler.supabase.com:5432`. `prisma/schema.prisma:14` reads `DATABASE_URL` for runtime, `prisma/schema.prisma:25` reads `DIRECT_URL` for schema operations. Object storage is S3-compatible via `src/lib/storage.ts`, with a local `.uploads` disk fallback.

### Trust boundaries

There are seven, and they are not equally hardened.

1. **Browser → Next.js.** Cookie session (NextAuth JWT). CSRF enforced by origin check in `src/middleware.ts:45-72`. Requests with **no** `Origin` header pass unchecked (`src/middleware.ts:57`) — deliberate, so native clients and Stripe work, but it means the only thing standing between a cross-site form POST and a state change is that modern browsers always send `Origin` on mutating fetches.
2. **Native app → Next.js.** Bearer JWT, `aud: juno-native`, 10-minute TTL, HS256 with a key namespaced off `AUTH_SECRET`. `src/lib/session.ts:16-31`: **if an `Authorization` header is present the bearer is authoritative and never falls back to the cookie** — this is the correct decision and is implemented correctly.
3. **GitHub Actions runner → Next.js.** OIDC JWT verified in `src/lib/github-oidc.ts`, exchanged once at `src/app/api/code/tasks/[id]/runner-context/route.ts` for a short-lived `cct_` task token. No secret rides workflow inputs (`.github/workflows/code-runner.yml:368-374`). This is the best-designed boundary in the repo.
4. **Model provider → Juno.** Provider responses (including MCP tool results and web-search page content) re-enter the model's context. **This boundary has no sanitisation layer** — see [02-SECURITY.md](02-SECURITY.md) §4.
5. **Anthropic MCP infrastructure → Juno.** `/api/mcp/[connector]` is dialled *from outside* by the provider, authenticated by a short-lived HMAC (`src/lib/connector-token.ts`, verified at `src/app/api/mcp/[connector]/route.ts`). Correctly does not use session auth.
6. **Artifact code → the app.** Opaque-origin iframe, `sandbox="allow-scripts allow-popups allow-forms allow-modals"` with **no** `allow-same-origin` (`src/components/canvas/sandbox-frame.tsx`). Genuinely well done.
7. **Stripe → Juno.** Signature-verified (`src/app/api/stripe/webhook/route.ts:66`). Exempted from the CSRF middleware at `src/middleware.ts:22`.

### Data flow: one chat turn

```
Browser  ──POST /api/chat (SSE)──►  handleChat()                src/app/api/chat/route.ts:490
                                     ├─ getCurrentUser()         session or bearer
                                     ├─ first-submission receipt lookup  :499-540
                                     ├─ rateLimit chat:<uid> 30/60s      :542-547
                                     ├─ quickScreen moderation           :610-628
                                     ├─ model resolve / Auto route       :636-717
                                     ├─ checkBudget + consumeMessage
                                     ├─ buildSystemPrompt()      src/lib/anthropic.ts:50
                                     ├─ streamChat()             src/lib/llm.ts
                                     │    ├─ streamAnthropic     src/lib/anthropic.ts
                                     │    ├─ streamOpenAIResponses src/lib/openai-responses.ts
                                     │    └─ streamOpenAICompat  src/lib/openai-compat.ts  (12 providers)
                                     ├─ enforceStreamBudget (mid-stream abort)  :870 / :2101
                                     ├─ persistArtifacts / message write
                                     └─ recordSpend() → ApiSpend ledger
                                                │
                        Postgres triggers ──► AccountChange (BIGSERIAL cursor)
                                                │
              native client ◄── GET /api/v1/changes  ◄── EntityRevision
```

The provider stream is bound to a **generation-scoped** `AbortController`, not the request signal (`src/app/api/chat/route.ts:758`, `:1706`), and `send()` swallows enqueue errors — so generation and persistence survive a client disconnect. This is correct and non-obvious; most implementations get it wrong.

---

## 2. API surface vs the published contract

`contracts/openapi/juno-native-v1.yaml` is the single contract file. `scripts/check-native-swift-contract.mjs` gates drift in CI (`.github/workflows/native.yml:631-642`).

**Routes the contract covers:** the 15 `/api/v1/*` routes, plus operation-level entries for the bearer-capable general routes (`/api/chat`, `/api/chat/cancel`, `/api/chat/receipt`, `/api/conversations/{id}/messages`, `/api/upload`, `/api/attachments/{id}`), per `docs/JUNO.md:1179-1181`.

**Routes with no contract entry — 106 of 127.** That is by design for the web-only surface, but three groups are consumed by native clients today and are *not* in the contract, which is a real gap:

| Uncovered route group | Native consumer | Risk |
|---|---|---|
| `/api/code/devices/**` (8 routes) | macOS Code host + iOS remote control | The entire phone↔Mac protocol is unversioned. A server-side shape change silently breaks shipped apps. |
| `/api/voice/relay-token`, `/api/voice/stt`, `/api/voice/tts` | iOS/macOS voice | Same. |
| `/api/models` | native falls back here when `/api/v1/models` 304s | Two catalog shapes, one contract entry. |

**Contract entries with no route: none found.** The generator/checker pair prevents this.

---

## 3. Test coverage vs critical paths

25 files under `tests/`, all at the top level (`npm test` runs `tsx --test tests/*.test.ts` — `package.json:16`, note the glob does not recurse), plus four standalone `scripts/test-*.ts`.

| Critical path | Covered? | Evidence |
|---|---|---|
| Password hashing / token helpers | ✅ | `scripts/test-auth.ts`, `tests/native-auth-core.test.ts` |
| Message encryption at rest | ✅ | `scripts/test-message-crypto.ts` |
| Moderation fail-open | ✅ | `scripts/test-moderation.ts` (scrubs provider keys to force the fail-open path) |
| Memory backfill / suppression | ✅ | `scripts/test-memory.ts` |
| Code-remote-session event ordering | ✅ | `tests/` (planner/ordering) |
| **`POST /api/chat` — the 2,129-line core** | ❌ **none** | no test file references `handleChat` or the chat route |
| **Stripe webhook / plan transitions** | ❌ none | |
| **Authorization (IDOR) on any route** | ❌ none | |
| **Provider adapters (`openai-compat.ts`, `anthropic.ts`)** | ❌ none | |
| **Budget enforcement / spend maths** | ❌ none | `src/lib/spend.ts` is money code with zero tests |
| **Prisma ownership guard** | ❌ none | `src/lib/db.ts:83` |

The tests that exist are good. They cover the parts that are easy to test in isolation and skip everything where the money and the data live. CI runs `tsc --noEmit`, `npm test`, `npm run lint` on push to `main` (`.github/workflows/deploy.yml:391-411`) — **but only on push, never on pull_request**, so the web surface has no PR gate. `native.yml` does gate PRs (`.github/workflows/native.yml:607`).

Typecheck currently **passes clean** (`npx tsc --noEmit`, exit 0, verified 2026-07-31). Migrations apply cleanly to an empty database (`prisma migrate deploy` against a fresh PG 17, 45 migrations, all applied).

---

## 4. Doc-vs-code drift

`docs/JUNO.md` is 1,474 lines and is, by a wide margin, the best-maintained artefact in the repo. The drift below is real but narrow — most of it is one refactor that landed without a doc update.

| # | Doc says | Code says | Severity |
|---|---|---|---|
| D1 | §19 (`docs/JUNO.md:1303-1307`): "`DIRECT_URL` … is **not currently wired** — `prisma/schema.prisma`'s datasource reads only `DATABASE_URL` … it can be dropped." | `prisma/schema.prisma:25` has `directUrl = env("DIRECT_URL")`, and `.github/workflows/deploy.yml:527-536` **hard-fails the deploy** if `DIRECT_URL` is missing. It is load-bearing. | **High** — the doc actively tells you to delete a var that breaks deploys. |
| D2 | §20.2 (`:1356-1359`): "The deploy derives it by stripping `-pooler` from `DATABASE_URL` at migrate time." | Removed. `.github/workflows/deploy.yml:521-526` explains why that heuristic was abandoned and reads `DIRECT_URL` explicitly. | High (same root cause as D1) |
| D3 | §20.2 (`:1348`): "the reference deployment uses **Neon**" | `.env` `DATABASE_URL` → `aws-0-eu-west-1.pooler.supabase.com`. Supabase, eu-west-1. `.env.example:82-90` already documents Supabase correctly. | Medium — the doc's P3009/P1002 war stories are Neon-framed but Supabase-accurate. |
| D4 | §20.3 (`:1380-1381`): "**Three** workflows live in `.github/workflows/`" | Four. `native.yml` exists and is not mentioned anywhere in `docs/JUNO.md`. | Medium |
| D5 | §17 (`:1197`) and §2 (`:103`): "49 models, 13 enums" | `grep -c '^model ' prisma/schema.prisma` → **48**. Enums: 13 ✅. | Low |
| D6 | §2 (`:111`) and `README.md:58`: "~120 route handlers" | 127. | Low |
| D7 | §11.2 (`:921`) lists `STRIPE_PRICE_MAX20` as required; §11.1 sells MAX20 at €200. | **`STRIPE_PRICE_MAX20` is absent from both `.env` and `.env.example`.** The upgrade page renders the ×20 tier (`src/app/(app)/upgrade/page.tsx:17`) and checkout 503s (`src/app/api/stripe/checkout/route.ts:20`). | **Critical** — see [01](01-CODE-REVIEW.md) §3.1. |
| D8 | §18 (`:1263`): at-rest encryption "keyed by `AUTH_SECRET`-derived keys (rotatable via `TOKEN_ENCRYPTION_KEYS`/`TOKEN_ENCRYPTION_PRIMARY`)" | Production `.env` sets `DATA_ENCRYPTION_KEY`, which appears in neither §19's table nor `.env.example`. | Medium — an undocumented var holds the data-encryption key. |
| D9 | §12 (`:975`): "Admin API routes return **404** (not 403) to non-owners to hide the surface." | True for `admin/moderation` (`:14`), `admin/users/[id]/unban` (`:11`). **False for `admin/announcements`** — `src/app/api/admin/announcements/route.ts:11` and `:24` return **403**, and so do `admin/announcements/[id]` and `/upload`. | Low (existence oracle on 3 routes) |
| D10 | §2 repository layout (`:102-135`) | Omits `native/` (835 tracked files), `dist/`, `public/downloads/`, `contracts/` is listed but `docs/native/` (26 files) is not. The doc says it "does not document the native clients themselves" (`:13-14`) — fair — but the layout tree should still show the directory exists. | Low |
| D11 | §6.2 (`:600`): "14 providers" | `src/lib/providers.ts:20` `PROVIDERS` — 14 ✅, including `meta` marked decommissioned. Accurate. `.env` still carries `META_API_KEY`/`META_BASE_URL` for a dead API. | Low (env cruft only) |
| D12 | §21 (`:1464`): "Tests … cover auth token/locale helpers, message crypto, moderation logic, memory backfill/suppression, clarify, and the code-remote-sessions ordering/planner logic." | Accurate, and honest by omission — but it never states that the chat route, billing, and authorization have **no** tests. | Medium (a reader would infer more coverage than exists) |
| D13 | §11.1 (`:903-909`) prices the plans as bare numbers "20 / 100 / 200"; `src/lib/plans.ts:8` comments "Display price in **USD** per month". | The upgrade page renders **`20 €` `HT/mo`** (`src/app/(app)/upgrade/page.tsx:136`), and `src/lib/spend.ts:29` defines budgets in **EUR**. Three currencies' worth of ambiguity in one product. | Medium — see [03](03-PRODUCTION-READINESS.md) §6. |

**Not drift** (checked and confirmed accurate): the SSE event union (§5.1), the idempotency/receipt protocol (§5.7), the sync trigger design (§16), the sandbox iframe flags (§4.3), the rate-limit table (§11.4), the auth scheme including the `sessionVersion` invalidation (§15), the Cloud Code OIDC handshake (§9.3). These are described precisely and match the code.

---

## 5. Structural observations

- **`src/lib/db.ts:83` is a genuine piece of defence-in-depth**: a Prisma `$extends` query guard that throws in dev and logs in prod when a user-owned model is queried without a `userId` filter. Sixteen models are guarded (`:24-42`). Eleven user-owned models are **not**: `Share`, `SavedPrompt`, `ScheduledTask`, `VoiceTranscriptSession`, `ModerationFlag`, `CodeRemoteSession`, `CodeRemoteSessionEvent`, `CodeSessionCommand`, `CodeWorkspace`, `NativeDeviceSession`, `NativeAuthorizationCode` (derived: `awk '/^model /{m=$2} /userId +String/{print m}' prisma/schema.prisma` minus the guard list). The three sync tables key on `accountId`, which the guard's `whereHasUserId` (`src/lib/db.ts:58`) does not recognise at all.
- **`src/app/api/chat/route.ts` is one 2,129-line function** (`handleChat`, `:490`→`:2619`) containing **two near-identical streaming loops** — private mode at `:766-1145` and normal mode at `:1808-2515`. Both independently implement `send`, the activity log, `enforceStreamBudget`, usage accumulation, spend recording and the `finally` teardown. This is the single largest maintenance liability in the codebase and the reason the chat pipeline has no tests.
- **127 of 440 `.ts`/`.tsx` files under `src/` carry `"use client"`** (29%). For an app this interactive that is reasonable, not sprawl.
- **TypeScript rigour is unusually high**: `strict: true` (`tsconfig.json:9`), 5 total `any`/`as any` sites across `src/`, **zero** `@ts-ignore`/`@ts-expect-error`/`@ts-nocheck`, 73 non-null assertions, 23 `eslint-disable` comments (12 of them `react-hooks/exhaustive-deps`, 6 in `chat-view.tsx` alone). `next.config.mjs:5-9` disables type-checking *during the build* with a documented reason (1 GB VM OOM) and CI compensates with a real `tsc --noEmit` gate.

# 01 — Code review

Grouped by subsystem, ordered by blast radius. Severity: **Critical** = data loss / breach / revenue loss · **High** = broken for real users or blocks launch · **Medium** = degrades quality or velocity · **Low** = polish.

Before the findings, the honest headline: **this is well-written code.** `strict: true` with five `any` sites and zero `@ts-ignore` across 440 files, a Prisma ownership guard, atomic conditional quota increments, generation-scoped abort controllers that survive client disconnect, an opaque-origin artifact sandbox, and comments that explain *why* rather than *what* — repeatedly citing the specific bug that motivated the current shape. The problems below are concentrated in three places: **billing**, **one enormous function**, and **operational assumptions that have already stopped being true**.

---

## 1. Chat pipeline — `src/app/api/chat/route.ts`

### 1.1 `handleChat` is a 2,129-line function with the streaming loop written twice — **High**

`src/app/api/chat/route.ts:490` opens `handleChat`; `:2619` is the next top-level declaration. Inside it, two near-identical `ReadableStream` bodies:

- private mode `:766-1145`
- normal mode `:1808-2515`

Each independently declares `send()` (`:768`, `:1808`), the activity log and `sendActivity`, ~14 usage accumulator variables (`:786-804`), `enforceStreamBudget` (`:870`, `:2101`), the `recordSpend` call (`:1011`/`:1101`, `:2302`/`:2414`), and the `finally` teardown (`:1140`, `:2509`). A third, smaller stream body exists at `:2524`.

**Why it matters.** Every fix to streaming, cancellation, spend or usage has to be made twice, and the two copies have already diverged: the normal path calls `persistArtifacts` (`:2249`, `:2385`) and the private path does not; the normal path has two `recordSpend` sites with different shapes. There are no tests for any of it because the function is untestable without a full request, a database and a live provider.

**Fix — a concrete decomposition, in migration order.** Each step is independently shippable and behaviour-preserving.

| # | Extract to | Contents | Lines moved | Risk |
|---|---|---|---|---|
| 1 | `src/lib/chat/responses.ts` | `alreadySubmittedResponse`, `firstSubmissionInProgressResponse`, `firstSubmissionRecoveryResponse`, `idempotencyKeyConflictResponse`, `generationFailureCode`, `classifyErrorFinishReason`, `isAbortLike`, `appendFinishWarning` (`:347-489`) | ~145 | **Low** — pure functions, no state |
| 2 | `src/lib/chat/usage-accumulator.ts` | the 14 `let` counters + `buildUsage` (`:227`) behind a small class with `absorb(chunk)` / `snapshot()` | ~180 | **Low** — mechanical; makes spend testable in isolation |
| 3 | `src/lib/chat/sse.ts` | `encodeChunk`, `send`, `sendActivity`, the 15 s heartbeat, `ping` | ~90 | **Low** |
| 4 | `src/lib/chat/preflight.ts` | auth → parse → receipt recovery → rate limit → moderation → plan → model resolution → connector resolution (`:490-722`). Returns a discriminated `{ ok: true, ctx } \| { ok: false, response }`. | ~235 | **Medium** — the receipt-recovery ordering at `:494-540` is subtle and deliberately runs *before* rate limiting; preserve that comment and add a test |
| 5 | `src/lib/chat/budget-guard.ts` | `enforceStreamBudget` as a class taking `(remainingMicroUsd, rates)` and exposing `observe(tokens)` | ~60 | **Medium** — money path; test first |
| 6 | `src/lib/chat/run-generation.ts` | the shared streaming loop, parameterised by a `persistence` strategy (`private` = no-op, `saved` = full). **This is the step that deletes the duplication.** | ~700 → ~380 | **High** — do it last, behind a feature flag, with the two paths diffed line-by-line first |

After 1–5 the route file is ~1,100 lines and step 6 becomes reviewable. Do not attempt step 6 first.

### 1.2 The cost of a trivial turn is ~7.3K tokens — **Medium**

Observed live: a 30-word question answered with three bullets and six lines of Python billed **7.3K tokens / $0.037** (screenshot `29-answer-complete.png`, footer). The per-turn fixed overhead is `buildSystemPrompt` (`src/lib/anthropic.ts:50`) plus the injected memory summary plus recent facts plus project context — injected **every turn** with no retrieval (`docs/JUNO.md:701-703` confirms "no embeddings / semantic retrieval — retrieval injects the whole consolidated summary plus recent facts every turn").

At PRO's €11 budget (`src/lib/spend.ts:29`), $0.037/turn is **~300 messages a month**, on a plan advertised as "unlimited" with a "monthly usage limit based on tokens" (`src/app/(app)/upgrade/page.tsx`). That is a real product ceiling that neither the pricing page nor the docs state. Anthropic prompt caching (`docs/JUNO.md:638`) mitigates the *cost* of the stable prefix but the memory block is appended after the cache breakpoint on any turn where memory changed.

**Fix:** measure the fixed overhead per model, publish the real message estimate on the upgrade page, and make memory injection budget-aware (cap the summary at N tokens, drop `recentFacts` when the conversation is long).

### 1.3 `refundMessage` is read-then-write, not atomic — **Low**

`src/lib/usage.ts:104-114` reads `messageCount`, checks `> 0`, then decrements. Two concurrent failed generations can both read `1` and both decrement to `-1`. Harmless today (FREE is 0 and paid plans are `null`/unlimited, so the counter is accounting-only) but it is the one place in the quota code that abandons the atomic pattern used correctly at `:66-72`.

**Fix:** `updateMany({ where: { userId, period, messageCount: { gt: 0 } }, data: { decrement: 1 } })`.

### 1.4 Auto-routing failure degrades silently to "first eligible model" — **Medium**

`src/app/api/chat/route.ts:682-685`: if `pickAutoModel` throws, `modelInfo` is set to `undefined` and the fallback at `:698-705` picks `MODEL_LIST.find(...)` — the **first** configured, plan-allowed chat model in registry order. A user who selected "Auto" expecting cheapest-first routing silently gets whatever is first in the list, with no `activity` event saying so. The error is logged (`:683`) but never surfaced.

**Fix:** emit an `activity` warning event when the fallback fires, and make the fallback prefer the cheapest eligible model rather than the first.

---

## 2. Provider abstraction

### 2.1 `isProviderConfigured` tests for a non-empty string, nothing else — **High**

`src/lib/providers.ts:165-167`:
```ts
export function isProviderConfigured(p: Provider): boolean {
  return Boolean(providerApiKey(p));
}
```

This is the *only* gate between a provider and the model picker. It cannot tell a working key from a revoked one, and it cannot tell a funded account from an empty one.

**This is not hypothetical — it is the current state of production.** Probing the keys in the production `.env` on 2026-07-31:

| Provider | Result |
|---|---|
| anthropic | `400 invalid_request_error` — *"Your credit balance is too low to access the Anthropic API"* |
| openai | `429` — *"You have no credits remaining"* |
| deepseek | `402 Insufficient Balance` |
| xai | `403` on `/v1/models` — key invalid or revoked |
| mistral | ✅ `200` |
| qwen (DashScope) | ✅ `200` |
| google | key valid; `gemini-2.5-flash` returns `404 no longer available to new users` |

Anthropic is `DEFAULT_MODEL` (`src/lib/models.ts:535`) **and** the utility model behind auto-titling, memory extraction, the moderation classifier, clarify triage and the entire i18n translation route (`src/app/api/i18n/translations/route.ts` → `runUtilityPrompt`). With that key dead, the default path of the shipped product returns *"Anthropic · Claude reports no remaining balance or quota"* — reproduced in `review/screenshots/` (the first `29-answer-complete` capture, before I switched to Mistral).

**Fix (three parts, all needed):**
1. A periodic key-health probe per provider (a 1-token completion, cached 10 min) feeding a `providerHealthy` flag; unhealthy providers drop out of `loadAvailableModels()` and the picker.
2. Alerting on transition to unhealthy — this is the single highest-value alert the product could have.
3. Never surface the provider's own billing text to the end user (see 2.2).

### 2.2 Provider billing errors leak verbatim to the user — **Medium**

The UI renders *"Anthropic · Claude reports no remaining balance or quota. Top up that account, or pick another model."* to a **paying Juno subscriber**. Juno has no BYOK (`docs/JUNO.md:493`), so "that account" is Juno's, and "top up" is advice the user cannot act on. It discloses vendor-relationship state and reads as a broken product.

**Fix:** map provider auth/billing/quota errors to a single user-facing class — *"Claude is temporarily unavailable. Try another model."* — plus an operator-facing log line and an alert. Keep the actionable errors (context-length, content-filter, rate-limit) verbatim.

### 2.3 Error mapping is per-adapter, not shared — **Medium**

`src/lib/anthropic.ts`, `src/lib/openai-compat.ts` (562 lines, 12 providers) and `src/lib/openai-responses.ts` each classify errors independently, and `classifyErrorFinishReason` (`src/app/api/chat/route.ts:352`) re-classifies on top. A DeepSeek `402` and an OpenAI `429` are semantically the same event (account out of funds) and arrive as different shapes. There is no `ProviderError` union.

**Fix:** one `normalizeProviderError(provider, err): { class: "auth"|"billing"|"rate_limit"|"context"|"content_filter"|"capacity"|"unknown", retryable, userMessage, operatorMessage }`, called by all three adapters.

### 2.4 Model catalog drift is real and one-directional — **Medium**

`google:gemini-2.5-flash` is in the registry but Google returns `404 … no longer available to new users`. `meta` is marked decommissioned (`docs/JUNO.md:619`) yet `META_API_KEY`/`META_BASE_URL` remain in production `.env`. The nightly `sync-models.yml` discovers *new* models and marks vanished ones `UNAVAILABLE`, but it runs `|| true` on every step (`.github/workflows/sync-models.yml:217`, `:222`, `:225`) so a total fetch failure is indistinguishable from "nothing changed", and `validate:models` only enforces internal invariants — it never calls a provider.

**Fix:** make `sync:models` fail loudly when *zero* providers responded, and add a `lastVerifiedAt` to generated entries so a model unverified for N days is hidden from the picker.

### 2.5 `xSearchRequests` / `webSearchRequests` are accumulated in two places with no shared type — **Low**

`src/app/api/chat/route.ts:796-797` declares them per-branch; `src/lib/pricing.ts` applies the fee. A provider that reports search usage in a new field silently under-bills. Covered by the step-2 extraction in §1.1.

---

## 3. Billing — the highest-risk subsystem

### 3.1 MAX20 is sellable in the UI and unbuyable in production — **Critical**

- `src/lib/plans.ts:96-115` defines MAX20 at 200/month with `priceEnvKey: "STRIPE_PRICE_MAX20"`.
- `src/lib/plans.ts:117` puts it in `PLAN_LIST`; `src/app/(app)/upgrade/page.tsx:17` renders it as a `×20` toggle inside the Max card (visible in `review/screenshots/41-upgrade-desktop-light.png`).
- `src/app/api/stripe/checkout/route.ts:9` accepts `"MAX20"`, `:20` returns **503 "Plan price is not configured."** when `priceIdForPlan` returns undefined.
- **`STRIPE_PRICE_MAX20` is set in neither `.env` nor `.env.example`.**

The highest-value plan in the product presents a purchase button that returns a server error. `docs/JUNO.md:921` lists the variable as required, so this is a deployment omission the docs already warned about and nothing enforces.

**Fix:** either set the price id, or gate `PLAN_LIST` on `priceIdForPlan(plan) !== undefined` so an unconfigured tier does not render. Do the second regardless — it makes the class of bug impossible.

### 3.2 An unknown Stripe price id silently downgrades a paying subscriber to FREE — **Critical**

`src/app/api/stripe/webhook/route.ts:34`:
```ts
const plan = planFromPriceId(priceId) ?? "FREE";
```
`planFromPriceId` (`src/lib/stripe.ts:13-19`) compares against exactly three env values. Any price id not in that set — a legacy price, a price created in the dashboard, a promotional price, a currency variant, or a price whose env var was not deployed (see 3.1) — maps to `"FREE"`. And `FREE` is `monthlyMessages: 0` (`src/lib/plans.ts:33`).

So the failure mode is: **a customer keeps being charged by Stripe and is locked out of the product entirely**, triggered by a routine dashboard action. There is no alert, no log line, and `syncSubscription` writes the downgrade unconditionally.

**Fix:**
```ts
const plan = planFromPriceId(priceId);
if (!plan) {
  console.error("[stripe] unknown price", { priceId, customerId, subId: sub.id });
  return; // leave the existing plan intact
}
```
plus an alert on that log line. Never let an unrecognised input become a downgrade.

### 3.3 No event ordering or replay protection on the webhook — **High**

`syncSubscription` (`src/app/api/stripe/webhook/route.ts:25-52`) writes unconditionally. Stripe does not guarantee ordering and retries on any non-2xx. A `customer.subscription.updated` emitted before a cancellation but delivered after it will resurrect a cancelled plan; a redelivered stale event does the same.

**Fix:** store `lastStripeEventAt` on `Subscription` and ignore events with `event.created` older than it; or (simpler and strictly better) ignore the event payload entirely and re-`retrieve` the subscription from Stripe inside the handler, using that as truth.

### 3.4 A missing `Subscription` row makes every webhook a silent no-op — **High**

`src/app/api/stripe/webhook/route.ts:30-31`: `findFirst({ where: { stripeCustomerId } })`, and `if (!record) return;`. The checkout route creates the customer and writes `stripeCustomerId` first (`src/app/api/stripe/checkout/route.ts:29-36`), but those are two non-transactional steps: if `stripe.customers.create` succeeds and the following `prisma.subscription.update` fails, the user has a Stripe customer that Juno cannot recognise, forever.

`checkout.sessions.create` already sets `client_reference_id: user.id` and `metadata.userId` (`:41`, `:44-45`) — the fallback exists and is unused.

**Fix:** on `!record`, fall back to `sub.metadata.userId` / the session's `client_reference_id`, and log loudly when both miss. Wrap the customer-create + row-update in a transaction or make it idempotent by looking up the customer by `metadata.userId` before creating.

### 3.5 Concurrent checkout creates duplicate Stripe customers — **Low**

Two simultaneous `POST /api/stripe/checkout` both see `sub.stripeCustomerId == null` (`:28`) and both create a customer; the second `update` wins and the first is orphaned. Low likelihood, but it produces exactly the state in 3.4.

### 3.6 Budget maths has no tests — **High** (process, not a defect)

`src/lib/spend.ts` converts EUR budgets to micro-USD (`:44-47`), computes per-token rates (`:73-77`), and applies flat media prices (`:96-105`) — with an `eurPerUsd()` that defaults to **1.0** when `API_COST_EUR_PER_USD` is unset (`:38-41`). It is unset in `.env.example`. Every budget is therefore currently enforced as though €1 = $1. Whether that is intended is unclear from the code; the comment at `:15` says "treated 1:1 … unless `API_COST_EUR_PER_USD` says how many EUR one USD of model spend costs". Given the €/$ rate this makes budgets ~8% more generous than the sizing comment at `:20-27` assumes.

**Fix:** test `budgetForPlan`, `modelRequestCost`, `mediaRequestCost` and the `max(fromTokens, callerEstimate)` reconciliation. Money code with zero tests is the finding.

---

## 4. Data layer

### 4.1 Eleven user-owned models bypass the ownership guard — **Medium**

`src/lib/db.ts:24-42` lists 16 guarded models. Models with a `userId` column that are **not** in the set: `Share`, `SavedPrompt`, `ScheduledTask`, `VoiceTranscriptSession`, `ModerationFlag`, `CodeRemoteSession`, `CodeRemoteSessionEvent`, `CodeSessionCommand`, `CodeWorkspace`, `NativeDeviceSession`, `NativeAuthorizationCode`. The guard's comment (`:18-21`) explains the deliberate exclusions (`Message`, `Artifact`, `ArtifactVersion`, `CodeTaskEvent`, and the auth-adapter models) — these eleven are not among them and look like drift as models were added.

Also: `whereHasUserId` (`:58-66`) only looks for the literal key `userId`, so the three sync tables keyed on `accountId` (`AccountChange`, `EntityRevision`, `MutationReceipt`) are unguardable as written.

**Fix:** add the eleven; teach `whereHasUserId` about `accountId`; add a unit test that derives the guarded set from the schema and fails when a new `userId` model is added without a decision.

### 4.2 The guard accepts a `userId` anywhere in the tree, including inside `OR` and `NOT` — **Low**

`src/lib/db.ts:60-65` recurses through arrays and objects and returns `true` on the first `userId` key. `where: { OR: [{ userId: me }, { id: someOtherId }] }` passes the guard while returning another user's row. No such query exists today; the guard just cannot catch that shape.

### 4.3 `create`, `upsert`, `count`, `aggregate` and `groupBy` are unguarded — **Low**

`GUARDED_OPERATIONS` (`src/lib/db.ts:44-54`) omits them. `count`/`aggregate`/`groupBy` on a guarded model can leak cross-tenant counts.

### 4.4 `GET /api/files/[...key]` loads whole objects into memory to serve ranges — **High**

`src/app/api/files/[...key]/route.ts:56` calls `getObjectBytes(k)` — the entire object — then slices for the `Range` response further down. Uploads are capped at 50 MB (MAX) / 1 GB (OWNER) per `src/lib/plans.ts`, and nginx allows `120m` bodies (`docs/JUNO.md:1339`). PM2 restarts `juno-backend` at ~1.4 GB (`docs/JUNO.md:1343`).

A handful of concurrent range requests on one large video will OOM-restart the backend, killing every in-flight SSE stream on the box. Safari issues a `Range: bytes=0-1` probe then a full request, so this triggers on ordinary playback.

**Fix:** stream from S3 with the `Range` header forwarded (`GetObjectCommand` accepts `Range`), and stream the local-disk fallback with `fs.createReadStream(path, { start, end })`.

### 4.5 `canReadObject` runs up to three unindexed lookups per file request — **Medium**

`src/app/api/files/[...key]/route.ts:18-34`: `Attachment.findFirst({ storageKey })`, then `User.findFirst({ image: url })`, then `Announcement.findFirst({ OR: [imageUrl, videoUrl] })`. `User.image` and `Announcement.imageUrl`/`videoUrl` have no index in `prisma/schema.prisma`. Every avatar render does a sequential scan of `User`.

**Fix:** index `Attachment.storageKey`, `User.image`, `Announcement.imageUrl`, `Announcement.videoUrl`; or better, encode the object class in the key prefix (`uploads/<uid>/avatar/…`) and branch on it.

### 4.6 Unbounded `findMany` on growth tables — **Medium**

Derived by AST-walking every `.findMany(` call for a missing `take:`. Most hits are safe (bounded by `id: { in: ids }` with `ids.length ≤ 100` in `src/lib/sync-entities.ts`). These are not:

| Site | Query | Growth |
|---|---|---|
| `src/lib/queries.ts:54` | every `Message` in a conversation, with `attachments` and `versions` included | Unbounded per conversation. A 500-turn chat loads 500 rows + attachments + version metadata to render one page. |
| `src/lib/queries.ts:64` | every `Artifact` in a conversation, `include: { versions: true }` — **all version bodies** | Artifact versions are append-only. A heavily-iterated canvas artifact loads every historical body. |
| `src/lib/memory.ts:172` | every `MemoryEntry` for the user on **every** `saveCandidates` call | Grows for the life of the account; runs after every assistant turn. |
| `src/lib/memory.ts:158` | every `SUPPRESSION` row | Same. |
| `src/lib/share.ts:125` | all active shares | Bounded in practice. |
| `src/lib/app-data.ts:28` | all folders | Bounded in practice. |

`queries.ts:54/64` is the one that will hurt first — it is on the critical path of opening a conversation.

**Fix:** paginate messages (newest N, older on scroll), select only `currentVersion` for artifacts, and replace the memory dedup read with a `SELECT … WHERE normalize(content) IN (…)` on the candidate set.

### 4.7 `RateLimit` rows are never pruned — **Low**

`src/lib/rate-limit.ts:26-32` upserts by key and never deletes. `docs/JUNO.md:1436` documents pruning `AccountChange`/`MutationReceipt` but not this. Bounded by distinct (user × bucket) + (IP × bucket), so it grows with the user base and never shrinks.

**Fix:** `DELETE FROM "RateLimit" WHERE "expiresAt" < now() - interval '1 day'` in `scripts/prune-sync.ts`.

### 4.8 Migration history is clean — **no finding**

45 migration directories, applied cleanly to an empty PostgreSQL 17 database (`prisma migrate deploy`, verified 2026-07-31). No `DROP COLUMN` on a populated table without a preceding backfill, no `ALTER TYPE` rewrite of a large table. The change-capture triggers are applied as ordinary migration SQL. The only operational hazard is the `db push` → migration convergence path in `.github/workflows/deploy.yml:552-560`, which is one-time and already guarded by `scripts/baseline-production-migrations.mjs --status`.

---

## 5. React / Next.js

### 5.1 Twelve `react-hooks/exhaustive-deps` suppressions, six in one file — **Medium**

`src/components/chat/chat-view.tsx:508, 524, 568, 650, 723, 735`; also `src/hooks/use-chat.ts:160, 339`, `src/hooks/use-code-session.ts:187`, `src/components/code/code-session-view.tsx:251, 295`, `src/components/compare/compare-view.tsx:142`, `src/components/chat/composer-clarification-popover.tsx:113`, `src/app/(app)/memory/page.tsx:140`, `src/components/tasks/task-dialog.tsx:94`.

Each is a stale-closure risk in the exact components that own streaming state. None is annotated with *why* the dep is omitted — unlike the rest of this codebase, where the reasoning is usually written down.

**Fix:** for each, either add the dep and memoise the callback, or add a one-line comment stating which value is intentionally captured at mount. The comment alone is worth the change.

### 5.2 `chat-view.tsx` reads `process.env` in a client component — **Low**

`src/components/chat/chat-view.tsx` is the only `"use client"` file that references `process.env.` (grep across all 127 client files). Provided it is `NEXT_PUBLIC_*` this is inlined at build time and correct — but it makes the voice button's availability a **build-time** decision (`docs/JUNO.md:892` confirms: "gated at build time by `NEXT_PUBLIC_VOICE_RELAY_URL`"), so enabling voice requires a rebuild, not a config change. Worth knowing before an incident.

### 5.3 No `<h1>` and no heading structure on the chat surface — **Medium** (also an a11y failure, see [04](04-UX-AUDIT.md))

Live DOM audit of `/chat/[id]`: `h1: []`, and `[...document.querySelectorAll("h1,h2,h3,h4")]` returns `[]`. The primary surface of the product has zero headings.

### 5.4 The streaming transcript is not a live region — **High** (a11y)

Same audit: `[role=log]` → 0, `[role=status]` → 0. `aria-live="polite"` exists on conversation *titles* and on the "Thought process" summary, but **not on the assistant message being streamed**. Detail and fix in [04-UX-AUDIT.md](04-UX-AUDIT.md) §5.

### 5.5 Hydration mismatch at tablet width — **Medium**

Captured during the screenshot sweep at 768×1024: *"A tree hydrated but some attributes of the server rendered HTML didn't match the client properties."* Not reproduced at 390 or 1440. Likely a width- or `localStorage`-derived initial state (sidebar width/collapse is persisted per `docs/JUNO.md:351`) rendered on the server without a `suppressHydrationWarning` or a mount gate.

**Fix:** move any `localStorage`/`matchMedia`-derived initial state behind a `useEffect` mount flag, or render the server default and swap after mount.

### 5.6 God components — **Medium**

| File | Lines | Proposed split |
|---|---|---|
| `src/components/chat/composer.tsx` | 2,335 | `composer-shell.tsx` (textarea + autosize + submit) · `composer-attachments.tsx` (drag/paste/library, `useUploads`) · `composer-commands.tsx` (`/` and `@` palettes) · `composer-tools-menu.tsx` (the `+` menu, connector auto-detect) · `composer-model-controls.tsx` (`ModelSelector` + `ReasoningSlider` + fast mode) · `composer-dictation.tsx` (already separate — keep). **Risk: Medium** — the pieces are already visually separable; the shared state is `value`, `attachments`, `prefs`, and can move to one `useComposerState` hook. |
| `src/components/chat/chat-view.tsx` | 1,875 | `chat-view.tsx` (layout + column orchestration only) · `use-chat-columns.ts` (canvas ⇄ thought-dock mutual exclusion) · `chat-header-actions.tsx` (share, params, private toggle) · `chat-mode-layer.tsx` (the private-mode cross-fade at `modeLayer()`). **Risk: Medium-High** — six `exhaustive-deps` suppressions live here; fix 5.1 *first*, then split. |
| `src/app/globals.css` | 2,637 | Split by concern into `@layer` files imported by `globals.css`: `tokens.css` (the `:root`/`.dark`/`[data-accent]` variables, ~250 lines) · `base.css` · `materials.css` (`.glass-raised`, `.surface-raised`, `.field-well`, shadows) · `motion.css` (keyframes + `prefers-reduced-motion`) · `prose.css` (markdown/KaTeX/highlight.js) · `aicss.css` (`.aicss-*` blocks). **Risk: Low** — pure CSS, ordering is preserved by import order. Do this one first; it is free. |
| `src/lib/i18n-catalog.generated.ts` | 9,468 (195 KB) | Not a god file — a build artefact. See [06-CLEANUP.md](06-CLEANUP.md); it should not be tracked as source. |

---

## 6. Error handling and logging

### 6.1 There is no structured logger — **High** (see also [03](03-PRODUCTION-READINESS.md))

67 `console.error`/`console.warn` and 4 `console.log` calls across `src/`. No request id, no user id, no correlation with the `X-Juno-Request-Id` header that `/api/v1` already emits (`docs/JUNO.md:1145`). PM2 writes them to `logs/` as unstructured text.

### 6.2 `console.log` in production paths — **Low**

Three in `src/app/api`, including `src/app/api/admin/users/[id]/unban/route.ts:18` — `console.log('[admin] unban by ${owner.email}: ${user.email}')`, which writes **two user email addresses in plaintext** to the PM2 log on every unban. `src/app/api/chat/route.ts:674` logs the auto-routing decision at `console.info` on every Auto turn.

**Fix:** log user *ids*, not emails. Move the auto-route line to debug level.

### 6.3 Silent `catch {}` around auth — **Low, by design but worth a comment**

`src/lib/session.ts:22-27`: any exception from `authenticateNativeBearer` returns `null`, indistinguishable from "no credential". Correct for the caller, but it means an expired token, a malformed token, a revoked device and a `sessionVersion` bump are all invisible in logs. Native clients will report "logged out for no reason" and there will be nothing to look at.

**Fix:** log the `NativeAuthError` code (not the token) before returning `null`.

---

## 7. Dead code, unused deps, cruft

Verified unreferenced across `src/`, `native/`, `scripts/`, `relay/`, `runner/` and CI before listing. Acted-on items are in [06-CLEANUP.md](06-CLEANUP.md); *candidates I did not delete* are listed there too.

- **`public/downloads/Juno.dmg` — 21.9 MB tracked binary.** `.gitignore:56-58` already ignores `dist/*.dmg`; this path was missed. It is in git history, so removing it from tracking shrinks the working tree but not the clone.
- **`src/lib/i18n-catalog.generated.ts` — 195 KB, 9,468 lines, regenerated by `predev`/`prebuild`** (`package.json:6,8`). Tracked as source and excluded from lint (`eslint.config.mjs:16`). Every `npm run dev` dirties the working tree.
- **`docs/native/` — 26 files, 3.9 MB.** Contains `HANDOFF.md`, `NEXT_PROMPT.md`, `STATUS.md` (740 lines), `JUNO_CODE_HANDOFF.md`, and five `*_V2.md` files sitting beside their V1 originals. `docs/native/handoff.json`. 11 PNGs totalling ~3.2 MB under `docs/native/design/`, of which the largest single file (`deep-research-ios.png`, 502 KB) is a design-review artefact from a shipped change.
- **`dist/` — 6 tracked files** (`DELIVERY_REPORT.md`, `INSTALL.md`, `RELEASE_NOTES.md`, and three `SHA256SUMS*.txt` including two commit-pinned ones for `b722da0` and `c37010f`). The `.gitignore` comment at `:53-55` says the docs and checksums are deliberately tracked — so this is intentional, but two stale per-commit checksum files are not.
- **`chat.liams.dev.pem` in the working tree** — correctly gitignored (`*.pem`), never tracked. No action, but it should not live in the repo directory at all.
- **`META_API_KEY` / `META_BASE_URL`** in production `.env` for an API that shut down 2026-07-06 (`docs/JUNO.md:619`).
- **Unused dependency:** none found. Every entry in `package.json` `dependencies` resolves to at least one import. `imapflow`/`@types/imapflow` are used by `src/lib/apple/mail.ts`; `pptxgenjs`/`exceljs`/`docx` by `src/lib/office-export.ts`.
- **30 `TODO`/`FIXME`/`HACK`/`XXX` markers** across `src/`. Not enumerated here; most are genuine future-work notes.

---

## 8. Things I checked and found correct

Worth recording so they are not re-litigated:

- **Rate limiter** (`src/lib/rate-limit.ts:26-32`) — single atomic `INSERT … ON CONFLICT` with the window reset inside the `CASE`. Cannot race. `ipFromHeaders` (`:47-56`) correctly prefers `X-Real-IP` and takes the **right-most** `X-Forwarded-For` entry rather than the spoofable left-most one.
- **Quota consumption** (`src/lib/usage.ts:66-72`) — single conditional `updateMany`, no TOCTOU.
- **`GET /api/files/[...key]`** — auth, `..` and prefix guard (`:46-48`), per-object authorization, 404-not-403 (`:51`), magic-byte sniffing, `Content-Disposition: attachment` + `application/octet-stream` for anything not image/video. Textbook. (Its one defect is 4.4, which is about memory, not authorization.)
- **Artifact sandbox** — opaque origin, no `allow-same-origin`, `postMessage` trusted only from the frame's own `contentWindow`.
- **Cloud Code OIDC handshake** — no secret in workflow inputs, single-use `runnerClaimedAt` stamp, browser sessions rejected with 403 so the clone token cannot reach a browser.
- **`getCurrentUser` bearer precedence** (`src/lib/session.ts:16-31`) — a presented bearer never falls back to a cookie. This is the correct and commonly-missed decision.
- **The `finally` teardown** in both stream bodies calls `unregisterGeneration()` (`:1142`, `:2512`, `:2557`) — no leaked entries in the cancellation registry.
- **`dotenv` inline-comment stripping** — `OWNER_EMAILS=…  # ton compte admin` parses to the bare address (verified against `dotenv@16.6.1`). Not a bug.
- **`src/app/dev/*`** — all three dev galleries call `notFound()` when `NODE_ENV === "production"` (`src/app/dev/aicss/page.tsx:13`, `src/app/dev/voice/page.tsx`). Correctly gated.

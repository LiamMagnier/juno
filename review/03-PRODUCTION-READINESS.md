# 03 — Production readiness

---

## 1. Failure modes

What happens when each dependency is down or slow, traced through the code.

| Dependency | Current behaviour | Verdict |
|---|---|---|
| **Postgres unreachable** | Every route throws. `getCurrentUser` → `prisma.user.findUnique` → unhandled → Next 500. No retry, no circuit breaker, no cached-session fallback. The UI shows a generic error. | **Total outage, ugly.** Acceptable for a solo product *if* it is alerted; it is not (§2). |
| **Postgres slow** | No statement timeout is set anywhere. A slow query holds a Supavisor session-pooler connection; the pooler has a fixed slot count, so slow queries cascade into connection exhaustion. | **High risk.** Set `statement_timeout` and a Prisma connection limit. |
| **S3 down** | `POST /api/upload` fails per-request. `GET /api/files` fails per-request. Chat is unaffected unless the turn has attachments. | ✅ **Correctly isolated.** |
| **A provider is down or out of credit** | The stream emits `error` with the provider's own message; the chat route does **not** fall back to another provider. `docs/JUNO.md:640` documents a fast-mode→standard fallback within Anthropic only. | **Broken today** — see [01](01-CODE-REVIEW.md) §2.1. Anthropic, OpenAI and DeepSeek are all out of credit in the production `.env` right now, and they are the default and the top of the picker. |
| **Relay down** | `POST /api/voice/relay-token` polls `/healthz` (`src/app/api/voice/relay-token/route.ts:45`) and reports per-provider availability, so the client degrades cleanly. | ✅ **The one dependency with a real health check.** |
| **Tavily down** | Deep research degrades; the composer toggle only appears when `TAVILY_API_KEY` is set. | ✅ fails soft |
| **Composio down** | Connector directory shows built-ins only. | ✅ fails soft |
| **Resend down** | Password reset silently no-ops; `/api/auth/forgot-password` returns 503 without the key. | ⚠️ A user who cannot reset their password gets a uniform "if that address exists…" response, i.e. **the failure is invisible to them and to you.** |
| **Client disconnects mid-stream** | Generation and persistence continue (generation-scoped `AbortController`, `send()` swallows enqueue errors). | ✅ **Correct and non-obvious.** |
| **Backend OOM mid-stream** | PM2 restarts at 1400 MB (`deploy/ecosystem.config.js:44`). Every in-flight SSE stream on the box dies. The `ChatFirstSubmissionReceipt` lease expires and the client sees `GENERATION_LEASE_EXPIRED`. | ✅ **The receipt protocol is exactly the right design for this.** The remaining problem is that `/api/files` makes OOM easy to trigger ([01](01-CODE-REVIEW.md) §4.4). |

**Missing across the board:** timeouts on outbound provider calls (no `AbortSignal.timeout` on the provider fetches I read), retry with backoff, and any circuit breaker. A provider that accepts the connection and then hangs will hold a Node handle and an SSE stream open until nginx's `proxy_read_timeout 3600s` fires — one hour.

---

## 2. Observability — the weakest area of the whole system

| Capability | Status |
|---|---|
| Structured logs | ❌ 67 `console.error`/`warn` + 4 `console.log`, unstructured, into `logs/*.log` via PM2 |
| Error tracking | ❌ **none.** No Sentry, no OpenTelemetry, no Datadog — grep across `src/` and `package.json` returns zero hits |
| Request IDs | ⚠️ `/api/v1` emits `X-Juno-Request-Id`; nothing else does, and it is not attached to any log line |
| Health check | ❌ **The Next.js backend has no health endpoint.** The relay has `/healthz` (`relay/src/server.ts:29`). PM2 knows the process exists, not that it serves. |
| Uptime monitoring | ❌ none configured in-repo |
| Alerting | ⚠️ exactly one: budget-alert emails at ≥80% of a *user's* plan budget (`src/lib/spend.ts`, `sendBudgetAlert`). Nothing alerts the operator. |
| Metrics | ❌ none |
| Log rotation | ❌ no `pm2-logrotate` in `ecosystem.config.js`; `logs/` grows until the disk fills |

**Can you diagnose a production incident today?** No. Concretely: the Anthropic key ran out of credit at some point before today. Nothing detected it, nothing alerted, and the only symptom is a user-visible error string. That is the test case, and the system failed it.

**Minimum viable fix, in order:**
1. `GET /api/health` returning `{ db: ok|fail, providers: {…}, version }` — 20 lines, and it unlocks everything else.
2. An external uptime monitor hitting it (free tier is fine).
3. Sentry (or equivalent) in `instrumentation.ts` + `global-error.tsx`. This is a `npm i` and ~15 lines.
4. `pm2 install pm2-logrotate`.
5. A provider-key health probe with an alert (see [01](01-CODE-REVIEW.md) §2.1) — the single highest-value alert this product can have.

---

## 3. Deployment

**What is good:** builds happen on GitHub runners, not the 1 GB VM. `concurrency: deploy-main, cancel-in-progress: true` serialises deploys. `PROD_ENV` is a single source of truth, upserted per-key into the VM `.env` with an `.env.bak` rollback, **before** the Prisma steps — and the comment at `.github/workflows/deploy.yml:493-496` explains that this ordering was itself a bug fix. The rsync `--delete` excludes are correct and commented. `DIRECT_URL` is validated and the deploy hard-fails without it (`:527-536`). The migration path is `migrate deploy` after a one-time baseline convergence.

**Findings:**

### 3.1 CI does not gate pull requests for the web surface — **High**
`.github/workflows/deploy.yml:381-384` triggers on `push: branches: [main]` and `workflow_dispatch` only. The `test` job (typecheck + test + lint) therefore runs **after** the merge, on the way to production. `native.yml` correctly gates `pull_request` (`:607`). Add `pull_request` to `deploy.yml`'s trigger and split the deploy job behind an `if: github.ref == 'refs/heads/main'`.

### 3.2 There is no rollback path — **High**
A bad deploy is fixed by pushing a revert commit and waiting for a full build+rsync+migrate cycle. `rsync --delete` overwrites the previous build in place, so the prior version no longer exists on the VM. There is no `releases/<sha>` directory and no symlink swap.

**Fix:** rsync into `~/juno-releases/<sha>`, `ln -sfn` a `current` symlink, `pm2 reload`. Rollback becomes re-pointing the symlink. This is a half-day change and it is the difference between a 3-minute and a 20-minute incident.

### 3.3 Migrations are not zero-downtime and are not reversible — **Medium**
`prisma migrate deploy` runs against the live database while the old code is still serving, then PM2 reloads. There is no expand/contract discipline documented, and Prisma has no down-migrations. Today's 45 migrations are additive, so this has not bitten yet — but the first `DROP COLUMN` or `NOT NULL` addition will take the site down for the duration of the reload, and there is no way back.

**Fix:** document the expand/contract rule (add nullable → backfill → deploy code → make required → drop old, across two releases) in `docs/JUNO.md` §20 and hold to it.

### 3.4 `pm2 startOrReload` is not zero-downtime for a single instance — **Medium**
`ecosystem.config.js` declares no `instances`/`exec_mode: cluster`, so `reload` behaves as a restart. Every in-flight SSE stream is dropped on every deploy. Because deploys are triggered by *every* push to `main` — including the nightly automated `chore(models)` commit from `sync-models.yml:243` — this happens at 04:17 UTC daily whether or not anything user-facing changed.

**Fix:** either run 2 cluster instances (the app is stateless except the in-memory generation registry — see 3.5), or make `sync-models.yml` commit with `[skip deploy]` and batch registry changes into real deploys.

### 3.5 In-memory state blocks horizontal scaling — **Medium**
`registerGeneration`/`cancelGeneration` (`src/lib/generation-cancel.ts`) hold an in-process map, and `src/app/api/i18n/translations/route.ts:13-15` caches translations on `globalThis`. With more than one instance, `POST /api/chat/cancel` reaches the wrong process and silently no-ops (it returns `{ ok: true, cancelled: false }`). This is fine at one instance and is a hard blocker for two.

**Fix (when needed, not now):** move cancellation to a Postgres `LISTEN/NOTIFY` or a `generationId → cancel` row polled by the streaming loop.

### 3.6 Config drift between the two deployment shapes — **Medium**
The Vercel-front shape (`RENDER_BACKEND_URL` rewrite, `COOKIE_DOMAIN`) is documented (`docs/JUNO.md:1426-1432`) but nothing tests it, and two things break silently there: `maxDuration = 300` directives are Vercel-only no-ops on the VM and vice versa, and `ipFromHeaders` behaves differently behind Vercel's proxy chain (§6.2 of [02](02-SECURITY.md)). `render.yaml` exists for the relay-on-Render variant and is a third, unexercised shape.

**Fix:** pick one shape as supported, mark the others "community/untested" in the docs, and delete `render.yaml` if the relay never runs there.

### 3.7 The relay receives every `*_API_KEY` in `.env` — **Medium**
`deploy/ecosystem.config.js:32-40` forwards any key matching `_API_KEY`, plus `AUTH_SECRET`. That hands the realtime-voice process `ANTHROPIC_API_KEY`, `COMPOSIO_API_KEY`, `TAVILY_API_KEY`, `RESEND_API_KEY`, `AA_API_KEY` and every model-provider key — none of which it needs. The relay is the process that terminates untrusted WebSockets from the public internet.

**Fix:** replace the suffix match with an explicit allowlist: `AUTH_SECRET`, `ALLOWED_ORIGINS`, `OPENAI_API_KEY`, `GEMINI_LIVE_API_KEY`, `DASHSCOPE_API_KEY`, `MINIMAX_API_KEY`, `RELAY_*`.

---

## 4. Data lifecycle

| Concern | Status |
|---|---|
| **Backups** | ⚠️ `docs/JUNO.md:1442` — "rely on Neon's branching/point-in-time restore". The database is **Supabase**, not Neon. Supabase's free tier has **no PITR**; daily backups begin on Pro, and PITR is a paid add-on. **UNVERIFIED**: which Supabase plan this project is on. If it is free, there is no meaningful backup. This is the single most important unknown in this document. |
| **Restore tested** | ❌ no evidence of a restore drill anywhere in the repo or docs |
| **S3 backup** | ❌ not mentioned. Attachments have no second copy. |
| **Retention** | ⚠️ `AccountChange`/`MutationReceipt` pruned weekly by `npm run sync:prune`, manual. `RateLimit` never pruned ([01](01-CODE-REVIEW.md) §4.7). `ApiSpend` and `CodeTaskEvent` are append-only and unbounded. |
| **Account deletion** | ✅ `DELETE /api/account` + `POST /api/account/delete` (email-confirmed): best-effort Stripe cancel → storage purge → cascading `user.delete`. Every relation cascades from `User` (`docs/JUNO.md:1200`). |
| **Erasure across third parties** | ⚠️ Composio holds a session reference; Stripe retains billing records (lawful, but must be disclosed); provider logs are governed by each provider's retention. **Deletion does not reach any of them** beyond the Stripe subscription cancel. |
| **Export** | ✅ `GET /api/account/export` — full JSON or CSV with RFC-4180 quoting and CSV-injection neutralisation. Genuinely good, and better than several incumbents ship. |

---

## 5. Legal and compliance for an EU-hosted paid AI product

**I am not a lawyer and none of this is a legal verdict.** These are the issues a lawyer will ask about, ranked by how likely they are to matter.

### 5.1 Prices are displayed excluding tax — **needs a lawyer, likely must change**
`src/app/(app)/upgrade/page.tsx:136,149` renders `20 €` with the suffix **`HT/mo`** (*hors taxes*). EU consumer-protection law (Directive 98/6/EC, and the French Code de la consommation art. L112-1) requires prices shown to consumers to be **TTC** — inclusive of all taxes. "HT" pricing is a B2B convention.

If the operator is a French micro-entrepreneur under the VAT franchise (`src/lib/spend.ts:20-27` sizes budgets against URSSAF cotisations, which strongly implies this), then **no VAT is charged at all** and the correct display is a plain `20 €` with the mention *"TVA non applicable, art. 293 B du CGI"* on invoices. Either way, `HT` is the wrong label for a consumer-facing price. Cheap to fix, non-trivial if a regulator notices.

### 5.2 The legal pages are French-only; the product is English-only — **needs a lawyer**
`src/app/(legal)/legal/cgu`, `/confidentialite`, `/mentions-legales`. The entire product UI is English (with runtime auto-translation), the landing page is English, and the sign-up flow is English. A consumer who transacts in English and is bound by French-only terms has a strong argument the terms were not validly incorporated. Also: the terms are not linked from the checkout flow that I could find.

### 5.3 Subprocessor disclosure is incomplete — **High, and the easiest to fix**
Every user prompt is transmitted to whichever of **14 model providers** the user selects — including Zhipu, Moonshot, DeepSeek, MiniMax, MiMo, Alibaba/Qwen, LongCat (all PRC-based) and xAI. Plus Tavily (search), Composio (connectors), Resend (email), Stripe (billing), Supabase (database, eu-west-1), and the S3 host. `docs/JUNO.md:894-895` already flags the Qwen/Alibaba case as a GDPR note — the concern is correct and the response is a doc comment, not a product control.

Under GDPR Art. 13 and Art. 28 you need a published subprocessor list and, for the non-EU ones, a documented transfer mechanism. **UNVERIFIED**: whether the existing `/legal/confidentialite` page discloses these. It should be read against this list before launch.

### 5.4 AI transparency — **needs a lawyer, deadline-driven**
The EU AI Act's transparency obligations for interacting-with-AI systems (Art. 50) apply. The `"Juno can be wrong — worth a second look on anything that matters"` footer is a good start. Missing: an explicit statement of which model provider processed a given turn *before* the user sends (it is shown after, in the message footer — good), and disclosure that generated media is AI-generated.

### 5.5 Cookie consent — **appears correct**
The banner states essential cookies only, no analytics, no trackers, with an "Essential only" option, and the code carries no analytics SDK (grep confirms: no Sentry, no GA, no PostHog, no Meta Pixel). If that stays true, no consent is legally required for strictly-necessary cookies at all — the banner is more conservative than it needs to be, which is the right side to err on.

### 5.6 Provider terms — **needs review, one specific risk**
Reselling access to 14 providers' models under a single subscription is exactly the arrangement several providers' terms constrain (minimum-price clauses, prohibitions on presenting output as your own model, branding requirements). The UI presents a model as `Mistral Medium 3.5` with the vendor logo, which is the right posture. **UNVERIFIED**: whether every provider's ToS permits resale to third parties without a commercial agreement. This is a per-provider read and it is a genuine business risk, not a formality — a single provider objecting removes a model from the picker overnight.

### 5.7 Data residency — **Medium**
Database is `eu-west-1` (Supabase). The VM location is not documented in-repo. Model inference goes wherever the provider is. Realtime voice through Qwen goes to Alibaba Cloud Singapore (`docs/JUNO.md:894`). There is no region selector and no way for a user to restrict processing to the EU.

---

## 6. Go / no-go

# ⛔ NO-GO

Not because the engineering is bad — it is well above the median for a solo-built product — but because **the product does not currently work on its default path, and if it broke tonight you would not find out.**

The Anthropic key that backs the default model, auto-titling, memory extraction, moderation classification and UI translation is out of credit. The OpenAI and DeepSeek keys are out of credit. The xAI key is rejected. Nothing in the system noticed, because there is no health check, no error tracking, and no alerting of any kind. On top of that, the top-priced plan cannot be purchased, and a routine Stripe dashboard action can silently downgrade a paying customer to a plan with zero messages.

### The shortest list that flips this to GO

| # | Blocker | Effort |
|---|---|---|
| 1 | **Fund or rotate the provider keys** and add a periodic key-health probe that removes unhealthy providers from the picker and alerts you. | S |
| 2 | **Stop unknown Stripe price ids from downgrading a subscriber.** Change `?? "FREE"` to "leave plan unchanged + alert" ([01](01-CODE-REVIEW.md) §3.2). | S |
| 3 | **Set `STRIPE_PRICE_MAX20`, or gate `PLAN_LIST` on a configured price id** so an unbuyable tier cannot render. | S |
| 4 | **Add `GET /api/health` + an external uptime monitor + error tracking.** | S |
| 5 | **Confirm the Supabase plan has backups, and run one restore drill.** | S |
| 6 | **Stream `/api/files` range responses** instead of buffering whole objects ([01](01-CODE-REVIEW.md) §4.4). | S |
| 7 | **Add ordering/idempotency to the Stripe webhook.** | M |
| 8 | **Wrap tool and web-search output in an untrusted-content envelope** ([02](02-SECURITY.md) §4.1). | M |
| 9 | **Display prices TTC** (or with the `293 B` mention) and publish a subprocessor list. | M |
| 10 | **A release-directory + symlink deploy so rollback is one command.** | M |

Items 1–6 are all Small and together they are the difference between "broken and silent" and "working and observable". That is realistically **one focused week**. Items 7–10 are the second week.

I would not take paying customers before 1–6. I would take them after 1–10 with the known gaps documented, because everything remaining is a quality problem rather than a correctness or compliance problem.

**What I am explicitly not calling a blocker:** the god files, the missing CSP, the absent test coverage on the chat route, the accessibility failures, and every market gap. Those are real and they are in the backlog — none of them will lose a customer's data or take a payment for a service that does not deliver.

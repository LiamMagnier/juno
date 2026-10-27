# Open decisions

Items from the pre-production review that are **not** code problems. Each is a
choice only the owner can make, or a question that needs someone qualified.
Recorded here so they stop living in a review document nobody re-reads.

Everything else from that review has been implemented; see the branch history.

---

## 1. Consumer prices are displayed excluding tax (review item 60) — **DECIDED, October 2026**

**The owner charges VAT (20%).** Prices stay HT in `PLANS` (that is what
Stripe charges, with Stripe Tax adding the buyer's VAT: French rate in France,
the buyer's own rate for other EU consumers under OSS, reverse charge for
businesses in another EU state). Every price a person sees goes through
`displayPrice()` in `src/lib/price-display.ts` and is shown **TTC** with
`vatNote()` under it (commit 96f3305c). The CGU price table is gone; the
contract of sale is `/legal/cgv`, whose prices are computed from `PLANS` so
they cannot drift (branch `pricing/legal`).

Still open, and tracked in `docs/pricing/LEGAL_CHECKLIST.md` §2–3: the OSS
registration and Stripe Tax settings (owner), and one remaining HT line in
Settings → Plan & usage (pricing-UI lane).

---

## 2. Does Free get any messages at all? (review item 7) — **DECIDED, October 2026**

**Yes: about €0.20 of model cost a month, on cost-1 models only** (Claude
Haiku, GPT-6 Luna, Gemini Flash-Lite, GLM Flash). `BUDGET_EUR.FREE` is 0.2 in
`src/lib/spend.ts` and `modelRequiredPlan()` admits Free only to models the
catalogue prices FREE *and* marks cost 1. Voice, web search, Code, agents and
research stay paid, which was the interaction this item warned about. The CGV
(art. 3) describes the Free offer.

---

## 3. Is there a tier under €20? (review item 49) — **DECIDED, October 2026**

**Yes: Lite at €9 HT** (€10.80 TTC), fast everyday models plus web search, no
Code or agents. The line-up is now Free, Lite €9, Pro €20, Plus €50, Max ×5
€100, Max ×10 €200, Ultra €500 (all HT). Annual billing is **ten months for
twelve** (`ANNUAL_MONTHS_BILLED`), replacing the earlier no-discount annual
price. Code and agents start at Pro.

---

## 4. Should "Code" be called Code, and should it be a sidebar item?
(review item 51) — **DECIDED, September 2026**

**Yes to the sidebar item; Code keeps its name.** The decision and its reasoning
are `docs/design/TWO_PRODUCTS.md`; this entry records that it is closed and what
was actually settled, because the question as asked was not quite the question.

Code is one of the two products in the sidebar's switcher, at ⌘⇧2, with its own
column — its sessions in date folds, a **Needs you** fold above them, and its own
Customize page. It kept the name because renaming a surface is cheap to do and
expensive to undo, it invalidates every screenshot, doc and support answer, and
the market study this item cited is a snapshot of a convention that is still
forming. The runtime was always the asset.

What the item did not ask, and what the answer turned on: the surface those
eight incumbents promoted is not Code, it is the **async agent** — and Juno
already had it, as Work, as a third top-level product. The reference the item
was written against has since gone the other way: Anthropic folded Cowork back
into Claude on 16 September 2026, on the argument that a person should not have
to decide, before typing, whether their sentence belongs in a conversation or in
an agent workspace. Juno did the same. Work is now what a conversation does when
the ask is big — armed from the composer's `+` menu, drawn in the transcript,
listed in the sidebar as an ordinary chat with a status — and the `/work` routes
redirect. Two products, not three, and the runtime under both is unchanged.

---

## 5. Do the provider terms permit reselling? (review item 63)

**This one is a real business risk, not a formality, and it needs a lawyer.**

Juno resells access to fourteen model providers under a single subscription.
Whether each provider's terms permit that without a commercial agreement is a
question of fact per provider, and a single provider objecting removes a model
from the picker overnight.

`docs/SUBPROCESSORS.md` has the verified list to review against.

---

## 6. The repository has no license (review item 64)

`LICENSE` is a marked TODO. Under the Berne Convention the default is
all-rights-reserved: nobody may copy, modify or redistribute, and no grant
attaches to any contribution. That may be exactly what you want for a commercial
product — but it is currently an accident rather than a decision, and the file
says so out loud.

---

## 7. Other AI Act / GDPR items (review item 64) — **partly done, October 2026**

- **AI Act Art. 50 transparency.** Done for images: `/api/generate` writes an
  IPTC XMP "AI-generated" marking into every PNG, JPEG and WebP it saves
  (`src/lib/ai-content-marking.ts`), and generated media in chat carries a
  plain "AI-generated" caption. **Not done:** video and audio files (left as
  the provider made them; Google's carry SynthID), text, and the caption on
  public share pages and in the Library. See
  `docs/pricing/LEGAL_CHECKLIST.md` §8.
- **Data residency.** Unchanged: the database is `eu-west-1` and the app runs
  on Azure Sweden Central, but inference goes wherever the chosen provider is.
  The privacy notice now lists every provider with its country and the
  intended transfer safeguard; whether each will sign SCCs (and the seven
  PRC-based ones in particular) is still a fact to establish. Checklist §5.
- **No cookie banner, on purpose.** Still true and still correct: essential
  cookies only. Adding analytics means adding consent in the same change.

---

## 8. Work tasks waiting on a person: two numbers — **owner to confirm**

A cloud Work run that asks a question or an approval waits with its executor
attached, then parks (`paused`, lease released). An answer or decision that
arrives after that now puts the run back in the queue and the restored run is
handed it, so the person answers once (`src/lib/work/park-resume.ts`). Two
numbers follow from that, both in env with conservative defaults:

- **`WORK_ATTENDED_WAIT_MS`, default 60000 (1 minute; bounded 1 s to 4 min).**
  How long the executor stays attached before it parks. It was 4 minutes, which
  held one of the runner's 3 slots per slow answer for every account. Shorter
  frees slots sooner; longer saves a person who is watching the cold start of a
  requeue.
- **`WORK_MAX_PARKED_RUNS_PER_ACCOUNT`, default 10 (bounded 1 to 100).** Parked
  runs hold no executor, so they no longer count against the per-account cap of
  3 live runs; this bounds them separately. An account at the bound is refused
  new tasks (`parked_cap_exceeded`) until it answers, resumes or cancels one.
  Note the consequence: answering every parked task at once can put up to
  3 + 10 runs of one account in the queue, which the runner still works 3 at a
  time across all accounts.

---

## 9. Provider health from live turns: five numbers, and the fault copy — **owner to confirm**

A real turn (chat, private chat, Work, background job) that fails on a lab's
account now marks the lab down at once, and repeated server errors on real
traffic hold it down until the next probe; a restart seeds health from recent
failed turns in `RoutingOutcome` (`src/lib/provider-health.ts`,
`src/lib/provider-health-policy.ts`). The probe still owns recovery. Five
numbers, all in env with conservative defaults and clamps:

- **`PROVIDER_CAPACITY_FAULTS_TO_MARK_DOWN`, default 3 (bounded 2 to 50).**
  Server errors (5xx) from real turns that mark a lab down. Never fewer than 2,
  so one 503 can never take a lab out of the picker.
- **`PROVIDER_CAPACITY_FAULT_WINDOW_SECONDS`, default 120 (10 s to 1 h).** …
  within this window.
- **`PROVIDER_LIVE_FAULT_RECHECK_SECONDS`, default 120 (30 s to 30 min).** How
  soon the probe looks again at a lab a live turn marked down (instead of the
  30-minute unhealthy TTL). One 1-token probe per lab per recheck while it is
  down for server errors or unconfirmed.
- **`PROVIDER_HEALTH_SEED_WINDOW_MINUTES`, default 15 (1 to 120)** and
  **`PROVIDER_HEALTH_SEED_MIN_FAILURES`, default 3 (1 to 50).** At boot, a lab
  whose newest turns in the window are at least this many failures with no
  answer since is held down until its first probe (seconds). The seed never
  alerts.

Also for the owner:

- **Mail.** The down alert is now **mailed** when the lab serves
  `DEFAULT_MODEL` or `FREE_DEFAULT_MODEL` (deduplicated per hour per process;
  `ALERT_MUTED_KINDS=provider_unhealthy:<provider>` mutes it). Other labs stay
  log-only. With three processes that can each see the fault (web, Work,
  sweepers), the worst case is one mail per process per hour.
- **Fault copy.** An account fault on a platform-held key now reads
  "<model> is temporarily unavailable. Choose another model, or try again
  later." instead of naming an exhausted credit or a misconfigured key (the
  discovery's owner decision 3, taken as instructed). The precise class still
  reaches the operator log, the alert and the error frame's `errorClass`.
- **Not changed, still the owner's:** substituting an implicit default
  automatically, making Auto the paid default, restoring the Qwen credit or
  changing `DEFAULT_MODEL`. A new chat whose default is marked unavailable
  starts on Auto with a visible notice; an existing conversation and an
  explicit choice are never substituted.
- **Known limit:** health is still per process. A fault the Work runner or a
  sweeper sees lives in that process (it still alerts); the web process learns
  of it from its own next failed turn or probe. A cross-process verdict needs a
  durable row.

---

## Not a decision — a known scaling limit (review item 39)

Recorded here so it is not rediscovered as a bug.

**Stop is no longer one of them (2026-10-25, LEDGER P1-1).** The
active-generation map in `src/lib/generation-cancel.ts` is still per-process,
but a Stop that lands on another process — or before the turn registered — is
recorded as a durable `generation:cancel:` row (in `RateLimit`, no migration)
that every process's signal pump reads once a second for the generations it
holds, alongside the receipt's `cancelRequestedAt`. Saved turns also hold a
`generation:live:` lease, so the cancel route answers `cancelled` honestly and
the resume route tails a turn another process is generating. Polling rather
than `LISTEN/NOTIFY`: Prisma cannot hold a LISTEN session, there is no raw `pg`
driver in the app, and a NOTIFY nobody hears is lost, so the durable row would
be needed underneath anyway. Proven with two Node processes against Postgres
(`tests/chat-cross-process-stop.integration.test.ts`, a CI step).

What is still per-process and in memory:

- `activeGenerationForConversation` (`/api/chat/stream/active`, cross-chat
  context): a tab reopened WITHOUT its sessionStorage ledger finds a running
  web turn only when it reaches the process generating it. The lease key is
  per generation, not per conversation, so another process cannot answer this
  without a lookup the `RateLimit` key cannot index; it needs a small
  `ChatGeneration` table (generationId, userId, conversationId, heartbeat) if
  it ever matters.
- `src/app/api/i18n/translations/route.ts` — the translation cache.
- (Also `provider-health.ts` and `platform-budget.ts`, both added since, both
  documented as such in place.)
- The others the 2026-10-25 audit lists under P1-1: the local-folder bridge
  (`src/lib/chat/local-folder-bridge.ts`, PR #85) and the code env-link hub's
  in-memory default (`ALEVR_LINK_STORE`).

With more than one instance those still answer for one process only, and the
last two can lose in-flight work across a restart (see the audit). Stop no
longer silently does nothing.

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
  time across all accounts. The queue is served by when a run last entered it,
  not by when it was created, so those answered runs wait behind work other
  accounts queued before the answers, rather than jumping ahead of it. There
  is no per-account fairness beyond that.

---

## 9. Provider health from live turns: five numbers, and the fault copy — **owner to confirm**

A real turn (chat, private chat, Work, background job) that fails on a lab's
account now marks the lab down at once, and repeated server errors on real
traffic hold it down until the next probe; a restart seeds health from recent
failed turns in `RoutingOutcome` (`src/lib/provider-health.ts`,
`src/lib/provider-health-policy.ts`). The probe still owns recovery. Five
numbers, all in env with conservative defaults and clamps:

- **`PROVIDER_CAPACITY_FAULTS_TO_MARK_DOWN`, default 3 (bounded 2 to 50).**
  Distinct sources whose real turns met server errors (5xx) that mark a lab
  down. A source is a person (or a Work run) on one model, so one person
  pressing Try again on one model, or one Work run's retries, counts once and
  can never hold every model of the lab down alone; the same person meeting
  5xx on three models of the lab does count three times. Never fewer than 2,
  so one 503 can never take a lab out of the picker. Owner to confirm the
  source definition as well as the number.
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
  `DEFAULT_MODEL` or `FREE_DEFAULT_MODEL`, and so is that lab's all-clear
  (`ALERT_MUTED_KINDS=provider_unhealthy:<provider>` or
  `provider_recovered:<provider>` mutes either). Other labs stay log-only.
  Only the web process mails; the Work runner and the sweepers log the same
  alert. A live fault alone never alerts: it changes routing at once and
  starts a 1-token probe, and only the probe's confirmation alerts. The mail
  follows what the operator was last told, not the previous verdict, so the
  last mail stays true while a lab flaps: an outage is mailed only when the
  last mail did not already say down, and an all-clear only when it did
  (including when the probe clears a live verdict laid over a mailed
  outage). The all-clear keeps the hourly dedupe and stays owed until it is
  sent; an outage after a mailed all-clear skips the dedupe, so a flapping
  default lab mails at most one all-clear and two outages an hour and the
  last one is true. A restarted web process whose seed found too few failures
  can mail the same outage once more.
- **What a live turn may change.** Only an error the model call itself threw
  counts (`streamChat` marks them; Work classifies its own): a 401 from a
  search API or an artifact step that reaches the same catch changes nothing.
  A 403 whose wording names no key or funding problem can be one model this
  key may not use (an organisation verification, an unpurchased model, a
  preview id), so it changes nothing by itself and asks the probe instead (at
  most once per lab per recheck). A hold for repeated server errors is
  confirmed only by a probe that meets a server error too. A live verdict the
  probe can neither confirm nor clear (a timeout, a rate limit) is held
  through one such probe and then released, and a confirmed hold whose probe
  then times out is held through one timeout and released at the second, so
  a slow probe model cannot keep a lab out indefinitely. A private chat's
  fault keeps its class and status only; the provider's text is not kept.
- **Media generation** is refused only for an account fault (auth, billing),
  with the same neutral sentence; a hold for chat server errors does not
  block the image and video endpoints.
- **The native apps' model lists** (`/api/v1/models`, `/api/v1/bootstrap`)
  mark a lab unavailable only for an account fault, as before this change.
  The apps load the catalog once per start and will not send to a model it
  marks unavailable, so a hold for server errors there would strand the lab
  (and a conversation's recorded model) on that device until the next start.
  The web picker and Auto still see every hold. Having the apps refresh the
  catalog after a failed send or on foreground is a native change not made
  here.
- **"Answer with <model>".** The one model a failed turn's error card offers
  must clear the platform's data-use record for training whether the failed
  turn was an explicit choice or Auto: the model row and the provider's API
  terms (`src/lib/router/data-policy.ts`), so a lab whose terms allow
  training, whose terms are unverified, or whose tier-dependent terms have no
  attested paid tier is never offered. After an Auto turn the offer also
  stays inside the account's Auto data boundary. With
  `AUTO_ROUTER_PAID_TIER_PROVIDERS` unset (its owner action is still open in
  `docs/rework/program/AUTO_ROUTER.md`), Google and Mistral are never
  offered; when no configured lab clears, the card offers Try again only.
- **Probes outside the web process.** The Work runner and the sweepers never
  load the catalog, so a lab marked down there is re-probed when its verdict is
  read after the recheck time (1-token probes on the platform key, at most one
  per lab per recheck while it is down). Without that, a lab topped up again
  stayed down in those processes until their next restart.
- **Fault copy.** An account fault on a platform-held key now reads
  "<model> is temporarily unavailable. Choose another model, or try again
  later." instead of naming an exhausted credit or a misconfigured key (the
  discovery's owner decision 3, taken as instructed). The error frame's
  `errorClass` says `account` for both, so the stream does not reveal it
  either; the precise class still reaches the operator log, the health
  verdict and the alert.
- **Not changed, still the owner's:** substituting an implicit default
  automatically, making Auto the paid default, restoring the Qwen credit or
  changing `DEFAULT_MODEL`. A new chat whose default is marked unavailable
  starts on Auto with a visible notice; an existing conversation and an
  explicit choice are never substituted.
- **Known limit:** health is still per process. A fault the Work runner or a
  sweeper sees lives in that process (its confirmation still alerts); the web
  process learns of it from its own next failed turn or probe. A cross-process
  verdict, and a mail dedupe that survives restarts, need a durable row.

---

## 10. Agent computers (owner to confirm)

Computers stay **off in production**: `COMPUTER_PROVIDER` is empty, so nobody
can create, wake, view or use one and no run gets computer tools. What changes
in production today is copy only (the agent panel says "Computers aren’t
available on this server." where it said nothing) and three inert additions
(`Agent.computerPolicy`, default `ask`; `AgentComputer.lastContactAt`; the
usage and audit tables, empty). The plan is
`docs/design/agents-v2/COMPUTERS_2026-10.md`; these are its numbers and
switches for the owner. Every one is an env value with the conservative
default shown, and nothing changes until the owner sets it.

**Rollout, on top of the provider switch** (`src/lib/computer/access.ts`):

- **`AGENT_COMPUTER_ROLLOUT`, default `allowlist`.** `allowlist` admits only the
  accounts in **`AGENT_COMPUTER_ALLOWLIST`** (default empty: nobody), so setting
  a provider alone exposes nobody; `plans` admits every plan that includes
  computers; `off` admits nobody. Any other value reads as `off`. An allowlist
  email matches only a **verified** email; an id matches exactly. Who goes on
  the list first, and when (if ever) to switch to `plans`, is the owner's.
- The allowlist is ANDed with the plan: a listed Free or Lite account is told
  computers come with Pro and above.

**Per-plan caps** (`PLAN_AGENT_COMPUTER` in `src/lib/plans.ts`, a map beside
`PLANS`; `PlanConfig`, the plans page and Stripe are untouched). Computers come
only with the plans where `agents` is true (Pro and up). Free and Lite have no
key and an override set for them is ignored. Setting a plan's number to 0 takes
computers out of that plan: its accounts are offered the next plan up that still
has them ("Computers come with Plus and above."), or, when none does, told
"Computers aren’t included in your plan." with no upgrade link.

| Plan | Computers per account (`AGENT_COMPUTER_MAX_ENABLED_<PLAN>`) | Awake minutes per week (`AGENT_COMPUTER_WEEKLY_MINUTES_<PLAN>`) |
|---|---|---|
| Pro | 1 | 120 |
| Plus | 2 | 300 |
| Max ×5 | 3 | 600 |
| Max ×10 | 5 | 1200 |
| Ultra | 10 | 3000 |
| Owner | 24 | 10080 |

- **The week** starts Monday 00:00 UTC. Awake time is **metered at a price of
  0** (`AgentComputerUsageInterval`), so the allowance bounds use whatever
  `COMPUTER_COST_MICRO_USD_PER_SECOND` / `AGENT_COMPUTER_COST_USD_PER_MIN` say
  (default 0: nothing is billed). Awake time that runs across Monday 00:00 UTC
  is split there, metered or still open, so each week counts only its own
  share and the new week starts from what was used since Monday 00:00.
- **The allowance is soft, by a known bound.** It is checked at wake, at every
  lease renewal (40 s) and at every sweep (60 s), never continuously, so an
  account can overrun its week by at most (its awake computers) × 40 s for
  computers a run holds, and 60 s for a computer only a viewer keeps awake.
- The existing awake caps stay: 2 awake per account, 6 per host
  (`AGENT_COMPUTER_MAX_AWAKE_USER`, `AGENT_COMPUTER_MAX_AWAKE_HOST`).

**Each agent's policy** (`Agent.computerPolicy`): `off`, `ask` (the first
computer tool call of a task asks the person "Start {name}’s computer"; nothing
else is approved by it) or `allowed` (it starts on its own). **Default for new
agents: `ask`.** Agents that already had a computer were migrated to `allowed`
so they keep working without a new question. The per-action floors do not
change: a shell command, typed text and a text-producing key still ask every
time, and an unattended run never gets a standing grant to run commands (it
notifies and parks on the start card like on any approval).

**Image age.** **`AGENT_COMPUTER_MAX_IMAGE_AGE_DAYS`, default 14.** Past it,
every wake records `image_stale` in the audit. Nothing is refused (whether a
stale image should ever refuse a wake is the owner's).

**Retention: off.** Computers are never deleted for age. `COMPUTER_RETENTION_DAYS`
is not read for deletion even if an env file has it (three docs once gave 30 as
the default); the getter that held it is removed. Turning retention on will need
its own switch and a number of days (stage S2: `AGENT_COMPUTER_RETENTION_ENFORCE=1`
and `AGENT_COMPUTER_RETENTION_DAYS`, at least 7), deletes files and sign-ins,
and needs a notice to users first.

**The scripted Work model** (`JUNO_ALLOW_SCRIPTED_WORK`, `WORK_SCRIPTED_MODEL_FILE`,
`WORK_SCRIPTED_MODEL_USERS`) is for tests and local demos only: refused when
`NODE_ENV=production` (logged once if set there), never in the model catalog,
and a run it drives says "Development run: a scripted test model drove this
task. No AI model was called."

**Egress, on whichever machine runs the computers** (stage S2; written into
the proxy's unit by `deploy/agent-computers/setup-vm.sh`, and by
`deploy/computer-host/setup.sh` through it): **`JUNO_EGRESS_MAX_MB_PER_HOUR`,
default 1024** (per computer, both directions, rolling hour; over it new
connections get 403 and open tunnels close) and **`JUNO_EGRESS_LOG_DAYS`,
default 14** (days of `/var/log/juno-computers-egress/egress.jsonl` kept; it
names the hosts each computer reached, so it is personal data about what an
agent did). Whether computers may reach any public host on 80 and 443 (today)
or an allowlist is the owner's.

**The computer host** (stage S3, `deploy/computer-host/`; nothing runs until the
owner provisions a machine, runs its `setup.sh` and sets
`COMPUTER_PROVIDER=remote` on the web VM):

- **Computers running at once per host: 6** (`setup.sh --max-running`, the
  host's `maxRunning`). By arithmetic, not measurement: 2 GB and 2 CPUs per
  awake computer, plus 2 GB for the system and a 1 GB free-memory floor, so 6
  need about 16 GB. Start and unpause are refused past it, and also below 1 GB
  of free memory or 10 GB of free disk on the Docker root (`minFreeMemMb`,
  `minFreeDiskMb` in `/etc/juno/computer-host.json`).
- **`COMPUTER_HOST_TIMEOUT_MS`, default 30000** on the web VM: how long one
  request to the host may take (a command adds its own limit of up to 300 s).
- **Tunnel tickets**: single use, **60 s**, at most **16** outstanding per
  computer (`ticketTtlSeconds`, `maxTicketsPerComputer`).
- **Tokens**: at most two per environment namespace at once, rotated with
  `setup.sh --add-token` then `--retire-token`, without a restart. How often to
  rotate, and who holds them, is the owner's. One host per environment.
- **TLS**: default a private CA that can sign only the host's name, its key
  destroyed after signing, the certificate valid **397 days** (renew a month
  ahead with `--renew-tls`); Let's Encrypt with port 80 open only during
  renewals, or the owner's own certificate, are the alternatives.
- **`AGENT_COMPUTER_REQUIRE_BROWSER_SANDBOX`, default 0.** 1 refuses to wake a
  computer whose Chromium runs without its own sandbox ("This server requires
  the browser's own sandbox, and this computer can't use it."). On Ubuntu
  24.04, whose AppArmor restricts unprivileged user namespaces, the sandbox
  reports off unless the owner relaxes that on the host.
- **Image freshness**: the weekly rebuild timer is **off** (`setup.sh
  --rebuild-timer on` installs it; it pulls Debian packages on the host). A
  stale image is audited once a day and at every wake; nothing is refused.
- **Losing the host**: an awake computer's time is metered only up to the last
  time the host answered, and resumes at the next answer; nothing is recreated
  or deleted during the outage.

**Planned numbers that later stages add** (named here so the list is whole;
none of them is in the code yet, and each stage that builds one updates this
section): the inbox upload cap `AGENT_COMPUTER_UPLOAD_MAX_MB` (25); the
streamed shell output kept per call `AGENT_COMPUTER_SHELL_LOG_KB_PER_CALL` (512).

**Still the owner's** (the plan's section 8): the computer host and its size,
the price, egress and its log, unattended command grants (default: none),
Chromium's sandbox requirement, the inbox and streamed-output caps, what a
downgraded account may do with its computer (today: it stays asleep and intact;
it can be deleted, not woken; no export), host TLS and token rotation, and
promoting the real-container CI job to required.

---

## 11. Orbit: what an agent keeps from a task, and when a goal is met (owner to confirm)

Code defaults chosen on 2026-10-28 (package O2). None is commercial; each is a
product rule the owner may want different. Constants, not env, because they
are safety bounds rather than tuning: changing one is a one-line edit with
its test.

- **Which notes wait for review** (`runNoteReview`, `src/lib/agents/note-review.ts`).
  A note a cloud task saves with `remember` is kept at once only when the
  agent's "What it may remember about you" is *Everything you share with
  chats*; under *Your profile* (the default) and *Its own notes only* it waits
  for the person's *Keep*. A note touching a sensitive topic always waits.
  The alternative is to keep notes at once under *Your profile* too, which
  makes `remember` useful without a review step but lets a task's untrusted
  reading reach later tasks unreviewed.
- **Three notes per run** (`MAX_RUN_NOTES_PER_RUN`) and **500 characters per
  note** (`MAX_RUN_NOTE_CHARS`).
- **A goal whose last step ran on a Mac ends `unverified`.** The criteria
  check runs only on the cloud executor; the Mac app has no such check yet,
  so such a goal always asks the person to check the result rather than being
  marked met. Adding the check to the Mac runner would need the Swift side.
- **The criteria check's bounds**: 30 s and 120 output tokens per check
  (`checkGoalCriteria`), the steps' results cut to 1,500 characters each and
  8,000 in all (`GOAL_CHECK_STEP_CHARS`, `GOAL_CHECK_TOTAL_CHARS`). The check
  is one extra model call on the agent's own model at the end of a goal; it
  is not metered separately from the run (the same as the run's own judge).

---

## 12. Retry before the first byte: one switch and one number — **owner to confirm**

A saved chat turn whose provider rejects the first request before answering
it now asks once more (`src/lib/chat/turn/pre-stream-retry.ts`, wired in
`run-turn.ts`). "Rejects" is narrow: the error must come from opening the
turn's first request, before the response headers arrived (an HTTP error
status instead of a stream, or a connection refused, reset or unresolvable),
and the adapter must have passed nothing on. A stream the provider had already
accepted is never asked again, even when it breaks before the adapter passes
anything on: its opening events can carry usage the provider bills (Anthropic's
`message_start`). Timeouts are never retried. An
explicit choice is asked again on the same model, and only for a rate limit,
a server error or a failed connection. Auto moves to the decision's next
ranked healthy candidate, which clears the same plan, capability and data-use
terms, also after an account fault or a model the lab no longer serves. Never
after a single event or token, never for a safety refusal (read from the
wording, whatever the status, so a 403 refusal is not moved to another lab),
an oversize prompt or a malformed request, never after a Stop, a drain, the
watchdog or the budget guard, and never twice. An adapter that already sent
the request a second time itself (Gemini's own retries, Anthropic's fast-mode
fallback) has used that model's second ask, so only Auto may still move on.
Attempt 1's spend hold is released and attempt 2 takes its own
(`<generationId>:attempt-2`; the abandoned-receipt sweep releases both). If
attempt 1's hold cannot be released, or attempt 2's is refused, there is no
retry. The reader sees a "Retrying…" row. Both settings are in env, with
defaults and clamps:

- **`CHAT_PRESTREAM_RETRY`, default on.** `off` (or `0`, `false`, `no`) turns
  the retry off everywhere. The turn then fails on the first rejection, as
  before this change.
- **`CHAT_PRESTREAM_RETRY_MAX_WAIT_MS`, default 8000 (bounded 0 to 15000).**
  The longest wait before the second attempt. Without a stated wait, the same
  model is asked again after a jittered 0.4–1.2 s, and another model under
  Auto after 0.2–0.6 s. A wait the provider names (`retry-after`,
  `retry-after-ms`, "retry in Ns") is honoured up to this bound. When the
  provider asks for longer, the same model is not retried: the error card
  shows the wait instead. Auto may still move on to another model.

Also for the owner:

- **Cost.** A retried turn makes one more provider request. It is billed to
  the reader only for what that request serves: attempt 1 received nothing,
  so nothing was recorded for it. A provider *may* still bill the platform
  for a request whose connection was reset after it was sent but before the
  response headers came back. That is the one case the rule cannot see, and
  it is why timeouts (the likelier shape of it) are never retried.
- **Auto may answer on a different lab after an account fault.** This is
  the in-turn failover the discovery asked for (gap 1e). The receipt says
  "Auto's first choice couldn't be reached, so the next best model answered".
  An explicit choice is never moved.
- **Not covered:** private chats (`private-turn.ts`) and Work runs still fail
  on the first rejection. The native apps show the row as an ordinary model
  row. Their run panel's "Model" fact may still name the first pick after Auto
  moves on, because the web panel reads the last "Selected model" row and the
  Swift side was not changed.

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

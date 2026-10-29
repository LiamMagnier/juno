# Chatbot, cost, and cross-platform design audit

**29 October 2026 · Repository: LiamMagnier/juno**

Inspected base: `7c91a0c2eb986f468c94801878820d7393ccd140`.

This audit implements the owner's request to improve the chatbot, research its
competitors, make usage go further, and bring the website, macOS, and iOS closer
to one design identity. The repository is named Juno; its existing public
display-name module calls the product Alevr. This change preserves those names
and the stable API, storage, and bundle identifiers.

## Outcome

The most valuable findings were correctness and consistency problems in an
already capable product. The branch fixes avoidable usage charges, repeated
suggestion work, composer submission races, conversation-search failures, and
drift between the web and native control systems. It preserves the selected
answer model, the main prompt/history policy, and the existing tool and approval
boundaries.

The accompanying [competitor research](COMPETITORS.md) compares current official
documentation for ChatGPT, Claude, Grok, Gemini, and Perplexity with code actually
present in Juno. The [design report](DESIGN.md) explains the shared identity and
native changes. [Validation](VALIDATION.md) records executed checks and their
limits. These documents distinguish implemented fixes from remaining work.

## Evidence and boundaries

The audit inspected the chat/composer/transcript pipeline, provider adapters and
request metering, pricing and spend settlement, follow-up generation, utility
fallbacks, usage reporting, shared controls, design-token generation, native
design primitives, routing/evaluation, and relevant CI/release gates. It used
focused regression tests, repository-wide checks, and the sanctioned production
browser harness. See the validation record for the final outcomes.

This is a broad source audit of these systems, not a line-by-line certification
of every file, a penetration test, a competitor's private implementation audit,
or a live provider bake-off. No production database, customer content, provider
credentials, live model calls, or store releases were used. macOS/iOS runtime
claims require the Apple build and device gates identified below.

## Findings and implemented changes

| Priority | Finding | Implemented correction | Evidence |
|---|---|---|---|
| Critical | Reading the usage profile could overwrite correct discounted ledger charges. It estimated standard uncached cost from aggregate tokens, chose the larger value, and asynchronously updated historical rows. | Usage reads now report validated settled cost and never write charges. Incomplete historical counters are not sufficient evidence for a repair. | [Profile route](../../src/app/api/profile/stats/route.ts), [route regression](../../tests/profile-stats-ledger.test.ts) |
| High | Cumulative tool-loop tokens were priced as one request. Several ordinary prompts could incorrectly cross a provider's long-context price boundary; a mixed premium/standard turn could use one tier for everything. | Internal request receipts preserve request boundaries and served tier. Display and settlement use their sum only when prompt, output, cache, and tool buckets reconcile. Incomplete receipts retain the existing conservative fallback. | [Turn pricing](../../src/lib/turn-pricing.ts), [request meter](../../src/lib/llm/request-meter.ts), [ledger boundary tests](../../tests/chat-turn-spend.test.ts) |
| High | Utility requests rejected before any provider event could be charged for an estimated full prompt. | Explicit structured rejection statuses are distinguished from missing usage. Rejections before any event and without an abort create no invented charge. Partial streams, timeouts, and unknown failures remain conservatively accounted. | [Utility classifier](../../src/lib/utility-attempt.ts), [utility runner](../../src/lib/memory.ts), [real-runner tests](../../tests/utility-rejection-billing.test.ts) |
| Medium | Reopening the same completed answer could start duplicate paid follow-up calls. | Identical in-flight requests coalesce, and successful suggestions have a bounded ten-minute process cache. Ownership, current provider policy, model, message identity/content, and branch context remain part of the authorization/key path. | [Route](../../src/app/api/chat/follow-ups/route.ts), [cache](../../src/lib/chat/follow-up-cache.ts), [route tests](../../tests/follow-ups-route.test.ts) |
| Medium | Live budget estimates handled cache writes and fully cached Anthropic prompts inconsistently, and could keep the premium rate after an initial downgrade. | The guard uses the canonical inclusive/exclusive cache convention, split write lifetimes, an output character floor, and current served-tier rates. Anthropic reports a rejected premium-to-standard fallback before standard tokens arrive. | [Budget guard](../../src/lib/chat-budget-guard.ts), [guard tests](../../tests/chat-budget-guard.test.ts), [adapter test](../../tests/prompt-cache-wire.test.ts) |
| High | A pending send could be submitted twice or clear a draft edited while acceptance was pending. The landing-to-dock handoff also changes Composer mounts. | Synchronous submission ownership and a view-local draft session carry the draft through the handoff. Text revision and submitted-resource ownership are checked separately. Private drafts stay in memory. | [Composer](../../src/components/chat/composer.tsx), [submission guard](../../src/lib/chat/composer-submission.ts), [draft session](../../src/lib/chat/composer-draft-session.ts) |
| Medium | Escape in conversation search could propagate to the global Stop shortcut. Unicode case expansion could shift previews; result caps and history scope were unclear. | Escape closes search locally; matching keeps original string offsets. The selected hit survives older history loading, previews show the actual match, and the UI distinguishes a capped count from an exact count. | [Search UI](../../src/components/chat/conversation-find.tsx), [search core](../../src/lib/conversation-search.ts), [browser tests](../../e2e/conversation-find.spec.ts) |
| Medium | Shared web form controls, button motion, tooltips, native surfaces, and composer geometry had diverged. | Semantic field tokens, shared recipes, generated spring parameters, consistent tooltip timing, native neutral roles, composer radii, and preference-aware native control feedback. | [Design report](DESIGN.md) |
| Moderate advisory | An installed MCP dependency included an affected `@hono/node-server` version. | MCP SDK updated to 1.32.2; the lockfile now selects patched `@hono/node-server` 2.1.5. Production dependency and security gates are recorded in validation. | [GHSA-rmxm-3fg6-px4f](https://github.com/advisories/GHSA-rmxm-3fg6-px4f), [package manifest](../../package.json) |

The advisory's applicability depends on use of the affected static-serving
middleware configuration. The dependency finding is not evidence that the Juno
deployment was exploitable. The patch removes the known affected dependency.

### Why the billing correction matters

A provider prices a request according to that request's context size and served
tier. A tool turn can contain many requests. Adding their tokens first can
create a context size that no request actually had. The regression fixture uses
two Grok 4.7 requests with 150,000 prompt tokens and 1,000 output tokens each.
At the repository's current pricing table, the old aggregate estimate is
$1.224; the sum of the individual requests is $0.612. This is a deterministic accounting
reproduction, not a measured customer saving or a claim about all conversations.

The new request callback stays inside the server. Clients cannot supply receipts
or select an arbitrary low dollar charge. Both saved and private chat paths feed
the same accumulator, and both the visible receipt and `recordSpend` recompute
from the same reconciled usage. Gemini's per-request total is retained so
thought tokens are not lost when separate prompt and answer counts are present.
The public SSE and native wire schemas do not need to change.

Interrupted coverage retains the aggregate estimate plus any verified positive
tier/batch premium already consumed by completed requests. It cannot fall below
the valid known receipts. A malformed sibling does not erase a valid receipt,
and cheaper partial receipts cannot create an unsupported discount. The mixed
fast-to-standard regression retains $0.015 for a completed premium request plus
the standard-priced remainder; the former fallback returned only $0.009.

The profile fix is necessary for that correction to last. A correct ledger
write was previously vulnerable to later repricing when someone opened their
profile. The read route now respects the price settled at the time of the
request, including cache/batch/tier discounts and retired models. Invalid legacy
cost values contribute zero to this display; a GET does not guess and mutate
financial history.

Historical overcharges cannot be safely repaired from the stored aggregate
input/output counts alone. Such a reconciliation needs provider receipts or
equivalent complete usage evidence, historical rates, and an explicit reviewed
correction plan. This branch does not silently rewrite old bills.

### Why the follow-up cache is narrow

Follow-up suggestions are optional decoration on a finished answer. They are a
good place to eliminate redundant work without changing answer quality. A
single-flight cache test sends twenty identical callers to one generation
function; it generates once. That is nineteen avoided calls in that fixture,
not a 95% reduction in total API spending.

The route still authenticates, rate-limits, checks ownership, and reads current
background-provider policy before serving a hit. The key includes the user and
conversation, the model/provider policy, prompt version, and message identities
and content. Edits, regenerations, branch changes, and policy changes therefore
do not reuse the wrong answer's suggestions. Keys are hashes; cached suggestion
text remains process-local and bounded. Empty or failed generation is not cached.
One disconnected waiter does not cancel shared work for another waiter; the
utility runner retains its own deadline.

This design has no database migration or Redis dependency. Its tradeoff is that
separate server processes do not share hits. Distributed coalescing should only
be added if measurements show that cross-process duplicates justify its
infrastructure and privacy costs.

## Quality, features, and competitor implications

Juno already contains research plans, tool approvals, source inspection, editable
artifacts, projects, memory, voice, background work, and multi-model selection.
The research report links each observation to source. The useful competitive
test is whether a user can successfully complete a workflow: upload a document,
get a supported answer, edit the resulting artifact, recover from an interrupted
turn, and continue on another device.

The implemented work improves interaction reliability and billing fidelity. It
does not demonstrate that model answers are better than ChatGPT, Claude, Grok,
Gemini, or Perplexity. That requires a controlled task set with correctness,
grounding, preference, latency, and complete cost measurements. Vendor feature
documentation is not a quality benchmark.

Two evaluation gaps deserve priority:

1. The general evaluation runner prices input/output counters while labelling
   the cost source `measured_usage`. That is a token-price estimate, not a total
   reconciled provider bill. Cache writes, tools, media, retries, and missing
   usage need separate coverage and provenance.
2. The general suite's `citationQuality` checks URL/title shape. It must not be
   interpreted as factual support. The richer research citation evaluator is a
   better foundation, but its stock labelled examples are regression evidence;
   held-out independent examples are needed for broader quality claims.

## Cost strategy that preserves quality

The order of optimization matters. First remove duplicated work and erroneous
charges. Then improve cache reuse and deferred utility scheduling using measured
workloads. Change answer-model routing only when outcome evidence shows an
acceptable quality/latency tradeoff.

| Workload | Current action / appropriate next action | Constraint |
|---|---|---|
| Repeated follow-up suggestions | Implemented bounded reuse and coalescing. | Never share across users or bypass changed policy. |
| Multi-request chat | Implemented request-level context/tier pricing. | Incomplete receipt coverage still uses a conservative estimate. |
| Rejected utility requests | Implemented evidence-based zero consumption classification. | A timeout or partial stream is not proof of zero cost. |
| Repeated conversation prefixes | Preserve the existing stable-prefix and provider-cache implementation; measure hit rate by provider/model/role. | Cache writes can cost more than fresh input. Minimize invalidation rather than assuming every cache is a discount. |
| Nonurgent batchable work | Use existing batch infrastructure for eligible delayed utility work after confirming policy and provider support. | Batch discounts differ by provider; asynchronous batch is unsuitable for a live chat response. |
| Short/easy answer routing | Evaluate the existing router on held-out tasks and cost per accepted outcome. | No silent downgrade of user-selected models, no universal cheapest-model default. |
| Long context | Keep intentional context selection and summaries, then evaluate recall and prompt reuse. | Arbitrary truncation can save tokens while ruining the task. |
| Search and multi-model comparison | Make the cost an intentional part of the requested workflow. | Extra searches/models/synthesis are extra billable work. |

Official cache, batch, and provider pricing references and important provider
differences are collected in [COMPETITORS.md](COMPETITORS.md). A subscription's
message allowance and an API's per-request price are different quantities.
There is no defensible universal monthly savings percentage without production
traffic and invoice reconciliation.

## Performance and operational implications

The main answer path adds no model request, search call, database round trip, or
new browser dependency. Request receipts reuse existing instrumentation and are
small token-count objects, bounded by the existing tool loop. Search remains
local, caps navigation results, and defers expensive transcript matching.
Shared CSS/SwiftUI recipes replace divergent styling; they do not add idle
animation loops. Removing modal backdrop blur reduces a rendering cost.

The included [synthetic benchmark](../../scripts/bench-chat-audit.ts) measures
local accounting/search CPU work and deterministic avoided calls. It explicitly
does not measure production p95, provider time to first token, device frame
rates, or answer quality. A claim of unchanged end-to-end performance needs
before/after production measurements under equivalent load.

The streaming guard remains an estimate until usage arrives. Mixed served-tier
tool turns, nonlinear long-context rates, unreported reasoning, and already
accepted provider work mean an abort is not a universal invoice-level hard cap.
The settlement path now has more exact request evidence; the next guard
improvement should price completed requests plus current unreported deltas
without revaluing prior rounds. This limit must remain visible in budget claims.

## Remaining release and product priorities

### Before a production or store release

- Complete the existing CI gates on the proposed commit, including Apple SDK
  builds and native UI/snapshot checks. Linux source/static checks cannot
  establish SwiftUI layout or VoiceOver behavior on actual devices.
- Extend the verified core web matrix to remaining feature-specific screens
  and native device snapshots. The reviewed [browser captures](DESIGN.md#captured-browser-evidence)
  cover real settings, dialogs, search and composer states in the audited flows.
- Monitor request-receipt reconciliation coverage and ledger/display agreement;
  distinguish reported and estimated cost. Verify representative invoices
  before changing plan allowances or advertising savings.
- Measure p50/p95 time to first useful output, completion time, and interaction
  responsiveness on representative long threads and lower-end devices.

### Next measured improvements

- Persist sufficient request-level billing evidence for later reconciliation,
  with retention/privacy boundaries, then improve live budget projections.
- Build a held-out task suite for multilingual chat, document grounding,
  coding, research, long-context recall, artifact revision, and recovery.
- Track cost per successful/accepted task with cost-coverage and retry counts,
  alongside quality and latency, before broadening cheap-route use.
- Continue migrating feature-specific legacy controls to the shared recipes.
  Shared primitives now agree; this is not a claim that every bespoke screen
  in the large repository has been visually certified.
- Move attachment ownership across the first-message landing-to-dock handoff.
  Text and context chips now survive this mount change, but newly added uploads
  during that first send's preflight still belong to the old Composer instance.
  The targeted cleanup fix preserves new uploads in an already mounted thread;
  it does not solve this separate existing attachment-lifetime issue.
- Run the same interaction checklist across web, Mac, and iPhone while keeping
  native navigation, safe areas, text scaling, and platform focus conventions.

## Delivery and rollback

The changes are isolated on the audit branch and proposed through a pull
request. There is no schema migration and no production deployment in this
work. The model selection/prompt policy and native wire format remain compatible.
Rollback is a normal code revert; already settled historical ledger rows are not
rewritten by this branch. The dependency patch should be retained if a visual
change needs to be reverted independently.

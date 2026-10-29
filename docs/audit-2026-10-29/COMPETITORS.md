# Competitor and API cost research, mapped to Juno

Research date: **29 October 2026**. Repository base inspected:
`7c91a0c2eb986f468c94801878820d7393ccd140`.

## Scope and evidence

This report combines current official product/API documentation with a static
inspection of Juno. It is **not a hands-on competitor benchmark**, a production
verification of Juno, or an independent audit of the competitors' private
implementations. Features can depend on plan, platform, region, and rollout.
An unverified capability is unknown, not absent.

Repository context came from [PRODUCT.md](../../PRODUCT.md), the relevant design,
chat, model, billing, and operations sections of [JUNO.md](../JUNO.md), the
[25 October competitive matrix](../baseline-2026-10-25/COMPETITIVE_MATRIX.md), and
the source files linked below. Existing tests and workflows were inspected as
evidence of coverage intent; this research subtask did not execute them.

Evidence labels used here:

- **Official documentation:** a vendor describes the capability; this is not a
  measured quality or performance result.
- **Code present:** the inspected implementation has the relevant behavior or
  primitive; deployment, configuration, and real execution remain separate.
- **Measurement gap:** the evidence gathered for this report cannot establish
  the claimed outcome; it does not mean the feature is missing or broken.
- **Recommendation:** an engineering judgment derived from that evidence.

## Main finding

Juno already has the broad feature set that a generic competitor checklist would
recommend: research, source inspection, editable artifacts, tools, memory,
projects, voice, model routing, resumable streams, and background work. Adding a
second version of these systems would increase complexity. The valuable next
step is to make the existing experience easier to use and to establish
repeatable evidence of answer quality, latency, accessibility, and actual cost.

The product direction in `PRODUCT.md` is quiet, premium, restrained, and
conversation-first. It should remain the design constraint. Competitor patterns
are references for behavior, not permission to copy brand assets or replace
Juno's established interaction language.

The older matrix is useful historical context but must not be presented as
current verification. For example, its statement that Playwright is absent from
CI is superseded by the current [e2e workflow](../../.github/workflows/e2e.yml)
and [design-gates workflow](../../.github/workflows/design-gates.yml). Their
presence does not establish the latest run result. Likewise, old production
incidents, model counts, and unmerged-branch statements need current checks
before being repeated.

## 1. Existing Juno capabilities to preserve

All statuses in this table mean **code present**, not independently verified
production parity.

| Capability | Evidence in the repository | Implication for the improvement work |
|---|---|---|
| Composer, model and effort controls, attachments, commands | [composer.tsx](../../src/components/chat/composer.tsx), [composer-plus-menu.tsx](../../src/components/chat/composer-plus-menu.tsx), [chat-view.tsx](../../src/components/chat/chat-view.tsx) | Refine discoverability and interaction consistency; do not add another tool picker or mode system. |
| Streaming, cancellation, first-turn idempotency and recovery | [use-chat.ts](../../src/hooks/use-chat.ts), [chat-stream.ts](../../src/lib/chat-stream.ts), [chat-first-submission-receipt.ts](../../src/lib/chat-first-submission-receipt.ts), [turn pipeline](../../src/lib/chat/turn/run-turn.ts) | Preserve durable identities and distinguish reconnecting to a generation from starting a new billable generation. |
| Reading-first transcript and screen-reader status handling | [message-list.tsx](../../src/components/chat/message-list.tsx) | The implementation already limits follow behavior, offers a full-conversation reading route, and announces completion separately. Validate edge cases instead of replacing the model. |
| Efficient rich text | [markdown.tsx](../../src/components/chat/markdown.tsx), [markdown-plugins.ts](../../src/components/chat/markdown-plugins.ts) | Stable Markdown blocks, memoization, lazy math/highlighting, and dynamic Mermaid/Live UI are already present. Any new render work must preserve this strategy. |
| Source inspection and claim support | [sources-pill.tsx](../../src/components/chat/sources-pill.tsx), [citation-audit.tsx](../../src/components/chat/citation-audit.tsx), [citation-audit-core.ts](../../src/lib/research/citation-audit-core.ts) | Juno already distinguishes provenance and supports claim-level inspection. This can become a differentiator if held-out evaluation demonstrates it works. |
| Durable research | [research/run.ts](../../src/lib/research/run.ts), [research planner](../../src/lib/research/planner.ts), [research-run-panel.tsx](../../src/components/chat/research-run-panel.tsx) | Improve completion quality and budget/latency evidence; adding a separate research engine is unnecessary. |
| Editable artifacts and isolated previews | [canvas-panel.tsx](../../src/components/canvas/canvas-panel.tsx), [sandbox-frame.tsx](../../src/components/canvas/sandbox-frame.tsx), [sandbox-document-frame.tsx](../../src/components/canvas/sandbox-document-frame.tsx) | Preserve edit/version behavior and the preview security boundary. The useful benchmark is successfully editing and exporting a result. |
| Context and memory | [turn context](../../src/lib/chat/turn/context.ts), [project context](../../src/lib/chat/turn/project-context.ts), [turn memory](../../src/lib/chat/turn/memory.ts), [memory-fact-row.tsx](../../src/components/chat/memory-fact-row.tsx) | Evaluate relevance, correction, deletion, scope, and continuity with realistic conversations; do not equate more memory with better answers. |
| Adaptive model selection and cost outcome tracking | [router/decide.ts](../../src/lib/router/decide.ts), [router/evidence.ts](../../src/lib/router/evidence.ts), [cost-per-accepted.ts](../../src/lib/metering/cost-per-accepted.ts) | Use the existing router and sample guards. Acceptance is a behavioral proxy, not a factual-correctness guarantee. |
| Provider caching and delayed utility work | [openai-prompt-cache.ts](../../src/lib/openai-prompt-cache.ts), [anthropic-cache.ts](../../src/lib/anthropic-cache.ts), [batch/plan.ts](../../src/lib/batch/plan.ts), [batch/providers.ts](../../src/lib/batch/providers.ts) | Optimize measured reuse and billed work. Cache helpers and OpenAI/Anthropic batching are already implemented. |

## 2. Current competitor comparison

This matrix describes documented strengths and the relevant comparison with
Juno. It intentionally contains no invented quality scores or speed rankings.

| Product | Officially documented capabilities | Relevant Juno comparison and remaining question |
|---|---|---|
| **ChatGPT** | Search and deep research; files, images, audio and data analysis; voice; controllable memory; projects and scheduled tasks. Supported writing/code blocks are editable and can expose copy, preview or run actions. Research supports a reviewable plan, progress, source control and cited outputs.[^chatgpt-overview][^chatgpt-blocks][^chatgpt-research] | Juno already implements most of these primitives. Compare complete workflows: upload a document, get a grounded answer, correct it, reopen it later, and export usable work. A feature count cannot establish equivalence. |
| **Claude** | Artifacts sit beside the conversation and support direct or conversational editing, reuse, sharing and export. Research combines web and enabled connectors; ordinary search exposes an activity indicator and citations.[^claude-artifacts][^claude-research][^claude-search] | Juno's Canvas and research/citation systems already address these patterns. The remaining comparison is artifact editing fidelity, provenance clarity, successful research completion, and continuity across surfaces. |
| **Grok** | Consumer documentation describes chat, voice, image/video creation, broad file support, connectors and cross-platform continuity. Developer tools expose X Search plus structured citation information.[^grok-overview][^x-search][^x-citations] | Juno already has multimodal and provider/tool infrastructure. X Search is a separately priced provider capability, not evidence that ordinary Juno chat should always search. Confirm each capability's eligibility and cost before exposing it. |
| **Gemini** | Canvas supports documents, apps and code, direct edits, targeted selection edits, preview logs and auto-save. Deep Research supports source choice, editable plans, progress and completion notifications.[^gemini-canvas][^gemini-research] | Juno has Canvas, selection/context affordances and research. Test whether a user can complete these workflows with similarly clear control and recovery. Do not add new parallel surfaces merely to match terminology. |
| **Perplexity** | Source-linked search/research, contextual Spaces, file/app creation and model choice. A published composer redesign groups tools behind `+` while retaining the selected model. Council runs three models and a separate synthesizer.[^perplexity-search][^perplexity-spaces][^perplexity-composer] | Juno has search, projects, a plus menu, source inspection and model comparison. Improve discoverability and citation usefulness. Multi-model execution should remain intentional and budgeted because it adds provider work. |

The common useful pattern is a clear prompt surface with contextual controls,
inspectable evidence, visible execution state, and results that remain useful
after generation. This is a synthesis of the documentation, not a claim that
all competitors implement every detail identically.

## 3. Prioritized remaining gaps

### P1: Make cost evidence complete before claiming savings

The inspected [evaluation runner](../../src/lib/eval/runner.ts) accepts a live
result with input/output token counts and latency, then estimates cost using
only those token fields while labelling its provenance `measured_usage`.
That establishes that token counts came from a live call; it does not establish
an invoice-equivalent total. Cache reads/writes, tool/media fees, multiple
attempts and provider-specific billing can change the total.

**Recommended closure:** reconcile benchmark cost with the existing request
meter and spend ledger. Report the pricing version, actual usage dimensions,
unknown-charge coverage and all failed/retried attempts. Keep the distinction
between a token-priced estimate and reconciled spend. The existing
[cost-per-accepted metric](../../src/lib/metering/cost-per-accepted.ts) is a
better outcome-oriented foundation than cost per request, but its extrapolation
from turns with known cost must remain visible through `costCoverage`.

### P1: Separate citation formatting from citation correctness

The general [evaluation suite](../../src/lib/eval/suite.ts) calls a source
"citable" when it has an HTTPS-shaped URL and a nonempty title. Its
`citationQuality` value therefore measures source metadata shape, not whether
a source supports the answer. Juno has a substantially richer
[research citation evaluation](../../src/lib/eval/research-citations.ts) that
checks the production audit against labelled cases, including false support,
contradiction and unresolved citations.

**Recommended closure:** present these as distinct metrics. Use the research
evaluation for support claims and expand with held-out, independently labelled
reports. Preserve its existing warning that the stock cases are in-sample
regression evidence. A valid-looking URL must never become an accuracy score.

### P1: Establish a comparable quality/latency/cost baseline

No same-task, same-conditions head-to-head benchmark was run for this report.
The inspected evaluation code correctly distinguishes `mock`, `live` and
`not_run`; keep that provenance in every presentation of results. A mock run
proves harness behavior and routing logic, not model quality.

**Recommended closure:** use an agreed task mix covering short chat, coding,
French/English instruction following, document questions, research, long
context and artifact revision. Preserve exact prompts and input files. Record
task correctness, user preference where appropriate, time to first useful
output, completion latency, interruption rate and total task cost. Compare
changes to Juno's baseline before making an equivalence claim about cheaper
model routing. Competitor subscription limits and Juno API cost are different
economic quantities and should not share one ranking.

### P2: Verify polish on real interaction paths

Code already contains motion preferences, accessible status messages, rich-text
loading boundaries and transcript follow logic. The remaining evidence gap is
how these interact under long answers, reconnection, slow chunks, mobile
keyboards, reduced motion, screen readers and 100-plus-message histories.

**Recommended closure:** run the existing authenticated journeys and design
gates on the changed build; add coverage only for a concrete uncovered risk.
Capture browser performance traces for representative large transcripts and
artifact transitions. Do not infer improvement from a screenshot or a smaller
component alone. Native behavior needs its own compiled/device evidence;
shared contract tests cannot prove SwiftUI layout or voice interaction quality.

**QA finding during implementation (29 October):** the existing
[screenshot matrix helper](../../e2e/support/screenshot-matrix.ts) supplied
`reducedMotion`, `contrast` and `forcedColors` directly to `test.use`. The
installed Playwright fixtures only pass these through `contextOptions`, so the
old screenshot names do not verify that those media preferences were active.
The helper now uses the supported nested options. The selected
[design audit journeys](../../e2e/design-primitives-audit.spec.ts) also assert
the browser's actual `matchMedia` results before drawing conclusions about
motion or contrast. Historical reduced-motion/high-contrast matrix labels
remain unverified; this change does not re-record or approve their baselines.

### P2: Treat provider documentation drift as a capability check

Provider cache rules, model availability and batch eligibility evolve. The
current OpenAI guide and a search-indexed API reference disagree about
supported cache lifetimes; see the appendix. This is an example of why a
generic future-model regex or old comment is not sufficient evidence of a new
parameter's support.

**Recommended closure:** keep provider/model capability tests and a small
explicit compatibility map. Reconfirm a new setting on the actual endpoint and
model before enabling it. Refresh catalog/pricing provenance without silently
substituting untested models.

## 4. UI, UX and motion direction

Preserve the existing flat transcript, restrained chrome, stable reading
column, progressive disclosure and shared motion tokens described in
[JUNO.md](../JUNO.md). Juno already uses dynamic rich renderers and stable
Markdown blocks. Repeating the usual advice to "lazy-load highlighting" or
"add reduced motion" would misdescribe this repository.

For changes in this pass, evaluate these specific outcomes:

1. A new user can identify the current mode/model, attach a file, and send a
   request without learning provider vocabulary.
2. Generation status, a recoverable failure, a stopped turn and a completed
   turn are distinguishable; navigation does not create a duplicate request.
3. Reading old content remains stable while new content arrives. User-directed
   jumping to the latest message respects reduced-motion preferences.
4. Copying, retrying, editing and inspecting sources have visible keyboard
   focus and adequate touch targets, including on narrow layouts.
5. Artifact edits and exports preserve the user's actual content and versions.

Use motion to explain a state transition, not to occupy attention continuously.
Browser guidance favors transforms/opacity over geometry-changing animation
when possible, because layout and paint can dominate rendering cost.[^motion]
Respect `prefers-reduced-motion` in both CSS and JavaScript.[^reduced-motion]
W3C guidance calls for status changes that assistive technology can announce
without moving focus, while WCAG 2.2's target-size rule specifies a 24-by-24 CSS
pixel minimum with documented exceptions.[^status][^target-size] Juno's
existing larger coarse-pointer targets should be preserved.

These are acceptance criteria and standards references, not a claim that this
static review establishes accessibility compliance or a specific frame rate.

## 5. API cost practices appendix

### Prompt caching: preserve useful work before changing the model

Caching can reuse input processing without intentionally reducing answer
capability. It still needs endpoint-specific implementation, a reusable prefix,
and complete billing evidence. Stable instructions/tool ordering should precede
changing context. Keep user/account scope intact; cache reuse is not permission
to mix private contexts.

| Provider | Officially documented behavior | Juno implication |
|---|---|---|
| **OpenAI** | Caching uses matching prefixes and model-specific boundaries. Modern models support explicit/implicit breakpoints; writes can carry a premium. The current guide describes a 30-minute default and a higher-priced 12-hour option on Responses.[^openai-cache] | Existing helpers distinguish single-use utility calls from reusable conversation/tool prefixes. Retain those distinctions; do not enable writes merely because caching sounds cheaper. Measure cache-read/write usage rather than assuming a hit. |
| **Anthropic** | `cache_control` can be automatic or attached to blocks. Default lifetime is five minutes; an hour costs more to write. Cache-read multipliers have model-specific exceptions.[^anthropic-cache] | Existing moving breakpoints and volatile-tail handling are valuable. Use observed reuse intervals to choose lifetime. Do not assume all Claude cache reads have the same multiplier or blanket-upgrade to one-hour writes. |
| **Gemini** | The current Interactions API supports implicit caching; explicit cache objects are not supported there or on Gemini 4 Argon onward. Supported older models can use explicit caching through `generateContent`; that path has storage-duration costs.[^gemini-cache][^gemini-legacy-cache] | Keep API generations and model capabilities distinct. Preserve shared prefixes and capture the endpoint's cached-token usage field. Explicit-cache plumbing is not automatically valid for every Gemini model. |
| **xAI** | Matching starting messages are cached automatically, without a guaranteed hit. Chat Completions uses `x-grok-conv-id` for affinity; Responses uses `prompt_cache_key`.[^x-cache][^x-cache-routing] | Juno already distinguishes the two wires. Keep stable conversation keys, avoid changing history unnecessarily, and check actual cached-token usage before reporting savings. |

**Documentation discrepancy, 29 October:** the opened OpenAI caching guide
documents `12h`, but the search-indexed Responses reference still describes
`30m` as the only supported TTL.[^openai-cache][^openai-response-reference]
The full reference could not be opened by this research tool because it
exceeded the retrieval size limit. Keep the currently used `30m` until a live
capability check resolves this for the exact model/endpoint; this is not a
reason to disable existing caching.

A simple planning check for a stable prefix is:
`cached cost = write cost + (number of requests - 1) × read cost`, versus
`uncached cost = number of requests × ordinary input cost`. Add changing input,
outputs, tool fees and storage separately. This is a cost model, not a measured
saving. A prefix never reused can cost more when writing has a premium.

### Batch APIs: only for work whose result can wait

| Provider | Documented economics and timing | Appropriate use in Juno |
|---|---|---|
| OpenAI | 50% reduction for eligible batch requests; a 24-hour processing window; no streaming. Expired batches can still contain completed, billable results.[^openai-batch][^openai-batch-faq] | Existing background-memory batching; offline evaluations and other explicitly delay-tolerant jobs. |
| Anthropic | 50% reduction; asynchronous completion, with unfinished requests expiring at 24 hours. Prompt caching can combine with batching, but hits are best effort.[^anthropic-batch] | Existing adapter; retain idempotent accounting and handle partial/expired results. |
| Gemini | 50% of standard cost with a target 24-hour turnaround on the documented `generateContent` batch path.[^gemini-batch] | A possible future adapter only if background volume justifies implementation and operational cost. |
| xAI | Discounts vary by model; the current pricing page lists 20% for specified Grok models and no discount for unlisted models. Completion within 24 hours is typical, not guaranteed.[^x-batch][^x-pricing] | Do not generalize another provider's 50% discount. Verify model eligibility and price before extending Juno's batch provider list. |

The inspected `BATCH_PROVIDERS` list contains OpenAI and Anthropic. Adding Google
or xAI batching is an optional, demand-driven extension, not a missing core chat
feature. Keep live chat and watched research on synchronous/streaming paths;
moving them to batch would violate the user's latency constraint.

### Retries: one accountable policy

OpenAI recommends honoring `Retry-After`, bounded attempts and total retry time,
and jitter when a server delay is unavailable. It specifically warns against
nested SDK/application retry multiplication and retrying billing/quota errors.
Anthropic documents transient retries and distinguishes spend-cap errors from
temporary limits. Gemini recommends exponential backoff with jitter and bounded
retries for transient failures. xAI documents backoff for rate limits.[^openai-retries][^anthropic-retries][^gemini-retries][^x-retries]

Juno's inspected OpenAI-compatible, Anthropic and batch clients already disable
hidden SDK retries; the request meter records attempts. Preserve that
accountability. Apply any retry policy to the whole operation, respect
cancellation, and do not silently restart an ambiguous completed or partially
streamed generation. Reconnection should recover the existing durable result.

### What would justify more usage for the same budget

Measure total cost per completed/accepted task, including discarded attempts,
cache writes, tools and background work. Report the cost coverage and retain a
quality/correctness gate. Lower token prices alone do not establish lower task
cost if the user must regenerate, repair or re-ask more often. No percentage
reduction or unchanged-quality claim is made by this research report.

## 6. Release evidence to attach to the improvement

| Claim | Required evidence |
|---|---|
| Better answer quality | A dated task set, actual outputs, grader limits, and task-specific correctness or blind comparisons. |
| Same or better performance | Before/after first-useful-output and completion distributions, browser traces on representative devices, bundle/build evidence, and interruption/error rates. |
| Lower API cost | Comparable workloads, provider usage dimensions, all attempts/tool charges, pricing provenance, and coverage of unknown costs. |
| Better accessibility and motion | Keyboard and reduced-motion journeys, screen-reader checks, narrow-screen/touch checks, and relevant automated gate results. |
| Safe to release across platforms | Current web integration/e2e evidence and native build/device evidence for affected behavior; explicit outstanding gates. |

This report supplies research and static code mapping. The main audit's
implementation and verification records should supply the measured evidence.

## Sources

All external sources below were retrieved on 29 October 2026 from official
vendor documentation or standards/browser guidance. URLs are included so future
audits can recheck changing behavior. Unless explicitly noted, product claims
are documentation evidence, not hands-on verification.

[^chatgpt-overview]: OpenAI, [ChatGPT capabilities overview](https://help.openai.com/en/articles/9260256-chatgpt-capabilities-overview).
[^chatgpt-blocks]: OpenAI, [Working with writing blocks and code blocks in ChatGPT](https://help.openai.com/en/articles/20001246-working-with-writing-blocks-and-code-blocks-in-chatgpt).
[^chatgpt-research]: OpenAI, [Deep research in ChatGPT](https://help.openai.com/en/articles/10500283-deep-research-in-chatgpt).
[^claude-artifacts]: Anthropic, [What are artifacts and how do I use them?](https://support.claude.com/en/articles/17153992-what-are-artifacts-and-how-do-i-use-them).
[^claude-research]: Anthropic, [Use research on Claude](https://support.claude.com/en/articles/11088861-use-research-on-claude).
[^claude-search]: Anthropic, [Enable and use web search](https://support.claude.com/en/articles/10684626-enable-and-use-web-search).
[^grok-overview]: xAI, [Welcome to Grok](https://docs.x.ai/grok/overview).
[^x-search]: xAI, [X Search](https://docs.x.ai/developers/tools/x-search). This is API documentation, not a consumer-plan entitlement table.
[^x-citations]: xAI, [Citations](https://docs.x.ai/developers/tools/citations). The complete list can include consulted URLs not referenced in the final answer.
[^gemini-canvas]: Google, [Create docs, apps and more with Canvas](https://support.google.com/gemini/answer/16047321?hl=en).
[^gemini-research]: Google, [Use Deep Research in Gemini Apps](https://support.google.com/gemini/answer/15719111?hl=en).
[^perplexity-search]: Perplexity, [What is Pro Search?](https://www.perplexity.ai/help-center/en/articles/10352903-what-is-pro-search).
[^perplexity-spaces]: Perplexity, [How to use/create Spaces](https://www.perplexity.ai/enterprise/videos/how-to-use-create-spaces). Terminology and plan availability should be checked in the target surface.
[^perplexity-composer]: Perplexity, [Upgraded deep research, Model Council, and a simplified input bar](https://www.perplexity.ai/en-GB/changelog/what-we-shipped---february-6th-2026). A dated official changelog establishes the shipped pattern, not every detail of today's UI.
[^motion]: Google web.dev, [Why are some animations slow?](https://web.dev/articles/animations-overview) and [CSS transitions](https://web.dev/learn/css/transitions).
[^reduced-motion]: Google web.dev, [prefers-reduced-motion](https://web.dev/articles/prefers-reduced-motion).
[^status]: W3C WAI, [Understanding Success Criterion 4.1.3: Status Messages](https://www.w3.org/WAI/WCAG21/Understanding/status-messages).
[^target-size]: W3C WAI, [What's new in WCAG 2.2](https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/).
[^openai-cache]: OpenAI, [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching). The opened guide includes 30-minute and 12-hour Responses lifetimes and different write rates.
[^openai-response-reference]: OpenAI, [Create a model response](https://developers.openai.com/api/reference/resources/responses/methods/create). Official search excerpt only in this pass: full retrieval exceeded the tool's content-size limit. Its indexed TTL description conflicts with the opened guide; do not treat the excerpt as a live capability probe.
[^anthropic-cache]: Anthropic, [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).
[^gemini-cache]: Google, [Context caching](https://ai.google.dev/gemini-api/docs/caching).
[^gemini-legacy-cache]: Google, [Generate Content context caching](https://ai.google.dev/gemini-api/docs/generate-content/caching.md).
[^x-cache]: xAI, [How prompt caching works](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/how-it-works).
[^x-cache-routing]: xAI, [Maximizing cache hits](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/maximizing-cache-hits).
[^openai-batch]: OpenAI, [Batch API](https://developers.openai.com/api/docs/guides/batch).
[^openai-batch-faq]: OpenAI, [Batch API FAQ](https://help.openai.com/en/articles/9197833-batch-api-faq).
[^anthropic-batch]: Anthropic, [Batch processing](https://platform.claude.com/docs/en/build-with-claude/batch-processing).
[^gemini-batch]: Google, [Batch API](https://ai.google.dev/gemini-api/docs/batch-api).
[^x-batch]: xAI, [Batch API](https://docs.x.ai/developers/advanced-api-usage/batch-api).
[^x-pricing]: xAI, [API pricing](https://docs.x.ai/developers/pricing).
[^openai-retries]: OpenAI, [Rate limits](https://developers.openai.com/api/docs/guides/rate-limits).
[^anthropic-retries]: Anthropic, [API errors](https://platform.claude.com/docs/en/api/errors) and [TypeScript SDK retries](https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript).
[^gemini-retries]: Google, [Troubleshooting guide](https://ai.google.dev/gemini-api/docs/troubleshooting).
[^x-retries]: xAI, [Rate limits](https://docs.x.ai/developers/rate-limits).

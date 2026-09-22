# September 22, 2026 model research pass

Full research of every configured lab's live text/image/video catalog, plus a
scan for labs Juno does not yet integrate. Context and prior audit:
[`docs/models-september-2026.md`](./models-september-2026.md) (Sept 6, 2026).

**Working conditions for this pass:** this environment's egress proxy blocks
`platform.openai.com`, `ai.google.dev`, `docs.x.ai`, `dev.meta.ai`,
`alibabacloud.com`, `volcengine.com`, `docs.z.ai`, and every other provider
console/docs domain by organization policy — the same policy that blocks
`openrouter.ai`, which is why `npm run radar:models` (the industry-radar step
in `sync-models.yml`) cannot run here either. Every finding below came from
web search (secondary/aggregator sources, cross-checked against each other)
rather than a primary-doc fetch or a live provider key. Treat anything not
marked "high confidence" the way the Meta section of the prior audit treats
Muse Spark/Muse Image: real, but unverified against a live key or primary
doc — confirm before the next hand-curation pass leans on it further.

## Added this pass

**Grok 4.7** (`xai:grok-4.7`) — released 2026-09-21, one day before this
audit. Same $2/$6 per MTok pricing and 500K context as 4.6, on a
2.1T-parameter base (40% larger than 4.6's 1.5T), positioned for agent runs
that unfold over hours rather than minutes. Reasoning ladder is
low/medium/high(default)/xhigh — identical shape to 4.6's, so `reasoningCaps`
reuses it. No Artificial Analysis Intelligence Index has been published for
it yet, so `model-metrics.ts` carries it as a positioning estimate
(`source:"provider"`), not `official()`. 4.6 steps down to `legacy` in the
same family. **High confidence on id/price/context** (converged across
several independent sources, one of which was xAI's own docs listing);
**not verified against a live key**.

Fixed in the same pass: `model-metrics.ts`'s xai `FAMILY_RULES` had
`{ hints: ["grok-4.6", "grok-4.5"], metric: official(...) }`. Hints are
AND'd (`hints.every(h => id.includes(h))`), and no id contains both
substrings, so that rule could never match *either* model — 4.5 was silently
falling through to the generic `grok` catch-all (`source:"provider"`, wrong
1,000,000-token context) and losing its official II 53.8 benchmark row. Split
into two single-hint rules carrying the same metric, since 4.5 and 4.6
genuinely share EU-mid-July pricing and that benchmark run.

## Added later the same day: GPT-6 Sol, GPT-6 Luna, and Claude Opus 5.5 at launch

Unlike the pass above, these were checked against the providers' own primary
pages (fetched directly: `developers.openai.com/api/docs/models/gpt-6-sol`,
`…/gpt-6-luna`, `…/gpt-6-astra`, `platform.claude.com/docs/en/models/opus-5-5/*`,
`platform.claude.com/docs/en/about-claude/pricing`, `…/build-with-claude/fast-mode`,
`docs.x.ai/developers/models/grok-4.7` and `…/grok-4.6`).

| Model | Provider ID | Context | Input / output per MTok | Cached input | Thinking |
| --- | --- | --- | --- | --- | --- |
| GPT-6 Sol | `gpt-6-sol` | 1,050,000 (922K in, 128K out) | $2 / $10 | $0.20 (writes $2.50) | none · low · medium (default) · high · xhigh · max |
| GPT-6 Luna | `gpt-6-luna` | 1,050,000 (922K in, 128K out) | $0.10 / $0.50 | $0.01 (writes $0.125) | none · low · medium (default) · high · xhigh · max |
| Claude Opus 5.5 | `claude-opus-5-5` | 1,000,000 (128K out) | $4 / $20 | $0.20 (5m write $5, 1h $8) | adaptive, always on · low…max · medium default |
| Grok 4.7 | `grok-4.7` | 500,000 | $2 / $6 (≥200K prompt: $4 / $12) | $0.50 (≥200K: $1) | low · medium · high (default) · xhigh |

**GPT-6 Sol / Luna** replace the GPT-5.6 Sol and Luna tiers in their families
(`gpt`, `gpt-luna`); both 5.6 rows stay selectable as `legacy`. GPT-5.6 Terra
has no GPT-6 counterpart and stays current. Both serve Chat Completions and
Responses, so they use the ordinary chat adapter like the 5.6 tiers. Unlike
Astra they list `none`, so Instant sends `reasoning_effort: "none"` (it has
to be explicit — without it they think at `medium`). Long prompts (>272K
input) bill 2x input/cache and 1.5x output for the whole request, and Fast
mode (`service_tier: "priority"`, OpenAI's former name for it) is 2x — both
now metered. Ids that migrated to GPT-5.6 Sol (`gpt-5.6`, `gpt-5.5-thinking`,
`o1-preview`, and the `replacedBy` of gpt-5 / o3 / gpt-4o / gpt-4-turbo) now
migrate to GPT-6 Sol, since a migration target has to be `current`.

**Claude Opus 5.5** was already registered from a pre-launch Console read
(Sept 22 morning); the launch page corrected it. Price is $4/$20, not $5/$25,
and cache reads are 0.05x rather than 0.1x. More importantly it has four
breaking changes against Opus 5, three shared with Fable 5.1: thinking can't
be disabled (`{type: "disabled"}` and manual `budget_tokens` are 400s), forced
`tool_choice` (`any`/`tool`) is a 400, and thinking blocks are bound to the
model and conversation; `computer_20251124` is also rejected. Juno sends only
`auto`/`none` tool choice and no computer-use tool, so the only change needed
was thinking: Opus 5.5 now takes Fable's always-on path — no Instant option,
adaptive thinking with `display: "summarized"` on every request, and its own
`medium` default instead of Fable's `high` — in the web adapter, the vendored
runner copy (`runner/agent-core/src/providers/thinking.ts`, which had also
drifted and never asked Opus 5 / 5.5 for summarized thinking) and the native
Code wire.

**Grok 4.7** is now confirmed on xAI's own page (id, price, context, effort
ladder). Both 4.6 and 4.7 bill every token at 2x once a prompt reaches 200K
tokens, which Juno had not been metering; it is now.

**How routing was verified.** `tests/september-22-models.test.ts` pins each id
from the picker to the provider: it resolves to itself (no migration), goes out
on its provider's own transport, and the probe request — built from the same
routing and wire-id boundary as the chat adapters — targets the documented
endpoint with the documented `model`. Separately, Juno's real `streamChat`
path was driven with the network stubbed and the outgoing requests captured:
Opus 5.5 → `api.anthropic.com/v1/messages` with `model: "claude-opus-5-5"` and
adaptive thinking on every tier (never `disabled`); GPT-6 Sol/Luna →
`api.openai.com/v1/chat/completions` with their exact ids, `none` for Instant
and `max` at the top; Grok 4.7 → `api.x.ai/v1/chat/completions` with
`model: "grok-4.7"`; and a stored `openai:gpt-5.6` → `gpt-6-sol`.

## Considered and explicitly NOT added

**OpenAI Sora (video)** — Juno has never carried an OpenAI video model. Sora
looked like the obvious gap. It is not: OpenAI notified developers on
2026-03-24 that the Videos API and every `sora-2`/`sora-2-pro` alias and
dated snapshot are removed from the API on **2026-09-24** — two days after
this audit. Confirmed independently by OpenAI's own Help Center article on
the discontinuation and by `developers.openai.com/api/docs/deprecations`
(titles/snippets only — the pages themselves are proxy-blocked here). Adding
a model two days from shutdown, with no replacement to set as `replacedBy`,
would fail `validate:models`' own retirement invariant on arrival. Not added.

**Alibaba Wan 2.7 (video, `wan2.7-t2v` / `wan2.7-i2v`)** and **Qwen-Image 3.0
/ 3.0 Pro (image)** — both are real, shipped, documented Alibaba Cloud Model
Studio products (Wan 2.7 launched as a four-model suite — t2v/i2v/
reference-to-video/video-edit — at roughly $0.15/s at 1080p; Qwen-Image 3.0
and 3.0 Pro price around $0.025–$0.035/image). Not added: `src/lib/qwen`
carries zero image or video models today, which means there is no adapter
for either modality on this provider. Juno's image path
(`src/lib/image-gen.ts`) falls back to a generic OpenAI-compatible
`/images/generations` call for any provider not given its own function, but
Alibaba's image-synthesis API — like its video API — is documented across
multiple independent sources as an **async task-submit-then-poll** flow
(`task_id` → poll → result URL), not a single synchronous call. Registering
either model without writing and verifying that adapter would register a
model that 400s or hangs on every generation. See "A gap this pass found"
below for why that specific failure mode is not hypothetical.

**ByteDance Seedream (image, Volcengine Ark)** — same shape of gap as Wan/
Qwen-Image. `seedance` (Juno's ByteDance/Volcengine Ark provider) already has
a working **video** adapter (`seedanceAdapter` in `src/lib/video-gen.ts`),
but Seedream is a *different* Ark product, and sources disagree on whether
its image endpoint is synchronous (like OpenAI's `/images/generations`,
which the generic fallback assumes) or an async submit/poll pair like
Seedance video. Given that disagreement and no live key to resolve it,
not added rather than guessed.

**Claude Mythos** — still restricted to Project Glasswing partners as of this
audit; Fable 5.1 remains the GA "Mythos-class" product. Matches what the
prior audit already recorded — no change.

## A gap this pass found (pre-existing, not introduced here)

`src/lib/models.ts` already registers two xAI **video** models —
`xai:grok-imagine-video` and `xai:grok-imagine-video-1.5` — but
`src/lib/video-gen.ts`'s `adapterFor()` only recognizes `google` (Veo),
`minimax`, `zhipu`, and `seedance`. There is no `xai` case, so both models
fall through to `null` and every generation attempt throws
`videoGenUnsupportedMessage`: *"Video generation for Grok Imagine Video is
not wired yet — try Veo, Gemini Omni, or Hailuo."* They are selectable in
the picker and bill as if functional; they are not. This is exactly the
failure mode the Wan/Qwen-Image/Seedream decisions above were made to avoid
reproducing. Fixing it needs a verified `docs.x.ai` Grok Imagine Video
request/poll shape, which this pass could not fetch — filed here rather than
guessed at.

## Everything else: unchanged, and why

Every other currently-`current` model in the catalog was re-checked against
this pass's research and is still the newest of its family as of 2026-09-22:
Claude Fable 5.1 / Opus 5 / Sonnet 5 / Haiku 4.5, GPT-6 Astra and the 5.6
tiers, Gemini 3.8 Flash / 3.1 Pro, Muse Spark 1.3 (+ Contributor) / Muse
Image, GLM-5.3 / GLM Image / CogVideoX, Kimi K3, DeepSeek V4.1 Flash / V4
Pro, Mistral Medium 3.5, MiniMax M3 / Hailuo 2.3, MiMo V2.6, Qwen3.8 Max /
Flash, Veo 3.1. The 16-day gap since the last audit (Sept 6 → Sept 22) did
not turn up a second frontier release besides Grok 4.7.

**Not evaluated for integration:** labs outside the 14 already configured in
`src/lib/providers.ts` (Amazon Nova, Cohere, Perplexity Sonar, AI21, Stability
AI, Black Forest Labs/Flux, Runway, Luma, Kling, Ideogram…). Several of these
would fit the existing OpenAI-compatible adapter shape reasonably well
(Perplexity and Cohere both publish OpenAI-compatible chat endpoints), but
onboarding a new provider is a materially bigger, differently-scoped change
(provider config, secrets, CI plumbing, a verified adapter) than this pass's
brief, and none was requested. Candidates for a future pass, not gaps in
this one.

## Sources

Primary-doc fetches were blocked in this environment (see above); the
following are the search results this pass's findings are triangulated
across. None is a `platform.claude.com`/`ai.google.dev`/`docs.x.ai`-grade
primary source except where noted.

- Grok 4.7: multiple independent launch-day writeups (2026-09-21/22),
  including one search result surfaced directly from `docs.x.ai/developers/models`.
- Sora discontinuation: OpenAI Help Center, "What to know about the Sora
  discontinuation"; `developers.openai.com/api/docs/deprecations`.
- Wan 2.7: OpenRouter, fal.ai, Together.ai, and EvoLink listings, cross-checked
  against Alibaba Cloud Model Studio's own doc-page titles ("Wan2.7 - Text-to-
  Video API Reference" vs. "Wan - text-to-video API reference (2.1-2.6)"
  marked legacy).
- Qwen-Image 3.0: tech-insider.org, PixMind (two independent posts), aireiter.com.
- Seedream: therundown.ai, evolink.ai, cometapi.com, tech-insider.org,
  GitHub `xujfcn/seedream-guide` — internally inconsistent on release dates
  and sync-vs-async request shape, which is why nothing here was registered.

Live provider inference requires deployment credentials and was not
exercised in this change, for any model — new or pre-existing.

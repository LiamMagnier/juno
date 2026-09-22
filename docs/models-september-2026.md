# September 2026 model refresh

Verified against provider documentation on September 6, 2026. Exact provider IDs
are curated; predecessor IDs remain selectable as legacy entries.

| Model | Provider ID | Context | Input / output per million tokens |
| --- | --- | --- | --- |
| Claude Opus 5.5 | claude-opus-5-5 | 1,000,000 | $5 / $25 |
| Claude Fable 5.1 | claude-fable-5-1 | 1,000,000 | $10 / $50 |
| Gemini 3.8 Flash | gemini-3.8-flash | 1,048,576 | $0.75 / $3.75 |
| Grok 4.6 | grok-4.6 | 500,000 | $2 / $6 |
| Muse Spark 1.3 | muse-spark-1.3 | 1,048,576 | $1.25 / $4.25 (cache read $0.15) |
| Muse Spark 1.3 Contributor | muse-spark-1.3-contributor | 1,048,576 | $0.10 / $0.20 (cache read $0.002) |
| Muse Image | muse-image-1.0 | n/a | $0.01 per returned image |

Fable 5.1 uses adaptive reasoning, defaults to high, and supports low through max.
Its cache-read price is $0.25 per million tokens; older Fable cache pricing is
unchanged. Existing Anthropic transport already supplies adaptive thinking and
preserves thinking blocks during tool loops.

Gemini 3.8 uses low, medium, or high thinking, defaulting to medium. Gemini
3.6–3.8 Flash promotional pricing lasts through December 31, 2026; recheck rates
before January 1 ($1.50 / $7.50 announced). Cache reads are 10% of input pricing.
Grok 4.6 supports low, medium, high and xhigh, defaulting to high; 4.5 retains its
three-level ladder. GPT-6 Astra was already curated. Restricted Mythos access is
not advertised as general availability.

## Meta · Muse

Muse Spark 1.3 (2 September 2026) is the same 1M-window multimodal reasoner as
1.2 — text, image and video in — finishing comparable tasks in roughly 20% fewer
tool calls and 25% fewer tokens, and reporting 98.5% on million-token retrieval.
Its reasoning ladder is 1.2's plus a `max` rung: minimal, low, medium, high,
xhigh, max, defaulting to medium, with no way to turn reasoning off. 1.2 steps
down to legacy.

**Muse Spark 1.3 Contributor is not a cheaper model — it is the same model on
different terms.** `muse-spark-1.3-contributor` serves identical weights at
$0.10/$0.20 per MTok (12.5x and 21.25x below standard, 75x on cached input) in
exchange for Meta's right to train on the prompts and completions sent to it,
and is rate-limited to 100 requests/minute against standard's 3,000. Both tiers
are registered and both are selectable. They are separate `family` slugs, so
neither hides the other in a picker that shows one current row per family, and
their migration ladders never cross: a stored contributor id moves to a newer
contributor id, never to standard (which would be a silent 12.5x price rise),
and nothing on the standard ladder can ever resolve to a contributor id (which
would opt a reader into training through a rename). The contributor row carries
`trainsOnPrompts`, which keeps it out of `pickAutoModel`, `cheapestWorkModel`
and `pickWorkModel` — it is otherwise the cheapest model on the catalog that
clears Work's intelligence floor, so without the flag it would have become the
standing default for every unattended run.

Muse Image reached the Meta Model API on 26 August 2026 at $0.01 per returned
image, flat — the same whether `reasoning_strength` is high or low and whether
or not it uses its built-in web and image search, neither of which is billed
separately. The API id is `muse-image-1.0`; `muse-image` and `muse-image-1` are
how the launch material writes it and are registered as aliases, because an
unrecognised id resolves to a fabricated *chat* model rather than failing. It is
reached through the OpenAI-shaped `/v1/images/generations` and
`/v1/images/edits`, so no Meta-specific transport was needed. Editing is
instruction-scoped (a prompt plus up to ten reference images via `images_list`),
not mask-scoped — Meta publishes no `mask` parameter — so Meta is registered as
a `"prompt"` image-edit provider and `editOpenAICompatImage` now withholds the
mask from any provider that is not `"mask"`.

No Meta credential was available, so none of the above was exercised against a
live key; it is curated from Meta's own documentation and the gateways
reselling the models.

## Anthropic · Claude Opus 5.5

Not (yet) covered by Anthropic's public docs at the time of this entry — no
`platform.claude.com/docs/en/models/opus-5-5/` page, and web search for
"Claude Opus 5.5" turned up only unconfirmed leak blogs, not an Anthropic
announcement. Curated instead from the account owner's own Claude Platform
Console — Dashboard → model card, `claude-opus-5-5` — which is a live,
first-party read of an account's actual model list rather than a rumor site.

Console card showed: description "Powerful model for complex work"; $5/$25
per MTok input/output (same as Opus 5 — Anthropic did not reprice the family
for this release, unlike the leaked "20% cheaper" rumor); prompt-cache write
$6.25/MTok and read $0.50/MTok (the standard 1.25x/0.1x-of-input Anthropic
ratios, unchanged); fast mode $10/$50 (2x, same multiplier as Opus 4.8); 1M
context window; 128K max output; adaptive thinking; fast mode supported;
May 2026 knowledge cutoff.

Registered as `anthropic:claude-opus-5-5`, family `opus`, `current` — Opus 5
moves to `legacy` in the same family (one current model per family per the
picker convention). No independent benchmark coverage exists yet, so
`model-metrics.ts` intentionally does NOT get a dedicated `opus-5-5` hint —
it falls through to the existing generic `opus` family rule
(`official(5, 25, 1_000_000, 4, 9)`), which already matches the console's
price and context figures and keeps the intelligence/speed grades as
positioning estimates pending real benchmark data, exactly like `gpt-5.5-pro`
and other unbenchmarked entries already do in that file.

Live provider inference was not exercised for this entry (no API credential
available in this environment) — only the Console's own model-catalog UI,
which is generated from Anthropic's live model registry for the signed-in
account. Recheck against `platform.claude.com/docs` once Anthropic publishes
a model page.

Sources:
- https://platform.claude.com/docs/en/models/fable-5-1/overview
- https://platform.claude.com/docs/en/models/fable-5-1/migration-guide
- https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash
- https://ai.google.dev/gemini-api/docs/pricing
- https://docs.x.ai/developers/models/grok-4.6
- https://docs.x.ai/developers/model-capabilities/text/reasoning
- https://dev.meta.ai/docs/models
- https://dev.meta.ai/docs/pricing-rate-limits
- https://dev.meta.ai/docs/image-generation
- https://developer.meta.com/ai/models/muse-spark/
- https://developer.meta.com/ai/models/muse-image/
- https://developer.meta.com/ai/resources/blog/build-with-muse-Image/

Live provider inference requires deployment credentials and was not exercised in
this change. Documentation verification does not imply every provider account
has access.

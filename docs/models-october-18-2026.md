# October 18, 2026 model and reasoning audit

Audit date: **2026-10-18**. Previous passes: [`models-september-22-2026.md`](./models-september-22-2026.md)
and the `models:sync` run of 2026-10-10 ([`models/sync-reports/2026-10-10-applied.md`](./models/sync-reports/2026-10-10-applied.md)).
Today's sync run: [`models/sync-reports/2026-10-18-applied.md`](./models/sync-reports/2026-10-18-applied.md).

What this pass covered:

- every lab's official model list, changelog and deprecations page, looking for releases since the last audit;
- every catalogue chat model's reasoning control, checked against the lab's own docs: whether it reasons, the
  control type, the valid tiers, the default, whether it can be turned off, and the parameter name;
- the request bodies Alevr actually sends for each offered option, now pinned by `tests/model-effort-wire.test.ts`.

All facts were read from official pages, with no API keys used. Where a page could not be read, this document
says so instead of guessing.

## The Claude Haiku 5.5 failure

**Symptom:** Claude Haiku 5.5 failed in Alevr Code on Mac and iOS, and in Work and cloud agent runs. Chat on the
web worked.

**Cause:** two request builders sit outside the website's chat path:

- `runner/agent-core/src/providers/thinking.ts`, the agent runtime that the Mac app and the cloud runner both bundle;
- `native/Packages/JunoCode/Sources/JunoCodeBridge/CodeThinkingWire.swift`, the Code app's own body builder.

Both classified *every* model id containing `haiku` as extended-thinking-only. Any effort tier therefore went out
as `thinking: {type: "enabled", budget_tokens: N}`. Claude Haiku 5.5 is adaptive-only. Anthropic's per-model
table marks it as rejecting `"enabled"` with a 400:

> "thinking.type.enabled" is not supported for this model.

Source: platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting.

Instant had the opposite fault. Haiku 5.5 thinks by default, and Instant sent nothing, so Instant turns still
reasoned.

**Fix:** both copies now mirror `src/lib/anthropic-thinking.ts`, which already had it right:

- Effort tiers send adaptive thinking plus `output_config.effort`, with `display: "summarized"`.
- Instant sends `thinking: {type: "disabled"}`. Haiku 5.5 accepts this only at effort high or below, so Instant
  never carries an effort.

A test now holds the agent runtime to the website's thinking shape for every Claude model at every effort.

**Haiku 5.5's contract** (platform.claude.com effort docs):

| Property | Value |
| --- | --- |
| Effort levels | low, medium, high, xhigh, max |
| Default effort | medium |
| Thinking | adaptive, on by default |
| `disabled` | accepted at effort high or below |
| Max output | 128K |
| Context | 1M |

## Reasoning fixes

| Model(s) | Was | Now | Source |
| --- | --- | --- | --- |
| Claude Haiku 5.5 (agent runtime, Mac and iOS Code) | `enabled` + `budget_tokens` (400); Instant kept thinking | adaptive + effort; Instant sends `disabled` | platform.claude.com effort, thinking-troubleshooting |
| Claude Sonnet 5.5 (agent runtime) | Instant sent `disabled` (400 on Sonnet 5.5) | Instant sends `between_tools` | thinking-troubleshooting |
| Claude Opus 5 (agent runtime) | Instant sent nothing, so it thought anyway | `disabled` | thinking-troubleshooting ("On" by default) |
| Grok 4.3 | Instant sent no effort, so it ran at the API default `low` | `reasoning.effort: "none"` | docs.x.ai model page (none, low, medium, high, xhigh; default low) |
| Grok 4.20 Multi-Agent | default shown as medium | default high | docs.x.ai/docs/guides/reasoning ("defaults to high") |
| GLM-5.3 (production compat adapter) | `thinking: {type: "enabled"}` alongside the effort | effort only, the same body `llm/compat-loop.ts` sends | docs.z.ai glm-5.3 (effort low, high, max; always on) |
| DeepSeek V4.1 Flash / V4 Pro (`compat-loop.ts`) | Instant `reasoning_effort: "none"` | `thinking: {type: "disabled"}`, matching the production adapter | api-docs.deepseek.com/guides/thinking_mode |
| Mistral Large 4 | no reasoning control | high/none toggle (`reasoning_effort`) | docs.mistral.ai/capabilities/reasoning |
| Qwen3.8 Omni Flash | no control ("levels not published") | Instant plus minimal, low, medium, high, xhigh, max via `enable_thinking` + `reasoning_effort` | Model Studio Chat Completions reference |
| GLM-5.2 (capability registry) | parameter reported as `thinking.type` | `thinking.type + reasoning_effort` | docs.z.ai capabilities/thinking |
| MiniMax M3 (capability registry) | "Thinking" mapped to `enabled` | `adaptive`, the only on-value the API lists | platform.minimax.io text-chat-openai |

The following matched the docs and were left unchanged:

- every OpenAI row, checked against each model page's `reasoning.effort` list;
- every Gemini row, checked against the `thinking_level` table;
- Grok 4.7, 4.6 and 4.5;
- Kimi K3, K2.7 Code and K2.6;
- GLM-5.3 and the GLM on/off models;
- DeepSeek tiers;
- MiMo, LongCat, Qwen 3.5, 3.6 and 3.7, and Meta Muse.

## Catalogue changes

| Model | Change | Source |
| --- | --- | --- |
| `qwen:qwen3.8-27b` | **Added.** Hybrid thinking (3.8 ladder), image and video in, 1M context, tools. $0.50 in / $3.00 out per MTok, cache hit $0.10 | alibabacloud.com/help/en/model-studio/qwen3-8-27b |
| `qwen:qwen3.8-2.4t-a95b` | **Added.** Thinking-only (low, medium, xhigh; default xhigh), text only, 1M context, tools. $2 in / $6 out per MTok, cache hit $0.25 | alibabacloud.com/help/en/model-studio/qwen3-8-2-4t-a95b |
| `deepseek:deepseek-flash` | The alias now serves the V4.1-Flash-1017 snapshot (2026-10-17). DeepSeek publishes no pinned id, and price and API are unchanged | api-docs.deepseek.com/updates |
| `openai:gpt-4o`, `openai:gpt-4o-mini` | legacy → **deprecated**, retire 2027-01-14, replaced by GPT-6 Luna | developers.openai.com/api/docs/deprecations (notice 2026-10-14) |
| `google:gemini-3.1-flash-image` (Nano Banana 2) | legacy → **deprecated** (Oct 6, no shutdown date), replaced by Nano Banana 2.1 | ai.google.dev Gemini API changelog |
| `minimax:MiniMax-M2.7`, `MiniMax-M2.7-highspeed`, `MiniMax-M2.5` | → **deprecated**, retire 2026-11-18, replaced by MiniMax M3 | platform.minimax.io/docs/guides/models-intro |
| `mimo:mimo-v2.5`, `mimo:mimo-v2.5-pro` | **Retired** 2026-10-13; stored ids redirect to V2.6 Flash / V2.6 Pro (`models:sync`) | mimo.mi.com deprecation page |

No other new API models were published since the last audit by these labs:

- Anthropic, OpenAI, Google (Gemini 4 Argon and Nano Banana 2.1 were already in), xAI;
- Mistral (Large 4 was already in), Z.ai, Moonshot, MiniMax, LongCat, Meta.

Meta's "Muse Spark Open" (2026-10-15) and "Muse Glimmer" are open-weight releases with no Model API id, so they
are not added.

### Rates

The `models:sync` run with no keys (`--no-api`) verified 104 official rates today and wrote the two new Qwen rows.

It also found a parser bug. Anthropic's fast-mode table now prints prices as `$8 USD / MTok`. The parser could not
read it and would have removed the fast tier from Opus 5.5, Opus 5 and Opus 4.8. Fixed in two places:

- `scripts/model-sync/tables.ts` now reads that format.
- `labs/anthropic.ts` treats an empty read of the table as a format change, not a withdrawal.

Fast mode is unchanged: $8 / $40 on Opus 5.5, $10 / $50 on Opus 5 and Opus 4.8.

Pricing notes:

- Mistral Large 4's launch sale ($0.68 / $2.09) is reported but not billed; the list price is kept.
- Claude Haiku 5.5 is billed at $0.10 / $0.50 up to 100K prompt tokens and $0.50 / $2.50 above that. This was
  already on file.

## Availability on web, Mac and iOS

Pickers list a model only when its lab is configured on the deployment. This was already true.

New in this pass: a lab failing its cached health probe, or a model failing its own capability probe, is now shown
**disabled with a reason** on all three surfaces. Before, it was offered as a selection that could only fail.

| Surface | How it shows |
| --- | --- |
| Native manifest (`/api/v1/models`, `/api/v1/bootstrap`) | `availability: "health_check_failed"` with `availabilityReason: "provider_unhealthy"`. The Mac and iOS apps already render this as "Temporarily unavailable" |
| Web (`/api/models`) | `unavailableReason` on the model; the web selector disables the row |

The lab is never removed from the list. `model-catalog-api.ts` explains why a lab silently vanishing was worse.

The native effort pickers read each model's `supportedReasoningEfforts`, `reasoning.canDisable`,
`reasoning.onOffOnly` and `reasoning.defaultEffort` from the manifest. See the PR for the native changes.

## Could not verify

- **Xiaomi MiMo:** the pricing, model and news pages returned 404. Only the deep-thinking guide was readable.
  `models:sync` did read the pay-as-you-go price page.
- **BytePlus ModelArk (Seedance):** the pages render only navigation when fetched. Nothing newer than Seedance 2.5
  was found.
- **GPT-6 Astra default effort:** neither the model page nor the reasoning guide states one. Medium is kept as the
  inferred default.

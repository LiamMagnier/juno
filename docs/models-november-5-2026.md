# November 5, 2026 model audit

Audit date: **2026-11-05**. Previous pass: [`models-october-25-2026.md`](./models-october-25-2026.md).

What this pass covered:

- every model announced by a lab Alevr carries between 2026-09-01 and 2026-11-05, compared against the catalogue;
- the nightly `models:sync` report of 2026-11-05 (issue #135), which read OpenAI's, Google's, xAI's, DeepSeek's,
  MiMo's, Z.ai's and Mistral's pages from GitHub Actions;
- a local `models:sync` dry run. From this host it read only Anthropic's pages (the proxy refuses the other labs),
  so every other fact below was read from the lab's page through a web fetch.

Because no lab page except Anthropic's was parsed by `models:sync` here, **no row was written to
`model-rates.generated.ts`**. New prices live in the hand-coded fallbacks (`pricing.ts`, `model-metrics.ts`); the
next nightly `--apply` writes the official rows.

## Catalogue changes

| Model | Change | Source |
| --- | --- | --- |
| `openai:gpt-6.1-terra` | **Added**, family `gpt-value`, current. 1,050,000 context, 128K output, text + image in. Chat Completions and Responses, "Tool calling requires the Responses API" (routed to Responses). Effort none / low / medium (default) / high / xhigh / max, so Instant is offered. $1 in, $0.05 cached, $5 out; over 272K input 2x input and 1.5x output; fast mode 2x | developers.openai.com/api/docs/models/gpt-6.1-terra; models index |
| `openai:gpt-5.6-terra` | current → **legacy** (superseded). Stored ids (`gpt-3.5-turbo`, `gpt-5.1-codex-mini`) and `gpt-5-mini`'s `replacedBy` re-pointed to 6.1 Terra | as above; nightly sync plan |
| `openai:gpt-image-2.6-sunburst`, `openai:gpt-image-2.6-flare` | **Added**, families `gpt-image` / `gpt-image-fast`, current. Text + image in, image out, generations and edits. $5 text in, $8 image in, $30 image out per MTok (same as 2.5). The image reference scopes `xhigh` / `max` quality and transparent backgrounds to the 2.5 models, so 2.6 is offered auto…high quality and no background picker until OpenAI documents more | developers.openai.com/api/docs/models/gpt-image-2.6-*; images reference |
| `openai:gpt-image-2.5-sunburst`, `-flare` | current → **legacy**. DALL·E and `gpt-image-1` redirects, and the 1.5 / 1-mini `replacedBy`, now land on 2.6 | as above |
| `google:gemini-omni-1.2-flash` | **Added**, family `gemini-omni`, current, MAX plan. GA on the Gemini API 2026-11-05. Clips up to 15s, 360p/720p drafts with 1080p/4K upscale, $0.07/s at 720p (metered at its 15s ceiling, $1.04). Same Interactions API wire as 1.1; the post mentions a 3–15s length setting but the Omni guide documents no request field, so the prompt still steers length | blog.google "Introducing Gemini Omni 1.2 Flash" (id from its AI Studio link) |
| `google:gemini-omni-1.1-flash` | current → **legacy**; still served on the Omni path. Veo / Omni-preview redirects re-pointed to 1.2 | as above |
| `zhipu:glm-5.3-flashx-legal` | **Added**, family `glm-legal`, current. Z.ai pricing page (Text Models): $0.37 / $1.25, cache $0.075. Legal specialist built on FlashX; shares FlashX's thinking contract. Text only, since Z.ai documents no image input for it | docs.z.ai/guides/overview/pricing; z.ai GLM-Legal announcement (2026-10-12) |
| `xai:grok-imagine-image-quality` | retired 2026-11-02, moved to `RETIRED_MODELS` → `grok-imagine-image-2.0` (`models:sync --apply --only xai`) | xAI release notes, 2026-11-02 |

Also updated: the Code agent ranking (6.1 Terra in 5.6 Terra's place), the pinned tool records, the
tool-runtime coverage record, and the Mac model-picker fixture.

## Not added

| Candidate | Why |
| --- | --- |
| `gpt-6.1-terra-pro`, `-sol-pro`, `-luna-pro` (OpenRouter) | OpenRouter's slug for `reasoning.mode: "pro"`, which Alevr exposes as Pro mode (`not-carried.json`) |
| `gpt-5.6-cyber`, `gpt-rosalind-research` | restricted to approved organisations |
| `deepseek-v4.1-flash-1017` | the dated snapshot behind `deepseek-flash`, which Alevr carries |
| Muse Spark Open | open-weight release on Hugging Face; not on Meta's Model API |
| Qwen Image 2.1 Pro / Turbo, Qwen Audio 3.1, Voxtral 3, Grok Voice 3.0 | no adapter for that lab's image or speech API in the catalogue (voice lives in the relay) |
| GLM-5.3 Prime, Qwen3.8 Max Prime | OpenRouter only; not on Z.ai's or Model Studio's pages |
| Non-carried labs (Tencent, StepFun, Cohere, NVIDIA, Inception, …) | Alevr has no provider integration for them |

No new API chat models were found from Anthropic (pages read directly), Google (beyond Omni), xAI, Meta, Mistral,
DeepSeek, Qwen, Xiaomi MiMo, MiniMax, Moonshot or LongCat in the window that were not already in the catalogue.

## Could not verify

- Release days for GPT-6.1 Terra and GPT Image 2.6: the model pages give none. `released` uses OpenRouter's first
  sighting (Terra, 2026-10) and the nightly sync's (2.6, 2026-11).
- Gemini Omni 1.2's duration field and the 1.1 transition: one secondary report says 1.1 requests route to 1.2 on
  2026-12-03; Google's post does not, so no retirement date was written.
- GLM-5.3-FlashX-Legal's context window (1M) comes from Vercel's gateway card, not Z.ai.

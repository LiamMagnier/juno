# October 25, 2026 model audit

Audit date: **2026-10-25**. Previous pass: [`models-october-18-2026.md`](./models-october-18-2026.md).

What this pass covered:

- releases and announcements from every lab Alevr carries between 2026-10-18 and 2026-10-25;
- the request contract of each new model (context, output, reasoning control, inputs), so the model is wired
  the same way as its predecessor;
- a `models:sync` dry run (`--no-api --today 2026-10-25`).

## How facts were read this time

The audit host could not reach most lab pages. The `models:sync` dry run read Anthropic's pages and nothing
else ("fetch failed" for the other ten labs; the proxy refused `platform.kimi.ai` with a 403). Direct page fetches
failed the same way.

Facts below therefore come from search-indexed copies of the official pages (the Kimi quickstart, kimi.ai's pricing
page, MiniMax's pricing overview and text-generation guide), each checked against at least two independent
reports. Because none of these pages was read directly, **no row was written to `model-rates.generated.ts`**.
That file only takes prices `models:sync` has read from a lab's page. The new prices live in the hand-coded
fallbacks (`pricing.ts`, `model-metrics.ts`), which the generated table overrides the next time a sync run reads
the pages.

## Catalogue changes

| Model | Change | Source |
| --- | --- | --- |
| `moonshot:kimi-k3.1-pro` | **Added** (released 2026-10-23), family `kimi`, current. 1,048,576 context, always thinks, top-level `reasoning_effort` low / high / max (default max), no off switch, image input (base64 or `ms://` file id), `max_completion_tokens` up to 1,048,576, tools. $2 in / $10 out per MTok, cache hit $0.20 | platform.kimi.ai/docs/guide/kimi-k3-1-pro-quickstart; kimi.ai/resources/kimi-k3-1-pro-pricing; simonwillison.net/2026/Oct/23/kimi-k31-pro; siliconangle.com (2026-10-23) |
| `moonshot:kimi-k3.1-pro-highspeed` | **Added** (2026-10-23), family `kimi-highspeed`, current. The same model served two to three times faster. $4 in / $20 out per MTok, cache hit $0.20 | Kimi quickstart ("Kimi K3.1 Pro and Kimi K3.1 Pro Highspeed are now available"); aimlapi.com, mindstudio.ai pricing write-ups |
| `moonshot:kimi-k3` | current → **legacy**, superseded by K3.1 Pro. Rate unchanged ($3 / $15, on file) | as above |
| `moonshot:kimi-k2`, `kimi-k2.5`, `moonshot-v1-128k` (retired ids) | stored-id redirects re-pointed from K3 to K3.1 Pro | `validate:models` (redirects must target a current model) |
| `minimax:MiniMax-M3.1-Flash` | **Added** (GA 2026-10-19), family `m-flash`, current. 1M context, image input, always thinks, `reasoning_effort` low / medium / high / xhigh / max (default max), tools. Pay-as-you-go $0.15 in / $0.60 out per MTok, cache read $0.015, flat (no long-context band) | platform.minimax.io/docs/pricing/overview; platform.minimax.io/docs/guides/text-generation; marktechpost.com (2026-10-19) |
| `minimax:MiniMax-M3.1-Flash-Preview` | current → **legacy** (still `comingSoon`, M Plan only), superseded by the GA id | as above |

The Code agent ranking (`code-v2/code-models.ts`) now lists Kimi K3.1 Pro in K3's place.

### Reasoning wiring

Both new Kimi ids speak K3's contract. Every Moonshot gate in the adapters matches on `k3`, so they need no
code change:

- `openai-compat.ts` and `llm/compat-loop.ts`;
- `model-metrics.ts` `reasoningCaps`: low, high, max; default max; `canDisable: false`;
- `model-reasoning-capabilities.ts`;
- the Code app's `CodeThinkingWire.swift`.

MiniMax M3.1 Flash matches the existing `m3.1` gates, so it gets the Preview's ladder: five tiers, default max,
no Instant. `tests/model-effort-wire.test.ts` now pins:

- `kimi-k3.1-pro` at max;
- `kimi-k3.1-pro-highspeed` at low;
- `MiniMax-M3.1-Flash` at xhigh.

### Not added

| Candidate | Why |
| --- | --- |
| "Qwen3.6 27B" (2026-10-21) | Only one aggregator lists it, and no Model Studio page was found |
| Mistral Large 4 open weights | Reported for about 2026-10-27, not released yet. The API model has been in since 2026-10-06 |
| Kimi K3.1 Pro open weights | Promised by 2026-11-04. Weights are not an API change |

No new API chat models were found from these labs in the window:

- Anthropic (`models:sync` read its pages and found nothing new), OpenAI, Google, xAI;
- Meta, Mistral, DeepSeek, Z.ai, Qwen, Xiaomi MiMo, LongCat.

Recent releases already in the catalogue:

- Gemini 4 Argon (10-13);
- Muse Wonder (10-12);
- DeepSeek V4.1-Flash-1017 (10-17, served by the `deepseek-flash` alias).

## Left for the next `models:sync --apply` with network access

- Write official rates for `kimi-k3.1-pro`, `kimi-k3.1-pro-highspeed` and `MiniMax-M3.1-Flash` into
  `model-rates.generated.ts`. Then confirm the cache-write prices: one report gives Moonshot 5-minute and 1-hour
  write prices; Moonshot's other rows list none.
- Expiries the dry run already sees, from `retiresOn` dates that have passed. `MODEL_LIST` already hides these,
  so only the move into `RETIRED_MODELS` is pending:
  - `google:veo-3.1-*-preview` (×3), retired 2026-10-22;
  - `openai:gpt-3.5-turbo`, `gpt-4-turbo`, `gpt-image-1`, `o1` and `o3-mini`, retired 2026-10-23.
- Max output for MiniMax M3.1 Flash: reports say 524,288 or 1,048,576. `PROVIDER_MAX_OUTPUT.minimax` stays at
  131,072, the value MiniMax recommends, so it is unaffected.

## Could not verify

- **Any lab page directly**, apart from Anthropic's (see above).
- **Kimi K3.1 Pro video input:** K3 takes video. The K3.1 quickstart shows only an image example, so the row
  says "image input".

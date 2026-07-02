# Model registry — sources & audit notes

The curated registry lives in `src/lib/models.ts` (chat in `CURATED`, image/video in
`GENERATIVE`, dead ids in `RETIRED_MODELS`). `npm run validate:models` checks the
invariants (unique ids, one *current* per family/modality, defaults, migrations).

**Last full audit: 2026-07-01** — every provider verified against its official model
docs, deprecation/lifecycle pages, pricing pages, and changelogs. Model availability
changes often; re-audit quarterly or when a provider announces a retirement wave.

Status meanings: `current` = latest active generation of its family · `legacy` =
still callable, superseded · `deprecated` = provider-announced retirement date
(shown as a "Retiring" warning in the picker) · retired ids are unregistered and
silently migrate via `RETIRED_MODELS`/`migrateModelId()`.

---

## Anthropic — checked 2026-07-01
Sources: platform.claude.com/docs models overview · model-deprecations · pricing.
- Current: `claude-fable-5` (GA Jun 9 2026; dateless pinned id, adaptive thinking always on, sampling params rejected), `claude-opus-4-8`, `claude-sonnet-5` (released Jun 30 2026, supersedes 4.6; intro pricing $2/$10 through Aug 31 2026), `claude-haiku-4-5` (only active Haiku; extended thinking via budget_tokens).
- Deprecated: `claude-opus-4-1` retires **2026-08-05** → Opus 4.8.
- Retired: entire Claude 3.x line (3 Opus/Sonnet/Haiku, 3.5 Sonnet ×2, 3.5 Haiku).
- Note: "retirement not sooner than" dates on legacy 4.x models are tentative.

## OpenAI — checked 2026-07-01
Sources: developers.openai.com/api/docs models · models/all index · deprecations · pricing.
- Current: `gpt-5.5` ($5/$30, 1.05M ctx, effort none→xhigh), `gpt-5.5-pro`, `gpt-5.4` (affordable frontier tier — OpenAI's own labeling), `gpt-5.4-mini`, `gpt-5.4-nano`. Image: `gpt-image-2`.
- **`gpt-5.5-thinking` and `gpt-5.5-mini` are NOT API ids** (ChatGPT product names); they migrate to `gpt-5.5` / `gpt-5.4-mini`.
- Deprecated wave (shutdowns): o3-deep-research & o4-mini-deep-research 2026-07-23; o3-mini, gpt-4-turbo, gpt-4o snapshots, gpt-3.5-turbo, gpt-image-1 2026-10-23; o3, gpt-5/-mini/-pro snapshots 2026-12-11.
- Retired: o1-preview (2025-07-28), o1-mini (2025-10-27), **DALL·E 2 & 3 (2026-05-12)** — dall-e-3 had been wrongly listed as the current image model.
- Uncertain: gpt-5.4-nano ctx/maxOut unverified; GPT-5.6 is preview-only with no API id; sora-2 deprecated with unclear successor (not registered).

## Google — checked 2026-07-01
Sources: ai.google.dev/gemini-api/docs models · deprecations · image-generation · video · pricing · changelog.
- Chat current: `gemini-3.5-flash` (GA May 2026 flagship), `gemini-3.1-pro-preview` (no GA id yet), `gemini-3.1-flash-lite`.
- Image current — **the Nano Banana family, not Imagen** (the app previously had this backwards): `gemini-3-pro-image` (Nano Banana Pro), `gemini-3.1-flash-image` (Nano Banana 2), `gemini-3.1-flash-lite-image` (Nano Banana 2 Lite). "nano-banana-*" were never chat ids.
- Image deprecated: `gemini-2.5-flash-image` (2026-10-02), `imagen-4.0-generate-001` (2026-08-17 — the whole Imagen line is sunsetting). Imagen 3 retired 2025-11-10; `imagen-3.0-fast-002` never existed.
- Video current: `veo-3.1-generate-preview`, `veo-3.1-fast-generate-preview`, `gemini-omni-flash-preview` (conversational video editing, public preview Jun 30 2026). **Veo 2.0/3.0 shut down 2026-06-30.**
- Deprecated chat: gemini-2.5-pro/flash retire 2026-10-16.

## Zhipu / Z.AI — checked 2026-07-01
Sources: docs.z.ai model guides + pricing · docs.bigmodel.cn model overview.
- Current: `glm-5.2` (flagship, 1M ctx), `glm-5-turbo`, `glm-5v-turbo` (vision), `glm-4.7-flash` (free tier). Image: `glm-image` (docs call it the "new flagship" — statuses were swapped with CogView-4 in the app). Video: `cogvideox-3`.
- Legacy: glm-5.1, glm-5, glm-4.7, glm-4.6, glm-4.6v, glm-4.5-flash, cogview-4.
- Retired: `glm-4-plus` (absent from all current listings; no formal notice).
- Zhipu publishes no deprecation dates; legacy status is inferred from supersession.

## Moonshot / Kimi — checked 2026-07-01
Sources: platform.kimi.ai docs (platform.moonshot.ai now redirects there): models.md · per-model pricing pages.
- Current: `kimi-k2.6` (flagship, image+video input, toggleable thinking), `kimi-k2.7-code` (thinking always on — do not send a disable param), `kimi-k2.7-code-highspeed` (~180 tok/s tier).
- Legacy: `kimi-k2.5`, `moonshot-v1-128k` (8k/32k + vision-preview variants also still callable but not registered to avoid clutter).
- Retired: **the whole kimi-k2 (K2.0) series on 2026-05-25** — the app's "kimi-k2" id was both wrong (real ids were dated previews) and dead. kimi-latest retired 2026-01-28.
- Uncertain: max output not published; base-URL (api.moonshot.ai vs api.kimi.ai) unverified.

## DeepSeek — checked 2026-07-01
Sources: api-docs.deepseek.com pricing · updates · list-models · V4 release notes.
- Current: `deepseek-v4-flash` (default; 1M ctx, 384K maxOut), `deepseek-v4-pro` (flagship). Only these two are exposed by list-models.
- Deprecated: `deepseek-chat` and `deepseek-reasoner` (aliases now routing to V4 Flash) are **fully retired 2026-07-24 15:59 UTC** — weeks away.
- Retired: `deepseek-coder` (merged into chat with V2.5 back in Sept 2024).
- Uncertain: V4 vision appears app-only, not API — vision=false.

## Mistral — checked 2026-07-01
Sources: docs.mistral.ai models overview + model cards + changelog · mistral.ai/pricing/api.
- Current: `mistral-medium-latest` → **Medium 3.5** (frontier, reasoning effort — was wrongly "legacy" in the app), `mistral-large-latest` → **Large 3** (open-weight, cheap), `mistral-small-latest` → **Small 4** (also wrongly legacy), `codestral-latest` (25.08), `ministral-14b-latest` (8b/3b also exist, unregistered).
- Deprecated: magistral-medium-2509 retires **2026-07-31** (reasoning folded into Medium 3.5), devstral-2512 (May 2026).
- Retired: mistral-large-2411 & the entire Pixtral line (2026-05-31).
- `-latest` aliases remain the official primary names.

## xAI / Grok — checked 2026-07-01
Sources: docs.x.ai models + model cards · may-15-retirement migration page · release notes.
- Current: `grok-4.3` (recommended flagship; effort none/low/medium/high), `grok-build-0.1` (agentic coding), `grok-4.20-multi-agent-0309` (beta deep research). Image: `grok-imagine-image-quality` (recommended) + `grok-imagine-image` (budget). Video: `grok-imagine-video`, `grok-imagine-video-1.5` (preview, I2V-only).
- Legacy: grok-4.20-0309-reasoning / -non-reasoning.
- Retired (2026-05-15 wave): grok-4-0709 (+ alias grok-4 — now silently redirects to 4.3), grok-4/4.1-fast ×4, grok-code-fast-1, grok-3, grok-imagine-image-pro. Feb 28 2026: grok-3-mini, grok-2-image-1212, grok-2-vision-1212.
- **`grok-3-image` never existed** — it was a fabricated id in the app.

## ByteDance Seedance (BytePlus ModelArk) — checked 2026-07-01
Sources: docs.byteplus.com ModelArk model list · video tutorial · pricing · deprecations · model cards.
- Current: `dreamina-seedance-2-0-260128` (flagship, audio, 4K), `dreamina-seedance-2-0-fast-260128`, `dreamina-seedance-2-0-mini-260615`. Note the **dreamina- prefix** on the 2.0 line (BytePlus international; mainland Volcengine uses doubao-).
- Legacy: `seedance-1-5-pro-251215` (first audio+video model), `seedance-1-0-pro-250528` (the app's old "current" — still callable, two generations back), seedance-1-0-pro-fast-251015 (unregistered).
- Retired: Seedance 1.0 Lite t2v/i2v (deactivated 2026-05-13).
- Uncertain: 2.0 per-video pricing table parsed from client-side JSON; re-verify in console.

## MiniMax — checked 2026-07-01
Sources: platform.minimax.io models-intro · pricing-paygo · image/video guides · minimax.io model pages.
- Current: `MiniMax-M3` (1M ctx, multimodal, ~May 31 2026), `MiniMax-M2.7-highspeed` (distinct low-latency tier — was wrongly legacy). Image: `image-01`. Video: `MiniMax-Hailuo-2.3` and `MiniMax-Hailuo-2.3-Fast` (was wrongly legacy — it's the current Fast tier).
- Legacy: MiniMax-M2.7, MiniMax-M2.5 (M2.1/M2/Hailuo-02/S2V-01 also callable, unregistered).
- MiniMax publishes no deprecation dates. Casing is exact: `MiniMax-M3`, `MiniMax-Hailuo-2.3`.

## MiMo (Xiaomi) — checked 2026-07-02
Sources: mimo.mi.com docs (quick-start / pricing) · litellm xiaomi_mimo provider.
- Current: `mimo-v2.5-pro` (reasoning/coding/agentic flagship, multimodal, 256k ctx), `mimo-v2-flash` (efficient/fast tier).
- OpenAI-compatible endpoint `https://api.xiaomimimo.com/v1`; also exposes an Anthropic-format endpoint at `/anthropic`. Pay-as-you-go keys are `sk-…`, Token-Plan keys are `tp-…`.
- Reasoning via OpenAI-style `reasoning_effort`. Casing is lowercase: `mimo-v2.5-pro`.

---

## Maintenance checklist

**Automated sync** — `src/lib/models.generated.ts` is a machine-written, committed
file (never edit by hand) that models.ts merges into the registry: `DISCOVERED`
entries surface as chat models with guessed metadata pending curation, and
`UNAVAILABLE` ids are hidden from every picker while stored ids keep resolving
(they migrate to the family's current model, else the default).

1. `npm run sync:models` — dry run: fetches every configured provider's live
   model list (keys from `.env`/`.env.local`) and reports genuinely new models
   plus curated **chat** models the API no longer serves. Family curation keeps
   only the latest id per family, so dated snapshots don't pile up.
2. `npm run sync:models:write` — `--write --prune`: regenerates the file
   (records adds in `DISCOVERED`, absences in `UNAVAILABLE`) and re-runs
   `validate:models`. Image/video models are never pruned automatically, and a
   failed/empty provider fetch never prunes anything. `--write` alone adds only.
3. Promote worthwhile `DISCOVERED` entries into `CURATED` in `src/lib/models.ts`
   with real metadata; move dead ids into `RETIRED_MODELS` with a replacement.
4. Run `npm run validate:models`.
5. Sync `FAMILY_RULES`/`reasoningCaps` in `src/lib/model-metrics.ts` and
   `FAMILIES` in `src/lib/model-discovery-core.ts` for new families.
6. Update this file's per-provider "checked" date and notes.

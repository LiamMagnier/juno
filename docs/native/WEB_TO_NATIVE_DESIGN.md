# Juno web → native design translation

Date: 2026-08-15. The design source of truth for the iOS and macOS rework. Since 2026-09-25 it
also holds the [register of deliberate differences](#register-of-deliberate-differences): every
intentional difference between the web and the Mac, numbered. A difference that is not on the
register is drift (MACOS_LIQUID_GLASS_REDESIGN.md §A4.9).

This supersedes the "design principles" section of [`REWORK_PLAN.md`](REWORK_PLAN.md)
wherever the two disagree. That document derived a register from competitive research; this
one derives it from **Juno's own website**, which is what the owner asked for. The plan's
structural work (component layer, IA, phases, motion tokens, gates) is unaffected.

## Which website register to follow

The site has two, and they disagree. Measured across `src/components/`:

| Surface | `font-mono` | `text-label` | `text-caption` | `uppercase` |
|---|---|---|---|---|
| chat | 152 | 31 | 104 | 16 |
| work | 121 | 42 | 62 | 6 |
| code | 56 | 16 | 65 | 6 |
| **research** (redesigned 2026-08-15) | **2** | **3** | **32** | 6 |

Deep Research is the newest surface and the one the owner signed off after rejecting its
predecessor as "horrible AI slop". **It is the register to port.** Web Chat, Code and Work
have not been converted yet, so porting *them* verbatim would import the exact problem this
rework exists to remove.

> **2026-09-25.** There are two products now, Chat and Code: Work is merged into Chat on the
> web and on the Mac (MACOS_LIQUID_GLASS_REDESIGN.md §1.7, Phase 5). Read "Chat, Code and
> Work" above as the surfaces as they stood in August.

Two owner rules govern the register, both recorded as feedback:

1. **Never full uppercase.** No `uppercase` on eyebrows, section labels, kickers or
   headings. Uppercase-plus-mono micro-labels are the single clearest "AI slop" tell.
2. **`font-mono` is for genuinely machine metadata only** — model ids, token counts,
   hashes, file paths, diff bodies, terminal output. Never headings, statuses or counts;
   those belong in the interface face.

Note the trap in rule 1: `text-label` carries `letterSpacing: 0.10em` **because it was
drawn for caps**. Setting it in sentence case looks wrong too — the tracking goes with the
caps. So `text-label` does not get a native counterpart at all. Its replacement is
`text-caption font-medium` in the sans face, sentence case.

## The typographic system

Three families, and contrast comes from **family and 3× size jumps, not timid weights** —
that is the stated intent in `tailwind.config.ts` and it should survive the port.

| Web rung | Family | Native |
|---|---|---|
| `text-hero`, `text-display` | Newsreader serif | `JunoSerif` display face. **On the Mac, the greeting only** (MACOS_LIQUID_GLASS_REDESIGN.md §0.2; the earlier "hero question and artifact/document titles" is superseded). |
| `text-title` | sans | `junoFont(size:relativeTo: .title2)` |
| `text-body` | sans | `junoFont(size:relativeTo: .body)` |
| `text-ui` | sans | `junoFont(size:relativeTo: .callout)` — the workhorse; most interface text is this |
| `text-caption` | sans | `junoFont(size:relativeTo: .caption)`, sentence case — the eyebrow/kicker rung |
| `text-micro` | sans | `junoFont(size:relativeTo: .caption2)` |
| `text-label` | sans, 0.10em, drawn for caps | **No native counterpart. Do not port.** |
| `font-mono` | mono | `JunoMono` — machine metadata only, per rule 2 |

The serif is *display-only*. It is not a body face and never sets a paragraph.

### What this changes in the apps today

- iOS chat prints `Claude Sonnet 4.6 · $0.021` entirely in mono. The model id may stay
  mono (it is a machine identifier); **the cost may not** — a count belongs in the sans
  face. Split the line rather than setting all of it one way.
- macOS Work sets `Where` / `Model` / `Spent` / `Attempt`, `What you asked for` and `Plan`
  in mono. All six are headings or labels → sans `text-caption` equivalent, sentence case.
- iOS Settings sets three of five section headers in mono. → sans.

## Colour and surface

The palette is already generated from `globals.css` and is correct. What must be ported is
its **application**, which the web does far more restrainedly than the apps:

- **One accent.** Coral appears on the primary action and on the one italic emphasis line.
  It is not spread across icons, statuses and badges. The apps currently run four hues on a
  single Work screen.
- **Hairlines are translucent.** The web's dominant border is `border-border/50` to `/70`,
  not a solid rule. Port as the hairline token at matching opacity.
- **Warm ground, opaque content.** `bg-card` / `bg-secondary` are solid fills, never
  translucent. This is the same rule as the glass rule below, arrived at independently.

## Layout and disclosure — the actual shape of the direction

This is the part that matters more than any token, and it is what the Deep Research
redesign was really about:

1. **Progressive disclosure, not density.** The live surface shows a serif question, a
   spine of five stages with **only the live one expanded**, and a source rail. Everything
   else sits behind **one** "Show detail" disclosure, **closed by default**. The rejected
   predecessor rendered nine blocks at once.
2. **A finished run is a document cover, not a stat dashboard.** The artifact's own title
   in the serif, one provenance sentence, one verdict, and **one wide door** into the full
   report. Machinery hides behind "How it worked".
3. **One set of transport controls, and the composer owns them.** The panel gets no
   Pause/Stop. Typing while a run is live adds a constraint; the composer's Stop face
   cancels the run and the stream. A second set of transport controls a few hundred pixels
   above the real ones was a named defect.
4. **Real sentences over raw machinery.** The plan gate shows the planner's written steps,
   never the raw query list. Queries live behind "Show the searches".

### Applying 1–4 to the apps

- **macOS Work** currently violates 3 outright: `Pause` and `Stop` sit in the detail pane
  *and* the composer is at the bottom of the same view. Remove the panel pair.
- **iOS Work** violates 2 and 3: two full-width coral primaries ("Allow once" and "Say
  something") with no hierarchy, and a completed task that shows a plan instead of an
  answer. A finished task is a document cover with the answer as the hero.
- **macOS Code** violates 1: the inspector exposes every pane at once rather than one
  live thing plus a disclosure.
- **Both**: the six undocumented status glyphs are raw machinery where a sentence belongs.

## Liquid Glass — how the web's elevation becomes native material

The website has no glass; it expresses elevation with **radius + soft shadow + a warm
ground**. That is exactly what Liquid Glass expresses natively, which makes the translation
rule mechanical rather than a matter of taste:

> **Where the web floats a surface *above* the page — composer, sidebar, toolbar, popover,
> menu, sheet — that surface becomes the Liquid Glass layer natively.**
> **Where the web uses `bg-card` / `bg-secondary` for content the reader reads or acts on —
> rows, transcript, cards, diffs, empty states — that stays opaque natively.**

Both halves are enforceable by grep, and the second half is the one that fails most often.

Concretely, the web's `.composer-surface` (floating, large radius, soft shadow, sitting over
the scrolling transcript) is the single clearest glass candidate in the product. It is
already the right *shape*; it needs the material rather than a drawn shadow.

The rest of the glass rules from `REWORK_PLAN.md` stand unchanged and are compatible with
this: one `GlassEffectContainer` per cluster, `glassEffectID` on every participant, morph
rather than fade, exactly one tinted action per bar on the trailing edge, register bars for
the scroll edge effect, delete custom bar backgrounds, `ToolbarSpacer(.fixed)` grouping.

**Concentric shapes.** The web's radius ladder is flat (`rounded-field` 10,
`rounded-card` 14, `rounded-composer` 26) because CSS has no concentricity primitive.
Native does: use `ConcentricRectangle` / `.rect(corner: .containerConcentric)` for nested
containers rather than porting the numbers. This is the fix for the composer/target-picker
seam on macOS Code and the mixed radii on the iOS sign-in screen — both are cases where two
nested shapes were given independent literal radii.

## What the apps must NOT port from the web

- `text-label` and every uppercase micro-label.
- The `font-mono` density of web Chat / Code / Work (121–152 uses). Those surfaces are
  pre-redesign.
- Hand-rolled controls. The web hand-rolls selects and segmented controls because the
  platform gives it nothing; native gives it `Picker`, `Menu`, `Form`, `List`. **Adopting
  the native structure is what makes Liquid Glass appear** — hand-rolling opts out of it.
  This is the single biggest reason the apps read as non-native today.
- The web's own god-files. `work-transport.tsx` is 1,667 lines and `app-sidebar.tsx` is
  2,045; the native side already has worse. Port the *design*, not the decomposition.

## Always in sync, and never a loading state

Owner requirement, 2026-08-15: *"the website and apps should be sync everytime without any
loading."*

This is an architectural bar, not a polish item, and it decides how every surface is
written. It resolves into four rules.

### 1. Reads are cache-first. A surface never awaits the network to render.

Every screen renders from the local SQLite store immediately and unconditionally. The
network is what *updates* what is already on screen; it is never what produces the first
frame. A list that spins on cold launch is unusable in the twenty-second windows a phone
actually gets used in.

The machinery for this already exists — `SQLiteAccountRepository`, `NativeSyncModel`, the
cursor/revision/tombstone contract at `/api/v1/changes`. What was missing was coverage:
the audit found 23 of 87 Prisma models had entity loaders and change-capture, and **all 16
`Work*` models had neither**, so a Work task could never arrive through sync at all. That
is now closed to 30 entities including seven `work_*` and four `code_*`.

**Falsifiable:** put the device in airplane mode, cold-launch, and open every destination.
Anything that shows a spinner instead of its last-known content is a defect.

### 2. Writes are optimistic and go through the outbox.

A mutation applies to the local store and renders instantly; the outbox reconciles it.
Offline writes currently cover 6 entity families out of 87 — so today, most actions in the
product are a direct network call with no outbox behind them. Every action a user can take
on a surface being reworked must be added to `sync-mutations.ts` as part of that rework,
not deferred.

**Falsifiable:** every button that changes state must work in airplane mode and reconcile
on reconnect.

### 3. Changes arrive; they are not fetched.

Polling is what makes a product feel stale, and Juno currently depends on a foregrounded
30-second poll — which also means a backgrounded phone learns nothing at all. Two pieces:

- **Foreground:** the SSE wakeup on `/api/v1/changes` drives the cursor, so an edit on the
  web appears on the Mac and the phone without either asking.
- **Background:** there is **no push pipeline anywhere in the native tree** — no
  entitlements, no device-token registration, no server service, no link between a
  `WorkApproval` row and a device. Work's whole proposition is unattended execution that
  stops to ask you something, so without push the proposition does not hold on a phone.
  This is a backend project with its own schedule and it is the single largest remaining
  gap between "synced" as claimed and "synced" as experienced.

### 4. Where a wait is genuine, it is a skeleton with real final geometry — never a spinner.

Three waits are real and cannot be designed away: the first-ever sign-in on a new device,
a large artifact download, and a live agent run producing output that does not exist yet.
Everything else is a cache miss that rules 1–3 should have prevented.

For those three, the answer is a skeleton whose geometry matches the content that will
land, so nothing reflows — plus a *specific* label. "Reading 14 files" is honest; "Loading"
is not. The product has 112 bare `ProgressView()` sites and one skeleton today.

**Falsifiable:** any `ProgressView()` on a surface whose row geometry is known is a defect.

### What this costs, stated plainly

Rules 1 and 2 are largely mechanical now that the entity coverage exists. Rule 3's
foreground half is wiring. Rule 3's background half — push — is genuinely a separate
project needing certificates, entitlements, a server-side service and a device registry.
Until it lands, "always in sync" is true for two foregrounded surfaces and false for a
phone in a pocket, and the plan should not claim otherwise.

## Ambient decoration

The web defines `.composer-aura`, `.voice-aura`, `.aicss-shine` and registers two animated
custom properties for the aura's tint and swell. The native side mirrors these in ~1,084
lines across `JunoComposerAura`, `JunoVoiceAura`, `JunoProviderGlow` and `JunoAIcssShine`.

Note that `design-qa.md` claims the design deliberately has "no composer glow", and
`globals.css` contradicts it with 68 `aura` references. **The web is not a settled
reference on this point**, so it cannot decide the native question. This remains the open
owner decision recorded in `REWORK_PLAN.md`: kill, demote to one static accent, or keep.

Whatever is decided, encoding *which AI lab you are talking to* as hue and *reasoning
effort* as brightness fails the still-frame test — it is information that cannot be read,
only sensed — and that part should go regardless.

## Overlays, menus and keys on the Mac (Phase 3, integrated 2026-09-25)

How the web's palette, dialogs and menus land on the Mac, as the three Phase 3 stages built them (details in the spec's "Phase 3 errata"):

- **One panel for ⌘K and Search.** The web has two palettes; the Mac has one glass panel with Commands and Search modes (⌘K and ⇧⌘F open the same panel). Matched words are semibold in the row's ink, never coral. Chats, messages, projects, files and artifacts are searched on this Mac; memory, knowledge and tasks on the server, and the account's tasks this Mac has read fill the Tasks group beside the server's hits.
- **Keys live in one table.** `JunoShortcutRegistry` generates the menu bar, the Keyboard Shortcuts window and the panel's keycaps, so none of them can disagree. In-window menus show no chords; the menu bar does. The View menu also lists the Chat window's pages, without chords.
- **Dialogs are the system's.** A share is the Share popover (or its content in a sheet where there is no toolbar anchor, as on the Artifacts page); confirmations use the shared `junoConfirmation` helper with the web's words and Title Case buttons; renames happen in place.
- **Menus** use the `.menuStyle(.button)` recipe with Title Case items and Phosphor glyphs; the `menus` gate holds the count of the deprecated style.
- **Settings** follows the web's order and words, with the Mac's grouped form, and links to pages open them in the main window.

## Two layers, and no third (Mac, MACOS_LIQUID_GLASS_REDESIGN.md §0.1)

The rule the Liquid Glass section above set out, as the Mac redesign fixed it:

- **Chrome is Liquid Glass, and the system draws it:** the sidebar pane, toolbar item groups, menus and context menus, popovers, sheets and alerts.
- **Juno adds glass in exactly five places**, each allow-listed in the glass gate (`npm run native:design:glass`): the composer cluster (one `GlassEffectContainer` holding the composer shell, the follow-up chips and Scroll to latest), the ⌘K / Search panel, the find bar, the toast host (also Library's multi-select capsule) and the Quick Entry panel.
- **Content is opaque, on the warm canvas:** the greeting, starter chips, transcript, bubbles, cards, code, tables, message actions, rows, pages, docks and empty states. There is no glass inside a sheet and no glass on top of glass.

## Register of deliberate differences

Every intentional difference between the web and the Mac, numbered. A difference that is not here is drift: fix it, or add it here in the same change, with the reason. It began as the spec's §0.8 and gathers every later register entry the phases wrote; the numbers are final (the integration renumbered the lanes' provisional numbers, and each renumbered entry says what it was, so a code comment citing a lane's number can be traced). A retired entry keeps its number and says why it no longer holds. The entries keep the words of the lane that wrote them; the section's source has the context.

`npm run native:register:check` holds the list to its numbering (one entry per number, from 1 with no gaps) and fails when the parity ledger (`contracts/parity/features.json`) or the chat wire's notes (`contracts/chat/juno-chat-wire-v1.status.json`) cite an entry that does not exist or is retired. The parity matrix those feed is [`PARITY_MATRIX.md`](PARITY_MATRIX.md).

### Ground rules (#1–#13)

Source: `MACOS_LIQUID_GLASS_REDESIGN.md` §0.8, the seed of this register.

1. Floating layers use system glass. The web makes them opaque on purpose. This applies to the five custom glass sites and to system chrome.
2. The sidebar hides completely with ⌃⌘S. There is no 64pt rail.
3. The chrome shows no wordmark. The traffic lights and the system toggle occupy that strip.
4. Products are ⌘1/⌘2. The web uses ⌘⇧1/2 because browsers reserve ⌘1–8.
5. Menus are Title Case.
6. The window title, subtitle and title menu are the system's, replacing the web's header h1 and floating project pill. The title does not cross-fade in the titlebar.
7. Search and ⌘K are one panel. The web has two palettes.
8. Icons don't articulate on hover. Only state swaps animate.
9. The composer is one glass shell. The web's is an opaque card with a hairline and shadow.
10. Controls are 28pt. The web's are 32px.
11. Springs are multiplied by 0.75.
12. Settings is its own window. The web uses a modal.
13. Mac-only features are listed in A5.

### Phase 2: the transcript (#14–#45)

Source: `MACOS_LIQUID_GLASS_REDESIGN.md`, “Phase 2 errata”.

14. Designs are drawn inline on the Mac; the web shows the document's JSON.
15. Images add Download and Expand to the web's Edit, and a click opens Quick Look rather than a new tab.
16. The More menu's info item is greyed by the system; the web keeps it at full ink.
17. Switch Model marks the current model with the system checkmark, not the web's coral check.
18. Tooltips use `.help()`, so they appear on the system's delay rather than the web's.
19. File tiles and pictures open in Quick Look, and Office and iWork tiles show a QuickLook page picture; the web opens its own document viewer beside the chat and shows an Office file's opening lines.
20. A generated clip is downloaded whole (51 MB ceiling) before it plays; the web streams it.
21. The artifact runtime has no network; the web's sandbox lets a preview pull https scripts, styles, fonts and images (and, in production, runs no script at all — audit X-01). The Mac runs a page's own scripts; web fonts and remote pictures do not load, and Python shows Code (Pyodide is not bundled). Tailwind Play, React, ReactDOM and Babel (so React, JSX, TSX and TypeScript) come from the app bundle, as Mermaid does, not from the web's CDNs (#183). Only status and console come back from the page; the web also has a link bridge and an element inspector. *(Amended 2026-09-25 by #183. It said: Tailwind classes do not load, and React, TypeScript and Python show Code until their engines are bundled.)*
22. The inline artifact card's meta line, the Console header and the view switch are SF 11; the web sets them in JetBrains Mono.
23. While a reply is still writing an artifact, its card shows the tag's source as it arrives; the web shows the stored row's previous body under "Writing".
24. The canvas saves an edit as a new version when the reader presses Save (⌘S), on top of the version the edit began from; the web's design editor commits as it goes. A code artifact without a stored row is read-only in the canvas.
25. The canvas dock is 400–60% wide, opening at 480; the web's canvas opens at 46% of the window.
26. A `juno-visual` flow wraps its nodes with arrows only as wide as an arrow; the web gives each arrow a full grid column.
27. A Mermaid figure settles to its diagram's height (160–520) after a 288 skeleton; the web's stays 288 and scrolls.
28. Regenerating a reply that carries artifacts asks first ("Regenerate this answer?"); the web regenerates, and deletes them, at once.
29. A design that has no stored row yet cannot be opened in the canvas; the web opens the canvas only once the row exists, so it never offers one.
30. The Mac's thinking and tool UI follows the Tool calls & research rework's decisions (inline run block, phase-typed signature, Activity panel) before the web ships them; the live web still shows `ThinkingDots` and the Thought panel.
31. Without the rework's typed timeline the Mac builds the run from today's activity rows (the SPEC's legacy adapter); connector calls with no detail and search rows other than deep research's are not drawn as steps.
32. A citation is a numbered chip without the source's logo: a `Text` run cannot hold an image that loads later. The logo is in the popover, which opens on click where the web shows a hover card.
33. The sources pill's label is SF, not the web's mono (the count stays mono).
34. Tables sit in a card with a filled header row (brief §6.2); the web's table is rules only, with no card or fill.
35. The approval card hairline takes the risk tone (source for a reversible change, warning otherwise); the web washes every answerable card in the warning tone.
36. Find counts and highlights what the reading style draws, message by message; the web scrolls the message into view and highlights through the DOM.
37. *Retired by the Foundations errata:* the toast host landed, and a failed action on a reply is an error toast. It said: Until the toast host lands, a failed action on a reply (a rating that did not save, Read Aloud) shows as the error box at the foot of the transcript for six seconds.
38. The Activity panel has no find field, filters, Copy menu, j/k or cost; the rework removes them from the web too, but the live web still has them.
39. "Not sent" under an unsent question is SF 11 medium; the web sets it in its mono voice.
40. The run line's facts, the research row's count and the Activity panel's counts are SF with tabular numerals; the SPEC sets them in the mono caption. The Mac keeps mono for code, ids, the clock and durations (§10.2 rule 6).
41. The research plan card starts or cancels the plan as it stands; editing questions and "Update plan" are the web's alone for now.
42. Research answered inside the chat by a profile-1 server (today's production) shows the research row and panel on the Mac, read from its activity rows; the web shows its run line.
43. *Retired:* the Mac's sidebar now has the Agents section (Phase 5 C) and no Design row (#73). It said: (Merge of main, 2026-09-24.) Agents is a sidebar navigation row after Design, as on the web, and wears `juno.agents`, the web's face mark. The web also folds the roster into the sidebar as its own section; the Mac does not yet (track B).
44. Main's Agents views draw their primary buttons as opaque `.borderedProminent` in `junoAccent`, not in `.glassProminent`: glass is chrome only (§0.1), and two of the three are inside sheets. The web's buttons are opaque too.
45. *Retired, superseded by #73:* the Mac dropped the Design row too. It said: The Mac keeps the Design row and `/design` routing although the web dropped them in `e5501f65` (Design is now a type in Artifacts). This is the open follow-up "Artifacts and Design merge on the web" in `MACOS_REDESIGN_HANDOFF.md`.

### Shared foundations (#46–#52)

Source: `MACOS_LIQUID_GLASS_REDESIGN.md`, “Foundations errata”.

46. `JunoSegmented`'s counts are at the segment's own ink; §9's 70% dimming is gone because the web removed it (2.9:1 in light). Segments are equal widths, as on the web.
47. The empty state follows today's web rather than §9 and errata 9: a page-size state is drawn open (no well), its title is the 18pt heading rung (not 17), and the dashed well is the panel size only, at the card radius 16 (not the field radius 12).
48. Prominent buttons carry the Juno accent in their style (`.junoProminent`) rather than inheriting a tint; the window's accent colour stays the system's, as before.
49. One toast at a time; the web stacks up to three. A draft's toast sits 24pt above the window's bottom, where the web lifts it 8rem on `/chat`. Toasts are glass cards (a floating layer, register #1); the web's are opaque.
50. The page search field is 32pt at the field radius 12 (§9 said 28 at 10): every control in the controls row is 32, the Mac's rung over the web's 36. Its focus edge is the neutral ring, never the accent the web's input takes.
51. The Library header carries Refresh and Add Document… (Mac extras: no Upload or Recently deleted yet, and no rename or delete in the Mac library client), and its selection bar offers Copy Names. Connections' header carries Refresh and the connected count, which the web does not draw.
52. *Retired at integration:* the Search page is gone; the ⌘K panel replaces it (#7). It said: The Search page's lede, "Chats, messages, files and artifacts synced to this Mac.", is new copy: the web has no search page (it becomes the ⌘K panel in Phase 3).

### Phase 5: Work in Chat (#53–#71)

Source: `MACOS_LIQUID_GLASS_REDESIGN.md`, “Phase 5 errata” (Stages A, B and D, then C).

53. Earlier tasks in a chat stay in the transcript as one-line rows that open the Task panel from a one-shot read; the web draws only the newest task.
54. A finished task never keeps the composer in answer mode; the web keeps "Answer the task’s question" while a question is open on a finished run, and the server refuses the answer.
55. A task's live step is a neutral tile led by the chat's run signature, and finished plan steps are marked in neutral ink; the web tints the step coral with a spinner and fills done steps in coral.
56. The pending-steers header, "Waiting on you · asked …", "Your decision" and "never finished" are SF 11; the web sets them in its mono voice (extends #39 and #40).
57. The task card's overflow menu has Pause, Resume, Try Again and Show Details; the web has no pause, resume or retry in chat (A5).
58. A task's deliverables are Quick Look tiles for every file it made, with Save As…; the web previews the newest inline with Download and points the rest to an "Outputs" list that chat does not have. The outcome digest's actions line ends "They are listed in Details.".
59. The Task panel (Activity · Files · Details) in the trailing dock is Mac-only; the web retired its task page.
60. In a queue of task approvals only the first answerable card's verb is the prominent button; the web draws every card's verb as primary.
61. Tasks that need you also raise the Dock badge, the menu-bar extra's count and, when Juno is not in front, a local notification; the web has a toast and, where the browser already allows it, a browser notification.
62. The Notifications popover has no "Get notified on this browser" row; the Mac's switches are in Settings.
63. Tasks with no conversation (from the old Work window) open in a sheet from Search › Tasks or a notification, still answerable; the web sends them to an empty chat. (Search › Tasks is now the ⌘K panel's Tasks group, #165.)
64. A chat looks for its task only while its window is visible; the web polls every open chat every four seconds.
65. The research report opens in its own window with Copy, Export Markdown… and Print…; the web opens a dialog.
66. A skill's instructions are edited in SF, not mono.
67. A task approval carries a hairline in its risk tone and no warning wash (extends #35).
68. The task card's run words leave out a question that is still open, which its question card shows; the web prints it in both (Stage A, 2026-09-25).
69. The Dock badge, the menu-bar extra's count and the rise sentence count the chats the column can show: every chat whose newest task needs the reader, less those the store knows are archived or Code's (a chat not yet synced still counts). The web's toast counts every conversation id its list returns.
70. The menu-bar extra's number adds the Code sessions waiting on an approval to the chats in Needs You, since the menu lists both; the Dock badge is the fold's count alone.
71. An empty or failed Notifications popover closes up to 272pt under its header; the list and its loading rows take 480pt. The web sizes the popover to its content under a 36rem ceiling.

### Phase 4: the pages (#72–#119)

Source: `MACOS_LIQUID_GLASS_REDESIGN.md`, “Phase 4 errata” Stages A, B and C; the lanes' provisional numbers are given where they changed.

72. **Artifacts opening.** A row opens the artifact's own page, pushed on the Artifacts stack, as the web's `/a/{id}` does; "Open in Conversation" is the canvas dock on that row. The page does not edit except a design at its latest version: the web's window is read-only and the chat is where an artifact is changed. *(was Phase 4 A #69)*
73. **Design is a type.** No Design row; `.design` resolves to Artifacts › Designs, as the web's `/design` redirect does. *(was Phase 4 A #70)*
74. **Poster fallback.** Designs draw the server's poster and fall back to the SVG export when there is none; the web falls back to the type glyph. *(was Phase 4 A #71)*
75. **Pins** on project tiles, the project page, project chats and pinned assistants are a neutral fill glyph; the web draws them coral. *(was Phase 4 A #72 and B #56)*
76. **Eyebrows and back.** Page eyebrows ("Project", "Assistants", "Skills", "Automations", "Permissions") are SF 13 medium captions in the secondary ink above the title, not the web's mono labels; detail pages use the system back button, not the web's back row. *(was Phase 4 A #73, B #57 and C (brief #57))*
77. **Meta lines and counts** (project ledes and tile footers, artifact rows and tiles, library rows, "3 skills · 2 on", "{n} assistants", "v4") are SF with tabular digits; the web sets them in the mono caption (extends #40). The version pager's count stays mono. *(was Phase 4 A #74 and B #58)*
78. **Library.** List is the default and the grid is square tiles, as on the web. Mac extras: Add Document…, Refresh, Copy Names, Quick Look, Edit Image… and file drag-out. *(was Phase 4 A #75)*
79. **Design sizes** in the New menu show the size as the item's subtitle; the web right-aligns it in mono. *(was Phase 4 A #76)*
80. **Preset hover.** The preset buttons' plus stays neutral on hover; the web turns it coral. *(was Phase 4 A #77)*
81. **Project ask field.** A project's Overview has an opaque, composer-shaped field; Return opens a new chat in the project with the words in its composer (the draft is prefilled and not sent, because the draft composer takes no send request before it appears). The web embeds a second full composer that sends. Glass stays on the one real composer. *(was Phase 4 A #78)*
82. **Project tab counts** use `JunoSegmented`'s counts; the web adds a badge to the tab label. Code is not a tab yet (a Code session cannot be opened from a page). *(was Phase 4 A #79)*
83. **Headings.** A project's Settings cards head on the `heading` rung, not the web's mono labels. *(was Phase 4 A #80)*
84. **Sheet buttons** are Title Case ("Create Project", "Rename Project", "Save Changes"). *(was Phase 4 A #81)*
85. **"Download Source…"** keeps the web's words and adds an ellipsis because it opens a save panel. *(was Phase 4 A #82)*
86. **One prominent per surface.** The Library header withholds Upload while the empty state shows "Upload files" (the web shows both); the Artifacts New ▾ is withheld on a first-run empty page, as on the web. *(was Phase 4 A #83)*
87. **Sizes** use the web's `formatBytes` (1024-based, one decimal, "0 B") rather than the system's byte formatter. *(was Phase 4 A #84)*
88. **Library uploads** go through the native upload route (`/api/v1/attachments`, the existing client) rather than the web's `/api/upload`, and an uploading row shows an indeterminate bar: the native transport reports no byte progress. *(was Phase 4 A #85)*
89. **New project.** A blank name is created through `POST /api/projects` (the server names it from the first chat), because the sync mutation needs a name; a named project goes through the sync outbox. *(was Phase 4 A #86)*
90. **`?new=design`** cannot open a native menu from code; a request for it lands on the Designs filter, which pins the same four sizes above the list. *(was Phase 4 A #87)*
91. Connections has no "Use in chats" switch: the web's is stored in the browser and read by nothing. *(was Phase 4 B #59)*
92. Assistants has no "Start chat", and a tile opens its editor: the web's `/chat?assistantId=` is read by nothing. The tile's footer shows the preferred model where the web's reads "Start chat". *(was Phase 4 B #60)*
93. Memory's Activity is a sheet; the web uses a side sheet. *(was Phase 4 B #65)*
94. New automation, New skill and New agent are pushed pages, as on the web; the assistant editor stays a sheet, as on the web. *(was Phase 4 B #66 and C (brief #66))*
95. Code automations are listed and run on the Mac but edited on the web: an existing Code automation opens with its fields read-only and “Edit this automation on the web”; the editor offers “Code” only when the Mac can edit it. *(was Phase 4 C (brief #67))*
96. This Mac's host page opens with an “On this Mac” group above the server switches; the web's host page has none. *(was Phase 4 C (brief #68))*
97. A drafted memory change is drawn on neutral fills with a leading + or −, the removed line struck through in the secondary ink; the web tints the lines success and destructive. *(was Phase 4 B #74)*
98. Import from GitHub wears Phosphor's GitHub mark (`ph.githublogo`); the web draws the brand's filled mark (`GitHubMark`). *(was Phase 4 B #75)*
99. A skill source's owner tile draws the GitHub mark; the web loads the owner's GitHub picture and falls back to the same mark. No request leaves the app for a decoration. *(was Phase 4 B #76)*
100. Memory rows sit on hairlines, not inside a card (the brief said a card): the summary is the page's one raised surface, as the web's page says of itself. *(was Phase 4 B #77)*
101. The memory summary panel is at the panel radius 20, as the web's `rounded-panel`, so the dock inset 8 is concentric with its field radius 12 (the brief said 16). *(was Phase 4 B #78)*
102. "Learn from Past Chats" carries its unread count as the menu item's subtitle; the web right-aligns the number. *(was Phase 4 B #79)*
103. A New skill failure is a toast (§2.8); the web draws an inline note under the form. *(was Phase 4 B #80)*
104. New skill has no Files field, as on the web (the brief listed one). A written skill's Edit keeps the files its version names but cannot add new ones yet (§7). *(was Phase 4 B #81)*
105. Skill rows set the name at 13 medium and the description at 11 in the secondary ink (the brief's ladder); the web sets them at 15 and 13. *(was Phase 4 B #82)*
106. Checkboxes (Import memory, Import from GitHub, the update sheet) take the accent on their checked fill, as a switch's on-track does (§0.4 "Toggle on-tracks"); radio choices (a skill's Usage, Move to a project) are drawn in the foreground ink, never the accent. *(was Phase 4 B #83)*
107. `/` focuses the Skills search while the page holds focus (`onKeyPress`); the web listens on the whole window. *(was Phase 4 B #84)*
108. Skills' Add ▾ is drawn as the system's prominent button in the accent (`DesktopProminentMenuLabel`), because a `Menu` cannot take `.junoProminent`. *(was Phase 4 B #85)*
109. **Permissions order.** The page follows the web: the floor, the modes, then Your Macs (the brief listed Your Macs first). The Mac puts this Mac first in the list, which the web does not. *(was Phase 4 C #74)*
110. **The host page's lede** is the web's meta line (platform · Juno version · last seen); the workload sentence sits beside the state word under the header, as on the web (the brief made it the lede). The approval section's heading is the web's "When Juno stops to ask" (the brief used the control's accessibility label). *(was Phase 4 C #75)*
111. **Apps and sites are read-only** on the host page, as on the web: `hostPatchSchema` refuses them, so `updateHost` sends only the switches, the ceiling and restore. *(was Phase 4 C #76)*
112. **The spend hint** says "your usage limit" where the web names the window ("5-hour" or "weekly") and has a separate sentence for an unmetered account: the Mac reads no spend window yet. *(was Phase 4 C #77)*
113. **The arming card is the signature.** "What you are switching on" sits in the editor above Save, in plain sentences; the web's "Firing this from elsewhere" card appears only with the API trigger, as on the web. *(was Phase 4 C #78)*
114. **Unknown trigger kinds** show the web's sentence ("This trigger was set up by a newer version of Juno…") and are saved back untouched; every kind the web edits is editable on the Mac, so nothing says "edited on the web" except a Code automation. *(was Phase 4 C #79)*
115. **History rows** open their conversation only when this Mac knows the session's conversation; the web resolves `/work/{sessionId}` on the server. *(was Phase 4 C #80)*
116. **Dots only for live state.** A host carries the dot only while awake; a run's status pill only while running. Every other state is its word in its ink (the web dots every pill). *(was Phase 4 C #81)*
117. **Hire** drops the web's step numbers, sets field labels in SF, and has no "Preview a state" control on the Mac (the iPhone keeps it). *(was Phase 4 C #82)*
118. **Retire…** in the agent page's More asks at once, with the web's profile-tab dialog ("Retire {name}?", "Keep It" / "Retire"); the web's menu item switches to the Profile tab. *(was Phase 4 C #83)*
119. **Automation rows** put Run Now, Pause/Resume and Its Task behind More (and the context menu) instead of the web's hover buttons, and add Delete…, which the web's list does not have. *(was Phase 4 C #84)*

### Phase 3: overlays, menus, Settings (#120–#163)

Source: `MACOS_PHASE3_OVERLAYS_BRIEF.md` Appendix C (P3-1 to P3-24) and the spec's “Phase 3 errata” (the stages' P3-25 onwards).

120. Settings has a search field in its sidebar; the web's rail has none. *(was Phase 3 P3-1)*
121. Settings groups are the system's grouped form; the web's are flat rows on hairlines. *(was Phase 3 P3-2)*
122. A Mac-only Code section stays last in Settings until Code's redesign. *(was Phase 3 P3-3)*
123. Models' "On this device" note says "on this Mac"; the web's says "in this browser". *(was Phase 3 P3-4)*
124. Interface language is not offered on the Mac until the Mac ships a string catalogue. *(was Phase 3 P3-5)*
125. Text size scales Juno's own type and controls. The sidebar, menus and toolbar keep macOS's sizes; the web scales everything. *(was Phase 3 P3-6)*
126. A custom accent leaves the focus ring graphite; the web sets the ring to the custom colour. *(was Phase 3 P3-7)*
127. Upgrade is a sheet, monthly only until the server says which plans and intervals are for sale; the web is a page with Yearly when offered. *(was Phase 3 P3-8)*
128. Onboarding has no dot-field backdrop, and its theme choice is saved to the account; the web keeps it in the browser. *(was Phase 3 P3-9)*
129. Search marks matched words in semibold in the row's ink; the web washes them in coral. *(was Phase 3 P3-10)*
130. Search's date and project filters are menus; the web's dates are chips. *(was Phase 3 P3-11)*
131. Chats, messages, projects, files and artifacts are searched on this Mac (offline, full text); memory, knowledge and tasks on the server. The web asks the server for all. *(was Phase 3 P3-12)*
132. ⌘K leaves out "Open pull requests" and "Compare models", and "Roadmap & feature requests" opens the web. *(was Phase 3 P3-13)*
133. ⌘K offers "New private chat" (⇧⌘N); the web's palette has no such row. *(was Phase 3 P3-14)*
134. The account popover has no "Get the apps" row. *(was Phase 3 P3-15)*
135. Share is a popover with a system "More…" item; the web's is a dialog without it. *(was Phase 3 P3-16)*
136. Outputs open uploads and images in Quick Look (extends #19). *(was Phase 3 P3-17)*
137. A failure inside Archived Chats shows under its row, not as a toast. *(was Phase 3 P3-18)*
138. Chords are shown in the menu bar and the Shortcuts window only, not inside in-window menus: the `+` menu lost ⌘U and ⇧⌘U, and the stop face lost ⌘. *(was Phase 3 P3-19)*
139. Keyboard Shortcuts is a window with a Code group and the Mac's own keys (⌘1 and ⌘2, ⌃⌘S, ⌥Space, ⇧⌘N, ⇧⌘F, ⌘., ⌘R, ⌘G and ⇧⌘G, ⇧⌘U); the web's is a dialog. *(was Phase 3 P3-20)*
140. The Chat menu adds ⌘R Regenerate and ⌘. Stop Generating; the web stops with Esc and has no regenerate chord. *(was Phase 3 P3-21)*
141. The Shortcuts window's group headings are SF 13 medium, not the web's mono label. *(was Phase 3 P3-22)*
142. Devices on the Mac starts with this Mac's own switch, and its empty state offers that switch rather than "Get the Mac app". *(was Phase 3 P3-23)*
143. Sign Out asks first on the Mac, because it removes this Mac's local copy. *(was Phase 3 P3-24)*
144. The Session menu replaces the Chat menu while Code is showing; the web has no menu bar. *(was Phase 3 A P3-25)*
145. The Shortcuts window's escape keycap reads "esc" and every key is its own cap; the web writes "Esc" in a single cap. *(was Phase 3 A P3-26)*
146. Code's shortcut rows are one key per row, in shorter words (decision 10). *(was Phase 3 A P3-27)*
147. When only the server half of Search fails while this Mac is online, the panel lists what this Mac found and says "{Type}: couldn’t be searched right now." for each server type in scope; the web, with one half, shows its error tile. The error tile is kept for a search where both halves failed. *(was Phase 3 B P3-25)*
148. The panel's keycaps are the Mac's chords: New chat ⌘N, Toggle sidebar ⌃⌘S, Settings ⌘,, Switch to Dark/Light Mode ⇧⌘L, Keyboard shortcuts ⌘/ (the web prints ⌘⇧O and ⌘⇧S, and no Settings hint). Seam 2 replaces the literals with registry lookups. *(was Phase 3 B P3-26)*
149. Recent's Code rows switch the window to Code (the web's Code sessions are not this Mac's local ones); offline, Recent lists this Mac's own workbench sessions, which open directly. *(was Phase 3 B P3-27)*
150. The filter chips at rest have no fill (the brief's recipe inside glass); the web's rest chip sits on `--secondary`. *(was Phase 3 B P3-28)*
151. The panel's field shows an "esc" keycap at rest; the web has none. *(was Phase 3 B P3-29)*
152. *Retired at integration.* It said the account popover's usage block reads “This week · {n}% used” until the plan route carries `quota`; seam 9 reads the quota, so the popover says “Messages {used} / {limit}” as the web does. *(was Phase 3 B P3-30)*
153. Share's More… sits at the foot of the popover in the ready state, so the fixed 232pt frame reads as a footer rather than a gap under the caption. *(was Phase 3 B P3-31)*
154. Models › On this device shows Fast mode only. The composer keeps no stored default for thinking effort or web search (both are `@State` in `ChatComposer.swift`), so those two rows would change nothing; they return when the composer reads `juno.desktop.composer.*` defaults. *(was Phase 3 C P3-25)*
155. A pinned model's Unpin star is drawn in the foreground ink, not the web's coral (accent budget). *(was Phase 3 C P3-26)*
156. Import shows "Uploading" with an indeterminate bar: the authenticated sender returns only when the server answers, so there is no byte count to show. *(was Phase 3 C P3-27)*
157. A custom accent's accent text is the clamped colour itself; the web keeps the preset's `--primary-ink`. *(was Phase 3 C P3-28)*
158. Devices' empty state on the Mac: "No Macs yet" / "Turn on Juno Work for this Mac and it appears here on its own." (the switch is the group above), not "Get the Mac app". *(was Phase 3 C P3-29)*
159. Devices › This Mac is the Work switch and a "What this Mac may do" row whose "Choose…" opens the full Juno Work card (`DesktopWorkHostTile`, unchanged) in a sheet. The brief moved the card itself into the pane; drawn there it filled the window, pushed "Your Macs" off screen and put a card inside the form's group. The web's Devices is a list whose rows open a Mac to choose what it may do, which this follows. *(was Phase 3 C P3-31)*
160. Each Upgrade card puts its action under the price, above the features; the web puts it at the card's foot. At the sheet's 640pt the foot is below the fold, and the one coral button is the choice the sheet exists for. *(was Phase 3 C P3-32)*
161. Account › Notifications is one group, as on the web: "Notifications on this Mac" (the permission, with the push reach as its description), "When something needs you", "Updates", then the two email rows. The brief's separate "Notifications on this Mac" section would have repeated its own title as its first row. *(was Phase 3 C P3-33)*
162. An import's result stays in its row, in the web's sentence, as the web shows it; only "Nothing new to import…" is a toast (the web's own toast). The brief asked for the result as a toast. *(was Phase 3 C P3-34)*
163. Plan & usage shows its actions whatever the server's `features.billing` says (native clients cannot read it); a server without Stripe answers checkout and the portal with its own "Billing is not configured." sentence, shown inline or as a toast. *(was Phase 3 C P3-30)*

### Integration (#164–#167)

Source: `MACOS_LIQUID_GLASS_REDESIGN.md`, “Integration register”.

164. The View menu lists the Chat window's pages, without chords; the web has no menu bar.
165. ⌘K's Tasks group adds the account's tasks this Mac has read to the server's hits; the web lists only the server's.
166. Skills are offered from the `+` menu's Use a Skill (§5.4) and a typed `/slug`; the web lists them in its `/` palette, which the Mac composer does not have yet.
167. An artifact's Share… is a sheet on the Artifacts page (the Share popover's content); the web's is a dialog, the Mac's chat share a toolbar popover.

### Phase 6: sync tooling (#168–#171)

Source: `MACOS_LIQUID_GLASS_REDESIGN.md`, “Phase 6 notes, part A”.

168. The apps draw `--foreground` on every ground. The web's per-ground inks (`--secondary-foreground` 16% and `--accent-foreground` 14% in light, against `--foreground`'s 11%) are not painted; `unreadGenerated` lists them. *(was Phase 6 A P6A-1)*
169. The shipped status ramp (`junoSuccess`, `junoDanger`, `junoCaution`) is still hand-tuned text colour where the web draws `--success-ink`, `--destructive-ink` and `--warning-foreground`. It is read at about 300 sites across Code, Work, the phone and the Mac (43 of them in Chat's Mac files), several as fills, so it moves surface by surface with a look at each. *(was Phase 6 A P6A-2)*
170. Native-only tokens with no web variable: Juno Code's terminal well and diff rows, the chart series palette past the accent and the citation teal. Registered, not deleted. *(was Phase 6 A P6A-3)*
171. The phone keeps its shipped dark canvas, translucent border and row alphas until the iOS pass (as before; now on the register). *(was Phase 6 A P6A-4)*

### Final review (#172–#182)

Source: `MACOS_LIQUID_GLASS_REDESIGN.md`, “Final review”.

172. A prompt handed to the window (Quick Entry's Return, a page's "Ask") always lands in the composer: an empty field takes it as it is, and a half-typed draft keeps its words and gains the prompt after a blank line. The web's seed replaces the field; the Mac keeps what the reader typed.
173. A failed run's status mark is always its cross (the Differentiate Without Color glyph), never the 6pt dot: the web's `--destructive` and `--primary` are near twins at that size, and under Reduce Motion a running dot stops breathing, which left a running and a failed row identical. The near-identical hues are raised with web design.
174. Share's popover is sized per state (ready 360 × 204, loading and error 176, revoked 180, blocked 132) instead of one 360 × 232 frame; #153's footer placement of More… stays for the ready state.
175. ⌘K's offline notices name every type in one line ("Knowledge, memory and tasks: not searched while offline."), not a line each. Mac-only copy.
176. On this Mac's own page, a switch the Mac has not offered says "This Mac has not offered this. Switch it on under On this Mac, above." (the reader is on the Mac); other Macs keep the web's sentence. The local tile's groups read "What this Mac offers" and its approval radios wear the web's three mode names.
177. The Settings rail's no-results state is the shared empty state, "No settings match “{query}”", with a Phosphor glyph, not the system's `ContentUnavailableView`. Mac-only copy (the web's Settings has no rail search).
178. Connections' status pills carry a dot only for live state (Connected, Connecting); Available, Setup needed and Unavailable are words alone. The web dots every state (solid or hollow). Follows #116.
179. Mermaid diagrams use Mermaid's `neutral` theme in light; the web uses `default`, whose lavender nodes and violet strokes §10.2 rule 5 rules out. Dark is unchanged.
180. The Task panel's Details end with a labelled, selectable "Task ID" row, not a bare id. Mac-only (the panel is Mac-only, #59).
181. VoiceOver says where a waiting approval is: "…The approval is in the reply, under its activity line." or "…in the Activity panel." while the panel holds the run. The SPEC's "below the answer" was wrong for the Mac, which places the approval above the answer.
182. The private mode is "Incognito" everywhere the Mac names it, as on the web: the toolbar toggle ("Turn on incognito" / "Leave incognito"), the menu's "New Incognito Chat", ⌘K's "New incognito chat", and the leave confirmation "Leave incognito?" / "It won't be saved." (the web leaves without asking; the menu and ⌘K rows are Mac-only).

### Owner-approved additions (#183–#184)

Source: `MACOS_REDESIGN_HANDOFF.md` › "Ready to ship", "Added after the final review (2026-09-25)".

183. React, JSX, TSX and TypeScript artifacts and Tailwind-styled pages run live on the Mac from bundled copies of the web's own CDN builds — React and ReactDOM 18.3.1 (UMD development), `@babel/standalone` 7.29.9 with the web's presets (`react` classic runtime, `typescript` with `onlyRemoveTypeImports`) and Tailwind Play 3.4.17 — served over `juno-runtime:` (`Resources/ArtifactRuntime`, checksums in its README); the web fetches them from unpkg and cdn.tailwindcss.com. Where that shows: Babel is pinned at 7.29.9 where the web's unversioned URL follows the latest release; Tailwind Play's `?plugins=` builds are not bundled, so plugin classes stay unstyled; and a full HTML page that loads Tailwind Play, React 18, ReactDOM 18 or Babel 7 from a CDN itself is pointed at the bundled build, its `integrity` hash dropped and a `.production.min` React served as the development build (whose warnings reach the Console), where the web gives it the CDN's file. Python still shows Code (#21).
184. The greeting's italic name (and the agent thread's "Hi, I'm *name*") is Newsreader Italic's variable file pinned at `opsz` 24 and `wght` 400 through a font descriptor, so it is the exact italic of the bundled Newsreader 24pt Regular around it, at weight 400 as the web's `font-normal` greeting sets it. The Medium Italic stand-in (a half-weight heavy) is gone. The web draws Google Fonts' Newsreader at the browser's choice of optical size; the Mac holds upright and italic at the 24pt cut at every greeting size (32–48).

# Audit: web shell, chat and design system (Phase 0)

- **Scope:** the app shell and sidebar, every sidebar destination and route under `src/app/(app)`, the chat home and empty state, the composer (including `@` mentions), the model picker, the transcript, tool receipts, the thinking panel, follow-ups, the design tokens and how they reach Swift, fonts, radius, shadows, motion, icons, the ESLint design rules and the `/dev/*` galleries.
- **Tree:** `rework/refoundation` @ `1feb392c`, which is the same commit as `main`. Audited on 2026-09-30.
- **Method:** static reading, `grep` and `git` only. No dev server, build, typecheck or test was run: Phase 0 rules, and a baseline gate was running on the machine. So nothing here was visually confirmed. Runtime claims are marked **UNVERIFIED**.
- **Competitor claims:** checked with live web research on 2026-09-30. Sources are listed at the end. Where a page gave no date, the report says so.

---

## 0. Decision-relevant summary

1. **Juno does not merely resemble Claude; its design tokens are Claude's values.**
   - The page is `#faf9f6` (`globals.css:70`). Claude's canvas is `#faf9f5`.
   - The sidebar is `#f4f3ee` (`globals.css:213`), exactly the "Pampas" swatch published for Claude.
   - The default accent is a terracotta at hue 15 (`globals.css:82`, `preferences.ts:15`). Claude's "Crail" is also hue 15.
   - The greeting and the wordmark are set in a serif (`empty-state.tsx:10-11`). The wordmark's size was "measured off" Claude's wordmark (`app-sidebar.tsx:957-960`).
   - The `+` menu labels are Claude's, word for word: "Add files or photos", "Take a screenshot", "Add to project" (`contracts/product/juno-shell-v1.json:88-92`).
   - 55 comment lines across 32 files justify a design choice by pointing at Claude or ChatGPT.
   - The product's own brand commitments name Grok, ChatGPT and Meta Muse as references, not Claude (`PRODUCT.md:27`).
2. **The design system is centralised and mechanically projected to Swift.** Colour and motion come from `globals.css`; radius, type and spacing from `tailwind.config.ts`; `scripts/generate-design-tokens.ts` projects both into `JunoGeneratedTokens.swift`. A re-brand done at the token layer therefore reaches web, Mac and iOS at once. This is the refoundation's biggest lever.
3. **The information architecture has three versions.**
   - **Web and Mac:** Chat and Code, with Library, Projects, Artifacts and Agents, plus More (Assistants, Skills, Automations). The Mac is held to the web by the shell contract.
   - **iPad:** Chat, Work and Code, with Tasks and Connections.
   - **iPhone:** Chat, Work and Code as products, plus an eight-tile drawer that includes Work and Tasks.
   - The web retired Work and Tasks, and the shell contract never reaches iOS.
4. **The chat surface is made of very large components glued by a window event bus.**
   - `composer.tsx` is 3,731 lines, `app-sidebar.tsx` 3,125, `chat-view.tsx` 2,697 and `globals.css` 4,081.
   - Components talk through about 40 `window` `juno:*` CustomEvent names.
   - Any redesign has to cut these apart first.
5. **A large chat rework sits unmerged, unreviewed and partly broken.**
   - Branches `web/rework-ws1` through `ws8` and `web/tools-thinking-research` carry a 5,600-line spec.
   - The pieces relevant here are the new run block (ws5), the Activity panel and right-column shell (ws6), and the Research UI (ws8). Together they would replace today's thinking strip, thought panel and receipts.
   - The refoundation has to decide whether to adopt this work or supersede it.
6. **The model catalogue presents estimates as facts.** It shows "Intelligence n/10" and "Speed n/10" bars even when `model-metrics.ts` marks the grade `source: "estimated"` or a "positioning estimate". Nothing tells the reader.
7. **The `/dev/*` galleries are the only way to see these surfaces signed out.** There are 22, all dev-only. They cover the sidebar, secondary pages, the transcript, the composer and settings. They do not cover the model catalogue, the command or search palette, the thought panel, follow-ups, or a real `ChatView` empty state. `/dev/polish` has drifted from the product.

---

## 1. Map

### 1.1 Shell and data flow

```
src/app/layout.tsx         RootLayout: fonts (Inter / Newsreader / JetBrains Mono, :35-53),
                           the data-accent attribute, theme, locale, a font-size boot script
                           and <Providers>
  └ src/app/(app)/layout.tsx   force-dynamic; getSessionBan → requireUser → getAppBootstrap(user)
       ├ AppProvider (components/app/app-provider.tsx, 362 lines)
       │    bootstrap = { quota, conversations (listConversations, take 200, queries.ts:39-81),
       │                  folders, models, settings, … } (lib/app-data.ts:86-190)
       ├ AppShell (components/app/app-shell.tsx, 698 lines)
       │    ├ <aside> desktop sidebar (resizable 224–336, default 288, rail 64; :25-45)
       │    │    └ AppSidebar product={productOf(pathname, activeConversation.kind)}
       │    ├ <Sheet> phone drawer → AppSidebar (same component, re-based tokens; :609-616)
       │    ├ <main> StreamProgress (juno:streaming), VerifyEmailBanner, phone top bar
       │    │         (menu / title / search / new), PageTransition{children}
       │    └ OnboardingLazy, AnnouncementPopupLazy, CommandPaletteLazy, DocumentTitle
       └ SettingsModalLazy (the settings modal, beside the /settings page)
```

**How the shell's parts talk to each other.**
- **Window events.** Roughly 40 `window` CustomEvent names, such as `juno:new-chat` (12 sites), `juno:search`, `juno:streaming`, `juno:toggle-sidebar`, `juno:go-product`, `juno:composer-seed` and `juno:learning-demo`. They are dispatched and heard across unrelated components, for example `app-shell.tsx:241-267`, `:318-325` and `:391-394`.
- **localStorage.** Sidebar collapse and width (`juno:sidebar-collapsed`, `juno:sidebar:width`), section folds (`app-sidebar.tsx:186-191`), and model recents.
- **Polling.** The agent roster refreshes every 10 s (`use-agents.ts:16`), notifications every 30 s (`work-transport.tsx:131`), and there is one run-status poll per product (`app-sidebar.tsx:601-640`).

**The sidebar** is `components/app/app-sidebar.tsx`, 3,125 lines, about 27% of them comment lines. It is one tree for the expanded panel, the 64 px rail and the phone drawer. From top to bottom:
- **Header:** collapse, the serif "Juno" wordmark (`:994-996`), and the product switch (`product-switch.tsx`, Chat and Code as links).
- **Actions:** New chat (⌘⇧O), Search (opens the palette through `juno:search`), and Notifications (a popover with a dot signal, `:1130-1142`).
- **Destinations:**
  - Chat: Library, Projects, Artifacts, Agents (`:1216-1234`).
  - Code: Artifacts, Customize, Pull requests (`:1211-1215`).
- **More flyout** (`:2062-2204`):
  - Chat: Assistants, Skills, Automations, then Archived.
  - Code: Connections, then Archived.
- **Folds:** Needs you (a filter toggle, `:1671-1700`), Agents (the roster), Pinned projects, Pinned, and Recent (pages of 40).
- **Footer:** the account row, name over plan.

**Keyboard and the palette.** The command palette (`command-palette.tsx`, 1,489 lines) has two modes, commands (⌘K) and search (`juno:search`). Several routes are reachable only from it (see §1.2).

### 1.2 Route inventory (`src/app/(app)`)

| Route | Lines | What it is | How you reach it |
|---|---|---|---|
| `/chat`, `/chat/[id]` | 46 / 86 | `ChatView`. For `kind=code` with a workspace, `[id]` renders `CodeSessionView` (`chat/[id]/page.tsx`) | New chat, sidebar rows |
| `/code`, `/code/new`, `/code/customize`, `/code/pulls` | 129 / 53 / 42 / 62 | The Code product | Product switch, Code sidebar |
| `/library` | 417 | Files | Sidebar |
| `/projects`, `/projects/[id]` | 593 / 1,427 | Projects | Sidebar |
| `/artifacts` | 1,025 | The index of generated things. Designs are a type filter here | Sidebar |
| `/a/[id]` | 87 | One artifact in its own window. `/design/[id]` redirects here | Links |
| `/agents`, `/agents/[id]`, `/agents/new` | 6 / 30 / 19 | Agents (redesign live on main, `a4f8b992`) | Sidebar destination **and** the Agents fold |
| `/assistants` | 373 | Custom assistants | More, `@assistants`, ⌘K |
| `/skills`, `/skills/[id]`, `/skills/new`, `/skills/import` | 17 / 122 / 199 / 13 | Skills | More |
| `/automations`, `/automations/[id]`, `/automations/new` | 133 / 423 / 49 | Scheduled work. `/tasks` redirects here | More |
| `/connections` | 342 | Connectors | Code More, Settings, composer |
| `/settings` | 66 | Settings page. The same sections also open as `SettingsModalLazy` | User menu |
| `/upgrade` | 351 | Plans (liquid-metal CTA, `upgrade/page.tsx:177`) | User menu, product-switch gate |
| `/memory` | 16 | Memory manager | ⌘K, Settings, composer `/memory` |
| `/compare` | 8 | Side-by-side model race | **⌘K only** (`command-palette.tsx:1247`) |
| `/roadmap`, `/roadmap/[id]` | 431 / 358 | Feature requests | **⌘K only** (`:1249`) |
| `/permissions`, `/permissions/[hostId]` | 362 / 417 | Mac host approvals | ⌘K, Settings > Devices |
| `/knowledge/documents/[id]` | 250 | Parsed-document inspector | **No inbound link found** (only `route-title.ts:46`). Orphan |
| `/admin/*` | small | Admin | User menu, "Admin panel" |
| Redirects | | `/design` → `/artifacts?type=DESIGN`, `/tasks` → `/automations`, `/research` → `/chat?research=1`, `/research/[id]` → its chat, `/work/*` → chat or automations (`work/[[...segments]]/page.tsx`), `/profile` → `/settings?section=account` | Old links |

### 1.3 Chat surface

**Loading and streaming a conversation.**
- `chat/[id]/page.tsx` loads the thread with `getConversationThread` and renders `<ChatView …>`.
- `ChatView` (`components/chat/chat-view.tsx`, 2,697 lines) drives the turn through `useChat` (`hooks/use-chat.ts`, 1,918 lines). That hook POSTs `/api/chat` and consumes the stream.
- Beside the transcript, `ChatView` owns a great deal:
  - the header band (title, share and incognito, `:2084-2135`);
  - the greeting view (`:2410-2475`);
  - the thought dock (`:2478-2540`);
  - the canvas split;
  - agent threads (`AgentGreeting`, `AgentPanel`, `AgentComputerPip`);
  - the Work run panel;
  - Research run panels;
  - realtime voice;
  - the follow-ups;
  - the `/learn-demo` listener.

**The empty state.**
- `EmptyGreeting` (`empty-state.tsx:5-15`) renders "How can I help, *Name*?" in `font-serif text-display` (Newsreader).
- `PrivateGreeting` renders "You're incognito".
- The greeting sits centred above the composer (`chat-view.tsx:2414-2475`).

**The transcript.**
- `MessageList` (433 lines) and `MessageItem` (1,761 lines): user bubble, reply markdown (`markdown.tsx`, 776 lines), action row (Copy, 👍, 👎, Read aloud, Regenerate, More; `message-item.tsx:1558`), version pager (`:449`), and in-place editing (`:729`).

**Thinking and tools.**
- `ActivityTimeline` (463 lines) is the inline strip on every turn.
- The strip lazy-loads `ThoughtProcessPanel` (1,655 lines, `activity-timeline.tsx:~24`).
- Both use the run model in `thought-process-model.tsx` (852 lines) and `lib/run-receipt`.
- Tool calls render through `ToolReceiptRow` (`tool-receipt.tsx:113`): one hairline row per call, with an in-flow disclosure.
- The live mark is `PhaseOrb` (`effects/phase-orb.tsx`), a `thinking-orbs` canvas. For the first 2 s it is the 3×3 matrix instead.

**Follow-ups.** `FollowUpSuggestions` (`follow-up-suggestions.tsx:25-54`) POSTs `/api/chat/follow-ups` whenever the last message is a finished assistant turn (`chat-view.tsx:529-533`, `:2379-2391`). That route runs a utility model (`follow-ups/route.ts:140`) behind a limit of 30 per minute (`:84`).

**The composer.**
- `Composer` (`components/chat/composer.tsx`, 3,731 lines) sits on the primitives in `components/ui/composer-shell.tsx` (971 lines):
  - `ComposerShell`: the field tier plus a controls row (`:75-139`);
  - `ComposerPrimaryAction`, whose faces are send, stop, voice and busy;
  - attachment tiles;
  - `ComposerFieldMirror`, the painted mentions (`:462-510`).
- **`+` menu** (`composer-plus-menu.tsx`; data at `composer.tsx:2646-2900`):
  - three sections "in Claude's order" (`composer.tsx:2646`);
  - labels pinned in the shell contract (`juno-shell-v1.json:88-97`): Add files or photos, Take a screenshot, Add from library | Add to project, Connectors | Use a skill, Research, Web search, Memory.
- **`/` commands:** `/model`, skills, navigate (`composer.tsx:1600-1720`).
- **`@` mentions** (`composer.tsx:358-395`, `:1729-1893`):
  - The rows are `@search`, `@research`, `@memory`, `@assistants` (which navigates away), and one row per connected or configured connector.
  - Detection is a regex at the caret (`:1856-1861`).
  - A connector mention is painted as a chip by drawing the draft a second time behind a transparent textarea (`composer-shell.tsx:462-510`). That paint appears only while the connector is attached to the chat.
  - There is **no mention of files, chats, projects, agents, people or models**, and no structured token reaches the server; the draft stays plain text.
- **Other controls:** dictation (`composer-dictation.tsx`, 607 lines), clarification popover (524), reasoning slider (273), private-chat toggle, skills panel, voice glow.

**The model picker.**
- Stage one is `ModelQuickMenu` / `ModelSelector` (`model-selector.tsx`, 445 lines): Auto, favourites, recents, then More models, then thinking effort.
- Stage two is `ModelCatalogue` (`model-catalogue.tsx`, 971 lines, dynamically imported): a 600 px three-pane catalogue whose detail panel shows Intelligence, Speed, Context and Cost bars (`:173-196`, `:279-290`) from `lib/model-metrics.ts`.

### 1.4 Design system

| Layer | Where | Facts |
|---|---|---|
| Colour | `src/app/globals.css` `:root` (`:59-505`), `.dark` (`:507-660`), accents (`:666-694`) | 93 custom properties on `:root`, 57 of them HSL colours. Six accents: coral (default), juniper, teal, violet, amber, sage. Warm neutrals by rule (`:62-68`) |
| Type | `tailwind.config.ts:317-360` | 13 rungs: hero, display, page-title, title (22), heading (18), body-lg (17), reading (16), body (15), nav (14), ui (13), label (12), caption (11), micro (10.5) |
| Fonts | `src/app/layout.tsx:35-53` | Inter 400/500/600 for UI; Newsreader 400/500/600, roman and italic, for the greeting and wordmark; JetBrains Mono for metadata and code |
| Radius | `tailwind.config.ts:138-157`, `--radius` `globals.css:260` | 18 names over 11 values: micro 2, sm 4, **xs 6**, md 8, control 10, field 12, menu 14, card/popover/surface/lg 16, panel/composer 20, stage 28, logo 24%. Most used: `rounded-control` 259, `rounded-full` 238, `rounded-field` 220, `rounded-card` 153. One arbitrary `rounded-[0.25em]` (allowed) |
| Shadow | `globals.css:394-442`, dark `:636-651` | 10 names: raised, raised-lg, inset, pressed, float, soft, lift, glass, pop, well. `inset` and `pressed` are transparent no-ops (`:422-423`); `well` aliases `inset`. Used sparingly: 22 `shadow-soft`, 20 `shadow-float`, 18 `shadow-raised` |
| Motion | CSS vars `globals.css:336-371`, Tailwind `:251-285`, `src/lib/motion.ts` (from `tokens.generated.ts`) | Six durations (70/120/160/220/360/560), nine curves, four framer springs, six variants, three stagger rungs. 35 Tailwind keyframes plus 24 CSS `@keyframes` |
| Motion in use | grep over `src` | framer-motion in 36 files (63 `motion.*` elements, 24 `AnimatePresence`). `animate-rise-in` on 148 sites, `animate-fade-in` 107, `staggerDelay` 214 times in 72 files, including loading skeletons such as `(app)/loading.tsx` and `roadmap/[id]/loading.tsx`. `MotionConfig reducedMotion="user"` wraps the shell (`app-shell.tsx:460`) |
| Icons | `src/components/ui/icons.tsx` (712 lines), `juno-glyphs.tsx` | Phosphor geometry, `regular` weight, optical `bold` at 12 px and under. Five bespoke marks: JunoChat, JunoCode, JunoDesign, JunoLibrary, Send. Per-glyph hover "articulations" played by CSS. ESLint forbids importing `lucide-react` or `@phosphor-icons/*` directly (`eslint.config.mjs:144-160`) |
| Lint | `eslint-rules/design-system.mjs`, `no-arbitrary-text.js`, `no-raw-text-size.js`; wired at `eslint.config.mjs:100-160` | Errors: `no-arbitrary-radius` (autofix), `no-ad-hoc-stacking`, `concentric-radius`. Warnings: `no-arbitrary-text` (3 sites left), `no-raw-text-size` (19 sites left) |
| Projection to Swift | `scripts/generate-design-tokens.ts` → `JunoGeneratedTokens.swift` and `src/lib/design/tokens.generated.ts`; checked by `design:tokens:check` in `native.yml:123` | Parses the CSS for colour and motion, and the Tailwind config for radius, type and spacing. The digest hashes **the whole `globals.css` file** (`:349-355`) |
| Design contract | `scripts/generate-design-contract.ts` | Despite the name, **not tokens.** It projects the Design-artifact document schema (zod) to JSON Schema at `contracts/design/design-document.v1.schema.json` |
| Shell contract | `contracts/product/juno-shell-v1.json` → `scripts/generate-shell-contract.mjs` → `native/macOS/JunoDesktop/App/Generated/JunoShellContract.swift` | The web's IA as data: products, sidebars, `+` menu, primary faces, Settings rail. The web is held to it by `tests/shell-contract.test.ts`. **The Mac only**; iOS does not consume it |

### 1.5 `/dev/*` galleries (visual QA surface)

- **Access.** All 22 galleries 404 in production (`process.env.NODE_ENV === "production"` → `notFound()`). They live outside the `(app)` group, so `requireUser` never runs: every one renders signed out on a dev server.
- **Fetch shims.** Galleries marked "shim" replace `window.fetch` with fixtures. The others render presentational components or real components with fixture props.
- **What works signed out is UNVERIFIED.** No dev server was started. Any unstubbed call a real component makes (for example the composer's connector or skills reads) will fail with 401.

| Gallery | Renders | Shim | Notes and query params |
|---|---|---|---|
| `/dev/shell` | Real `AppSidebar` (and `AppShell` with `?shell=1`): Chat expanded, rail, Code expanded | yes | `?quota=near`, `?many=1` (100 chats) |
| `/dev/pages` | Real Library, Projects, Artifacts, Connections, Agents, Automations, Compare, Settings, Memory, Skills, notifications and search, inside the real `AppShell` | yes | `?page=…&state=ready\|empty\|loading\|error` |
| `/dev/agents` | Agents in the real shell, face motion states | yes | `?view=motion\|thread&panel=1&state=&fresh=1` |
| `/dev/composer-landing` | Real `Composer`, `EmptyGreeting`, `WorkRunPanel`: landing vs docked width | no | |
| `/dev/polish` | Real `MessageItem`, `ComposerShell`, empty and error states, skeletons | no | **Drifted:** "Starter chips" renders an empty `<div>` (`gallery.tsx:218-219`, `:265-267`), and the greeting is hand-copied rather than `EmptyGreeting` (`:188-190`) |
| `/dev/transcript` | Real `MessageItem`, `MessageList`, `Markdown`, code receipts, shared transcript | no | Sections: conversation, states, streaming, code, shared |
| `/dev/premium` | Libraries.dev placements: landings, composer bloom, phase orbs, image mosaic, voice glow, `MetalCta` | no | |
| `/dev/library` | Library components plus `ModelQuickMenu` (stage one only) | no | |
| `/dev/controls` | Button, Pressable, menus, the `+` menu, segmented, switch, … | no | 932 lines |
| `/dev/settings` | Real settings rail, pane, modal | yes | |
| `/dev/memory` | Memory page composition | no | |
| `/dev/skills` | Skills library, importer, composer skills panel | no | |
| `/dev/aicss` | AIcss blocks | no | |
| `/dev/glyphs` | Juno's own glyphs at every size | no | |
| `/dev/documents` | Attachment tiles, viewer, quotes | yes | |
| `/dev/design-canvas` | Real `CanvasPanel` on a generated design | yes | |
| `/dev/sandbox` | `SandboxFrame`, Mermaid, shared artifact viewer | no | |
| `/dev/learning` | Visual learning blocks | no | |
| `/dev/task-handoff` | `ApprovalCard` | no | |
| `/dev/connections` | Add-MCP-server dialog | no | |
| `/dev/share-links` | Report dialog, links admin | yes | |
| `/dev/download` | Download page | no | |

**Not covered by any gallery:**
- `ModelCatalogue` (stage two of the picker);
- the command and search palette;
- the notifications popover on its own (`/dev/pages` has `notifications`);
- the user menu;
- `ThoughtProcessPanel`;
- `FollowUpSuggestions`;
- a real `ChatView` empty state (header band plus greeting plus composer as composed in production).

Unmerged branches add `/dev/run` (ws5) and `/dev/research` (ws8).

---

## 2. What is real vs placeholder, dead or gated

| Item | Status | Evidence |
|---|---|---|
| Sidebar, product switch, rail, phone drawer, resize, collapse | Real | `app-shell.tsx`, `app-sidebar.tsx` |
| Product gating in the switch | Built but inert. Both products are `FREE` | `product-switch.tsx:68-78`; `juno-shell-v1.json` products |
| `@` mentions | Real but narrow: tools plus connectors, painted text only | `composer.tsx:358-395`, `:1729-1861` |
| "Take a screenshot" | Real (`getDisplayMedia`, feature-detected) | `composer.tsx:992-995`, `:2880-2888` |
| Follow-up suggestions | Real. One utility-model call per finished turn **and per reopened conversation**; no cache found in the route | `chat-view.tsx:529-533`; `follow-up-suggestions.tsx:33-54`; `follow-ups/route.ts:84-140` |
| Model catalogue grades | **Partly estimated, shown as fact.** Models without family data get grades from their cost tier (`source: "estimated"`), and several family rows are "positioning estimates". The panel draws `n/10` bars with no provenance | `model-metrics.ts:343-352`, `:55-80`; `model-catalogue.tsx:279-290` |
| `ContextInspector` (377 lines) | **Dead.** No importer; ws8 deletes it | `components/app/context-inspector.tsx`; `git diff main...web/rework-ws8` |
| `/learn-demo` → `juno:learning-demo` | **Dead trigger, live listener.** Nothing dispatches the event, yet `chat-view.tsx` imports the step-lab fixture into the chat bundle | `chat-view.tsx:69`, `:891-910`; `step-lab-fixture.ts:4` |
| `/knowledge/documents/[id]` | **Orphan route.** No inbound link | §1.2 |
| `.empty-greeting*` CSS (accent-coloured name, amber override) | **Dead.** `EmptyGreeting` no longer uses the class | `globals.css:1692-1726`; 0 references in `src` |
| Other dead CSS | About 15 classes with no reference: `juno-mark-popping`, `glass-raised`, `research-field`, `work-breathing`, `work-crossfade*`, `work-status-shift`, `reasoning-fast-toggle`, `reasoning-slider-track`, `composer-voice-wave`, `animate-research-stage` | Script over `globals.css` (179 top-level classes, 22 unreferenced, 7 of those are highlight.js runtime classes) |
| `StatusDot` | Now screen-reader-only (owner rule, 2026-09-26), but the sidebar header comment still describes a visible toned dot | `work-vocabulary.tsx:310-320` vs `app-sidebar.tsx:92-99` |
| `AgentStatusBadge` | Live **"Running", "Thinking" and "Generating" badges with an animated orb.** Used in `code-session-banner`, `project-work-list`, `subagent-tree` | `ui/agent-status-badge.tsx:34-60`, `effects/phase-orb.tsx` |
| Notifications row signal | A static dot: accent while a decision is pending, **muted while it is "only news"** | `app-sidebar.tsx:1117-1142` |
| `/settings` page and `SettingsModalLazy` | Both real: two presentations of one settings tree | `(app)/settings/page.tsx`, `(app)/layout.tsx:24` |
| `design:tokens:check` | **Failing on main** before any refoundation edit (`docs/rework/PROGRESS.md` baseline). No token value changed: the digest hashes the whole `globals.css`, so any component-CSS edit fails the gate | `generate-design-tokens.ts:349-355`; `git diff 64701dc2 HEAD -- src/app/globals.css` changes no `--token:` line |

---

## 3. Problems

### 3.1 What makes Juno read as a Claude imitation

The code is explicit about it: 55 comment lines in 32 files justify a choice by citing Claude and/or ChatGPT. That count comes from grepping for "Claude and ChatGPT", "Claude's …", "both references", "reference set", "ChatGPT's" and similar phrases.

| # | Juno | Evidence in code | Claude (external) |
|---|---|---|---|
| 1 | Page ground `hsl(48 24% 97.2%)`, which is **#faf9f6** | `globals.css:70` | Canvas **#faf9f5**, hsl(48 33% 97%) [S3][S4] |
| 2 | Sidebar `hsl(46 22% 94.6%)`, which is **#f4f3ee** | `globals.css:213` | "Pampas" **#F4F3EE** (search snippet citing Mobbin; the page itself returned 403) [S5] |
| 3 | Default accent "coral" `hsl(15 54% 46%)` (#b55636); dark ink `hsl(15 62% 66%)` (#de8d73) | `globals.css:82`, `:536-538`, `:678-679`; `preferences.ts:15` | "Crail" #C15F3C (hsl 15.8 53% 50%); coral #D97757 / #C6613F [S3][S5] |
| 4 | Warm charcoal dark: page #1f1d1c, sidebar #181615 | `globals.css:527`, `:603` | Dark surfaces #141413 / #181715 [S3][S4] |
| 5 | Serif display greeting, "How can I help, *Name*?" (Newsreader, italic name) | `empty-state.tsx:10-11`; `layout.tsx:18-21`, `:41-47` | Headlines in a serif ("Anthropic Serif") with a sans for UI [S3][S4]. Exact greeting copy **UNVERIFIED** |
| 6 | Serif "Juno" wordmark, size "measured off the reference": "Claude's wordmark sets a 14.86px cap" | `app-sidebar.tsx:957-960`, `:994-996` | 14.86 px figure **UNVERIFIED** (claimed only in the code) |
| 7 | UI sans chosen as "the closest open face to the custom sans Claude and ChatGPT set"; JetBrains Mono for code | `layout.tsx:13-16` | Anthropic Sans; JetBrains Mono listed as a supporting face [S3][S4] |
| 8 | Sidebar opens at 288 px, "the width Claude's sidebar opens at" | `app-shell.tsx:29-44` | **UNVERIFIED** |
| 9 | Sidebar row type and selection copied from "both references" | `app-sidebar.tsx:106-143`; `tailwind.config.ts:391-401`; `globals.css:239`, `:1372` | — |
| 10 | Product switch "PLACEMENT and the tone are Claude's"; labelled cells are "the trade Claude's own Chat/Code switch makes"; the second product is literally "Juno Code" | `product-switch.tsx:37-40`, `:231` | — |
| 11 | `+` menu: "Three sections in Claude's order"; labels "Add files or photos", "Take a screenshot", "Add to project", then connectors, skill, Research, Web search | `composer.tsx:2646`; `juno-shell-v1.json:88-97` | Claude's `+` menu: "Add files or photos", "Take a screenshot", "Add to project" \| Skills, Add connectors, Add plugins \| Research, Web search, Use style [S1][S2] |
| 12 | Composer geometry "the Claude / ChatGPT geometry"; send arrow "the same weight Claude and ChatGPT give" | `composer-shell.tsx:97-100`, `:751` | — |
| 13 | Header band "(Claude's header)": title left, share and incognito right; "You're incognito" | `chat-view.tsx:2084-2086`; `empty-state.tsx:20-33` | Incognito ghost toggle at the top right of the chat header [S6] (date not retrieved) |
| 14 | Thought panel header "Claude's footer geometry" | `thought-process-panel.tsx:718` | — |
| 15 | Icon line "the same light, even line Claude and ChatGPT draw their chrome with"; empty-state tile "the way Claude and Linear set theirs"; toasts, menus, tables, user bubble and edit-in-place all "as Claude/ChatGPT" | `icons.tsx:17`; `ui/empty-state.tsx:13`, `:31`; `sonner.tsx:44`; `menu-recipe.ts:31`; `globals.css:3074`; `user-bubble.ts:7`; `message-item.tsx:729-730` | — |

**Conclusion.** The identity comes from the palette (items 1 to 4), the serif moments (5 to 7) and the literal copy (11). That is five tokens, one font role and one JSON file. The layout conventions (items 8 to 15) are industry-standard chat patterns: they reinforce the resemblance but do not create it. The tokens are centralised, so a token and copy pass removes most of the resemblance without touching component structure.

### 3.2 AI-slop and owner-rule risks

- **The brand mark is a speech bubble with a four-point sparkle** (`public/juno-mark.png`; described in `juno-glyphs.tsx:5-12`). The spark "twinkles a quarter turn" on hover. The sparkle is the generic "AI" motif the owner's rules call out.
- **Liquid-metal CTA** on `/upgrade` (`effects/metal-cta.tsx`, used at `upgrade/page.tsx:177`, from the `metal-fx` package). It is an ornamental shader.
- **Animated thinking orbs** (`thinking-orbs`, `effects/phase-orb.tsx`): a scan meridian, an undulating sash and orbiting particles beside every live status.
  - They are also inside `AgentStatusBadge`, which prints "Running", "Thinking" and "Generating" with the orb. That is a running-status badge, which the owner's rules forbid.
- **Voice glow** (`voice/voice-composer-glow.tsx`, `voice-glow`): the owner approved "glow = state" in the premium pass (2026-09-26), but it is a bloom of light. Re-confirm it under the refoundation's no-glow-blob rule.
- **Notifications dot** in its "muted, only news" state (`app-sidebar.tsx:1140`): a static dot for non-actionable news reads as decoration. Confirm with the owner.
- **Motion noise.** `animate-rise-in` on 148 sites and `staggerDelay` on 214 sites mean pages, lists and even loading skeletons choreograph their own arrival. Premium tools use motion for state changes, not for every mount.
- **Dependency footprint** of Libraries.dev effects: `thinking-orbs`, `voice-glow`, `metal-fx`, `img-fx`, `bot-avatars` (`package.json`).

### 3.3 Product and UX coherence

1. **Four overlapping "configure a helper" concepts, plus Projects.**
   - Assistants (custom personas), Agents (teammates), Skills (instructions) and Automations (schedules) are four places. Projects also carry instructions.
   - The composer's `@assistants` row navigates away mid-sentence (`composer.tsx:1787`).
   - Agents is both a destination and a fold in the same column (`app-sidebar.tsx:1233` and `SECTION_KEYS.agents`).
2. **Two attention surfaces** in one column: the Notifications popover row and the "Needs you" filter fold (`app-sidebar.tsx:1117-1142`, `:1671-1700`).
3. **Hidden destinations.** Compare, Roadmap and (from the sidebar) Memory are reachable only through ⌘K. The document inspector is not reachable at all.
4. **Settings exists twice** (page and modal). `/profile` redirects into the page.
5. **Mentions are cosmetic.** `@GitHub` is plain text plus a painted chip. The capability is toggled through a side effect and nothing structured reaches the request. Mentions of files, chats, projects or agents, which competitors treat as core context tools, do not exist.
6. **Follow-ups on every reopen.** Every open of an old conversation whose last turn is an assistant reply fires a utility-model call (`chat-view.tsx:529-533` with no "fresh turn" condition). That costs money and adds visual churn under old threads.
7. **Model picker honesty.** The detail-panel grades present estimates as facts (§2).

### 3.4 Correctness and maintainability

- **Easing token drift across three sources:**
  - The Tailwind `ease-spring` is `cubic-bezier(0.34, 1.16, 0.64, 1)`, with overshoot (`tailwind.config.ts:275`). It is used by `checkbox.tsx:48` and `radio-group.tsx:43`.
  - The CSS `--ease-spring` is `cubic-bezier(0.22, 1, 0.36, 1)`, with none (`globals.css:361`), although its own comment says "y2 = 1.16" (`:352-355`).
  - `motion.ts:60` and Swift (`JunoGeneratedTokens.swift:466-467`) take the CSS value.
  - So one token name animates two different ways on web, and native matches only one of them.
- **Radius naming inversion.** `rounded-xs` (6 px) is larger than `rounded-sm` (4 px) (`tailwind.config.ts:159-161`). Four names alias 16 px and two alias 20 px.
- **Shadow no-ops.** `--shadow-inset` and `--shadow-pressed` are transparent (`globals.css:422-423`) yet remain classes (`shadow-inset`, `shadow-pressed`, `shadow-well`).
- **The token gate is noisy.** `design:tokens:check` fails on any `globals.css` edit, token or not (§2). A gate that is red for reasons unrelated to tokens stops being read.
- **The window event bus.** About 40 `juno:*` CustomEvents form an untyped global API between the shell, sidebar, palette, composer and chat view. Some events have no dispatcher (`juno:learning-demo`).
- **God components with prose-heavy source.**
  - Sizes: `composer.tsx` 3,731 lines (≥26% comment lines), `app-sidebar.tsx` 3,125 (≥27%), `chat-view.tsx` 2,697, `composer-shell.tsx` 971 (≥45%), `tailwind.config.ts` 924 (≥46%).
  - `globals.css` is 4,081 lines and cannot be split without breaking `@layer components` (`globals.css:7-33`).
- **Stale comments** that contradict the code:
  - `app-sidebar.tsx:92-99` describes a visible `StatusDot`;
  - `app-sidebar.tsx:948` says the wordmark reads "Juno Code" in Code (the code always renders "Juno");
  - `chat-view.tsx:2063` says the sidebar takes 304 px (the default is 288);
  - `chat-view.tsx:2493` says a 400 ms slide (the `slow` duration is 360 ms).
- **The rail width is spelled in three places** (`RAIL_WIDTH`, the `w-16` spacer, the sidebar's collapsed column), per `app-shell.tsx:480-482`.

### 3.5 Parity gaps: Web, Mac, iPhone, iPad

| Area | Web | Mac | iPhone | iPad |
|---|---|---|---|---|
| Products | Chat, Code (Work retired; `/work/*` redirects) | Chat, Code (from the contract, `DesktopShellContract.swift:26-35`) | **Chat, Work, Code** tabs (`JunoMobileSection.swift:108-140`) | **Chat, Work, Code** |
| Destinations | Library, Projects, Artifacts, Agents + More (Assistants, Skills, Automations) | Same as web (`DesktopShellContract.swift:47-55`) | Drawer grid: Projects, Library, Artifacts, **Work**, Agents, Code, **Tasks**, Connections (`JunoMobileSection.swift:105-107`). **No Assistants, Skills or Automations** | Code, **Work**, Library, Projects, Artifacts, Agents + More (**Tasks**, Connections) (`JunoMobileDrawer.swift:723-726`). The comment claims "the Mac's sidebar, row for row" (`:728`) |
| Contract enforcement | `tests/shell-contract.test.ts` | Generated enums, compile-time | **None** | **None** |
| Empty-chat greeting | Serif "How can I help, *Name*?" | Same (`DesktopEmptyChat.swift:63`, `:210`) | **Time-of-day phrases** ("Rise and grind", "Night owl mode"), which the web dropped (`JunoGreeting.swift:3-12`, `:20-44`; `JunoMobileGreeting.swift:223-248`) | As iPhone |
| `+` menu | Contract labels | Contract labels (`JunoShellContract.swift:350-356`) | Own structure: camera, photos, files, library, project, connectors, memory, canvas, tools (`JunoMobileAttachmentMenu.swift`) | As iPhone |
| Research naming | "Research" (levels removed in hotfix `ba2b0c4d`) | UNVERIFIED | **"Deep research"** (`Localizable.xcstrings:2641`, `:5267`, `:5301`; UI tests `JunoMobileComposerUITests.swift:303`, `:327`) | As iPhone |
| Tokens | Source | Generated Swift | Generated Swift | Generated Swift |
| Materials | CSS | Native Liquid Glass (checked by `native:design:glass`) | Native | Native |

---

## 4. Unmerged branches touching this area

Method: `git rev-list main..<b>`, `git cherry main <b>`, and `git diff --stat main...<b>` restricted to the files in this area.

| Branch (last commit) | Unmerged | What it does here | Recommendation |
|---|---|---|---|
| `web/tools-thinking-research` (09-24), the integration branch, and `web/rework-ws1`…`ws8` (09-24) | 15 to 26 commits each; WIP, "unverified", never reviewed or gated. ws1's WIP had a parse error (`src/lib/tools/specs/shared.ts:26`, per the chat-rework `HANDOFF.md`) | The chat rework against a 5,600-line `SPEC.md`:<br>• **ws5:** a new inline run block (`src/components/chat/run/*`, about 3,000 lines) and `/dev/run`, plus +276 lines of `globals.css` and `app-shell.tsx` edits.<br>• **ws6:** the Activity panel and a right-column shell (`src/components/chat/panel/*`, about 4,700 lines).<br>• **ws8:** the Research UI and `/dev/research`; deletes `context-inspector.tsx`.<br>• **ws1–ws4, ws7:** tools, broker, provider adapters, turn pipeline, research backend | **Do not merge the UI as-is.**<br>• The backend streams (ws1–4, ws7) fix real "tool calling doesn't work" pain and should finish through their own gate. They are orthogonal to the visual refoundation, but the wire changes (`clientFeatures`, activity events) constrain the new UI.<br>• ws5, ws6 and ws8 are the right *shape* (they replace `ActivityTimeline`, `ThoughtProcessPanel` and the receipts) but are drawn in today's Claude-derived system. Harvest their run model, phases and copy as spec input, and rebuild the visuals in the new system.<br>• Owner decisions are pending (`DECISIONS.md` §4c) |
| `artifacts/r1-lifecycle` (09-24) | 1 WIP commit, "not for main" | `artifact-inline-card.tsx` (+129), `chat-view.tsx` (+48), `message-item.tsx`, `message-list.tsx` | Coordinate: it edits the same `chat-view` and `message-item` the refoundation must split. Land or park it before the split |
| `artifacts/merge-first-light-prerebase` (09-24) | 3 unmerged of 10 (7 already in main) | Sidebar, palette, artifact card | Pre-rebase leftover; First light shipped (`e5501f65`). Check the 3 stragglers, then delete |
| `connectors/custom-mcp` (09-27) | 1 | `/connections` page (+124) plus `/dev/pages` fixtures | Product feature; independent of the shell. Land on its own merits |
| `agents/rework`, `agents/features`, `agents/runtime`, `wip/agents-v2-gemini-stopped` (09-27) | 1–4 each | `chat-view`, `composer`, `approval-card`, `agent-change-card`, `tailwind.config.ts`, `globals.css` | Superseded by `agents/redesign`, which is live on main (`a4f8b992`). Archive |
| `design/voice-motion` (09-27) | 1 | Voice glow bands | Hold: it deepens an effect §3.2 questions |
| `origin/claude/affectionate-volta-kqsq9v` (09-22) | 2 (77 area files) | Splits `icons.tsx` into `ui/icons/glyphs-*.ts`; "every mark answers a hover" | Stale (8 days, 77 files). Do not rebase. Reconsider after the icon decision |
| `design/premium-ios2` (09-26) | 1 WIP | iPad lane follow-ups | Native; affects the iPad parity row in §3.5 |

---

## 5. Recommendations, ordered by leverage

**R1. Re-found the brand at the token layer, not component by component.** This removes most of §3.1 in one change and reaches web, Mac and iOS through the generator.
- Replace the page and sidebar neutrals, the default accent, and the serif roles with Juno's own values. Follow PRODUCT.md's stated references (quiet, premium, restrained glass; Grok, ChatGPT and Meta Muse as craft references, not Claude).
- Drop the serif greeting and wordmark, or pick a face with no Claude association. Rename the `+` menu rows in Juno's own voice.
- Replace "because Claude/ChatGPT do it" comments with Juno principles as they are touched.
- **Files:**
  - `src/app/globals.css:59-260`, `:507-660`, `:666-694`;
  - `src/lib/preferences.ts:15`;
  - `src/app/layout.tsx:35-53`;
  - `tailwind.config.ts:288-316`;
  - `src/components/chat/empty-state.tsx`;
  - `src/components/app/app-sidebar.tsx:936-997`;
  - `src/components/ui/theme-color.ts`;
  - `public/og.png`, `public/juno-mark.png`;
  - `contracts/product/juno-shell-v1.json:88-97`;
  - `native/Packages/JunoNativeKit/Sources/JunoDesignSystem/JunoSerif.swift`, `JunoGreeting.swift`;
  - `native/macOS/JunoDesktop/App/DesktopEmptyChat.swift`;
  - then `npm run design:tokens` and `shell:contract:generate`.

**R2. One information architecture, enforced on every client.**
- Decide the product set: Chat and Code, or Chat, Work and Code.
- Merge Assistants, Agents, Skills and Automations into at most two concepts.
- Extend `generate-shell-contract.mjs` to emit a Swift projection that JunoMobile consumes, so iPhone and iPad drift fails the build the way the Mac's does.
- Fix "Deep research" on iOS. Surface or retire Compare, Roadmap and `/knowledge/documents/[id]`.
- **Files:**
  - `contracts/product/juno-shell-v1.json`, `scripts/generate-shell-contract.mjs`;
  - `native/iOS/JunoMobile/App/JunoMobileSection.swift`, `JunoMobileDrawer.swift`, `Resources/Localizable.xcstrings`;
  - `src/components/app/app-sidebar.tsx:1196-1250`, `:2062-2204`;
  - `src/components/app/command-palette.tsx:1180-1250`;
  - `src/app/(app)/*` routes;
  - `tests/shell-contract.test.ts`.

**R3. Cut the god components apart before redesigning them.** Replace the `juno:*` window events with a typed shell store (context or Zustand) exposing named actions. Split:
- `chat-view.tsx` into ChatSurface (layout slots), ThreadHeader, EmptyState, SidePanels (canvas, thought, agent) and per-feature hooks (voice, research, work, agent);
- `composer.tsx` into data (commands, mentions, `+` rows), controller and view;
- `app-sidebar.tsx` into header, actions, destinations, folds and account.

Without this, R1, R4 and R6 each become high-risk edits of 3,000-line files that sibling sessions also touch.
- **Files:** `src/components/chat/chat-view.tsx`, `composer.tsx`, `src/components/app/app-sidebar.tsx`, `app-shell.tsx`, `src/hooks/use-global-shortcuts.ts`, plus every `dispatchEvent(new CustomEvent("juno:…"))` site.

**R4. Decide the chat rework's fate explicitly** (§4).
- Finish and land the backend workstreams (ws1–ws4, ws7) through their own gate.
- Treat ws5, ws6 and ws8 as the functional spec for the transcript's run block, activity panel and research UI, rebuilt in the refoundation's visual system.
- Park or land `artifacts/r1-lifecycle` before splitting `chat-view` (R3).
- **Files:** branches `web/rework-ws1…ws8`, `web/tools-thinking-research`; `docs/chat-rework/SPEC.md` §7 (on the branch); `src/components/chat/activity-timeline.tsx`, `thought-process-panel.tsx`, `thought-process-model.tsx`, `tool-receipt.tsx`.

**R5. Remove the slop and the status theatre.**
- Retire `MetalCta`.
- Replace `PhaseOrb` and orb badges with a static, typographic status: the sentence is already the status.
- Remove the visible "Running" and "Thinking" labels with orbs from `AgentStatusBadge`, keeping `sr-only` text.
- Reconsider the sparkle mark and its hover twinkle.
- Re-confirm the voice glow and the muted notification dot with the owner.
- **Files:**
  - `src/components/effects/metal-cta.tsx`, `phase-orb.tsx`, `src/app/(app)/upgrade/page.tsx:177`;
  - `src/components/ui/agent-status-badge.tsx`;
  - `src/components/ui/juno-glyphs.tsx`, `public/juno-mark.png`;
  - `src/components/voice/voice-composer-glow.tsx`;
  - `src/components/app/app-sidebar.tsx:1140`;
  - `package.json` (`metal-fx`, `thinking-orbs`, `voice-glow`, `img-fx`, `bot-avatars`).

**R6. Make the token system trustworthy, then smaller.**
- Fix the `ease-spring` drift: one value, generated into Tailwind rather than hand-written twice.
- Make the token digest hash parsed token values, not the whole CSS file, so `design:tokens:check` goes green and stays meaningful.
- Rename or collapse the radius aliases (xs/sm inversion; one name per value).
- Delete the no-op shadows.
- Cut the type ladder from 13 rungs toward about 8, since the 1 px steps from 13 to 17 are hard to tell apart.
- Delete the dead CSS listed in §2.
- **Files:** `tailwind.config.ts:138-157`, `:199-210`, `:251-285`, `:317-360`; `src/app/globals.css:336-371`, `:394-442`, `:1276-1282`, `:1692-1726`; `scripts/generate-design-tokens.ts:349-355`; `eslint-rules/design-system.mjs:44-56`; `src/lib/motion.ts`.

**R7. A motion diet.**
- Keep motion for state change (panel open, send, stream, selection).
- Remove mount choreography: `animate-rise-in` on pages, `staggerDelay` on lists and all skeletons.
- Keep `MotionConfig reducedMotion="user"`.
- **Files:** the 72 files using `staggerDelay` (top: `roadmap/[id]/page.tsx`, `knowledge/documents/[id]/*`, `download-view.tsx`, `library-browser.tsx`, `onboarding.tsx`, `app-sidebar.tsx`, `command-palette.tsx`, `(app)/loading.tsx`); `src/lib/motion.ts:229-270` (`STAGGER`, `staggerDelay`).

**R8. Honest model picker.** Show where each grade comes from (official, benchmark or estimate), or remove the `/10` bars for estimated rows.
- **Files:** `src/components/chat/model-catalogue.tsx:173-196`, `:276-291`; `src/lib/model-metrics.ts:343-352`; the native `JunoModelSelector*.swift` for parity.

**R9. Real inline tokens in the composer.**
- Replace the regex-plus-mirror mentions with a token model: an inline chip node, a typed payload in the chat request.
- Cover connectors, tools, files and library items, chats, projects, agents and models.
- Keep `/` for commands only; drop navigational `@` rows such as `@assistants`.
- **Files:** `src/components/chat/composer.tsx:358-395`, `:1729-2060`, `:2412-2421`; `src/components/ui/composer-shell.tsx:160-260`, `:462-510`; the chat request schema (`src/lib/chat/request.ts`, which ws1/ws4 also touch); the `composer.plusMenu` section of the shell contract.

**R10. Stop the follow-up cost leak.** Fetch only for a turn that just finished streaming in this session, or cache suggestions per `messageId` server-side.
- **Files:** `src/components/chat/chat-view.tsx:529-533`, `src/components/chat/follow-up-suggestions.tsx:28-54`, `src/app/api/chat/follow-ups/route.ts`.

**R11. Make the galleries the visual-QA contract.**
- Add galleries for the model catalogue, command and search palette, user menu, notifications, thought panel or run panel, follow-ups, and a real `ChatView` empty state with its header band.
- Fix `/dev/polish` (empty "Starter chips" section, hand-copied greeting).
- Capture both themes at phone, iPad and desktop widths with Playwright and Chrome. Per the memory notes, the built-in pane blocks URL-loaded iframes and has no signed-in session.
- **Files:** `src/app/dev/*`, `playwright.config.ts`, `e2e/`.

**R12. Clear the dead code in this area.**
- `src/components/app/context-inspector.tsx` (unused);
- the `juno:learning-demo` listener and the `STEP_LAB_DEMO_MESSAGE` import (`chat-view.tsx:69`, `:891-910`);
- the dead CSS (§2);
- the stale comments (§3.4);
- the superseded branches (§4).

---

## Sources (competitor claims, accessed 2026-09-30)

- [S1] Claude Help Center, "Upload files to Claude": the `+` button in the lower left, "Add files or photos". Last updated 2026-07-23. https://support.claude.com/en/articles/8241126-upload-files-to-claude
- [S2] AI Toolbox, "How to upload files to Claude (2026)": `+` menu order "Add files or photos", "Take a screenshot", "Add to project" \| "Skills", "Add connectors", "Add plugins…" \| "Research", "Web search", "Use style". Dated 2026-06-15. https://www.ai-toolbox.co/claude-management-and-productivity/how-to-upload-files-to-claude-2026
- [S3] Fudge, "claude.ai website design: fonts, colors and UI patterns": surfaces #FAF9F5, #F2F0EA, #ECEAE4; dark #141413; coral #D97757 and #C6613F; Anthropic Serif and Anthropic Sans; JetBrains Mono. No date shown. https://design.withfudge.com/share/claude.ai-design
- [S4] VoltAgent, awesome-design-md, `design-md/claude/DESIGN.md` ("alpha"): canvas #faf9f5, coral #cc785c, dark #181715, serif display, humanist sans, JetBrains Mono. No commit date retrieved. https://github.com/voltagent/awesome-design-md/blob/main/design-md/claude/DESIGN.md
- [S5] Web search result summarising Mobbin's Claude palette: Crail #C15F3C, Cloudy #B1ADA1, Pampas #F4F3EE. **The Mobbin page returned 403, so this is snippet-only and UNVERIFIED at the source.** https://mobbin.com/colors/brand/claude
- [S6] Web search results (freeacademy.ai, vibecodingacademy.ai, aigeniuslab substack): Claude's incognito is a ghost icon at the top right of the chat header. Dates not retrieved. https://freeacademy.ai/blog/claude-keyboard-shortcuts-hidden-features

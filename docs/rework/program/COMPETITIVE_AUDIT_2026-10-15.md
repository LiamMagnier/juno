# Alevr competitive audit — 15 October 2026

This is a full review of Alevr against ChatGPT (Chat, Work, Codex), Claude (Chat, Claude Code, Cowork), T3 Chat and T3 Code, Cursor, Gemini, Perplexity and others. It covers features, design and motion. Fifteen research and audit agents produced it. Each one read Alevr's code and checked competitors against public documentation and live pages as of 15 October 2026. The sources for every claim are kept in each section.

**Scope.** 6 competitor groups (394 features catalogued) and 7 Alevr surfaces (254 features audited). The result is 98 ranked gaps and 22 areas where Alevr already leads.

**Verdict.** Alevr leads the category on routing transparency, cost receipts, streaming craft, context mentions and the honesty of its failure states. It trails on breadth: 32 gaps have impact 4 or 5. The biggest are branching edits, image generation, the Code ship flow, Code composer attachments, routines created from chat, first-party Google and Microsoft connectors, and iOS push. The build plan at the end of this document closes these in waves. Items that need an outside account or vendor are flagged and are not counted as done until the owner provides access.

## Where Alevr already leads

- Auto routing that explains itself: src/lib/router/decide.ts scores models on expected total cost, applies hard plan, data-policy, context, budget and health filters, and shows a truthful 'Auto · Model · Effort · Selected for' receipt (auto-receipt.tsx). ChatGPT retired auto-switching and Perplexity's effort slider names the model without saying why.
- Auto data boundary (no-training labs only, exclude PRC labs, EU/US only) in Settings > Models. No competitor exposes this.
- Per-turn token and USD receipt (message-item.tsx TurnMeta), plus euro budget meters with 5-hour and weekly windows, held spend, a user ceiling and 30-day history (sections/billing.tsx). Clearer than ChatGPT's opaque credit pool or Claude's unpublished limits.
- Citation audit that checks answers against their sources (citation-audit.tsx, research claims and support marks). No competitor ships per-claim verification.
- Deep research leads the category: editable plan and clarify gates, four depths, mid-run guidance, pause, 'Write with what you have', private sources gated on the server, and a live Deep Field source map that follows the run's real progress.
- Memory control beyond ChatGPT and Claude: natural-language edits drafted as a diff with Apply and Undo, an edit ledger with inverse operations, Forget versus Delete (suppression), project-scoped memory, background dreaming with sensitive-topic classification, procedural skill candidates, and injection-safe import.
- Streaming craft and resilience: frame-paced reveal with a CSS Custom Highlight fade, half-formed markdown held back, reconnect without double charging, honest finish notes, Continue, and 'Not sent · Retry'. On par with or better than ChatGPT's accent-word entry.
- A 7-kind context and mention system (crew, file, project, app, skill, chat, artifact) with approval previews and a resolution receipt under the user turn.
- Multi-agent rooms and cross-conversation messaging in chat, plus Orbit agents with faces, goals, budgets, setup-change cards with Undo, and proactive ideas.
- Approval UX that names the real verb ('Send', 'Buy', 'Delete for good'), previews the actual artifact, supports Amend with a reason, batches only safe actions, and shares one permission taxonomy across TypeScript, agent-core and Swift.
- One normalised Code protocol drives Alevr's engine, Claude Agent SDK, Codex app-server, ACP agents (Gemini CLI, OpenCode, Antigravity, Grok, DeepSeek), BYOK and OpenRouter. Broader than Codex or Claude Code, and on par with T3 Code but with a native agent engine as well.
- Checkpoints that capture shell-made edits through hidden git refs, undoable rollbacks, manifests for non-git folders and per-hunk reverse patches. Claude Code's checkpoints miss Bash edits.
- Role-routed teams (lead, workers, explorer, reviewer), Plan→Build→Verify and Best-of-N in worktrees with enforced budgets, and an Auto-mode reviewer that fails closed.
- Voice in Code whose spoken lines become send, steer or queue, plus automatic resume when a subscription limit resets.
- iPhone remote control of local Mac Code sessions (QR pairing, approvals, diffs, terminal, subagents). ChatGPT and Claude mobile only reach cloud runs.
- Targeted artifact edits that keep untouched text byte-identical, and a suggestion guard that never overwrites user edits with AI rewrites. Plus a full design editor (layers, effects, motion, interactions) with no ChatGPT or Claude equivalent.
- Semantic documents, workbooks and decks with a real formula engine, recalculation highlights that show what changed, and Office export that is re-opened and verified before download.
- Skills that can never widen permissions (requested ∩ granted), importable from GitHub, zip or markdown with versions and upstream update checks, and capturable from a successful run.
- Thorough routines: DST-correct clocks, missed-fire, unattended and host-offline policies, a plain-language arming summary, history of fires that didn't happen, and an API fire token.
- Truly native macOS and iOS apps (~589k Swift lines, 5,679 tests) with CI-enforced route parity and wire schema checks, an encrypted local-first store and a durable outbox. Competitors' desktop apps are reportedly Electron.
- A cross-platform design token pipeline with a CI drift gate, lint-enforced radius, z-index and type rules, a custom pixel-hinted icon family generated into SF Symbols, and a deterministic galaxy indicator rendered identically on web and Swift.
- History import from ChatGPT, Claude and Gemini (projects, memories, attachments) with real upload progress. A strong switching lever, comparable to Codex's import from Claude Code and Cursor.

## Ranked gaps

Impact runs from 5 (decides whether people pick the product) to 1 (polish). Effort is S, M, L or XL. The Plan column gives the build wave for each gap (see "Build plan").

| ID | Impact | Effort | Area | Gap | Outside dependency | Plan |
|---|---|---|---|---|---|---|
| G01 | 5 | S | mobile/native | Restore iOS push (aps-environment) and guard it in CI | Apple Developer account with the Push Notifications capability on the App ID, an APNs auth | Wave 1 |
| G02 | 5 | S | coding | First Code turn must honour the landing's model, effort, attachments and text-less prompts |  | Wave 1 |
| G03 | 5 | M | chat | Editing an earlier message should fork a branch, not delete the rest of the thread |  | Wave 1 |
| G04 | 5 | M | chat | Generate images when asked in chat or Auto, with 'Create image' in the + menu | Image model provider capacity and keys for the image models already in the catalogue. | Wave 2 |
| G05 | 5 | M | coding | Ship flow in the v2 workspace: commit, push, PR, CI checks and an auto-fix toggle | GitHub App installation with contents, pull_requests and checks permissions (already used  | Wave 2 |
| G06 | 5 | M | coding | Real attachments in the Code session composer: paste, drop and upload |  | Wave 1 |
| G07 | 5 | M | automation | Create recurring routines straight from chat ('every weekday at 8am…') |  | Wave 1 |
| G08 | 5 | L | integrations | First-party Gmail, Google Calendar/Drive, Outlook/M365 and Slack connectors and triggers | Google Cloud OAuth app with restricted-scope verification (Gmail) and a Pub/Sub topic; Mic | Wave 6 |
| G09 | 4 | S | coding | Fix the Mac-thread queue: remove, edit and steer-now act on the real queue |  | Wave 1 |
| G10 | 4 | S | chat | Select a passage in an answer to ask about it or quote it |  | Wave 1 |
| G11 | 4 | S | mobile | Bring incognito, Share, Continue-on and Session outputs to phones |  | Wave 4 |
| G12 | 4 | S | artifacts/canvas | Never lose canvas edits: autosave the draft and confirm before discarding |  | Wave 1 |
| G13 | 4 | S | agents | Finished-task actions on the card: Retry, Run again, Continue, Resume and Make a routine |  | Wave 1 |
| G14 | 4 | M | chat | Inline, expandable reasoning that also works on phones |  | Wave 1 |
| G15 | 4 | M | agents | Choose a permission mode for tasks from the chat composer |  | Wave 1 |
| G16 | 4 | M | coding | Wire @file mentions and the Files dock to the Mac's file system |  | Wave 2 |
| G17 | 4 | M | coding | Keep Mac-thread history readable offline and show link status |  | Wave 2 |
| G18 | 4 | M | chat | Pin the new user turn to the top while the answer grows below |  | Wave 2 |
| G19 | 4 | M | collaboration | Shared chats: Update link, continue in your own account, per-message share and phone access |  | Wave 3 |
| G20 | 4 | M | memory | Memory sources on answers, and an actionable 'Memory updated' |  | Wave 1 |
| G21 | 4 | M | desktop | Mac Quick Entry: a real global hotkey, answers inside the panel, window capture with text | macOS Screen Recording permission for window capture (user grant). | Wave 4 |
| G22 | 4 | M | mobile/native | iOS Share extension and macOS Services menu | App Group entitlement and provisioning profiles for the new extension targets. | Wave 4 |
| G23 | 4 | M | artifacts/canvas | Let React artifacts import charting and UI libraries | CSP allowance for the chosen CDN origin in the sandbox frame (or self-host the bundles). | Wave 3 |
| G24 | 4 | M | collaboration | Project sharing UI: invite members with viewer and editor roles | Transactional email deliverability for invites (existing provider). | Wave 3 |
| G25 | 4 | M | coding | Diff review that talks back: inline comments, context expansion, virtualization, real highlighting |  | Wave 2 |
| G26 | 4 | L | mobile/native | Allow several chats to generate at once in the native apps |  | Wave 4 |
| G27 | 4 | L | artifacts/canvas | Edit documents and decks directly, with selection-scoped AI edits |  | Wave 2 |
| G28 | 4 | L | agents | A live browser and computer view for every cloud task, with take over and hand back | Production-grade isolated browser/VM capacity (self-hosted Docker fleet hardening or a ven | Wave 6 |
| G29 | 4 | L | chat | Generative UI that drives the conversation: clickable visuals, savable widgets, entity and map cards | Map tile provider and a weather data source if not served via search. | Wave 2 |
| G30 | 4 | L | artifacts/canvas | Artifacts with persistent storage that can call the model, billed to each viewer |  | Wave 3 |
| G31 | 4 | XL | coding | Warm, persistent cloud environments for Code instead of a cold GitHub Actions job per turn | Container/VM compute vendor or self-managed cluster, egress proxy, secrets management, and | Wave 6 |
| G32 | 4 | XL | platform | Team and Business workspaces: orgs, seats, shared billing, SSO, SCIM and audit log | Stripe per-seat products, IdP test tenants (Okta/Entra/Google) for OIDC/SCIM, and legal te | Wave 5 |
| G33 | 3 | S | chat | Thumbs-down that listens: no celebration, and a reason picker |  | Wave 1 |
| G34 | 3 | S | chat | Starter prompts and capability chips on the home screen |  | Wave 1 |
| G35 | 3 | S | mobile | Return inserts a newline on touch keyboards |  | Wave 1 |
| G36 | 3 | S | chat | Show dictation on browsers without Web Speech |  | Wave 1 |
| G37 | 3 | S | research | Fix research export and add DOCX, copy, share and open-in-canvas |  | Wave 1 |
| G38 | 3 | S | coding | Client-side /model, /clear and /plan |  | Wave 1 |
| G39 | 3 | S | coding | Answer actions in Code: Retry, Copy, Feedback, Edit and resend |  | Wave 1 |
| G40 | 3 | S | coding | Session management in v2: rename sheet, pin, archive, delete, share and sidebar row menu |  | Wave 1 |
| G41 | 3 | S | settings | Make Code settings in global Settings actually work |  | Wave 1 |
| G42 | 3 | S | automation | Show routine and trigger health on web |  | Wave 1 |
| G43 | 3 | S | agents | Fix the task follower on re-runs, and stop polling idle conversations |  | Wave 1 |
| G44 | 3 | S | design | Remove 'Juno' from every user-visible surface |  | Wave 1 |
| G45 | 3 | S | motion | Tiered in-app Reduced motion, a 'Full' option, and Tailwind utilities on the motion tokens |  | Wave 1 |
| G46 | 3 | S | motion | Scope icon hover articulation back to destinations |  | Wave 1 |
| G47 | 3 | S | platform | Onboarding that activates: server-gated, use-case setup, an import nudge, a tour of modes |  | Wave 2 |
| G48 | 3 | S | pricing/limits | Simplify the seven consumer tiers | Stripe price and product changes; legal review of plan change notices. | Wave 5 |
| G49 | 3 | M | chat | Fuller incognito: attachments, save to history, a personalised option |  | Wave 2 |
| G50 | 3 | M | chat | Regenerate any answer and unify branching |  | Wave 1 |
| G51 | 3 | M | research | A research history index, and site restrictions |  | Wave 3 |
| G52 | 3 | M | files | One Library: content search, in-app viewers, type filters, stable paging, rendered thumbnails |  | Wave 3 |
| G53 | 3 | M | design | One working indicator everywhere: the galaxy, driven by real state |  | Wave 1 |
| G54 | 3 | M | mobile | Mobile web that feels native: safe areas, swipe, bottom sheets, 44px targets, compact headers |  | Wave 1 |
| G55 | 3 | M | design | Automated accessibility checks and prefers-contrast coverage on web |  | Wave 5 |
| G56 | 3 | M | motion | Symmetric motion: exits for docks, popovers and folds, plus View Transitions for list to detail |  | Wave 1 |
| G57 | 3 | M | coding | Working Preview from any device, plus annotate-to-edit |  | Wave 3 |
| G58 | 3 | M | coding | One composer from landing to session, painted on first load |  | Wave 1 |
| G59 | 3 | M | coding | Goal and live todo row above the composer |  | Wave 2 |
| G60 | 3 | M | coding | Cloud environments UI, keybinding cleanup and dead shortcuts |  | Wave 3 |
| G61 | 3 | M | coding | End-to-end tests for the Code flow |  | Wave 3 |
| G62 | 3 | M | mobile/native | Durable offline sends and real network awareness in native apps |  | Wave 4 |
| G63 | 3 | M | mobile/native | 'Continue on Mac/iPhone' that works without APNs |  | Wave 4 |
| G64 | 3 | M | mobile/native | Widgets and controls worth using: fixed small widget, Lock Screen, Control Center, recent and needs-you |  | Wave 1 |
| G65 | 3 | M | mobile/native | App Intents that answer inside Siri and Shortcuts, with conversation entities |  | Wave 4 |
| G66 | 3 | M | mobile/native | Live Activities for v2 Code approvals, push-to-start and in-place actions | APNs push-to-start (requires G01) and the Live Activities push type on the server. | Wave 4 |
| G67 | 3 | M | mobile/native | Run trace and task cards in the iPhone transcript |  | Wave 4 |
| G68 | 3 | M | platform | Passkeys, active sessions, linked sign-in methods and native Sign in with Apple | WebAuthn relying-party domain, apple-app-site-association webcredentials entry, and Apple  | Wave 5 |
| G69 | 3 | M | agents | Answer Work approvals and questions straight from notifications | APNs (G01) and VAPID web push already configured. | Wave 4 |
| G70 | 3 | M | agents | An Activity view across chats, tasks and Code: Running, Needs you, Ready, Blocked |  | Wave 2 |
| G71 | 3 | M | chat | Study mode with guided tutoring, quizzes and flashcards |  | Wave 3 |
| G72 | 3 | M | chat | Ask several models at once and see where they agree |  | Wave 3 |
| G73 | 3 | M | search | Inline image results and richer source cards in search answers | An image search API from the existing search provider, if not already returned. | Wave 3 |
| G75 | 3 | M | pricing/limits | Bring-your-own-key for Chat, with Priority and Fallback per model |  | Wave 3 |
| G74 | 3 | L | files | True semantic retrieval with pgvector, plus project sources synced from Drive, GitHub and Notion | pgvector extension on the production Postgres. | Wave 6 |
| G76 | 3 | L | artifacts/canvas | Spreadsheet and deck editors at full size, with presenter mode and PDF export |  | Wave 3 |
| G77 | 3 | L | coding | Repository understanding beyond TypeScript, a persistent index and diagnostics |  | Wave 3 |
| G78 | 3 | L | coding | User MCP servers and hooks for web, Mac env-server and cloud runs |  | Wave 3 |
| G79 | 3 | L | coding | In-app PR inbox and an @alevr review bot | GitHub App permissions for pull request reviews and issue comments. | Wave 6 |
| G80 | 3 | L | i18n | Server-rendered translations and RTL layout | Translation review for legal pages. | Wave 5 |
| G81 | 3 | L | automation | Teach by showing: record a workflow, get a skill | macOS Screen Recording and Accessibility permissions (user grant). | Wave 6 |
| G82 | 3 | L | integrations | Reach Alevr agents from email, Slack and Teams | Inbound email domain and MX/processing provider; Slack app and Microsoft Teams bot registr | Wave 6 |
| G83 | 3 | L | artifacts/canvas | Sites: custom domains, server storage and analytics for published artifacts | Edge hosting with TLS for custom domains (certificate automation). | Wave 6 |
| G84 | 3 | XL | desktop | A browser extension with a side chat and browser control | Chrome Web Store developer account and review. | Wave 6 |
| G85 | 3 | XL | integrations | Office and Google Workspace add-ins | Microsoft Partner Center/AppSource listing; Google Workspace Marketplace listing and OAuth | Wave 6 |
| G86 | 2 | S | design | One accent list and a presence token across web and native |  | Wave 1 |
| G87 | 2 | S | design | Ship Inter's Cyrillic and extended-Latin subsets |  | Wave 5 |
| G88 | 2 | S | coding | Keep Best-of-N winners, and undo cloud turns |  | Wave 3 |
| G89 | 2 | S | platform | Help, feedback, release notes and status in the account menu | A public status page provider or self-hosted status page. | Wave 5 |
| G90 | 2 | S | memory | Readable memory export and a ready-made import prompt |  | Wave 3 |
| G91 | 2 | S | settings | Personality characteristic dials |  | Wave 3 |
| G92 | 2 | S | mobile/native | Full-screen prompt editor on iPhone |  | Wave 1 |
| G93 | 2 | M | settings | Rebindable shortcuts and the missing ones |  | Wave 3 |
| G94 | 2 | M | projects | Per-chat export and bulk sidebar actions |  | Wave 3 |
| G95 | 2 | M | coding | Ghost-text next-prompt suggestions in Code |  | Wave 3 |
| G96 | 2 | M | mobile/native | iPad multi-window, and system-wide screen share in iOS voice | App Group entitlement for the broadcast extension. | Wave 4 |
| G97 | 2 | M | agents | Rooms, templates and roster actions you can find |  | Wave 3 |
| G98 | 2 | M | voice | Live camera in web voice mode |  | Wave 3 |

## Build plan

Each wave is built in isolated worktrees, attacked by an independent reviewer, merged, put through the full local gates, then pushed and deployed through GitHub Actions. After wave 6, a fresh competitor sweep and a judge panel score Alevr surface by surface. Anything still behind goes into another wave.

- **Wave 1: correctness and craft. Chat branching, answer selection bar, inline reasoning, the Code composer and session management, routines from chat, the motion system, home and mobile web, canvas autosave, the iOS approval fix and push, permission modes, memory sources, Mac Code billing.** (G01, G02, G03, G06, G07, G09, G10, G12, G13, G14, G15, G20, G33, G34, G35, G36, G37, G38, G39, G40, G41, G42, G43, G44, G45, G46, G50, G53, G54, G56, G58, G64, G86, G92)
- **Wave 2: core experience. Pinned user turn, image generation, the Code ship flow, Mac files and offline history, diff review, goal row, Activity view, generative UI, direct document editing, onboarding, fuller incognito.** (G04, G05, G16, G17, G18, G25, G27, G29, G47, G49, G59, G70)
- **Wave 3: depth. Sharing, artifacts with storage, Library, preview and annotate, study mode, multi-model answers, bring-your-own-key, repository understanding, user MCP and hooks, full-size editors, shortcuts and exports.** (G19, G23, G24, G30, G51, G52, G57, G60, G61, G71, G72, G73, G75, G76, G77, G78, G88, G90, G91, G93, G94, G95, G97, G98)
- **Wave 4: native apps. Concurrent generation, offline sends, widgets, Live Activities, App Intents, Quick Entry, Share extension, notification approvals, iPad multi-window, native parity and localization.** (G11, G21, G22, G26, G62, G63, G65, G66, G67, G69, G96)
- **Wave 5: platform and trust. Passkeys and sessions, Team workspaces, pricing tiers, RTL and translations, accessibility automation, observability, offline shell, sign-up limits, settings, built-in document skills, Work voice and undo.** (G32, G48, G55, G68, G80, G87, G89)
- **Wave 6: outside accounts. Google and Microsoft connectors, live cloud browser, warm cloud environments, semantic retrieval, PR review bot, email and Slack agents, Sites domains, browser extension, Office add-ins. Built up to each boundary, then switched on once the owner provides the account.** (G08, G28, G31, G74, G79, G81, G82, G83, G84, G85)

## Design and motion direction

Direction: 'Editorial calm, honest motion.' Keep what already beats the incumbents (Newsreader serif display, dot-matrix rules, graphite neutrals, presence blue, mono annotations, frame-paced streaming) and extend it to the surfaces that still use generic card chrome: Library home, /artifacts (to be merged into Library), canvas chrome, Trash, lifecycle dialogs, the Remote settings section and Code v2 empty states.

1) Tokens. Add one global --presence/--presence-ink pair (generated to Swift and TS) replacing the four scoped variables and 12+ literals. Add ultramarine to the generator and to JunoAccent. Point Tailwind duration and easing utilities at var(--dur-*)/var(--ease-*) so reduced motion actually reaches them. Delete the stale 'warm' comments and the dead svg.icon[data-motion] CSS so future tuning targets the real values.

2) One status vocabulary everywhere. Running / Needs you / Ready / Blocked, in the priority order ChatGPT's pets use, drives the sidebar Needs-you fold, a new Activity popover, the Mac menu bar and Dock badge, iOS Live Activities and widgets, and Code sidebar rows. Coral (Code) and presence (Chat/Work) remain the only 'needs you' and 'live' signals. One working mark, the galaxy, appears wherever work is real: it replaces RunGlyph in the Activity panel and research card and the 17 native shimmer lines. Spinners stay only inside buttons. Follow T3 Code's rule of no perpetual repaint without real state, and add the web's eased stop and 60% finished dim to the Swift galaxy.

3) Conversation layout. Anchor the new user turn at the top and let the answer grow below (ChatGPT/Claude), with a 'Jump to latest · N new' pill when the reader scrolls up, in both Chat and Code v2. Reasoning expands inline under the live line using the 0fr→1fr grid-template-rows pattern plus opacity, with interpolate-size only when motion is allowed, and opens as a bottom sheet on phones instead of replacing the chat. Selection on any answer raises a small Ask / Quote / Explain bar using the same highlight API as streaming.

4) Motion symmetry. Every surface that animates in should animate out. Code dock, popovers, palette and toasts get --dur-exit ease-in exits (~0.65× the entrance). Folds stay mounted so they collapse as smoothly as they open. Composer height animates when the approval panel replaces the textarea. The task card's live-to-finished swap animates height instead of collapsing under mode='wait'. Use View Transitions for chat list to thread, tile to canvas (docked to fullscreen and back with scroll restore, as Claude does) and the Orbit portrait to the agent header (transitionName is already wired), with a crossfade fallback under reduced motion. Keep micro-interactions on the 70/120/160/220/360 ladder, and hold editorial entrances (700–900ms) to first visits so settings and utility pages settle in under 300ms.

5) Restraint. Scope icon hover articulation to destinations and drop it from menus, lists and message actions. Make celebration (Swell/Burst) positive-only: thumbs-down opens a calm reason picker instead. Rebuild the in-app 'Reduced' setting on the same tiers as the OS path (keep fades and state colour, remove travel and loops) and add 'Full'. Calm the home dot field once starter chips appear, so content rather than decoration owns the empty state.

6) Mobile-first craft. Set viewportFit 'cover' so the safe-area paddings take effect. Dialogs become bottom sheets under 640px with velocity dismissal (extract the Code v2 sheet that already rubber-bands). Add an edge-swipe sidebar following the finger like ChatGPT's gesture-progress drawer. Use 44px coarse targets and newline-on-Return for touch. Compact the editorial page headers on phones so the first item sits above the fold. On native, add widgets and Live Activities that move: progress, elapsed time and counts, and visible staleness after 15 minutes as T3 does.

7) Answers as interfaces, on brand. Grow the live-ui and chart blocks into a small, typed component library (comparison, map, entity card, quiz/flashcard, recipe step mode) drawn with the system's hairlines, radius ladder and presence accents, so generated UI still looks like Alevr (ChatGPT's Intelligent UI principle). Clicks inside visuals send follow-ups (Claude), every visual can be saved as an artifact, and a 'Layout and visuals' preference turns them down.

8) Accessibility and global reach as design requirements. Run axe sweeps over the /dev galleries in CI, extend prefers-contrast: more to every tone-step boundary, use roving tabindex in tablists and radiogroups, add Cyrillic, Vietnamese and extended-Latin Inter subsets, and migrate to logical CSS properties so RTL locales can ship. Visual QA screenshots must come from production builds and be checked against their route (the current 'search' captures show Projects).

## Critic review of this audit

An independent critic checked the gap list for misjudged ratings and missed defects. Its corrections are part of the build plan.

- **[Misjudged] G63's premise is probably wrong.** I'm working from what I know of Apple's rules and haven't checked the Mac build. G63 accepts the code comment that Developer ID Mac builds are refused push (JunoDesktopApp.swift:167-173) and builds a long-poll workaround around it. As far as I know, Developer ID apps can use APNs if they embed a Developer ID provisioning profile that includes aps-environment. If that holds, the same entitlement-and-profile fix as G01 restores server pushes on the Mac, including when the app is closed, not just handoff. Check this before building G63.
- **[Misjudged] G64 hides a real defect inside an M-sized item.** The small iOS widget uses four Links, but WidgetKit only honours one in systemSmall. Its tiles need about 200pt and get clipped. The description also says "a Alevr" (JunoMobileWidgets.swift:26-37, 52, 86-94). This should be its own S-sized fix.
- **[Misjudged] G40 and G41 are rated too low.** The audit marks both high severity: v2 sessions can't be archived, deleted, pinned or shared, and three Settings sections are permanent dead ends. The gap list gives both impact 3.
- **[Misjudged] G06's HEIC plan won't work as written, and Chat has the same gap.** "Convert HEIC in the browser" fails in Chromium unless you add a wasm decoder or convert on the server; uploads.ts:216 says HEIC only displays in Safari. The Chat composer also lacks HEIC (audit: "HEIC is not in IMAGE_MIME"), which matters for iPhone photo uploads on mobile web. G06 only covers Code.
- **[Missed defect] Mac Code turns aren't counted against the plan.** The native audit lists /api/agent/usage as a gap ("Code turns are not counted against the plan"). That's lost revenue and inconsistent billing, and no G item covers it.
- **[Missed defect] There's no production observability or offline shell.** package.json has no Sentry or OpenTelemetry (checked). Metrics live in an in-memory ring buffer, and public/sw.js only handles install, activate, push and notificationclick (checked), so there's no offline PWA shell. Platform e2e tests cover auth only. G89 adds a status page but nothing behind it.
- **[Missed defect] The Code v2 web draft is never saved, and model and mode stay in one browser.** Audit, cross-device continuity row: web v2 keeps prefs in localStorage and doesn't persist the draft at all. Chat syncs drafts across devices, and the native app syncs ThreadSyncPrefs.
- **[Missed defect] Code v2 UX problems the list doesn't mention.**
  - The Connections sheet opens by itself on a new user's first Mac session, just as their prompt sends (live-route.tsx:476, workspace.tsx:209-213).
  - Two toast systems appear on one screen: sonner and cv2-toast.
  - The Agents dock opens on its own whenever a new subagent appears, interrupting whatever was in the panel.
  - The ⌘K palette doesn't search message content, unlike Codex, T3 and Cursor.
  - The target picker can't create or clone a project onto the Mac, which T3 does while you type the first prompt.
  - FileLink is a role=link span nested inside button rows, which is invalid markup (thread.tsx).
- **[Missed defect] One stray Escape denies an approval in Code.** Esc maps to Deny and Esc Esc stops the run. Cursor protects approval prompts from an accidental Escape.
- **[Missed defect, security] The iOS approval deep link approves without Face ID.** com.liammagnier.juno://juno/code/approval?...&approved=true sends the decision immediately (JunoMobileIntents.swift:140-149, RootView:821-831), while the notification path asks for Face ID. Fix this before G66 and G69 add more in-place approvals.
- **[Missed defect] Native parity gaps beyond what G-items cover.**
  - The Auto routing receipt and Auto/data-boundary preferences are missing on both apps (capabilities.ts auto_routing: native planned). That's the product's headline advantage.
  - There's no pre-flight clarification card on native (/api/chat/clarify is Planned).
  - Native cloud Code has no steer, PR, checks, auto-fix, rollback or base-branch picker, and its composer is text-only (NativeCodeTaskStore.swift, JunoMobileCodeView.swift). G05 is web-only.
  - iOS has no artifact page, can't write skills, and its routine editor allows a single schedule.
  - Both apps lack connector credentials, the knowledge inspector, artifact proposals (Compare/Apply), and Orbit rooms, goals, setup cards and undo. G97 is web-only.
- **[Missed defect] Native localization covers only English and about 63% of French.** Localizable.xcstrings has 614 keys, 388 of them in French, and many views use literal strings outside the catalog. G80 covers the web only.
- **[Missed defect] Performance risks.** iOS transcript performance at 1,000 messages has never been measured, and the server sends the full payload (chat_transcript_virtualization). The chat payload also carries up to 50 full version bodies per artifact (ARTIFACT_VERSION_WINDOW).
- **[Missed defect] Native config drift, the same kind that dropped aps-environment.** project.yml and the pbxproj target iOS 18 while the xcconfigs and Package.swift require 26. build_log.txt and build_pid.txt are committed. G01's CI check should also verify the deployment target.
- **[Missed defect] The status docs are wrong in both directions, and the gap list relies on them.** PARITY_MATRIX.md and capabilities.ts say native lacks search, StoreKit and semantic artifacts, which all exist. They also label Drive/M365, SSO OIDC and DLP "stable" when those are dead or unused. G08 cites capabilities.ts. A CI check that every registry evidence path is actually imported would stop this.
- **[Missed defect] The Electron desktop client is outside the brand and token work.** 74 files in native/desktop-electron/src still contain "Juno" (checked). It also uses the Archivo font and its own Tailwind config, and the token generator doesn't cover it. G44 and G86 ignore it, so it needs a decision: retire it or bring it into the pipeline.
- **[Missed defect] Sign-up limits would block a launch.** register/route.ts:25-26 caps sign-ups at 5 per IP per hour and 200 per hour globally (checked). A per-IP limit plus a challenge such as Turnstile is safer than a global cap.
- **[Missed defect] The 100 MB import cap weakens the history-import advantage.** It's set in api/import/route.ts:34 and import-history.tsx:14 (checked). Large ChatGPT exports go over it, while Gemini accepts 5 GB ZIPs.
- **[Missed defect] There are two "add an MCP server" flows that save to different tables.** The header Add button opens AddMcpServerDialog and the tile opens AddCustomConnectorDialog. They should be merged.
- **[Missed defect] Settings structure and controls.**
  - There are 20 sections. General holds little more than language, Capabilities sits under Coding, and Devices, Remote and /permissions overlap.
  - On phones the rail becomes a strip of about 20 tabs with no search, and search only filters sections, not rows.
  - The budget-alert and digest switches appear twice.
  - Remote uses window.confirm and shows unlocalized dates.
  - There are no per-tool capability switches (code execution, network egress, image generation, AI artifacts), which ChatGPT and Claude both have.
- **[Missed] The skills ecosystem.** There are no built-in docx/xlsx/pptx/pdf skills. The marketplace is 3 hardcoded repos, and skills can't be shared or published. G32 only covers org skills. Claude ships built-ins and lets you share or publish to an org, Perplexity has a Skills Marketplace, and Gemini drafts skills from your chats.
- **[Missed] Work.**
  - About 1,100 lines of voice briefing and voice task control were orphaned (components/work/voice/*). ChatGPT starts, checks and steers Work tasks by voice.
  - The Orbit goal task board API has no UI client at all (api/agents/[id]/board).
  - UndoJournal has no user-facing Undo.
  - Chat tasks show no cost or clarifying card before they start (preflight-card.tsx orphaned), and the plan is collapsed while the task runs (planOpen=false). Gemini shows completed, current and planned steps, and Perplexity states the credit cost before running.
  - There are two separate approval card implementations.
  - The credential broker that G28 relies on is experimental and has never been tested end to end.
- **[Missed] Artifact lifecycle.**
  - /a/{id} is read-only for every type except design, so an artifact whose chat was deleted can't be edited.
  - Compare is two raw `<pre>` blocks cut off at 20k characters, with no diff.
  - History shows raw origin strings, there's no Rename, and json() is parsed before checking res.ok, which leaks parser errors (artifact-lifecycle-actions.tsx).
  - Viewers of a published artifact can't remix or copy it, which Claude allows.
- **[Missed] The canvas code editor is a textarea over highlight.js.** It has no find/replace, autocomplete, multi-cursor or folding. The history rail is a fixed 192px wide, and closing history reloads the sandbox and loses the console. Consider CodeMirror.
- **[Missed accessibility/motion defects]**
  - Memory rows (.mem-reveal) start at opacity 0 and stay invisible if the IntersectionObserver never fires, for example in print or some webviews.
  - The Deep Field map is mouse-only (role=img, labels tabIndex=-1). G55 only fixes the tablist.
  - Research headers always show dollar cost with no setting to hide it.
- **[Missed design issue] The headline advantages are hidden behind hover.** The Auto receipt and the per-turn token and USD receipt only show on hover, or in the More menu on phones. Claude keeps model and effort visible in the composer chip, and Perplexity names the model before you send. Show a quiet persistent "Auto · Model" label.
- **[Missed design details]**
  - Skeletons don't announce loading (no aria-busy or screen-reader text).
  - forced-colors is handled in only one to three places.
  - Tooltips and metadata use 10.5–11px type.
  - Page titles are serif on Projects and Library but sans on Settings.
  - On Code home, the helper line sits over the dot orbit.
  - In the empty sidebar, "Your recent chats…" sits under the Orbit header with no Recent label.
  - iOS uses the stock ContentUnavailableView, and the native empty panel still draws the dashed well the web retired.
- **[Missed motion details]**
  - Every Code work-log row fades in at once when a thread loads (cv2-row-in), with no stagger and no way to skip it.
  - The incognito switch animates margin, radius and shadow on the whole column, which reflows the layout.
  - Orbit lineup items carry two competing animations with fill-mode both.
  - Switching settings sections stacks entrances to about 950ms. The design direction mentions this but no G item fixes it.
  - Plans animates font-size, which forces layout.
  - juno-icons/icons.css hard-codes durations and its own curves; G45 only fixes Tailwind.
  - A gradient sweep the spec bans still runs in artifact-inline-card.tsx:563.
  - PageTransition skips entirely under reduced motion instead of falling back to a crossfade.
- **[Missed competitor feature] Side chat (/btw).** Codex has /side (⌘⌥S), Claude Code has /btw (⌘;), Cursor has /side and Perplexity has /side during Computer tasks. Each lets you ask about the thread without adding to it or interrupting a running task. I found no side-chat code in src.
- **[Missed competitor feature] IDE extensions and headless/CI use.** Codex runs in VS Code, Cursor and Windsurf; Claude Code runs in VS Code and JetBrains with diffs and the shared selection. For scripting and CI there's codex exec, claude -p, the Agent SDK and openai/codex-action. Alevr has only an API fire token.
- **[Missed competitor feature] Moving a thread between local and cloud, and hosts other than the Mac.** Codex can move a chat between hosts, Claude Code has --teleport, and Cursor hands off between local and cloud in one click. Codex, Claude Desktop and T3 support SSH and WSL hosts; Alevr's env-server only runs on the Mac. G31 unifies the protocol but doesn't plan handoff.
- **[Missed competitor feature] GitHub, Linear and webhook triggers for routines.** ChatGPT triggers on GitHub PR activity, Claude routines can be GitHub-triggered, Cursor Automations cover GitHub, Linear and webhooks, and T3 supports webhooks with templates. G08 covers mail, calendar and Slack only, and G79 only covers @alevr comments.
- **[Missed competitor feature] Live co-editing with presence and attribution.** Claude Docs, ChatGPT Pages and Office in Copilot all have it. G27 is single-user.
- **[Missed competitor feature] iOS system-app actions through preview cards.** Claude on iOS drafts in Messages and Mail, creates Calendar events and Reminders, and shows Maps suggestions.
- **[Missed competitor feature] Mac voice and dictation access.** Gemini and Perplexity let you hold fn to dictate into any app. The Mac app has no shortcut for voice or dictation (JunoShortcutRegistry.swift has none). G21 doesn't cover either.
- **[Missed competitor feature] Floating desktop surfaces.** ChatGPT has a pop-out chat with Always on top, and pets that float over other apps showing each chat's status. G70 only covers the menu bar.
- **[Missed competitor feature] Deeper theming.** ChatGPT desktop offers accent, background and foreground hex colours, a contrast slider, UI and code fonts, and themes you can import or share. T3 imports VS Code themes. G86 only fixes the accent list.
- **[Missed competitor feature] A dedicated security-review agent.** Codex Security, Claude /security-review and Cursor Security Review all offer one. G79 is general PR review.
- **[Missed competitor feature] Paste hygiene.** Claude Code and T3 strip invisible Unicode from pastes and prompt links, and warn when they do. I found no such handling in composer.tsx. ChatGPT also keeps the structure of rich pastes, such as headings and links from Google Docs.
- **[Missed, smaller polish]**
  - Perplexity pauses tasks when credits run out and resumes them automatically. Alevr's resume-at-reset covers Mac Code only.
  - ChatGPT lets you long-press Send to pick a model for one message.
  - Claude Code posts a recap of what happened while you were away.
  - T3 can snooze a thread until the limit resets, has a streamer mode that hides personal details, and shows time to first token and tokens per second.
  - Codex shows profile streaks and share cards, and Claude has a monthly Reflect recap.
  - T3 lets outside agents drive threads through an MCP endpoint.
- **[Missed, scope decision needed] Life verticals.** No G item covers ChatGPT Health or Claude's iOS Health charts, Perplexity Finance and Shopping, or ChatGPT reservations and checkout. G29 only adds map, weather and recipe cards. This may be deliberate, but it should be decided explicitly.

## Competitors

### ChatGPT (OpenAI): Chat, Work, and Codex on web, macOS, Windows, Linux (preview), iOS, and Android

As of 2026-10-15. 45 features catalogued.

**Standout details**

- Pastes over 10,000 characters turn into an attachment chip with 'Show in text field' to undo, which keeps the composer and context window clean
- Long-pressing send picks a model for one message without changing the default (iOS and Android)
- Holding + on iOS opens recent photos, last-second autocorrect is applied before sending, and image previews appear immediately
- Cmd+A selects only the conversation, not the surrounding interface
- Memory Sources let you mark a memory 'not relevant' or delete it right from the answer, and 'Don't mention this again' is separate from deleting
- Temporary chats can still be personalized and can later be saved to history
- Desktop shortcut settings can be searched by pressing a key combination, and every shortcut can be rebound
- Approval prompts answer to Enter and Esc, and 'Allow low-risk actions' builds trust gradually
- Follow-up behavior setting: steer the current run or queue for the next one
- Appshots: press both Command keys to send the front window, including its off-screen text, to a chat chosen by a 60-second rule
- Floating pets show agent status (Needs input, Blocked, Ready, Running) while you work in other apps, and respect reduced motion
- Snake game and animated dots while images generate
- Flashcards with swipe physics: tap to flip, mark ✔️ or ❌, shuffle
- Restaurant times with a Reserve button inline, and audio pronunciation with a phonetic breakdown in over 60 languages
- Table of contents for conversations longer than five responses
- Composer predictions in Codex: press Tab to accept, and they never auto-send
- Sites: 'Edit site' from the live page, and changing the URL keeps old routes and query parameters working through redirects
- Shared scheduled tasks copy into the recipient's own account with their own app connections
- Voice keeps going on the Lock Screen and in the Dynamic Island, works in CarPlay, and finishes unfinished Work tasks in text after the call
- Deep research can be restricted to specific sites and downloads as Markdown, Word or PDF

**Design patterns**

- **Centered empty state with a pill composer.** The new-chat screen shows one headline, 'Where should we begin?' (24px/28px), above a centered pill composer. On logged-out web the composer reads 'Ask ChatGPT' with + ('Add files and more') on the left and dictation and a round send button on the right. Measured on live chatgpt.com: max width 768px, 52px tall for one line, 28px corner radius, padding 7px 10px. In dark mode the fill is oklch(0.248 0 0) with a 1px inset hairline at rgba(255,255,255,0.2). Logged-out mobile web also centers the composer so popups can't block it.
- **Model choice lives in the composer.** On web, model and thinking level are chosen inside the composer as a 'Faster ↔ Smarter' slider (Instant, Medium, High, Extra High, Pro). Mobile puts the picker at the top of the conversation. Work's composer shows compact chips such as '6 Sol' and 'Medium' next to the mic. A reviewer liked the slider but said six options are too many.
- **Dense, collapsible sidebar with pins and grouping.** The sidebar is 260px wide and collapses to a 52px icon rail (seen in the CSS keyframes). Nav items include New chat, Search, Images, Plugins, Deep research, Library or Space, Scheduled, Projects, Pinned and Recents. Recents can be one list or grouped by project. On mobile the sidebar swipes in at min(76vw, 360px), and experiences sit in a horizontal bar above chats. Desktop combines Chat and Work Recents with filter and sort.
- **System font, pure-black dark mode, pill controls.** Live web uses the system font stack (-apple-system-body, ui-sans-serif, system-ui, Segoe UI, Helvetica), 16px/24px body text and 17px composer text. The dark-mode canvas is pure black (#000), with raised surfaces around oklch 0.25. Segmented controls and selects are full pills (999px radius); text fields use 0.75rem radius. CSS is atomic and hashed (StyleX-like), with Lightning CSS producing light and dark color pairs.
- **A component library the model composes (Intelligent UI).** Answers are assembled from native, streamable components (comparisons, maps, diagrams, forms, calculators) on a shared design base, so generated UI still feels like ChatGPT. The model decides layout and when plain text is enough. Users can reduce visuals with 'Layout and visuals'.
- **Agent task view: status line, file chips, artifact panel.** A Work thread shows the prompt, then a collapsible elapsed-time line ('Worked for 2m 30s ›'), then file chips labeled with type and app (e.g. 'Spreadsheet · XLS', Excel). A preview panel beside the chat has tabs, a page counter (1/8), zoom (100%), sheet tabs and an 'Open' button. Deliverables are framed as drafts to review.
- **Approval cards with tiered trust.** Before an action, an inline card names the app, the account and the proposed action, with Deny, Allow once, Allow low-risk actions and Always allow. On desktop, Enter approves and Esc declines. Mobile Codex approvals add 'Always approve' and 'Tell Codex what to do'. Voice approvals require a tap on screen.
- **Progress row above the composer for long goals.** A pinned row above the composer shows the goal title, elapsed time (e.g. 10h 9m), an 'Auto-review' label and the model and effort. It has pause, resume, edit and clear controls. Side chat lets you ask for a status recap without interrupting the run.
- **Provenance under every answer.** Citations show a hover preview, a Sources panel lists them, a book-style Sources icon shows which memories and chats were used (with 'not relevant' and delete actions), entity highlights open fact side panels, and deep research reports carry a table of contents, a sources-used list and an activity history.
- **Work beside the conversation.** Files from Drive, Box, Dropbox and SharePoint, generated documents, browser tabs and Sites previews open in a side pane next to the chat. The desktop browser has split and full views. Writing blocks open full-screen. Plugin extensions can open full-screen from the sidebar.
- **Status by priority (pets and Activity view).** Background chats are summarized as one of four states: Running, Needs input, Ready (unread result) or Blocked. When several apply, the most urgent wins: Needs input > Blocked > Ready > Running. The state shows on a floating pet over other apps and in the bell Activity view, which filters by Work, Chat, Pinned or Scheduled.
- **Personable agent identity.** A dot gets a customizable avatar (shape, color, eyes, glasses, accessories) and an @handle, reachable in ChatGPT, Slack and Teams. Its messages read like a colleague's: 'I've prepared the changes. Want to review them?'
- **Deep desktop theming.** Desktop exposes theme hex colors (accent, background, foreground), UI and code fonts, a translucent sidebar, a contrast slider (examples at 45 light and 60 dark), pointer-cursor and font-size settings, importable and shareable themes (presets such as Codex, Catppuccin, Dracula), and an 'Always on top' popped-out chat.
- **Creation tools that ask follow-up questions.** Image Templates and Sketch guide creation with follow-up questions shown as option chips. The image editor toolbar has Select, Aspect ratio, Undo, Redo, Cancel and Save, and mobile adds Resize and Remove. Study mode is entered with an '@study' token chip removed by Backspace.

**Motion patterns**

- **Accent-tinted word entry while streaming.** Live CSS defines --stream-accent-color, --stream-entry-opacity and --stream-word-accent-percent. Newly streamed words go from opacity 0 (or a set entry opacity) to full, tinted with an accent color until about 55% of the animation, then settle to the normal text color. A mask-position sweep reveals text, and the top border of a block flashes the accent color while it streams in.
- **Interface that renders as it is generated.** The Intelligent UI compiler renders components as the model emits them, so interactive content appears piece by piece instead of all at the end (web since Aug 2026). GPT-6 adds partial answers while it keeps thinking.
- **Shimmer sweeps on status text.** Several keyframes animate background-position (-100% to 100%, -200%, -180%, -250%) and mask-position (140% to -105%), the usual gradient shimmer on 'thinking' and 'searching' labels and skeletons. Live voice also speaks short varied phrases while it searches.
- **Breathing pulse and ripple.** A pulse scales 0.82 to 1 and back with opacity 0.68 to 1 (a breathing indicator). A ripple uses --d-pulse-opacity and --d-pulse-scale to expand and fade over 90%. A spinner rotates one full turn (indicator default 0.8s). A caret blinks with opacity off between 45% and 55%.
- **Animating to auto height for collapsibles.** Sections expand and collapse by animating grid-template-rows between 0fr and 1fr together with opacity; the collapse fades out over the first 40% before shrinking. The page sets 'interpolate-size: allow-keywords' only when motion is allowed. This is likely what animates the 'Worked for' and reasoning disclosures.
- **Sidebar and layout transitions.** The sidebar collapse animates grid-template-columns from 260px to 52px while translating by -208px. On mobile the sidebar follows the finger (a gesture-progress variable) with opacity and translate. Bottom sheets fade their backdrop with cubic-bezier(0.2, 0.8, 0.2, 1), and some layout movement follows the on-screen keyboard height.
- **Small entry and exit animations.** Menus and popovers fade and scale from 0.95 to 1. Content enters by fading up 0.625rem (10px) or 8px from opacity 0.12. Toasts rise 0.25rem by 30% of the animation, hold until 85%, then fade. Crossfades use 0 to 1 and 0.55 to 1 opacity ramps.
- **Flashcard physics.** Flashcards are thrown off-screen with translateX(±120%) plus rotation, rejected cards come back with a 6° tilt, and the stack below settles from translateY(12px), rotate(-1.25deg), scaleX(0.96) as the top card is released. Shadow depth follows drag progress.
- **Timing and easing.** Most micro-interactions take 150ms, with others at 100–250ms, 220ms and 300ms; ambient loops run 1.2–2s. Easings are mostly expo-out, cubic-bezier(0.16,1,0.3,1) and (0.19,1,0.22,1), plus cubic-bezier(0.2,0,0,1), standard (0.4,0,0.2,1), and a spring-like CSS linear() curve. Page navigations use CSS View Transitions (@view-transition navigation: auto) only when the user allows motion.
- **Reduced motion handled throughout.** The web CSS has 117 prefers-reduced-motion blocks that turn off animations and transforms and switch smooth scrolling to instant. Desktop pets show a still frame under reduced motion, and generated visualizations aim to respect it.
- **Voice: simultaneous speech and text.** Live speaks and streams text at the same time and lets you interrupt. Widgets and images appear mid-call. A waveform is likely, given keyframes with about 23 steps of bar values. On iOS the call continues in Live Activities and the Dynamic Island.
- **Making waits enjoyable.** Image generation shows animated dots and, for some users, a playable Snake game, and you can keep chatting meanwhile. Agent tasks show a running elapsed timer. Pets animate their status. iOS stopped replaying the streaming effect on answers that already finished.

**Weaknesses**

- Product is fragmented and models are confusingly named: Chat, Work, Codex, Space, Library, Projects, Pages and Sites overlap; models include GPT-6 Sol, Luna and Astra, GPT-6.1 Sol, and GPT-5.6 Sol, Terra and Luna, with different models in Chat versus Work and Codex
- The July 2026 desktop launch drew criticism: Chat was buried under Work, the switcher had no way back to plain chat, the rollout was confusing (old app updated instead of replaced), settings are packed with toggles, and the app is reportedly Electron. OpenAI walked part of it back within days
- Canvas was removed from current models; users say writing blocks scroll away with the chat, can't be renamed or kept as documents, and can't export directly to .md, .docx or .pdf
- Group chats were retired (none can be created after July 9, 2026), Pulse was sunset, and the Atlas browser shut down Aug 9, 2026
- Custom GPTs are being retired (Enterprise date Dec 11, 2026) and migrated to plugins, which disrupts existing workflows
- Live voice can't do video or screen sharing (you must switch back to Advanced), personalities don't apply in Live, there is no precise playback-speed control, it isn't tuned for several speakers, and approvals can't be spoken
- Intelligent UI can't be turned fully off; 'Layout and visuals' only reduces visuals. Early anecdotal complaints call it cluttered and patronizing
- Free and Go show ads, including Go at $8/month; users call this a broken promise
- Users report rate limits hit unexpectedly on Plus, and Work and Codex usage draws on an opaque shared credit pool
- Feature gaps differ by platform: Space pages can't be edited on mobile, older desktop apps lack Intelligent UI, the desktop app can't create event triggers, Sites isn't on Free or Go, and many features exclude the EEA, UK or Switzerland
- Shared links have no expiration or per-recipient access, and personal-account links are static snapshots
- Scheduled tasks don't support voice or GPTs; Work is unavailable in project-only-memory projects; study mode isn't available in Projects, GPTs or temporary chats
- Automatic switching to Thinking was removed for Plus and Pro, so users must pick the effort level manually
- App Store reviews mention slower responses, crashes, and a read-aloud or dictation button that was removed
- A user-reported bug on Windows: the Chat/Work toggle was missing and the app opened only in Work, blocking chat once the Work quota ran out

**Not verified**

- The 'Thought for N seconds' label and the exact look of the reasoning disclosure in Chat in 2026 (only Work's 'Worked for 2m 30s' is documented)
- The look of the Live voice screen (orb or waveform); waveform keyframes exist in the CSS but which component they animate is inferred
- Which UI element each live-CSS keyframe drives (streaming words, shimmer, pulse, flashcards and so on) is inferred from property names in the logged-out web bundle and may differ from the signed-in app
- Web-app keyboard shortcuts beyond Cmd/Ctrl+K search (Cmd+Shift+O new chat, Cmd+Shift+S sidebar, Cmd+Shift+C copy last response, Cmd+Shift+; copy code block, Shift+Esc focus composer, Cmd+Shift+Backspace delete chat) come only from third-party guides; only the desktop-app list is primary
- iOS Lock Screen widgets, Action Button, Siri and Shortcuts actions are described only by third-party sources for 2026
- Whether Read Aloud is still available in 2026 (an App Store review says a read-aloud or dictation button was removed)
- Press reports say the ChatGPT interface uses OpenAI Sans; the live logged-out web CSS shows a system font stack
- The date new custom GPT creation ends is inconsistent across sources (Sep 25 vs Oct 26, 2026); the Dec 11, 2026 retirement is consistent
- The Spyglass claim that the desktop app is built on Electron
- Which plan column the pricing page's context-window figures (27K/54K/128K Instant; 256K/400K reasoning) map to was read from page text without the price cells rendered
- The current availability of the legacy 'record mode': the pricing page still lists it, while the Meetings plugin is the new macOS beta
- Medium commentary on why Canvas was removed (keeping one consistent experience across surfaces)

**Features**

- **Three experiences: Chat, Work, and Codex** (chat). ChatGPT is now split into Chat (quick conversational help), Work (an agent that runs longer multi-step tasks and produces finished deliverables) and Codex (software development). Chat and Work share one history. ([source](https://help.openai.com/en/articles/20001275-chatgpt-work-and-codex))
- **GPT-6 model picker with a Thinking slider** (chat). You pick how much ChatGPT thinks on one slider: Instant, Medium, High, Extra High, Pro. ([source](https://help.openai.com/en/articles/20001354-gpt-6-and-other-models-in-chatgpt))
- **Intelligent UI** (chat). GPT-6 answers can mix text, visuals and interactive elements: side-by-side comparisons, maps, interactive diagrams, forms, tappable buttons, charts, calculators, bill splitters and small games. ([source](https://openai.com/index/gpt-6-for-everyone/))
- **Answering while still thinking** (chat). GPT-6 can start answering while it keeps thinking or using tools, then adds findings without another prompt. ([source](https://openai.com/index/gpt-6-for-everyone/))
- **Plans, limits and context windows** (pricing/limits). Plans are Free, Go, Plus, Pro (three tiers), Business, Enterprise and Edu. Free and Go have unlimited everyday text chats, subject to abuse guardrails. ([source](https://chatgpt.com/pricing/))
- **Pick a model for one message** (chat). Long-press the send button to choose a model for a single message without changing your default. ([source](https://help.openai.com/en/articles/6825453-chatgpt-release-notes))
- **Branching and editing messages** (chat). Start a new conversation from any message, or edit an earlier prompt, including prompts that have attachments. ([source](https://help.openai.com/en/articles/6825453-chatgpt-release-notes))
- **Interrupt and steer long-running answers** (chat). Add new information while deep research, a Pro answer or a Work task is still running, without restarting or losing progress. ([source](https://help.openai.com/en/articles/6825453-chatgpt-release-notes))
- **Composer conveniences** (chat). Small behaviors that keep the input box clean and quick to use. ([source](https://help.openai.com/en/articles/6825453-chatgpt-release-notes))
- **Visual and interactive answer elements** (chat). Answers can include inline web images, interactive charts, entity highlights, interactive learning modules and audio pronunciations. ([source](https://help.openai.com/en/articles/6825453-chatgpt-release-notes))
- **Long-conversation navigation** (chat). Long chats get a table of contents and load faster. ([source](https://help.openai.com/en/articles/6825453-chatgpt-release-notes))
- **Writing blocks and code blocks (Canvas replacement)** (artifacts/canvas). Writing and coding now happen in blocks inside the chat. Canvas was removed from current models on May 28, 2026. ([source](https://help.openai.com/en/articles/6825453-chatgpt-release-notes))
- **Memory (improved memory)** (memory). ChatGPT keeps your context up to date from past chats, saved memories, custom instructions, Library files and connected Gmail, depending on plan. ([source](https://help.openai.com/en/articles/8590148-memory-in-chatgpt))
- **Memory sources** (memory). A book-style Sources icon under a response shows which memories, past chats, custom instructions, files or emails personalized it. ([source](https://help.openai.com/en/articles/8590148-memory-in-chatgpt))
- **Custom instructions** (settings). Persistent guidance ChatGPT applies across all your chats. ([source](https://help.openai.com/en/articles/8096356-chatgpt-custom-instructions))
- **Personality and characteristics** (settings). Choose a base style and tone, then fine-tune individual traits. ([source](https://help.openai.com/en/articles/11899719-customizing-your-chatgpt-personality))
- **Temporary chat** (memory). A chat that stays out of history and isn't used for training, with an optional personalized mode. ([source](https://help.openai.com/en/articles/8914046-temporary-chat-in-chatgpt))
- **Computer History (macOS)** (memory). Optional activity memory that lets ChatGPT and Codex refer to what you did in selected apps and sites. ([source](https://help.openai.com/en/articles/6825453-chatgpt-release-notes))
- **Projects** (projects). Workspaces that group chats, files, instructions and app sources so ChatGPT shares context across them. ([source](https://help.openai.com/en/articles/10169521-projects-in-chatgpt))
- **Sidebar organization and search** (projects). Pin chats and projects, group Recents by project, and search everything you've saved. ([source](https://help.openai.com/en/articles/6825453-chatgpt-release-notes))
- **Library and storage** (files). Uploaded and generated files save automatically, so you can reuse them in any chat. ([source](https://help.openai.com/en/articles/6825453-chatgpt-release-notes))
- **Space and Pages** (collaboration). A home for editable pages, subpages, folders and files that you can share and co-edit in real time. Each collaborator works with their own ChatGPT. ([source](https://help.openai.com/en/articles/20001549-getting-started-with-space-in-chatgpt))
- **Web search** (search). Current information with citations, used automatically or on request. ([source](https://help.openai.com/en/articles/9237897-searching-the-web-with-chatgpt))
- **Deep research** (research). Long multi-source research that produces a cited report. ([source](https://help.openai.com/en/articles/10500283-deep-research-in-chatgpt))
- **File and audio uploads** (files). Upload documents, spreadsheets, presentations, images and audio to summarize, compare, analyze or transcribe them. ([source](https://help.openai.com/en/articles/8555545-uploading-files-and-audio-to-chatgpt))
- **Images (ChatGPT Images 2.5)** (files). Create and edit images in chat or from the Images tab, using templates, sketches and region editing. ([source](https://help.openai.com/en/articles/11084440-images-in-chatgpt))
- **Study mode, quizzes and flashcards** (chat). Socratic tutoring that guides you instead of just giving the answer, plus interactive quizzes and flashcards. ([source](https://help.openai.com/en/articles/11780217-using-study-mode-in-chatgpt))
- **Scheduled tasks** (automation). One-time or recurring tasks, monitors that alert only on meaningful changes, and tasks triggered by app events. ([source](https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt))
- **ChatGPT Voice: Live (GPT-Live-1.1)** (voice). Voice inside the chat that listens and speaks at the same time, so you can interrupt naturally. Spoken replies also stream as text. ([source](https://help.openai.com/en/articles/20001274-chatgpt-voice))
- **Voice in Work and on desktop** (voice). Start, check and coordinate agent tasks by speaking. ([source](https://help.openai.com/en/articles/20001275-chatgpt-work-and-codex))
- **ChatGPT Work (agent)** (agents). An agent that researches, works across apps and files, and returns finished documents, sheets, slides, reports and Sites, staying with a task for hours if needed. ([source](https://learn.chatgpt.com/docs/get-started-with-work))
- **Dots (always-on agents)** (agents). A personal agent running on GPT-6 Astra that keeps working between conversations on its own cloud computer and browser, and asks you when a decision is needed. ([source](https://learn.chatgpt.com/docs/dots))
- **Built-in browser and cloud browser** (agents). Desktop has an agentic browser with tabs. Work on web and mobile uses a separate cloud browser. ([source](https://learn.chatgpt.com/docs/browser))
- **Computer use, browser extension and Appshots** (desktop). ChatGPT can operate desktop apps and your existing browser, and you can send any app window as context. ([source](https://learn.chatgpt.com/docs/appshots))
- **Plugins (replacing apps, connectors and GPTs)** (integrations). Installable bundles of skills, connected apps (MCP), app templates and interactive extensions, used automatically or by @mention. ([source](https://help.openai.com/en/articles/20001256-plugins-in-chatgpt))
- **App permissions and approval cards** (integrations). Detailed control over when ChatGPT reads from or acts in connected apps. ([source](https://help.openai.com/en/articles/20001495-managing-app-permissions-in-chatgpt))
- **Sites** (artifacts/canvas). Build, preview, version, publish and share interactive websites and small apps from Work or Codex. ([source](https://help.openai.com/en/articles/20001339-creating-and-using-chatgpt-sites))
- **Visualizations (@Visualize)** (artifacts/canvas). Interactive diagrams, charts, maps, simulations and calculators generated in chat. ([source](https://learn.chatgpt.com/docs/visualizations))
- **Sharing conversations** (collaboration). Share a link to a conversation or a single response. ([source](https://help.openai.com/en/articles/7925741-sharing-conversations-and-scheduled-tasks-in-chatgpt))
- **Desktop app keyboard shortcuts** (desktop). A full, rebindable shortcut map, with a settings page you can search by command name or by pressing a key combination. ([source](https://learn.chatgpt.com/docs/app/commands))
- **Desktop settings, appearance, pets and notifications** (desktop). Deep customization of the desktop app, plus status companions. ([source](https://learn.chatgpt.com/docs/pets))
- **Codex inside the ChatGPT app** (coding). The coding agent lives in the same app, with cloud, remote and mobile control. ([source](https://learn.chatgpt.com/docs/whats-new))
- **Mobile and platform reach** (mobile). Features specific to iOS and Android, and other places ChatGPT runs. ([source](https://help.openai.com/en/articles/6825453-chatgpt-release-notes))
- **Life features: Health, Finances, Shopping, Jobs** (chat). Dashboards and conversations grounded in connected personal data, plus commerce flows. ([source](https://help.openai.com/en/articles/6825453-chatgpt-release-notes))
- **Privacy, security and safety controls** (settings). Account-level protections and data controls. ([source](https://help.openai.com/en/articles/6825453-chatgpt-release-notes))

### OpenAI Codex (Codex CLI, Codex view in the ChatGPT desktop app, IDE extension, Codex Cloud, GitHub/GitLab/Slack/Linear integrations, SDK/App Server) and ChatGPT Work (OpenAI's "work" agent, launched July 9, 2026), plus related work products: dots, ChatGPT Space/Pages, Sites, Team Tasks, ChatGPT in Slack/Teams. As of today, "ChatGPT Work" is a mode in ChatGPT (the Chat/Work toggle) for delegating multi-step tasks that end in a finished deliverable. It shares its execution engine, permissions, pricing, credits and usage limits with Codex. It replaced the older ChatGPT agent, which has been retired. Its docs live at learn.chatgpt.com, which replaced developers.openai.com/codex (308 redirect).

As of 2026-10-15. 72 features catalogued.

**Standout details**

- Composer Predictions: Tab accepts a predicted next prompt as an editable draft (not sent), and generating predictions costs no credits.
- Steer vs Queue: a default setting plus a one-off shortcut for the other behavior. Queued messages are drag-reorderable above the composer. In the CLI, Enter steers and Tab queues.
- Esc twice on an empty CLI composer edits your previous message and forks from that point; ↑ restores the previous prompt.
- Appshots: press both Command (or both Alt) keys to capture the frontmost window's image plus off-screen accessible text. It routes to the chat you touched in the last 60 seconds.
- Pastes over 10,000 characters automatically become attachments, with a 'Show in text field' escape hatch.
- Managed worktrees are snapshotted before automatic deletion, and reopening the chat offers a restore. .worktreeinclude copies .env files into new worktrees.
- Network secrets never reach the sandbox: tasks see a placeholder, and the proxy substitutes the real value only for allowed HTTPS destinations.
- The Auto-review circuit breaker stops a turn after 3 consecutive or 10 of the last 50 denials. /approve grants a single exact retry.
- /side opens an ephemeral side chat, and the TUI keeps showing the parent chat's running status.
- Pets with Running / Needs input / Ready / Blocked states, custom pets generated by a hatch-pet skill, and reduced-motion still frames.
- Codex Micro hardware keyboard with per-chat status LEDs and Approve/Decline/Fork/Fast keys.
- Locked-use Computer Use can briefly unlock a Mac during trusted turns while covering every display. Any local input relocks it.
- Home and Lock Screen widgets show remaining usage and reset times, and Plus/Pro users can bank usage resets (/usage).
- Import from Claude Code, Claude Cowork and Cursor, including hooks, subagents, MCP config and the last 30 days of chats, with optional ongoing sync.
- @codex review on GitHub reacts with 👀, posts only P0/P1 findings, and accepts a scoped focus. '@codex fix the P1 issue' pushes a fix.
- Review output formats include 'Comic book', 'Visualization' and 'PDF'.
- Notification sounds: Default, Classic or None, and on macOS any system sound or imported audio.
- Shared thread snapshots redact known secret patterns and publish only on 'Copy link'.
- Interrupted local chats auto-resume after an app restart, and pinned threads sync between desktop and iOS.
- Model choice is a Faster-to-Smarter slider instead of a list of model names.
- Profile streaks, peak-token stats and shareable profile cards.
- Site tools (WebMCP) let a web page register agent tools, each call gets a safety review, and a 'Site tools' button in the address bar shows them.

**Design patterns**

- **One app, product selector with distinct information density.** A single desktop app holds ChatGPT (Chat and Work) and Codex. Ctrl+1/2/3 switches between them, and the web uses a Chat/Work toggle at the top. The ChatGPT view hides Git and shell detail and leads with plain language and finished outputs. Codex shows diffs, the review pane, the terminal and PR panes. Quick chat opens a lightweight ChatGPT chat from inside Codex, with 'Add to task' to attach it to a running task.
- **Sidebar as a work hub.** New chat (with a hover-revealed Quick chat icon) and Recents at the top. Entry points for Projects, Scheduled, Plugins (with Plugins and Skills tabs), Sites, Code Review and Security. A bell for Activity. Pinned items and collapsible sections. Profile in the bottom-left shows remaining weekly usage and a Show/Hide Pet toggle. The Codex Micro battery icon appears beside the account name.
- **Control row under the composer.** Run settings sit directly beneath the input: the permissions control (Ask for approval / Approve for me / Full access), the Power slider, the 'Work in' menu (This computer / Cloud), a Worktree toggle and a branch picker. The + menu holds attachments, Appshots, Goal, Plan mode, Connect Chrome, Sites and plugins. Mentioned tools become chips in the composer (e.g. a 'Visualize' tag). Empty-state prompts read 'What should we work on?' or 'Do anything'.
- **Faster-to-Smarter Power slider with progressive disclosure.** Model choice is a single slider with six presets, from Luna High to Astra Extra High; the default is Sol Medium. An Advanced panel exposes model, effort and speed separately. Max and Ultra appear only if eligible, and Ultra can be added to the slider in settings. This replaced long model lists and made capability-versus-cost a one-dimensional choice.
- **Stacked status rows above the composer.** Live controls for an in-flight run sit above the composer. A goal progress row offers pause, resume, edit and clear. A queued-message stack can be edited, reordered, sent or deleted. In the IDE, an active-subagents panel shows status and stop-all. Everything for the current run stays within thumb and eye reach of the input.
- **Side panel and multi-pane workspace.** A right-hand panel, toggled from the top-right, shows the agent's plan, sources, generated files and summary while a task runs. It also holds a Git summary and Sources section, PR review, browser tabs and file previews. A bottom panel shares space with the terminal. Cmd+Shift+B cycles workspace layouts; full view and split view are available. Tabs can be drag-reordered, closed tabs reopened, and widths resized by percentage.
- **Shared status vocabulary across surfaces.** Four chat states (Running, Needs input, Ready, Blocked) are reused by pets, the Activity view, the CLI pet and Codex Micro LEDs (white idle, blue thinking, green complete/unread, amber needs input, red error). A fixed priority order (needs input > blocked > ready > running) decides what to surface first. Unread markers, 'Mark as unread' and 'next chat needing attention' make many parallel agents manageable.
- **Annotate-to-edit everywhere.** Feedback is spatial rather than prose-only. Inline diff comments come from a hover '+'. Browser annotation mode lets you click an element or drag a region, and 'Adjust' offers style tweaks with a live preview. Artifact previews accept region selection for focused edits, image editing supports area selection with a Canvas compare view, and Space pages offer 'Ask for change' on selected text. Comments collect first and are sent as one chat message.
- **Approval UX: keyboard-first, scoped and explainable.** Enter approves and Esc declines. Cmd/Ctrl+Enter submits approval feedback. Multiple requests can be approved in parallel. Scopes include Allow once, Allow for this site, Allow for all sites, Always allow this app, and 'Don't ask again' for MCP. Auto-review items show a status (Reviewing, Approved, Denied, Aborted, Timed out) with a risk level. Slack uses private Allow/Deny cards. Mobile uses a redesigned approval picker.
- **Ambient companions and floating surfaces.** An optional floating pet with chat controls (or 'Mini' without the pet), a pop-out chat window with 'Always on top', a Quick Chat on a global hotkey, and a Computer Use picture-in-picture window that docks to the pet. You can follow agents without the main window in front.
- **Plugin display-mode system (Apps SDK guidelines).** Third-party UI in ChatGPT uses fixed display modes. Inline cards: at most 2 actions, no nested scrolling or deep navigation, and the card grows to fit its content. Carousels: 3–8 items, image plus title plus at most 2–3 lines of metadata, one CTA each. Fullscreen keeps the ChatGPT composer overlaid. PiP pins to the top while scrolling and returns inline when the session ends. Visual rules: system font stack, system colors with brand only on accents and primary buttons, monochrome outlined icons, consistent corner radii and grid spacing, WCAG AA. A @openai/apps-sdk-ui library (Tailwind plus CSS-variable tokens) and a Figma kit are provided.
- **Deep theming and density controls.** Users choose a base theme, accent, background and foreground colors, and separate UI and code fonts, and can share themes. A theme switcher sits in the command palette. Font size and zoom are adjustable per window. The TUI has .tmTheme syntax themes, a configurable status line and terminal title, a Vim mode and a full keymap.
- **Keyboard and command-palette first.** A command menu (Cmd+K or Cmd+Shift+P), a shortcut editor with keystroke search, Cmd+1–9 chat jumping, recent-chat chords, back and forward history with mouse-button support, app-level undo/redo (Cmd+Z), and copy-deep-link and copy-working-directory shortcuts.
- **TUI information layout.** The footer status line defaults to model-with-reasoning, context-remaining and current-dir. The terminal title shows a spinner and the project. A welcome screen shows onboarding tooltips. Fenced code and diffs are syntax-highlighted. Alt-screen is auto-skipped in Zellij to preserve scrollback, and a raw scrollback mode allows copy-friendly selection.
- **Review-format presets and personal review inbox.** Code review can be rendered as Comic book, Visualization or PDF. The PR inbox has 'Assigned to me', 'Assigned to my team' and 'Authored by me' filters, stacked-PR navigation, per-revision 'Mark as viewed', and Checks > Fix, which drafts a fix message from failing CI output.
- **Profile insights as engagement design.** The profile shows lifetime and peak tokens, streaks, longest task and token activity, with shareable cards on consumer plans. Widgets show remaining usage and reset times.
- **Brand system foundation.** OpenAI's in-house rebrand (early 2025) introduced the OpenAI Sans typeface (with ABC Dinamo) and a motion system by Studio Dumbar. The plugin guidelines, however, tell partners ChatGPT uses platform-native system fonts (SF Pro on iOS).

**Motion patterns**

- **Composer shimmer while streaming.** In fullscreen plugin views, the ChatGPT composer input 'shimmers' to signal that a response is streaming. When it finishes, a short-lived, truncated snippet of the response appears above the composer, and tapping it opens the chat sheet.
- **Loading shimmer in the Codex app.** Codex app 26.318/26.319 (Mar 19, 2026) added a loading shimmer, alongside a refreshed file tree and percentage-based resizing.
- **TUI spinners, shimmer and welcome animation (globally switchable).** The CLI animates its welcome screen, shows a shimmer and spinners on active status and command rows, and puts a braille spinner in the terminal title while working (default title is [spinner, project]). tui.animations=false turns off every spinner, shimmer and animation for screen readers. Commit #20564 (May 2026) enforced the flag after some animations had slipped through ungated.
- **Structured streaming phases.** The agent stream separates commentary (progress narration), partial_answer (stable answer text that may grow) and final_answer. Reasoning summaries stream section by section (summaryIndex increments when a new section opens). Plan steps move through pending, inProgress and completed. Command stdout streams live. A turn-level aggregated diff updates as files change. These let the UI animate progress per item rather than as one undifferentiated text stream.
- **Safety buffering and reroute states.** The protocol emits model/safetyBuffering/updated with a showBufferingUi flag (and an optional fasterModel) when a response pauses briefly for safety, and model/rerouted when traffic moves to another model. The client shows an explicit buffering state instead of a silent stall.
- **Sprite-animated pets that respect reduced motion.** Floating pets use sprite-sheet animation (sprite format v1 or v2) and reflect agent state. When the OS reduced-motion setting is on, the pet shows a still frame. The pet keeps its position across launches, and the Computer Use PiP window docks to it and follows when moved.
- **Hardware light motion (Codex Micro).** The selected chat's Agent Key pulses in its status color. A sea-green moving light shows recording and a moving white light shows speech processing. Solid white means a prompt is ready to send. The channel light fast-flashes while pairing. Lights auto-dim after 3 minutes and wake on use or on any status change.
- **Smoother transcript scrolling and animations.** The Oct 9, 2026 dots/ChatGPT update lists smoother transcript scrolling and animations, faster sidebar loading, fewer pauses while waiting for replies, and threads that rename themselves as the work changes.
- **Streaming robustness fixes as motion quality.** Release notes treat smooth streaming as a product requirement. Fixes include: views that stopped updating during streaming (26.228), streaming stalls in hidden windows and new-chat stalls after large pastes (26.831), queued messages stuck on 'Sending' (26.1007), and Changes-panel scroll smoothness. Earlier answers now stay visible while a task continues (26.928).
- **Ghost-text predictions.** After a response finishes, Composer Predictions show the suggested next prompt as autocomplete-style ghost text in the input. Typing replaces it immediately, and Tab converts it to an editable draft without sending.
- **Live Activities and progress affordances on mobile.** iOS 26 shows a Live Activity for worktree setup. The app shows reconnection progress, and Home and Lock Screen widgets show remaining usage and reset countdowns.
- **Direct-manipulation micro-interactions.** Interactions include drag-to-reorder queued messages and tabs, drag handles that move whole blocks or sections in Pages, a hover-revealed '+' on diff lines, double-click to rename threads, hover to reveal Quick chat beside New chat, a click on the file background to expand or collapse a diff, and inline accept/change/undo on generated text in Pages.
- **Voice with natural turn-taking.** GPT-Live voice can be interrupted mid-response and steered while tasks run. The voice key on Codex Micro supports hold-to-talk or a double-press latch within 350 ms.

**Weaknesses**

- The July 2026 desktop merge confused users: the app defaulted to Work, Chat was buried in a pop-up box, window controls were non-standard, and settings were crowded. A reviewer called it a near-copy of the Claude Mac app. OpenAI reversed many of these changes by July 17.
- The Work vs Codex toggle feels cosmetic to many users (mostly changes default plugins and colors). Users ask why they must pick a mode up front.
- At launch, users reported chats hidden in a 'Recent chats' pop-up showing 3–4 threads, no working chat search, missing projects on macOS, and missing voice, Deep Research, Canvas, custom GPTs, temporary chats and message editing in the new app.
- Electron app, reported at about 1.46 GB. Codex creates a folder per thread and injects global AGENTS.md and developer instructions even into casual chats.
- Recurring usage-limit complaints (fast quota drain since May 2026, an opaque dashboard, community 'limits storm'). Work and Codex share one quota.
- ChatGPT agent was removed (around July/August 2026) with little notice or migration path. Work cannot do cloud-browser website sign-in in Enterprise/Edu, and agent-based scheduled tasks broke. ChatGPT Atlas shut down Aug 9, 2026.
- Accuracy complaints about Work: small logic mistakes and ignoring explicit rules mean outputs need checking. Inaccuracy is the top negative tag in G2 reviews cited by a competitor's review.
- Heavy fragmentation by platform, region, plan and rollout. Many features are macOS-only (Record & Replay, Computer History, screen context, locked use, thread snapshots) or excluded from the EEA/UK/CH at launch. Ultrafast is Pro $500 or Enterprise only. Predictions are Pro-only. Browser, plugins and visualizations are missing from the CLI and/or IDE.
- Cloud environments don't support computer or browser use, GitLab, or GitHub Enterprise Server. Tailscale is the only VPN. Legacy cloud still backs code review and the Linear/GitHub integrations.
- Rapid model churn (GPT-5.4 retired Aug 31, Spark Sep 14, GPT-5.5 Oct 14) forces users to update saved configs, automations and custom agents. `codex mcp-server` was removed after a short deprecation window.
- Compliance logs and MCP hooks are not a complete audit trail. Computer History memory files are unencrypted. Local computer access with Work Cloud is not strict ZDR.
- Screen-reader accessibility gaps in the TUI (decorative bullets read aloud, redraws, animations not gated by the flag until a May 2026 fix). The accessibility issue remains open.
- The Business plan lets any member invite users, adding paid seats without approval, and lacks SCIM, RBAC, IP allowlisting and residency.
- The web Subagents panel is read-only with no stop or steer. Event-triggered scheduled tasks are unavailable in the desktop app, CLI and IDE.
- Apple Messages send confirmations can fail under Full access. Computer Use on Windows takes over the foreground and can't run in the background.

**Not verified**

- Workspace agents: secondary sources (Decrypt, The Decoder, TestingCatalog, Reworked) say OpenAI launched Codex-powered 'workspace agents' on April 22, 2026, as an evolution of custom GPTs, in research preview for Business/Enterprise/Edu/Teachers, free until May 6, 2026 and then credit-based. Current primary docs instead describe teams/Team Tasks, @ChatGPT in Slack/Teams, workspace connections and GPT-to-plugin migration.
- The OpenAI announcement page (openai.com/index/chatgpt-for-your-most-ambitious-work, July 9, 2026) returned 403. Search summaries say Work on web and mobile started with Pro, Enterprise and Edu while the desktop app with Work reached every plan including Free. Axios reportedly gave a different order. Docs confirm only that the updated desktop app is available on every plan including Free.
- GPT-5.6 launching July 9, 2026 after a delay attributed to the US administration (Axios/Bloomberg summaries; not read directly).
- Exact removal date of ChatGPT agent (reports range from mid-July to early August 2026). The help-center notice could not be fetched (403).
- A claimed July 12, 2026 removal of the Codex five-hour window (smartscope.blog) conflicts with the pricing page, which still lists five-hour estimates for Plus and says only Pro has no five-hour limit.
- '@Template Creator' locked-layout templates in Work, the book icon under responses that reveals which memories were used, built-in pet names (Dewey, Fireball, Hoots, Rocky, Seedy, Stacky, Codex), and the web custom-MCP 'New Plugin' form under Developer mode. All come from a third-party Substack guide only.
- Web model picker labels ('Instant, Medium, High' with a model submenu; help article says 'Instant, Medium, High, Extra High' with Pro on GPT-6 Astra). help.openai.com returned 403.
- Spyglass review details (minimize closes the window, 'Do anything' placeholder, Chat opening as a bottom pop-up) predate OpenAI's July 17 partial reversal. Current state is unknown.
- Hacker News reports: app size of 1.46 GB, the Classic app no longer downloadable, Sora and Group Chats retired.
- Motion timing values (150–220 ms hovers, cubic-bezier easing) come from an unofficial 'OpenAI design system' page.
- Wikipedia's ChatGPT infobox lists 'GPT-6 Astra' as the engine. Release reporting ties ChatGPT Work's launch to GPT-5.6.
- Exact duration and easing of the desktop app's shimmer, streaming text reveal and panel transitions. No primary source describes them beyond a 'loading shimmer' and 'composer shimmers while streaming'.

**Features**

- **ChatGPT Work (mode)** (agents). Agent mode for handing off multi-step tasks that end in a deliverable: brief, deck, spreadsheet, analysis, PDF, Site, recurring update or workflow. You can monitor progress, answer questions, change direction and approve important actions while it runs. ([source](https://learn.chatgpt.com/docs/get-started-with-work ; https://learn.chatgpt.com/docs/use-chatgpt ; https://learn.chatgpt.com/docs/enterprise/work-admin-faq))
- **Local computer access with Work Cloud (Work across devices)** (agents). Start a Work task on desktop and continue it on web or mobile. OpenAI's cloud orchestrates the task, and an online connected computer runs the steps that need local files and tools. ([source](https://learn.chatgpt.com/docs/enterprise/chatgpt-work-overview ; https://learn.chatgpt.com/docs/whats-new/devday-2026))
- **Work cloud browser** (agents). Remote browser session that ChatGPT Work and dots use for public sites and forms, separate from the user's local browser. ([source](https://learn.chatgpt.com/docs/enterprise/chatgpt-work-overview ; https://learn.chatgpt.com/docs/dots))
- **Work network access setting** (agents). Per-user control over whether Work's code and shell commands can reach the public internet. ([source](https://learn.chatgpt.com/docs/enterprise/chatgpt-work-overview))
- **Dots (always-on personal agents)** (agents). An always-on GPT-6 Astra agent that takes ongoing responsibility for goals across tools. It works between conversations on its own cloud computer and browser, reports results, and asks for decisions. ([source](https://learn.chatgpt.com/docs/dots ; https://learn.chatgpt.com/docs/whats-new/dots-october-9-2026))
- **ChatGPT Space and Pages** (collaboration). Workspace combining Pages (collaborative docs edited with ChatGPT), spreadsheets, presentations, Sites, images and files, organized into Space groups. ([source](https://learn.chatgpt.com/docs/space ; https://learn.chatgpt.com/docs/space/pages ; https://learn.chatgpt.com/docs/space/agents ; https://learn.chatgpt.com/docs/space/collaboration))
- **Sites (hosted websites and apps)** (artifacts/canvas). Create, save, version, deploy and share interactive websites and apps from a chat. Triggered by the word 'website' or by @Sites. ([source](https://learn.chatgpt.com/docs/sites))
- **Visualizations (@Visualize)** (artifacts/canvas). Interactive charts, maps, diagrams, calculators and simulations rendered in the chat. ([source](https://learn.chatgpt.com/docs/visualizations ; https://learn.chatgpt.com/docs/changelog))
- **Artifact viewer / Work with files** (files). Preview and refine generated documents, presentations, spreadsheets and PDFs next to the chat, with annotation-driven edits. ([source](https://learn.chatgpt.com/docs/artifacts-viewer))
- **Library and long-paste handling** (files). Saved files reusable across conversations, plus automatic conversion of long pastes into attachments. ([source](https://learn.chatgpt.com/docs/codex-manual.md (What's new section) ; https://learn.chatgpt.com/docs/enterprise/chatgpt-work-overview))
- **Scheduled tasks (automations)** (automation). Recurring or event-triggered background work, either standalone (each run starts a new chat) or inside an existing chat (runs return to it with its context). ([source](https://learn.chatgpt.com/docs/automations))
- **Team Tasks and teams** (automation). Shared scheduled or event-triggered tasks that run in the cloud under a team service account and approved connections. ([source](https://learn.chatgpt.com/docs/enterprise/teams))
- **ChatGPT in Slack and Microsoft Teams (@ChatGPT)** (integrations). Mention @ChatGPT in approved channels to request work. Repository work can be delegated to a Codex Cloud task, with results posted back to the thread. ([source](https://learn.chatgpt.com/docs/third-party/slack ; https://learn.chatgpt.com/docs/environments/cloud-environments))
- **Plugins and plugin directory** (integrations). Reusable packages that bundle skills, MCP servers or apps, browser extensions and hooks. One catalog is shared by ChatGPT Chat/Work and Codex. ([source](https://learn.chatgpt.com/docs/plugins ; https://learn.chatgpt.com/docs/whats-new/devday-2026 ; https://learn.chatgpt.com/docs/changelog))
- **Custom GPT to plugin migration** (integrations). Custom GPT workflows are being moved to plugins: GPT instructions become a skill, knowledge files become reference files, and connected apps carry over. ([source](https://learn.chatgpt.com/docs/migrate-custom-gpts))
- **MCP Events** (integrations). Ask ChatGPT to watch an MCP server for updates and act when matching events arrive. ([source](https://learn.chatgpt.com/docs/whats-new/september-28-october-2-2026))
- **Sign in with ChatGPT** (integrations). Identity provider for third-party apps. Eligible Plus and Pro users can bring their plan usage to participating apps. ([source](https://learn.chatgpt.com/docs/plugins ; https://learn.chatgpt.com/docs/whats-new/devday-2026))
- **Unified ChatGPT desktop app (Chat, Work, Codex)** (desktop). On July 9, 2026 the Codex app merged into the ChatGPT desktop app for macOS and Windows. ChatGPT (Chat/Work) and Codex are separate views in one app. ([source](https://learn.chatgpt.com/docs/app ; https://learn.chatgpt.com/docs/codex-manual.md ; https://learn.chatgpt.com/docs/changelog))
- **Run location: Local / Worktree / Cloud / SSH hosts** (desktop). Choose where each Codex chat runs when you start it. ([source](https://learn.chatgpt.com/docs/environments/modes ; https://learn.chatgpt.com/docs/remote-connections))
- **Worktrees and Handoff** (coding). Isolated Git worktrees let several chats work in the same repo in parallel. Handoff moves a chat and its code between Local and Worktree. ([source](https://learn.chatgpt.com/docs/environments/git-worktrees ; https://learn.chatgpt.com/docs/changelog))
- **Review pane (local diffs)** (coding). Built-in diff review with scopes, staging, reverting and inline comments that feed back to the agent. ([source](https://learn.chatgpt.com/docs/code-review ; https://learn.chatgpt.com/docs/changelog))
- **Code Review plugin / PR review in the app** (coding). Review GitHub PRs (and GitLab MRs in preview) inside the app, with a personal inbox, stacked-PR awareness, and fixes for failing checks. ([source](https://learn.chatgpt.com/docs/code-review ; https://learn.chatgpt.com/docs/changelog))
- **Integrated terminal** (coding). A terminal drawer under each chat, scoped to its project or worktree, whose output the agent can read. ([source](https://learn.chatgpt.com/docs/integrated-terminal ; https://learn.chatgpt.com/docs/reference/commands))
- **Built-in browser** (desktop). A browser inside the desktop app for previewing local and public pages, leaving comments, and letting Work or Codex click, type, inspect and verify. ([source](https://learn.chatgpt.com/docs/browser ; https://learn.chatgpt.com/docs/webmcp))
- **Browser extension (side chat)** (desktop). Extension for Chrome, Edge, Brave, Opera and Vivaldi that lets ChatGPT work in your real, signed-in browser tabs. ([source](https://learn.chatgpt.com/docs/chrome-extension))
- **Computer Use** (desktop). ChatGPT Work or Codex operates desktop apps through their visual interface on macOS and Windows. ([source](https://learn.chatgpt.com/docs/computer-use ; https://learn.chatgpt.com/docs/pets))
- **Record & Replay** (automation). Demonstrate a workflow on your Mac, and ChatGPT or Codex drafts a reusable skill from it. ([source](https://learn.chatgpt.com/docs/extend/record-and-replay))
- **Appshots** (desktop). Capture the frontmost window, both image and accessible text (including off-screen scroll content), straight into a chat. ([source](https://learn.chatgpt.com/docs/appshots))
- **ChatGPT Voice (GPT-Live) in the desktop app** (voice). Live voice conversation in Chat, Work and Codex that can start, check on and steer tasks. ([source](https://learn.chatgpt.com/docs/features/voice ; https://learn.chatgpt.com/docs/pricing))
- **Pets and Quick Chat floating controls** (desktop). Optional animated companions that float above other windows, show chat status and give quick access to a Quick Chat composer. ([source](https://learn.chatgpt.com/docs/pets))
- **Activity view and notifications** (desktop). A central place for chats that are unread, running or waiting on you, plus configurable alerts. ([source](https://learn.chatgpt.com/docs/notifications ; https://learn.chatgpt.com/docs/reference/commands ; https://learn.chatgpt.com/docs/changelog))
- **Composer: steer vs queue, mentions, predictions** (chat). A composer built for running agents: inject instructions mid-turn or queue follow-ups, mention context and skills, and accept predicted next prompts. ([source](https://learn.chatgpt.com/docs/prompting ; https://learn.chatgpt.com/docs/features/composer-predictions ; https://learn.chatgpt.com/docs/reference/settings))
- **Power slider and model/intelligence picker** (chat). In the desktop app and on the web, a single Faster-to-Smarter slider replaces a list of model names, with an Advanced panel for picking model, effort and speed separately. ([source](https://learn.chatgpt.com/docs/codex-manual.md (Models section) ; https://learn.chatgpt.com/docs/models ; https://learn.chatgpt.com/docs/reference/commands))
- **Goal mode (/goal) and Plan mode (/plan)** (agents). Goal mode sets a persistent objective whose text is both the first prompt and the completion criteria. Plan mode investigates and proposes an approach before editing. ([source](https://learn.chatgpt.com/docs/long-running-work ; https://learn.chatgpt.com/docs/prompting))
- **Side chats, forks, quick and temporary chats** (chat). Branch off without derailing the main thread. ([source](https://learn.chatgpt.com/docs/developer-commands?surface=cli ; https://learn.chatgpt.com/docs/reference/commands ; https://learn.chatgpt.com/docs/projects))
- **Shared Codex thread snapshots (/share)** (collaboration). Read-only, link-shareable snapshots of local Codex threads. ([source](https://learn.chatgpt.com/docs/use-chatgpt))
- **Projects and chats organization** (projects). Projects combine ChatGPT projects and local folders; chats can be pinned, renamed, archived and moved in bulk. ([source](https://learn.chatgpt.com/docs/projects ; https://learn.chatgpt.com/docs/changelog))
- **Memories (local Codex memory store)** (memory). Codex turns useful context from earlier chats into local memory files used in future sessions. Separate from ChatGPT web memory. ([source](https://learn.chatgpt.com/docs/customization/memories))
- **Computer History (macOS)** (memory). Opt-in feature that turns your activity across allowed apps and sites into memories and a day-grouped timeline that ChatGPT and Codex can reference. ([source](https://learn.chatgpt.com/docs/customization/computer-history))
- **Personalization and appearance** (settings). Personal instructions, writing style, themes, fonts, profile and shortcut editing. ([source](https://learn.chatgpt.com/docs/reference/settings ; https://learn.chatgpt.com/docs/personalize ; https://learn.chatgpt.com/docs/config-file/config-reference))
- **Command menu, shortcuts and deep links** (desktop). Keyboard-first navigation across the app, with a comprehensive set of shortcuts. ([source](https://learn.chatgpt.com/docs/reference/commands))
- **Codex on mobile / Codex Remote** (mobile). Start, follow, steer, approve and review Codex tasks from the ChatGPT iOS and Android apps, running in the cloud or on a paired Mac or PC. ([source](https://learn.chatgpt.com/docs/mobile ; https://learn.chatgpt.com/docs/remote-connections ; https://learn.chatgpt.com/docs/changelog))
- **Codex CLI (TUI)** (coding). Open-source terminal agent with an interactive TUI that inspects, edits and runs commands with live diffs. ([source](https://learn.chatgpt.com/docs/codex/cli ; https://learn.chatgpt.com/docs/developer-commands?surface=cli ; https://learn.chatgpt.com/docs/cli-customization ; https://github.com/openai/codex/releases))
- **CLI slash commands** (coding). A large set of in-session commands. ([source](https://learn.chatgpt.com/docs/developer-commands?surface=cli))
- **CLI subcommands** (coding). Scriptable commands beyond the TUI. ([source](https://learn.chatgpt.com/docs/developer-commands?surface=cli ; https://learn.chatgpt.com/docs/mcp-server))
- **Non-interactive mode (codex exec)** (coding). Run Codex in scripts and CI. Progress streams to stderr and the final message goes to stdout. ([source](https://learn.chatgpt.com/docs/non-interactive-mode))
- **Codex IDE extension** (coding). Codex in VS Code, Cursor, Windsurf and VS Code Insiders (openai.chatgpt). Xcode and JetBrains connect through their own agent integrations. ([source](https://learn.chatgpt.com/docs/codex/ide ; https://learn.chatgpt.com/docs/developer-commands?surface=ide))
- **Desktop app slash commands** (coding). 28 built-in composer commands in the desktop app. ([source](https://learn.chatgpt.com/docs/reference/slash-commands))
- **AGENTS.md custom instructions** (settings). Layered instruction files discovered from global scope down to the current directory. ([source](https://learn.chatgpt.com/docs/agent-configuration/agents-md))
- **Skills** (settings). Folder-based capabilities (SKILL.md plus optional scripts, references and assets) following the agentskills.io standard. ([source](https://learn.chatgpt.com/docs/build-skills))
- **Hooks** (settings). Lifecycle hooks that run command scripts or MCP tools at points in the agent loop. ([source](https://learn.chatgpt.com/docs/hooks))
- **Rules (execpolicy)** (settings). Starlark prefix_rule files that allow, prompt or forbid specific commands outside the sandbox. ([source](https://learn.chatgpt.com/docs/agent-configuration/rules))
- **Subagents and custom agents** (agents). Parallel delegated agents (explicit, instruction-driven, or proactive at Ultra) that return one consolidated answer. ([source](https://learn.chatgpt.com/docs/agent-configuration/subagents ; https://learn.chatgpt.com/docs/changelog))
- **MCP client support** (integrations). STDIO and Streamable HTTP MCP servers, with configuration shared across the desktop app, CLI and IDE on the same host. ([source](https://learn.chatgpt.com/docs/extend/mcp ; https://learn.chatgpt.com/docs/changelog))
- **Permission modes (Ask for approval / Approve for me / Full access)** (settings). A permissions control below the composer (or /permissions in the CLI) that sets when the agent pauses. ([source](https://learn.chatgpt.com/docs/permission-modes ; https://learn.chatgpt.com/docs/agent-approvals-security))
- **Auto-review (reviewer agent for approvals)** (settings). A separate reviewer agent decides sandbox-escalation, network and side-effecting tool requests in place of the user. ([source](https://learn.chatgpt.com/docs/sandboxing/auto-review))
- **Safety monitoring (GPT-6 Astra)** (settings). An asynchronous monitor that can pause a task on detected unsafe behavior. ([source](https://learn.chatgpt.com/docs/agent-approvals-security))
- **Codex Cloud with reusable environments** (coding). Cloud coding tasks that each run in an isolated workspace built from a published environment, and keep running while your computer sleeps. ([source](https://learn.chatgpt.com/docs/environments/cloud-environments ; https://learn.chatgpt.com/docs/cloud))
- **Codex Cloud (Legacy)** (coding). The earlier container-based cloud. Still backs Code Review and the Linear and GitHub @codex integrations; planned for deprecation. ([source](https://learn.chatgpt.com/docs/environments/cloud-environment ; https://learn.chatgpt.com/docs/changelog))
- **GitHub code review and @codex** (integrations). Automatic or on-demand PR reviews posted as standard GitHub reviews, plus @codex tasks from PR comments. ([source](https://learn.chatgpt.com/docs/third-party/github ; https://learn.chatgpt.com/docs/pricing))
- **GitLab support (Beta)** (integrations). Codex cloud and Code Review for GitLab merge requests. ([source](https://learn.chatgpt.com/docs/changelog))
- **Codex for Linear** (integrations). Assign or @mention Codex on Linear issues to start cloud tasks that post progress and summaries back. ([source](https://learn.chatgpt.com/docs/third-party/linear))
- **Codex GitHub Action** (integrations). openai/codex-action@v1 runs codex exec in CI with a Responses API proxy that limits key exposure. ([source](https://learn.chatgpt.com/docs/github-action))
- **Codex SDK and App Server** (integrations). TypeScript (@openai/codex-sdk) and Python (openai-codex) SDKs, and a JSON-RPC app server for building custom Codex clients. ([source](https://learn.chatgpt.com/docs/codex-sdk ; https://learn.chatgpt.com/docs/codex-manual.md (App Server section)))
- **Codex Security** (coding). Application-security agent for finding, validating and fixing vulnerabilities. ([source](https://learn.chatgpt.com/docs/security))
- **Import from another agent** (integrations). Bring setup and recent chats over from Claude Code, Claude Cowork and Cursor. ([source](https://learn.chatgpt.com/docs/import))
- **Codex Micro (Work Louder keyboard)** (desktop). A limited-run hardware macro pad for monitoring and controlling chats. ([source](https://learn.chatgpt.com/docs/features/codex-micro))
- **Models and retirements** (pricing/limits). Current Codex and Work models: GPT-6 Astra, GPT-6.1 Sol (released Sep 29, 2026), GPT-6 Sol, GPT-6 Luna, and GPT-5.6 Sol/Terra/Luna during the transition. ([source](https://learn.chatgpt.com/docs/models ; https://learn.chatgpt.com/docs/changelog))
- **Fast and Ultrafast speed tiers** (pricing/limits). Paid speed boosts for supported models. ([source](https://learn.chatgpt.com/docs/agent-configuration/speed))
- **Plans, usage limits and credits** (pricing/limits). Work and Codex share pricing, credits and limits across plans. ([source](https://learn.chatgpt.com/docs/pricing ; https://learn.chatgpt.com/docs/enterprise/chatgpt-work-usage-and-cost ; https://learn.chatgpt.com/docs/changelog))
- **Enterprise governance (Agent Security, managed config, access tokens)** (settings). Admin controls over agent tools, files, network, models and automation. ([source](https://learn.chatgpt.com/docs/enterprise/work-admin-faq ; https://learn.chatgpt.com/docs/agent-approvals-security ; https://learn.chatgpt.com/docs/changelog))
- **Image generation and editing (gpt-image-2)** (artifacts/canvas). Generate and edit images in a chat, with a dedicated review viewer. ([source](https://learn.chatgpt.com/docs/image-generation))

### Claude (claude.ai web, Claude Desktop for macOS/Windows/Linux, Claude for iOS/Android), plus the add-ins and extensions that are part of the same account (Claude in Chrome, Microsoft 365, Google Workspace, Slack)

As of 2026-10-14. 62 features catalogued.

**Standout details**

- Thinking shows a live timer, and the reasoning folds into an expandable summary afterwards.
- The model picker always shows both model and effort level, and every model marks its own 'Default' effort.
- Artifacts that call Claude bill each viewer's own plan, so creators can share AI apps with no API keys and pay nothing.
- Custom visuals can be copied as an image, downloaded as .svg or .html, or promoted to a persistent artifact. Clicking inside one sends a follow-up prompt.
- Style preferences for visuals persist through memory (for example 'make all my visualizations pink').
- Highlighting text and choosing 'Edit with Claude' rewrites only that passage. Edits across files can be queued and applied in one pass.
- In Docs, Claude leaves its own margin comments explaining its choices, and @Claude in any comment requests a targeted edit with an explanation in the thread.
- Docs follow familiar editor conventions: '/' inserts blocks, '@' mentions people, dates, tabs and docs, and ':' inserts emoji. The full shortcut sheet opens with Cmd+/ or '?'.
- Dashboards show the SQL and last refresh time behind every chart. Clicking any number reveals its query.
- Motion is code, not generated video, so you can change one number or word without re-rendering everything, and there are no AI-generated people.
- On Mac, quick entry opens with a double-tap of Option and can attach a dragged screenshot or a clicked window. Caps Lock toggles dictation.
- claude:// deep links prefill prompts but never auto-send. Folders passed in links always need confirmation.
- Memory leaves out sensitive topics by default and shows a notice above the message box the first time it declines to save one. It never stores government IDs or financial account numbers, even when asked.
- Memory can be switched off for a single chat before the first message, and that chat still stays in history (unlike incognito).
- Memory import from other assistants comes with a ready-made export prompt, then 'See what Claude learned about you' opens a chat to verify what was imported.
- Incognito chats get a black border around the whole chat and a label, so the mode is unmistakable.
- Email-invited chat shares open only for the exact invited address, and Claude never reveals whether an email already has an account.
- Recipes have a 'Get cooking' step-by-step mode with servings and unit scaling. Weather shows Fahrenheit for US locations and Celsius elsewhere.
- Claude in Chrome puts its tabs in a separately coloured tab group, and 1Password sign-in is approved by biometrics so Claude never sees the password.
- On iOS, 'Analyze Photo with Claude' works from the Lock Screen without unlocking. 'Ask Claude' works from Siri, Spotlight and the Share Sheet.
- Health data is shown as native charts, is never written back, and stays out of memory by default.
- Break reminders and quiet hours are gentle nudges, not locks. A monthly Reflect recap shows your peak hour and most active day.
- Record a skill turns a narrated screen recording into a reviewable skill card (NEW or Update). The raw video and audio are discarded afterwards.
- 'Try fixing with Claude' appears right next to artifact errors.
- Research runs on Opus 5.5 whatever model is selected, so deep research quality doesn't depend on the chat's model choice.
- App Store release notes are signed 'Yours, Claude'.
- Help articles document each editor's keyboard and screen-reader behaviour, including known VoiceOver issues and the browser versions affected.

**Design patterns**

- **Model and effort picker inside the composer.** The menu next to the send button always shows both the model and the effort level ('Opus 5.5 · High' style). Clicking it opens model choices with a 'Default' badge per model, an 'Effort' submenu with the Thinking switch on hover, and 'More models' for older ones. Model choice stays in the composer instead of the header.
- **'+' menu as the single tool tray.** One '+' at the lower left of the composer holds everything: add files or photos, Add from Google Drive, Research, Connectors (per-chat toggles), Web search (classic), the per-chat Memory switch, and Record a skill. The rest of the composer stays minimal.
- **'Output' chooser and slash commands in the message box.** An 'Output' option in the message box picks a target format (Docs, Design, Motion, other templates) before you type. The same targets are reachable as /docs, /design, /motion, /deep-research and /schedule, so power users can skip the menu.
- **Autonomy switch in the composer.** The Manual/Auto (and Skip) permission control sits in the message box beside the model picker. The level of agency is a visible per-conversation choice rather than a setting buried in preferences.
- **Chat beside a working surface (split view).** Artifacts, Docs, Slides, Dashboards and Google files open in a panel next to the conversation. Claude Design puts chat on one side and the canvas on the other, with a top bar, canvas and properties panel, and F6 cycles between them. In a narrow panel, Doc comments collapse to margin icons; in a wide panel they sit beside the text.
- **Sidebar information architecture.** A collapsible left sidebar (it can't be fully hidden) contains Recents (one list mixing quick chats and long tasks), Projects, an Artifacts tab (everything made, plus template gallery and migration banners), Scheduled, Customize (Skills, Connectors, Plugins), the Code tab, Design on desktop, and 'Shared with me' for projects. The account menu sits at the bottom left via your initials.
- **Warm-neutral colour system (official host tokens).** Claude's own style variables, exposed to MCP Apps. Light mode: background primary #FFFFFF, secondary #F5F4ED, tertiary #FAF9F5, text #141413, #3D3D3A and #73726C, borders #1F1E1D at 40/30/15% alpha. Dark mode: #30302E, #262624 and #141413 backgrounds, text #FAF9F5, #C2C0B6 and #9C9A92, borders #DEDCD1 at alpha. Semantic info/danger/success/warning sets come in background, text, border and ring variants, with rings at 50 to 70% alpha. The greys carry a warm (yellow-brown) undertone rather than blue.
- **Typography: Anthropic Sans and Anthropic Serif.** The host injects Anthropic Sans for UI (font-sans), with ui-monospace for code. The official Figma kit uses Anthropic Sans plus Anthropic Serif. Type scale: text 12/14/16/20px, headings 12 to 36px. Line height is 1.4 for small text, 1.25 for large, down to 1.0 for 3xl. Weights are 400, 500, 600 and 700, and apps are told to use only three sizes and two weights. Users can switch the chat font to Default, Match System or Dyslexic Friendly. Third-party reviews note a large serif greeting and serif reply text against sans UI, an 'editorial' feel different from ChatGPT and Gemini.
- **Hairline borders, small radii, rare shadows.** Border width is 0.5px. Radii are 4, 6, 8, 10 and 12px plus full pill. Shadows run from a hairline 0 1px 2px at 5% alpha to a large 0 10px 15px at 10%. Depth comes mostly from surface-tone shifts (FFFFFF, F5F4ED, FAF9F5) rather than elevation. Icons are monochrome and outlined.
- **Embedded app display modes with strict density rules.** An inline card auto-fits its height with no nested scroll, has at most 2 actions (at the bottom) and 4 to 5 data points, and no menus or drill-ins. An inline carousel holds 3 to 8 same-size cards, each with an image, a title, up to 3 metadata lines and 1 CTA; on mobile the next card peeks into view. Fullscreen has its own close button in a native header, and the composer stays visible. Picture-in-picture also exists. Visible controls (segmented buttons, toggle chips, inline tabs) are preferred over dropdowns.
- **Conversation-first split between app and chat input.** Direct manipulation (sliders, toggles, filtering, confirm actions) happens inside embedded UI. Anything needing language understanding (refine, redo, follow-ups) goes back through the composer. Embedded apps must not copy Claude's chat input.
- **Mobile layout rules.** Embedded apps render in a native WKWebView or WebView, full-width with no side margins, from 320pt wide up. Tap targets are at least 44pt, with primary actions in thumb reach. The conversation owns vertical scroll, so a tall widget can't trap the user, and inline height is capped. Safe-area insets are passed in hostContext. Content is borderless on web and bordered on mobile by default.
- **Minimal new-chat empty state.** A cream or off-white canvas with a small orange starburst (the Claude spark), a large serif personalised greeting (for example 'Back at it, Antoine'), and one softly bordered composer ('How can I help you today?') with the model shown quietly inside it. Below it sit five pill chips (Code, Create, Write, Learn, Life stuff). The icon sidebar is collapsed and there are no feature grids.
- **Incognito visual mode.** A ghost icon at the top right of a new chat. When it's active, the whole chat gets a black border and an 'Incognito chat' label at the top left, so the state is unmistakable.
- **Review-before-act cards.** Side-effecting actions show a preview card the user confirms. Examples: iOS Messages and Mail drafts open prefilled compose sheets, connector tool calls ask with an 'Allow always' option, Google Workspace edits show approval cards with a summary, and Slack messages appear as formatted previews before sending.
- **Message action row and feedback forms.** Under each reply: copy, read aloud, thumbs up, thumbs down and Try again. Edit sits on the user bubble. Thumbs up opens a light modal with one optional field; thumbs down adds an issue-type dropdown. Both warn that the conversation may be sent to Anthropic.
- **Settings taxonomy.** Settings sections: General (Instructions for Claude, Voice settings, Desktop app shortcuts, notifications), Appearance, Capabilities (code execution, network egress, AI-powered artifacts), Memory (topics, import), Privacy (shared chats), Usage (session and weekly bars, credits), Reflect, Time and focus, Billing, Extensions on desktop, Cowork (preferred browser), and Trusted folders.
- **Keyboard-first, accessible editors.** Docs, Slides and Design ship full keyboard maps. Cmd+/ or '?' opens the shortcut sheet. F6 cycles editor regions. Docs have '/' insert, '@' mention and ':' emoji menus, and Cmd+Option+M for comments with a 'Send to Claude' checkbox. Screen readers announce the slide number and title while presenting. Known VoiceOver bugs are documented with the Chrome versions affected.
- **Claude Code desktop workspace.** A session sidebar with status, project and environment filters. Drag-and-drop panes for terminal, editor, diff and preview arranged in a grid. Side chat on Cmd+;. A three-step verbosity control (Verbose, Normal, Summary). A usage button showing context and session use.
- **Transparent provenance in data UIs.** Dashboards show each chart's query and last refresh time, and clicking a number reveals its query. Excel answers cite exact cells and highlight edited ones. Research and web answers carry citations and source links. Past-chat search shows as a visible tool call linking the source chats.

**Motion patterns**

- **Thinking indicator with live timer and collapsible summary.** While Claude reasons, a 'Thinking' label with an elapsed-time counter is shown. Afterwards the reasoning collapses into an expandable section summarising Claude's approach. If safety systems stop the reasoning, it ends with an explicit message.
- **Animated Claude spark as the 'working' mark.** An orange spark (asterisk) animates while Claude works; users call it the most Claude-like part of waiting. In late Sep 2026 the Desktop Code tab replaced it with node-graph dot marks: 4 dots in a square while running a tool (with a label such as 'Running python3 35s'), 3 dots in a row while searching the web or counting seconds, and scattered dots in transient states. Users filed requests to bring back the spark or make it configurable.
- **Context compaction status.** When a long chat nears the limit, the UI shows Claude 'organizing its thoughts' while older turns are summarised, instead of failing with a length error.
- **Activity indicators for tools.** An indicator shows while Claude searches the web. Research mode shows a persistent blue indicator at the bottom of the chat until clicked off. Cowork tasks show step-by-step progress indicators. Past-chat search and connector calls appear inline as tool calls.
- **Inline-to-fullscreen expansion that returns scroll position.** Embedded apps and custom visuals expand from an inline card to fullscreen with a smooth transition and a clear expand affordance. Closing returns to the conversation at the same scroll position.
- **Skeletons instead of spinners for inline content.** Loading states for inline content use skeleton screens that match the final layout, so the swap is seamless. Spinners are discouraged as feeling less native.
- **Living, ephemeral inline visuals.** Custom visuals respond to sliders and buttons in place. Claude rebuilds or updates them as the conversation continues, and they 'change or disappear' as the chat moves on, unless saved as an artifact.
- **Click-inside-visual follow-up.** Clicking an element in a custom visual (for example a bar or quarter) sends a follow-up prompt automatically, so the visual drives the next turn.
- **Real-time co-editing presence in Docs.** Edits from collaborators and from Claude appear immediately for everyone with the doc open, attributed to the person or Claude. Claude's margin comments arrive while it drafts.
- **Voice mode turn-taking.** Hands-free mode listens continuously and replies at natural pauses. Speaking over Claude stops it and makes it listen (barge-in). Push-to-talk is hold-and-release. Spoken prompts first populate the chat input, then Claude responds.
- **Quick entry floating panel and capture gestures.** A double-tap of Option summons a floating input over any app. Dragging over the screen captures a region, and clicking a window attaches it. With Caps Lock dictation, text appears in real time as you speak.
- **Recording capture bar with countdown.** While recording a skill, a capture bar shows recording status and a live step count. A countdown appears with about one minute left, and at zero it auto-submits as if 'Done' were clicked.
- **Recipe 'Get cooking' step mode.** A recipe card turns into a step-by-step cooking interface. Servings and unit controls rescale ingredients in place.
- **Browser-agent tab grouping and alerts.** Claude in Chrome opens its tabs in a separate, differently coloured tab group, so agent activity is visually separate from yours. It plays sounds and sends notifications when it needs attention, and background workflows keep running when you switch tabs.
- **Slides present mode.** Full-screen presenting from inside Claude, with arrow and Space navigation. Escape exits and focus returns to 'Present'.
- **Streaming responses.** Responses stream as Claude generates them, including in the Code tab. Long tasks keep streaming progress from the cloud and land in the conversation when you return.
- **Reduced-motion fallback.** Users report that a Desktop setting to reduce animation (Settings > Motion) brings back a static or choppy spark and turns off other animations. Claude Code has a prefersReducedMotion setting that disables its spinner.
- **Motion as a product (Claude Motion).** Code-generated animations of text, charts, shapes and images. Timing and values stay editable after generation, and output is MP4. This is product motion offered to users, distinct from the UI's own motion.

**Weaknesses**

- No native image generation: Claude doesn't produce photos or illustrations, only HTML/SVG diagrams and charts (official help article, Mar 2026). ChatGPT is consistently cited as stronger on image generation.
- No generative video: Motion explicitly creates no realistic footage or people, only code-animated graphics.
- Usage limits are opaque (a rolling 5-hour session plus a weekly cap, no published message counts) and shared across chat, Claude Code and Desktop. Fortune (Apr 2026) reported outages, stricter peak-hour limits and complaints about perceived quality drops. Agentic tasks, Research, Auto mode and Design all burn limits faster.
- Reviewers repeatedly call Claude slower than ChatGPT on simple tasks (third-party comparisons).
- The new unified experience removed or doesn't yet support some things: branching from an earlier point, 'Add from GitHub', file creation and code in incognito, and search over older Cowork tasks. Dispatch is closed to new users.
- Mobile parity gaps: no custom visuals, weather or recipe widgets on iOS/Android. Chats can't be shared from the app, and artifact or design sharing settings can't be changed there. Research on mobile silently skips connectors, and mobile embedded apps have no camera, mic or location access.
- Several features are platform-locked: quick entry and Record a skill are Mac-only, Claude in Chrome works only in Google Chrome, and computer use and dictation aren't available on Linux.
- Claude Design has no version history, inline comments sometimes don't register, multi-person editing is 'basic and may be unreliable', large repos lag, and adding new layers needs a mouse.
- Claude Docs has no comment-only role, charts don't auto-refresh, Team/Enterprise can't share externally, there's no trash, and doc activity isn't in the Compliance API yet.
- Voice mode is still beta, and non-English is beta. Fable isn't available in voice, Cowork and Claude Code get only dictation, and Free can attach just one connector in voice.
- The Free tier lacks Opus, Research, Claude in Chrome, M365, Dashboards and Claude Code, and is capped at 5 projects with no RAG. Fable needs credits on Pro, and Mythos needs separate cyber-verification approval.
- Memory is unavailable for HIPAA, public-sector and custom-retention organisations, chat search doesn't work with CMEK, and local-only Cowork sessions don't use memory.
- Custom visuals are beta, quality varies, and they may not appear when expected. Weather and recipe widgets depend on web search being on.
- Users complained when the beloved animated spark in the Desktop Code tab was replaced by ambiguous dot indicators whose 3 vs 4-dot states aren't documented (GitHub issues, Sep to Oct 2026).
- Accessibility gaps reported by users: the Dyslexic Friendly font doesn't apply in the Code tab terminal, and the chat-font option was reported missing from the native mobile apps.
- There is no published keyboard-shortcut list for the main chat UI. Shortcut maps exist only for Docs, Slides, Design and Claude Code.
- Shared public links have surfaced in search results despite noindex (third-party report, Jul 2026), and Anthropic says it can't control crawlers that ignore noindex.
- Rapid product churn creates confusion: standalone Claude Design shuts down Dec 14, 2026 with chats and comments deleted, legacy artifacts and legacy memory coexist with new ones, and help articles conflict on plan availability.
- The connector and plugin ecosystem is described by reviewers as thinner than ChatGPT's outside the Connectors directory, and connector auth and network setup (Anthropic IP allowlisting) can be complex for private servers.

**Not verified**

- The default chat font is Anthropic Serif, with Anthropic Sans offered as the alternative (from a third-party blog; the official appearance article lists only 'Default / Match System / Dyslexic Friendly').
- Empty-state details: the personalised serif greeting ('Back at it, <name>'), the five chips (Code, Create, Write, Learn, Life stuff) and the collapsed icon sidebar come from a SaaSFrame capture (Feb 2026), not official documentation.
- The message action row (copy, read aloud, thumbs, Try again), the '1/N' version switcher, the thumbs feedback modals and 'Reply' on text selection with a quote chip in the composer all come from a third-party UX teardown (aiuxplayground).
- Details of the spark animation (a clockwise sweep with rays shrinking and regrowing, about 12fps, hand-drawn style) are a community recreation, not Anthropic's implementation.
- The Desktop Code-tab node-graph indicator internals (nodes3/nodes4 sprites, a turnStatusActivityMarks flag) and the 'Settings > Motion > reduce animation' path come from user inspection in GitHub issues, with no Anthropic confirmation.
- A 'Response completions' notification toggle under Settings > General > Notifications comes from third-party Guideflow tutorials only.
- The Settings > Usage layout (a 'Current session' bar with reset time, and weekly limits with a separate Fable entry) is described only by third-party guides and a university KB page.
- Styles (presets Normal/Concise/Formal/Explanatory, custom styles trained on writing samples, a 'Choose style' control by the model selector) appear only in older help versions. The current styles article returns 404, and the personalization article now points to skills, so it's unclear whether Styles still exist in the new experience.
- Claude Design 'tweaks' (auto-generated sliders and toggles per design) are reported by reviewers of the April 2026 launch but are not in the current help article.
- Voice names (Buttery, Airy, Mellow, Glassy, Rounded) come only from a third-party guide. An older help-article snippet said voice notes display 'key points in real time as Claude speaks', but the current article doesn't mention it.
- Playful '-ing' waiting words and the Clawd mascot as a greeting are documented for Claude Code, and one Japanese commentary attributes them to the Claude UI generally; this isn't confirmed for claude.ai chat.
- Third-party DESIGN.md token values (coral #cc785c, canvas #faf9f5, Copernicus/Tiempos and Styrene fonts) are reverse-engineered from claude.com marketing pages. The official host tokens (#FAF9F5, #F5F4ED, #141413, Anthropic Sans) differ in places.
- Mythos 5.1 access via the Cyber Verification Program, and its usage rules on Pro and Max, come only from a search snippet of the help article; I couldn't read the full page.
- Reports that the Claude Code Projects waitlist fully opened to Pro/Max on Oct 9, 2026, and that Opus 5.5 became the Claude Code default around Sep 23, 2026, come from third parties only.
- Plan access for Dashboards: the official article says paid plans, while one third-party headline claimed all plans.
- The exact Max 20x web price isn't shown separately on the pricing page ('From $100'). iOS in-app purchase lists $124.99 for Max 5x and $249.99 for Max 20x.
- Claude in Slack help article 12461605 returned 404. Slack context limits (20 channel messages, 50 thread messages) come from the Claude Code Slack docs and search snippets.
- Claude for Outlook details come from a search snippet; the help article itself returned 404 when fetched.

**Features**

- **Unified conversation ('new Claude experience': Chat and Cowork merged)** (chat). You no longer pick between Chat and Cowork. One conversation handles a quick question or a multi-step agentic task, and Claude decides which tools to use (web, files, code, connectors, browser). ([source](https://support.claude.com/en/articles/16761823 ; https://claude.com/blog/cowork-is-now-claude))
- **Permission modes in the message box (Manual / Auto / Skip)** (agents). A per-conversation control for how independently Claude acts. ([source](https://support.claude.com/en/articles/13345190 ; https://support.claude.com/en/articles/16761823))
- **Model menu with effort levels** (chat). A menu next to the send button shows the current model and effort level. Both can be changed at any point in a chat. ([source](https://support.claude.com/en/articles/8664678 ; https://claude.com/pricing))
- **Extended / adaptive thinking display** (chat). Claude can reason before answering. A live 'Thinking' indicator runs while it does, and the reasoning is shown afterwards as a collapsible summary. ([source](https://support.claude.com/en/articles/8664678))
- **Edit, retry and branch** (chat). Edit an earlier prompt or retry an answer without losing the original. ([source](https://support.claude.com/en/articles/17153992 ; https://support.claude.com/en/articles/16761823 ; https://aiuxplayground.com/teardowns/claude/output (third-party)))
- **File and image uploads** (files). Attach documents and images to a chat or to a project. ([source](https://support.claude.com/en/articles/8241126 ; https://support.claude.com/en/articles/10166901))
- **Long context and automatic context management** (chat). Very long conversations keep going because Claude summarises older turns as the context limit approaches. ([source](https://support.claude.com/en/articles/11647753 ; https://support.claude.com/en/articles/12138966-release-notes))
- **Usage limits, Settings > Usage and usage credits** (pricing/limits). Usage is metered in a rolling 5-hour session plus a weekly limit, and paid users can keep working on pay-as-you-go credits. ([source](https://support.claude.com/en/articles/11647753 ; https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans ; https://apps.apple.com/us/app/claude-by-anthropic/id6473753684 ; https://support.claude.com/en/articles/12138966-release-notes))
- **Plans** (pricing/limits). Free, Pro, Max 5x/20x, Team (Standard/Premium) and Enterprise. ([source](https://claude.com/pricing ; https://apps.apple.com/us/app/claude-by-anthropic/id6473753684))
- **Clickable clarifying questions** (chat). When Claude needs more information first, it can show clickable options instead of asking you to type. ([source](https://support.claude.com/en/articles/13641943-visual-and-interactive-content))
- **Rich answer widgets (weather, recipes, sports)** (chat). Structured, interactive cards for common queries. ([source](https://support.claude.com/en/articles/13641943-visual-and-interactive-content))
- **Custom visuals (inline interactive charts and diagrams)** (artifacts/canvas). Claude builds diagrams, flowcharts, charts and small interactive widgets directly inside a reply, not in a side panel. ([source](https://support.claude.com/en/articles/13979539 ; https://claude.com/blog/claude-builds-visuals))
- **Web search, web fetch and image results** (search). Live web search with citations, fetching of specific URLs, and inline image results. ([source](https://support.claude.com/en/articles/10684626))
- **Research (deep research)** (research). An agentic research mode that runs many chained searches across the web and connected sources and writes a cited report. ([source](https://support.claude.com/en/articles/11088861 ; https://support.claude.com/en/articles/16761823))
- **Past-chat search** (memory). Ask Claude to find or continue earlier conversations. ([source](https://support.claude.com/en/articles/11817273))
- **Memory (categorized topics)** (memory). Claude saves individual memory 'topics' during conversations and uses them in later chats and cloud tasks. ([source](https://support.claude.com/en/articles/11817273 ; https://support.claude.com/en/articles/12138966-release-notes))
- **Memory import and export** (memory). Bring memories over from another AI assistant, or export Claude's. ([source](https://support.claude.com/en/articles/12123587))
- **Incognito chats** (chat). Private chats kept out of history and memory. ([source](https://support.claude.com/en/articles/12260368 ; https://support.claude.com/en/articles/16761823))
- **Instructions for Claude, project instructions and styles** (settings). Account-wide standing instructions, plus per-project instructions. Skills now cover response style. ([source](https://support.claude.com/en/articles/10185728))
- **Projects (classic)** (projects). Workspaces with their own chats, knowledge files and instructions. ([source](https://support.claude.com/en/articles/9517075-what-are-projects.md ; https://support.claude.com/en/articles/12111783))
- **Projects redesigned (beta): goal-driven project with coordinator and parallel threads** (projects). A project becomes one ongoing conversation with a 'coordinator' that splits the work into parallel cloud threads and assembles the result. ([source](https://claude.com/blog/projects-redesigned ; https://support.claude.com/en/articles/9517075-what-are-projects.md))
- **Artifacts (new model, Sep 16, 2026)** (artifacts/canvas). Substantial, reusable outputs (docs, decks, designs, dashboards, tools) open in a panel beside the chat, where you can edit, revisit and share them. ([source](https://support.claude.com/en/articles/17153992-what-are-artifacts-and-how-do-i-use-them ; https://www.unite.ai/anthropic-launches-claude-dashboards-and-motion-takes-docs-out-of-beta/))
- **Artifacts that call Claude (AI-powered apps)** (artifacts/canvas). Build small apps that call Claude themselves, with no API keys. ([source](https://support.claude.com/en/articles/17153992-what-are-artifacts-and-how-do-i-use-them ; https://support.claude.com/en/articles/9547008-publishing-remixing-and-sharing-artifacts))
- **Artifact connected apps and persistent storage** (artifacts/canvas). Artifacts can read and write connected apps through MCP and keep data between sessions, which makes journals, trackers and shared tools possible. ([source](https://support.claude.com/en/articles/17153992-what-are-artifacts-and-how-do-i-use-them))
- **Artifact sharing, comments and permissions** (collaboration). Share artifacts privately, inside an org, or by link, with view, comment or edit access. ([source](https://support.claude.com/en/articles/9547008-publishing-remixing-and-sharing-artifacts))
- **Claude Docs** (artifacts/canvas). Living rich-text documents written together with Claude and colleagues in real time. ([source](https://support.claude.com/en/articles/16923645 ; https://support.claude.com/en/articles/17458093))
- **Claude Slides** (artifacts/canvas). Decks drafted from notes or chat content, edited directly, presented from Claude, or exported. ([source](https://support.claude.com/en/articles/17153992-what-are-artifacts-and-how-do-i-use-them ; https://claude.com/blog/cowork-is-now-claude))
- **Claude Design (in-conversation canvas)** (artifacts/canvas). Mockups, prototypes, one-pagers and landing pages on a canvas beside the chat, built to your design system. ([source](https://support.claude.com/en/articles/14604416 ; https://support.claude.com/en/articles/17440474 ; https://claude.com/blog/claude-design-stays-on-brand-for-daily-work))
- **Claude Dashboards (beta)** (artifacts/canvas). Live dashboards built from company data with a plain-language request. ([source](https://claude.com/resources/articles/dashboards-and-motion ; https://support.claude.com/en/articles/17153992-what-are-artifacts-and-how-do-i-use-them))
- **Claude Motion (beta)** (artifacts/canvas). Prompt-to-animation explainers that play like short videos and export as MP4. ([source](https://support.claude.com/en/articles/17454997-get-started-with-claude-motion ; https://claude.com/resources/articles/dashboards-and-motion))
- **File creation and code execution (sandbox)** (files). Claude runs code in a sandbox to create and edit Excel, Word, PowerPoint and PDF files, analyse data and render charts. ([source](https://support.claude.com/en/articles/12111783 ; https://support.claude.com/en/articles/13345190))
- **Skills** (automation). Folders of instructions, scripts and resources that Claude loads automatically when relevant. ([source](https://support.claude.com/en/articles/12512180-using-skills-in-claude ; https://support.claude.com/en/articles/12512198-how-to-create-custom-skills))
- **Record a skill (teach by demonstration)** (automation). Screen-record yourself doing a task while narrating, and Claude turns it into a reusable skill. ([source](https://support.claude.com/en/articles/12512198-how-to-create-custom-skills))
- **Plugins and plugin directory** (integrations). Role packages that bundle skills, connectors, slash commands and sub-agents. ([source](https://support.claude.com/en/articles/13837440 ; https://support.claude.com/en/articles/12138966-release-notes))
- **Connectors (remote MCP) and Connectors Directory** (integrations). Connect Claude to third-party services, either from the directory or by adding any remote MCP server. ([source](https://support.claude.com/en/articles/11175166))
- **Interactive connectors (MCP Apps)** (integrations). Third-party apps render live UI inside the conversation. ([source](https://claude.com/blog/interactive-tools-in-claude ; https://claude.com/docs/connectors/building/mcp-apps/design-guidelines))
- **Google Workspace and Microsoft 365 connectors** (integrations). Gmail, Calendar, Drive and Docs/Sheets/Slides, plus Outlook, OneDrive, SharePoint and Teams data inside Claude. ([source](https://support.claude.com/en/articles/10166901 ; https://claude.com/resources/articles/claude-now-works-in-google-docs-sheets-and-slides ; https://support.claude.com/en/articles/12138966-release-notes))
- **Desktop extensions and local MCP servers** (desktop). One-click local integrations for Claude Desktop. ([source](https://support.claude.com/en/articles/10065433-install-claude-desktop ; https://support.claude.com/en/articles/11175166))
- **Claude in Chrome (browser extension)** (agents). Claude reads, clicks, types and navigates in your Chrome, from a side panel or driven by Desktop or Claude Code. ([source](https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome.md))
- **Local folders, built-in browser and computer use (Claude Desktop)** (desktop). On desktop, Claude works directly on your files, browses in a built-in browser and can operate apps on screen. ([source](https://support.claude.com/en/articles/16761823 ; https://support.claude.com/en/articles/13345190 ; https://support.claude.com/en/articles/10065433-install-claude-desktop))
- **Cloud tasks, sub-agents and progress steering** (agents). Multi-step tasks run on Anthropic's servers with visible progress, and you can steer them midway. ([source](https://support.claude.com/en/articles/13345190))
- **Scheduled tasks** (automation). Recurring or on-demand tasks that run in the cloud without a prompt. ([source](https://support.claude.com/en/articles/13345190 ; https://claude.com/blog/cowork-is-now-claude))
- **Dispatch (phone-to-desktop persistent thread)** (mobile). Message Claude from your phone and it does the work on your desktop, using local files and apps. ([source](https://support.claude.com/en/articles/13947068))
- **Edit drafts in place ('Edit with Claude')** (artifacts/canvas). Highlight part of a draft, type the change, and Claude rewrites only that part in the draft panel. ([source](https://support.claude.com/en/articles/12138966-release-notes ; https://support.claude.com/en/articles/13345190 ; https://aiuxplayground.com/teardowns/claude/output (third-party)))
- **Voice mode** (voice). Two-way spoken conversation with Claude, with tools available. ([source](https://support.claude.com/en/articles/11101966))
- **Quick entry (macOS)** (desktop). A global hotkey opens a floating Claude prompt over any app, with screenshot, window capture and dictation. ([source](https://support.claude.com/en/articles/12626668 ; https://support.claude.com/en/articles/10065433-install-claude-desktop))
- **claude:// deep links** (desktop). Open Claude Desktop to a new prefilled chat, an existing chat or project, or a new Code or Cowork session. ([source](https://support.claude.com/en/articles/14729294-open-claude-desktop-with-a-link))
- **Desktop app platforms** (desktop). Native apps for macOS, Windows and Linux (beta). ([source](https://support.claude.com/en/articles/10065433-install-claude-desktop ; https://claude.com/blog/claude-design-stays-on-brand-for-daily-work))
- **Code tab (Claude Code in the Claude apps)** (coding). Claude Code sessions inside Claude Desktop and the web, plus mobile access through Remote Control and cloud sessions. ([source](https://claude.com/blog/claude-code-desktop-redesign ; https://code.claude.com/docs/en/mobile ; https://support.claude.com/en/articles/17153992-what-are-artifacts-and-how-do-i-use-them))
- **iOS system-app integration and Health** (mobile). Claude acts through native iOS apps via reviewable cards. ([source](https://support.claude.com/en/articles/11869619-use-claude-with-ios-apps))
- **iOS widgets, Control Center, Siri and Shortcuts** (mobile). System-level ways into Claude on iOS 18+. ([source](https://support.claude.com/en/articles/10263469-use-claude-app-intents-shortcuts-and-widgets-on-ios))
- **Android system-app integration and widget** (mobile). Claude drafts in native and third-party Android apps and offers a home-screen widget. ([source](https://support.claude.com/en/articles/11869629-use-claude-with-android-apps ; https://support.claude.com/en/articles/10534883-use-the-claude-widget-on-android ; https://support.claude.com/en/articles/12138966-release-notes))
- **Mobile tasks and artifacts** (mobile). Start, monitor and steer agent tasks from the phone, and view or edit artifacts. ([source](https://support.claude.com/en/articles/16761823 ; https://www.macrumors.com/2026/07/07/claude-cowork-mobile-web/ ; https://apps.apple.com/us/app/claude-by-anthropic/id6473753684))
- **Chat sharing (people or public link)** (collaboration). Share a read-only snapshot of a chat by email invite or public link. ([source](https://support.claude.com/en/articles/16762496-share-a-chat-with-specific-people ; https://support.claude.com/en/articles/16762437))
- **Appearance settings** (settings). Theme and chat-font controls. ([source](https://support.claude.com/en/articles/8887527))
- **Reflect: monthly recap (beta)** (settings). A personal monthly summary of how you used Claude. ([source](https://support.claude.com/en/articles/15672559-see-your-monthly-recap))
- **Time and focus: break reminders and quiet hours (beta)** (settings). Optional wellbeing controls. ([source](https://support.claude.com/en/articles/15672868-set-break-reminders-and-quiet-hours))
- **Claude for Microsoft 365 (Excel, PowerPoint, Word, Outlook add-ins)** (integrations). Claude in a sidebar inside Office apps, sharing conversation context across them. ([source](https://support.claude.com/en/articles/12650343 ; https://support.claude.com/en/articles/13521390 ; https://www.claude.com/docs/office-agents/word ; https://support.claude.com/en/articles/12138966-release-notes))
- **Claude for Google Workspace add-on (public beta, Oct 6, 2026)** (integrations). Claude in a sidebar inside Google Docs, Sheets and Slides. ([source](https://claude.com/resources/articles/claude-now-works-in-google-docs-sheets-and-slides))
- **Claude in Slack (@Claude and Claude Tag)** (integrations). Tag Claude in Slack to answer questions or take on tasks, including handing coding to Claude Code. ([source](https://code.claude.com/docs/en/slack ; https://support.claude.com/en/articles/12138966-release-notes ; https://claude.com/pricing))
- **Claude Science (beta)** (research). A research workbench for scientists inside the Claude product family. ([source](https://www.anthropic.com/news/claude-science-ai-workbench))
- **Admin and enterprise controls** (settings). Org-level governance across models, connectors, skills, artifacts and data. ([source](https://support.claude.com/en/articles/12138966-release-notes ; https://claude.com/pricing))

### Claude Code (CLI, Desktop Code tab, web/cloud, mobile, VS Code, JetBrains, GitHub Actions/Code Review) and Claude Cowork (now merging into the unified Claude app)

As of 2026-10-15. 80 features catalogued.

**Standout details**

- Queued messages are delivered within the same turn as soon as current tool calls finish, and Ctrl+Enter sends now by moving running work to the background instead of killing it.
- Ctrl+C on a draft, then Up on the empty prompt, brings the draft back, including pasted text and images; Ctrl+S stashes and restores a prompt with its input mode.
- Double-Esc clears the input but saves the draft to history; on an empty prompt it opens rewind instead.
- Permission prompts accept a Tab comment, so you can approve and add a note, or deny with a reason, without breaking flow.
- Pasted text is silently cleaned of invisible Unicode (tag characters, bidi controls, zero-width spaces). If anything is removed, Enter doesn't send, and a notice asks you to review.
- Pasted content is marked to the model as pasted rather than typed, so instructions hidden inside a paste are treated as untrusted.
- /btw side questions cost almost nothing on a warm cache, see the full context, and can be forked into a tool-using subagent with one key (f).
- The prompt-cache countdown clock in VS Code shows minutes left and turns red when the cache has likely expired, hinting that the next message will be slower and more expensive.
- Session recap and the attach recap tell you what happened while you were away, without you asking.
- Auto-continue after a usage limit resumes the interrupted task by itself and handles laptop sleep sensibly.
- Agent view's PR label color tells you when a task is mergeable (green) without opening it.
- Claude remembers your last /code-review effort level across sessions and tells you it reused it.
- Plan accept automatically titles the session from the plan.
- Deep links pre-fill a prompt but never send it, and warn when the prompt came from an external link.
- Desktop scheduled tasks catch up exactly once after sleep and explain each skipped run on hover.
- Desktop auto-verify takes screenshots and clicks through your app after edits before Claude reports done.
- The /diff 'ask' button attaches one file's diff to your next prompt; per-turn views (T1, T2) isolate what each prompt changed.
- Emoji :shortcodes:, spellcheck underlines, readline-correct word motions that also work in CJK text, and Vim mode in the prompt.
- /powerup animated lessons, /insights HTML report on your habits, and /team-onboarding guide generation.
- Cowork's 'Edit with Claude' on a highlighted passage in a Markdown draft edits in place without describing the location.
- Cowork cookie import is per site, with banking, email and SSO unchecked by default.
- Cowork deletion protection always asks before permanently deleting files, in every mode.
- Community attachment to small delightful touches: a top-voted GitHub issue asks to bring back the /buddy terminal companion removed in v2.1.97.
- /radio (Claude FM lo-fi), /stickers and themed spinner verbs add personality without getting in the way.

**Design patterns**

- **Bottom-anchored composer that holds the whole session config.** In Desktop the prompt box holds environment (Local/Cloud/SSH/WSL), project folder, model dropdown next to Send, permission-mode selector, a + menu (attachments, slash commands, connectors, plugins) and a usage ring. VS Code puts the mode indicator and model/effort button at the bottom of the prompt box. In CLI fullscreen the input stays fixed at the bottom.
- **Sessions sidebar as mission control.** Desktop and web share a sidebar of active and recent sessions (Pinned / Scheduled / Recents), with filters by status, project and environment, grouping by project, archive on hover, and auto-archive when a PR merges. VS Code adds named collapsible groups and Active / Needs input / Working / Completed filters.
- **Drag-and-drop pane grid with pop-out windows.** Chat, diff, browser, terminal, file editor, plan, tasks, subagent and simulator are equal panes you rearrange into any grid, resize by dragging edges, close with Cmd+\, and pop out to a second screen. The title bar has Terminal/Changes/Browser buttons that collapse into a ⋮ menu when the window is narrow.
- **State grouped by what needs you.** Agent view groups rows as Pinned > Ready for review > Needs input > Working > Completed, with … N more truncation. Each row is a state icon, name tinted by /color, a one-line model summary, a PR label and age. The terminal tab title shows a count of sessions awaiting input.
- **Peek before attach.** Space opens a peek panel showing only the truncated sentence, the pending question with numbered choices, linked PRs and time waiting. You can reply inline or attach for the full transcript, which progressively discloses detail.
- **Three transcript density levels.** Desktop has Normal (tool calls collapsed into summaries), Thinking and Verbose. The CLI has a transcript viewer (Ctrl+O) and /focus, which shows only the last prompt, a one-line tool summary with diffstats and the final answer. VS Code Focus view hides tool calls behind expandable rows but keeps the to-do list and pending questions visible.
- **Collapsed, clickable tool output.** Repeated MCP calls fold into one line (for example 'Called slack 3 times'), messages from other sessions show as one-line previews, and long pastes collapse to '[Pasted text #1 +120 lines]'. Images appear as [Image #N] chips. Everything expands on click or with Ctrl+O.
- **Numbered permission prompts with optional comments.** Prompts list numbered Yes / Yes-for-session / No options; Tab opens a comment field on Yes or No that is sent as context or as the denial reason. When several requests stack, the prompt shows a count like '2 of 5'. A No without a comment stops the turn. Desktop site approvals use Allow once / Always allow / Deny cards.
- **Diff-first review with inline comments.** Every surface shows a +N −M diff indicator that opens a file-list plus diff view. You click lines to comment and batch-submit with Cmd+Enter. Review findings render as a card with Walk through in diff, Fix this one and Apply fixes. VS Code has per-change Accept/Reject buttons.
- **Footer status chips.** The CLI footer shows a PR badge whose colored underline encodes review state (green approved, yellow pending, red changes requested, gray draft), an MR !N badge for GitLab, '/rc active', and a '← N agents' hint. Desktop shows a CI status bar with Auto-fix and Auto-merge toggles.
- **Ghost-text prompt suggestions.** A gray suggested next prompt sits in the empty composer; Tab or → accepts it and typing dismisses it. The first-run example comes from your git history. Mid-prompt / completion shows ghost text with a +N count, or a dropdown in fullscreen.
- **Branded inline callout blocks.** Explanatory style uses '★ Insight ───' blocks, Learning style uses '● Learn by Doing' with Context / Your Task / Guidance, and You should know shows '✦ Heads up' notes with numbered actions. The ✻ asterisk glyph is the product mark (status bar item, agent icons).
- **Overlays that stay out of history.** /btw answers appear in a dismissible overlay with up to five earlier questions dimmed above, Shift+arrows to step through history, and c to copy raw Markdown. Desktop side chats read the thread but never write back to it.
- **Context and cache made visible.** Usage ring (Desktop), context indicator and a prompt-cache countdown clock that turns red when the cache has likely expired (VS Code), a colored /context grid, and status-line fields for cache, rate limits and spend.
- **Task checklist and agent tree.** Ctrl+T toggles Claude's to-do list, showing up to five items with pending, in-progress and complete markers. The subagent panel below the prompt shows nested agents as a tree with (+N) descendant counts. VS Code's agent map shows each agent's status, elapsed time and tokens.
- **Empty-state onboarding.** VS Code shows a 'Learn Claude Code' checklist with 'Show me' buttons and a walkthrough. The CLI offers /powerup lessons and an example command drawn from git history. The Cowork home is one shared message box for chat and tasks.
- **Most precise tool first.** For computer and browser work, both Claude Code and Cowork prefer connector, then shell, then browser, then simulator, then screen control. Per-app tiers (view-only, click-only, full) push Claude toward dedicated tools.
- **Task chips and cross-session cards.** Claude offers out-of-scope work as clickable chips that start a new worktree session. Messages between sessions arrive as attributed cards with a link back to the sender.
- **Unified chat and task home (Cowork merge).** There is no Chat/Cowork toggle: one composer and a single Recents list for quick answers and long tasks. Files Claude creates appear alongside the conversation. The permission setting (Auto/Manual) lives in the message box. Artifacts (Docs/Slides/Design) live at one shareable link where you can select an element and move it.
- **Typography and width control in the terminal.** maxProseWidth wraps prose while tables and code keep full width. Themes are token-based (claude, warning, permission, promptBorder, inactive, fastMode, each with shimmer variants) in auto light/dark, daltonized or ANSI forms.
- **Hover-revealed affordances in VS Code.** Hovering a response reveals Copy response, Bookmark and a rewind button with three fork/rewind options. Tab dots signal state: blue for a pending permission, orange for finished while hidden.

**Motion patterns**

- **Spinner with rotating verbs and a live counter.** While a turn runs, the spinner line cycles whimsical verbs (customizable with spinnerVerbs) and appends elapsed time and a live output-token count, for example 'Deciphering… (10m 27s · ↓ 5.5k tokens)'. The arrow points down while output streams or tools run. Hooks can set a custom statusMessage, and mods can append to or replace the spinner.
- **Shimmer gradient on brand tokens.** The spinner uses an animated gradient between each base token and its lighter shimmer variant (claudeShimmer, warningShimmer, permissionShimmer, promptBorderShimmer, inactiveShimmer, fastModeShimmer). Custom themes override both colors.
- **Rainbow ultrathink keyword.** Typing 'ultrathink' renders the word in a seven-color rainbow gradient (rainbow_<color> plus _shimmer tokens) right in the input as feedback.
- **Animated state icons in agent view.** Working sessions show an animated ✽. Static ✻ means running or waiting, ∙ means exited, ✢ is a sleeping /loop with a live countdown ('in 4m'). Color marks state: yellow, green, red, grey or dim.
- **Attention flashes on agent counts.** The '← N agents' footer hint briefly changes color when the count moves or an agent completes, and briefly shows '← 2 done' when background sessions finish. It refreshes about every 10 seconds, or immediately when focus returns. prefersReducedMotion turns the flashes off.
- **Microphone-reactive cursor.** During voice dictation the prompt cursor becomes a bar that rises and falls with microphone level. The footer moves from 'keep holding…' (warmup while key-repeat is detected) to 'listening…'. Reduced motion removes the bar.
- **Flicker-free streaming in the alternate screen.** Fullscreen rendering redraws only visible messages, so streaming output doesn't jump the scroll position or flash. The input box stays put while text streams above it.
- **Auto-follow with a jump-to-bottom pill.** Scrolling up pauses auto-follow. A floating 'Jump to bottom' button shows an accumulating 'N new messages' count, and a finished stream doesn't yank the view back down. A sticky dim header shows the last prompt that scrolled off.
- **Hover and pressed states in a terminal UI.** In fullscreen, list rows highlight on hover, the 'N more' rows have hover and pressed states, scrollbars appear only while the pointer is over a list, scrollbar arrows repeat while held, and links are underlined under the pointer.
- **Gray-until-acknowledged messages.** Sent and queued messages render gray until the model starts responding to them, giving quiet feedback about delivery.
- **Live-updating row summaries.** Agent-view row text refreshes from session output at most every 15 seconds and is rewritten by a small model at the end of each turn and every few minutes during long turns, so rows read like a live ticker without flicker.
- **Self-refreshing diff panel.** The /diff panel opens automatically when Claude starts editing (at 144+ columns) and refreshes on each edit or shell command, so changes visibly build up during a turn.
- **Transient rows with timed dismissal.** Finished subagent rows disappear immediately and a '/tasks to see subagents' hint shows for 30 seconds. Failed or stopped rows stay for 30 seconds. 'Dismissed. Turn off suggestions' clears after 20 seconds.
- **Watch-the-agent live media.** The iOS Simulator pane streams the device screen live while Claude taps. The Desktop Browser pane and Cowork's side-panel browser show Claude clicking and typing in real time. Chrome actions run in a visible window and can be recorded as GIFs.
- **Live progress across devices.** Remote Control mirrors the transcript, compaction progress, subagents and workflows to phone and browser in real time. Cowork shows progress indicators per step and push notifications when done or blocked.
- **Usage-limit countdown states.** Footer lines move through states: limit reached and reset time, continuing automatically at a set time, continuing shortly, then a 'Usage limit reset · continuing automatically' line in the transcript.
- **Animated lessons.** /powerup teaches features through quick interactive lessons with animated demos.
- **Reduced-motion and screen-reader fallbacks.** prefersReducedMotion reduces or removes spinners, shimmer and other animations. Screen reader mode replaces animations and in-place redraws with labeled linear text. VS Code reads a text label in place of the spinner.
- **Program Status Protocol for terminal tabs.** Claude Code reports working, waiting or done through OSC 7501, so supporting terminals can animate or badge tabs per session.

**Weaknesses**

- Usage limits are the dominant complaint. The most-reacted GitHub issues are about Max plans hitting limits almost instantly (#16157, about 1.5k comments) and session limits draining abnormally fast after March 23, 2026 (#38335). The Register and DevClass report Anthropic acknowledging users hit limits faster than expected.
- Agentic Cowork and ultracode/workflow runs use limits much faster than chat, and Anthropic's own pages warn about this.
- Terminal flicker and scroll-jumping was a long-standing complaint (#769, #1913, #826). Fullscreen rendering fixes it, but it is still labeled a research preview and changes native selection, search and scrollback behavior.
- Feature sprawl and complexity: around 100 slash commands, five overlapping parallelism models (subagents, agent view, agent teams, workflows, projects), and many version-gated behaviors make it hard to discover what is available.
- Many features are limited by plan or provider. Computer use, Dispatch, Remote Control and Chrome are missing or limited on Team/Enterprise or third-party providers. Agent teams are experimental, CLI-only and disabled by default.
- Checkpoints don't cover Bash-made changes or most subagent edits, so rewind is incomplete.
- Cowork's October 6, 2026 switch to cloud-only for Pro/Max removed local-only execution with no way back. Privacy-minded users are pointed to Claude Code instead, and local files opened in tasks are processed on Anthropic's servers.
- The unified Claude experience removes conversation branching, doesn't support Add from GitHub, opens incognito chats in the old experience, and search excludes older Cowork tasks. Dispatch is closed to new users and limited to one thread.
- Cowork sessions can't be shared (only artifacts), and pre-August 19 live artifacts are desktop-only and can't be edited in place.
- A user report (#22543) says local Cowork created a 10GB VM bundle that degraded Desktop performance.
- Multi-account switching is missing in Desktop and mobile (#18435, #36151), and multiple accounts for the same connector aren't supported (#27302).
- Desktop on Windows: a reported always-on-top window bug (#85891). Users requested multi-window support (#30154; pane pop-out partly addresses it).
- Cloud sessions require GitHub to clone and open PRs; GitLab/Bitbucket only work as a bundle that can't push back. IP-allowlisted orgs can't use Anthropic-hosted cloud sessions, Code Review or routines.
- Auto mode boundaries are re-read from the transcript and can be lost after compaction, so a hard guarantee needs a deny rule.
- Model verbosity complaints, such as verbose code comments that ignore instructions (#65961), and reports of cache-creation token inflation between versions (#46917).
- Unannounced removals frustrate users: /buddy disappeared in v2.1.97 with no changelog entry (#45596), and /ultraplan and /vim were removed.
- Code Review costs $15–25 per PR on average, and ultrareview costs $5–25 after three one-time free runs; both bill as extra usage credits.

**Not verified**

- Cowork's launch history (research preview January 12, 2026; Windows launch February 10, 2026; general availability around April 2026) comes from third-party coverage (VentureBeat, TechCrunch, Substack, DataCamp), not a primary source I read.
- Claude Dashboards and Claude Motion: the October 8, 2026 beta launch and that Docs, Slides and Design left beta and reached every plan are confirmed only by a related-article teaser on claude.com. Plan restrictions (Motion on Team/Enterprise only), supported data sources (Redshift, BigQuery, ClickHouse, Databricks, Snowflake, Salesforce) and MP4 export come from secondary sites.
- Fast mode for Opus 5.5 being 2.5x faster at $8/$40 per MTok, and Max plans including API credits ($100 or $200), come from a summarizer's reading of claude.com/product/claude-code. The docs I read list $10/$50 for fast mode on Opus 5 and 4.8.
- The Cowork product page's announcement dates (private plugin marketplaces February 24, enterprise controls April 9, built-in browser August 26, 2026) were read through a summarizer, not verified line by line.
- The 10GB Cowork VM bundle and the cache-token inflation between versions are individual user reports on GitHub, not confirmed by Anthropic.
- The claim that the Claude Code desktop redesign is live for all plans and shipped with Routines comes from secondary coverage; the official April 14, 2026 post confirms the redesign features only.
- I didn't open the specific spinner verb list, exact color hex values, typography, or easing curves; official docs don't publish motion timings beyond the documented intervals (15-second row refresh, 10-second count refresh, 30-second and 20-second dismissals).
- I didn't research Claude Tag (the org-wide @Claude in Slack) in detail beyond the Claude Code docs warning that describes it.

**Features**

- **Agentic loop in the terminal (CLI)** (coding). Claude reads the codebase, edits files, runs shell commands and works with git from a terminal session started with `claude`. ([source](https://code.claude.com/docs/en/overview))
- **Permission modes (Manual, Accept edits, Plan, Auto, dontAsk, Bypass)** (coding). A session-level setting that decides which actions run without asking. ([source](https://code.claude.com/docs/en/permission-modes))
- **Auto mode classifier** (coding). A background classifier replaces most permission prompts and blocks risky actions. ([source](https://code.claude.com/docs/en/permission-modes))
- **Plan mode and plan approval** (coding). Claude explores and writes a plan without editing source until you approve it. ([source](https://code.claude.com/docs/en/permission-modes))
- **Checkpoints and /rewind** (coding). Automatic snapshots of Claude's file edits before every prompt that starts a turn, with rewind and summarize options. ([source](https://code.claude.com/docs/en/checkpointing))
- **Session management (resume, name, branch, fork, export)** (coding). Named and searchable sessions you can resume, branch or copy into the background. ([source](https://code.claude.com/docs/en/sessions))
- **Queued messages and send-now** (coding). Type while Claude works; messages queue instead of interrupting. ([source](https://code.claude.com/docs/en/interactive-mode))
- **Shell mode (! prefix) with an auto-response** (coding). Run a shell command yourself, add its output to context, and get an automatic explanation. ([source](https://code.claude.com/docs/en/interactive-mode))
- **Background Bash tasks and the Monitor tool** (coding). Long commands run asynchronously and Claude can tail their output. ([source](https://code.claude.com/docs/en/interactive-mode))
- **Side questions (/btw)** (coding). Ask about the session without adding to the conversation history. ([source](https://code.claude.com/docs/en/interactive-mode))
- **/diff live panel and diff dialog** (coding). Review working-tree changes and per-turn edits without leaving the CLI. ([source](https://code.claude.com/docs/en/interactive-mode))
- **Local /code-review (alias /review) and /security-review** (coding). Reviews the diff for correctness bugs in a background subagent and returns findings. ([source](https://code.claude.com/docs/en/code-review))
- **Ultrareview (/code-review ultra)** (coding). A fleet of reviewer agents runs in a cloud sandbox and reproduces each finding. ([source](https://code.claude.com/docs/en/ultrareview))
- **Model choice, effort levels, ultrathink and ultracode** (coding). Choose the model and how much reasoning it uses. ([source](https://code.claude.com/docs/en/model-config))
- **Fast mode** (coding). Faster Opus output at a higher price per token. ([source](https://code.claude.com/docs/en/fast-mode))
- **Output styles (Default, Proactive, Concise, Explanatory, Learning, custom)** (coding). Changes Claude's role, tone and response format. ([source](https://code.claude.com/docs/en/output-styles))
- **/goal completion conditions** (coding). Claude keeps taking turns until a separate model judges the condition met or impossible. ([source](https://code.claude.com/docs/en/goal))
- **Subagents (built-in and custom)** (agents). Delegated workers with their own context that return a summary. ([source](https://code.claude.com/docs/en/sub-agents))
- **Forks and fork mode (/subtask)** (agents). A subagent that inherits the whole conversation and shares the prompt cache. ([source](https://code.claude.com/docs/en/sub-agents))
- **Agent view (claude agents)** (agents). One full-terminal table to dispatch and supervise background sessions. ([source](https://code.claude.com/docs/en/agent-view))
- **Agent teams (experimental)** (agents). A lead session coordinates teammates that share a task list and message each other. ([source](https://code.claude.com/docs/en/agent-teams))
- **Dynamic workflows (/workflows, /deep-research, /batch)** (agents). A JavaScript script that Claude writes, which orchestrates dozens to hundreds of subagents in the background. ([source](https://code.claude.com/docs/en/workflows))
- **Cross-session messaging** (agents). Your Claude sessions can list and message each other, on the same machine, other machines, or in the cloud. ([source](https://code.claude.com/docs/en/cross-session-messaging))
- **Git worktrees** (agents). Isolated checkouts so parallel sessions don't collide. ([source](https://code.claude.com/docs/en/worktrees))
- **Projects (Claude Code on web/desktop, public beta)** (agents). One ongoing conversation where Claude starts and tracks parallel cloud threads. ([source](https://code.claude.com/docs/en/claude-projects))
- **Hooks (settings hooks)** (automation). Deterministic handlers on lifecycle events. ([source](https://code.claude.com/docs/en/hooks))
- **Skills and custom slash commands** (automation). SKILL.md instruction packages, loaded by Claude when relevant or run as /name. ([source](https://code.claude.com/docs/en/skills))
- **Plugins and marketplaces** (automation). Installable bundles of skills, agents, hooks, MCP and LSP servers, themes, output styles and mods. ([source](https://code.claude.com/docs/en/plugins/overview))
- **Mods (JavaScript hooks modules)** (automation). Plugins that run inside Claude Code and can draw interface and intercept events. ([source](https://code.claude.com/docs/en/plugins/mods/overview))
- **MCP servers, connectors, tool search** (integrations). Connect external tools over the Model Context Protocol. ([source](https://code.claude.com/docs/en/mcp))
- **Routines (cloud scheduled/API/GitHub-triggered agents)** (automation). Saved prompts with repos and connectors that run autonomously in the cloud. ([source](https://code.claude.com/docs/en/routines))
- **/loop and session cron tools** (automation). Repeat a prompt within an open session, or set reminders. ([source](https://code.claude.com/docs/en/scheduled-tasks))
- **Desktop scheduled tasks (local routines)** (automation). Recurring sessions that run on your machine with access to local files. ([source](https://code.claude.com/docs/en/desktop-scheduled-tasks))
- **Channels (push events into a session)** (automation). MCP servers that push chat messages, CI results or webhooks into a running session, with replies sent back. ([source](https://code.claude.com/docs/en/channels))
- **Headless / print mode and Agent SDK** (automation). Scriptable runs and a library for building your own agents. ([source](https://code.claude.com/docs/en/headless))
- **Deep links (claude-cli://)** (automation). A URL opens a terminal session in a chosen repo with the prompt pre-filled but not sent. ([source](https://code.claude.com/docs/en/deep-links))
- **GitHub Actions (@claude) and GitLab CI/CD** (integrations). Run Claude in your own CI to answer @claude, turn issues into PRs and review code. ([source](https://code.claude.com/docs/en/github-actions))
- **Managed Code Review (GitHub PRs)** (integrations). Multi-agent review on Anthropic infrastructure, posted as inline comments. ([source](https://code.claude.com/docs/en/code-review))
- **PR auto-fix and CI monitoring** (integrations). Claude watches a PR and pushes fixes for CI failures and review comments. ([source](https://code.claude.com/docs/en/claude-code-on-the-web))
- **Desktop Code tab: parallel sessions and pane workspace** (desktop). A GUI for Claude Code with a sessions sidebar and drag-and-drop panes. ([source](https://code.claude.com/docs/en/desktop))
- **Visual diff review with line comments** (desktop). File-list diff viewer where you comment on lines and submit the batch. ([source](https://code.claude.com/docs/en/desktop))
- **Browser pane: app preview, auto-verify and external sites** (desktop). Built-in tabbed browser where Claude runs your dev server and checks its own changes. ([source](https://code.claude.com/docs/en/desktop))
- **iOS Simulator pane** (desktop). Streams a per-session simulator live while Claude builds, taps through and checks your app. ([source](https://code.claude.com/docs/en/desktop-ios-simulator))
- **Computer use (Desktop and CLI)** (desktop). Claude opens native apps, clicks, types and takes screenshots. ([source](https://code.claude.com/docs/en/desktop))
- **Side chats, task chips, managing other sessions** (desktop). Branch a question off the main thread, spawn suggested work, and have Claude manage other sessions. ([source](https://code.claude.com/docs/en/desktop))
- **Suggested next prompt** (desktop). Gray ghost-text suggestion of your likely next prompt. ([source](https://code.claude.com/docs/en/interactive-mode))
- **Desktop keyboard shortcuts** (desktop). Keyboard control of sessions, panes and menus. ([source](https://code.claude.com/docs/en/desktop))
- **SSH and WSL sessions, local env editor** (desktop). Run the agent on remote machines or inside WSL with the Desktop UI. ([source](https://code.claude.com/docs/en/desktop))
- **Auto-continue after usage limit** (desktop). Waits in the session and continues automatically when the limit resets. ([source](https://code.claude.com/docs/en/interactive-mode))
- **Prompt history search** (search). Search past prompts across sessions and projects. ([source](https://code.claude.com/docs/en/interactive-mode))
- **Fullscreen (flicker-free) renderer** (settings). Alternate-screen rendering with mouse support and flat memory use in long conversations. ([source](https://code.claude.com/docs/en/fullscreen))
- **Status line, themes, keybindings, terminal integration** (settings). Deep customization of the terminal UI. ([source](https://code.claude.com/docs/en/terminal-config))
- **/config key=value, /doctor, /context, /usage, /insights** (settings). Introspection and repair tools. ([source](https://code.claude.com/docs/en/commands))
- **CLAUDE.md, rules and auto memory** (memory). Persistent instructions plus notes Claude writes for itself. ([source](https://code.claude.com/docs/en/memory))
- **Bash sandbox** (settings). OS-enforced filesystem and network boundary for shell commands. ([source](https://code.claude.com/docs/en/sandboxing))
- **Voice dictation** (voice). Speak prompts with hold-to-record or tap-to-record. ([source](https://code.claude.com/docs/en/voice-dictation))
- **Remote Control** (mobile). Drive a session running on your machine from claude.ai/code or the Claude app. ([source](https://code.claude.com/docs/en/remote-control))
- **Claude app Code tab and Dispatch** (mobile). Start and steer cloud sessions, projects, Remote Control sessions, or message Dispatch from a phone. ([source](https://code.claude.com/docs/en/mobile))
- **Cloud sessions (Claude Code on the web) and teleport** (coding). Sessions on Anthropic-managed VMs or self-hosted runners that keep running when your laptop is closed. ([source](https://code.claude.com/docs/en/claude-code-on-the-web))
- **VS Code extension** (integrations). A graphical chat panel inside VS Code and Cursor. ([source](https://code.claude.com/docs/en/vs-code))
- **JetBrains plugin** (integrations). Runs the CLI in the IDE terminal with IDE integration. ([source](https://code.claude.com/docs/en/jetbrains))
- **Claude in Chrome from Claude Code** (integrations). Browser automation in your real, logged-in Chrome. ([source](https://code.claude.com/docs/en/chrome))
- **Artifacts from Claude Code** (artifacts/canvas). Publishes a live, interactive page on claude.ai that updates in place as the session works. ([source](https://code.claude.com/docs/en/artifacts))
- **Slack (@Claude) and Claude Tag** (integrations). Mention @Claude in Slack and it routes coding requests to cloud sessions and returns PRs. ([source](https://code.claude.com/docs/en/slack))
- **Security tooling plugins** (coding). Self-review and full codebase vulnerability scanning. ([source](https://code.claude.com/docs/en/claude-security))
- **You should know (built-in mod, opt-in)** (settings). A side agent occasionally rereads the conversation and flags one thing you may have missed. ([source](https://code.claude.com/docs/en/interactive-mode))
- **Session recap** (settings). A one-line summary of what happened while you were away. ([source](https://code.claude.com/docs/en/interactive-mode))
- **Accessibility: screen reader mode and reduced motion** (settings). A linear text interface for VoiceOver/NVDA plus motion and color options. ([source](https://code.claude.com/docs/en/accessibility))
- **Plans and usage** (pricing/limits). Subscription plans with shared usage limits across surfaces; usage credits for overage. ([source](https://www.claude.com/product/claude-code))
- **Cowork: hand off whole tasks (now inside unified Claude)** (automation). Knowledge-work agent built on Claude Code's architecture with no terminal. You describe an outcome and get finished files back. ([source](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork))
- **Cowork cloud execution and local reach** (automation). Sessions run in isolated, temporary cloud sandboxes and reach your computer through the Desktop app. ([source](https://support.claude.com/en/articles/15520349-use-claude-cowork-on-web-desktop-and-mobile))
- **Cowork permission modes (Manual / Auto / Skip)** (automation). Controls when Claude asks before acting. ([source](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork))
- **Cowork scheduled tasks** (automation). Recurring or on-demand tasks that run in the cloud with no device online. ([source](https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-cowork))
- **Cowork projects** (projects). Workspaces with their own instructions, files, links, scheduled tasks and memory. ([source](https://support.claude.com/en/articles/14116274-organize-your-tasks-with-projects-in-cowork))
- **Cowork built-in browser and Chrome side panel** (automation). Claude browses in a side-panel browser inside Desktop, or in your Chrome. ([source](https://support.claude.com/en/articles/16607400))
- **Cowork computer use** (automation). Claude uses desktop apps by clicking, typing and taking screenshots when no connector or browser path exists. ([source](https://support.claude.com/en/articles/14128542-let-claude-use-your-computer-in-cowork))
- **Cowork Dispatch (legacy)** (mobile). A single persistent thread from your phone that runs work on your desktop. ([source](https://support.claude.com/en/articles/13947068-assign-tasks-from-anywhere-in-claude-cowork))
- **Cowork shared memory and instructions** (memory). Cloud Cowork shares chat memory; global and folder instructions. ([source](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork))
- **Cowork admin and enterprise controls** (collaboration). Organization toggles and observability. ([source](https://support.claude.com/en/articles/13455879-use-claude-cowork-on-team-and-enterprise-plans))
- **Cowork surface availability matrix** (surfaces). Which features work on desktop, web and mobile. ([source](https://support.claude.com/en/articles/15520349-use-claude-cowork-on-web-desktop-and-mobile))

### T3 Chat (t3.chat) and T3 Code (t3.codes, the product people call "T3.Codes"), from Theo Browne / Ping Labs, published as T3 Tools Inc. As of 2026-10-15, "T3.Codes" is T3 Code, not a separate product. The domain t3.codes is T3 Code's homepage, the hosted web client is app.t3.codes, and the installer runs from t3.codes/install.sh. T3 Code is a free, MIT-licensed, open-source "control plane for coding agents" (repo pingdotgg/t3code, created 2026-02-08, about 27.8k stars). It drives coding-agent CLIs and harnesses (Codex, Claude Code, Cursor, Grok Build, OpenCode, Antigravity, Pi, Muse Code, and ACP Registry agents) on your own machines. You use it from an Electron desktop app, a web app, a CLI server, and iOS/Android companion apps. T3 Chat is the separate subscription multi-model chat app ($8/mo Pro, $50/mo Premier), with T3 Canvas for image generation.

As of 2026-10-15. 58 features catalogued.

**Standout details**

- T3 Chat: one-click 'Boring Theme' turns down the signature pink without losing the layout.
- T3 Chat: 'Stats for Nerds' shows tokens/sec, time to first token and token counts on each message.
- T3 Chat: 'Hide Personal Information' hides name and email for streaming and screen sharing.
- T3 Chat: URL-launch API (/new?q=&model=&effort=&search=&search_limit=&profile=&temporary=) works as a browser search engine.
- T3 Chat: 'Branch to temporary chat' explores a tangent without polluting history, and 'Convert to stored chat' keeps it if it turns out useful.
- T3 Chat: shared threads show view and fork counts; visitors continue in their own fork.
- T3 Chat: BYOK Priority/Fallback per model plus automatic BYOK fallback for over-length threads.
- T3 Chat: interactive Mermaid viewer with pan, zoom, fit, and copy as PNG or code.
- T3 Chat: accessibility font choices (Atkinson Hyperlegible, OpenDyslexic, Intel One Mono) plus density control and a live preview.
- T3 Chat: the FAQ explains the reserve-then-settle meter with a worked points example, which is unusually transparent.
- T3 Chat Canvas: transparent-PNG option, 4K AI upscale, enhanced-prompt reveal and side-by-side multi-model generation.
- T3 Code: 5-second Undo toast on every thread state change, with mod+z.
- T3 Code: rate-limit-aware threads that auto-resume or snooze until the provider's quota resets.
- T3 Code: Usage → Limits pools every account into one segmented bar and shows how much the next reset hands back.
- T3 Code: shift-click several models to race the same prompt in separate worktrees.
- T3 Code: prompt links strip invisible Unicode and warn about possible prompt injection.
- T3 Code: SnapShots, a double-Shift capture of any window with its accessibility tree for the agent.
- T3 Code: live iOS Simulator and Android Emulator inside the app, with a 3D foldable view, that agents can also drive.
- T3 Code: agents watch or babysit a PR and are woken on CI failure, review or merge conflict.
- T3 Code: AI review guides tour a PR in reading order with 'Look closely' stops.
- T3 Code: inline HTML 'visual replies' that inherit the current theme; users singled this out in Oct 2026.
- T3 Code: VS Code and OpenVSX theme import plus a theme editor with an on-screen color picker.
- T3 Code: drag a thread from the sidebar onto the composer to give the agent another conversation as lazy context.

**Design patterns**

- **T3 Chat: three-zone layout with inset main canvas.** A full-height left sidebar holds the 'T3.chat' wordmark, a Canvas shortcut icon, a prominent filled pink 'New Chat' button, a thread search field, date-grouped threads, and a profile/Login footer. The main chat surface sits inset with a large rounded top-left corner, so the sidebar reads as the background layer. Two floating icon buttons at the top right toggle temporary chat and open settings. The sidebar collapses with Mod+B.
- **T3 Chat: docked composer with pill controls.** The composer is centered (max-w-3xl) and docked at the bottom, with a thick translucent outline ring (outline-8 using a chat-input-gradient token at 50% opacity). The input sits above a row of compact pills: model name with cost glyph and chevron, Instant/Thinking mode, Search, Attach. A square accent-colored send button sits at the right and stays disabled with an accessible 'Message requires text' label until there is input. On mobile the pills collapse into a '+' menu and the corner radius becomes 22px.
- **T3 Chat: dense, scannable model picker.** Popover over the composer. A paywall banner sits on top, then search with a filter-funnel button, a vertical provider-logo rail on the left (favorites first), and rows of model name, cost glyph, NEW badge, star, capability icons and info button with a one-line description under each. An info click opens a side sheet with specs and benchmark charts. Legacy models fold into a count row per provider.
- **T3 Chat: cost transparency glyphs.** Relative cost is shown as dollar glyphs (··· / $·· / $$· / $$$ / $$$+) instead of credit numbers. Tooltips use plain language ('Can use up your usage limit much faster'), and a warning appears when one message is estimated to be expensive.
- **T3 Chat: playful but restrained brand.** Pink/magenta primary (#e33f86 light) over lavender backgrounds (#f2e1f4 light, #1c121a dark chrome), set in ProximaVara with Berkeley Mono for code. A one-switch 'Boring Theme' swaps to neutral greys with a muted rose primary. Copy is witty (404: 'AI hallucinates when it is unsure. We are sure: this page is gone.'). Accessibility fonts (Atkinson Hyperlegible, OpenDyslexic, Intel One Mono) and a chat density control.
- **T3 Chat: empty state with category chips.** A large 'How can I help you?' heading, a row of four icon chips (Create, Explore, Code, Learn), and a list of four starter prompts separated by hairlines. Clicking a chip swaps the list.
- **T3 Chat: settings as tabbed sections.** Settings pages: Account, Customization, History & Sync, Models, API Keys, Attachments, Shortcuts, Contact Us. A persistent profile/usage summary sits at the side with Base and Burst usage bars and reset countdowns. Each destructive area is a labeled 'Danger Zone' with an 'Are you absolutely sure?' dialog.
- **T3 Code: three-pane agent workspace.** Left: thread inbox with project label, title, branch, PR number and relative time, with a collapsible 'Settled (N)' shelf. Center: conversation with a collapsible 'Worked for 3m 43s' header, the final answer, a changed-files card (+/− counts, Show files, Open diff) and the composer placeholder 'Ask for changes, send follow-ups, or attach images'. Right: tabbed panel (Diff with a turn selector, terminal, browser, files, PRs, devices) that can be maximized.
- **T3 Code: inline context chips.** All context (terminal excerpts, diff comments, files, PRs colored by state, threads, images, citations) lives as atomic chips inside the prompt text where the caret was. Chips are hoverable, navigable, copy/paste-able, and announced to screen readers ('Terminal excerpt, Terminal 1 lines 3-4'). Unavailable context shows a dashed outline.
- **T3 Code: inbox triage model.** Threads behave like an email inbox: pin, snooze (custom or until rate-limit reset), settle (auto after 3 days or on PR merge) and wake. Every state change gets a 5-second Undo toast, and drag gestures reveal action badges. This lowers the cost of running many agents in parallel.
- **T3 Code: settings scope crumb and inheritance chain.** A sentence-style crumb ('Applying settings for …') at the top of each settings page picks environments and project. A layers icon reveals where each value comes from and how many projects override it. Conflicting multi-machine values render as 'Mixed' with an amber icon.
- **T3 Code: keyboard-first with VS Code-grade remapping.** Nearly every composer control has a mod+shift chord (model, host, effort, access, workspace, branch). The palette searches threads and messages. Number keys jump to threads, or to models when the picker is open. Focus rules return to the composer after the palette closes and keep focus while a terminal boots. Shortcuts are remappable in JSON with when-clauses.
- **T3 Code: performance as a design value.** Contributor rules frame performance as user-facing: users who drive agents all day notice a dropped frame, a lying spinner or a stale label. UI primitives own their look and may not be restyled (lint-enforced). Composer banners are built from shared slots, and before/after images (or video for motion) are required for UI PRs.
- **T3 Code marketing site.** Dark grid background, a large centered display headline ('The open-source control plane for coding agents.') ringed by floating provider app-icon tiles, a white primary 'Download for macOS' pill, a secondary 'Steal our code (legally)' GitHub link, an iOS/Android text link, a GitHub star counter in the header, then a full product screenshot and a scrolling wall of X testimonials.

**Motion patterns**

- **T3 Chat: staggered bouncing-dot wait indicator.** Before the first token, the assistant slot shows three 8px dots using Tailwind animate-bounce with delays of -0.3s, -0.15s and 0. The bounce eases with cubic-bezier(.8,0,1,1) going up and (0,0,.2,1) coming down, which reads as a wave.
- **T3 Chat: shimmer sweep on loading surfaces.** A .shimmer-fx pseudo-element sweeps a white gradient (transparent → 20% → 50% → transparent) across an element every 2s, infinitely, behind a blurred 5% white inset. Canvas skeletons use a separate background-position shimmer from -200% to 200%.
- **T3 Chat: spring-animated composer.** Composer layout changes use a Framer Motion spring (stiffness 550, damping 45, mass 0.8): fast, near-critically-damped, no visible overshoot.
- **T3 Chat: fade-in on thread load.** A conversation stays at opacity 0 until messages are measured and positioned, then fades in, which avoids scroll-jump flashes. Shared threads use the same treatment.
- **T3 Chat: Radix enter/exit micro-transitions.** Tooltips, popovers, menus and dialogs use animate-in/animate-out fade and zoom. The model details sheet fades and slides in over the picker; the transition was visible mid-animation in screenshots.
- **T3 Chat Canvas: generation motion.** New gallery items fade in and rise 8px (canvas-fade-in-up). Active generations pulse a soft accent glow (canvas-pulse-glow, 0→20px box-shadow). Image placeholders pulse, then cross-fade over a long 5s opacity transition as the image resolves. Statuses step from 'Queued for generation…' to 'Generating image…' to '4K Ready' after upscale.
- **T3 Chat: retry spin and caret blink.** The retry icon gets a dedicated full-rotation spin while re-requesting. One-time-code inputs show a blinking caret (1s ease-out).
- **T3 Code: motion off by default, user-tunable.** Sidebar, right panel and terminal drawer snap open and closed instantly by default. A 'Panel animations' slider adds 0–400 ms of motion, and OS reduced motion always wins. Switching threads snaps to that thread's panel state without replaying transitions.
- **T3 Code: list reflow and drag choreography.** Pin, settle and snooze animate rows between sections, respecting reduced motion. During a drag, other rows slide aside to show the insertion gap, section labels appear without shifting rows, and the target section takes the accent color. The dragged row swaps its hover actions for an action badge (Pin, Unpin, Settle, Un-settle, Wake). No second transition replays after the drop.
- **T3 Code: no continuously repainting animations.** A contributor rule bans perpetual animations because they peg the GPU on high-refresh displays, and treats 'lying spinners' and stale labels as bugs. Status comes from real state ('Worked for 3m 43s', the 'Goal' indicator, Working section) rather than decorative loops.
- **T3 Code: SnapShot capture feedback.** Capturing a window plays a capture sound, flashes the captured window, and flies the image into the draft. Each effect can be toggled off independently, and the fly-in is disabled under reduced motion.
- **T3 Code: progress that widens in place.** The sidebar update button widens to show multi-machine update progress, names a slow machine, then runs a short restart countdown. Clone progress lives in a toast with cancel and retry.
- **T3 Code mobile: Live Activity lifecycle.** Agent progress streams into the iOS Live Activity or Android Live Update. The finished result stays up to 15 minutes, and the activity visibly degrades once its content goes stale.

**Weaknesses**

- T3 Chat: no persistent cross-chat memory, only manual per-profile customization. A Jan 2026 reviewer cancelled over it.
- T3 Chat: no projects, folders or knowledge 'library'. 'Add a library of files the model can look into' is still Planned on the feedback board.
- T3 Chat: no MCP or connectors, no agent mode, no code-execution sandbox, and no artifacts or code canvas. A reviewer specifically missed a code interface.
- T3 Chat: no voice input or read-aloud in the web app; no voice strings were found in the shipped client.
- T3 Chat: no native mobile app confirmed in the App Store as of 2026-10-15. Users ask about it, and mobile profile switching is an open request.
- T3 Chat: the usage meter (4-hour Base plus monthly Burst/Overage) is opaque. Users report one search query draining most of the base bar, and Theo admits the UI needs clearer expectations.
- T3 Chat: the $8 tier cannot sustain heavy image generation (about 7 images per $1 of API cost). The jump to $50 Premier is criticized.
- T3 Chat: free tier has no web search, attachments or Thinking mode. Retry, edit, branch and share require sign-in.
- T3 Chat: temporary chats live in browser storage that can fill up, and they cannot be exported.
- T3 Chat: frequent warning banners (long thread, buggy model, stealth training, content blocker). Users asked to hide them permanently.
- T3 Chat: title regeneration is rate-limited, and the import only accepts T3 Chat's own JSON, not ChatGPT exports.
- T3 Chat: a Trustpilot report (Apr 2026) of charges continuing after cancellation and a broken contact button; the profile has only 7 reviews.
- T3 Code: the README calls it very early and says to expect bugs. About 1.4k open issues and 1.5k open PRs; big feature contributions are not accepted.
- T3 Code: requires installing and logging into each provider CLI on the host. It depends on vendors' CLIs, SDKs and policies, and T3 has no monetization path of its own.
- T3 Code: no whole-thread export command. V1→V2 migration drops checkpoints, tool history and plans.
- T3 Code: Intel Macs lack the t3 server binary. Store mobile apps cannot connect to nightly servers. Push notifications require T3 Connect.
- T3 Code: hosted web app needs an HTTPS endpoint, and plain-HTTP remote origins degrade device streaming.
- T3 Code: early 2026 reviews flagged broken ~ path resolution and missing diff views, and called it 'good but not usable' (since largely addressed, but the alpha reputation lingers).
- T3 Code: many settings and power features add complexity, and the mobile Android beta has reported connection issues.

**Not verified**

- Whether a native T3 Chat iOS or Android app is publicly released. The client has 'subscription managed in the app store' strings and the feedback board mentions mobile, but no T3 Chat listing appears in the App Store search API.
- Exact current per-window dollar allowances for Pro and Premier. Theo's figures date from Mar 27 2026 and may have changed.
- That the $50/month tier is officially named 'Premier' and priced at $50. The name comes from shipped client strings and the price from Theo's '$50 tier' post plus a user review; no public pricing page exists.
- T3 Chat's trait character limit of 2,500 is from the Feb 2025 changelog thread and may have changed.
- Complete T3 Chat Launch Week (Feb 2026) contents. Only the pre-launch credits overhaul, day 1 (profiles), day 3 (temporary chats and archiving) and the Feb 21 T3 Canvas launch were confirmed; days 2, 4 and 5 were not found.
- Implementation history claims (for example a move from local-first IndexedDB to Convex). Convex is confirmed in shipped code, but the migration narrative is not.
- The T3 Code homepage claims ('Tolerated by over 500,000 devs', '24k+ GitHub stars') are self-reported marketing.
- Exact chat-density option names beyond 'Compact', and the default fonts' marketing names (ProximaVara / BerkeleyMono come from CSS tokens).
- Whether T3 Chat streaming text has any per-token fade or smoothing animation. Code shows only the dots, fade-in, shimmer and springs described.
- Some details come from shipped minified client strings on t3.chat rather than published docs, so they could change with any deploy.

**Features**

- **T3 Chat: multi-model catalog and model picker** (chat). One chat app with roughly 67 current models from 11 providers and about 41 more under 'legacy'. You can switch model for any message.
- **T3 Chat: model capability filters and model details panel** (chat). Filter the catalog by capability and open a details sheet for any model.
- **T3 Chat: reasoning mode and effort** (chat). A composer pill switches between Instant and Thinking. Thinking carries a Pro badge for paid users. Per-model reasoning effort is supported.
- **T3 Chat: web search with adjustable search limit** (search). Toggle web search per message and choose how many searches or tool calls the model may run.
- **T3 Chat: attachments** (files). Attach images, PDFs, Office files and text files to messages. Paid only.
- **T3 Chat: branching** (chat). Fork a conversation from any assistant message into a new thread, or into a throwaway temporary chat.
- **T3 Chat: edit, retry, revisions, quote, stop** (chat). Edit sent messages, retry with the same or another model, step through revisions, quote text, and cancel generation.
- **T3 Chat: find in thread** (chat). Search within the current conversation.
- **T3 Chat: thread sharing** (collaboration). Publish a read-only link to a thread. Viewers can fork it into their own copy.
- **T3 Chat: temporary chats** (chat). Incognito-style threads that live only in the browser session. Shipped during Launch Week, Feb 19 2026. ([source](https://x.com/theo/status/2024345125720379492; shipped client strings; https://t3.chat/faq))
- **T3 Chat: thread archiving** (chat). Archive threads instead of deleting them. Launch Week, Feb 2026. ([source](https://x.com/theo/status/2024345125720379492; shipped client strings))
- **T3 Chat: profiles** (settings). Separate workspaces, each with its own threads and personalization (for example Work and Personal). Launch Week day 1, Feb 17 2026. ([source](https://x.com/theo/status/2023591027857387723; shipped client strings; https://feedback.t3.chat))
- **T3 Chat: personalization ('Customize T3 Chat')** (settings). Per-profile system-prompt personalization.
- **T3 Chat: behavior and visual options** (settings). Fine-grained preferences for sending, links, theme, fonts and density.
- **T3 Chat: sidebar thread management** (chat). Searchable, date-grouped thread list with pinning, multi-select and bulk actions.
- **T3 Chat: export, import and history deletion** (files). Back up or move your conversations, or wipe them.
- **T3 Chat: command menu (Mod+K)** (settings). Keyboard command palette for navigation and actions.
- **T3 Chat: customizable keyboard shortcuts** (settings). Rebind app hotkeys with a recorder UI.
- **T3 Chat: URL-driven chats / custom search engine** (integrations). Start a chat from a URL so the browser address bar or a search-engine shortcut can launch T3 Chat. ([source](https://t3.chat/faq))
- **T3 Chat: BYOK (bring your own key)** (pricing/limits). Use your own provider API keys for selected models. BYOK messages do not count toward plan limits.
- **T3 Chat: usage meter (Base + Burst/Overage buckets)** (pricing/limits). A cost-weighted allowance replaced fixed message credits (Feb 15 2026). A Base bucket refills every 4 hours and an Overage bucket refills monthly. ([source](https://t3.chat/faq; https://x.com/theo/status/2022844310165893484; https://x.com/theo/status/2037657053670637775; https://x.com/theo/status/1937320689176052146))
- **T3 Chat: plans** (pricing/limits). Guest, Free, Pro ($8/mo) and Premier ($50/mo).
- **T3 Chat: account and security** (settings). Sign-in, email change, account transfer, device sessions, deletion.
- **T3 Canvas (image generation workspace)** (artifacts/canvas). A dedicated image generation and editing UI at /canvas, launched Feb 21 2026 as 'the world's best image generation experience'. ([source](https://x.com/theo/status/2025082274262516117; shipped client strings; live /canvas page))
- **T3 Chat: rich message rendering** (chat). Markdown, math, tables, code and diagrams in replies.
- **T3 Chat: resumable streaming and sync** (chat). Responses keep streaming server-side and resume after a reload or in another tab. Threads sync across devices.
- **T3 Chat: model safety and quality warnings** (chat). Contextual banners about model behavior and limits.
- **T3 Chat: model API status page and Wrapped** (settings). Extra pages: /status shows health of model provider APIs; /wrapped is a year-in-review.
- **T3 Chat: empty state and onboarding** (chat). New-chat screen with a greeting, category chips and starter prompts.
- **T3 Chat: privacy and data-training policy** (settings). Published no-training stance per provider. ([source](https://t3.chat/faq))
- **T3 Chat: mobile web** (mobile). Responsive web app installable as a PWA. A native app is in development.
- **T3 Code: what it is** (coding). A free, MIT-licensed 'agent harness control surface': one UI that runs and supervises coding agents on your machines from desktop, web or phone. ([source](https://github.com/pingdotgg/t3code; https://t3.codes; https://x.com/theo/status/2092455706582499815))
- **T3 Code: install and platforms** (desktop). CLI server, Electron desktop app, hosted web client, iOS and Android apps. ([source](https://github.com/pingdotgg/t3code/blob/main/docs/user/install.md; https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824))
- **T3 Code: providers, harnesses and accounts** (agents). Drives many agent CLIs through one thread model, with multiple accounts per provider. ([source](https://github.com/pingdotgg/t3code/tree/main/docs/user (install.md, providers-*.md)))
- **T3 Code: threads, worktrees and parallel runs** (coding). Each task is a thread, optionally in its own git worktree and branch. You can fan one prompt out to several models. ([source](https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md; project-settings.md; source-control.md))
- **T3 Code: inbox-style thread sidebar** (coding). Sections for Pinned, Active, Working, Snoozed and Settled, with drag-to-change-state and undo. ([source](https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md))
- **T3 Code: composer** (coding). Markdown composer with inline context chips, queue/steer, stash and recall. ([source](https://github.com/pingdotgg/t3code/blob/main/docs/user/composer.md; keybindings.md))
- **T3 Code: commands, skills and goals** (agents). Slash commands, $skills and long-running goals. ([source](https://github.com/pingdotgg/t3code/blob/main/docs/user/composer.md; providers-claude.md; providers-acp.md))
- **T3 Code: permission modes and approvals** (agents). Per-thread approval policy chosen in the composer (mod+shift+a). ([source](https://github.com/pingdotgg/t3code/blob/main/docs/user/permission-modes.md; question-attachments.md))
- **T3 Code: rewind / edit from here** (coding). Rewind a thread to before any prompt, optionally restoring files. ([source](https://github.com/pingdotgg/t3code/blob/main/docs/user/composer.md))
- **T3 Code: activity log, subagents and turn summaries** (coding). Collapsed tool-call groups, 'Worked for Xm Ys' headers and subagent tracking. ([source](https://github.com/pingdotgg/t3code/blob/main/docs/user/activity-log.md; thread-sidebar.md; t3.codes product screenshot))
- **T3 Code: source control, PRs and review** (coding). One-click commit, push and PR across 7 git hosts, with in-app PR review. ([source](https://github.com/pingdotgg/t3code/blob/main/docs/user/source-control.md; keybindings.md))
- **T3 Code: terminal, browser and file viewer panels** (coding). Right-panel tabs for terminal, an embedded browser, files, diffs, PRs and devices. ([source](https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md; default-browser.md; browser-import.md; terminal.md; keybindings.md))
- **T3 Code: Devices panel (simulators and emulators)** (coding). Live, interactive iOS Simulator and Android Emulator next to the thread, which agents can drive too. ([source](https://github.com/pingdotgg/t3code/blob/main/docs/user/devices.md))
- **T3 Code: SnapShots** (files). A global hotkey captures the window you're looking at, with its accessibility tree, into your draft. ([source](https://github.com/pingdotgg/t3code/blob/main/docs/user/snap-shot.md))
- **T3 Code: Visual replies (HTML renders) and MCP Apps** (artifacts/canvas). Agents can answer with a sandboxed HTML page (chart, table, diagram, mockup) above their text reply. MCP Apps render inline. ([source](https://github.com/pingdotgg/t3code/blob/main/docs/user/html-renders.md; https://x.com/theo/status/2109364777558626624))
- **T3 Code: Usage and Limits dashboard** (pricing/limits). Cross-provider token, cost and quota analytics built from local history. ([source](https://github.com/pingdotgg/t3code/blob/main/docs/user/usage.md))
- **T3 Code: remote access, T3 Connect and multi-machine** (agents). Run agents on one machine and control them from any device. You can spread threads across several machines. ([source](https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md; background-service.md))
- **T3 Code: outside agents over MCP** (integrations). Claude Code, Codex, ChatGPT or bots can read and drive T3 threads through the environment's /mcp endpoint. ([source](https://github.com/pingdotgg/t3code/blob/main/docs/user/outside-agents.md))
- **T3 Code: scheduled tasks and webhook automations** (automation). Recurring or webhook-triggered agent runs per environment and project. ([source](https://github.com/pingdotgg/t3code/blob/main/docs/user/project-settings.md))
- **T3 Code: mobile companion apps** (mobile). iOS and Android clients with near-full desktop power: start runs, browse files, git actions, diffs, terminal and PR review. ([source](https://github.com/pingdotgg/t3code/blob/main/docs/user/composer.md; mobile-notifications.md; source-control.md; appearance.md; install.md))
- **T3 Code: keybindings** (settings). Fully remappable shortcuts with VS Code-style when-clauses. ([source](https://github.com/pingdotgg/t3code/blob/main/docs/user/keybindings.md))
- **T3 Code: appearance and themes** (settings). Theme system with a custom editor, VS Code theme import and server-published themes. ([source](https://github.com/pingdotgg/t3code/blob/main/docs/user/appearance.md; https://x.com/theo/status/2092455706582499815))
- **T3 Code: scoped settings with inheritance** (settings). One settings UI edits any combination of environments and project overrides. ([source](https://github.com/pingdotgg/t3code/blob/main/docs/user/project-settings.md))
- **T3 Code: prompt links** (integrations). Shareable URLs that open a prepared prompt as a draft and never run anything. ([source](https://github.com/pingdotgg/t3code/blob/main/docs/user/prompt-links.md))
- **T3 Code: provider switching mid-thread (portable handoffs)** (agents). Change model or provider inside a thread. T3 transfers a budgeted selection of history. ([source](https://github.com/pingdotgg/t3code/blob/main/docs/user/portable-handoffs.md; docs/orchestration-v2/README.md))
- **T3 Code: onboarding wizard and history import** (settings). First-run flow connects machines, checks agents and imports existing Claude Code / Codex projects and chats. ([source](https://github.com/pingdotgg/t3code/blob/main/docs/user/welcome-wizard.md))
- **T3 Code: updates, restarts and diagnostics** (desktop). One button updates providers, every connected server and the app. Threads resume after restarts. ([source](https://github.com/pingdotgg/t3code/blob/main/docs/user/updating.md; telemetry.md; https://x.com/theo/status/2092455706582499815))

### Second-tier competitor sweep: Google Gemini (app, Tasks/Spark agent, Deep Research, Canvas, Live, Skills), Perplexity (Search, Computer, Comet, Projects, Brain), Cursor (Agents Window, Cloud Agents, Projects, Bugbot, Security/Rollouts), Microsoft Copilot (new Copilot with Home/Cowork/Code/Autopilot, consumer app, Vision, Mico)

As of 2026-10-14. 77 features catalogued.

**Standout details**

- Cursor steering: pressing Enter twice sends a follow-up at the agent's next tool call instead of interrupting mid-action. Queued messages can be dragged to reorder.
- Cursor iOS Live Activities track up to 8 agents on the lock screen and Dynamic Island, and a push arrives when each turn finishes.
- Cursor Design Mode: click, multi-select or draw on a frozen frame, or speak while agents run, then queue the next UI edit before the first finishes.
- Bugbot lets a team teach it with '@cursor remember [fact]' on any PR, and 'bugbot run verbose=true' prints which rules a review used.
- Bugbot reads its config from the PR's base branch, so a PR can't weaken its own review. Local /review-bugbot dedupes against the remote review by git patch ID.
- Cursor cloud agents attach screenshots and videos proving their change works, and you can take over the agent's remote desktop and hand it back.
- Cursor's 'Copy table' pastes as a real table into Google Docs, Notion and Slack, with Markdown for plain-text targets.
- Cursor approval cards say why they appear, and an accidental Escape can't dismiss approval, error or branch-mismatch prompts.
- Cursor marks where unread replies start and offers a New Messages pill. Unread agents surface on the macOS Dock badge and in the menu bar.
- Cursor Projects show a 'Listening' pill that lists every event a project is subscribed to.
- Perplexity's source shield badges (Government, Academic, Trusted) come with a one-sentence explanation and 'Rate this source'.
- Perplexity Model Council explicitly shows where models disagree and what only one model found, so minority findings aren't lost.
- Perplexity Automations stay silent when a run finds nothing new. Notifications deep-link straight to the result.
- When Perplexity Computer runs out of credits, tasks pause rather than fail and resume automatically.
- Perplexity Brain entries each link back to the session or file they came from and can be edited, and corrections feed forward.
- Computer in Email replies only to the verified sender, even when CC'd on a group thread, and treats forwarded content as context, not instructions.
- Comet shortcuts never auto-run, can be stacked, and expand behind the scenes so threads stay readable. They can be shared via link or added as a new-tab widget.
- Comet Inline Assistant appears on any text selection and can insert its result straight into the active field, or 'Send to sidecar' to continue.
- Comet tab cycling: tap Opt+Tab to swap the last two tabs, or hold it for a visual recent-tab menu, like an app switcher.
- Perplexity's effort slider shows which model each level will use before you submit, and the docs tell users that higher effort isn't always better.
- Gemini Deep Research shows a plan you can edit before it spends minutes researching, and tells you how many runs you have left today.
- Gemini Tasks: typing 'interview me' starts guided setup, and the work panel shows planned steps as well as completed ones.
- Gemini imports another assistant's chat-history ZIP (up to 5 GB) and marks imported chats with a special icon. A memory summary can be pasted in.
- Gemini Skills use the SKILL.md format, so skills from other platforms import directly. Gemini can also auto-apply a skill when relevant.
- Gemini Live now runs inside normal chats, with live map and weather cards appearing while you talk.
- Hold fn on Gemini for Mac (and Perplexity for Mac) to dictate clean text into any app's cursor.
- Chrome auto browse requires a human takeover for payments, terms acceptance and account creation, regardless of autonomy settings.
- Microsoft Excel in Copilot shows what changed and why when Copilot or a teammate edits.
- Copilot Vision Highlights: say 'show me how' and it highlights where to click in the shared app.
- Microsoft's redesigned composer keeps the structure of pasted content and allows inline formatting before sending, and it can expand to fill the screen.

**Design patterns**

- **Gemini 'Neural Expressive' design language.** Gemini's 2026 redesign, launched at I/O on 2026-05-19 across web, Android and iOS, builds on Material 3 Expressive. Visible traits: a capsule or pill composer with one consolidated '+' menu; voice folded into the same composer so switching modes doesn't reset the UI; thin outline icons; pill-shaped navigation-drawer indicators; and dynamic device colors on Android. The Mac app (v1.86) refreshed its side-panel, voice and Temporary-chat buttons and rounded the mini-view button.
- **Editorial answer hierarchy.** Coverage of the redesign says Gemini answers lead with the top-line answer emphasized and supporting detail below. The model also picks a format per query, such as a timeline or narrated walkthrough, instead of uniform text blocks. Reported by a secondary design outlet, not documented by Google.
- **Generative UI per prompt.** Gemini's dynamic view designs and codes a bespoke interactive micro-app for each request. Visual layout produces magazine-style answers with photos and interactive modules you keep refining in chat. Perplexity renders inline interactive charts and 3D explainers in threads, and Cursor renders Canvases next to chat.
- **Chat/Task mode toggle at the composer.** Gemini puts a 'Task' control below the text box, so delegating to the agent is a mode switch rather than a separate product. Microsoft Copilot has a Chat/Cowork toggle and will auto-route by goal. Perplexity switches between Ask and Computer with an icon on the home page.
- **Agent work panel with past, current and planned steps.** Gemini Tasks has a progress chip that opens a panel of completed, current and planned steps plus a Files section. Cursor Projects show a live one-line coordinator status. Perplexity Deep Research shows which sources are being read and the key findings so far.
- **Plan, then edit, then run.** Gemini Deep Research and Chrome auto browse show a plan with 'Edit plan' before 'Start research' or 'Start Task'. Cursor Plan Mode writes an editable markdown plan with Build or 'Build in Parallel'. Perplexity proposes an automation schedule for approval and states its credit cost.
- **Take over and give back.** All three agent products offer explicit control handoff. Gemini has 'View live', 'Take over task' and 'Go back to Gemini'. Chrome has 'Take over task', 'Resume' and 'Give back task'. Cursor cloud agents let you take over the remote desktop and release it. Grok Bot and Chrome hand sign-ins and payments back to the human.
- **Status pills and trays above the prompt.** Cursor puts compact pills above the composer for Goal, Queued, Debug, Canvas, Open Browser, Plan (minimizable), Listening (Projects) and Agents. The Agents pill gets a yellow dot when a subagent needs you, and each pill opens or minimizes its panel. Trays swap with a crossfade and never shift the transcript.
- **Multi-agent tabs, tiles and status semantics.** In Cursor, subagents and side chats open as tabs on their parent agent. Tiles drag between splits, and hovering a tab shows an agent card. Status uses consistent colors: a red Error group in the sidebar, a yellow 'Action Required' group for PRs, 'N merged' or 'N closed' fold rows for PR stacks, a 'New Messages' pill and unread markers. Unread counts also appear on the Dock badge and in the menu bar.
- **Approval cards that explain why.** Cursor approval cards state their reason (for example, 'This edits a file outside your workspace') and show the full path. Approval, error and branch-mismatch prompts can't be dismissed by an accidental Escape. Gemini and Chrome list the categories that always need confirmation, and Gemini shows which sites it will visit before browsing.
- **Effort slider that shows the model.** Perplexity replaces a model picker with a four-step Light/Standard/High/Ultra slider that names the paired model before you submit. Custom is tucked below the slider, and 'Return to Presets' resets it. The help docs state that higher is not always better.
- **Consolidated '+' input menu with branded model chips.** The Perplexity web composer gathers uploads, sources and modes (Deep Research, Model Council, Create files and apps, Learn) under '+'. Each model has its logo, and the selected model's name stays visible in the bar. Gemini's redesign also consolidates into a single plus menu.
- **Source trust badges and hover source cards.** Perplexity citations carry a shield badge (Government, Academic or Trusted). Hovering opens a card with a one-sentence description of the site and 'Rate this source'. Referenced memories also appear among an answer's sources.
- **Consensus and disagreement layout.** Model Council returns one synthesized answer organized by where models agree, where they disagree and why, and what only one model found. Each model's contribution sits below, and in Computer each full report is a downloadable file.
- **Memory as a browsable wiki and graph with provenance.** Perplexity Brain organizes memory into Concepts, Entities and Workstreams, shown as a wiki and a graph. Every entry links to its source session or file, and edits feed the next learning run. This turns opaque memory into something you can inspect.
- **Automation dashboards grouped by state.** Perplexity's Automations page groups tasks as Active, Paused or Completed, shows cadence and next run per row, and offers row actions Run now, Pause/Enable, Edit, Pin and Delete. Cowork lists event-driven tasks next to scheduled prompts. Cursor Projects show subscriptions behind a 'Listening' pill.
- **Progressive disclosure and a task-aware composer (Microsoft).** Microsoft's May 2026 Copilot redesign starts the screen clean and reveals tools as needed. The left navigation expands and contracts, and pinning is shared. The prompt became a 'task-aware workspace' that can grow to fill the view, keeps the structure of pasted content and allows inline formatting before sending. Copilot has a single entry point above the work in each Microsoft 365 app and can be invoked on the canvas, inside a paragraph, cell or slide. Stated principles include 'Your prompt shapes the canvas.'
- **Triage buckets for proactive surfaces.** Copilot Today sorts work into what you missed, what needs attention now, and what can wait, with drafts already prepared. Perplexity Automations stay silent when a run finds nothing new.
- **Selection-triggered inline assistant.** In Comet, selecting text shows a small floating button that offers context-aware actions. Reading text gets Summarize, Fact check, Define and Translate; editing gets Rephrase and Edit; empty fields get 'Help me draft'. Results appear in a popup with Insert and 'Send to sidecar'. The button positions itself to avoid covering content.
- **Slash shortcuts that expand behind the scenes.** Comet shortcuts never auto-execute. They can be stacked and expand into full prompts at submit time, so thread titles stay readable. Cursor, Perplexity and Gemini all use / for skills, plugins and commands; Gemini is moving skills to @.
- **System-wide summon and dictation.** Gemini opens over any app with Option+Space on Mac and Alt+Space on Windows. Perplexity's floating task bar opens with both Command keys. Holding fn dictates into the active window on Gemini for Mac and starts voice on Perplexity for Mac.
- **Proof-of-work artifacts.** Cursor cloud agents attach screenshots, videos and log references to PRs, optionally embedded in GitHub PR descriptions, so you can verify without checking out the branch. Cursor Rollouts posts an editable monitoring plan on each PR.
- **Lock-screen agent tracking.** Cursor for iOS tracks up to 8 agents through Live Activities on the lock screen and Dynamic Island, and sends a push when a turn finishes. Gemini Deep Research and Deep Think notify on completion, including on a locked device.
- **Readable density controls.** Cursor adds a Chat Width slider (600–1600px). Markdown tables get hover 'Expand table' and 'Copy table' buttons, and copied tables paste as real tables into Docs, Notion and Slack. In Projects, user messages are flat, filled, borderless bubbles that follow the theme so they stand apart from agent replies.
- **Domain-level permission tiers for browsing agents.** Comet Enterprise sets each domain to Browser Control, Read Only or No Access, which override the global setting. Consumer Comet lets users block AI tasks on specific sites. Cursor offers an origin allowlist for agent navigation.

**Motion patterns**

- **Animating with purpose.** Google describes the new Gemini/Android visual system as 'animating with purpose to reduce distractions' so motion supports focus. Motion is used to guide attention, not decorate.
- **Launch gradient around the composer.** On Gemini for Mac (Neural Expressive), a colorful gradient briefly surrounds the prompt bar at launch to draw the eye to the input.
- **Motion that reflects processing ('breathing').** Design press describes Gemini's transitions as reflecting processing, retrieval and mode switching rather than freezing or spinning ('Gemini now breathes'), with haptics on mobile. Secondary source.
- **Ambient gradient and particle backgrounds (Gemini iOS).** Reports say the redesigned Gemini app has a pulsing color gradient background and, on iOS, a glowing animated particle field. Android uses flatter depth without particles. Secondary or leak sources.
- **Live overlay glow, sparkles and waveform.** APK teardowns report a sharper Gemini Live overlay animation with sparkles and dots (spreading to Circle to Search), a central waveform during voice input, and a multicolor 'Glow Overlay' on Wear OS. Leak or teardown sources.
- **Glide scroll while streaming.** Cursor changed the chat's follow-along scroll to glide smoothly to new text and tool cards instead of jumping in uneven steps (3.21, refined in 3.24). The transcript also no longer shifts when a turn finishes.
- **Crossfade tray swaps without layout shift.** In Cursor, swapping one tray above the prompt for another crossfades in place. Pills no longer jump or flicker when banners open, interrupted tray animations don't snap, and opening trays doesn't move the conversation.
- **No-flash continuity.** Cursor removed white flashes on new browser tabs, stopped showing the previous page when switching tabs, and kept scroll position without flashing when returning to a recent agent. Long agent titles fade out rather than truncate abruptly, and hover cards move between tabs without waiting.
- **Freeze-frame annotation and hot-reload reveal.** Cursor Design Mode freezes the viewport so drawings sit on the exact page state, including animated pages. As queued agents finish, the running app hot-reloads to reveal each change in place.
- **Live progress streaming in research.** Perplexity Deep Research shows a live view of the sources being read and what it is learning. Key findings appear before completion, and the report streams into an editable file.
- **AI-in-control edge glow.** Comet for Android shows blue screen edges while the AI controls the browser, and an assist button replays the steps it took. Chrome marks the agent's tab with an auto-browse icon and shows a top 'Check your task' notice when it needs you.
- **Avatar that changes color with the conversation.** Microsoft's Mico avatar listens, reacts and changes colors to reflect the conversation in voice mode. Copilot Appearance before it animated expressions such as smiles, nods and raised eyebrows in real time.
- **Gesture navigation and smooth transitions (Perplexity iOS).** The September 2025 Perplexity iOS redesign added gesture navigation to Library and Discover, smooth transitions, enhanced voice-mode visuals and faster input. Only headings are documented.
- **Lock-screen live progress.** Cursor iOS Live Activities update agent progress on the lock screen and Dynamic Island for up to 8 agents. Android Gemini app automation reports progress in notifications.
- **Asynchronous long-think with completion notice.** Gemini Deep Think and Deep Research let you leave while they run, then notify you when the answer is ready, usually within minutes. Perplexity Computer tasks pause when credits run out and resume automatically.
- **Perceived-speed work as a design goal.** Microsoft reports more than a 50% drop in user-perceived load time (navigation, prompt box and suggestions) and about a 10% faster p95 first token after its redesign. Cursor prepares the agent in the background when a chat gains focus so the first response arrives sooner.

**Weaknesses**

- Gemini Tasks are unavailable in the EEA, UK, Switzerland and Nigeria, to work or school accounts, and to under-18s. They require Pro or Ultra plus Personal Intelligence opt-in.
- Gemini's remote browser is used only on mobile. Local-browser tasks fail or fall back when the desktop or Chrome sleeps.
- Chrome auto browse is US-only, English-only and desktop-only, capped at 20 tasks a day on AI Pro, and unavailable in Incognito and on iPhone or iPad.
- Gemini Skills don't yet support Canvas, Deep Research, Guided Learning, or video and music creation, and sharing isn't available yet, while Gems are being forced to migrate (November 2026 for personal accounts).
- Gemini Deep Research visuals disappear when Gmail or Drive are sources, and per-tier report limits aren't published.
- Gemini chat import moves text only: no images, generated files or project files.
- Personal Intelligence is labeled beta, and Google warns of mistakes and over-personalization. International rollout excludes the EEA, UK, Switzerland, South Korea, Australia and Nigeria.
- Gemini's Neural Expressive redesign drew criticism that form was prioritized over function (Android Authority hands-on headline). Rollout was uneven across platforms; the Chrome side panel stayed on the old design.
- In 2025, Workspace business and education users couldn't share Gemini Canvas creations.
- Perplexity credits are hard to predict: no fixed price per task, help articles conflict on Pro allotments, and effort levels are not spending caps.
- Perplexity Model Council on web and iOS is Max-only with a monthly cap, and not on Android or desktop. Effort mode is not in the Mac or Windows apps.
- Perplexity Pages 'Create page' is temporarily retired. Learn Mode's toggle is limited to verified students.
- Perplexity Workflows were replaced by Skills on 2026-09-23 without automatic installation, and some workflows had no matching skill.
- Perplexity Projects on personal accounts cap at 5 contributors and can't be public. Focus can't change mid-session.
- Comet had serious indirect prompt-injection flaws disclosed by Brave in 2025 (page text treated as instructions), with early fixes reported incomplete.
- Comet for Android only works while the app is open (no background tasks), and Perplexity says completion isn't always obvious.
- Cursor pricing has churned repeatedly: the 2025 credit switch backlash and refunds, then the 2026 move into xAI's 'The X Subscription', where switching is permanent. The cheapest paid tier, Plus, lacks Cloud Agents, Bugbot, Automations and third-party models.
- Cursor Projects, cloud agents, Remote Control and the iOS app need cloud data storage and don't work under Legacy Privacy Mode. There's no native Android app (PWA only).
- Cursor shared transcripts are limited to Teams and Enterprise, 50 a day. Bugbot findings default to a 'neutral' check, which doesn't block merges unless fail-on-unresolved is enabled.
- Cursor's SpaceX/xAI ownership and Grok-first model pool may concern some users; coverage reports Musk told staff xAI had fallen behind. The Composer base model wasn't disclosed at launch.
- The consumer Microsoft Copilot app retired Group Chat, Podcasts and Deep Research on 2026-08-18. The Copilot Tasks to Cowork migration drops memories, breaks shared links and turns scheduled tasks off.
- Microsoft Personal and Family subscribers lose Cowork access and need Microsoft 365 Premium or Pro. Home, Code, Autopilot and Today are Frontier or private-preview only.
- Microsoft's Copilot branding and rollout are confusing even to trackers. Office Watch notes the 'September' label doesn't mean September availability, and its own descriptions of the /-and-@ shortcuts contradicted each other.
- Copilot Health is waitlist-only, English, US adults. Mico invited Clippy comparisons.

**Not verified**

- Gemini iOS animated particle field and pulsating gradient background (androidsage.com and mobilemasr.com only).
- Gemini Live as a rounded in-chat animation block, a central voice waveform, and Live-overlay sparkles spreading to Circle to Search (APK teardowns and leak reports).
- Wear OS 'Glow Overlay' multicolor animation (SamMobile).
- Neural Expressive editorial answer hierarchy, 'Gemini now breathes', and haptics specifics (urdesignmag.com design press, not Google docs).
- NotebookLM renamed to 'Gemini Notebook' on 2026-07-16 (a single Spanish-language source). Google's own September 2026 recap does mention 'Gemini Notebook' study tools.
- Gemini Storybook and other 2025 Labs features still being available; not confirmed in the release notes read.
- Perplexity 'Ultrafast' speed setting for GPT-6 Astra and GPT-6.1 Sol for Max (reported 2026-10-14 by orcarouter.ai; not yet in the changelog).
- Perplexity Decisions API with an open-weight routing model (Releasebot tracker only).
- Comet keyboard shortcuts Alt+A for the Assistant and Alt+S for summarize (third-party). Only ⌥⇧V for Voice Mode is confirmed in official docs.
- Microsoft Copilot Chat '/' for agents and '@' for skills: Office Watch contradicts itself.
- Microsoft's claim that Copilot Cowork is 30–40% cheaper than Claude Cowork (vendor claim relayed by press).
- Copilot redesign 'loads 2x faster' (secondary). Microsoft's own figure is a more-than-50% drop in user-perceived load time.
- Copilot Groups' 32-participant limit and features such as vote tallying (secondary coverage), and Mico reacting to emotional tone (secondary). The Microsoft blog quote that Mico changes colors was seen only via a search snippet; the page fetch returned an index.
- Cursor Composer 2 being built on Moonshot's Kimi K2.5 base (secondary coverage of a co-founder remark).
- SpaceX acquisition of Anysphere for $60B closing 2026-08-14 (secondary news). Cursor's docs do confirm The X Subscription, Grok models and 'SpaceXAI' naming.
- Exact per-tier Gemini Deep Research and Audio Overview limits (not published).

**Features**

- **Gemini Tasks (formerly Spark / Gemini Agent)** (agents). You give Gemini a multi-step goal, such as decluttering email, watching flight prices or producing researched files. It plans the work and runs it in the background, using connected apps, skills, a browser and code execution. ([source](https://support.google.com/gemini/answer/17094507 ; https://support.google.com/gemini/answer/16596215))
- **Gemini in Chrome auto browse** (automation). Gemini drives your desktop Chrome to finish web tasks, such as booking appointments or reserving parking, and shows you a plan first. ([source](https://support.google.com/chrome/answer/16821166?hl=en))
- **Gemini Deep Research** (research). A multi-minute research agent that proposes a plan you can edit before it starts, then writes a report that opens in Canvas. ([source](https://support.google.com/gemini/answer/15719111))
- **Gemini Skills (replacing Gems)** (skills). Reusable instruction sets that Gemini can apply automatically or that you invoke by name. Gemini can draft a skill from your chats, and several skills combine in one task. ([source](https://support.google.com/gemini/answer/18560919?hl=en ; https://gemini.google/release-notes/))
- **Gemini Customize panel** (settings). A single place to set how Gemini responds, which tools and apps it connects to, and which skills it uses. ([source](https://gemini.google/release-notes/ ; https://blog.google/innovation-and-ai/technology/ai/google-ai-updates-september-2026/))
- **Personal Intelligence** (memory). Opt-in personalization that reasons across Gmail, Photos, YouTube and Search history to give answers tailored to your life. ([source](https://blog.google/innovation-and-ai/products/gemini-app/gemini-drop-updates-march-2026/ ; https://blog.google/innovation-and-ai/products/gemini-app/gemini-drop-april-2026/ ; https://blog.google/innovation-and-ai/products/gemini-app/personal-intelligence/))
- **Import memory and chat history from other AI apps** (memory). Two switching tools: paste a preferences summary from another assistant into Gemini's memory, and upload a chat-history export so old threads continue in Gemini. ([source](https://gemini.google/import-memory/ ; https://blog.google/innovation-and-ai/products/gemini-app/gemini-drop-updates-march-2026/))
- **Notebooks in Gemini, plus the student hub** (projects). Notebooks collect chats and sources into projects that sync with NotebookLM. A student hub builds study notebooks from course materials. ([source](https://blog.google/innovation-and-ai/products/gemini-app/gemini-drop-april-2026/ ; https://gemini.google/release-notes/ ; https://blog.google/innovation-and-ai/technology/ai/google-ai-updates-september-2026/))
- **Gemini Canvas** (artifacts/canvas). A side workspace for documents, code, web apps, games, infographics, quizzes, audio overviews and slide decks, all editable in real time. ([source](https://workspaceupdates.googleblog.com/2025/05/more-ways-to-create-with-canvas-gemini.html ; https://blog.google/products/gemini/gemini-collaboration-features/))
- **Dynamic view and visual layout (generative UI)** (artifacts/canvas). For each prompt, Gemini designs and codes a custom interactive interface, such as a gallery micro-app or a magazine-style itinerary with photos and interactive modules. ([source](https://research.google/blog/generative-ui-a-rich-custom-visual-interactive-user-experience-for-any-prompt/ ; https://blog.google/innovation-and-ai/products/gemini-app/gemini-drop-april-2026/))
- **Gemini Live (now inside chats)** (voice). Real-time voice with camera and screen sharing. Since May 2026, Live lives inside ordinary chats, so you move between typing and talking without leaving the thread. ([source](https://gemini.google/release-notes/ ; https://blog.google/innovation-and-ai/products/gemini-app/gemini-drop-updates-march-2026/ ; https://blog.google/innovation-and-ai/technology/ai/google-ai-updates-september-2026/ ; https://store.google.com/magazine/gemini-camera-updates))
- **Gemini for Mac (with Antigravity) and Windows** (desktop). Native desktop apps you summon over any window with a hotkey. The Mac app adds screen-aware dictation and a built-in coding agent. ([source](https://gemini.google/release-notes/ ; https://blog.google/innovation-and-ai/models-and-research/gemini-models/introducing-gemini-4-argon/))
- **Model picker, Deep Think and Gemini 4 Argon** (chat). Mode-based picker (Fast, Thinking/Reasoning, Pro). Deep Think is an asynchronous parallel-hypothesis mode, and Gemini 4 Argon is the new frontier model. ([source](https://gemini.google/release-notes/ ; https://blog.google/innovation-and-ai/models-and-research/gemini-models/introducing-gemini-4-argon/))
- **Scheduled actions (chat)** (automation). One-time or recurring prompts, such as a daily summary of your calendar, tasks and unread email, or weekly local events. ([source](https://gemini.google/release-notes/))
- **Temporary chats, history search and Gem sharing** (chat). Privacy and organization basics. ([source](https://gemini.google/release-notes/))
- **Guided Learning, exam prep and automatic visuals** (learning). A tutor-style mode plus study tools, with images, diagrams and YouTube videos added to answers automatically. ([source](https://gemini.google/release-notes/ ; https://blog.google/innovation-and-ai/products/gemini-app/gemini-drop-january-2026/))
- **Media creation: Nano Banana 2, Gemini Omni video, Veo, Lyria** (files). In-chat image, video and music generation and editing, including a personal avatar that looks and speaks like you. ([source](https://gemini.google/release-notes/ ; https://blog.google/innovation-and-ai/products/gemini-app/gemini-drop-february-2026/ ; https://blog.google/innovation-and-ai/technology/ai/google-ai-updates-september-2026/))
- **Verified scientific citations** (search). Gemini links directly to scientific papers, not just search results. ([source](https://blog.google/innovation-and-ai/products/gemini-app/gemini-drop-february-2026/ ; https://gemini.google/release-notes/))
- **Gemini Intelligence on Android** (mobile). OS-level agent features: multi-step app automation, natural-language home-screen widgets, a speech-cleanup keyboard, and autofill from connected apps. ([source](https://blog.google/products-and-platforms/platforms/android/gemini-intelligence/))
- **Google AI Ultra at $100 and student offers** (pricing/limits). Restructured top tier and free student plans. ([source](https://gemini.google/release-notes/))
- **Perplexity answer engine and Pro Search** (search). Cited answers from live web search. Pro Search runs many searches, shows how it broke your question down, and lets you pick the model. ([source](https://www.perplexity.ai/help-center/en/articles/10352903-what-is-pro-search ; https://www.perplexity.ai/help-center/en/articles/10354769-what-is-a-thread ; https://www.perplexity.ai/help-center/en/articles/10354775-technical-capabilities-of-threads))
- **Source trust labels** (search). A shield icon on rated citations marks a domain as Government, Academic or Trusted. Hovering shows a one-sentence description of the site. ([source](https://www.perplexity.ai/help-center/en/articles/20260806-understanding-source-labels))
- **Perplexity Advanced Deep Research** (research). A long research mode that asks clarifying questions, accepts follow-ups mid-run, shows live progress and key findings, and streams the report into an editable, shareable file. ([source](https://www.perplexity.ai/help-center/en/articles/13600190-what-s-new-in-advanced-deep-research ; https://www.perplexity.ai/changelog/what-we-shipped---february-6th-2026 ; https://www.perplexity.ai/help-center/en/articles/10738684-what-is-research-mode))
- **Model Council** (research). Runs your question through several frontier models at once. A synthesizer model then reports where they agree, where they disagree, and what only one model found. ([source](https://www.perplexity.ai/help-center/en/articles/13641704-what-is-model-council ; https://www.perplexity.ai/changelog/what-we-shipped---march-6-2026))
- **Perplexity Computer** (agents). A cloud agent that researches, builds documents, decks, dashboards and apps, manages email, and runs in the background or on schedules, coordinating sub-agents across 20+ models. ([source](https://www.perplexity.ai/help-center/en/articles/13837784-what-is-computer ; https://www.perplexity.ai/help-center/en/articles/13838041-how-credits-work-on-perplexity ; https://www.perplexity.ai/changelog))
- **Effort mode** (agents). A Light/Standard/High/Ultra slider in the prompt box. Perplexity picks the coordinating model and reasoning depth, and shows the paired model before you submit. ([source](https://www.perplexity.ai/help-center/en/articles/20260917-effort-mode-in-perplexity-computer ; https://www.perplexity.ai/changelog/effort-mode-gpt-6-astra-and-skills-marketplace ; https://www.perplexity.ai/changelog/automations-inline-visualizations-and-gpt-6-1-sol))
- **Side Chat (Perplexity)** (agents). A read-only side conversation that runs beside a Computer task without interrupting it. ([source](https://www.perplexity.ai/changelog/effort-mode-gpt-6-astra-and-skills-marketplace))
- **Automations (scheduled and event-driven Computer tasks)** (automation). Recurring or event-triggered Computer work, such as monitoring, briefings and inbox checks, that notifies you only when something is noteworthy. ([source](https://www.perplexity.ai/help-center/en/articles/11521526-perplexity-tasks ; https://www.perplexity.ai/changelog/automations-inline-visualizations-and-gpt-6-1-sol))
- **Memory and Brain** (memory). Memory personalizes Search. Brain is a background, self-improving knowledge graph of your projects, people, files, decisions and open loops for Computer, with every entry linked to its source. ([source](https://www.perplexity.ai/help-center/en/articles/10968016-memory ; https://www.perplexity.ai/help-center/en/articles/19700001-what-is-brain))
- **Perplexity Projects (formerly Spaces)** (projects). Persistent, shareable workspaces that hold searches, Computer tasks, files, instructions, connectors, skills and channel bindings. ([source](https://www.perplexity.ai/help-center/en/articles/10352961-what-are-projects))
- **Skills, Plugins and Skills Marketplace** (skills). Skills deploy specialist sub-agents for a type of task and activate automatically from their description. Plugins bundle connectors and skills around a job. ([source](https://www.perplexity.ai/help-center/en/articles/13914413-how-to-use-computer-skills ; https://www.perplexity.ai/help-center/en/articles/2026100701-what-are-plugins))
- **Create files and apps (formerly Labs)** (artifacts/canvas). Generate and iterate on DOCX, PDF, XLSX, PPTX and HTML apps with research and citations built in. ([source](https://www.perplexity.ai/help-center/en/articles/12528830-creating-assets-with-perplexity-overview))
- **Website publishing from Computer** (artifacts/canvas). Turn a Computer-built site into a live URL on pplx.app with access controls, or deploy to Vercel for a custom domain. ([source](https://www.perplexity.ai/help-center/en/articles/20260711-publishing-your-website-to-the-web))
- **Inline visualizations in Computer threads** (artifacts/canvas). Interactive charts and 3D explainers render directly inside the thread. ([source](https://www.perplexity.ai/changelog/automations-inline-visualizations-and-gpt-6-1-sol))
- **Computer in Email** (integrations). Send, forward or CC a task to computer@perplexity.com. Computer reads the whole thread and replies in it with the result and attachments. ([source](https://www.perplexity.ai/help-center/en/articles/20260715-computer-in-email))
- **Personal Computer desktop app (Mac/Windows)** (desktop). A desktop app built around Computer, with local file access, native Mac app control, a floating task bar, voice and Remote Access, and always-on use on a Mac mini. ([source](https://www.perplexity.ai/help-center/en/articles/14659663-what-is-personal-computer ; https://www.perplexity.ai/help-center/en/articles/19800006-work-with-browsers-and-apps ; https://www.perplexity.ai/help-center/en/articles/19800009-use-remote-access ; https://www.perplexity.ai/changelog/automations-inline-visualizations-and-gpt-6-1-sol))
- **Hybrid compute and Portable Computer (local models)** (settings). Run sensitive steps or whole tasks on your own hardware without spending credits. Any escalation to the cloud needs your permission. ([source](https://www.perplexity.ai/help-center/en/articles/14659663-what-is-personal-computer ; https://www.perplexity.ai/changelog/effort-mode-gpt-6-astra-and-skills-marketplace))
- **Comet browser and assistant** (desktop). A Chromium AI browser with an assistant side panel that reads the current tab or any @-mentioned tab and acts on pages, plus parallel background assistants. ([source](https://www.perplexity.ai/help-center/comet/en/articles/11734688-assistant-panel ; https://www.perplexity.ai/help-center/comet/en/articles/12658082-control-what-comet-assistant-can-use ; https://www.perplexity.ai/help-center/comet/en/articles/12658438-comet-memory ; https://www.perplexity.ai/help-center/en/articles/13531023-managing-comet-assistant-permissions ; https://www.perplexity.ai/changelog/what-we-shipped-october-3rd))
- **Comet Shortcuts, Inline Assistant, Split View, tab cycling and Voice Mode** (desktop). Browser-native AI tools: reusable slash prompts, a floating assistant on text selection, side-by-side tabs, a visual recent-tab switcher and hands-free voice. ([source](https://www.perplexity.ai/help-center/comet/en/articles/11906981-comet-query-shortcuts ; https://www.perplexity.ai/help-center/comet/en/articles/13533742-inline-assistant ; https://www.perplexity.ai/help-center/comet/en/articles/12324462-split-view-mode ; https://www.perplexity.ai/help-center/comet/en/articles/13534100-cycle-most-recent-tabs ; https://www.perplexity.ai/help-center/comet/en/articles/13860420-voice-mode))
- **Comet for Android** (mobile). A mobile AI browser that automates web tasks, with a strong visual cue when the AI has control. ([source](https://www.perplexity.ai/help-center/comet/en/articles/12875447-comet-for-android-quick-start-and-key-features))
- **Perplexity voice and mobile assistants** (voice). Voice assistant layers on iOS and Android, with hardware shortcuts. ([source](https://www.perplexity.ai/help-center/en/articles/11132456-how-to-use-the-perplexity-voice-assistant-for-ios ; https://www.perplexity.ai/changelog/what-we-shipped-september-5th ; https://www.perplexity.ai/changelog/effort-mode-gpt-6-astra-and-skills-marketplace))
- **Learn step by step and Study Mode** (learning). A guided-learning mode with questions, hints, flashcards and quizzes, adapted to your level. ([source](https://www.perplexity.ai/changelog/what-we-shipped---february-6th-2026 ; https://www.perplexity.ai/help-center/en/articles/12120542-what-is-learn-mode))
- **History search and library management** (search). Cmd+K or Ctrl+K searches Search threads and Computer tasks by title or phrase. The History page filters and bulk-deletes. ([source](https://www.perplexity.ai/changelog/effort-mode-gpt-6-astra-and-skills-marketplace ; https://www.perplexity.ai/help-center/en/articles/10354769-what-is-a-thread))
- **Vertical experiences: Finance, Places, Shopping, Health** (search). Purpose-built answer surfaces with live data widgets. ([source](https://www.perplexity.ai/changelog/what-we-shipped---february-6th-2026 ; https://www.perplexity.ai/changelog/what-we-shipped-october-3rd ; https://www.perplexity.ai/changelog/what-we-shipped-september-5th ; https://www.perplexity.ai/changelog/automations-inline-visualizations-and-gpt-6-1-sol))
- **Cursor Agents Window (Cursor 3)** (coding). An agent-first workspace for running and managing many agents across repos and environments (local, cloud, SSH, worktrees), with the classic IDE one command away. ([source](https://cursor.com/docs/agent/agents-window ; https://cursor.com/docs/release-notes))
- **Cursor message queue and live steering** (agents). Queue messages while the agent works, reorder them, or steer the active turn at the agent's next tool call without cutting off work mid-action. ([source](https://cursor.com/docs/agent/overview ; https://cursor.com/docs/release-notes))
- **Checkpoints** (coding). Automatic snapshots before significant agent changes. Click any point in the timeline to preview, then restore. ([source](https://cursor.com/docs/agent/overview))
- **Plan Mode, Debug Mode, /goal, /multitask** (coding). Specialized agent modes for planning, runtime-evidence debugging, long-lived objectives and parallel execution. ([source](https://cursor.com/docs/agent/plan-mode ; https://cursor.com/docs/agent/debug-mode ; https://cursor.com/help/ai-features/multi-agent ; https://cursor.com/docs/release-notes))
- **Design Mode** (coding). Direct the agent visually in the live app: click elements, multi-select, draw on a frozen frame, or narrate by voice, then queue the next edit before the first finishes. ([source](https://cursor.com/docs/agent/design-mode ; https://cursor.com/docs/cloud-agent/mobile))
- **Cursor Canvases** (artifacts/canvas). Interactive artifacts (dashboards, audits, reports with sections, stats, tables and charts) that render next to chat and can be rerun with fresh data. ([source](https://cursor.com/docs/agent/tools/canvas))
- **Cursor built-in browser tool** (coding). The agent navigates, clicks, types, scrolls, screenshots, and reads console and network traffic to test and verify UI work. ([source](https://cursor.com/docs/agent/tools/browser ; https://cursor.com/docs/release-notes))
- **Cursor side chats and conversation search** (agents). Durable side conversations that use the main thread as context, plus a local full-text transcript search. ([source](https://cursor.com/changelog/side-chat ; https://cursor.com/docs/release-notes))
- **Cursor Cloud Agents** (agents). Agents run in isolated cloud VMs with full dev environments, attach screenshots, videos and logs to their PRs as proof, and let you take over the remote desktop. ([source](https://cursor.com/docs/cloud-agent ; https://cursor.com/docs/cloud-agent/capabilities))
- **Agent subscriptions (/subscribe)** (automation). An agent can end its turn and wake when a PR comment, CI result, Slack reply, Linear change or timer arrives, continuing in the same conversation with full context. ([source](https://cursor.com/docs/cloud-agent/capabilities ; https://cursor.com/docs/release-notes))
- **Cursor Automations** (automation). Background cloud agents triggered by schedules or by events from GitHub, GitLab, Bitbucket, Slack, Linear and webhooks, configurable in plain language. ([source](https://cursor.com/docs/cloud-agent/automations))
- **Bugbot (AI PR review)** (coding). Reviews every PR update for bugs, security and quality issues, learns team rules from review history, and can auto-fix findings through a cloud agent. ([source](https://cursor.com/docs/bugbot))
- **Security Review, Rollouts and PR Routing & Approval** (coding). Managed bots for exploit-focused security review, post-deploy health monitoring and risk-based reviewer routing or auto-approval. ([source](https://cursor.com/changelog ; https://cursor.com/docs/approval-agents))
- **Agent Review (local)** (coding). A dedicated code review of local changes before you push. ([source](https://cursor.com/docs/agent/agent-review ; https://cursor.com/docs/release-notes))
- **Cursor Projects (coordinator agent)** (projects). Long-running bodies of work, such as features, migrations or apps. A coordinator agent that never writes code plans the work, delegates to parallel agents, and brings results back for review over months. ([source](https://cursor.com/docs/agent/projects ; https://cursor.com/docs/release-notes))
- **Cursor for iOS/iPad and Remote Control** (mobile). A native app for starting, following, reviewing and merging agent work, including directing agents that run on your own computer. ([source](https://cursor.com/docs/cloud-agent/mobile ; https://cursor.com/changelog))
- **Run modes, Auto-review classifier and sandbox** (settings). Graduated autonomy: allowlisted calls run, shell commands run sandboxed where possible, and a classifier reviews the rest against plain-English rules. ([source](https://cursor.com/docs/agent/security/run-modes ; https://cursor.com/docs/release-notes))
- **Cursor Tab completion** (coding). Predictive multi-line edits that jump to your next edit location, including across files. ([source](https://cursor.com/help/ai-features/tab))
- **Shared transcripts** (collaboration). Share a read-only agent conversation with your team or publicly; recipients can fork it into their own Cursor. ([source](https://cursor.com/help/ai-features/shared-transcripts))
- **Grok Bot (in Cursor plans)** (agents). Persistent, named AI teammates, each working on a shared persistent cloud computer with a browser, filesystem and terminal. They message each other and learn workflows from demonstration. ([source](https://cursor.com/docs/grok-bot))
- **Cursor plans (The X Subscription)** (pricing/limits). Cursor is now sold within xAI's 'The X Subscription', with weekly usage pools. ([source](https://cursor.com/help/account-and-billing/pricing ; https://cursor.com/docs/release-notes))
- **New Microsoft Copilot: Home, Chat and Cowork** (agents). Home brings Chat (quick answers) and Cowork (delegated end-to-end tasks) together, with recent activity and suggestions. Automatic routing to Chat, Cowork or Code is coming. ([source](https://blogs.microsoft.com/blog/2026/09/25/introducing-the-new-copilot-with-home-code-and-autopilot/ ; https://learn.microsoft.com/en-us/microsoft-365/copilot/cowork/whats-new))
- **Copilot Code** (coding). A natural-language builder for persistent desktop widgets, interactive dashboards and cloud-hosted internal apps that can be shared, aimed at non-developers. ([source](https://blogs.microsoft.com/blog/2026/09/25/introducing-the-new-copilot-with-home-code-and-autopilot/))
- **Copilot Autopilot (formerly Scout)** (agents). A persistent, proactive agent with its own name, role, goal, identity, memory, computer and workspace. It watches channels, follows up, runs recurring work and resumes projects days later. ([source](https://blogs.microsoft.com/blog/2026/09/25/introducing-the-new-copilot-with-home-code-and-autopilot/))
- **Copilot Today** (automation). A proactive command center across mail, calendar, Teams, meetings and tasks that sorts items into what you missed, what needs attention now, and what can wait, and prepares drafts in advance. ([source](https://blogs.microsoft.com/blog/2026/09/25/introducing-the-new-copilot-with-home-code-and-autopilot/))
- **Office in Copilot** (artifacts/canvas). Create and edit real Word, Excel and PowerPoint files beside the chat; teammates you @mention edit live alongside. ([source](https://blogs.microsoft.com/blog/2026/09/25/introducing-the-new-copilot-with-home-code-and-autopilot/ ; https://office-watch.com/2026/microsoft-copilot-september-2026-update/))
- **@Copilot in Teams** (collaboration). Invoke Copilot in a channel, group chat or meeting; it inherits that space's shared context and permissions. ([source](https://blogs.microsoft.com/blog/2026/09/25/introducing-the-new-copilot-with-home-code-and-autopilot/))
- **Copilot Vision on Windows (Desktop Share and Highlights)** (vision). Share your whole desktop, or up to two app windows, and talk through what's on screen in real time. Highlights points to where to click. ([source](https://blogs.windows.com/windows-insider/2025/07/15/copilot-on-windows-vision-desktop-share-begins-rolling-out-to-windows-insiders/ ; https://blogs.windows.com/windows-insider/2025/05/12/copilot-on-windows-windows-insiders-can-now-use-vision-with-2-apps-and-new-highlights-feature-with-1-app/))
- **Mico avatar and Copilot Appearance** (voice). An optional animated presence for voice mode that listens, reacts and changes color with the conversation. ([source](https://www.microsoft.com/en-us/microsoft-copilot/blog/2025/10/23/human-centered-ai/ (quoted in coverage) ; https://www.thurrott.com/?p=323786))
- **Copilot Health** (health). A separate, isolated health space that joins wearable data, medical records and labs into personalized insights, with provider search. ([source](https://microsoft.ai/news/introducing-copilot-health/))
- **Record (Copilot mobile)** (mobile). Capture in-person conversations and voice notes, then get a transcript and summary you can question further. ([source](https://office-watch.com/2026/microsoft-copilot-september-2026-update/))
- **Copilot model routing and billing transparency** (pricing/limits). An Auto model router, admin-scoped model families, and credit usage that end users can see. ([source](https://blogs.microsoft.com/blog/2026/09/25/introducing-the-new-copilot-with-home-code-and-autopilot/))
- **Consumer Copilot app consolidation** (chat). The personal Copilot app merged into the Microsoft 365 Copilot app. Chat, image creation and file uploads stay free; several consumer features were retired. ([source](https://support.microsoft.com/en-us/microsoft-365-copilot/learning/changes-microsoft-copilot-app))

## Alevr surfaces

### Chat on the web (src/app/(app)/chat, src/components/chat, src/hooks/use-chat.ts, src/lib/chat, src/lib/router, plus the shell, sidebar and search it relies on)

**Strengths**

- The Auto router is the best-reasoned in the category: it scores models on expected total cost (tool rounds, retries, failure-recovery cost, latency), learns from measured outcomes, applies hard data-policy and budget filters, and shows a truthful 'Auto · Model · Effort' receipt with real reasons.
- Streaming reads beautifully and survives failure: frame-paced reveal, highlight fade, held half-formed markdown, reconnect instead of a double charge, kept partial answers with honest finish notes, Continue past token limits, and 'Not sent / Retry send' for turns that never reached the server.
- The citation audit (citation-audit.tsx) checks answers against their sources, which no competitor ships. Inline [n] chips are protocol-allowlisted and favicons are fetched from each source's own origin.
- The context and mention system covers 7 kinds (crew, file, project, app, skill, chat, artifact), shows approval previews before sending, and adds a resolution receipt under the user turn.
- The composer is fully featured: queue while streaming, slash commands including skills, screenshot and sketch capture, Library picker, deep research toggle, and sticky Fast, Ultrafast and Pro modes.
- Regenerate can switch model for one turn, make the answer more concise or add detail, and every previous answer stays reachable through a lazily loaded version pager.
- Transcript performance and navigation are thorough: windowed rendering above 24 messages, backward paging that keeps the reader's place, a turn rail with hover previews, ?m= deep links from search, and Mod+F find over the whole thread.
- Unified search covers 8 sources, uses a recall index with a bounded decrypt-scan fallback, and states its coverage honestly, while message bodies stay encrypted at rest.
- Memory is deep: project-scoped ranked recall, a search_chats tool, agent memory grants, import and export, and a memory receipt in the thought panel.
- Projects go further than Claude's: nested folders, inherited instructions, sources and knowledge, covers, work defaults, a breadcrumb in the chat header, and a project-scoped composer.
- Unique product surface: multi-agent rooms, cross-conversation messaging, inline durable research and work runs, live-UI blocks, runnable code in place, and a per-turn token and USD receipt.
- Accessibility is unusually careful: sr-only turn headings, one polite live region per settled turn, a role=status completion announcer, 44px coarse-pointer targets, reduced-motion handling throughout, and tooltips that print keycaps.
- Load discipline: the canvas, voice panel, document viewer (pdf.js), thought panel, model catalogue and clarification popover are split out and load only when opened, prefetched on hover.

**UX issues**

- [high] Editing any earlier user message silently and permanently deletes every message after it, user and assistant, with no confirmation. The version pager only restores that message's old wording, not the thread that followed. (src/components/chat/message-item.tsx:923 (canEdit has no isLast check); src/app/api/messages/[id]/route.ts:59 (deleteMany createdAt > edited))
- [high] Phone users cannot start an incognito chat, and lose Session outputs, Continue-on and the header Share. The only PrivateChatToggle is inside the header cluster, which renders `hidden ... md:flex`. The command palette has no alternative. (src/components/chat/chat-view.tsx:2239 and 2367)
- [high] Chat models and Auto cannot generate images when asked. The user has to know to open the catalogue and pick an image model, and the + menu has no 'Create image'. This is the most common creative request in ChatGPT. (src/lib/chat/turn/tools.ts (no image tool); src/lib/router/decide.ts (excludes not_chat); composer.tsx plusSections)
- [medium] On touch keyboards Return always sends, so a newline is impossible on phones unless the user finds Settings › Keyboard. ChatGPT and Claude mobile web insert a newline and send with the button. (src/components/chat/composer.tsx:1987; src/lib/composer-keys.ts)
- [medium] The dictation mic is hidden whenever the Web Speech API is missing (Firefox, some WebViews), even though the component has a server-only transcription path (serverStt) that doesn't need Web Speech. (src/components/chat/composer.tsx:3296 (`speechSupported &&`); composer-dictation.tsx:202,441)
- [medium] Only the last answer can be regenerated, and Regenerate is hidden in incognito and private forks. A forked branch that ends on a user turn has no way to get an answer except typing again. (src/components/chat/message-item.tsx:1481; chat-view.tsx:944-995)
- [medium] 'Fork privately' makes an unsaved branch that silently drops attachment-only turns and artifacts, cannot attach files or use apps, and disappears on navigation. It sits as a bare icon on every user bubble, next to a separate 'Branch from here' with two destinations on assistant turns: two branching models in one UI. (src/components/chat/chat-view.tsx:966-981; message-item.tsx:1081 and 1500-1534)
- [medium] A thumbs-down plays the same celebratory swell and confetti burst as a thumbs-up, and asks for no reason, so negative feedback is both tone-deaf and low-signal. (src/components/chat/message-item.tsx:1463; src/hooks/use-chat.ts:2078)
- [medium] Share links are frozen snapshots with no 'Update link'; the only way to refresh is revoke and create again, which breaks the old URL. Viewers cannot continue or fork the shared chat ('Open in Alevr' goes to '/'). (src/components/share/share-dialog.tsx:199-222; src/app/share/[token]/page.tsx:142-143)
- [medium] You cannot select a passage in an assistant answer and ask about it or quote it. That exists in the canvas and document viewer but not in the transcript, where it's used most. (src/components/chat/message-item.tsx (only whole-message 'Quote in composer'))
- [medium] Streaming follows the bottom of the page, so long answers scroll away from their start while being read. Current ChatGPT and Claude pin the new user turn to the top and let the answer grow below without moving the reader. (src/hooks/use-transcript-window.ts; src/components/chat/message-list.tsx:126)
- [medium] The full reasoning trace only opens in a docked side panel. Below the split width that panel replaces the whole chat, so checking the thinking on a phone hides the conversation. Competitors expand it inline. (src/components/chat/chat-view.tsx:2288; activity-timeline.tsx)
- [low] The home screen offers no starter prompts, examples or capability hints. The suggestion row is an empty spacer div, which weakens activation for new users compared with ChatGPT and Claude. (src/components/chat/chat-view.tsx:2680; empty-state.tsx)
- [low] 'Memory updated' is plain text that vanishes after 4s, with no way to see, edit or undo what was saved. Its setTimeouts are never cleared, so rapid updates end each other early. (src/components/chat/chat-view.tsx:2371-2388 and onMemoryUpdated)
- [low] The viewport export has no viewportFit 'cover', so the many pb/pt-[env(safe-area-inset-*)] paddings resolve to 0 and the intended edge-to-edge layout of the installed PWA (manifest display: standalone) never happens. (src/app/layout.tsx:108-120)
- [low] Incognito refuses attachments (rows show the note 'Incognito'), and files pasted in incognito are silently ignored. ChatGPT temporary chats accept files. (src/components/chat/composer.tsx:1998 and 2252)
- [low] Sidebar has no bulk select, archive or delete, and no per-chat export (Markdown or PDF); only full-account export exists. (src/components/app/app-sidebar.tsx; src/components/settings/sections/data-privacy.tsx)
- [low] Comments are out of date and contradict behaviour: composer says the field is disabled while busy (it is not); conversation-find says server search covers titles only (unified search now reads messages). The shortcut sheet calls '@' 'Apps and tools' when it also names files, chats, projects and agents. (composer.tsx:1203-1204; conversation-find.tsx:19-28; src/lib/shortcut-groups.ts:46)
- [low] Several shortcuts the incumbents have are missing: delete chat, toggle incognito, regenerate, switch model. Mod+Shift+L (theme) collides with Safari's sidebar toggle. (src/hooks/use-global-shortcuts.ts; src/lib/shortcut-groups.ts)

**Motion notes**

- A coherent token ladder in src/app/globals.css: --dur-press 70ms, fast 120, exit 160, base 220, slow 360, emphasis 560, plus named curves (out-soft, out-strong, out-expo, spring, drawer, breathe). Components use the rungs instead of ad-hoc numbers.
- Streaming text is paced per frame with a 5-band CSS Custom Highlight fade (about 280ms) and no per-word spans (stream-text.tsx). Blocks fade and rise as they mount, and half-formed tables and fences are held back. Under reduced motion the cadence stays and the fade goes. This is the strongest streaming treatment in the category.
- First-message handoff: the greeting exits on title-out, the empty composer is measured and travels from the home centre to the dock, and the transcript fades in (chat-view.tsx:1515-1646). Conversation switches remount the list with a 6px rise while the chrome holds still.
- The canvas and thought dock slide in and out with a held closing state, so the chat column doesn't snap 480px wider. The entrance is disarmed after the first drag so it doesn't replay on pointer-up.
- Small details: the copy glyph cross-fades to a check only after the clipboard write succeeds; read-aloud swaps to Stop with a spring IconSwap; the AI-written title cross-fades in the header and mobile bar; the transcript rail's ticks scale with tapering and its preview card glides.
- Swell plus Burst on feedback is applied to thumbs-down as well as thumbs-up (message-item.tsx:1463). The burst should be positive-only.
- The incognito transition animates margin, border-radius and box-shadow on the whole transcript column over --dur-slow, which reflows the layout. It is guarded by motion-reduce but heavier than an opacity or transform switch.
- The long-message clamp switches in one frame with only the foot fade cross-fading, deliberately avoiding height tweens. This matches ChatGPT and Claude.
- The home's dot-matrix 'construction' field draws itself on and brightens under the pointer, and pauses when hidden or off screen. Distinctive, but it is decoration competing with a home that otherwise offers no starter content.
- The memory pill and transient notices use rise-in and title-out with forwards fill. The 4s dwell is timer-driven and not cancelled on unmount or repeat.

**Feature status**

- **Composer core: autosizing field, Enter/Shift+Enter, IME-safe, drafts, queue while streaming**: solid. The field stays live while a reply streams. Enter hands the draft to useChat, which queues it until the reply ends. Huge pastes collapse in the DOM. Drafts persist and sync across devices. Optional 'Send with Mod+Enter' setting. The comment at composer.tsx:1203 ('The field is disabled while busy') is out of date. (Evidence: src/components/chat/composer.tsx (1288-1302 sendBlocked/canSend, 1987 Enter rule, 1996 onPaste), src/lib/composer-keys.ts, src/lib/chat/context-draft.ts, src/lib/sync/thread-draft-client (useThreadDraftSync))
- **Slash commands and @ mentions**: solid. Mentions cover 7 kinds, including past chats and artifacts. An app row warns before send when that app asks for approval. A resolution receipt under the user turn says what was added or dropped. Richer than ChatGPT or Claude. The shortcut sheet labels '@' as 'Apps and tools' (shortcut-groups.ts:46), which undersells it. (Evidence: composer.tsx:1639-1830 (/model, /artifact, /sketch, /voice, /new, /<skill>, /search, /research, /projects, /library, /memory), src/lib/mentions/types.ts (crew, file, project, app, skill, chat, artifact), src/components/chat/context-composer-field.tsx, context-receipt.tsx)
- **Plus menu (attach, screenshot, sketch, library, mention, skills, research, web search, memory, project, apps)**: solid. On the home screen, Project, Apps and Skills move to the tray under the composer. There is no 'Create image' entry. Image generation needs a manual model switch. (Evidence: composer.tsx:2534-2735, src/components/chat/composer-plus-menu.tsx (phone drill-in at max-width 639px), src/components/chat/composer-tray.tsx)
- **Model picker and catalogue (labs, modalities, plan locks, thinking effort, Fast/Ultrafast/Pro)**: solid. The chip opens the thinking panel first; the model name inside it opens the full catalogue. Selecting a locked model sends you to /upgrade with a toast naming the plan. Recents are tracked. Below 360px only the logo shows (max-[359px]:hidden). (Evidence: src/components/chat/model-selector.tsx, model-catalogue.tsx (lazy chunk, prefetched on hover), reasoning-slider.tsx, chat-view.tsx:330-350 (fast/ultra/pro prefs))
- **Auto routing with explainable receipt**: solid. More rigorous and transparent than ChatGPT's router: 'Auto · Model · Effort' with real 'Selected for' reasons, plus notes for reroutes and budget limits. Limits: chat models only (image models are excluded as not_chat), so Auto never makes images. The receipt appears only on hover after the turn, or in the More menu on phones. (Evidence: src/lib/router/decide.ts (scores each model on expected total cost; hard filters for plan, data policy, context, budget, provider health), evidence.ts, task-class.ts, data-policy.ts, receipt.ts, src/components/chat/auto-receipt.tsx, message-item.tsx TurnMeta)
- **Streaming text display**: solid. Text is released per animation frame at the arrival rate, with a 5-band CSS Custom Highlight fade-in (about 280ms). Only the last block re-parses. Half-formed tables, fences and links are held back. Under reduced motion the pacing stays and the fade goes. setCut fires every frame while streaming, which re-renders the markdown tree; block memoisation keeps that affordable. (Evidence: src/components/chat/stream-text.tsx, src/lib/chat/stream-pacer.ts, src/components/chat/markdown.tsx:130-210 (block split, closeDangling, holdUnfinishedTable))
- **Thinking / activity display**: solid. One live line shows topic, headline and clock, plus tool, search and skill receipts. A resizable docked panel holds the full trace and the memory receipt. Unlike Claude and ChatGPT, nothing expands inline: the full trace is only in the side panel, which on phones and narrow splits replaces the chat (chat-view.tsx:2288). (Evidence: src/components/chat/activity-timeline.tsx (liveCopy, reasoning headline, 'Thought for X'), thought-process-panel.tsx (docked, lazy), thought-process-model.tsx, src/lib/chat/reasoning-headline.ts, chat-view.tsx thought dock)
- **Stop, Continue, reconnect, unsent retry**: solid. A dropped stream reconnects instead of being charged twice. Partial answers are kept, with honest finish notes for token limit, interruption, user stop and safety stop. Better resilience than the incumbents. (Evidence: src/hooks/use-chat.ts (stop -> /api/chat/cancel, reconnectRef, resendUnsent), message-item.tsx finishNote + Continue button, 'Not sent · Retry send', composer.tsx:1203 (Esc stops))
- **Edit user message**: partial. Editing any earlier turn permanently deletes every later message, user and assistant, with no confirmation. Only that message's old wording is kept as a MessageVersion. The pager shows the old text but not the thread that followed it. ChatGPT keeps the whole branch tree per edit. (Evidence: message-item.tsx:923 (canEdit on every user turn, no isLast check), src/hooks/use-chat.ts:1924 editAndResend, src/app/api/messages/[id]/route.ts:39-62)
- **Regenerate with options and version pager**: partial. A one-off model override does not change the composer's pick. Old answers are kept and paged lazily (decrypted on the server). Only the last answer can be regenerated (isLast at message-item.tsx:1481). Regenerate is hidden in incognito and forks. Older versions lose their activity and steps (shown collapsed). (Evidence: message-item.tsx:413-475 RegenerateMenu (Try again, Switch model, More concise, Add details), 211-260 VersionPager, 752-830 version carousel; use-chat.ts:1770)
- **Branch / fork conversation**: partial. The saved branch is good. 'Fork privately' makes an unsaved incognito branch: it drops turns that only had attachments and their artifacts, cannot attach files or use connectors, and has no Regenerate. It is lost on navigation. Forking at a user turn leaves an unanswered user message. Two branch verbs with different glyphs on user and assistant turns is confusing. (Evidence: message-item.tsx:812-833 (saved branch POST /api/conversations/[id]/fork), 1081 'Fork privately' icon on user bubbles, 1500-1534 Branch submenu; chat-view.tsx:944-1019 (private fork via sessionStorage))
- **Copy actions**: solid. Copy-link-to-message and copy-last-code-block shortcuts go beyond ChatGPT and Claude. (Evidence: message-item.tsx:878-896 copy (strips memory tags, check only after the clipboard write succeeds), 1546-1560 Copy link (?m= deep link), src/hooks/use-global-shortcuts.ts (Mod+Shift+C last response, Mod+Shift+; last code block))
- **Response feedback (thumbs)**: partial. The thumbs update optimistically and roll back on failure. A thumbs-down asks for no reason or category, unlike ChatGPT and Claude. Both thumbs use `celebrate` (Swell plus confetti Burst), so rating an answer bad plays a celebration. (Evidence: message-item.tsx:1460-1465, src/hooks/use-chat.ts:2078 setFeedback)
- **Read aloud (TTS)**: solid. Stop sits in the same slot as Read aloud (spring icon swap). The voice glow follows playback. (Evidence: src/hooks/use-tts.ts (server TTS, browser fallback, voice-level bus), message-item.tsx:1469-1479)
- **Share chat**: partial. Opening the dialog creates nothing. A snapshot link has a view count, revoke and abuse reporting. Gaps: no 'Update link' to re-snapshot (only revoke and create a new one); viewers cannot continue or fork the conversation ('Open in Alevr' goes to '/'); no per-message share; the header Share button is hidden on phones (only the per-message More menu and sidebar row menu remain). (Evidence: src/components/share/share-dialog.tsx:112-222, src/app/share/[token]/page.tsx:142-162, shared-turn-actions.tsx, chat-view.tsx:2213-2229 (header Share))
- **Attachments**: solid. Broad: drag, paste, screenshot, sketch, Library, and an in-app document viewer with quote-to-ask. Gaps: none in incognito or private forks (composer.tsx:2252); HEIC is not in IMAGE_MIME; files pasted in incognito are silently ignored. (Evidence: src/lib/uploads.ts (10 per message; images, PDF, Office/ODF/RTF, text/code; audio/video sniffing), src/lib/attachment-upload.ts (size limit by plan), composer.tsx useFileDrop / onPaste / captureScreenshot / sketch, library-picker.tsx, attachment-tile.tsx, file-preview.tsx, documents viewer with 'Ask about this area')
- **Image / video / audio generation in chat**: partial. Generation works only after manually choosing an image, video or music model in the picker. Its parameters appear in the tray. Region-based image edit is strong. A chat model or Auto cannot create an image when asked, which ChatGPT does natively. (Evidence: composer-media-params.tsx, generated-media.tsx, image-edit-overlay.tsx, generation-placeholder.tsx; src/lib/chat/turn/tools.ts (no image tool); decide.ts excludes not_chat)
- **Dictation**: partial. Good pipeline: instant preview, accurate server re-transcription, and fallback to the preview on timeout. Defect: the mic button only renders when the Web Speech API exists, so Firefox and other non-Chromium users never see dictation, even though the serverStt path doesn't need Web Speech at all. (Evidence: src/components/chat/composer-dictation.tsx (Web Speech preview, server re-transcription via /api/voice/stt, serverStt path at 202/261/441), composer.tsx:1053 and 3296 (mic gated on speechSupported))
- **Realtime voice mode**: partial. Runs inside the composer with a glow, supports screen share, saves the transcript into the chat, and starts from the empty send button. No live camera video, which ChatGPT voice has. Voice turns hide the action row. (Evidence: src/hooks/use-realtime-voice.ts (several providers, screen share via getDisplayMedia, image frames, transcript save with sendBeacon fallback), src/components/voice/realtime-voice.tsx, composer primary slot 'voice' face)
- **Web search and citations**: solid. Inline [n] chips, a bibliography pill, and a citation audit that checks claims against sources, which no competitor ships. Search is a sticky preference across chats, which may surprise. (Evidence: source-chip.tsx (URL protocol allowlist, favicon from the source's own origin), sources-pill.tsx, citation-audit.tsx + citation-audit-panel.tsx, message-item.tsx:1388-1400, src/lib/search/alevr)
- **Deep research inside chat**: solid. A durable run is drawn inline under the turn that started it, and the composer can steer or stop it. (Evidence: research-run-panel.tsx, src/components/research/use-conversation-run.ts, GuideModeSwitch, chat-view.tsx inlineRuns)
- **Memory surfaces**: solid. Memories are ranked and scoped to the project, the model can search past chats, agents have memory grants, and the memory toggle is in the + menu. The in-chat 'Memory updated' notice is plain text that disappears after 4s, with no link to see or undo what was saved (ChatGPT links to Manage memories). Its timers are never cleared. (Evidence: src/app/(app)/memory/page.tsx + src/components/memory/* (manager, import, recap, constellation), src/lib/chat/turn/memory.ts, src/lib/tools/specs/search-chats.ts, thought-process-panel memory receipt, chat-view.tsx:2371-2388 'Memory updated')
- **Incognito (temporary) chat**: partial. Good on desktop: clear copy, connectors dropped, the column becomes a framed card. The only toggle is inside the header cluster, which is hidden below md (chat-view.tsx:2367), so phone users cannot start an incognito chat. No attachments in incognito. (Evidence: chat-view.tsx:384-414 and 865-889, private-chat-toggle.tsx, empty-state.tsx PrivateGreeting)
- **Projects**: solid. Deeper than Claude Projects: nested folders, inherited instructions, work defaults. Projects cannot be shared with other people (ChatGPT and Claude both offer shared projects). (Evidence: src/app/(app)/projects/[id]/page.tsx (tabs: overview, work, code, sources, settings), src/components/projects/* (instructions, sources/knowledge, nested folders, covers, memory rail), chat-view.tsx project breadcrumb and handlePickProject)
- **Conversation list (sidebar)**: solid. Polished, with a travelling selection fill. No bulk selection or bulk delete, no chat folders outside projects, no per-chat export (account-wide export only, in data-privacy.tsx). (Evidence: src/components/app/app-sidebar.tsx (Needs you, Pinned projects, Pinned chats, Recent with infinite scroll, rename, pin, move to project, share, archive with undo, delete, cross-conversation unread, archived dialog))
- **Search across chats**: solid. Searches messages, files, memories, artifacts, projects and work, with honest partial-coverage notes. Opens from the sidebar row or the mobile bar. Mod+K is the command menu, not search. (Evidence: src/components/app/command-palette.tsx (juno:search, highlighted snippets), src/lib/search/engine.ts (8 sources, recall index with bounded decrypt-scan fallback, coverage notes))
- **Find in conversation (Mod+F)**: solid. Loads the whole paged transcript before matching. Gives Ctrl+F back to macOS in text fields. The header comment saying server search covers titles only is out of date. (Evidence: src/components/chat/conversation-find.tsx, chat-view.tsx:1705-1741)
- **Transcript navigation**: solid. The turn rail shows question and answer previews on hover. The thread pages backward and keeps the reader's place. Streaming uses classic follow-the-bottom autoscroll; ChatGPT and Claude now pin the new user turn to the top and let the answer grow below. (Evidence: src/hooks/use-transcript-window.ts (windowed above 24 messages), message-list.tsx (older pages load ~1600px before the top, jump to latest), transcript-rail.tsx, ?m= deep links)
- **Follow-up suggestions**: solid. Shown only on a settled turn, with no skeleton (no layout shift), and can be turned off in Settings. Costs an extra request per turn. (Evidence: src/components/chat/follow-up-suggestions.tsx, chat-view.tsx followUpsVisible, ui-prefs followUps default true)
- **Keyboard shortcuts**: solid. Covers the essentials (new chat, sidebar, theme, copy last response or code, edit last with Up, Shift+Esc to focus, Esc to stop, Mod+U, Mod+F). No shortcuts for delete chat, toggle incognito, regenerate or switch model. (Evidence: src/lib/shortcut-groups.ts, src/hooks/use-global-shortcuts.ts, command-palette shortcuts sheet (Mod+/))
- **Rich answer rendering**: solid. Interactive live-UI blocks and runnable code in the answer go beyond the incumbents. Heavy viewers (canvas, pdf.js) load only when opened. (Evidence: markdown.tsx (code blocks with run-in-place, wrap and copy; mermaid; KaTeX; live-ui blocks), data-table-block.tsx, data-chart-block.tsx, python-execution-block.tsx, artifact-inline-card.tsx, canvas panel (lazy))
- **Home / empty state**: partial. The serif greeting and dot-matrix field are distinctive. There are no starter prompts, examples or capability hints for a first-time user; the suggestion slot is an empty div. (Evidence: src/components/chat/empty-state.tsx, chat-view.tsx:2610-2682 (chat-home__suggest left empty), composer.css .chat-home)
- **Mobile web chat**: partial. Good base: drawer, 44px targets, dvh, a composer within thumb reach, phone drill-in menus. Gaps: Return sends on soft keyboards (no newline without changing a setting); the header cluster (incognito, session outputs, continue-on, share) is hidden; viewport has no viewportFit 'cover', so every env(safe-area-inset-*) padding is inert; the thought panel and canvas take over the whole screen. (Evidence: src/components/app/app-shell.tsx:607-693 (drawer, mobile bar), composer-shell.tsx (44px coarse targets, 16px field), app-shell h-dvh, src/app/layout.tsx:108-120 viewport, chat-view.tsx:2367)
- **Select text in an answer to ask or quote**: missing. ChatGPT ('Ask ChatGPT') and Claude (quote and reply) both let you select a passage in a reply and ask about it. (Evidence: Selection-to-ask exists only in canvas-panel.tsx and document-viewer; message-item.tsx only offers 'Quote in composer' for the whole message)
- **Multi-agent rooms, crew and cross-conversation messages in chat**: solid. Unique: several agents reply in one thread with handoff lines, and conversations can message each other. (Evidence: src/components/chat/use-room.ts, cross-message-row.tsx, use-cross-messages.ts, src/components/agents/agent-thread-header.tsx)
- **Per-turn cost and token receipt**: solid. Model, tokens and USD per answer. Neither ChatGPT nor Claude shows this. (Evidence: message-item.tsx TurnMeta (hover) and More menu on phones)

### Alevr Code: the web Code workspace (/code landing, /code/[id] v2 workspace, /code/pulls, /code/customize), cloud runs on GitHub Actions, the device link and pairing to the Mac, the coding agent runtime (runner/agent-core, runner/env-server), diff review, checkpoints, subagents and teams, routing, repository understanding, GitHub (PRs, checks, auto-fix), and native/Packages/JunoCode.

**Strengths**

- One normalized, event-sourced TurnItem protocol covers Alevr's engine, Claude Agent SDK, Codex, ACP agents (Gemini CLI, OpenCode, Antigravity, Grok, DeepSeek), BYOK and OpenRouter, so a single workspace drives them all. That is broader than T3 Code and something ChatGPT Codex and Claude Code do not offer.
- Checkpoints are first class: hidden git refs capture shell-made edits too, a rollback can itself be undone, non-git folders get content-addressed manifests, and per-hunk revert applies a reverse patch on the real checkout.
- The orchestration runtime is serious: role-based routing (lead, workers, explorer, reviewer, architect), each with its own model, effort and context tier; Plan→Build→Verify and Best-of-N in isolated git worktrees; up to 16 concurrent subagents; enforced budgets; and a model reviewer for Auto mode that fails closed.
- The security work is careful throughout: signed short-lived pairing with an httpOnly pair cookie, device-link folder checks, approvals limited to the decisions offered, untrusted webhook and review text fenced and capped before it reaches a model, repository names and secrets kept out of public Actions logs, and the env bearer removed from child processes.
- The GitHub backend is complete: PR creation (full, draft or compare link, reusing an open PR, preferring the GitHub App token), checks polling, and an auto-fix webhook that turns failed checks and review comments into follow-up runs on the same branch. It mostly needs a UI.
- The thread design is thoughtful: settled turns fold to 'Worked for…', there are detail levels, a single changed-files receipt card, a turn navigator, approvals and plans live inside the composer with full keyboard control, and coral is reserved for 'needs you'.
- There are distinctive features competitors lack: a voice conversation in Code whose spoken lines become send, steer or queue; resuming automatically at a subscription limit reset; skills from the account, the Mac and the repo with /name invocation; and remote control of a Mac from a phone or browser.
- Agent-core is robust: classified provider errors with abortable jittered retry, compaction, prompt-cache compatibility, atomic file writes, container sandbox with an egress policy, nested AGENTS.md/CLAUDE.md/JUNO.md loading, and a bounded TS-compiler repository index that selects affected tests.
- Test coverage is deep: about 50 Code unit and integration test files (link latency, restart and concurrency in Postgres, wire contracts, routing, first prompt), around 40 agent-core tests, env-server tests, and a /dev/code-v2 gallery of 13 states in light, dark, desktop and mobile.
- The native Mac package is far ahead of the web: PR sheet, CI bar, preview verify loop, iOS simulator, rewind and fork, MCP, hooks, goals, and Open Quickly. Most of what the web lacks can be ported from here rather than invented.

**UX issues**

- [high] The model and effort picked on the /code landing are ignored for Mac runs; the first turn runs on whatever instance reconcileSelection picks first. On cloud runs, turn 1 uses the landing model and follow-ups use the v2 selection, so the model can change silently between turns. (src/components/code/code-composer.tsx (seedThreadMode writes mode only); src/lib/code-v2/composer-mode.ts:174; live-route.tsx:127, 190)
- [high] Files or photos attached on the landing are dropped for Mac runs, and a prompt with attachments but no text is never sent. You land in an empty session with no sign your task was lost. (live-route.tsx:393 (peek…?.text only); src/lib/code-v2/first-prompt.ts read())
- [high] 'Attach files' in the session composer only types '@filename' into the draft. Nothing is uploaded, and screenshots cannot be pasted or files dropped. Codex and Claude Code both take pasted images. (src/components/code/v2/composer.tsx:545, 664)
- [high] The default v2 workspace has no Commit, Push, Create PR, CI status or auto-fix toggle. All of them exist in the backend, but only ?surface=legacy shows them. 'Create pull request…' just types '/pr ' and leaves it to the model. (workspace.tsx moreMenu; run-review.tsx, code-session-banner.tsx, use-code-auto-fix.ts (legacy only))
- [high] On Mac threads, the queue's Remove does nothing, Edit sends the message twice, and 'Steer now' steers while the queued copy stays queued. (live-route.tsx:291-299 (mutates localQueue while env.view.queue is the source))
- [high] The Files tab is always empty and @-mentions never list files on the web, even though the env server can list files. (dock.tsx FilesPane; composer.tsx:308; live-route.tsx model has no files/fileContents)
- [high] A Mac thread's history disappears when the Mac is offline, because the client never reads the relay's snapshots. On load, Mac threads flash the 'What should we build in…' empty state until the link answers. (src/lib/code-v2/env-client.ts:604 resolveEnvEndpoint; live-route.tsx:87 useEnv/items fallback)
- [high] Each cloud follow-up is a cold GitHub Actions job (checkout, npm ci, build, clone), taking minutes before the agent starts. Runs are capped at 30 minutes and execute on a public Actions repo. That feels slow next to Codex cloud tasks, which keep warm containers. (src/lib/cloud-code.ts, .github/workflows/code-runner.yml)
- [high] v2 sessions cannot be archived, deleted, pinned or shared; there is no row menu in the sidebar. Rename uses a native window.prompt. (workspace.tsx:244 rename, sessionMenu; src/components/app/code-work-list.tsx)
- [medium] /model and /clear are listed as commands but are sent to the agent as prompts, spending a turn. /plan does not switch the mode. (src/lib/code-v2/composer.ts SLASH_COMMANDS; composer.tsx submit)
- [medium] While the Mac is offline the copy says 'Messages send when it is back', but Send is disabled and nothing is held for later. (composer.tsx:847-850; src/lib/code-v2/composer.ts sendButtonMode)
- [medium] Preview frames the viewer's own localhost:3000, so it fails from any other device. Its sandbox lacks allow-same-origin, which breaks cookies and storage in most apps. It is only reachable from the More menu. (dock.tsx PreviewPane)
- [medium] The Connections sheet opens by itself on a new user's first Mac session, right as their first prompt sends, even though Alevr's included models already work. (live-route.tsx:476 firstRun; workspace.tsx:209-213)
- [medium] The Shortcuts sheet lists dead bindings (⌘F Find, ⌘Z Undo last turn, 'a' accept hunk, provider cycling). Several bindings clash with browser shortcuts (⌘D, ⌘P, ⌘N, ⌘J, ⇧⌘A). (src/lib/code-v2/keymap.ts; workspace.tsx:377)
- [medium] Retry is never wired, so retryable failures are a dead end. Answers have no copy, feedback, regenerate or edit-and-resend. (thread.tsx error row (props.onRetry); workspace.tsx Thread props)
- [medium] Link status is never shown, so a dropped or reconnecting Mac link looks like a hung agent. (use-env-link.ts status (unused in live-route.tsx))
- [medium] The landing and the session use two different composers with different controls and visual systems (ComposerShell plus Chat's ModelSelector, then the cv2 custom composer). The box changes shape after the first send, and Team, subscription and BYOK choices only appear once a session exists. (code-composer.tsx vs src/components/code/v2/composer.tsx)
- [medium] Two toast systems appear on one screen: sonner for errors and a custom bottom-centre cv2-toast for mode and log changes. (live-route.tsx (sonner) vs workspace.tsx cv2-toast)
- [medium] /code/[id] renders client-only with no fallback, and the parent loading.tsx draws a landing-shaped skeleton. You see a blank or mismatched frame before the thread appears. (src/app/(app)/code/[id]/client.tsx; src/app/(app)/code/loading.tsx)
- [medium] The Best-of-N 'Keep A' button does nothing on the web, so the winning candidate cannot be kept. (dock.tsx:723; live-route.tsx (keepCandidate not set))
- [medium] Diff review has no inline comments to send back to the agent, the unmodified-lines expander is always disabled, and there is no virtualization for large diffs. The regex highlighter colours '#' as a comment in every language (CSS colours, Markdown headings). (dock.tsx ChangesPane/Gap/codeTokens)
- [medium] Cloud runs have no Undo or Revert in v2, even though the rollback API and hook exist. (live-route.tsx:300 rollback gated on useEnv)
- [medium] Cloud environments (variables, setup script, network) cannot be configured from Code, and the Customize copy says they are not configurable, which is out of date. (code-customize.tsx:348; /api/code/environments only used by work-schedule-editor)
- [low] Turn-rail ticks are 2×8 px targets. (code-v2.css .cv2-nav-tick)
- [low] File links are focusable spans with role='link' nested inside button rows, which is invalid nested interactive markup. (thread.tsx FileLink inside LogRow button)
- [low] The palette is role=dialog with no aria-modal or focus trap. 'Pull requests' uses window.location.assign, a full reload. (workspace.tsx Palette)
- [low] The two empty states disagree: the landing says 'What will you build?' in serif display type, while the session empty state says 'What should we build in X?' in 24 px sans. (code-landing.tsx vs workspace.tsx/.cv2-empty h1)
- [low] Hunk revert decisions are kept in localStorage per browser, so the Mac and other devices disagree about what was reverted. (live-route.tsx:168-172)
- [low] Starting a session goes to /chat/{id}, which then redirects to /code/{id}: an extra server round trip on the most important click. (code-composer.tsx startDevice/startCloud; src/app/(app)/chat/[id]/page.tsx:43)

**Motion notes**

- Animations only play on enter. Dock (24 px slide plus fade on the drawer curve), popovers (2 px rise), palette, sheets and toasts all animate in, but they disappear instantly because the components are conditionally rendered or return null when closed. Open and close feel lopsided.
- Folding a turn snaps shut. The grid-template-rows 0fr→1fr transition on .cv2-fold only plays when opening, because Steps is only rendered while open ({open && <Steps/>}) and is removed as soon as the fold closes.
- Every work-log row runs cv2-row-in (fade plus 2 px rise) on mount, so opening a long thread or a big turn fades dozens of rows in at once. There is no stagger and no way to skip it on hydration.
- The shimmer on live rows (cv2-shine, 2.2 s, steps(30)) is the only working indicator. It pauses when the tab is hidden and is replaced by plain muted text under reduced motion. Calm and well judged.
- Easing and duration come from shared tokens (--cv2-ease cubic-bezier(0.32,0.72,0,1), --dur-fast/mid/wide, a press scale), so micro-interactions are consistent. The send button cross-fades its arrow and stop glyphs.
- On narrow screens, composer popovers become bottom sheets with a drag handle, rubber-banding and dismissal by velocity, and the dock becomes a right-hand sheet. Good mobile craft.
- Auto-scroll jumps to the bottom on every items change (scrollTop = scrollHeight) with no smooth follow. When you scroll up it stops following, but there is no 'Jump to latest' pill and no unread count.
- Switching between the approval panel and the textarea changes the composer's height with no height or layout animation, only a 160 ms fade, so the thread jumps.
- The sidebar reorders with FLIP (150 ms, travel clamped to 40 px, entering rows fade), which matches T3 Code's timing.
- Reduced motion is handled globally (1 ms clamp under prefers-reduced-motion plus a data-reduced-motion override), and turn-rail jumps use auto instead of smooth scrolling.
- The landing uses a staggered ed-rise entrance for the lockup and greeting, but the session workspace has no entrance choreography, so landing → session feels like a hard cut, made worse by the blank client-only first paint.
- Dock resizing is updated through rAF with keyboard nudges and a double-click reset, but has no snap points or spring settle. Dock tabs remount with a 120 ms fade.

**Feature status**

- **Code landing composer (/code)**: partial. Well built on its own: server-rendered greeting, Mac/Cloud chip, project or repo+branch picker, mode chip, skills chip, attachments with drag-drop and the library picker, dictation, a voice call, and a check that the cloud runner is ready. Three defects. (1) The model and effort you pick here are not passed to Mac threads. seededThreadPrefs only writes the mode (lib/code-v2/composer-mode.ts:174), and live-route.tsx:127 reconcileSelection then picks the first ready instance, so the first turn ignores your pick. (2) It uses Chat's ModelSelector, which only lists Alevr's own models. Your Claude subscription, Codex, ACP agents, BYOK keys and Team routing only appear after the session exists. (3) Attachments for Mac runs are lost (see the first-prompt handoff row). Sending goes to /chat/{id}, which then redirects to /code/{id}: a double navigation. (Evidence: src/app/(app)/code/page.tsx, src/components/code/code-landing.tsx, src/components/code/code-composer.tsx)
- **Run target picker (Mac project / GitHub repo + branch)**: solid. Branches load lazily, are paged and cached per repo, and the base branch is shown on the chip. Error states are clear. You cannot create a new folder or clone a repo onto the Mac from here. (Evidence: src/components/code/code-target-picker.tsx, src/app/api/code/github/repos, src/app/api/code/github/branches, src/app/api/code/workspaces, src/app/api/code/devices)
- **Deep-link prefill (/code?prompt=&repositories=&branch=)**: solid. Fills the field but deliberately does not send, and explains anything it refused. /code/new forwards only the allowed parameters. The environment parameter is refused with 'Nothing here chooses one yet', even though CodeEnvironment exists in the backend. (Evidence: src/lib/code-prefill.ts, src/app/(app)/code/new/page.tsx, PREFILL_NOTES in code-composer.tsx)
- **First-prompt handoff from landing to Mac session**: partial. live-route reads only peekPendingCodePrompt(id)?.text, so attachments staged on the landing are dropped for Mac runs. A prompt with attachments but no text is never sent at all (text===null means nothing is pending). While it waits for the Mac, the prompt is not visible anywhere. The empty state shows instead, with no 'starting' line, because `starting` only reflects the legacy session.status. (Evidence: src/lib/code-v2/first-prompt.ts, src/lib/code-session-handoff.ts, live-route.tsx:390-419)
- **Session workspace shell (/code/[id])**: partial. Renders only on the client. Server-loaded initialMessages are not painted on the server, despite the page docblock saying they are. The dynamic import has no fallback, so the first paint is blank. There is no loading.tsx under [id], so the parent /code skeleton (a greeting and a composer) shows while a thread page loads. ThreadSkeleton exists but live-route never passes `loading`. Header has a breadcrumb, Terminal/Panel/More buttons and a session menu. (Evidence: src/app/(app)/code/[id]/page.tsx, client.tsx (nextDynamic ssr:false, no loading option), src/components/code/v2/live-route.tsx, workspace.tsx)
- **Thread: folded turns, work log, detail levels, receipt card**: solid. A finished turn folds to 'Worked for Xm' with the answer and a 'Changed N files +a −d' card below. Work-log rows are one line each with clickable file names. Consecutive file reads group into one row. Team and computer-use runs group too. Compaction gets its own row. Detail levels are cycled with ⇧⌘L. The 'Waiting for you' signal is the only coral on screen. Adapted from T3 Code. (Evidence: src/components/code/v2/thread.tsx, src/lib/code-v2/turns.ts)
- **Turn navigator rail**: partial. Appears from three turns, with a hover label per turn and smooth scroll that respects reduced motion. Each tick is only 2×8 px with 6 px gaps, which is too small to hit reliably and unusable on touch. (Evidence: thread.tsx TurnRail, code-v2.css .cv2-nav-rail/.cv2-nav-tick)
- **Approvals inside the composer**: solid. The approval replaces the composer body in place and the edge turns coral. Allow once / Allow for session / Deny / Deny and stop, with an 'N of M' pager and keys (↵, Esc, ⌘⇧↵, ←/→). Shows the reason with a More toggle. File-change approvals have a Review button. Switching between textarea and approval causes a layout jump (no height animation). (Evidence: composer.tsx ApprovalTakeover, workspace.tsx approval.* keybindings)
- **Plan mode and plan approval**: solid. Shows 'Plan ready, N steps' with Approve and build / Revise. Typing /plan does not switch the mode; it is sent to the model as text. Plan mode comes from the Mode menu or ⇧⌘A. (Evidence: composer.tsx PlanApproval, thread.tsx PlanBlock, composer-mode.ts)
- **Structured questions (user_input_request)**: solid. Single and multi-select options, or a free-text answer, plus Skip. On the legacy path the answers are flattened into one comma-joined string (live-route.tsx:271). (Evidence: composer.tsx ApprovalTakeover (questions branch))
- **Steer and queue while running**: partial. Enter queues and ⌘↵ steers. On a Mac thread the queue comes from env.view.queue, but editQueued/removeQueued/moveQueued only change localQueue. So Remove does nothing, Edit copies the text into the draft and leaves the original queued (it is sent twice), and 'Steer now' steers while the queued copy stays. The env server has dequeue() but no wire method for it. (Evidence: live-route.tsx:253-299, composer.tsx QueueMenu, runner/env-server/src/sessions/session-manager.ts:364 (dequeue 'Not on the wire yet'))
- **Stop (Esc Esc)**: solid. Two-press stop with a hint line. The send button morphs into Stop. (Evidence: workspace.tsx escPress, composer.tsx esc hint)
- **Slash commands**: partial. Lists /plan /compact /review /init /test /commit /pr /model /clear. Only /compact is handled, and only by the Alevr engine. /model and /clear are advertised as client actions but are sent to the agent as a prompt and spend a turn. The rest rely on the model reading the text. Skill /name invocation does work. (Evidence: src/lib/code-v2/composer.ts SLASH_COMMANDS, runner/agent-core/src/agent.ts:735)
- **@file mentions**: stub. model.files is never set on the live route, so typing @ only offers @explorer and @reviewer. The env server has fs.list and the link hub allows it (env-link-hub.ts:78), but the UI never calls it. (Evidence: composer.tsx:308 rankFiles(model.files ?? []), live-route.tsx model (no `files`))
- **Attachments and images in the session composer**: stub. 'Attach files' only types '@filename' into the draft; nothing is uploaded. Screenshots cannot be pasted and files cannot be dropped. The env server has host.upload (allowed by the link hub), but the UI does not use it. After the first message, you cannot attach anything. (Evidence: composer.tsx:664 (file input inserts `@${f.name}`), no onPaste or drop handler; live-route send() passes [] attachments)
- **Model and provider picker (Alevr, Claude subscription, Codex, ACP agents, BYOK, OpenRouter)**: solid. A broad catalogue. It lists Claude Agent SDK, the Codex app-server, and ACP agents (Gemini CLI, OpenCode, Antigravity, Grok, DeepSeek), plus BYOK keys and OpenRouter. Plan limits show with reset times. Install and Sign in open an in-app terminal with the command typed. Effort levels and context tiers have a ring gauge. 'Compact and switch' calls actions.compact, which is never wired, so it switches without compacting. (Evidence: src/components/code/v2/pickers.tsx, connections.tsx, src/lib/code-v2/workspace-instances.ts, providers-view.ts, byok-*.ts, runner/env-server/src/providers/*)
- **Permission modes (Ask / Accept edits / Auto / Plan / Full access)**: solid. Always visible on the composer row and cycled with ⇧⌘A. The default is remembered per project. Auto mode sends each risky call to a model reviewer that fails closed. Cloud runs only offer the modes their sandbox can enforce. (Evidence: src/lib/code-v2/composer-mode.ts, runner/agent-core/src/harness/auto-review.ts, permission-rules.ts, runner/env-server/src/providers/full-access-guard.ts)
- **Team, role routing and Best-of-N**: partial. Presets: Solo, Lead+workers, Plan→Build→Verify, Best of N. Each role gets its own model, effort and context tier, with a budget cap, and routing is saved on the server. The runtime is solid. On the web, the Best-of-N 'Keep A' button calls actions.keepCandidate, which the live route never sets, so you cannot keep the winning candidate. (Evidence: src/components/code/v2/team.tsx, src/lib/code-v2/team.ts, role-routing.ts, /api/code/routing/[conversationId], runner/agent-core/src/harness/routing.ts, subagents.ts)
- **Subagents panel (Agents dock)**: solid. Active and finished groups, each agent's task from the lead, a live trace, tokens and cost, its worktree branch, and Stop. Messaging an agent works only on Mac threads with the Alevr or BYOK engine. The panel opens on its own when a new agent appears, which interrupts other work in the panel. (Evidence: dock.tsx AgentsPane/AgentDetail, runner/agent-core/src/subagents.ts)
- **Diff review (Changes dock)**: partial. Unified view with two gutters, or split view when wide. Scope is this turn or the whole session. Files collapse, lines can wrap, and ]/[ and r work on hunks. Per-hunk Revert applies a reverse patch on the Mac (Mac threads only). Gaps: 'N unmodified lines' is always disabled because fileContents is never supplied. The highlighter is a regex with JS keywords that treats '#' as a comment in every language. No virtualization for large diffs. No inline line comments. No stage, accept-all or commit. Hunk decisions are kept in localStorage per browser. The legacy RunReviewPane ('Looks right' / 'Needs a change' plus per-line notes) cannot be reached from v2. (Evidence: dock.tsx ChangesPane, src/lib/code-v2/diff.ts, live-route.tsx decideHunk, runner/env-server/src/git/line-diff.ts)
- **Checkpoints, Revert to here, Undo a turn**: partial. The engine is excellent. Snapshots are hidden git refs that also capture shell-made edits, a rollback can itself be undone, and folders without git use manifests. In the v2 UI, rollback only exists on Mac threads. Cloud runs get no Undo, even though useCodeSession.requestRollback and /api/code/tasks/[id]/rollback exist. The saved pre-rollback state is never offered as 'Redo'. (Evidence: runner/env-server/src/git/checkpoints.ts, folder-checkpoints.ts, runner/agent-core/src/checkpoints.ts, thread.tsx UserBubble/Receipt, workspace.tsx Checkpoints submenu)
- **Terminal dock**: solid. Interactive shells on the Mac in xterm, plus read-only tabs for commands the agent ran. Input is batched every 16 ms. Not available on cloud runs or while the Mac is offline. (Evidence: dock.tsx TerminalPane, xterm-view.tsx, use-env-link.ts (batched writes, resize dedupe), runner/env-server/src/terminal/terminals.ts)
- **Files dock**: stub. On the live route it always says 'No file list for this workspace yet.' The tree, search and viewer only work in the /dev/code-v2 gallery. The tree sits on the right and the viewer on the left, the opposite of the usual layout. (Evidence: dock.tsx FilesPane, live-route.tsx (no files/fileContents))
- **Preview dock**: stub. Only reachable from More > Preview. It frames http://localhost:3000 on the viewer's own machine, not the Mac, so it is useless from another device. The iframe sandbox lacks allow-same-origin, which breaks most apps. Native has a full preview system (Views/Preview/*). (Evidence: dock.tsx PreviewPane, visibleTabs (needs model.previewUrl))
- **Screen / computer-use timeline**: solid. A step timeline with screenshots, a thumbnail inline in the thread, and Stop. (Evidence: dock.tsx ScreenPane, src/components/code/computer-timeline.tsx, runner/env-server/src/mcp/computer-*.ts)
- **Commit, push and create a PR from the workspace**: missing. The env server and the PR route (/api/code/tasks/[id]/pull-request: full, draft, compose; reuses an open PR) can do this, but the default v2 surface has no button. Only the ?surface=legacy view and the native Studio CreatePullRequestSheet have a real flow. (Evidence: workspace.tsx:435-436 (commit gated on actions.commit, never set; 'Create pull request…' only types '/pr '), env-link-hub.ts:80-82 allows git.commit/push/pr, src/components/code/run-review.tsx (legacy PR menu))
- **CI checks status**: missing. The checks rollup exists only in the legacy session banner. v2 shows no CI state for a run's branch or PR. (Evidence: /api/code/tasks/[id]/checks, src/components/code/use-code-checks.ts, code-session-banner.tsx (legacy only))
- **Auto-fix (failed checks and review comments start a follow-up run)**: partial. The backend is strong: a verified webhook, hostile text fenced off from the prompt, and the follow-up runs on the same branch. It defaults to off (watch?.enabled ?? false), and the only toggle is in the legacy view, so v2 users cannot turn it on. (Evidence: src/lib/code-autofix.ts, src/app/api/github/webhook/route.ts, /api/code/tasks/[id]/auto-fix, src/components/code/use-code-auto-fix.ts (legacy only))
- **Pull requests page**: partial. Lists open PRs you authored or are involved in, with loading, disconnected, unauthorized, error and empty states. Rows only open GitHub. No checks or review status, no merge, no in-app review, and no way to start a session from a PR. (Evidence: src/app/(app)/code/pulls/page.tsx, src/components/code/pulls-list.tsx, /api/code/github/pulls)
- **Cloud runs**: partial. Works: follow-ups continue on the same branch, cloud runs can be steered, the sandbox has no network by default, logs are redacted, and repo names are kept out of public inputs. But every turn is a new GitHub Actions job (checkout, npm ci, build, then clone), so each follow-up has a cold start of minutes. Runs are capped at 30 minutes. It runs on a public Actions repo. There is no persistent container or warm pool and no live terminal. (Evidence: src/lib/cloud-code.ts (CLOUD_RUNNER_REPO public), .github/workflows/code-runner.yml, scripts/cloud-code-runner.mjs, /api/code/tasks, /api/code/tasks/[id]/steer, runner-context)
- **Cloud environments (env vars, setup script, network)**: partial. The model, API and runner-context are complete, with encrypted variables. No Code UI creates or picks an environment; only the Work schedule editor uses the API. The Customize page still says 'There is one cloud environment and it is not configurable yet', which is out of date. (Evidence: prisma CodeEnvironment, /api/code/environments, runner-context route, src/components/code/code-customize.tsx:348)
- **Device link to the Mac**: partial. A reliable relay: long poll from the Mac, SSE to clients, a cursor ring, and replay from snapshots, with latency, restart and concurrency tests. On the web: the transport status (reconnecting/closed) is never shown. resolveEnvEndpoint returns none when the Mac is offline, so a Mac thread's history disappears and falls back to CodeTask messages (empty for env-only sessions). The Postgres hub is opt-in. (Evidence: src/lib/code-v2/env-client.ts, link-stream.ts, env-link-hub.ts, env-link-store-pg.ts, /api/code/v2/link/[deviceId]/{host,stream}, use-env-link.ts)
- **Remote control pairing (/pair)**: solid. Signed, single-use offers that expire in 2 minutes. The pair is stored server-side behind an httpOnly cookie, with an Allow/Deny step. The extra step is friction on first use, but it is sound. (Evidence: src/lib/code-v2/device-pairing.ts, src/components/code/remote-pair-browser.tsx, /api/code/pairing/*)
- **Resume when a plan limit resets**: solid. Shows 'Claude plan limit reached, resets at…' with Resume at reset / Switch model / Don't continue. Mac threads only. (Evidence: composer.tsx limited state, live-route.tsx resumeAtReset/cancelResume, runtime-lane.ts, session-manager.ts schedule)
- **Voice conversation and dictation in Code**: solid. A distinctive feature: a spoken line becomes a send, steer or queue, and the newest reply is read back. Dictation is in both composers. (Evidence: src/components/code/code-voice.tsx, code-voice-briefing.ts, composer.tsx useCodeVoiceCall)
- **Skills (account, Mac, repo) and /name**: solid. A skills chip and picker, a selection shared across devices on Mac threads, repo skills read from GitHub for cloud runs, and one-shot /name invocation. (Evidence: src/components/code/v2/skills.tsx, use-code-skills.ts, src/lib/code-v2/skills.ts, cloud-skills.ts, runner/env-server/src/skills/*)
- **Session management (rename, pin, archive, delete, share)**: partial. v2 offers rename through window.prompt, plus Copy reference, Checkpoints and Work log. Pin, Share read-only link, Archive and Delete exist only in the legacy view. Sidebar rows have no menu. There is no fork or branch from a message. (Evidence: workspace.tsx:244 (window.prompt rename), sessionMenu; legacy src/components/code/code-session-menu.tsx; docs/code-v2/STATUS.md 'no rename / archive / delete menu')
- **Message actions (copy, retry, feedback, edit and resend)**: missing. Retryable errors show no Retry button because the prop is never wired. Answers have no copy, thumbs, regenerate or edit-and-resend. (Evidence: thread.tsx (onRetry never passed by workspace.tsx), use-code-session.ts setFeedback (unused in v2))
- **Command palette and keyboard shortcuts**: partial. ⌘K searches session titles, Go-to entries and commands. It does not search message content. The Shortcuts sheet lists bindings with no handler: ⌘F thread.find, ⌘Z undoLastTurn, 'a' hunk.accept, and provider cycling (workspace.tsx:377). Several bindings clash with the browser: ⌘D, ⌘P, ⌘N, ⌘J, ⇧⌘A. The palette has no focus trap or aria-modal. (Evidence: workspace.tsx Palette/Shortcuts, src/lib/code-v2/keymap.ts)
- **Sidebar work list (Needs you, Working, Settled)**: solid. Sessions that need you come first, with live state from runs plus the open workspace, a project filter, and project removal. Reorders animate (FLIP). No row actions. (Evidence: src/components/app/code-work-list.tsx, src/lib/code-v2/shell-threads.ts, thread-sections.ts)
- **Cross-device continuity (draft, model, mode)**: partial. The Mac syncs prefs and draft through the backend. The web v2 workspace keeps model and mode choices in localStorage per browser and does not persist the draft at all. (Evidence: native CodeV2ThreadContinuity.swift (ThreadSyncPrefs), src/lib/sync/thread-sync-store.ts (not used by v2), live-route.tsx localStorage prefs)
- **Agent runtime core (loop, tools, compaction, retries, prompt cache)**: solid. Tools: read, write, edit, glob, grep, bash with background jobs, web search and fetch, update_plan, repository_*, computer_*, and cross-conversation tools. Classified provider errors with jittered retry that can be aborted. Atomic writes and edit safety. Container sandbox with an egress policy. Prompt caching. Extensive tests (~40 files). It is a vendored copy of juno-app/core, so drift is a risk. No LSP or diagnostics tool. (Evidence: runner/agent-core/src/{loop,agent,compaction,permissions,permission-rules}.ts, tools/{fs,bash,registry,container-sandbox,egress-policy}.ts, providers/*)
- **Repository understanding**: partial. repository_map, repository_symbols and repository_tests build a syntax index with the TypeScript compiler: declarations, imports, reverse dependencies, and tests affected by a change. Bounded (2k files, 12 MB) and honest about partial coverage. JS/TS only (no Python, Go, Swift, Rust). The index is rebuilt on every call with no cache. No semantic or embedding search and no persistent codebase index. (Evidence: runner/agent-core/src/repository.ts, tools/repository.ts)
- **Project instructions (JUNO.md / AGENTS.md / CLAUDE.md, nested)**: solid. Nested files are merged in a fixed order with duplicates removed. /init asks the model to write AGENTS.md. (Evidence: runner/agent-core/src/harness/instructions.ts, native NestedInstructionLoader.swift)
- **MCP servers and hooks**: partial. Only the native Studio runtime supports user MCP servers and hooks. The env-server Alevr engine and the cloud runner have no user MCP or connectors, and the web has no MCP or hooks configuration. (Evidence: native JunoCodeRuntime/MCP/*, JunoCodeLocal/Extensibility/Hook*.swift; runner/env-server/src/mcp/alevr-mcp.ts (Alevr's own MCP injected into ACP agents))
- **Multi-provider runtime on the Mac (env-server)**: solid. Event-sourced sessions with one normalized TurnItem schema across engines. Approvals are tied to call ids. Steer and queue, limits, scheduling, worktrees and terminals. Antigravity can be installed and signed in by the env server itself. (Evidence: runner/env-server/src/providers/{claude-agent,codex,acp,alevr,antigravity}/*, sessions/session-manager.ts, protocol/reducer.ts)
- **Native Mac Code app (JunoCodeUI)**: partial. Much richer than the web: a PR sheet, CI bar, preview with verify loop, iOS simulator pane, rewind and fork, MCP, hooks, goals, review queue and Open Quickly. Two architectures run side by side (Studio in-process and the v2 env session). The v2 env view also has no commit or PR flow. (Evidence: native/Packages/JunoCode/Sources/JunoCodeUI/{Studio,CodeV2,Views/Review,Views/Preview,Views/Simulator}, native/macOS/JunoDesktop/App/DesktopCodeWorkspace.swift)
- **Pinned live todo above the composer**: missing. The design spec has the live todo pinned above the composer as one line ('2 of 3 · …'). The web only shows it inside the folded work log. (Evidence: docs/code-v2/DESIGN.md:175 vs composer.tsx/workspace.tsx (no todo strip))
- **Customize page**: partial. A read-only list of repos, Macs and folders, and cloud machine facts. Nothing can be edited, and its docblock claims there is no CodeEnvironment model, which is wrong. (Evidence: src/app/(app)/code/customize/page.tsx, src/components/code/code-customize.tsx)
- **End-to-end tests for Code**: missing. Logic and wire are well unit-tested and the gallery covers 13 states. No Playwright flow covers landing → session → approve → review → PR, which is why the wiring gaps above went unnoticed. (Evidence: e2e/ (no code spec), tests/code-*.test.ts (~50 unit/integration files), src/app/dev/code-v2 gallery)

### Work, Orbit/agents and automation: background tasks and runs inside chat, approvals, cloud computers and computer use, personal agents (Orbit), teams, rooms, goals, routines/schedules/triggers, notifications, skills and connectors (web + native JunoWork)

**Strengths**

- Work's merge into chat is a deliberate product decision, written down in TWO_PRODUCTS.md: the model decides when a message becomes a task, and the user can always stop it. This matches where Claude's Cowork fold and ChatGPT Work went.
- The approval system is better than competitors on detail: the button names the action ('Send', 'Delete for good', 'Buy'), the actual artifact is previewed with the parameters folded below, Amend sends a refusal plus a reason, approve-all only covers safe actions, the hard floor is rendered from ALWAYS_CONFIRM_ACTIONS, and one permission contract is shared by TypeScript, agent-core and Swift.
- The cloud runner is careful engineering: leases instead of flags, waiting for a human without tying up a worker (checkpoint and release), never auto-restarting a run that may have acted, a DNS-pinned intercept-and-fulfil browser with WebSockets and WebRTC refused and same-origin rules restored.
- Skills are secure by construction: a skill's permissions are the intersection of what it requests and what is already granted. Skills can be imported from GitHub, zip or markdown, have versions and consent, and can be captured from a run that worked.
- Routines are very thorough: DST-correct clocks, missed-fire, unattended and host-offline policies, a plain-language summary above Save, history that records fires that did not happen, an API fire token, Code routines, and trigger dedupe through cursors and idempotency keys.
- Orbit has a distinctive identity: agent faces with state halos and gaze, serif names, state in words rather than pills, a 'Needs you' list, conversational setup changes with Undo, and per-agent memory access, budget and approval mode.
- Goals, teams and rooms are bounded by rules the database enforces: one step at a time, run and spend budgets, a goal never loops on failure, turn caps per message, and no agent answers the same message twice.
- Notifications go through an inbox popover, web push, APNs and email, with per-channel dedupe and a decision table for attended versus unattended runs. The browser permission prompt only appears when the user asks for it.
- The native JunoWork package has an unusually rigorous local-automation safety layer (emergency stop with generation tokens, sensitive-surface detection, screenshot policy, archive safety, undo journal, tiered control) with extensive tests.
- Accessibility and reduced-motion handling are consistent across the surface: aria-live progress lines, sr-only step states, coarse-pointer touch targets, contrast-more hairlines, and motion-reduce variants.

**UX issues**

- [high] Users cannot choose an approval mode for a task started from chat; it is always 'balanced'. The Permissions page still says the mode is set on the composer and from the running task, and neither control exists any more. (src/lib/chat/task-tool.ts:687, src/app/(app)/permissions/page.tsx (ApprovalModes), src/components/work/composer-home/permission-chip.tsx (orphaned))
- [high] A failed, interrupted or cancelled task card offers no Retry, Run again or Continue, so the user has to retype the request. A finished task cannot be turned into a routine either. (src/components/chat/work-run-panel.tsx (TerminalRun), src/components/work/detail/work-outcome.tsx)
- [high] Recurring requests in plain chat ('every morning…') are sent to start_task, which runs once and cannot schedule itself, so the user believes something recurring was set up. (src/lib/chat/system-prompt.ts:166, src/lib/chat/agent-config-tools.ts:1626)
- [high] Email and calendar triggers only work with iCloud (IMAP/CalDAV); there is no Gmail, Google Calendar or Outlook. Connector-event and folder triggers are listed in the vocabulary and then refused. (scripts/work-trigger-poller.ts, src/lib/work/triggers.ts (TRIGGER_KIND_LIMITS, TRIGGER_SOURCE_CONNECTORS))
- [medium] A routine whose trigger keeps failing (for example an expired iCloud credential) looks healthy on web, because lastPollError is never sent to the client and the row shows only 'last ran X ago' without success or failure. (src/lib/work/schedule.ts (ClientWorkTrigger), src/components/work/work-schedule-row.tsx)
- [medium] A paused run cannot be resumed from web, although the vocabulary says 'It can be resumed' and the control API supports pause and resume. The card only offers Stop. (src/components/chat/work-run-panel.tsx, src/app/api/work/runs/[id]/control/route.ts, src/components/work/work-vocabulary.tsx:75)
- [medium] Likely bug (not reproduced): the task follower ends its SSE loop on the 'done' frame and only resubscribes when the session id changes. When the same durable session starts a new run (a routine re-firing in an agent thread, or a retry), the header shows the new status while the plan, events and run stay frozen on the old run. (src/components/chat/use-conversation-work.ts (subscribe effect deps [sessionId, mergeEvents]); src/components/work/work-transport.tsx subscribeToWorkEvents)
- [medium] Every open conversation polls for tasks every 4 seconds, indefinitely, even with the tab hidden and even when it has never had a task. (src/components/chat/use-conversation-work.ts (DISCOVERY_POLL_MS, useConversationWorkSessions))
- [medium] Ordinary cloud tasks have no visual view of the browser or computer; watch and takeover exist only for agent computers, and those are not production-ready. (src/lib/computer/store.ts resolveRunComputerSession (requires agentId), src/lib/capabilities.ts computer_cloud)
- [medium] Rooms can only be created by asking the model; there is no 'New room' button and no members picker. (src/lib/chat/room-tools.ts, src/components/agents/agents-home.tsx)
- [medium] About 4k lines of Work UI were orphaned by the merge into chat (thread composer, add panel for files/skills/projects, permission chip, preflight card, voice briefing). The capabilities they offered are gone from web. (src/components/work/composer/*, src/components/work/composer-home/*, src/components/work/clarify/preflight-card.tsx, src/components/work/voice/*, src/components/work/work-conversation.tsx (WorkConversation))
- [medium] Brand leaks: users still see 'Juno' in 172 native JunoWork strings (including the screen-control indicator in EmergencyStop.swift:52), in trigger poll errors, and in a run's terminal detail (work-runner.ts:4254). The product is called Alevr. (native/Packages/JunoWork/Sources/**, scripts/work-trigger-poller.ts, scripts/work-runner.ts)
- [low] The Orbit roster menu only has Pin and Pause, with no Duplicate or Delete even though the APIs exist. A failed pin or pause gives no feedback. (src/components/agents/agents-home.tsx (Portrait act()))
- [low] Agent templates are hidden behind /agents/new?form=1. The home page shows a single example, filled in with Tab, and no gallery of starters. (src/components/agents/agents-home.tsx, src/lib/agents/templates.ts)
- [low] The task question's role=radiogroup has no arrow-key navigation, and the radios are separate tab stops. (src/components/chat/work-run-panel.tsx (TaskQuestion))
- [low] The plan is collapsed by default while a task runs, so the live checklist that best-in-class products show takes a click to see. (src/components/chat/work-run-panel.tsx (planOpen=false))
- [low] The agent task board API has no client anywhere, so dependencies, deadlines and leases are not visible to users. (src/app/api/agents/[id]/board/route.ts, src/lib/work/board.ts)
- [low] Work approvals cannot be answered from a push notification; only Code remote-control approvals have actions. (native/iOS/JunoMobile/App/JunoMobileLinkApprovalResponder.swift, src/lib/notify/push.ts)
- [low] Copy written into the code is out of date: the automations page claims folder and connector triggers; the poller header says topic_monitor has no producer though it does; the routine row says 'Emails…' when inbox and push are primary. (src/app/(app)/automations/page.tsx docblock, scripts/work-trigger-poller.ts:51, src/components/work/work-schedule-row.tsx notifySentence)
- [low] The outbound User-Agent hardcodes a personal domain. (scripts/work-runner.ts:1667 ('Juno Work (+https://chat.liams.dev)'))

**Motion notes**

- WorkRunPanel arrives with a fade and a 4px rise on transition.base; reduced motion keeps the fade and drops the movement. Stop fades in and out on the fast and exit timings. This motion is good and calm.
- When a task finishes, the live body swaps to the finished body through AnimatePresence mode="wait" with no height animation. The old body leaves completely before the new one enters, so the transcript collapses briefly and then jumps.
- The GalaxyMark presence glyph changes with each new action (eventKey={action.title}) and holds still while the task waits on the user. useHeldPhase stops the action words from flickering. This is a good example of state-driven motion.
- The plan and 'Earlier updates' disclosures use the shared Collapse component; chevrons rotate on duration-base, with motion-reduce:transition-none applied everywhere.
- Orbit lineup: each <li> carries both the parent .ed-arrive rule (14px rise, 760ms, 45ms stagger + 180ms) and an inline motion-safe:animate-rise-in stagger (6px, 30ms, fill both). The inline longhands override ed-arrive's timing, so the result matches neither spec, and the fill mode 'both' is the one editorial.css warns against.
- Agent faces: gaze follows the pointer, and the halo breathes, turns or fills by state. face-rig.ts, agent-presence.tsx, agent-thread-header.tsx and agent-face.css all check prefers-reduced-motion.
- Creating an agent holds its 'done' face for 560ms before navigating, and skips the pause under reduced motion. Small, but it gives the moment some weight.
- AgentPresence has a transitionName prop for a View Transitions shared element, but no caller passes it. The handoff from the Orbit portrait to the agent thread header is wired but unused.
- Automation and Work rows share staggerDelay(index, 'tight') from lib/motion, and use-work-arrivals animates only rows that are new, so polling does not make lists twitch.
- The agent computer poster card lifts 0.5 on hover with a deep shadow and presses to 0.99, with motion-reduce:transform-none applied.

**Feature status**

- **Background tasks started from chat (model decides with start_task)**: solid. Work is now a mode of a conversation, not a separate page. The chat model offers start_task under a careful gate (not in private, voice, regenerate or research turns). The brief has to stand on its own, there is a cap on live tasks per conversation, idempotency keys, and drafts are thrown away when a task is refused. The user has no manual 'run this as a task' override (removed on purpose), so if the model wrongly answers in chat, the only way to get a task is to rephrase. (Evidence: src/lib/chat/task-tool.ts, src/lib/tools/specs/start-task.ts, src/lib/tools/specs/start-task.prompt.ts, src/lib/chat/system-prompt.ts (TASK_HANDOFF_SECTION), src/lib/chat/turn/approvals.ts, docs/design/TWO_PRODUCTS.md)
- **Live task card in the transcript (title, current action, step N of M, plan, the run's own words, Stop)**: solid. Events stream over SSE with reconnect and per-run cursors. Each task in a conversation gets its own card. The plan is collapsed by default (only the 'step 2 of 4' line shows). Stop is the only control: no Pause/Resume, even though the API supports them. Ordinary cloud tasks have no visual (screenshot or live browser) view. stream onStopped is a no-op, so a refused or signed-out stream leaves a frozen card. (Evidence: src/components/chat/work-run-panel.tsx, src/components/chat/conversation-task-panel.tsx, src/components/chat/use-conversation-work.ts, src/components/work/work-timeline.tsx, src/components/work/work-detail-panels.tsx (WorkLiveMeter))
- **Steering and answering a running task from the chat composer**: solid. The composer switches between answering the task's open question and adding an instruction. Pending steers come from events. Every failure gets a clear toast. (Evidence: src/lib/work/delegation.ts, src/components/chat/use-conversation-work.ts (steering.send/stop), src/components/work/steering/pending-steers.tsx)
- **Finished-task view (outcome digest, deliverable inline, activity lines, capture as skill)**: partial. Good diagnosis copy: how far it got, what it left behind, degradation notes. There is no Retry, Run again, Continue or 'Make this a routine' action on a failed, interrupted or finished task. The digest docblock still talks about 'Try again' and 'panels below' from the deleted task page. (Evidence: src/components/chat/work-run-panel.tsx (TerminalRun), src/components/work/detail/work-outcome.tsx, src/components/work/detail/work-deliverable-stage.tsx, src/components/work/skills/capture-skill.tsx)
- **Pause/resume and retry of runs**: partial. The backend handles pause/resume with race-safe WHERE clauses. The web chat card shows none of it, so a run paused from another client cannot be resumed on web, and an interrupted run has no one-press retry. (Evidence: src/app/api/work/runs/[id]/control/route.ts (cancel/pause/resume), src/app/api/work/sessions/[id]/runs/route.ts, src/components/work/work-vocabulary.tsx ('paused: … It can be resumed'))
- **Per-task approval/permission mode (conservative/balanced/permissive)**: missing. Tasks started from chat always run 'balanced' unless they are in an agent's thread. There is no chip on the composer and no control on the card. The Permissions page still tells users the mode is set 'on the composer before you start it, and from the task itself while it runs', and neither control exists any more. Codex and Claude Code both put approval/permission modes in the composer. (Evidence: src/lib/chat/task-tool.ts:687 (permissionPolicy: agent?.approvalMode ?? DEFAULT_WORK_PERMISSION_POLICY), src/lib/work/domain.ts:524 ('balanced'), src/components/work/composer-home/permission-chip.tsx (orphaned), src/app/(app)/permissions/page.tsx (ApprovalModes copy))
- **Plan review before acting**: partial. This only applies to 'conservative' policy. Chat users cannot choose conservative, so in practice only agents set to conservative ever see it. (Evidence: src/lib/work/plan-review.ts, runner/agent-core/src/work/plan.ts)
- **Questions the task stops to ask (options, Something else, answer in composer)**: solid. The runner waits about 4 minutes in place, then saves a checkpoint and frees the worker. The options radiogroup has no arrow-key navigation. (Evidence: src/components/chat/work-run-panel.tsx (TaskQuestion), src/components/work/work-decisions.tsx, src/lib/work/answer-lookup.ts, scripts/work-runner.ts (ATTENDED_WAIT_MS park/checkpoint))
- **Approvals (verb buttons, artifact preview, amend, batch, digest-verified, hard floor)**: solid. Best in class on detail. Buttons say the actual verb ('Send', 'Buy'), the action is previewed with the parameters folded below, Amend sends a refusal plus a reason back to the model, and batching only covers safe actions. There are two approval card implementations (chat tool approvals in src/components/chat/approval-card.tsx and Work approvals). Work approvals cannot be answered from a push notification; only Code remote approvals can (native/iOS/JunoMobile/App/JunoMobileLinkApprovalResponder.swift). (Evidence: src/components/work/approvals/approval-card.tsx, src/components/work/approvals/action-verbs.ts, src/components/work/approvals/approval-queue.tsx, src/lib/work/digests.ts, src/lib/work/broker.ts, src/lib/action-approval.ts, contracts/permissions/permission-taxonomy.v1.json, src/app/(app)/permissions/page.tsx (AlwaysAsks renders ALWAYS_CONFIRM_ACTIONS))
- **Clarifying questions and cost card before a task starts**: stub. The 'Before it starts' card was built for the Work composer, which was removed, so nothing renders it now. A cost or approval gate still runs server-side inside start_task, and agents have a cost-confirm dialog. (Evidence: src/components/work/clarify/preflight-card.tsx (0 importers), src/components/work/clarify/preflight.ts, src/components/agents/confirm-cost-dialog.tsx)
- **Cloud task tools (web search/fetch, headless browser with credential fill, code sandbox, cloud files, deliverables, connectors)**: solid. Strong security work: DNS-pinned intercept-and-fulfil browser, WebSocket and WebRTC refused, CORS put back, untrusted-content wrapping, leases, checkpoints, and never auto-restarting a run. The browser is headless, so the user never sees it, unlike ChatGPT agent's live virtual browser with takeover. (Evidence: scripts/work-runner.ts (buildTools, fetchPinnedWebPage), runner/agent-core/src/work/tools.ts (web_search, web_fetch, browser, create_deliverable, cloud_files, run_code, check_run, connectorTool), src/lib/work/browser.ts, src/lib/secrets/browser-fill.ts)
- **Deliverables (documents, spreadsheets, decks, sites, reports; editable semantic models)**: partial. Rich generation with inline preview. Native clients skip the semantic kinds. Production acceptance is still pending. (Evidence: src/lib/work/deliverables/*, src/components/work/work-documents.tsx, src/components/work/work-site-preview.tsx, src/lib/capabilities.ts (semantic_artifacts beta))
- **Temporary specialist teams (researcher/engineer/designer + critic + synthesis)**: partial. The backend is solid: DAG validation, contained failures, a per-role budget split, at most 2 running in parallel. In the UI, a team shows only as lines of text in the card. Members have no per-member drill-in, progress or deliverables. (Evidence: src/lib/agents/team.ts, src/lib/agents/team-store.ts, src/lib/agent/swarm.ts, src/components/chat/team-activity.tsx (ActivityLines))
- **Cloud computers for agents (Docker VM, noVNC watch, take control/hand back, files, reset)**: partial. Only an agent's tasks get a computer. Ordinary chat tasks never do. The provider is self-hosted Docker or a fake one, and production security acceptance is blocked (process freeze, egress, VNC rotation). types.ts declares provisionCdpToken twice. (Evidence: src/lib/computer/store.ts (resolveRunComputerSession requires agentId), src/lib/computer/docker.ts, src/lib/computer/takeover.ts, src/lib/computer/live-view.ts, src/components/agents/agent-computer.tsx, src/components/agents/computer-viewer.tsx, runner/agent-core/src/work/computer-tools.ts, src/lib/capabilities.ts (computer_cloud: production blocked))
- **Local Mac execution (folder grants, file ops, batch plans, archive safety, undo journal, accessibility/visual/browser control, emergency stop)**: partial. Strong, well-tested primitives (about 21k lines including tests). No user-facing Undo control uses UndoJournal. capabilities.ts notes the Mac target was not rebuilt after the permission floor change. 172 user-facing strings in the JunoWork sources still say 'Juno' rather than 'Alevr', including the screen-control indicator phrase. (Evidence: native/Packages/JunoWork/Sources/JunoWorkCore/*, JunoWorkLocal/*, JunoWorkAutomation/* (EmergencyStop.swift, SensitiveSurface.swift, ScreenshotPolicy.swift, AutomationPermission.swift), JunoWorkRuntime/*, native/macOS/JunoDesktop/App/DesktopWorkExecutorAdapter.swift)
- **Personal agents (Orbit): create from one sentence, faces, roster with state words, Needs you**: solid. Distinctive identity work: faces with gaze and state halos. The roster menu only has Pin and Pause (no Duplicate or Delete, though /api/agents/[id]/duplicate exists), and failures there are silent. Templates are only reachable at /agents/new?form=1, and the home page surfaces just one example via Tab. (Evidence: src/components/agents/agents-home.tsx, src/lib/agents/new-agent.ts, src/components/agents/agent-presence.tsx, src/components/agents/agent-face.tsx, src/components/agents/face-rig.ts, src/app/(app)/agents/*)
- **Agent profile and conversational setup (brief, goals, routines, notes, apps, approval mode, memory access, budget, ideas, undo)**: solid. Setup changes come as cards with a direction and Undo. Changing an agent's own setup is refused in any turn that also reads untrusted content. (Evidence: src/components/agents/agent-panel.tsx, src/components/agents/agent-profile-fields.tsx, src/lib/chat/agent-config-tools.ts, src/lib/chat/setup-change-tool.ts, src/lib/agents/setup-changes.ts, src/app/api/agents/[id]/undo/route.ts)
- **Durable goals (milestones, success criteria, blockers, budget, run bound, advance)**: partial. The backend is excellent: each step is a lease plus an idempotent task, and a goal never loops on failure. The task board API has no UI consumer anywhere. Native clients do not draw milestones or blockers. A real multi-day run has not been observed. (Evidence: src/lib/agents/goals.ts, src/lib/agents/goal-runner.ts, scripts/agent-reflector.ts (sweepGoals), src/components/agents/agent-goal-row.tsx, src/lib/work/board.ts, src/app/api/agents/[id]/board/route.ts)
- **Rooms (2 to 6 agents in one chat, @mentions, bounded handoffs)**: partial. Turn caps and loop prevention are enforced in the database. There is no explicit 'New room' UI: the only way to create one is to ask the model (create_room tool). Not available on native. (Evidence: src/lib/agents/rooms.ts, src/lib/agents/room-store.ts, src/lib/chat/room-tools.ts, src/components/chat/use-room.ts, src/lib/chat/context-tokens.ts ('crew' mention kind))
- **Proactive ideas and reflection**: partial. Works end to end on web. Ideas only appear inside the agent profile and the notifications inbox. (Evidence: src/lib/agents/reflect.ts, src/lib/agents/reflect-sweep.ts, src/lib/agents/reflection.ts, src/components/agents/agent-panel.tsx (IdeasSection), src/app/api/agents/[id]/ideas/*)
- **Routines editor (once/hourly/daily/weekdays/weekly/monthly/yearly/cron, timezone, budget, model, concurrency, unattended/missed/offline policies, arming summary, Run now, history, Code routines)**: solid. Very thorough: DST arithmetic, a plain-language summary above Save, and history that also records fires that did not happen. Creation is a form only: no templates, no natural-language entry such as 'every weekday at 9'. The row shows 'last ran X ago' but not whether that run succeeded. (Evidence: src/app/(app)/automations/*, src/components/work/work-schedule-editor.tsx, src/components/work/work-triggers.tsx, src/components/work/schedules/arming-card.tsx, src/components/work/schedules/fire-card.tsx, src/lib/work/schedule.ts, scripts/work-scheduler.ts, src/lib/work/fire-token.ts)
- **Event triggers (email, calendar, topic monitor, connector event, folder change, API)**: partial. Email and calendar triggers only work through iCloud IMAP/CalDAV (apple-mail / apple-calendar), not Gmail, Google Calendar or Outlook. The topic monitor is implemented (fused web search), although the poller's header comment says it is not. connector_event and folder_change are refused but still in the vocabulary. The API fire token works. Label and attachment filters are refused because the mail reader cannot see them. (Evidence: src/lib/work/triggers.ts (TRIGGER_KIND_LIMITS, TRIGGER_SOURCE_CONNECTORS), scripts/work-trigger-poller.ts)
- **Creating recurring work from a plain chat**: missing. The system prompt sends 'every morning…' asks to start_task, but a task runs once and has no tool for scheduling itself. Routines can only be made in /automations or by an agent's setup change. ChatGPT Tasks and Claude scheduled tasks both create schedules from chat. (Evidence: src/lib/chat/system-prompt.ts:166 (routes 'every morning' to start_task), src/lib/chat/agent-config-tools.ts:1626 (agent_routine no longer offered), runner/agent-core/src/work/tools.ts (no schedule tool))
- **Routine and trigger health**: missing. The poller records why a trigger cannot read its source, but web never serializes or shows it. A trigger broken by an expired iCloud password looks healthy. (Evidence: src/lib/work/schedule.ts (ClientWorkTrigger has no lastPollError/lastPolledAt), src/lib/sync-entities.ts (only consumer of lastPollError), src/components/work/work-schedule-row.tsx)
- **Notifications (inbox popover, web push, APNs, email, per-run notify policy, attended vs unattended)**: solid. Never throws, dedupes per channel, and only asks for browser permission when the user chooses to. Work approvals cannot be answered from the notification itself. The routine row's notify sentence still says 'Emails…'. (Evidence: src/lib/work/notifications.ts, src/lib/work/notify/deliver.ts, src/lib/work/notify/email.ts, src/lib/notify/web-push.ts, src/lib/apns.ts, src/components/notifications/*, src/components/settings/sections/account.tsx)
- **Needs-you fold and run status dots in the sidebar**: solid. Polled every 30 seconds and capped at the 100 most recent sessions, so a stale waiting task can drop out of the fold. There is no 'running' or 'all tasks' filter across conversations, unlike the session lists in Codex or Claude Code. (Evidence: src/components/app/app-sidebar.tsx (NeedsYouFold), src/components/work/inbox/use-needs-you-count.ts)
- **Skills (library, editor, versions, import from GitHub/zip/md, consent, export, intersection security, capture from run, auto-select)**: solid. A skill's permissions are always the intersection of what it requests and what is already granted, so a skill can never widen access. Full lifecycle and a popular sources list. (Evidence: src/lib/work/skills.ts, src/lib/work/skill-security.ts, src/components/skills/*, src/app/(app)/skills/*, src/app/api/work/skills/**, scripts/work-runner.ts (skillForGoal, applySkill))
- **Connectors (GitHub, Figma, Notion, Apple Mail/Calendar/Music, Google Drive, M365, Composio directory, custom MCP with OAuth, custom connectors, standing grants)**: partial. Only a few connectors are first-party. Gmail, Slack, Google Calendar and similar depend on Composio being configured. Custom MCP over OAuth 2.1 with dynamic client registration is a strength. (Evidence: src/lib/connectors.ts, src/lib/connectors/google-drive.ts, src/lib/connectors/microsoft-365.ts, src/lib/composio.ts, src/lib/user-mcp.ts, src/lib/work/connectors.ts, src/components/connections/*)
- **Saved logins / scoped credential broker**: partial. Task-scoped grants, the value is never shown to the model, and there is an access log. Experimental, web only, and never tested end to end against a real site. (Evidence: src/lib/secrets/*, src/components/permissions/saved-credentials.tsx, src/lib/capabilities.ts (credential_broker experimental))
- **Native iOS Work surface (inbox, thread, approvals, questions, composer)**: partial. The iPhone still has a standalone Work inbox while web merged Work into chat, so the product works differently across platforms. Rooms, goal details and saved logins are missing on native. (Evidence: native/iOS/JunoMobile/App/JunoMobileWorkView.swift)
- **Voice briefing and voice control for tasks**: stub. About 1.1k lines of voice UI went unreachable when the Work page was deleted. (Evidence: src/components/work/voice/* (only imported by the orphaned WorkConversation), src/components/work/work-conversation.tsx)
- **Teach by showing / screen-recorded skills**: missing. Disabled in capabilities.ts. (Evidence: src/lib/capabilities.ts (teach_alevr: disabled), docs/design/PRODUCT_GAPS_ROADMAP.md §2)
- **External channels (WhatsApp/Slack/iMessage agent messaging)**: missing. Disabled in capabilities.ts. (Evidence: src/lib/capabilities.ts (external_channels: disabled))
- **Undo of task changes**: partial. The undo primitive exists but users cannot reach it. (Evidence: native/Packages/JunoWork/Sources/JunoWorkCore/UndoJournal.swift; no web or macOS UI consumer)

### Research, library, artifacts and memory: deep research (Deep Field), Library and project knowledge, artifacts (documents, spreadsheets, decks, code/HTML/React, designs), canvas editing, exports, and memory management UI.

**Strengths**

- The deep research engine and UX lead the category: an editable plan gate, a clarify gate, four depth tiers, mid-run guidance, pause and resume, 'write with what you have', private sources (files, project, library, memory, calendar, mail, connectors) with a server-side gate, and a per-claim citation audit with verbatim passages.
- Research presentation is distinctive and honest. A live source map follows the run's real progress, a question rail shows each question's state in words, the recap gives a citation verdict in words, 'Go further' suggestions start the next run from the composer, and completion is noticed across tabs (title, toast, browser notification) without double announcements.
- Memory management is clearly ahead of ChatGPT and Claude: natural-language edits drafted as a diff with explicit Apply and Undo, an edit ledger with inverses, a recap, Forget (blocks relearning) vs Delete, project-scoped memory, backfill from past chats and background dreaming, sensitive-memory classification, skill candidates, and an injection-safe import from other assistants.
- Artifact safety and collaboration engineering: targeted AI patch edits that keep everything else byte-identical, a guard that holds AI rewrites as pending suggestions instead of clobbering user edits, stale-write detection with 'Save anyway' or 'Discard', and versioned restores.
- Semantic artifact model (documents, workbooks, decks) with a real formula engine, charts, comments and suggested revisions, deck fit checks, and verified Office export (DOCX, XLSX, PPTX re-opened before download). The ops engine is already rich enough to power full editing UIs.
- The canvas covers many runtimes: HTML, React, SVG, Mermaid, JavaScript and TypeScript consoles, and Python via Pyodide. It adds real device-width preview, an element inspector that feeds scoped edits to the composer, a fallback to the last version that rendered, and a unified diff that can be copied.
- A full Figma-like design editor (layers, inspector, effects, motion, interactions) as an artifact type has no equivalent in ChatGPT or Claude.
- Projects support nested folders with inherited instructions and files, per-project tool restrictions, work defaults, members and project memory. Knowledge ingestion covers PDF, Office, ODT, RTF and OCR, with hybrid retrieval that degrades openly to lexical search.
- A careful accessibility baseline in most places: support states use glyph plus word, focus moves to a neighbour after removals, coarse-pointer targets are larger, reduced motion is honoured across the CSS modules, and states and errors are written in plain words.
- Dev galleries render every state from fixtures (src/app/dev/research, /dev/memory, /dev/library, /dev/deliverables, /dev/documents), which makes design QA of this surface practical.

**UX issues**

- [high] Users cannot directly edit their document or deck artifacts. DocumentView only offers Accept, Reject and Resolve; DeckView only offers Move earlier and Duplicate. The ops engine already supports updateText, insertBlock, deleteBlock, comment, deleteSlide and updateSlide. ChatGPT Canvas and Claude both let you type into the document. (src/components/semantic/document-view.tsx, src/components/semantic/deck-view.tsx vs src/lib/work/deliverables/semantic/document/ops.ts, deck/ops.ts)
- [high] Research Markdown export is wired to the fallback. ResearchExportContext is never provided, so downloads keep the <!-- juno:… --> markers and the model's own sources list, are named research-YYYY-MM-DD.md, and have no front matter or numbered sources appendix. reportMarkdownExport is only reached by tests. (src/components/research/report-export.tsx:46,82; src/lib/research/export.ts)
- [high] Unsaved code edits in the canvas are silently lost when the panel closes or another artifact opens. There is no confirm, no autosave and no beforeunload. (src/components/canvas/canvas-panel.tsx (reset effect on artifact.id ~L260; Close button ~L932))
- [high] React artifacts remove every import except React and lucide by regex. A generated component that imports recharts, d3, three or shadcn fails with a ReferenceError, even though the system prompt invites interactive charts. (src/lib/sandbox/console-doc.ts:61 stripImports; src/components/canvas/sandbox-frame.tsx reactDoc)
- [medium] Library tiles for deliverables open a download URL in a new tab, and file tiles open the raw file URL in a new tab. The in-app DocumentViewer and the deliverable preview routes are never used from Library. (src/components/library/library-items.tsx EntryTile/EntryRow; src/app/api/library/made/route.ts (href = /download))
- [medium] Library merges two separately paginated feeds and re-sorts them on the client. Loading more of one feed inserts older items into the middle of the list the user has already scrolled past. (src/components/library/library-home.tsx (entries sort + loadMoreRef loading both feeds))
- [medium] Library search only matches names and titles, and the empty state promises 'Try a client, a month or a number'. Content search is missing although the knowledge index exists. (src/components/library/library-home.tsx empty state; src/app/api/library/made/route.ts (title contains))
- [medium] /artifacts and Library's 'Made by Alevr' filter list the same items with different capabilities (type chips, rename and New design on one; deliverables and files on the other). The sidebar highlights Library for both and the command palette lists both. (src/app/(app)/artifacts/page.tsx, src/components/library/library-home.tsx, src/components/app/app-sidebar.tsx:1193, command-palette.tsx:1268-1269)
- [medium] /artifacts fetches at most 200 artifacts with no pagination, so older ones are unreachable and search only covers the loaded set. (src/app/api/artifacts/route.ts:47; src/app/(app)/artifacts/page.tsx load())
- [medium] MARKDOWN and DOCUMENT both map to 'Documents', so an account with both (research reports are MARKDOWN) sees two identical 'Documents' chips with different counts. (src/app/(app)/artifacts/page.tsx TYPE_LABELS + src/lib/artifacts-home.ts HOME_TYPE_ORDER)
- [medium] The spreadsheet view stops silently at 400 rows and 40 columns with no notice, renders every cell without virtualization, and has no range select, copy/paste or sort. (src/components/semantic/spreadsheet-view.tsx:23-24,91-92)
- [medium] The Ask/Modify selection bar works on Markdown and code only. Selecting text in a semantic document, deck or sheet does nothing, because previewScrollRef is attached only to the Markdown branch. (src/components/canvas/canvas-panel.tsx captureSelection / previewScrollRef)
- [medium] The artifact page's Compare is two raw <pre> blocks truncated at 20k characters with no diff highlighting, while the canvas has a proper line diff. History also shows raw origin strings ('generated', 'edit'). (src/components/artifacts/artifact-lifecycle-actions.tsx)
- [medium] /a/{id} is read-only for every type except design, so an artifact whose chat was deleted (or that was made outside a chat) can no longer be edited. (src/app/(app)/a/[id]/page.tsx, artifact-read-view.tsx)
- [medium] Recently deleted is visually and functionally thin. Every artifact shows the Document glyph, there is no permanent delete or empty, deleted files show no purge date, deliverables are absent, and loading and empty states are bare text. (src/components/library/library-trash.tsx)
- [medium] There is no PDF export for document or deck artifacts, and the research reader offers no DOCX, copy, share or open-in-canvas. (src/app/api/artifacts/[id]/export/route.ts (docx|xlsx|pptx only); src/components/research/report-fullscreen.tsx)
- [low] Library and /artifacts tiles are weak. HTML and React show source code, decks show only a title, and documents and sheets show a blank page or a glyph. Claude and ChatGPT show rendered thumbnails. (src/components/library/library-items.tsx EntryPreview; src/components/artifacts/artifact-preview.tsx:155)
- [low] The research details tablist uses raw role=tab buttons with no arrow-key navigation, roving tabindex or tab ids (the tabpanel has no aria-labelledby). The recap disclosure has no aria-controls. (src/components/research/research-console.tsx TABS block; research-recap.tsx work disclosure)
- [low] The Library menu for an artifact has no Rename, and its items have no icons, unlike every other menu. (src/components/artifacts/artifact-lifecycle-actions.tsx; src/components/library/library-items.tsx EntryMenu)
- [low] The codename leaks into user-visible file names: juno-memory-YYYY-MM-DD.json and *.juno.design.json. (src/components/memory/use-memory.ts:599; src/components/canvas/canvas-panel.tsx EXTENSIONS; src/app/(app)/artifacts/page.tsx DOWNLOAD_EXTENSIONS)
- [low] 'Saved in Library' after a research run is plain text, not a link to the saved report. (src/components/research/research-recap.tsx)
- [low] Live and finished research headers always show the run's dollar cost, which may alarm consumer users. Neither ChatGPT nor Claude shows money on a run, so this should probably be a setting. (src/components/research/research-console.tsx, research-recap.tsx (formatMicroUsd))
- [low] The chat payload includes up to 50 full version bodies per artifact. That is heavy for long documents, and the canvas cannot reach versions older than the window. (src/lib/artifact-access.ts ARTIFACT_VERSION_WINDOW; src/lib/serializers.ts ARTIFACT_CLIENT_INCLUDE)
- [low] The canvas history rail has a fixed w-48, which leaves the diff cramped in a docked panel of about 450 px. Closing history remounts the sandbox, so a running preview restarts and its console is lost. (src/components/canvas/canvas-panel.tsx history branch)
- [low] Memory export offers only machine JSON. There is no readable Markdown or text export to carry memories to another assistant. (src/components/memory/use-memory.ts exportMemory)
- [low] Deep research appears in the UI as 'Deep Field'. Users look for 'Deep research', so discoverability depends on the composer toggle and secondary labels. (src/lib/brand/names.ts FEATURE_NAMES.research)

**Motion notes**

- Research (research.css): motion only reports state changes, with no idle loops. Sections rise in on an 800 ms ease-out-expo staggered 70 ms. Source points arrive where they were discovered and travel inward over 900 ms as they are read and cited, the line to the page being read draws on, and figures roll (RollingNumber). prefers-reduced-motion and a dev data-motion='reduce' switch both place everything at its end state. This is the most deliberate motion in the product.
- Research report: jumpToSection scrolls smoothly and switches to instant under reduced motion. Tab panels enter with a 360 ms rf-view-enter rise. The tab underline scales in over 320 ms.
- Memory (memory.css): the title and figures rise (900 ms, 70 ms stagger), and constellation nodes pop in after a 520 ms delay. List rows reveal in sequence as each section scrolls into view (IntersectionObserver plus data-on). One deliberate infinite 'breathe' loop marks the live topic ring. Risk: .mem-reveal rows start at opacity 0, so if the observer never fires (print, some embedded webviews) rows stay invisible.
- Memory prompt dock: drafts unfold with framer-motion AnimatePresence and useReducedMotion. An applied change holds an inline Undo for 4.5 s, then folds away. Rows a change touched stay highlighted for 1.4 s.
- Semantic artifacts (semantic.css): cells recalculated by an edit settle from presence blue over 1.4 s, AI-changed document blocks ink in over 1.6 s, and changed slides ring over 1.6 s. Reduced motion is honoured. This is excellent 'what changed' signalling that competitors lack.
- Canvas: history and workspace swap through AnimatePresence mode='wait' with opacity only. The outgoing view must finish before the incoming one starts, which adds latency, and the workspace remounts (the sandbox reloads). Fullscreen fades in only: there is no exit animation and no shared-element transition from docked to fullscreen. Status words fade in, the save bar rises in, and the overflow icon swaps to a spinner during Office export without reflowing.
- Library tiles: hovering lifts the tile 1 px and deepens its shadow, pressing scales it to 0.99, and the first eight tiles get a staggered rise-in at 30 ms steps. Reduced motion keeps only the colour change. List view rises in as one block. Each tile mounts its own ResizeObserver to scale its miniature, which is a small cost per tile.
- Artifacts home uses staggerDelay entrances. Trash, lifecycle dialogs and the knowledge document page have little or no motion and stand out against the editorial surfaces.
- Visual language is split. Research, Memory, Projects and semantic artifacts share an editorial system (dot-matrix rules, Newsreader serif, mono annotations, presence blue). Library home, /artifacts, the canvas chrome, trash and lifecycle dialogs use generic card and border chrome. Presence blue is hard-coded as #2d49c9 / #97a6e6 in four scoped variables (--rf-, --mem-, --sx-, --pj-presence) instead of one global token.

**Feature status**

- **Deep research planning gate (scope card, clarify gate, effort tiers, editable questions, source toggles, estimate line)**: solid. Nothing is spent before Start. Questions can be edited in place, Update plan asks for a revision, and the estimate comes from the tier table (RESEARCH_TIERS). The run offers four depths: Quick, Standard, Deep and Max. Ahead of ChatGPT's clarify-then-run flow because the plan itself can be edited. (Evidence: src/components/research/scope-card.tsx, scope-draft.ts, run-controls.tsx (ClarifyGate, PlanOutline), effort-copy.ts, src/lib/research/planner.ts, src/app/api/research/[id]/plan/route.ts, [id]/clarify/route.ts)
- **Live research console (Deep Field source map, question rail, rolling figures, emerging answers, details tabs)**: solid. Each real source sits on an orbit for how far it got (found, read or cited), and the page being read now gets its own highlight. A recovery line explains retries in plain words. Details sit in tabs: Sources, Evidence, Activity, Researchers and Plan. The tablist has no arrow-key handling or roving tabindex. The map uses role=img and its labels are tabIndex=-1, so they can only be reached by mouse. (Evidence: src/components/research/research-console.tsx, deep-field.tsx, deep-field-model.ts, emerging-answers.tsx, run-timeline.tsx, source-deck.tsx, evidence-panel.tsx, workspace-model.ts, research.css)
- **Mid-run control: guide (steer), pause/resume, 'Write with what you have', stop**: solid. Guidance is queued and applied at the next round, and the UI shows whether it is queued or applied. Finishing early with the evidence gathered so far is a real differentiator against ChatGPT and Claude research. (Evidence: research-console.tsx controls block, src/components/research/steer.ts, src/app/api/research/[id]/steer/route.ts, [id]/control/route.ts)
- **Private sources in research (files, project, library, memory, calendar, mail, connectors)**: solid. Offered and enabled sources are intersected on the server, so a crafted request cannot turn on a source that was not offered. Private sources use https://private.invalid/ addressing so they never resolve and stay compatible with shipped native clients. Memory is off by default. (Evidence: src/lib/research/private-sources.ts, private-retrieval.ts, private-retrieval-core.ts, src/components/research/private-source-icon.tsx)
- **Citation audit, support marks per claim group, verbatim-passage citation cards**: solid. Support is shown as glyph plus word (supported, partial, not checked, not supported, contradicted), never colour alone. Ahead of competitors on verifiability. (Evidence: src/components/research/report-document.tsx (SupportMark, useReportModel), citation-card.tsx, src/components/chat/citation-audit.tsx, src/lib/research/claims.ts, claim-analysis.ts)
- **Full-screen report reader (TOC rail, 70ch measure, cited-sources rail with active citation)**: solid. Responsive at three widths and doubles as the print/PDF source. It has no copy-report action, no open-in-canvas or edit, no share and no DOCX. (Evidence: src/components/research/report-fullscreen.tsx, report-structure.ts)
- **Research report export (Markdown, PDF)**: partial. DEFECT: ResearchExportContext is never provided anywhere, so production Markdown export always uses the fallback. That fallback returns the raw report body with the <!-- juno:section=… --> markers, keeps the model's own sources list, and names the file research-YYYY-MM-DD.md. The proper exporter (front matter, numbered sources appendix, title slug) is dead code. PDF only goes through window.print. There is no DOCX from the reader, although the report is also saved as a MARKDOWN artifact that the canvas can export to Office. (Evidence: src/components/research/report-export.tsx:46 (ResearchExportContext default = fallbackMarkdownExport), :82; src/lib/research/export.ts (reportMarkdownExport, exportFileName used only by tests/research-export.test.ts))
- **Completion awareness (tab title, toast, browser notification, live refetch)**: solid. Announces only on transitions, so a reload never re-announces. Polls every 20 s while the tab is visible and every 60 s while hidden. (Evidence: src/components/research/completion-watch.ts, research-discovery.ts, scope-card.tsx (Notification.requestPermission))
- **Finished-run recap (cover, verdict, figures, audit headline, Go further suggestions, retry)**: solid. The 'Saved in Library' line is plain text, not a link to the item. The 'How it was researched' disclosure button has no aria-controls. (Evidence: src/components/research/research-recap.tsx, next-steps.ts, src/lib/research/completion-core.ts)
- **Research history / runs index outside a conversation**: missing. No list of past research runs. Reports can only be found through their chat or as MARKDOWN artifacts in Library. (Evidence: src/app/(app)/research/page.tsx (redirect to /chat?research=1), src/app/(app)/research/[id]/page.tsx (redirect into chat))
- **Library home (made items, files and media in one feed; grid/list; search; upload and drop anywhere; storage line)**: partial. Search matches titles and file names only. There is no type filter for made items (documents, sheets, decks, code) and no sort. Two independently paginated feeds are merged and re-sorted on the client, so loading more inserts older items in the middle of the list. Deliverable tiles link to /api/work/artifacts/{id}/download in a new tab, and file tiles open the raw file.url in a new tab instead of the in-app DocumentViewer. HTML and React tiles show source code instead of a rendered thumbnail; decks, sheets and documents show only their title on a blank page. (Evidence: src/components/library/library-home.tsx, library-items.tsx, src/app/api/library/made/route.ts, src/lib/library-made.ts, src/app/api/library/route.ts)
- **Library file manager (?view=files: multi-select, sort, versions, rename, delete)**: solid. Shows per-file indexing state and the error in words (index-status.tsx). (Evidence: src/components/library/library-files-page.tsx, library-browser.tsx, library-toolbar.tsx, library-dialogs.tsx, use-library.ts)
- **Recently deleted (trash)**: partial. Very bare next to the rest of the product. Every artifact gets the 'Document' glyph whatever its type. There is no delete-forever or empty-trash action, deleted files show no purge date, and deliverables are not included. Loading is a plain text line and the empty state is a bare paragraph. (Evidence: src/components/library/library-trash.tsx)
- **Cross-library content search (search inside documents)**: missing. The hybrid index is built but only reachable through chat retrieval. There is no 'search my files' UI. (Evidence: src/lib/knowledge/retrieve.ts exists, but no UI calls it; /api/knowledge only serves document detail)
- **Knowledge ingestion and hybrid retrieval (PDF, DOCX, XLSX, PPTX, ODT, RTF, OCR; embeddings plus lexical with RRF)**: solid. Limitation stated in the code: the semantic stage only rescores lexical candidates (no pgvector), so synonym-only matches are missed. With no embedding provider (for example a same_provider policy on Anthropic) it falls back to lexical only. (Evidence: src/lib/knowledge/ingest.ts, extract/*, ocr.ts, chunk.ts, embed.ts, retrieve.ts, rank.ts)
- **Knowledge document detail (blocks with page, slide, cell or line locators; search within the document)**: solid. Useful for checking what was extracted, but not linked from Library tiles. (Evidence: src/app/(app)/knowledge/documents/[id]/page.tsx)
- **Project knowledge (files and artifacts, nested folders with inherited instructions and files, per-project tool restrictions, work defaults, members, project memory)**: solid. Missing: sources synced from connectors (Drive, GitHub, Notion) like Claude and ChatGPT Projects, and a knowledge-capacity indicator. (Evidence: src/app/(app)/projects/[id]/page.tsx, src/components/projects/project-sources-list.tsx, project-folders.tsx, project-instructions-dialog.tsx, src/lib/projects/*, src/app/api/projects/[id]/memory/route.ts)
- **Artifacts home (/artifacts: type chips, search, grid/list, New design presets)**: partial. Loads at most 200 artifacts with no pagination, and search runs on the client over those. TYPE_LABELS maps both MARKDOWN and DOCUMENT to 'Documents', so two identical chips appear. Tiles for document, sheet and deck types are glyphs only. The page duplicates Library's 'Made by Alevr' filter with different capabilities, and the sidebar highlights Library for both routes. (Evidence: src/app/(app)/artifacts/page.tsx, src/app/api/artifacts/route.ts:47 (take: 200), src/lib/artifacts-home.ts (HOME_TYPE_ORDER), src/components/artifacts/artifact-preview.tsx)
- **Canvas panel: live preview (HTML, React, SVG, Mermaid), console, Python and JS runs, device widths, element inspector, selection Ask/Modify, fullscreen**: solid. Preview can be sized to real 390 px and 834 px device widths. When a version fails it offers the last version that rendered. The selection bar and element inspector feed scoped edits back to the composer. (Evidence: src/components/canvas/canvas-panel.tsx, sandbox-frame.tsx, sandbox-document-frame.tsx, src/lib/sandbox/console-doc.ts, src/lib/artifact-runtime.ts)
- **Targeted AI edits and suggestion guard (search/replace patches; pending suggestion bar with Compare, Apply, Dismiss)**: solid. Text outside accepted ranges stays byte-identical. An AI rewrite after a user edit is held as a suggestion instead of overwriting the user's work. Better than Claude and ChatGPT here. (Evidence: src/lib/artifact-edit.ts, src/lib/artifact-proposals.ts, src/components/artifacts/suggestion-bar.tsx, suggestion-compare-dialog.tsx)
- **Canvas version history (rail, line diff, copy unified diff, restore as new version, stale-write guard)**: solid. The chat payload carries up to 50 full version bodies per artifact, which is heavy. The canvas cannot reach versions older than that window. Closing history remounts the workspace, so the sandbox reloads. (Evidence: canvas-panel.tsx (diffLines, unifiedDiff, appendVersion 409 handling), src/lib/line-diff.ts, src/lib/artifact-access.ts (ARTIFACT_VERSION_WINDOW=50))
- **Canvas source editing**: partial. The overlay editor has no autocomplete, find/replace, multi-cursor or folding. DEFECT: an unsaved draft is silently thrown away when the canvas closes or another artifact opens. There is no confirm, no autosave and no beforeunload. Drafts persist only for the design editor (/api/artifacts/[id]/draft). (Evidence: src/components/canvas/code-surface.tsx (textarea over highlight.js), canvas-panel.tsx:260-276 (reset on artifact.id), :932 (Close))
- **React artifact runtime**: partial. Only React hooks and lucide-react are provided. Every other import (recharts, d3, three, shadcn/ui, lodash) is removed by a regex, so the component fails with a ReferenceError at runtime. The prompt asks for interactive charts but no chart library is available. The page loads development builds of React. Artifacts have no persistent storage (localStorage is shimmed) and cannot call the model, which Claude artifacts can. (Evidence: src/lib/sandbox/console-doc.ts:61 (stripImports), src/components/canvas/sandbox-frame.tsx reactDoc (React UMD development build, Babel in-browser, lucide shim), src/lib/chat/system-prompt.ts:248)
- **Document artifacts (semantic DOCUMENT)**: partial. Renders a well-typeset page with margin comments and inline suggested revisions (Accept, Reject, Resolve). The user cannot type into the document, add a comment, or insert, delete or move a block, although the ops engine supports all of these. Selecting text gets no Ask/Modify bar, because previewScrollRef is attached only to the Markdown view. (Evidence: src/components/semantic/document-view.tsx, src/lib/work/deliverables/semantic/document/ops.ts (updateText, insertBlock, deleteBlock, moveBlock, comment, suggestRevision…))
- **Markdown documents in canvas**: partial. Read-only render; editing means raw Markdown in the Code tab. There is no WYSIWYG editing and none of ChatGPT Canvas's shortcuts (adjust length, reading level, final polish, add emojis, add comments, add logs, fix bugs, port to language). (Evidence: canvas-panel.tsx isMarkdown branch (read-only Markdown render, max-w-3xl))
- **Spreadsheet artifacts (formula engine, number formats, frozen panes, filters, charts, cell editing)**: partial. The formula engine and the presence-blue recalculation highlight are strong. The grid silently stops at 400 rows and 40 columns with no notice, and up to 16k cells render without virtualization. There is no range selection, copy/paste, fill, sort, column resize or insert/delete row from the UI. (Evidence: src/components/semantic/spreadsheet-view.tsx (MAX_ROWS=400, MAX_COLS=40), src/lib/work/deliverables/semantic/workbook/*)
- **Deck artifacts**: partial. Thumbnail strip, arrow-key navigation, speaker notes and fit warnings. The only edits are 'Move earlier' and 'Duplicate': no move later, delete or text editing in the UI, though the ops engine supports updateText, deleteSlide, insertSlide and updateSlide. There is no presenter or fullscreen mode. (Evidence: src/components/semantic/deck-view.tsx, src/lib/work/deliverables/semantic/deck/ops.ts, deck/fit.ts)
- **Exports (Office docx/xlsx/pptx from Markdown and semantic artifacts, source download, version zip with history)**: partial. Exported files are re-opened to verify them before download. There is no PDF export for document or deck artifacts. The Office export menu hides itself while an older version is on screen. (Evidence: src/app/api/artifacts/[id]/export/route.ts, src/lib/office-export.ts, office-export-verify.ts, semantic/document/docx-export.ts, deck/pptx-export.ts, workbook/xlsx.ts, src/app/api/artifacts/[id]/download/route.ts)
- **Work deliverables (agent-produced DOCX, XLSX, PPTX, report, site with validation and hashing)**: partial. The generators and the build, cap, hash, validate order are solid. In Library these are download-only. The spreadsheet preview route and the site previewer are not used there, and deliverables cannot be edited as semantic artifacts. (Evidence: src/lib/work/deliverables/index.ts, validate.ts, src/app/api/work/artifacts/[id]/preview/route.ts, src/components/work/work-site-preview.tsx)
- **Design artifacts (editor with layers, inspector, effects, motion and interactions panels; posters)**: solid. Large Figma-like surface with draft checkpoints and posters rendered on the server. Neither ChatGPT nor Claude has an equivalent. (Evidence: src/components/design/design-editor.tsx, design-canvas.tsx, layers-panel.tsx, inspector-panel.tsx, effects-panel.tsx, motion-panel.tsx, interactions-panel.tsx, src/app/(app)/a/[id]/page.tsx)
- **Artifact lifecycle (publish, version history, compare, restore, make a copy, download, trash)**: partial. There is no Rename in this menu (only /artifacts has one) and the menu items have no icons. History shows raw origin strings such as 'generated' and 'edit'. Compare is two plain <pre> blocks truncated at 20k characters with no diff, unlike the canvas line diff. /a/{id} is read-only for every type except design, so an artifact whose chat was deleted can no longer be edited. json() parses the response body before checking response.ok, so a non-JSON error page shows the parser error to the user. (Evidence: src/components/artifacts/artifact-lifecycle-actions.tsx, src/app/(app)/a/[id]/artifact-read-view.tsx)
- **Sharing and publishing artifacts (public publication, poster, takedown, view counts)**: solid. Missing: a 'Remix' or 'Make a copy' for viewers of a published artifact, like Claude's customize-artifact flow. (Evidence: src/lib/artifact-publication.ts, src/app/share/[token]/page.tsx, src/components/share/shared-artifact-viewer.tsx, src/lib/artifact-takedown.ts)
- **Memory page (summary, natural-language prompt dock with drafted diff, Apply and Undo, topic constellation, list by topic or date, search, edit, move to project, forget vs delete)**: solid. Drafting an edit writes nothing, Apply is the only write, and an inline Undo stays for 4.5 s. Forget blocks the fact from being learned again (memory-suppression.ts); Delete allows relearning. Undo on removal is deferred. Clearly more control than ChatGPT or Claude memory. (Evidence: src/components/memory/memory-manager.tsx, prompt-dock.tsx, operation-diff.tsx, memory-list.tsx, entry-row.tsx, memory-constellation.tsx, summary-panel.tsx, use-memory.ts, use-deferred-removal.ts)
- **Memory activity (edit ledger, recap over a chosen period)**: solid. The edit history keeps inverse operations, so changes can be reverted. (Evidence: src/components/memory/activity-sheet.tsx, recap-view.tsx, src/app/api/memory/edits/*, src/lib/memory-recap.ts)
- **Memory import, export and reset**: partial. Import uses a deterministic parse that never shows the pasted text to a model (injection-safe), and the user ticks each line to keep. Export is raw JSON only, with no readable Markdown, and the file is named 'juno-memory-…', leaking the codename instead of Alevr. (Evidence: src/components/memory/import-dialog.tsx, src/lib/memory-import.ts, use-memory.ts:593 (exportMemory), memory-footer.tsx)
- **Project-scoped memory, backfill from past chats, background dreaming, skill candidates (procedural memory)**: solid. Background learning follows the provider policy, sensitive memories are classified, and the lifecycle supports expiry and consolidation. (Evidence: src/lib/memory-scope.ts, memory-dreamer.ts, memory-dreaming.ts, src/components/memory/use-backfill.ts, skill-candidates.tsx, src/lib/procedural-memory*.ts, memory-sensitive.ts)
- **In-chat memory signals ('Memory updated', 'Remembered about you' context)**: solid. Matches ChatGPT's 'Memory updated'. (Evidence: src/components/chat/chat-view.tsx:2386, src/components/chat/thought-process-model.tsx:391)
- **In-app document viewer for files (PDF, image, text, reader, find, selection ask)**: solid. Only mounted in the chat panel. Library and the project sources list open files in a raw browser tab instead. (Evidence: src/components/documents/document-viewer.tsx, pdf-view.tsx, reader-view.tsx, find.ts)

### Native apps: macOS (native/macOS/JunoDesktop, native/Packages/*) and iOS/iPadOS (native/iOS/JunoMobile). Scope: parity with web, chat, voice, Code remote control, widgets/shortcuts/notifications, offline behaviour. Read-only audit of current code at HEAD 11808e644. Docs were checked against the code. PARITY_MATRIX.md, capabilities.ts and PARITY_2026-10-08.md are partly out of date: iOS StoreKit purchase, iOS /api/search, native semantic artifacts, iOS Find, project folders, username and iOS account security all exist in code now.

**Strengths**

- Truly native and very large: about 589k lines of Swift across the macOS 26 and iOS 26 apps and shared packages (JunoNativeKit, JunoCode, JunoWork, JunoScreenControl). There are 5,679 test cases, including snapshot tests of the transcript and model picker.
- Parity is held by machinery, not hope: a generated route and page ledger checked in CI (npm run native:parity:check confirms the Swift really calls each 'native' route) plus a field-by-field chat wire schema (native:wire:check).
- Local-first architecture: an encrypted per-account SQLite store, a durable mutation outbox with idempotency keys and conflict resolution, cursor sync with a wake-up stream, and a candid recovery screen when the store cannot be unlocked.
- The Mac's local Alevr Code rivals Codex and Claude Code desktop: worktrees, turn checkpoints, a permission ladder with a command classifier, dev-server preview with element inspection, a simulator dock, CI watch, git publish, hooks, MCP, skills and subagents, and computer use with per-app consent and an Esc stop.
- The iPhone can supervise and drive Mac Code sessions over a paired device link: QR pairing, live stream, approvals, diff review, terminal, screens, ship, subagents, queued prompts, voice and dictation. ChatGPT and Claude mobile only reach cloud runs.
- Rich answer rendering on both apps: GFM tables, LaTeX, Mermaid, charts, Live UI lessons, syntax highlighting, inline artifacts with a canvas, semantic spreadsheets, documents and presentations, the hosted design editor, research reports with PDF export, and approval cards.
- Mature voice mode: a multi-provider realtime relay, the call inside the composer, camera, screen share where supported, interruption and route handling, an idempotent transcript save, haptics, VoiceOver announcements and a Live Activity.
- Mac-native touches: a privacy-preserving ⇧⌘1 screenshot through the system content picker, a menu bar extra with Needs You and live sessions, a Dock badge, one shortcut registry that drives both menus and the shortcuts window, adjustable text size, the updater and Handoff.
- Accessibility and motion discipline: no fixed-size fonts on iOS, wide VoiceOver labelling, Reduce Motion substitutes everywhere, motion tokens shared with the web, and careful copy that states limits honestly.

**UX issues**

- [high] The iOS entitlements file is an empty dict. Commit 615d3a5b0 (an Xcode regeneration) silently removed the aps-environment key that 6e0176967 had added. registerForRemoteNotifications fails in every build. That kills all server push on iPhone: agents, Work, research ready, Code approval notifications with their Face ID Allow/Deny actions, and 'Continue on iPhone'. (native/iOS/JunoMobile/Resources/JunoMobile.entitlements; native/Config/JunoMobile-*.xcconfig:14; JunoMobileApp.swift:414)
- [high] Only one chat can generate at a time across the whole app. On the Mac, isGenerating is global (ChatComposer.swift:1015), so opening another chat while one streams turns that chat's primary button into Stop, and pressing it stops the other conversation. On iOS, Send is greyed out in every other chat with no explanation. If a send still gets through, it fails with the wrong message, 'The conversation is no longer available.' (conversationPendingMessage). (NativeConversationStore.swift:876-878, :1014, :2464-2469, :3960-3965; macOS ChatComposer.swift:62-68, :1015; iOS JunoMobileComposer.swift:305-315)
- [high] 'Continue on Mac' and 'Continue on iPhone' always fail in shipping builds. The server delivers handoff only by APNs, Developer ID Mac builds cannot register for push, and iOS lacks the entitlement. People get 'No Mac signed in to Alevr can receive it. Open Alevr on your Mac first.' even with the Mac app open. (src/app/api/sync/handoff/route.ts:33-44; JunoDesktopApp.swift:167-173; iOS JunoMobileHandoff.swift (JunoMobileContinueOnMenu))
- [medium] The Mac offline caption promises 'Offline · messages send when you're back', and the enum comment says queued messages send on reconnect. In fact chat sends are never queued. They show 'Not sent' and need a manual Retry. The unsent text and its retry context are kept only in memory, so quitting the app (or iOS killing it) loses the message. (macOS ChatDetail.swift:105-125; NativeConversationStore.swift:1077-1081, :1020-1031)
- [medium] The small iOS widget is broken. It uses four Link views, which WidgetKit ignores in systemSmall (one tap target only), so no tile opens its own route. Its four 44pt-minimum tiles plus three 8pt gaps need about 200pt, more than the small widget's content height, so tiles get clipped or squeezed. The widget description also reads 'Start a Alevr chat'. (native/iOS/JunoMobile/Widgets/JunoMobileWidgets.swift:26-37, :52, :86-94)
- [medium] Quick Entry falls short of ChatGPT's and Claude's launchers. ⌥Space comes from an NSEvent global monitor: it needs Accessibility permission (an extra prompt inside the panel), it cannot consume the key, so the front app also receives ⌥Space and a non-breaking space appears in whatever field had focus, and it cannot be rebound. Return does not get an answer. It switches to the main window and drops the text into a new composer, so it takes a second Return. (native/macOS/JunoDesktop/App/DesktopQuickEntry.swift:54-75, :272-330)
- [medium] The Code approval Live Activity is almost never seen. It starts only in the older relay thread view, only while that thread is on screen, which is exactly when you can already see the approval card. The primary v2 device-link thread never starts one. There is no push-to-start. Lock Screen Allow and Deny open the app instead of answering in place. (iOS JunoMobileCodeRemote.swift:237-247; JunoMobileLinkThread.swift (no presentApproval); JunoMobileWidgets.swift:259-285)
- [medium] Neither app watches the network (no NWPathMonitor anywhere). On iOS the offline banner comes only from a failed session restore. Losing the connection mid-session shows up later as scattered per-page errors and failed sends, not one clear offline state. (iOS JunoMobileRootView.swift:447-455; JunoAuth/NativeAuthModel.swift:40-111)
- [medium] During a turn on iOS the phone shows 'Thinking' and the reasoning text, but none of the tool, search or connector steps the Mac's ActivityPanel and the web timeline show. Long agentic turns look stalled. (iOS JunoMobileThoughtProcess.swift:26-60)
- [medium] When a chat starts a task on iPhone, the transcript shows no run card. The person has to find it in the separate Work tab, while the Mac and the web draw it inside the chat. (iOS JunoMobileConversationsView.swift (no Work run card); JunoMobileWorkView.swift; PARITY_MATRIX.md:366)
- [medium] Screen share during an iOS voice call uses RPScreenRecorder in-app capture, which records only Alevr's own interface. The person cannot show the assistant another app; that would need a Broadcast Upload extension. (iOS JunoMobileVoiceCamera.swift:129-160)
- [medium] Siri, Shortcuts and the widget all just open the app. 'Ask Alevr' never returns an answer inside Shortcuts or Siri, there are no conversation or project entities, there is no share extension, and there are no Control Center or Lock Screen controls. These are all daily entry points in ChatGPT and Claude. (iOS JunoMobileIntents.swift:162-279; native/iOS/JunoMobile/project.yml)
- [low] The iPhone composer stops growing at 6 lines and has no full-screen editor for long prompts. (iOS JunoMobileComposer.swift:446-447)
- [low] With the push drawer open, the conversation behind it is still reachable by VoiceOver, and there is no accessibilityAction(.escape) (two-finger scrub) to close the drawer. (iOS JunoMobilePhoneShell.swift:118-150)
- [low] The pushed card's corner radius is guessed from screen width. iPhone SE (375pt) and 8 Plus (414pt), which have square screen corners, get 47pt corners, and newer widths fall through to 40pt. (iOS JunoMobilePhoneShell.swift:55-62)
- [low] The approval deep link (com.liammagnier.juno://juno/code/approval?...&approved=true) sends the decision straight away, with no Face ID and no on-screen confirmation. The notification-action path asks for Face ID. Request IDs are hard to guess, but the two paths should behave the same. (iOS JunoMobileIntents.swift:140-149; JunoMobileRootView.swift:821-831)
- [low] The Mac has no keyboard shortcut to start a voice conversation or dictation; the shortcut registry has none. (macOS JunoShortcutRegistry.swift:307-321)
- [low] The iPad cannot open multiple windows. Info.plist has no UIApplicationSceneManifest, so 'open chat in new window' and side-by-side Alevr windows are impossible. (native/iOS/JunoMobile/Resources/Info.plist)
- [low] Grammar mistakes in user-facing text: 'a Alevr' instead of 'an Alevr'. (JunoMobileWidgets.swift:52; JunoDesignKit/DesignDocumentCodec.swift:21)
- [low] The status docs have drifted from the code: PARITY_MATRIX.md says the phone has no plan purchase, capabilities.ts says native lacks unified search and semantic artifacts, and PARITY_2026-10-08 lists iOS Find, Skills and account security as missing. Prioritising from these docs would aim work at gaps already closed. (docs/native/PARITY_MATRIX.md:603; src/lib/capabilities.ts:329-330, 611-612; docs/native/PARITY_2026-10-08.md)
- [low] Repository and config hygiene. build_log.txt and build_pid.txt are committed. project.yml and the pbxproj say iOS 18.0 while the xcconfigs and Package.swift require 26.0. iOS Spotlight deletes and rebuilds the whole index domain on every sync. (native/macOS/JunoDesktop/build_log.txt, build_pid.txt; native/iOS/JunoMobile/project.yml:4-5; JunoMobileSpotlight.swift:34-37)

**Motion notes**

- The motion tokens are generated from the web's CSS (JunoDesignTokens.swift:225-290): press 70ms, fast 120ms, exit 160ms on ease-in, base 220ms, slow 360ms on expo. The standard and emphasized springs are scaled per platform. Entrances and exits are asymmetric (junoOverlay and junoInline transitions). JunoMotion.reduced() substitutes for Reduce Motion everywhere: 237 references on iOS and 345 on the Mac, and only 4 repeatForever loops in the codebase.
- The streaming pacer (JunoStreamReveal.swift) releases text at an adaptive speed: 0.25s target lag, a 40 characters-per-second floor, a jump when the backlog passes 900 characters, and a full flush on finish. New words fade in. Network bursts never make the text lurch. This is at or above ChatGPT's level of polish.
- The iPhone push drawer copies ChatGPT's gesture. It is interactive and settles in the direction the finger was heading, using the drawerSettle spring. The sidebar parallaxes by 22%, the pushed card keeps concentric continuous corners with a backward shadow and a dim, and a haptic fires on open. Under Reduce Motion it becomes a cross-fade. The corner radius is guessed from screen width and is wrong on some models.
- Composer: an emphasized spring carries it from the empty-state greeting into the conversation (handoff(reduceMotion:)). The primary disc changes face between voice, send, stop and busy by kind, cross-fading only when the kind changes. A border beam starts only after a reply has streamed for 3 seconds, so short answers never flash an effect. Chip presses dip to 0.97, honour Reduce Motion, and are sized to suit Liquid Glass.
- Voice: the composer edge glows with live mic and reply loudness (JunoMobileVoiceComposerGlow, DesktopVoiceComposerGlow). Haptics fire on connect and a light tap when Alevr starts speaking, and every phase change is announced to VoiceOver.
- The thought-process row goes from a live dot-matrix meter with a running clock to a resting 'THOUGHT PROCESS 8.4s ›' receipt in the same slot, so the eye follows one object. The galaxy working mark and AIcss reasoning lines draw the thinking state.
- The Mac uses real Liquid Glass on macOS 26 (glassEffect, glassEffectID morphs, GlassEffectContainer). Quick Entry is the one custom glass panel outside the main window. iOS uses .glass and .glassProminent button styles and interactive glass capsules.
- Gaps: widgets and Live Activities are static. They have no progress, animated waveform or count changes, the widget timeline policy is .never, and voice and approval cards show plain text states. There is no native transcript rail (per-turn ticks with hover previews) and no per-turn scrub animation. The iOS run trace has no animated tool-step list like the web and Mac activity timeline.

**Feature status**

- **Chat streaming and transcript rendering**: partial. Rendering is strong. It handles GFM tables, LaTeX, Mermaid, charts, Live UI, syntax highlighting, inline artifacts and approval cards, reconnect and resume (/api/chat/stream/active), Continue after a length or network cut, and paced streaming. The big limit: there is one chat generation for the whole app. chatPhase and activeChatConversationID live on the store (NativeConversationStore.swift:876-878, guard at :2464), so nobody can run two conversations at once, which ChatGPT and Claude both allow. Not adopted: durable first submission (/api/chat/receipt, clientRequestId) and Message.routing (the Auto receipt). (Evidence: native/Packages/JunoNativeKit/Sources/JunoChatKit/NativeConversationStore.swift (sendMessage ~2445-2560), ChatStreamReducer.swift, JunoDesignSystem/JunoMarkdown.swift, JunoMarkdownView.swift, JunoMathView.swift, MermaidDiagramView.swift, InlineChartRenderer.swift, JunoSyntaxHighlighter.swift, JunoStreamReveal.swift, macOS ChatTranscript.swift, iOS JunoMobileConversationsView.swift)
- **Message actions (copy, rate, regenerate, branch, read aloud, share, quote, edit)**: partial. The Mac has the full row. Regenerate offers Try again, Switch model, More concise and Add details. Branch can open a new chat or fork privately. There is also a receipt with model and cost. iOS adds Select text (a UITextView sheet) and Quote. Gaps: Regenerate only works on the newest reply. Edit-and-resend makes a local sibling branch and never calls PATCH /api/messages/[id], so the server keeps no versions (parity matrix: Planned). (Evidence: macOS MessageActions.swift:100-190; iOS JunoMobileMessageMenu.swift, JunoMobileConversationsView.swift:2486-2560; NativeBranchNavigator.swift; JunoMobileReadAloud.swift)
- **Run trace / tool activity timeline**: partial. The Mac shows tool runs in a panel. On iOS the ThoughtProcess row shows only the reasoning text and a clock. Its own comment says 'a client with no phase events'. The phone shows no live search queries, connector calls or tool steps during a turn. (Evidence: macOS ActivityPanel.swift:654 (NativeToolRunDetailView), NativeRunTimeline.swift; iOS JunoMobileThoughtProcess.swift)
- **Auto routing receipt / Auto preferences**: missing. Neither app shows which model Auto picked ('Auto · model · effort', 'Selected for'). Settings has no Auto preference and no data-boundary choice. (Evidence: src/lib/capabilities.ts auto_routing (native planned); no Message.routing rendering in JunoChatKit)
- **Pre-flight clarification card**: missing. Clarification exists only for Deep Research (clarifyResearch). There are no clarifying questions before an ordinary turn. (Evidence: docs/native/PARITY_MATRIX.md:128 (/api/chat/clarify Planned))
- **Run code blocks**: partial. JS, TS, Python and SQL run in the console document. Languages that need the hosted sandbox (C, C++, Go, Rust, Java, Ruby and others) have no Run button. (Evidence: NativeCodeConsoleClient.swift (/api/code/console in WKWebView); PARITY_MATRIX.md:136 (/api/code/run Planned))
- **Composer (attachments, tools, model and effort, mentions, slash commands)**: solid. Includes web search, deep research, canvas, memory, connectors, project, skills, @mentions from /api/mentions, media generation params, Attach as file for long pastes, and hardware-keyboard Return handling on iPad. Gaps: the iOS field stops growing at 6 lines and has no full-screen editor (ChatGPT has an expand control). No Sketch. The Mac's chat composer has no 'Work with apps' chip. AccessibilityEditorBufferReader exists but only as an agent tool behind ScreenControl. (Evidence: macOS ChatComposer.swift, ComposerPlusMenu.swift, ComposerModelChip.swift, DesktopScreenshotCapture.swift (⇧⌘1 via SCContentSharingPicker); iOS JunoMobileComposer.swift, JunoMobileAttachmentMenu.swift:292-545, JunoMobileSlashPalette.swift, JunoMobileCameraPanel.swift, JunoMobilePhotosPanel.swift; NativeComposerTray.swift, NativeMediaParams.swift)
- **Realtime voice mode**: solid. The call happens inside the composer. Supports several providers (Gemini, Qwen, MiniMax, xAI), camera on iOS, screen share where the provider accepts it, mute, and interruption and route-change handling. The transcript is saved idempotently into a chat. Haptics fire on connect and when Alevr starts speaking, phases are announced to VoiceOver, and a Live Activity runs. Background audio mode is set. Limits: on iOS, screen share uses in-app RPScreenRecorder capture (JunoMobileVoiceCamera.swift:129-160). That shares only Alevr's own screen; there is no Broadcast Upload extension for system-wide sharing. The Live Activity has no Mute or End controls. The Mac has no keyboard shortcut for voice or dictation. (Evidence: JunoVoiceKit/JunoRealtimeVoiceController.swift, RealtimeStreamingClient.swift, RealtimeAudioEngineEndpoint.swift; iOS JunoMobileVoiceView.swift, JunoMobileVoiceCamera.swift, JunoMobileVoiceAudioSession.swift; macOS DesktopVoice.swift:377-392)
- **Dictation and read aloud**: solid. Dictation runs on-device. Read aloud uses the server voice (/api/voice/tts) and falls back to AVSpeechSynthesizer when the server answers 501. Only one reader plays at a time. (Evidence: JunoMobileDictation.swift, macOS ComposerDictation.swift/DesktopDictation.swift, JunoSpeechService.swift, JunoMobileReadAloud.swift)
- **Offline / local-first behaviour**: partial. The local store is encrypted SQLite. Conversation edits (rename, pin, archive) go through a durable outbox with conflict resolution, and the Mac has an honest store-recovery screen. But chat messages are not queued: an offline send becomes 'Not sent' with a manual Retry. The unsent turn and its retry context live only in memory, so they are lost if the app quits or iOS kills it. The code has no NWPathMonitor anywhere. Offline state shows only after a restore or sync call has failed. (Evidence: JunoStorage/SQLiteAccountRepository.swift, AccountDataCipher.swift; JunoSync/PersistentMutationOutbox.swift, NativeSyncCoordinator.swift, NativeChangeWakeupStream.swift; NativeConversationStore.swift:3990-4090 (enqueueAndDrain, resolveConflicts), :1077-1081 (in-memory transient messages and retryContexts); macOS ChatDetail.swift:105-170; iOS JunoMobileRootView.swift:450-455)
- **Push notifications (iOS)**: partial. The code is complete: NativePushRegistrar, notification routes, Allow/Deny categories behind Face ID, mark-as-opened. But the shipped entitlements file has no aps-environment, so APNs registration fails in every configuration. That breaks push for agents, Work, research, Code approvals and handoff. Code approvals fall back to BGAppRefresh polling, which iOS runs at most a few times an hour. (Evidence: native/iOS/JunoMobile/Resources/JunoMobile.entitlements (empty <dict/>), commit 615d3a5b0 dropped aps-environment that 6e0176967 added; JunoMobileApp.swift:414 registerForRemoteNotifications; JunoMobileCodeNotifications.swift (BGAppRefresh fallback))
- **Notifications (macOS)**: partial. These work: local banners for Code runs, approvals and research, the Needs You Dock badge, the menu bar list and the in-app notification inbox. Server pushes cannot reach a Mac where Alevr is closed, because Developer ID builds cannot register for APNs. (Evidence: JunoDesktopApp.swift:167-173 (comment: Developer ID builds are refused push), StudioRunMonitor, DesktopResearchCompletions.swift, DesktopNeedsYouSignals.swift:71 (Dock badge), DesktopNotificationsPopover.swift)
- **Cross-device handoff (Continue on Mac / iPhone)**: partial. Apple Handoff through NSUserActivity is implemented on both apps and needs no push. The server-side 'Continue on…' delivers only by APNs (sendPushToDevices). The Mac cannot register for APNs and iOS lacks the entitlement, so the route returns 404: 'No Mac signed in to Alevr can receive it. Open Alevr on your Mac first.' (Evidence: iOS JunoMobileHandoff.swift; macOS DesktopHandoff.swift; JunoSync/ThreadSyncClient.swift:209; src/app/api/sync/handoff/route.ts:33-44)
- **Thread draft and composer sync across devices**: solid. Each thread's draft, composer settings, unread and needs-you state are shared over a debounced long-poll. (Evidence: JunoSync/ThreadSyncClient.swift (/api/sync/threads long-poll), iOS JunoMobileThreadSync.swift, macOS DesktopThreadSync.swift)
- **iOS Home Screen widget**: partial. One static Quick Actions widget (small and medium) with timeline policy .never. In the small size it uses four Link views; WidgetKit honours Links only in medium and larger, so a small widget has a single tap target. The four 44pt tiles plus spacing come to about 200pt, taller than the small widget's content area. Missing: Lock Screen accessory widgets, iOS 18 Control Center controls, and any recent-chats, needs-you or Code-status widget. (Evidence: native/iOS/JunoMobile/Widgets/JunoMobileWidgets.swift:44-124)
- **Live Activities / Dynamic Island**: partial. The voice activity shows only a status word (Connecting, Live, Muted). The Code approval activity starts only from the older relay thread view, and only while that thread is on screen. The v2 device-link thread (JunoMobileLinkThread) never starts one. There is no push-to-start, so it cannot appear from the background. Allow and Deny use openAppWhenRun and open the app. (Evidence: JunoMobileLiveActivities.swift; JunoMobileWidgets.swift:126-285; JunoMobileVoiceView.swift:678-690; JunoMobileCodeRemote.swift:237-247)
- **App Intents / Siri / Shortcuts / Home Screen quick actions**: partial. iOS has 5 intents (New chat, Voice, Dictate, Ask, Open Code); every one opens the app. Ask Alevr only opens the app with the question and never returns an answer inside Shortcuts or Siri. There are no AppEntity types for conversations or projects, so no 'open chat X' and no parameterised automations. The Mac has a single intent (Start an Alevr Code task). (Evidence: iOS JunoMobileIntents.swift:162-279, Info.plist UIApplicationShortcutItems; macOS JunoCodeIntents.swift)
- **Spotlight indexing**: partial. iOS indexes conversation titles only, by deleting and rebuilding the whole domain on every sync. The Mac does no CoreSpotlight indexing. (Evidence: iOS JunoMobileSpotlight.swift, JunoMobileRootView.swift:531-533)
- **Share extension / Services menu**: missing. There is no way to send text, a URL, a photo or a file to Alevr from another app on either platform. ChatGPT and Claude both ship share extensions. (Evidence: native/iOS/JunoMobile/project.yml (targets: app, widgets, tests only); native/macOS/JunoDesktop/project.yml (no extensions); no NSServices in Info.plist)
- **Mac Quick Entry (⌥Space)**: partial. A floating non-activating glass panel with a Chat/Code switch. Pressing Return does not answer in the panel. It brings up the main window with the text in a new chat or task. The global hotkey uses NSEvent.addGlobalMonitorForEvents, which needs Accessibility permission and cannot swallow the keystroke. The hotkey is fixed at ⌥Space. (Evidence: native/macOS/JunoDesktop/App/DesktopQuickEntry.swift:54-75, 303-330)
- **Mac menu bar extra and Dock presence**: solid. Offers New Chat, the Needs You chats with status subtitles, live Code sessions and 'Stop Alevr using apps'. Every item brings forward the existing window instead of opening a duplicate. (Evidence: DesktopMenuBarExtra.swift, DesktopNeedsYouSignals.swift, DesktopScreenPresence.swift)
- **Mac local Alevr Code agent**: solid. Includes worktrees, turn checkpoints and rewind, a command classifier with a permission ladder, dev-server preview with an inspection tool, a simulator dock, a terminal, CI watch, git publish and PR, hooks, MCP, skills and subagents, and computer use with per-app consent. Gaps: cloud environments on /code/customize, /api/agent/usage (Code turns are not counted against the plan), and mirroring /api/code/workspaces to the web. (Evidence: native/Packages/JunoCode/Sources/JunoCodeLocal (WorktreeManager, CheckpointStore, DevServerService, CIWatchService, Extensibility/HookTypes, ComputerUseCoordinator), JunoCodeRuntime/AgentOrchestrator.swift, JunoCodeUI/Studio/*, macOS DesktopCodeWorkspace.swift, DesktopCodePreviewDock.swift, DesktopSimulatorDock.swift)
- **iPhone remote control of Mac Code sessions**: solid. QR pairing with revoke. Live thread stream, approvals at the foot, diff review, terminal, screens, ship, continue on, subagent inspector, queued prompts, attachments, dictation and voice. Offline Mac states are handled. This goes beyond what ChatGPT's or Claude's mobile apps offer for a local agent. Approvals from the background depend on push, which is broken (see the iOS push entry). (Evidence: iOS JunoMobileLinkThread.swift, JunoMobileLinkComposer.swift, JunoMobileLinkSurfaces.swift, JunoMobileRemotePairing*.swift, JunoMobileCodeVoice.swift; JunoCode/Sources/JunoCodeRemote/CodeLinkRemoteModel.swift; macOS DesktopRemoteHostResponder.swift, DesktopRemotePairing.swift)
- **Cloud Code runs from native**: partial. Runs can be created, listed, followed (events), cancelled and answered. Missing: steer, open PR, CI checks, auto-fix, rollback, base-branch picker, repo skills and cloud-runner availability. The cloud composer on the phone takes text only. (Evidence: JunoCodeKit/NativeCodeTaskStore.swift:508-790; iOS JunoMobileCodeView.swift:14-580; PARITY_MATRIX.md:517-547)
- **Deep Research (Deep Field)**: solid. Live view, clarification, report window, PDF export, and completion notifications. On iOS, completion depends on BGAppRefresh because push is missing. (Evidence: NativeResearchRun.swift, NativeResearchLiveView.swift, NativeResearchReportPDF.swift; macOS ResearchViews.swift, ResearchReportWindow.swift; iOS JunoMobileResearch*.swift)
- **Tasks started from chat (Work runs)**: partial. The Mac draws the run card inside the chat. iOS has no run card in the transcript; the phone keeps its older separate Work tab. (Evidence: macOS ChatWorkRunCard.swift, ChatWorkPanel.swift, DesktopTaskRecordSheet.swift; iOS JunoMobileWorkView.swift (separate tab); PARITY_MATRIX.md:366)
- **Projects, folders, Library, Artifacts, Memory, Connections, Skills, Automations**: partial. The Mac is at near-web parity, including semantic spreadsheets, documents and presentations and the hosted design editor. iOS has no artifact page of its own, cannot write or edit a skill, and its routine editor has a single schedule (no events, targets or budgets). No Assistants or Permissions pages on iOS. Missing on both: key/token connector credentials, the knowledge document inspector, the saved-prompt library, and artifact proposals (Compare, Apply). (Evidence: macOS DesktopProjectPage.swift, DesktopProjectFolders.swift, DesktopLibraryScreen.swift, DesktopArtifactCanvas.swift, ArtifactPage.swift, DesktopMemoryScreen.swift, DesktopConnectionsScreen.swift, DesktopSkillPage.swift, DesktopAutomationEditor.swift; iOS JunoMobileProjectPage.swift, JunoMobileProjectFolders.swift, JunoMobileLibraryView.swift, JunoMobileDesignArtifact.swift:371-411 (SemanticArtifactView), JunoMobileSkillsView.swift, JunoMobileRoutinesView.swift)
- **Orbit agents**: partial. Missing on both: rooms, boards and goals, setup-change cards, undo and memory access. (Evidence: JunoWorkKit/Agents/NativeAgentsModel.swift; macOS DesktopAgentThread.swift; PARITY_MATRIX.md:441-463)
- **Search and find in conversation**: solid. capabilities.ts memory_session_search is wrong to say native does not call unified search; iOS does. (Evidence: macOS DesktopSearchPanel.swift, TranscriptFind.swift, DesktopFindBar.swift; iOS JunoMobileSearchView.swift (NativeServerSearchModel over /api/search plus local), JunoMobileFind.swift)
- **Settings and account**: partial. Covers MFA, password, sessions, username, export, account deletion, personalization, memory, models, voice, Code and notifications. Missing: the signed-in devices list (/api/v1/auth/devices), the email verification banner, the credential vault (/api/secrets) and the activity heatmap (/api/profile/stats). (Evidence: iOS JunoMobileSettingsView.swift:210-260, JunoMobileAccountSecurityView.swift; macOS DesktopSettings*Pane.swift, DesktopUsernameRow.swift)
- **Plans and billing**: partial. iOS sells plans through StoreKit; PARITY_MATRIX.md:603 is out of date on this. The Mac offers only a monthly Stripe sheet. (Evidence: iOS JunoMobilePlans.swift (StoreKit purchase and restore, POST /api/v1/billing/app-store); macOS DesktopUpgradeSheet.swift)
- **iPad experience**: partial. Includes a split view, a menu bar with shortcuts and a reading-width column. No multiple windows or Stage Manager scenes, no 'open chat in new window', and no Pencil sketch. (Evidence: iOS JunoMobileIPad.swift (NavigationSplitView, JunoMobileCommands, reading measure 768); Info.plist (no UIApplicationSceneManifest))
- **Sign-in**: partial. Sign-in goes only through the browser. There is no native Sign in with Apple sheet and no passkeys. (Evidence: iOS JunoMobileWebAuthenticationClient.swift (ASWebAuthenticationSession PKCE); src/lib/auth.ts (Google, Apple))
- **Accessibility**: solid. Strong overall. The custom push drawer is the exception; see the UX issues. (Evidence: iOS: 0 `.font(.system(size:))`, 305 semantic text styles, 184 accessibilityLabel; reduceMotion referenced 237 times (iOS) and 345 (Mac); JunoMobileVoiceView.swift:671-674 phase announcements)
- **Localization**: partial. English and French only. About 63% of the French strings exist, and many views use literal strings outside the catalog. (Evidence: native/iOS/JunoMobile/Resources/Localizable.xcstrings (614 keys, 388 with French))
- **Incognito / private chat**: solid. Private chats are not saved, and actions that need a saved message are hidden. (Evidence: NativePrivateChatModel.swift, iOS JunoMobileIncognito.swift, macOS DesktopCommands.swift:328)
- **Long-transcript performance**: partial. The Mac transcript is windowed. On iOS it is unmeasured at 1,000 messages, and the server sends the full payload. (Evidence: macOS ChatTranscript.swift (windowed); iOS JunoMobileConversationsView.swift:382-393 (LazyVStack); capabilities.ts chat_transcript_virtualization)
- **Model comparison / transcript rail / sketch**: missing. Compare is deferred (register #132). The per-turn tick rail and sketch input exist on the web only. (Evidence: NativeCompareView.swift exists but no call sites; no transcript rail or sketch code in native)

### Design system and motion across web and native (tokens, typography, colour, spacing, components, empty/loading/error states, galaxy working indicator, icon gestures, page transitions, reduced motion, accessibility, responsive)

**Strengths**

- A real token generator with a CI drift gate projects globals.css and tailwind.config.ts into Swift and TypeScript. It understands @layer versus conditional at-rules and does exact HSL->sRGB conversion. The check passes today.
- Design rules are enforced in lint, not just written down: no arbitrary radius, computed concentric radius, no ad-hoc z-index, a single icon import path, and text-size ratchets.
- A fully custom icon family with pixel-grid hinting, fractional-translate cancellation for crispness, on-state drawings, live data glyphs (voice levels, progress arc), and native SF Symbol templates generated from the same geometry.
- The galaxy working indicator is well engineered: a deterministic cross-platform particle field, rendering paused off screen and in hidden tabs, DPR and context-loss repaint, live reduced-motion observation, and eased stops on the web.
- The motion vocabulary is principled and documented with reasons (exit vs entrance curves, an emphasis rung reserved for changes the user didn't cause, stagger caps), and SwiftUI springs mirror the web exactly.
- The OS reduced-motion model is tiered rather than a kill switch, and it fixed a real layer-order bug where reduced-motion guards in @layer base silently lost. Native adds Reduce Transparency, Increase Contrast and cross-fade preference handling through one tested policy type.
- Accessibility care is visible in the tokens: muted ink retuned to clear AA on every reading ground, focus ring contrast measured, code-token colours fixed from 2.7:1 to 4.7:1+, a per-theme shadow ink that removes the dark-mode halo, and the popper z-index raised above modals.
- Empty and error states share one brand-led component: an open page variant versus a recessed panel variant, an h2 at page size, reassuring copy, and retry built in.
- Buttons in a loading state keep their width, cross-fade to a spinner, set aria-busy and stay disabled without dimming. A 1px transparent border on every variant prevents layout shift.
- Interface preferences (chat font, transcript width, code wrap, motion, text size) are applied before first paint through a boot script, and the theme script is CSP-nonce'd, so there's no flash on navigation.
- Native has Dynamic Type through @ScaledMetric pinned to the generated type ladder, system Liquid Glass, a coherent haptic vocabulary on iOS, and broad accessibility labelling (842 labels).

**UX issues**

- [medium] One run can show different working indicators at the same moment: galaxy in the transcript live line, the 3x3 RunGlyph matrix in the Activity side panel and Research plan card, shimmer text on native, and ~94 generic spinners elsewhere. Claude and ChatGPT each use one signature indicator. This breaks the 'one mark follows the truthful work row' contract in MOTION_AND_THINKING.md. (src/components/chat/live-line.tsx; src/components/chat/panel/activity-timeline-tab.tsx:152; src/components/research/scope-card.tsx:125; native JunoShimmerText.swift (17 sites))
- [medium] The in-app 'Reduced' motion setting applies a blanket !important kill (animation 0.01ms, one iteration, transitions 0.01ms). It drops even state-carrying feedback and fades, while the OS setting gets the careful tiered treatment. Two users asking for the same thing get different products. The spec's 'Full' option is also missing. (src/app/globals.css:4594-4602 vs 943-1000; src/lib/ui-prefs.ts:22)
- [medium] An accent picked on the web silently changes on native. Ultramarine is a web option, but JunoAccent has no case for it and falls back to Graphite, and the token generator's ACCENTS list leaves it out. (src/lib/accents.ts:9-21; scripts/generate-design-tokens.ts ACCENTS; native/.../JunoAccent.swift:13-37)
- [medium] Icon hover articulation now fires on every link, button, menu item, option and tab, with only one jicon-quiet opt-out. Dense menus, lists, the composer and message action rows wiggle on hover, against the brand spec's 'composer actions, menus, lists... remain stable'. The icons.tsx and juno-icons/index.tsx headers still say opt-in. (src/components/ui/juno-icons/icons.css:67-95; src/components/ui/icons.tsx:28-35)
- [medium] No RTL support: Arabic, Hebrew, Persian and Urdu are withheld because about 447 physical directional utilities would mirror wrongly. (src/lib/i18n.ts:95-106; src/components/**)
- [medium] Inter ships as a Latin-only subset while Cyrillic, Vietnamese, Polish and Turkish UI locales are offered, so their interface text renders in system-ui and the brand typography breaks. (src/app/layout.tsx (localFont inter-latin-wght-normal.woff2); src/app/fonts/)
- [medium] On mobile, Projects and Library push the first item to the fold: a large serif title, a two-line description, a big-number stat row, search, and filters all come before content. (artifacts/continuation-2026-10-15/projects-light-390.png, search-light-390.png)
- [medium] Mobile web has no gestures. Sheets and the sidebar can't be swiped open or closed, and dialogs stay centred modals rather than bottom sheets on phones. (src/components/ui/sheet.tsx; src/components/ui/dialog.tsx)
- [medium] Web accessibility has no automated checks: no axe or contrast tests in e2e/ or tests/. All contrast claims are hand measurements in comments. prefers-contrast: more covers only the composer. (e2e/; tests/; src/app/globals.css:1719,1945)
- [medium] Native still uses looping shimmer status text in 17 places. The interaction spec bans shimmer sweeps and the web has retired them, so the two platforms feel different while working. (native/.../JunoShimmerText.swift; InlineArtifactCard.swift, StudioThreadView.swift, JunoMobileLinkThread.swift, etc.)
- [low] Tailwind duration and easing utilities use literal values, not the CSS variables, so the reduced-motion flattening of out-strong, out-expo and slow never reaches `duration-slow` / `ease-out-expo` utility transitions. (tailwind.config.ts:276-316)
- [low] Native galaxy snaps to its still frame when `active` turns false, where the web eases to a stop. It also lacks the finished/idle dim and can never carry an accessible label. (native/.../JunoGalaxyMark.swift:62-90)
- [low] Section headings put a bare count inside the h2, so screen readers announce 'Your skills3' / 'Installed2'. (src/components/customize/customize-section.tsx:60-63)
- [low] On Code home, the helper line ('Accept edits — Edits files without asking. Asks before commands.') sits over the decorative dot orbit, which hurts legibility. (artifacts/continuation-2026-10-15/code-dark-1440.png)
- [low] In the empty sidebar, 'Your recent chats will appear here.' sits directly under the 'Orbit' header with no 'Recent' label, so it reads as Orbit's empty state. (artifacts/brand-pass-2026-10-14/after/app-chat-light.png)
- [low] Page title typography is inconsistent: a serif display title on Projects and Library, sans on Settings. (artifacts/continuation-2026-10-15/settings-light-390-after.png vs projects-light-390.png)
- [low] Native empty panels draw a dashed well that the web retired for a tonal recess, and the Swift doc comment wrongly says the web still draws dashed. (native/.../JunoEmptyState.swift:14-19,208-220; src/components/app/editorial.css:188)
- [low] Small type on transient UI: tooltips use the 11px caption, and metadata uses 10.5-11px mono micro labels. (src/components/ui/tooltip.tsx; tailwind.config.ts fontSize caption/micro)
- [low] Touch targets for small icon buttons only reach 36-40px under `coarse:`, below the 44pt that ChatGPT and Claude mobile honour. (src/components/ui/pressable.tsx:140-141; button.tsx size icon-sm)
- [low] Doc and code rot in the design system: GALAXY_SPEC.md is cited but missing. globals.css calls itself warm while the values are graphite. ~120 lines of dead svg.icon[data-motion] CSS remain. juno-glyphs.tsx claims to be in use but has no importers. The skeleton comment says radius 10 (it's 8), and the theme-color comment quotes the old palette. Future authors will tune the wrong things. (src/app/globals.css:66-80,827-945; src/components/ui/juno-glyphs.tsx:30; skeleton.tsx; theme-color.ts)
- [low] Acceptance screenshots are unreliable: the 'search' captures show Projects but passed the gallery check, every capture shows the Next.js dev badge, and the iOS audit images predate the rebrand. (artifacts/continuation-2026-10-15/search-*.png, gallery-checks.json; artifacts/ios27-redesign-audit/)

**Motion notes**

- The duration ladder (70/120/160/220/360/560ms) and curves (out-soft, out-strong, out-expo, in, in-out, breathe, out-back, spring, drawer) are one vocabulary across CSS, framer (src/lib/motion.ts) and SwiftUI (JunoMotion). Springs use duration+bounce on both platforms, so web and Mac settle the same way.
- CSS linear() springs (--spring-standard, --spring-pop) and the --loop-beat/--loop/--loop-calm family give loops a shared phase. Stagger rungs are 30/45/60ms, capped at 10 items.
- Exits accelerate (ease-in on --dur-exit, about 0.65 of the entrance) and entrances decelerate. Stagger exits run in reverse at half the step.
- The galaxy mark spins differentially (inner faster, oscillating rather than accumulating), the core breathes on 2.8s, and it enters over 420ms by spiralling in from 0.6 of its radius. On the web, stopping is an exponential slowdown (tau 0.35s) and finished marks dim to 60%. Native cuts to a still frame instead.
- Page transitions are a single 160ms opacity + 6px rise through the Web Animations API on route-group change. There's no exit, no shared-element or View Transition (except the agent face's viewTransitionName), and the first-send move from centred composer to dock is choreographed by hand.
- Icon motion: per-part hover poses amplified 1.35x on out-back 220ms, returning on out-soft 160ms. The press dip is 0.97 at 70ms for solo icon buttons only. State swaps cross-fade with 0.8 scale on fast. As of 2026-10-14 it's on by default for every interactive element, which conflicts with the brand and interaction specs.
- Reduced motion on the OS path keeps fades and colour (Tier A), zeroes travel through --motion-shift and --motion-scale-from (Tier B), and kills decorative loops one by one in an unlayered block (Tier C). The in-app setting skips the tiers with an !important kill. Native also honours 'prefer cross-fade transitions'.
- Native extras with no web equivalent: reward, articulate, chatLayout, chatControl, sendMorph and drawerSettle springs, matchedGeometryEffect/navigationTransition (10 sites), phaseAnimator/symbolEffect (6), and a centralised iOS haptic vocabulary.
- Banned-by-spec motion still ships: shimmer text (17 native sites, 1 web), the continuously rotating galaxy (an owner override of the 'no orbit/orb loop' rule), and a gradient sweep in artifact-inline-card.tsx:563.
- The skeleton uses an opacity breath (1 to 0.62 over 1.8s on --ease-breathe), not a travelling shimmer. That's calmer than the ChatGPT and Claude skeletons, but nothing announces loading.

**Feature status**

- **Cross-platform token pipeline (CSS -> Swift + TS, CI drift check)**: solid. A real CSS parser that handles @layer and conditional at-rules, with exact HSL->sRGB conversion. `--check` passes today: 68 colours, 6 accents, 6 durations, 9 easings, 15 radii, 13 type rungs, 15 spacing steps. Gaps: (1) the ACCENTS list leaves out `ultramarine`, which the web offers (src/lib/accents.ts), so it never reaches native. (2) There is no `--presence` CSS token. The brand's presence blue #2d49c9 / #97a6e6 is hand-typed in 12+ web files (galaxy-mark.tsx, thinking-mark.css, editorial.css, dot-construction.css, sketch.css, voice-glow-palette.ts...) and hand-authored natively as presenceLight/presenceDark in JunoColors.swift. (3) THEME_COLOR in src/components/ui/theme-color.ts is a hand copy, and its comment still quotes the old warm values. (4) The Electron client (native/desktop-electron) has its own styles and is not covered. (Evidence: scripts/generate-design-tokens.ts; src/lib/design/tokens.generated.ts; native/Packages/JunoNativeKit/Sources/JunoDesignSystem/Generated/JunoGeneratedTokens.swift; package.json design:tokens:check; .github/workflows/native.yml:123)
- **Colour system: light/dark themes and runtime accents**: partial. Graphite neutrals in both themes, a per-theme shadow ink (fixes the white halo in dark mode), contrast-tuned muted ink with measured ratios in comments, and on/hover/selected fills ranked as separate tokens. Web offers 7 accents plus a custom picker. Native JunoAccent has 6 and maps unknown values to .coral (Graphite), so an account that picks Ultramarine on the web shows Graphite on Mac and iPhone. Many comments contradict the values: 'Warm neutrals... red is the highest channel' over hue 210-240 values, 'Warm charcoal' over a hue-220 dark ground, '98% not pure white' over --card 100%, and a reference to a test (testBrandNeutralsAreWarm...) that was renamed to ...Graphite.... No high-contrast theme variant. (Evidence: src/app/globals.css:66-770 (:root, .dark, [data-accent]); src/lib/accents.ts; native/.../JunoAccent.swift:13-37)
- **Typography scale and fonts**: partial. Named rungs from hero down to micro, with fluid clamp() and cqi container units for display sizes. Self-hosted variable fonts (Inter, Newsreader, JetBrains Mono, Literata for Cyrillic serif). Lint ratchets are on as warnings; about 10 arbitrary text-[Npx] and 13 raw text-sm sites remain. Native uses @ScaledMetric for Dynamic Type, pinned to the generated rungs. Gaps: Inter ships as a Latin-only subset while ru, uk, vi, pl, tr and others are offered UI locales, so their interface text falls back to system-ui and loses the brand face. caption (11px) and micro (10.5px) are small for metadata and tooltips. Page titles are inconsistent: Projects and Library use the Newsreader serif display, Settings uses sans 'General' (artifacts/continuation-2026-10-15/settings-light-390-after.png). Electron ships Archivo, a face the brand no longer uses. (Evidence: tailwind.config.ts:317-495; src/app/layout.tsx (localFont); src/app/fonts/; eslint-rules/no-arbitrary-text.js, no-raw-text-size.js; native/.../JunoTypography.swift)
- **Spacing, radius and elevation ladder**: solid. The radius ladder (control 8, field 10, card 12, menu 14, panel 16, composer 22) is enforced by lint, including a computed concentric-radius rule. The flat material puts hairlines first and real throw shadows only on out-of-flow layers. The z-index ladder fixes poppers inside dialogs. Spacing is stock Tailwind 4px. Native mirrors it as JunoSpace/JunoRadius. (Evidence: tailwind.config.ts:138-175 (borderRadius, boxShadow, zIndex); globals.css --shadow-*, --z-*, --scrim; eslint design-system/no-arbitrary-radius, concentric-radius, no-ad-hoc-stacking)
- **Motion tokens and framer vocabulary**: solid. One duration ladder (press 70, fast 120, exit 160, base 220, slow 360, emphasis 560) and one set of curves, generated into TS and Swift. Springs use duration+bounce, the same parameters as SwiftUI. Variants match the CSS keyframe offsets. There is a stagger scale with a cap of 10, and RUN_PACING timing rules. Defects: Tailwind transitionDuration and transitionTimingFunction are literal values (tailwind.config.ts:276-316), not var(--dur-*)/var(--ease-*), so the reduced-motion overrides of --ease-out-strong, --ease-out-expo and --dur-slow never reach `duration-slow ease-out-expo` utilities. juno-icons/icons.css hard-codes 120/160/220/360ms and redeclares its own beziers (--ji-soft etc.). (Evidence: src/lib/motion.ts; globals.css:300-420 (--dur-*, --ease-*, --loop-*, --spring-* linear()); native/.../JunoDesignTokens.swift:225-620 (JunoMotion))
- **Reduced motion (OS, in-app setting, native)**: partial. The OS path is tiered and well reasoned: fades kept, travel removed, decorative loops killed one by one. Native adds the 'prefer cross-fade' preference plus Reduce Transparency and Increase Contrast. The in-app Settings > Motion 'Reduced' does something different: a blanket `* { animation-duration:.01ms !important; animation-iteration-count:1; transition-duration:.01ms }`. That is the kill switch the file's own comments say was retired, and it also removes Tier-A state feedback. The spec's 'Full' option is missing (MotionPref is system|reduced only). PageTransition skips the whole entrance under reduced motion instead of keeping a fade. Gallery simulation uses data-motion="reduce" while the app uses "reduced"; report-document.tsx:89 and activity-timeline-tab.tsx:53 check only the gallery value. (Evidence: globals.css:943-1000 (tiered OS block), 4350-4420 (unlayered kill list), 4594-4602 (html[data-motion="reduced"] blanket); src/lib/ui-prefs.ts; src/components/providers.tsx:14-17; src/lib/run/loop-phase.ts:118-132; JunoDesignTokens.swift JunoAccessibilityPreferences)
- **Galaxy working indicator**: solid. Well built. A deterministic mulberry32 field is bit-identical on web and Swift. One canvas per mark, paused off screen (IntersectionObserver) and in hidden tabs. DPR-aware with repaint on DPR or context loss. Ink follows currentColor. Spin eases to a stop instead of cutting, and finished marks dim to 60%. Reduced motion draws a still frame and reacts live to data-motion changes. Gaps: GALAXY_SPEC.md, cited by both implementations, does not exist in the repo. Presence and core colours are hard-coded RGB, not tokens. Native snaps to the still frame when `active` flips false (no deceleration), has no finished/idle dim, always draws in junoForeground rather than the row's colour, and is always accessibilityHidden with no label option (web has one). The brand spec bans 'particle loading field / constant rotating orbit' and the interaction spec bans orbs as loops; the galaxy is an owner override, but those docs were not updated. (Evidence: src/components/brand/galaxy-mark.tsx; src/components/brand/galaxy-field.ts; native/.../JunoGalaxyMark.swift; consumers: chat/live-line.tsx, thought-process-panel.tsx, work-run-panel.tsx, research-run-panel.tsx, tool-receipt.tsx; iOS JunoMobileThoughtProcess.swift)
- **Working/loading indicator consistency**: partial. At least four 'working' signals ship at once. The transcript shows the galaxy, while the Activity side panel and the Research plan card show the 3x3 RunGlyph matrix, so one run can show two different indicators side by side. Native uses shimmer status text in 17 places even though INTERACTION_SPEC §1.6 bans shimmer sweeps and the web has retired them (1 site left). There are about 94 generic spinners. RunLine, RunBlock and RunTimelineInline appear to be referenced only within their own folder (likely dead code). (Evidence: chat/live-line.tsx (GalaxyMark); chat/run/run-glyph.tsx used by research/scope-card.tsx:125,175 and chat/panel/activity-timeline-tab.tsx:152; native JunoShimmerText.swift (17 call sites); Loader2 + animate-spin (~94 sites); connections/add-custom-connector-dialog.tsx:149 shimmer-text)
- **Icon system and hover gestures**: solid. A custom icon family on a 24-unit grid with an optical line weight, hinting fitted to device pixels, and crisp placement that cancels fractional ancestor translates. It has on-state drawings, IconSwap cross-fades, live voice-level bars and a progress arc, and SF Symbol templates generated from the same geometry. Defects: the docs contradict each other. icons.tsx and juno-icons/index.tsx say hover is opt-in and only for F2 destinations. icons.css:67-95 says 'on by default (owner 2026-10-14)' and applies it to every a, button, menuitem, option and tab, with only one jicon-quiet opt-out. So menus, lists, the composer and message actions now wiggle, against BRAND_IDENTITY ('composer actions, menus, lists... remain stable'). globals.css:827-945 still holds ~120 lines of `svg.icon[data-motion]` gesture rules that nothing emits any more (the renderer outputs .ji). juno-glyphs.tsx says 'IN USE through icons.tsx' but has no importers. (Evidence: src/components/ui/icons.tsx; src/components/ui/juno-icons/{index.tsx,drawings.ts,extra.ts,icons.css}; native/.../JunoIconGesture.swift; macOS DesktopSidebarChrome.swift)
- **Core components (Button, Pressable, Dialog, Sheet, Tooltip, Tabs, Segmented, Switch, Slider, Select, Toast)**: solid. Radix primitives with a shared press recipe: transform on press 70ms, colour on fast 120ms. Every variant carries a 1px border so variants don't shift layout. Loading keeps the button's width, cross-fades to a spinner and sets aria-busy without dimming. Segmented controls are a radiogroup with arrow keys. Surface tabs are a nav with aria-current. Poppers open from the trigger side. Gaps: Dialog stays a centred modal on phones (no bottom-sheet variant). Sheet has no drag or swipe to dismiss, and the web has no touch gestures anywhere. Tooltip text is the 11px caption. Small icon buttons only reach 36-40px under `coarse:` (below the 44pt HIG). Close and Navigation labels are hard-coded English and rely on the AutoTranslate DOM pass. (Evidence: src/components/ui/button.tsx, pressable.tsx, dialog.tsx, sheet.tsx, tooltip.tsx, segmented-control.tsx, surface-tabs.tsx, sonner.tsx, menu-recipe.ts)
- **Empty and error states**: solid. One component handles page and panel sizes and empty and error tones. The brand dot-construction mark replaces a generic glyph tile. The serif title is an h2 at page size. Copy reassures ('nothing was deleted'). Errors use role=status and offer Try again. Drift: the native panel empty state still draws a dashed edge, and its comment says the web does too, but the web replaced the dashed well with a tonal `empty-well` recess. iOS uses the stock ContentUnavailableView, not the brand mark. (Evidence: src/components/ui/empty-state.tsx; empty-mark.tsx; load-error.tsx; native/.../JunoEmptyState.swift (macOS only); iOS ContentUnavailableView (68 sites))
- **Skeleton / loading placeholders**: partial. Muted fill with a hairline and a 1.8s opacity breath, killed under OS reduced motion. Nothing announces loading: no aria-busy or sr-only text, so every caller has to add it. The comment says 'rounded-control (10)' but control is 8px. No content-shaped transition from skeleton to content. (Evidence: src/components/ui/skeleton.tsx; globals.css:3286-3313; native JunoSkeleton.swift)
- **Page and route transitions**: partial. A WAAPI 160ms 6px rise on route-group change, with no remount (fixed a 300ms Suspense throttle) and no leftover transform. The first-send move of the composer from home to the dock is choreographed by hand. Missing: exit transitions, View Transitions or shared-element moves between list and detail (only the agent face sets viewTransitionName), and a reduced-motion cross-fade (it skips entirely). Soft surfaces (chat, code, settings) don't animate inside their own sub-routes. (Evidence: src/components/app/page-transition.tsx; src/components/chat/chat-view.tsx:1515-1540 (first-send handoff); agents/agent-presence.tsx:42-60 (viewTransitionName))
- **Micro-interactions library**: solid. A small, deliberate set (squash, swell, roll) with calibrated constants and reduced-motion handling, plus a hold-to-confirm button, height collapse and scroll-edge fades. (Evidence: src/components/ui/micro.tsx (Swell, Burst, RollingNumber, useTravelSquash); icon-swap.tsx; hold-button.tsx; collapse.tsx; scroll-fade.tsx; src/lib/micro.ts)
- **Focus visibility and keyboard**: solid. A global focus ring with measured contrast (about 5:1 light, 9:1 dark), retuned per accent, with no ring-offset halos. A skip link exists. 29 `focus-visible:outline-none` sites, mostly peer-pattern range inputs. Hover icon motion never fires on keyboard focus. (Evidence: globals.css:1013-1016 (:focus-visible 2px --ring, offset 2px); components/app/app-shell.tsx:484 (Skip to content); segmented-control.tsx:155)
- **Contrast and high-contrast modes**: partial. Contrast was checked by hand and written into comments. Native has 3 contrast tests over the generated tokens. The web has no automated contrast or axe checks, and e2e/ has no a11y spec. prefers-contrast: more is handled only for the composer and one other block, while the interaction spec says every meaningful tone-step boundary should get an outline. forced-colors is handled in about 1-3 places. (Evidence: globals.css comments (muted-foreground 4.57-5.35:1, code tokens 4.69-4.81:1); native Tests/JunoDesignSystemTests/JunoInkContrastTests.swift; @media (prefers-contrast: more) at globals.css:1719,1945 only; forced-colors at globals.css:4557)
- **Screen reader semantics**: partial. Broad coverage. Decorative marks are hidden, and phase changes go through live regions. Defect: section headings put a bare count inside the h2, so the accessible name reads 'Your skills3' (recorded verbatim in artifacts/continuation-2026-10-15/gallery-checks.json). (Evidence: ~829 aria-label, ~84 aria-live, ~171 role=status (web); 842 accessibilityLabel, 324 accessibilityHidden (native); customize/customize-section.tsx:60-63)
- **Responsive layouts (desktop, tablet, phone)**: partial. No horizontal overflow at 390 (scrollWidth checks). Uses an inset content panel on desktop, a sheet sidebar and safe areas on mobile. Gap: on the phone, Projects and Library spend the first ~450px of an 844px viewport on a serif title, description, stat row, search and filters, so the first item sits at the fold. No swipe to open the sidebar or dismiss sheets. (Evidence: ~92 container-query sites, 37 dvh/svh, 21 safe-area utilities, `coarse:` variant (tailwind.config.ts:983); artifacts/continuation-2026-10-15/*-390.png)
- **RTL layout support**: missing. directionOf() and <html dir> work, but the stylesheet is not RTL-safe, so ar, he, fa and ur are withheld from the picker. Physical utilities have grown from the 176 noted in the comment to about 447. ChatGPT and Claude both ship RTL. (Evidence: src/lib/i18n.ts:95-106 (RTL locales withheld); 447 physical vs 72 logical directional utilities in src/components+src/app)
- **Theme switching and interface preferences**: solid. No theme flash, thanks to the nonce'd first-paint script. Per-device chat font (default/system/serif/mono), transcript width, code wrap, motion and text size, applied before paint. Missing: a density preference, an explicit 'increase contrast' toggle on the web, and a 'Full motion' override. (Evidence: src/components/providers.tsx (next-themes disableTransitionOnChange, CSP nonce); src/lib/ui-prefs.ts (boot script, data-* attrs); globals.css:4570-4602)
- **Native SwiftUI design system parity**: solid. Generated colours and type are consumed through tests. Dynamic Type. Accessibility preference policy. Liquid Glass via system glassEffect. A haptic vocabulary on iOS (~40 sites). Drift: 6 accents vs 7 on the web, a dashed empty panel, the shimmer status line, and the galaxy stopping without easing. The Mac has no trackpad haptics (NSHapticFeedbackManager: 0), and there are no streaming haptics on iOS. (Evidence: native/Packages/JunoNativeKit/Sources/JunoDesignSystem/* (~28k lines); JunoDesignTokens.swift; JunoTokenConsumptionTests.swift; ~93 glassEffect sites; iOS JunoMobileFeedback.swift)
- **Electron desktop client design system**: stub. Still Juno-branded, with its own Tailwind config and the Archivo font. Its comment claims the web uses Archivo from Google Fonts, which is stale. The token generator doesn't cover it, so it will drift further. (Evidence: native/desktop-electron/README.md; native/desktop-electron/src/renderer/styles/base.css:35-62)
- **Visual QA evidence (artifacts)**: partial. There are light/dark × 1440/390 captures and two motion mp4s. Problems: search-dark-1440.png and search-light-390.png actually show the Projects page, yet the gallery check passed on status 200. Every capture comes from a dev build, with the Next.js 'N' badge over the account avatar or content. The iOS audit images predate the Alevr rebrand (coral, Juno). design-qa.md ends 'final result: blocked' with no same-frame comparison. (Evidence: artifacts/continuation-2026-10-15/; artifacts/brand-pass-2026-10-14/; artifacts/ios27-redesign-audit/comparison.jpg; design-qa.md)

### Platform and account surfaces: onboarding, sign-in, settings, plans/billing/usage, BYOK, connectors/apps, skills library, sharing/collaboration, admin/workspace, i18n, performance and reliability

**Strengths**

- Billing transparency beats ChatGPT and Claude: euro budget meter, rolling 5-hour and weekly windows with live countdowns, held spend counted, user-set spend ceiling, 30-day history, top-ups, referrals, VAT-inclusive pricing, embedded Stripe Checkout, legally compliant in-app cancellation.
- Auto-router data boundary setting (no-training labs only, exclude PRC labs, EU/US only) is a genuine privacy differentiator neither competitor exposes.
- One connector directory that merges native integrations, a ~1,000-app Composio catalog, header-auth MCP servers and OAuth MCP connectors, with five server-truthful action-approval policies, lockdown and standing grants.
- Skills library is more capable than Claude's: GitHub repo, zip, link and paste import, security scanning with trust levels, version history and restore, upstream update checks, SKILL.md and zip export.
- Import of ChatGPT, Claude and Gemini history (projects, memories, attachments) with real upload progress is a strong switching lever.
- Memory controls: per-topic sensitive-subject opt-ins off by default, background-learning provider policy, a full memory manager.
- Auth hygiene: provider buttons only when configured, non-enumerating registration, MFA pre-flight, password-leak-safe form method, OAuth error mapping, magic link.
- Artifact publishing with version pinning, rollback, unpublish and reset link, served in a script-free sandbox for anonymous viewers.
- Accessibility discipline throughout: tablist/roving tabindex rail, radiogroups with arrow keys, one-tab-stop usage chart, role=alert/status messages, coarse-pointer target sizes, translate=no on product names.
- Performance care: settings route idle-prefetched in full, i18n catalog kept out of the root bundle, router stale times re-enabled, every surface route has loading and error boundaries.
- Operator admin is MFA-gated at the layout level, with moderation, share-report queues and announcements.

**UX issues**

- [high] Three Coding settings sections (Session preferences, Agents, Permissions) are dead ends: the settings route unmounts the Code workspace, which clears codeSettingsBridge, so they always show the 'Open a Code session' placeholder. (src/components/settings/sections/code.tsx; src/components/code/v2/workspace.tsx:447-458)
- [high] No team or workspace product at all: no org, seats, shared billing, admin console, SSO setup, audit log or SCIM. ChatGPT Business/Enterprise and Claude Team/Enterprise are table stakes for B2B. (prisma/schema.prisma; src/lib/plans.ts)
- [high] Project sharing has a backend (roles, members API) but no UI, so collaboration is invisible to users. (src/app/api/projects/[id]/members/route.ts; src/components/projects/*)
- [medium] Sign-in error tells password users that Google 'can be linked to the account from Settings afterwards', but no linking UI or API exists. (src/components/auth/auth-form.tsx OAUTH_ERRORS.OAuthAccountNotLinked)
- [medium] Shared chats cannot be updated (the link is frozen; refreshing means revoke and a new URL), and viewers cannot 'continue this conversation' in their own account as ChatGPT and Claude allow. (src/components/share/share-dialog.tsx; src/app/share/[token]/page.tsx)
- [medium] Non-English users see English first, then text swaps after hydration as the DOM walker fetches machine translations; strings built at runtime (toasts, counts) never translate; legal pages are French only. (src/components/i18n/auto-translate.tsx; src/app/(legal)/legal/*)
- [medium] 2FA row stays disabled forever if /api/account/mfa fails (no error, no retry), and for 2FA-on accounts it first renders 'Set up…' then flips to 'Turn off…'. (src/components/auth/account-security.tsx TwoStepRow / AccountSecuritySection)
- [medium] No active sessions list or passkeys; only 'Sign out everywhere'. (src/components/auth/account-security.tsx; src/app/api/account/sessions/revoke)
- [medium] Two different 'add an MCP server' flows on the same page (header Add opens the header-token dialog; the 'Add an MCP server' tile opens the OAuth dialog), stored in different tables. Users cannot tell which to use. (src/app/(app)/connections/page.tsx; src/components/connections/add-mcp-server-dialog.tsx; add-custom-connector-dialog.tsx)
- [medium] Without Composio configured, the directory has no Google Workspace, Microsoft 365 or Slack, the connectors people expect first. The native Drive/M365 sync classes are dead code. (src/lib/connectors.ts; src/lib/connectors/google-drive.ts; microsoft-365.ts)
- [medium] BYOK works for Code only; Chat cannot run on the user's own keys. Remove deletes a key without confirmation. (src/components/settings/sections/connections.tsx)
- [medium] Seven consumer tiers (Free, Lite, Pro, Plus, Max x5, Max x10, Ultra) create decision friction compared with competitors' 3-4. (src/lib/plans.ts; src/components/billing/upgrade-view.tsx)
- [medium] No Help, Support, Feedback or Status entry in the account menu. (src/components/app/user-menu.tsx)
- [low] Duplicate controls: Budget alerts and Weekly digest switches appear in both Account and Notifications; browser push sits only under Account. (src/components/settings/sections/account.tsx; src/components/settings/sections/preferences.tsx)
- [low] Settings IA bloat: 20 sections; General holds only language plus links; Capabilities is mostly links and sits in the 'Coding' group; Devices, Remote and /permissions all cover Macs. On phones the rail becomes a 20-tab scrolling strip with no search. (src/components/settings/settings-sections.ts; settings-rail.tsx)
- [low] Remote section is below the product's polish bar: browser window.confirm, plain loading text, unlocalized toLocaleString dates, dense one-line JSX. (src/components/settings/sections/remote.tsx)
- [low] Onboarding is localStorage-gated, so it reappears on each new browser for an account with no chats. It offers no starter prompts, use-case setup or import nudge. (src/components/app/onboarding.tsx)
- [low] Global register limit of 200/hour would block legitimate signups during a launch spike; 5/IP/hour hurts shared networks. (src/app/api/auth/register/route.ts)
- [low] Upgrade welcome page refreshes once at 1.2s; if the Stripe webhook is late it shows the Free state ('Thank you.') with no polling until the plan settles. (src/app/(app)/upgrade/welcome/page.tsx)
- [low] Plans FAQ hardcodes '20% French VAT' while the note beside it is locale-aware. (src/components/billing/upgrade-view.tsx FAQ)
- [low] Keyboard shortcuts cannot be rebound; only the send key is configurable. (src/components/settings/sections/preferences.tsx KeyboardSection)

**Motion notes**

- Settings, Customize and the plans page use a token-driven motion system (src/lib/motion.ts from tokens.generated: press/fast/base/slow/emphasis rungs; outSoft, in, drawer, spring eases) with consistent reduced-motion handling (motion-safe:, MotionConfig reducedMotion=user, CSS media guards).
- Settings rail selection is a shared layoutId pill that slides between rows on a spring; the Customize tabs pill also travels across routes (layoutId customize-tab-pill, spring 520/40) and lights on press before navigation resolves.
- On the /settings page a section switch stacks entrances: main is keyed on section with animate-rise-in, and the pane's groups replay the editorial ed-stagger (700ms each, delays up to 250ms), roughly a 950ms settle. That is slow for a utility surface and contradicts SettingsPane's own 'no entrance inside an entrance' rule. The AnimatePresence mode=wait exit in SettingsPane never plays on the page because the whole pane remounts.
- The editorial kit (ed-rise 900ms, ed-stagger 700ms) and plans.css (420/520/900ms with --alv-ease) use hardcoded durations outside the DURATION tokens, so plans and settings feel slower and differently timed than the rest of the app.
- plans.css transitions font-size on .plans-node-name (520ms), which forces layout on every plan change; prefer a transform scale.
- The plans page headline and price use a 'plans-roll' blur-rise on key change, and FAQ disclosures animate height via ::details-content with interpolate-size: a modern, smooth pattern.
- Connector tiles flash a fading bg-selected highlight and scroll into view after an OAuth round trip; skills install lands, opens and flashes the target folder. These are good feedback moments.
- Auth buttons cross-fade brand mark to spinner via IconSwap; the copy button swaps glyph on a spring; form errors rise in on the base rung.
- The settings modal's tuned entrance (0.97 scale on base, faster exit, no animation when opened by keyboard) is dead code now that settings is a route.
- Remote section and the BYOK rows have no motion or skeletons (plain text loading), so they feel unfinished next to the Devices section's skeleton rows.

**Feature status**

- **Sign-in / sign-up (email+password, Google, Apple, magic link, TOTP step)**: solid. Provider buttons render only when configured server-side; inline field errors; method=post leak guard; MFA pre-flight challenge; magic link reuses typed email. Missing: passkeys/WebAuthn, Microsoft sign-in, enterprise SSO entry. OAuthAccountNotLinked copy says 'Google can be linked to the account from Settings afterwards' but no linking UI or API exists (src/components/auth/account-security.tsx has none). Register limit is 5/IP/h and 200/h GLOBAL, so a launch spike would block legitimate signups. Password rule only revealed after a failed submit (no strength meter). (Evidence: src/app/(auth)/sign-in/page.tsx, src/app/(auth)/sign-up/page.tsx, src/components/auth/auth-form.tsx, src/app/api/auth/register/route.ts, src/app/api/auth/mfa)
- **Password reset, email verification, check-email**: solid. Verification notices routed back into the sign-in form; non-enumerating copy. (Evidence: src/components/auth/forgot-password-form.tsx, src/components/auth/reset-password-form.tsx, src/components/auth/verify-email-banner.tsx, src/app/(auth)/check-email/page.tsx)
- **First-run onboarding**: partial. Single optional dialog: name, theme, accent (swatches read real --primary per theme). Gated by localStorage key juno:onboarded:v1, so it reappears on every new browser for an account with no chats. No use-case personalization, starter prompts, history-import nudge, or tour of Code/Agents. Name PATCH failures are swallowed silently (.catch(() => {})). (Evidence: src/components/app/onboarding.tsx, src/components/app/onboarding-lazy.tsx)
- **Settings shell (full-page /settings, grouped rail, search, deep links)**: solid. 20 sections in 3 groups, '/' focuses search, keyword search, ?section= deep links + aliases, Esc/Cmd-, return to origin, idle full prefetch. Search only filters sections (no jump to a specific row). Strip layout on phones hides search while carrying ~20 tabs. src/components/settings/settings-modal.tsx is dead code (only the dev gallery imports it) yet its docstring still describes Cmd-, opening a modal. (Evidence: src/app/(app)/settings/page.tsx, src/components/settings/settings-rail.tsx, src/components/settings/settings-sections.ts, src/components/settings/settings-pane.tsx, src/components/settings/settings-modal-lazy.tsx)
- **General / Appearance (theme cards, accent + custom accent, text size, chat font, transcript width, motion, interface language)**: solid. Appearance is rich. General itself is only Interface language plus a 'More' list of links to other sections, so the default landing section is nearly empty. Changing language does a full window.location.reload(). (Evidence: src/components/settings/sections/general.tsx, src/components/settings/font-size.ts)
- **Personalization (name, custom instructions, 6 personalities, response language)**: partial. Draft flush on unmount, word count, page and settings variants share one component. Lacks ChatGPT-style structured fields (occupation, traits) and characteristic dials (warmth, enthusiasm, emoji, headers/lists). (Evidence: src/components/settings/sections/personalization.tsx, src/lib/personalities.ts, src/app/(app)/customize/instructions/page.tsx)
- **Memory settings**: solid. Reference memories, background learning, per-topic sensitive-subject opt-ins (off by default), background provider policy, link to /memory manager. (Evidence: src/components/settings/sections/memory.tsx)
- **Models settings (default, Auto optimise-for, lab data boundary, effort, fast mode, web search, pinned models)**: solid. Auto data boundary (no-training labs, exclude PRC, EU/US only) is a real differentiator. Clearly separates account-synced vs this-device settings. (Evidence: src/components/settings/sections/models.tsx)
- **Notifications (reply ready, sound, web push, email budget alerts, weekly digest)**: partial. Budget alerts and Weekly digest switches are duplicated verbatim in both Account and Notifications; browser push rows live only under Account. Two homes for one concept. (Evidence: src/components/settings/sections/preferences.tsx (NotificationsSection), src/components/settings/sections/account.tsx lines ~188-227)
- **Keyboard shortcuts**: partial. Send-key choice (Enter vs Mod+Enter) only; the rest is a read-only list. No rebinding. (Evidence: src/components/settings/sections/preferences.tsx (KeyboardSection), src/lib/shortcut-groups.ts)
- **Capabilities section**: partial. Follow-up suggestions, code wrap, cross-conversation messaging; its 'Tools' group is just four links to other sections. No per-tool toggles (web search, code execution, image gen, canvas) like ChatGPT. Filed under the 'Coding' rail group, which does not fit. (Evidence: src/components/settings/sections/preferences.tsx (CapabilitiesSection), src/components/settings/sections/cross-conversation.tsx)
- **Voice settings**: solid. Read-aloud voice picker and voice-conversation sounds; only row structure was reviewed here. (Evidence: src/components/settings/sections/voice.tsx)
- **Account (avatar, name, username, email change, password, sign out, sign out everywhere, delete account)**: partial. TOTP 2FA with recovery codes. Missing: active sessions/devices list (only /api/account/sessions/revoke exists), passkeys, linked sign-in methods. If GET /api/account/mfa fails, the 2FA 'Set up…' button stays disabled forever with no error or retry; for 2FA-on accounts the row first renders 'Set up…' (disabled) then swaps to 'Turn off…' (layout shift). (Evidence: src/components/settings/sections/account.tsx, src/components/settings/sections/account-username.tsx, src/components/auth/account-security.tsx, src/app/api/account/*)
- **Data & privacy (export JSON/package/CSV, import ChatGPT/Claude/Gemini/Alevr, shared links, delete all chats)**: solid. Competitor-history import with XHR upload progress is a strong acquisition feature; 100 MB cap may reject heavy ChatGPT exports. Missing: archive-all, retention/auto-delete controls, an explicit 'your data is not used for training' statement row. (Evidence: src/components/settings/sections/data-privacy.tsx, src/components/settings/import-history.tsx, src/app/api/import/route.ts, src/components/share/shared-links-card.tsx)
- **Plans / upgrade page**: solid. Above-the-fold single decision, monthly/yearly, VAT-inclusive prices, capability diff incl. what you'd lose, FAQ, embedded Stripe Checkout (Apple/Google Pay). Seven consumer tiers (Free, Lite, Pro, Plus, Max x5, Max x10, Ultra) is choice overload next to competitors' 3-4. No Team/Business/Enterprise tier or seats at all (Plan enum has none). FAQ hardcodes '20% French VAT' while vatNote(locale) is dynamic. Welcome page refreshes once after 1.2s and shows 'Thank you.' on FREE if the webhook is late, with no polling. (Evidence: src/app/(app)/upgrade/page.tsx, src/components/billing/upgrade-view.tsx, plan-orbit.tsx, plan-compare.tsx, checkout-sheet.tsx, src/lib/plans.ts, src/lib/price-display.ts)
- **Plan & usage in settings (budget meter, 5-hour session and weekly windows, spend ceiling, 30-day history, billing portal)**: solid. Live countdowns, held/reserved spend counted, user ceiling with source note, one-tab-stop keyboard chart. Matches or beats Claude's usage-limit view; per-model/feature breakdown was deliberately removed. (Evidence: src/components/settings/sections/billing.tsx, src/components/settings/usage-history.tsx, src/lib/spend-ceiling.ts, src/lib/spend.ts)
- **Usage readout in account menu + upgrade nudge**: solid. Dot meter with % used; nudge only on Free or at 80% month / 10% window remaining. (Evidence: src/components/app/user-menu.tsx, src/lib/billing/upgrade-nudge.ts)
- **Top-up credits, referrals, in-app cancellation**: solid. French-law cancellation recap and undo; App Store subscriptions redirected correctly. Cards silently render nothing when their fetch fails. (Evidence: src/components/settings/top-up-card.tsx, src/components/settings/referral-card.tsx, src/app/r/[code]/route.ts, src/components/settings/cancel-subscription.tsx, src/lib/billing/credit-ledger.ts)
- **BYOK (your own API keys)**: partial. Anthropic, OpenAI, Gemini, xAI, DeepSeek, OpenRouter; validated with the provider before storing, last-4 hint, 30-day usage estimate, plus subscription connections (run your existing plans on a Mac). Applies to Code only, not Chat. 'Remove' deletes immediately with no confirmation. (Evidence: src/components/settings/sections/connections.tsx, src/app/api/provider-keys/*, src/lib/code-v2/byok.ts)
- **Apps / connectors directory**: solid. One searchable list: native (GitHub, Figma, Notion, Apple Calendar/Mail/Music), Composio catalog (~1,000 apps with categories), user MCP servers (URL + auth header, live test), custom OAuth MCP connectors, landing flash after OAuth. Without Composio configured, Google Workspace, Microsoft 365 and Slack are unavailable. Two separate 'add an MCP server' flows ('Add' button opens AddMcpServerDialog; the trailing tile opens AddCustomConnectorDialog) store to different tables. Reachable at both /customize and /connections. (Evidence: src/app/(app)/connections/page.tsx, src/app/(app)/customize/page.tsx, src/components/connections/connector-directory.tsx, app-detail-sheet.tsx, src/lib/connectors.ts, src/lib/composio.ts, src/lib/custom-connectors.ts, src/lib/user-mcp.ts)
- **Google Drive / Microsoft 365 knowledge sync**: stub. Connector classes are referenced only by the capability registry, which labels them 'stable' and cites credentials-dialog.tsx as evidence, but that dialog does not use them. Dead code. (Evidence: src/lib/connectors/google-drive.ts, src/lib/connectors/microsoft-365.ts, src/lib/capabilities.ts)
- **Action approval policy, lockdown, standing grants**: solid. Five policies described by what the server actually enforces; refuses to draw defaults if the policy fails to load. (Evidence: src/components/settings/sections/connectors.tsx, src/components/connections/standing-grants.tsx)
- **Skills library**: solid. Import from GitHub repo, file/.zip/.skill, link or paste; safety scan with trust levels; versions and restore; edit; export SKILL.md/.zip; manual vs auto-select; upstream update checks; 'Save as skill' from chat. Missing: first-party built-in skills (docx/xlsx/pptx/pdf style), a browsable marketplace beyond 3 hardcoded popular repos, sharing/publishing skills, org-provisioned skills. (Evidence: src/app/(app)/skills/*, src/components/skills/skills-library-page.tsx, import-skills-dialog.tsx, skill-detail-view.tsx, update-source-dialog.tsx, src/lib/skills/sources.ts)
- **Chat sharing (public snapshot links)**: partial. Explicit create, copy, revoke, view count, abuse report, noindex, static sandbox for previews. Missing: update snapshot to include new messages (must revoke and get a new URL), 'Continue this conversation' fork for signed-in viewers, expiry, share with specific people. Shared date hardcoded to en-US. Shared answers offer Copy only. (Evidence: src/components/share/share-dialog.tsx, src/app/share/[token]/page.tsx, src/app/api/share/*, src/components/share/report-share-dialog.tsx)
- **Artifact publishing**: solid. Stable URL, follow latest or pin a version, rollback, unpublish, reset link, design poster rendering. (Evidence: src/lib/artifact-publication.ts, src/components/share/share-dialog.tsx, src/components/share/shared-artifact-viewer.tsx, src/app/share/[token]/poster/route.ts)
- **Project collaboration (members and roles)**: stub. OWNER/EDITOR/VIEWER roles and API exist; no UI anywhere in src/components/projects to invite, list or manage members. (Evidence: src/lib/project-collaboration.ts, src/app/api/projects/[id]/members/route.ts, prisma ProjectMember)
- **Workspace / team admin (seats, SSO config, SCIM, audit log, domain capture, retention policy)**: missing. An OIDC verifier class exists but nothing in src imports it; SAML throws by design. DLP is used only in web search and URL guard, with no policy UI. The capability registry still labels SSO OIDC and DLP 'stable'. (Evidence: prisma/schema.prisma (no Organization/Workspace/Team model, no TEAM plan), src/lib/auth/enterprise-sso.ts, src/lib/security/dlp.ts)
- **Operator admin console**: solid. Owner-only, MFA-gated in the layout: users (plan change, ban/unban, delete, confirm email), moderation queue, share-link reports, announcements, turns trace. This is a platform-operator tool, not customer workspace admin. (Evidence: src/app/(app)/admin/*, src/components/admin/*)
- **Internationalization**: partial. 20 menu locales; 4,644 extracted strings machine-translated on demand by a utility model; catalog lazy-loaded; localStorage client cache. A DOM walker swaps text after hydration, so non-English users see English first. Server cache is process memory (cold after every deploy). Strings with runtime values (toasts like '${label} is connected') stay English. RTL withheld (176 physical vs 16 logical utilities). Legal pages exist only in French. <html lang> is set to the target locale while SSR content is still English. (Evidence: src/lib/i18n.ts, src/components/i18n/auto-translate.tsx, src/lib/i18n-phrase.tsx, src/app/api/i18n/translations/route.ts, scripts/generate-i18n-catalog.mjs, src/lib/i18n-catalog.generated.ts)
- **Profile page**: solid. A year of activity (daily, weekly, cumulative) and model mix in the viewer's timezone; private by design. (Evidence: src/app/(app)/profile/page.tsx, src/components/profile/*)
- **Devices and Remote pairing**: partial. Devices is polished (skeletons, stale-data note). Remote is visibly lower quality: native window.confirm for revoke, plain 'Loading paired Macs…' text, unlocalized toLocaleString dates, iPhone instructions as a static paragraph. Two sections plus /permissions all cover 'your Macs'. (Evidence: src/components/settings/sections/devices.tsx, src/components/settings/sections/remote.tsx, src/app/pair/page.tsx, src/app/(app)/permissions/*)
- **Code settings inside global settings (Session preferences, Agents, Permissions)**: stub. These sections read codeSettingsBridge, which the Code workspace clears on unmount. Settings is now a route, so opening it unmounts Code, and these three sections always show the 'Open a Code session…' placeholder. (Evidence: src/components/settings/sections/code.tsx, src/components/code/v2/settings-bridge.ts, src/components/code/v2/workspace.tsx lines 447-458)
- **Help, support, feedback, status**: missing. The account menu has no Help center, Contact support, Send feedback, Release notes or Status link. /roadmap is reachable only from the command palette and the marketing chrome. Announcements popups cover 'what's new'. (Evidence: src/components/app/user-menu.tsx)
- **Reliability signals**: partial. Thin liveness endpoint plus owner-gated readiness, fail-fast boot checks, standalone global error page, error and loading boundaries on every surface route. No external error reporting or APM (no Sentry/OTel in package.json); metrics are an in-memory ring buffer. Service worker handles push only (no offline shell). No public status page. Only auth has e2e coverage on this surface. (Evidence: src/app/api/health/route.ts, src/instrumentation.ts, src/lib/boot.ts, src/app/global-error.tsx, src/app/offline/page.tsx, public/sw.js, src/lib/observability.ts, per-route error.tsx/loading.tsx)
- **Performance work**: solid. Settings route idle-prefetched with FULL kind, ~130 KB i18n catalog kept out of the root bundle, client router cache re-enabled, Customize tabs prefetched. Plans page transitions font-size (layout reflow on every chip change). (Evidence: src/components/settings/settings-modal-lazy.tsx, src/components/i18n/auto-translate.tsx, next.config.mjs (staleTimes), src/components/customize/customize-nav.tsx (prefetch))

## Gap details

### G01 · Restore iOS push (aps-environment) and guard it in CI

Impact 5, effort S, area mobile/native.

**Competitors.** ChatGPT, Claude, Cursor iOS and T3 Code mobile all depend on APNs for agent and approval pushes, Live Activities and handoff. Cursor tracks up to 8 agents on the Lock Screen; Claude pushes when a task needs permission.

**Alevr today.** Broken. native/iOS/JunoMobile/Resources/JunoMobile.entitlements is an empty <dict/> (confirmed at HEAD). Commit 615d3a5b0 dropped the aps-environment key that 6e0176967 had added, so JunoMobileApp.swift:414 registerForRemoteNotifications fails in every build. That kills pushes for agents, Work, research and Code approvals (including the Face ID Allow/Deny categories) and breaks 'Continue on iPhone'.

**Approach.** Add aps-environment (development/production via native/Config/JunoMobile-*.xcconfig:14) back to JunoMobile.entitlements and to the project.yml entitlements block, so XcodeGen regeneration can't drop it again. Add a native:entitlements:check step to .github/workflows/native.yml that runs PlistBuddy on the file and fails when aps-environment, the app group or associated domains are missing. Then smoke-test NativePushRegistrar against /api/push/devices and one Code approval category.

**Needs from outside.** Apple Developer account with the Push Notifications capability on the App ID, an APNs auth key configured server-side (src/lib/apns.ts), and a real device for verification.

### G02 · First Code turn must honour the landing's model, effort, attachments and text-less prompts

Impact 5, effort S, area coding.

**Competitors.** Codex, Claude Code Desktop and T3 Code keep the model, effort and attachments chosen before the first send. T3 Code even clones in the background while you type the first prompt.

**Alevr today.** Wrong. Model and effort picked on /code are ignored for Mac runs: seededThreadPrefs writes only the mode (src/lib/code-v2/composer-mode.ts:174), and live-route.tsx:127 reconcileSelection picks the first ready instance. On cloud runs the model silently changes after turn 1. live-route.tsx:393 reads only peekPendingCodePrompt(id)?.text, so landing attachments are dropped, and a prompt with attachments but no text is never sent (src/lib/code-v2/first-prompt.ts). The extra hop through /chat/{id} is a double navigation.

**Approach.** Extend first-prompt.ts so the pending entry stores {text, attachments, instanceId, model, effort, contextTier, mode}. Treat 'has text OR has attachments' as pending. Have code-composer.tsx seed the full ThreadSyncPrefs, and make live-route.tsx skip reconcileSelection while a seeded selection exists. Send attachments through host.upload for Mac and the existing cloud task attachment path. Route startDevice/startCloud straight to /code/{id}. While the Mac link connects, show the queued prompt as an optimistic user bubble with a 'Starting on your Mac' line, replacing the empty state.

### G03 · Editing an earlier message should fork a branch, not delete the rest of the thread

Impact 5, effort M, area chat.

**Competitors.** ChatGPT keeps a full branch tree per edit (and 'Branch in new chat'). Claude makes each edit a branch that keeps its own artifacts. T3 Chat keeps revisions with Previous/Next.

**Alevr today.** Destructive. message-item.tsx:923 allows edit on any user turn, and src/app/api/messages/[id]/route.ts:59 deleteMany's every later message with no confirmation. MessageVersion keeps only that message's old wording. The VersionPager (message-item.tsx:211-260) can show the old text but not the thread that followed it.

**Approach.** Add parentId and branchId to Message in prisma, plus a ConversationBranch head pointer. Change PATCH /api/messages/[id] (and use-chat.ts:1924 editAndResend) to insert a sibling user message on a new branch and move the head instead of deleting. Teach use-transcript-window.ts to load the active path. Extend VersionPager so '2/3' switches whole branches, including their assistant turns and artifacts. Ship a confirm dialog straight away as a stopgap ('This replaces the 6 messages below'). Mirror the change in native NativeBranchNavigator.swift, which already makes local siblings but never calls the PATCH.

### G04 · Generate images when asked in chat or Auto, with 'Create image' in the + menu

Impact 5, effort M, area chat.

**Competitors.** ChatGPT generates natively in any chat (Images 2.5, templates, region edit, chips that ask follow-up questions). Gemini has Nano Banana in chat. Copilot Cowork generates images. T3 Chat sends image requests to Canvas.

**Alevr today.** Partial. An image is only made after the user manually picks an image, video or music model in the catalogue (composer-media-params.tsx, generated-media.tsx). src/lib/chat/turn/tools.ts has no image tool, src/lib/router/decide.ts excludes not_chat models from Auto, and composer-plus-menu.tsx has no 'Create image'. Region editing (image-edit-overlay.tsx) is already strong.

**Approach.** Add src/lib/tools/specs/generate-image.ts (prompt, aspect, n, reference attachment ids, transparent) and wire it in src/lib/chat/turn/tools.ts to the media pipeline behind generated-media.tsx, choosing the image model with a new decide.ts 'image' task class under the same plan, budget and data-policy filters. Render it with generation-placeholder.tsx so the chat keeps working while it generates. Add 'Create image' to the plusSections in composer.tsx, which inserts an image token chip and opens the aspect and quality params from composer-media-params.tsx in the tray. Record which model made the image on the Auto receipt.

**Needs from outside.** Image model provider capacity and keys for the image models already in the catalogue.

### G05 · Ship flow in the v2 workspace: commit, push, PR, CI checks and an auto-fix toggle

Impact 5, effort M, area coding.

**Competitors.** Codex has a review pane with stage/revert and PR review in a side panel, plus Checks > Fix. Claude Code Desktop has a CI bar with 'Auto-fix CI & address comments' and 'Auto-merge when ready'. T3 Code has one-click commit/push/PR across 7 hosts and stacked PRs. Cursor has /autopilot.

**Alevr today.** Missing in the default surface. workspace.tsx:435-436 gates commit on actions.commit, which is never set, and 'Create pull request…' only types '/pr '. The backend is complete: /api/code/tasks/[id]/pull-request, /checks, /auto-fix, src/lib/code-autofix.ts, the GitHub webhook, and env-link-hub.ts:80-82 allowing git.commit/push/pr. Today only ?surface=legacy (run-review.tsx, code-session-banner.tsx, use-code-auto-fix.ts) and the native CreatePullRequestSheet expose any of it.

**Approach.** Add a 'Ship' control to the v2 header and the Changes dock. Commit (AI-written message through the existing compose route), Push, and Create PR (full/draft) call env git.* on Mac threads and /pull-request on cloud. Port use-code-checks.ts into a CI strip above the composer showing passing/failing/pending, with 'Fix' prefilling a steer message from the failing check's log. Add an 'Auto-fix checks and review comments' switch backed by use-code-auto-fix.ts, defaulting to on once a PR exists. Show the PR chip (#N, state colour) in the sidebar row via shell-threads.ts.

**Needs from outside.** GitHub App installation with contents, pull_requests and checks permissions (already used by the legacy path).

### G06 · Real attachments in the Code session composer: paste, drop and upload

Impact 5, effort M, area coding.

**Competitors.** Codex and Claude Code accept pasted screenshots and any file type. T3 Code takes up to 100 files per message, converts HEIC, and turns pastes over 32 KiB into attachments. Cursor iOS adds Design Mode markup on photos.

**Alevr today.** Stub. v2/composer.tsx:664 only types '@filename' into the draft. There is no onPaste or drop handler, and live-route send() passes [] attachments. env-server already exposes host.upload, which the link hub allows.

**Approach.** Reuse useFileDrop/onPaste/captureScreenshot from src/components/chat/composer.tsx and attachment-tile.tsx in v2/composer.tsx. For Mac threads, stream files through use-env-link.ts host.upload into a session scratch dir and pass paths as TurnItem attachments. For cloud threads, upload via src/lib/attachment-upload.ts and include them in /api/code/tasks/[id]/steer. Convert pastes over 32 KiB to text-file chips with 'Keep inline' (Mod+Shift+V). Run HEIC to JPEG conversion in the browser.

### G07 · Create recurring routines straight from chat ('every weekday at 8am…')

Impact 5, effort M, area automation.

**Competitors.** ChatGPT Scheduled tasks are created from chat with time windows and event triggers. Claude has /schedule in any task. Perplexity Automations propose a schedule and its credit cost for approval. Gemini has scheduled actions. Copilot Cowork has an Automations page.

**Alevr today.** Missing, and misleading. src/lib/chat/system-prompt.ts:166 sends 'every morning…' requests to start_task, which runs once and has no scheduling tool. agent_routine is no longer offered (src/lib/chat/agent-config-tools.ts:1626), and runner/agent-core/src/work/tools.ts has none. Routines can only be made in /automations (work-schedule-editor.tsx).

**Approach.** Add a propose_routine tool (src/lib/tools/specs/propose-routine.ts) that drafts {name, prompt, cadence/RRULE, timezone, notify, budget, approval mode} with src/lib/work/schedule.ts. Render it as a confirm card reusing schedules/arming-card.tsx: plain-language summary, next three runs, estimated cost per run, Schedule / Edit / Not now. Fix the system-prompt routing so recurring intent goes to propose_routine. Add 'Make this a routine' to finished task cards (see G13). Allow natural-language entry in the /automations editor through the same parser.

### G08 · First-party Gmail, Google Calendar/Drive, Outlook/M365 and Slack connectors and triggers

Impact 5, effort L, area integrations.

**Competitors.** ChatGPT has Gmail, Slack and GitHub event triggers and Drive/SharePoint/Box in Library. Claude has Google Workspace and M365 write tools. Gemini has Personal Intelligence across Gmail/Photos. Perplexity Automations have event triggers. Copilot reacts to email and Teams events.

**Alevr today.** Partial. Email and calendar triggers only work through iCloud IMAP/CalDAV (scripts/work-trigger-poller.ts, TRIGGER_SOURCE_CONNECTORS in src/lib/work/triggers.ts). Gmail, Slack and Google Calendar depend on Composio being configured (src/lib/composio.ts). src/lib/connectors/google-drive.ts and microsoft-365.ts are dead code, even though capabilities.ts labels them 'stable'. connector_event and folder_change triggers are listed and then refused.

**Approach.** Build native OAuth connectors next to GitHub/Notion in src/lib/connectors.ts: Google (Gmail read/draft/send, Calendar, Drive picker and sync), Microsoft Graph (Outlook mail/calendar, OneDrive, SharePoint) and Slack (channels read, post with approval). Revive google-drive.ts and microsoft-365.ts as project knowledge sources (src/lib/knowledge/ingest.ts). Add gmail_message, gcal_event, outlook_message and slack_message trigger kinds to triggers.ts using Gmail push (Pub/Sub watch), Graph subscriptions and the Slack Events API instead of polling. Write cursors into the existing trigger dedupe. Every write goes through src/lib/action-approval.ts verbs.

**Needs from outside.** Google Cloud OAuth app with restricted-scope verification (Gmail) and a Pub/Sub topic; Microsoft Entra app registration with Graph permissions; Slack app with Events API; security review (CASA) for Gmail restricted scopes.

### G09 · Fix the Mac-thread queue: remove, edit and steer-now act on the real queue

Impact 4, effort S, area coding.

**Competitors.** Codex: queued messages stack above the composer and can be edited, drag-reordered, sent or deleted. T3 Code: queue saved on the server, promote to steer with Mod+Shift+Enter. Claude Code: Up takes queued items back.

**Alevr today.** Broken. live-route.tsx:291-299 mutates localQueue while env.view.queue is the source of truth. Remove does nothing, Edit copies the text and leaves the original queued (so it sends twice), and 'Steer now' leaves the queued copy behind. runner/env-server/src/sessions/session-manager.ts:364 has dequeue() but no wire method.

**Approach.** Add queue.remove/queue.edit/queue.move/queue.promote wire methods in the env-server protocol, backed by session-manager dequeue/reorder, and allow them in env-link-hub.ts. Make live-route editQueued/removeQueued/moveQueued call them on Mac threads, with an optimistic update reconciled from env.view.queue. Add a unit test in tests/code-* covering the remove-then-steer race.

### G10 · Select a passage in an answer to ask about it or quote it

Impact 4, effort S, area chat.

**Competitors.** ChatGPT has 'Ask ChatGPT' on a selection and 'Start writing'. Claude has Reply with a quote chip and 'Edit with Claude'. Comet's Inline Assistant offers Summarize, Fact check, Define and Translate. T3 Chat has 'Quote selected text'. T3 Code has 'Cite in composer'.

**Alevr today.** Missing in the transcript. Selection-to-ask exists only in canvas-panel.tsx and the document viewer. message-item.tsx offers only whole-message 'Quote in composer'.

**Approach.** Extract the selection bar from canvas-panel.tsx (captureSelection) into a shared SelectionAsk component and mount it on assistant message bodies in message-list.tsx. Actions: Ask, Quote, Explain, Copy. Insert a removable quote chip through context-draft.ts (a new 'quote' context token with message id plus the exact passage), so the resolution receipt (context-receipt.tsx) shows what was quoted. Use the CSS Custom Highlight API, already used for streaming, to keep the passage highlighted while composing.

### G11 · Bring incognito, Share, Continue-on and Session outputs to phones

Impact 4, effort S, area mobile.

**Competitors.** ChatGPT mobile web and apps have Temporary chat one tap away. Claude has the ghost icon at the top right of every new chat. T3 Chat has a top-right temporary toggle on all widths.

**Alevr today.** Missing on phones. The only PrivateChatToggle sits in the header cluster rendered `hidden … md:flex` (chat-view.tsx:2239, 2367), and the command palette has no alternative.

**Approach.** Add a mobile header overflow (⋯) to app-shell.tsx's mobile bar with Incognito, Share, Continue on…, Session outputs and Find. Put the ghost toggle directly on the mobile bar for empty chats. Add 'New incognito chat' to command-palette.tsx and a Mod+Shift+N shortcut in use-global-shortcuts.ts. Match ChatGPT's Temporary chat binding and avoid Safari's.

### G12 · Never lose canvas edits: autosave the draft and confirm before discarding

Impact 4, effort S, area artifacts/canvas.

**Competitors.** ChatGPT writing blocks and Claude Docs autosave. Claude Design keeps drafts. T3 Code stashes drafts for 24h.

**Alevr today.** Defect. canvas-panel.tsx (reset effect on artifact.id at about L260, Close at about L932) silently throws away unsaved code edits. There is no confirm, autosave or beforeunload. Drafts persist only for the design editor (/api/artifacts/[id]/draft).

**Approach.** Generalise /api/artifacts/[id]/draft to every artifact type and debounce-save code-surface.tsx edits there (localStorage as a first write). On Close or a switch with a dirty draft, show Save as new version / Keep draft / Discard. Add a beforeunload guard. Show 'Draft · unsaved' in the canvas status words, and when the artifact reopens offer 'Restore your draft from 3 min ago'.

### G13 · Finished-task actions on the card: Retry, Run again, Continue, Resume and Make a routine

Impact 4, effort S, area agents.

**Competitors.** Gemini Tasks pause, resume and run schedules from chips. Perplexity has Run now, Pause and Edit, and tasks resume after credits. ChatGPT Work can be redirected and continued. Cursor auto-fixes CI on its own PRs.

**Alevr today.** Partial. work-run-panel.tsx TerminalRun only diagnoses. A failed, interrupted or cancelled task has no Retry, and a paused run cannot be resumed on web even though src/app/api/work/runs/[id]/control/route.ts supports pause/resume and work-vocabulary.tsx:75 promises 'It can be resumed'. work-outcome.tsx's docblock still mentions a deleted 'Try again'.

**Approach.** In work-run-panel.tsx add Pause/Resume while running and Retry (new run on the same session with the same brief) and Continue (new run seeded with the outcome digest and checkpoint) when finished, via /api/work/sessions/[id]/runs. Add 'Make this a routine', which opens the G07 card prefilled. Make stream onStopped show 'Disconnected · Reconnect' instead of freezing the card. Delete the stale work-outcome.tsx docblock.

### G14 · Inline, expandable reasoning that also works on phones

Impact 4, effort M, area chat.

**Competitors.** Claude shows a live 'Thinking' label with a timer that collapses into an expandable summary in place. ChatGPT Work has a collapsible 'Worked for 2m 30s ›' that animates open with grid-template-rows 0fr/1fr. T3 Code has 'Worked for Xm Ys' groups.

**Alevr today.** Partial. activity-timeline.tsx shows one live line. The full trace only opens in thought-process-panel.tsx, which below the split width replaces the whole chat (chat-view.tsx:2288).

**Approach.** Add an inline disclosure under the live line in activity-timeline.tsx that renders a compact version of thought-process-model.tsx: reasoning headline sections, tool, search and skill receipts, and the memory receipt. Animate it with the 0fr/1fr grid plus opacity pattern behind motion-safe and interpolate-size. Keep the docked panel as 'Open full trace' on wide screens. On phones open it as a bottom sheet over the chat, never a replacement.

### G15 · Choose a permission mode for tasks from the chat composer

Impact 4, effort M, area agents.

**Competitors.** Claude's unified app puts Manual/Auto/Skip in the message box. Codex has Ask/Approve for me/Full access under the composer. Cursor has Auto-review/Allowlist/Run Everything. T3 Code has a per-thread mode (Mod+Shift+A).

**Alevr today.** Missing. src/lib/chat/task-tool.ts:687 sets permissionPolicy to ctx.agent?.approvalMode ?? DEFAULT ('balanced'), with no user control. composer-home/permission-chip.tsx is orphaned. The Permissions page copy (src/app/(app)/permissions/page.tsx ApprovalModes) promises composer and in-task controls that don't exist, so plan review (src/lib/work/plan-review.ts) is unreachable for chat users.

**Approach.** Revive permission-chip.tsx in the composer tray (composer-tray.tsx) as 'Ask first / Balanced / Hands-off', saved per conversation and defaulting per project (projects work defaults). Pass it through start_task into task-tool.ts. Add a mode control on the live work-run-panel.tsx card that takes effect at the next step through the control route. Update the Permissions page copy to match.

### G16 · Wire @file mentions and the Files dock to the Mac's file system

Impact 4, effort M, area coding.

**Competitors.** Codex @ fuzzy-finds files and Cmd+P searches them. Claude Code @ with fuzzy folders and @file#5-10 ranges. T3 Code has file chips and a file viewer rendering HTML/PDF/CSV.

**Alevr today.** Stub. composer.tsx:308 ranks model.files, which live-route.tsx never sets, so @ only offers @explorer/@reviewer. dock.tsx FilesPane always says 'No file list for this workspace yet.' env-server has fs.list and env-link-hub.ts:78 allows it.

**Approach.** Add a useWorkspaceFiles hook calling fs.list (with a gitignore-aware walk and a cache keyed by checkpoint ref) for Mac threads, and the GitHub tree API for cloud threads. Feed model.files/fileContents. Use fs.read for the viewer and 'N unmodified lines' expansion in the Changes dock. Put the tree on the left and the viewer on the right. Add Cmd+P quick open (rebinding the browser clash per G60).

### G17 · Keep Mac-thread history readable offline and show link status

Impact 4, effort M, area coding.

**Competitors.** Claude Remote Control revives sessions for about 4h after the server stops. T3 Code fails over between LAN, Tailscale and Connect routes. Cursor iOS is cache-first.

**Alevr today.** Partial. src/lib/code-v2/env-client.ts:604 resolveEnvEndpoint returns none when the Mac is offline, so a Mac thread's history disappears (live-route.tsx:87 falls back to empty CodeTask messages), and threads flash the empty state until the link answers. use-env-link.ts status is never shown. Composer copy says 'Messages send when it is back' but Send is disabled (composer.tsx:847-850).

**Approach.** Serve the last relay snapshot from env-link-store-pg.ts through a read-only /api/code/v2/link/[deviceId]/snapshot and hydrate the thread from it before the live link answers. Render ThreadSkeleton (already built) instead of the empty state. Show a link-status pill (Connected / Reconnecting / Mac offline · last seen 4m) in the header. Hold offline sends in a server-side pending queue that the host drains on reconnect, so the copy becomes true.

### G18 · Pin the new user turn to the top while the answer grows below

Impact 4, effort M, area chat.

**Competitors.** ChatGPT and Claude now anchor the new prompt at the top and let the answer stream beneath without moving the reader. Claude Code fullscreen pauses auto-follow and shows a 'Jump to bottom · N new' pill.

**Alevr today.** Partial. use-transcript-window.ts and message-list.tsx:126 follow the bottom, so long answers scroll away from their start as they are read.

**Approach.** On send, scroll the new user turn to the top with a dynamic min-height spacer equal to viewport minus composer, the standard pattern, so the answer fills downward with no auto-scroll. Keep the existing jump-to-latest control, add a new-content count, and stop following once the user scrolls. Use overflow-anchor and scroll-margin-top to avoid jumps when the paced stream-text.tsx reveal changes block heights. Port the same behaviour to Code v2 thread.tsx, which uses scrollTop = scrollHeight.

### G19 · Shared chats: Update link, continue in your own account, per-message share and phone access

Impact 4, effort M, area collaboration.

**Competitors.** ChatGPT has 'Update link' and single-response share. Claude has 'Update shared chat' and email-only invites. T3 Chat viewers fork into their own copy, with view and fork counts. Perplexity viewer follow-ups fork. Codex snapshots redact secrets.

**Alevr today.** Partial. share-dialog.tsx:199-222 has revoke but no re-snapshot. src/app/share/[token]/page.tsx:142 'Open in Alevr' goes to '/'. There is no per-message share, the header Share is hidden on phones, and the shared date is hardcoded to en-US.

**Approach.** Add PUT /api/share/[token] that re-snapshots the same token, plus an 'Update link' button showing 'Updated 2 min ago'. Add 'Continue this chat' on the share page that POSTs a fork via the existing /api/conversations/[id]/fork machinery into the viewer's account, and count forks next to views. Add 'Share this answer' in the message More menu, creating a snapshot scoped to one turn pair. Run secret-pattern redaction (reuse the log redaction from src/lib/cloud-code.ts) before snapshotting. Format dates by locale.

### G20 · Memory sources on answers, and an actionable 'Memory updated'

Impact 4, effort M, area memory.

**Competitors.** ChatGPT's book-style Sources icon shows which memories and chats personalised an answer, with mark-not-relevant and delete, and 'Memory updated' links to Manage. Perplexity lists referenced memories in sources. Claude flags sensitive memory saves above the composer.

**Alevr today.** Partial. The memory receipt exists only in thought-process-panel.tsx. 'Memory updated' (chat-view.tsx:2371-2388) is plain text that vanishes after 4s, its timers are never cleared, and it offers no view or undo.

**Approach.** Add a 'Personalised by' chip to TurnMeta in message-item.tsx listing the recalled memories and chats from src/lib/chat/turn/memory.ts, each with Not relevant (down-weight in ranking), Edit and Forget (memory-suppression.ts). Turn 'Memory updated' into a pill with 'View' (opens the entry in /memory) and 'Undo' (inverse op from /api/memory/edits). Manage dismissal with a ref-tracked timer that is cleared on unmount and on repeat.

### G21 · Mac Quick Entry: a real global hotkey, answers inside the panel, window capture with text

Impact 4, effort M, area desktop.

**Competitors.** Claude's quick entry opens with a double-tap of Option and can attach a dragged region or a clicked window's contents. ChatGPT has Option+Space Quick Chat and Appshots (both Command keys, image plus off-screen text). Gemini Mac has Option+Space. Perplexity opens with both Command keys.

**Alevr today.** Partial. DesktopQuickEntry.swift:54-75 uses NSEvent.addGlobalMonitorForEvents, which needs Accessibility, cannot swallow ⌥Space (so a non-breaking space lands in the front app) and cannot be rebound. Return hands off to the main window instead of answering (lines 303-330).

**Approach.** Register the hotkey with Carbon RegisterEventHotKey (or the KeyboardShortcuts pattern): no Accessibility prompt, the key is consumed, and it is rebindable in DesktopSettings. Stream the reply inside the panel with the shared JunoMarkdownView, adding 'Open in window' and 'Continue'. Add 'Attach window' using SCShareableContent plus AccessibilityEditorBufferReader for the window's text, and a region drag. Route it to the last chat used within 60 seconds, otherwise a new chat (ChatGPT's rule).

**Needs from outside.** macOS Screen Recording permission for window capture (user grant).

### G22 · iOS Share extension and macOS Services menu

Impact 4, effort M, area mobile/native.

**Competitors.** ChatGPT and Claude ship share extensions. Claude adds 'Summarize with Claude' to the Share Sheet through App Intents. Perplexity lets you email tasks to computer@.

**Alevr today.** Missing. native/iOS/JunoMobile/project.yml has only app, widgets and tests targets, native/macOS/JunoDesktop/project.yml has no extensions, and Info.plist has no NSServices.

**Approach.** Add a JunoMobileShare app-extension target (SwiftUI compose sheet: text, URL, images and files, choose New chat / a recent chat / a project) that writes to a shared App Group container and opens com.liammagnier.juno://juno/new?draft=…, reusing JunoMobileComposer attachment handling. On macOS add NSServices entries ('Ask Alevr', 'Send to Alevr') handled by DesktopQuickEntry, plus a Share extension. Never auto-send, matching the deep-link rule in src/lib/code-prefill.ts.

**Needs from outside.** App Group entitlement and provisioning profiles for the new extension targets.

### G23 · Let React artifacts import charting and UI libraries

Impact 4, effort M, area artifacts/canvas.

**Competitors.** Claude artifacts support React with common libraries plus Claude calls, storage and MCP. ChatGPT code blocks preview mini apps. Gemini Canvas builds apps and games. Perplexity renders TradingView charts inline.

**Alevr today.** Partial. src/lib/sandbox/console-doc.ts:61 stripImports removes every import except React and lucide, so recharts, d3, three, shadcn or lodash fail with a ReferenceError, even though system-prompt.ts:248 invites charts. sandbox-frame.tsx loads React development UMD builds and in-browser Babel.

**Approach.** Replace stripImports with an import map in sandbox-frame.tsx reactDoc that resolves an allowlisted, version-pinned set (recharts, d3, three, framer-motion, lodash, date-fns, zod and a vendored shadcn subset) from cdn.jsdelivr.net or esm.sh with integrity hashes. Use React production builds. Compile with esbuild-wasm or sucrase instead of Babel standalone. Update system-prompt.ts to list exactly which libraries are available. Surface unresolved imports through 'Try fixing' with the existing console-doc error channel.

**Needs from outside.** CSP allowance for the chosen CDN origin in the sandbox frame (or self-host the bundles).

### G24 · Project sharing UI: invite members with viewer and editor roles

Impact 4, effort M, area collaboration.

**Competitors.** ChatGPT shared projects (chat or edit access, link or invite, up to 100 collaborators on Pro, branch each other's chats). Claude Team project sharing (Can view / Can edit, Shared with me). Perplexity Projects with roles and request-access.

**Alevr today.** Stub. src/lib/project-collaboration.ts and src/app/api/projects/[id]/members/route.ts implement OWNER/EDITOR/VIEWER, but nothing in src/components/projects lets anyone invite, list or manage members.

**Approach.** Add a Members panel to the project Settings tab (src/app/(app)/projects/[id]/page.tsx): invite by email or username, a role select, pending invites expiring after 30 days, remove, and transfer ownership. Add a 'Shared with me' group in app-sidebar.tsx Pinned projects. Show member avatars in the project breadcrumb in chat-view.tsx. Send invite emails through the existing src/lib/work/notify/email.ts transport. Respect project-scoped memory isolation, so shared projects never pull personal memory.

**Needs from outside.** Transactional email deliverability for invites (existing provider).

### G25 · Diff review that talks back: inline comments, context expansion, virtualization, real highlighting

Impact 4, effort M, area coding.

**Competitors.** Codex: hover '+' inline comments, then 'Address the inline comments', with stage/revert per hunk and no diff-size cap. Claude Code Desktop: click a line to comment, Cmd+Enter submits the batch. T3 Code: mark viewed, find in diff, AI review guides.

**Alevr today.** Partial. dock.tsx ChangesPane has no inline comments, 'N unmodified lines' is always disabled (no fileContents), there is no virtualization, the regex highlighter treats '#' as a comment in every language, there is no stage or accept-all, and hunk decisions live in localStorage (live-route.tsx:168-172). The legacy RunReviewPane's per-line notes are unreachable.

**Approach.** Port per-line notes from run-review.tsx into ChangesPane. Collected comments become a diff_review context chip sent with 'Address comments'. Replace codeTokens with Shiki (lazy, by language from file extension) and virtualize hunks with @tanstack/react-virtual. Enable gap expansion via fs.read (G16). Store hunk decisions server-side per session. Add Stage file/hunk and Commit staged on Mac threads via env git.*.

### G26 · Allow several chats to generate at once in the native apps

Impact 4, effort L, area mobile/native.

**Competitors.** ChatGPT and Claude run multiple conversations and tasks in parallel. Claude's unified app runs several tasks at once, and Cursor iOS tracks 8 agents.

**Alevr today.** Limited. NativeConversationStore.swift:876-878 holds one chatPhase/activeChatConversationID for the whole app, with a guard at :2464. On the Mac, isGenerating is global (ChatComposer.swift:1015), so Stop in another chat stops the first one. On iOS, Send is greyed out elsewhere and fails with the wrong error (conversationPendingMessage).

**Approach.** Refactor NativeConversationStore to hold a per-conversation GenerationSession (phase, stream task, ChatStreamReducer state, retry context) in a dictionary keyed by conversation id. Scope ChatComposer and JunoMobileComposer primary-button state to the current conversation. Make reconnect via /api/chat/stream/active resume every active stream. Add snapshot tests in JunoChatKit for two concurrent streams plus stopping one.

### G27 · Edit documents and decks directly, with selection-scoped AI edits

Impact 4, effort L, area artifacts/canvas.

**Competitors.** ChatGPT writing blocks open a focused full-screen editor with a TOC. Claude Docs offer live co-editing, margin comments, '/' insert, @Claude in comments and export to Word/PDF/Google Docs. Claude Slides allow direct slide editing and a present mode. Gemini Canvas highlights text to change tone or length.

**Alevr today.** Partial. semantic/document-view.tsx only offers Accept/Reject/Resolve, and deck-view.tsx only Move earlier/Duplicate, although document/ops.ts and deck/ops.ts support updateText, insertBlock, deleteBlock, moveBlock, comment, deleteSlide and updateSlide. Markdown is read-only in the canvas. The Ask/Modify bar doesn't work on semantic types because previewScrollRef is attached only to the Markdown view.

**Approach.** Make document-view.tsx blocks contentEditable (or use a TipTap/ProseMirror schema mapped onto document ops), saving through updateText/insertBlock ops with the suggestion guard (artifact-proposals.ts). Add a '/' block insert menu, a select-to-comment flow and 'Edit with Alevr' on a selection, sent as a scoped edit (artifact-edit.ts). Move previewScrollRef onto every preview branch. For decks add text editing, delete and move-later, plus a fullscreen Present mode (arrow keys, Escape, slide announcements). Add ChatGPT-style quick actions (length, reading level, polish).

### G28 · A live browser and computer view for every cloud task, with take over and hand back

Impact 4, effort L, area agents.

**Competitors.** ChatGPT Work's cloud browser shows screenshots and replays, with Take over and a private sign-in form. Gemini Tasks have View live, Take over task and Go back to Gemini. Cursor cloud agents allow remote-desktop takeover. Comet shows a blue edge while the AI is in control.

**Alevr today.** Partial. Ordinary tasks run a headless browser (src/lib/work/browser.ts) the user never sees. Watch and takeover exist only for agent computers (src/lib/computer/store.ts resolveRunComputerSession requires agentId; agent-computer.tsx, computer-viewer.tsx), and capabilities.ts computer_cloud has production security acceptance blocked.

**Approach.** Stream periodic screenshots from the headless browser tool (runner/agent-core/src/work/tools.ts browser) as work events and render a filmstrip in work-run-panel.tsx, with a 'Watch live' sheet reusing computer-viewer.tsx. Add a takeover lease (src/lib/computer/takeover.ts) to the task browser: user input pauses the agent and 'Give back' resumes it. Route sign-ins through the credential broker fill (src/lib/secrets/browser-fill.ts) so the model never sees secrets. Finish the computer_cloud security acceptance (egress, process freeze, VNC rotation) before enabling it for non-agent tasks.

**Needs from outside.** Production-grade isolated browser/VM capacity (self-hosted Docker fleet hardening or a vendor such as a managed browser provider) and a security review.

### G29 · Generative UI that drives the conversation: clickable visuals, savable widgets, entity and map cards

Impact 4, effort L, area chat.

**Competitors.** ChatGPT Intelligent UI renders streamable native components (comparisons, maps, forms, calculators, bill splitters), plus entity side panels and interactive charts. Claude custom visuals send a follow-up when clicked, save as an artifact or download as SVG/HTML, and offer weather and recipe 'Get cooking' cards. Gemini dynamic view. Perplexity inline visualizations.

**Alevr today.** Partial and ahead in places. markdown.tsx renders live-ui blocks, data-chart-block.tsx, data-table-block.tsx, runnable code and mermaid. Visuals can't send a follow-up prompt when clicked, can't be promoted to an artifact or downloaded as SVG/HTML, and there are no map, weather, recipe or entity cards.

**Approach.** Add an intent bridge to live-ui and data-chart blocks (postMessage({type:'ask', text})) that inserts and sends a follow-up through use-chat. Add a toolbar on every visual: Save as artifact (creates an HTML artifact), Download SVG/PNG/HTML, Fullscreen with scroll restore. Add typed blocks to the live-ui registry for place/map (MapLibre with OSM tiles), weather (search-backed), recipe with a servings scaler and step mode, and entity cards opening a side sheet with sourced facts. Respect a 'Layout and visuals' preference in ui-prefs.

**Needs from outside.** Map tile provider and a weather data source if not served via search.

### G30 · Artifacts with persistent storage that can call the model, billed to each viewer

Impact 4, effort L, area artifacts/canvas.

**Competitors.** Claude artifacts call Claude on each viewer's own plan, with personal or shared storage (20 MB) and per-viewer MCP connectors. ChatGPT Sites have D1/R2 storage and read visitors' connected apps.

**Alevr today.** Missing. The sandbox shims localStorage. Artifacts cannot persist data or call a model. Publishing exists (src/lib/artifact-publication.ts) but only for static pages.

**Approach.** Expose a window.alevr bridge in sandbox-frame.tsx with storage.get/set (personal and shared scopes) backed by a new ArtifactStore table (20 MB text cap) and ai.complete routed through the chat router under the viewer's session and plan with a first-use permission card. Block ai on 'anyone with the link' shares, matching Claude. Add connector calls later, through the standing grants in src/components/connections/standing-grants.tsx.

### G31 · Warm, persistent cloud environments for Code instead of a cold GitHub Actions job per turn

Impact 4, effort XL, area coding.

**Competitors.** Codex Cloud: published environments, warm repos, state recoverable for 7 days, container caching (median start 48s→5s). Claude Code on the web: Anthropic VMs that keep running with the laptop closed. Cursor Cloud Agents: VMs with snapshots and remote desktop.

**Alevr today.** Partial. src/lib/cloud-code.ts and .github/workflows/code-runner.yml start a fresh public-repo Actions job per follow-up (checkout, npm ci, build, clone), taking minutes, with a 30-minute cap, no live terminal and no warm pool.

**Approach.** Introduce a CloudRunner provider interface beside the Actions path. Run runner/env-server inside per-session containers on a container platform with a snapshot per session (filesystem plus checkpoint refs), resumable for 7 days, and connect it to the existing device link (env-link-hub.ts) so cloud and Mac threads share one protocol, terminal and Files dock. Pre-warm images per CodeEnvironment (setup script and variables from /api/code/environments). Keep Actions as a fallback for users without the plan.

**Needs from outside.** Container/VM compute vendor or self-managed cluster, egress proxy, secrets management, and billing for compute minutes.

### G32 · Team and Business workspaces: orgs, seats, shared billing, SSO, SCIM and audit log

Impact 4, effort XL, area platform.

**Competitors.** ChatGPT Business/Enterprise (SCIM, RBAC, Compliance API, admin model defaults). Claude Team ($25/seat, project sharing, org skills, SSO) and Enterprise (audit logs, SCIM, IP allowlisting). Copilot admin model families and credit approvals.

**Alevr today.** Missing. prisma/schema.prisma has no Organization or Team model, and the Plan enum has no team tier. src/lib/auth/enterprise-sso.ts is unused and SAML throws. DLP (src/lib/security/dlp.ts) has no policy UI. The admin console (src/app/(app)/admin) is an operator tool only.

**Approach.** Add Organization, Membership (role) and Seat models, with an org-scoped billing customer on Stripe per-seat prices in src/lib/plans.ts. Add an /org admin area: members and invites, domain capture, default model/effort, allowed connectors and skills, retention, and a usage report reusing usage-history.tsx. Wire enterprise-sso.ts OIDC into NextAuth for org domains. Add a SCIM 2.0 endpoint and an append-only AuditEvent table fed from action-approval and share events. Org-provisioned skills and projects come from the existing skills and project models.

**Needs from outside.** Stripe per-seat products, IdP test tenants (Okta/Entra/Google) for OIDC/SCIM, and legal terms (DPA).

### G33 · Thumbs-down that listens: no celebration, and a reason picker

Impact 3, effort S, area chat.

**Competitors.** ChatGPT and Claude open a light feedback form on thumbs-down with issue categories and an optional note.

**Alevr today.** Tone-deaf. message-item.tsx:1460-1463 passes `celebrate` to both thumbs (confirmed), so 'Bad response' plays Swell plus a confetti Burst. use-chat.ts:2078 setFeedback carries no reason.

**Approach.** Remove celebrate from the down IconAction. Open a popover with chips (Inaccurate, Didn't follow instructions, Too long, Unsafe/refused, Bad formatting, Other) and an optional note, posted to the feedback route with the turn's routing receipt so the router's measured outcomes (src/lib/router/evidence.ts) learn from it. Keep the up thumb's Swell but drop the Burst after the first use in a session.

### G34 · Starter prompts and capability chips on the home screen

Impact 3, effort S, area chat.

**Competitors.** Claude shows five chips (Code, Create, Write, Learn, Life stuff) under a serif greeting. T3 Chat swaps Create/Explore/Code/Learn suggestions. ChatGPT surfaces suggestions and tools.

**Alevr today.** Partial. empty-state.tsx has the serif greeting and dot field, but chat-view.tsx:2680 renders the chat-home__suggest slot as an empty div.

**Approach.** Fill chat-home__suggest with 4–5 pill chips (Write, Research, Code, Create image, Plan a task) that swap a short list of starter prompts, personalised from recent projects and memory when available and static for new users. Clicking prefills (never sends) and sets the right mode (research toggle, image token, Code handoff). Stagger them in on the existing rise-in and hide them once typing starts.

### G35 · Return inserts a newline on touch keyboards

Impact 3, effort S, area mobile.

**Competitors.** ChatGPT and Claude mobile web insert a newline on Return and send with the button. T3 Code mobile has a long-press send for the opposite action.

**Alevr today.** Wrong default. composer.tsx:1987 and src/lib/composer-keys.ts send on Return everywhere unless the user finds Settings › Keyboard.

**Approach.** In composer-keys.ts, detect a coarse pointer without a hardware keyboard (matchMedia('(pointer: coarse)') plus the last keydown from a physical keyboard) and make Return a newline there. Set enterKeyHint='enter' on touch and 'send' on desktop. Keep the Settings override.

### G36 · Show dictation on browsers without Web Speech

Impact 3, effort S, area chat.

**Competitors.** ChatGPT and Claude dictation work in every major browser via server STT.

**Alevr today.** Defect. composer.tsx:3296 renders the mic only when speechSupported (confirmed), although composer-dictation.tsx:202/441 has a serverStt path that doesn't need Web Speech.

**Approach.** Gate the mic on getUserMedia support instead. When Web Speech is missing, record with MediaRecorder and use the serverStt path to /api/voice/stt, showing a level-reactive waveform instead of the live preview text.

### G37 · Fix research export and add DOCX, copy, share and open-in-canvas

Impact 3, effort S, area research.

**Competitors.** ChatGPT deep research downloads as Markdown, Word or PDF with a TOC and activity history. Perplexity exports PDF/MD/DOCX. Gemini exports to Docs.

**Alevr today.** Defect. ResearchExportContext (report-export.tsx:46) is never provided anywhere (confirmed), so downloads use the fallback with <!-- juno:section --> markers and a research-YYYY-MM-DD.md name. reportMarkdownExport in src/lib/research/export.ts is reached only by tests. report-fullscreen.tsx has no copy, DOCX, share or canvas action.

**Approach.** Make report-export.tsx call reportMarkdownExport directly (or wrap the research routes in a provider) and use exportFileName for the slug. Add 'Download Word' through /api/artifacts/[id]/export?format=docx on the saved MARKDOWN artifact (office-export.ts already verifies output), 'Copy report', 'Open in canvas' and 'Share' (artifact publication) to the report-fullscreen.tsx toolbar. Make 'Saved in Library' in research-recap.tsx a link.

### G38 · Client-side /model, /clear and /plan

Impact 3, effort S, area coding.

**Competitors.** Codex, Claude Code and T3 Code treat /model, /clear and /plan as app actions that never spend a turn.

**Alevr today.** Wrong. SLASH_COMMANDS in src/lib/code-v2/composer.ts advertises /model and /clear, but they are sent to the agent as prompts. /plan doesn't switch the mode. Only /compact is handled (runner/agent-core/src/agent.ts:735).

**Approach.** In v2 composer submit, intercept /model (opens pickers.tsx), /clear (new thread in the same workspace), /plan [task] (switch to plan mode via composer-mode.ts, then send the remainder) and /compact (actions.compact, which also fixes 'Compact and switch'). Mark provider-only commands distinctly in the slash menu.

### G39 · Answer actions in Code: Retry, Copy, Feedback, Edit and resend

Impact 3, effort S, area coding.

**Competitors.** Claude Code VS Code reveals Copy response, Bookmark and rewind on hover. Codex forks from any message. T3 Code rewinds with 'Revert files too'.

**Alevr today.** Missing. thread.tsx accepts onRetry but workspace.tsx never passes it, so retryable failures are dead ends. use-code-session.ts setFeedback is unused, and answers have no copy, regenerate or edit-and-resend.

**Approach.** Pass onRetry (resend the last turn's prompt and attachments) from workspace.tsx. Add a hover row on answers (Copy, thumbs via setFeedback, 'Edit and resend from here', which rolls back to that checkpoint via the existing rollback, then prefills the prompt). Reuse the Chat IconAction component for visual consistency.

### G40 · Session management in v2: rename sheet, pin, archive, delete, share and sidebar row menu

Impact 3, effort S, area coding.

**Competitors.** Claude Code Desktop archives on hover and auto-archives when the PR merges. T3 Code has pin/snooze/settle with 5-second undo. Codex has rename by double-click and bulk move.

**Alevr today.** Partial. workspace.tsx:244 renames through window.prompt. Pin, Share read-only link, Archive and Delete exist only in legacy code-session-menu.tsx. code-work-list.tsx rows have no menu.

**Approach.** Port code-session-menu.tsx actions into the v2 sessionMenu and a row context menu in code-work-list.tsx: inline rename, Pin, Share snapshot (reuse share-dialog with secret redaction), Archive with an Undo toast, and Delete with a confirm. Auto-settle a thread when its PR merges (shell-threads.ts already knows the PR state). Double-click a title to rename.

### G41 · Make Code settings in global Settings actually work

Impact 3, effort S, area settings.

**Competitors.** Codex Settings and Claude Code /config edit permissions, agents and session defaults without an open session.

**Alevr today.** Dead end. sections/code.tsx reads codeSettingsBridge, which workspace.tsx:447-458 clears on unmount. Settings is a route, so Session preferences, Agents and Permissions always show 'Open a Code session…'.

**Approach.** Persist Code defaults (default mode per project, team preset, role routing, agent definitions) server-side through /api/code/routing and a user-level CodePrefs row, and read them directly in sections/code.tsx instead of through the bridge. Keep the bridge only for live-session overrides.

### G42 · Show routine and trigger health on web

Impact 3, effort S, area automation.

**Competitors.** Perplexity prompts reconnect when connectors expire and pauses after repeated skips. ChatGPT's Scheduled inbox has unread, active, paused and completed states. Gemini skips schedules visibly.

**Alevr today.** Missing. The poller records lastPollError, but ClientWorkTrigger (src/lib/work/schedule.ts) never sends it and work-schedule-row.tsx shows only 'last ran X ago', so a trigger broken by an expired iCloud password looks healthy.

**Approach.** Add lastPollError, lastPolledAt and lastRunOutcome to ClientWorkTrigger and the routine serializer. Show a status dot plus words on the row (Healthy / Can't read mail · Reconnect / Last run failed), with a Reconnect action that opens the connector. Send one notification on the first consecutive failure (src/lib/work/notifications.ts). Fix the 'Emails…' notify sentence and the stale poller and page docblocks.

### G43 · Fix the task follower on re-runs, and stop polling idle conversations

Impact 3, effort S, area agents.

**Competitors.** Codex App Server streams turn and item lifecycles per run. Cursor reconnects after sleep.

**Alevr today.** Likely bug plus waste. use-conversation-work.ts ends SSE on 'done' and only resubscribes when sessionId changes, so a new run in the same session leaves the plan and events frozen. It also polls every 4s indefinitely, even in hidden tabs and conversations with no task (DISCOVERY_POLL_MS).

**Approach.** Key the subscribe effect on [sessionId, activeRunId] and resubscribe from the run cursor when a new run id appears in the session header. Replace discovery polling with a server-sent 'task started' event on the existing chat stream, with backoff to 30s and a pause on visibilitychange when hidden. Add a regression test for a routine re-firing in an agent thread.

### G44 · Remove 'Juno' from every user-visible surface

Impact 3, effort S, area design.

**Competitors.** Competitors keep brand consistency; Claude even signs release notes 'Yours, Claude'.

**Alevr today.** Leaking. 172 strings in native JunoWork sources (including the screen-control indicator in EmergencyStop.swift:52), trigger poll errors, the run terminal detail (scripts/work-runner.ts:4254), the User-Agent 'Juno Work (+https://chat.liams.dev)' (work-runner.ts:1667), file names juno-memory-*.json (use-memory.ts:599) and *.juno.design.json, plus 'a Alevr' grammar in JunoMobileWidgets.swift:52.

**Approach.** Route every user-facing product name through src/lib/brand/names.ts and a Swift JunoBrand constant. Add an ESLint rule and a SwiftLint custom rule forbidding /\bJuno\b/ in string literals outside identifiers. Rename export files to alevr-memory-*.json and *.alevr.design.json, keeping read compatibility with the old extensions. Set the User-Agent to 'Alevr Work (+https://alevr…)'.

### G45 · Tiered in-app Reduced motion, a 'Full' option, and Tailwind utilities on the motion tokens

Impact 3, effort S, area motion.

**Competitors.** ChatGPT web has 117 prefers-reduced-motion blocks that keep state feedback. Codex gates every TUI animation behind one flag. T3 Code has a panel animation slider.

**Alevr today.** Inconsistent. globals.css:4594-4602 applies a blanket !important kill for html[data-motion='reduced'], while the OS path is tiered (globals.css:943-1000). MotionPref has only system|reduced. tailwind.config.ts:276-316 uses literal durations and easings, so reduced-motion token overrides never reach utilities. The gallery uses 'reduce' while the app uses 'reduced' (report-document.tsx:89, activity-timeline-tab.tsx:53).

**Approach.** Make html[data-motion='reduced'] set the same custom properties as the OS block (--motion-shift:0, --motion-scale-from:1, decorative loops off) instead of killing everything. Add MotionPref 'full' in src/lib/ui-prefs.ts. Change tailwind transitionDuration and transitionTimingFunction to var(--dur-*)/var(--ease-*). Normalise on 'reduced' and add a unit test that both attribute values are honoured.

### G46 · Scope icon hover articulation back to destinations

Impact 3, effort S, area motion.

**Competitors.** ChatGPT and Claude keep menus, lists and composer actions still. Motion is reserved for state changes.

**Alevr today.** Over-applied. juno-icons/icons.css:67-95 turns hover gestures on for every a, button, menuitem, option and tab (owner note 2026-10-14), against BRAND_IDENTITY and the icons.tsx/juno-icons/index.tsx headers. About 120 lines of dead svg.icon[data-motion] CSS remain in globals.css:827-945.

**Approach.** Invert the default. Articulate only elements with data-jicon-articulate (sidebar destinations, primary nav, empty-state actions) and leave dense menus, lists and message actions still. Delete the dead svg.icon[data-motion] rules and the unused juno-glyphs.tsx. Align the doc headers with the result.

### G47 · Onboarding that activates: server-gated, use-case setup, an import nudge, a tour of modes

Impact 3, effort S, area platform.

**Competitors.** Gemini 'interview me' guided setup. Perplexity conversational onboarding for new accounts. Claude memory import with a ready-made export prompt. Codex imports from Claude Code, Cowork and Cursor.

**Alevr today.** Partial. onboarding.tsx is a name/theme/accent dialog gated by the localStorage key juno:onboarded:v1, so it reappears on every new browser, and name save failures are swallowed.

**Approach.** Store onboardedAt on the user. Add steps: what you'll use Alevr for (seeds starter chips G34 and Auto preferences), 'Bring your history' (deep link to import-history.tsx for ChatGPT/Claude/Gemini plus memory import), and a three-card tour of Chat · Code · Orbit. Surface name save errors inline.

### G48 · Simplify the seven consumer tiers

Impact 3, effort S, area pricing/limits.

**Competitors.** Claude: Free, Pro, Max 5x/20x. ChatGPT: Free, Go, Plus, Pro. Perplexity: Free, Pro, Max. Gemini: Plus, Pro, Ultra.

**Alevr today.** Choice overload. src/lib/plans.ts and upgrade-view.tsx offer Free, Lite, Pro, Plus, Max x5, Max x10 and Ultra. The FAQ hardcodes '20% French VAT' next to the locale-aware vatNote.

**Approach.** Collapse to Free, Plus, Pro and Max with an in-tier usage multiplier stepper (x5/x10) inside Max, keeping legacy plans grandfathered in plans.ts. Show at most three cards above the fold in plan-orbit.tsx. Make the VAT FAQ use vatNote(locale). Poll the upgrade welcome page (src/app/(app)/upgrade/welcome/page.tsx) until the plan settles instead of a single 1.2s refresh.

**Needs from outside.** Stripe price and product changes; legal review of plan change notices.

### G49 · Fuller incognito: attachments, save to history, a personalised option

Impact 3, effort M, area chat.

**Competitors.** ChatGPT temporary chats accept files, offer Personalized or Unpersonalized, and can be saved later. Claude keeps memory-off chats in history.

**Alevr today.** Partial. composer.tsx:1998/2252 refuses attachments in incognito and silently ignores pasted files. There is no 'save this chat'. 'Fork privately' drops attachment-only turns and artifacts.

**Approach.** Allow ephemeral uploads in incognito (stored under a TTL prefix and purged when the session ends) and show a note instead of silently ignoring them. Add 'Save to history' in the incognito header, which posts the session transcript into a new conversation. Add a Personalized/Unpersonalized choice before the first message (memory and instructions on or off). Make private forks carry attachments and artifacts by reference.

### G50 · Regenerate any answer and unify branching

Impact 3, effort M, area chat.

**Competitors.** ChatGPT can retry any response with another model or with search. Claude 'Try again' on any turn with a 1/N switcher. T3 Chat has 'Retry or switch model' and 'Branch to temporary chat'.

**Alevr today.** Partial. message-item.tsx:1481 allows regenerating only the last answer, and Regenerate is hidden in incognito and forks. There are two branch verbs with different glyphs (the 'Fork privately' icon on user bubbles at 1081 versus the Branch submenu at 1500-1534). Older versions lose their activity.

**Approach.** With G03's branch model, regenerating an earlier answer creates a new branch at that turn. Show RegenerateMenu on every assistant turn. Merge the branch verbs into one 'Branch' menu (New chat / Private) on assistant turns only, and drop the bare icon on user bubbles. Keep activity and steps on old versions by storing the steps JSON with MessageVersion.

### G51 · A research history index, and site restrictions

Impact 3, effort M, area research.

**Competitors.** ChatGPT deep research lets you restrict or prioritise sites under Manage sites and keeps reports in Library. Perplexity History filters by Research mode.

**Alevr today.** Missing. src/app/(app)/research/page.tsx and [id]/page.tsx redirect into chat. Past runs are only findable through their chat or as MARKDOWN artifacts.

**Approach.** Make /research a list of runs (title, verdict, sources, date, depth) from the research model, using the research.css editorial row style, with filters and search. Add a 'Sites' field to scope-card.tsx (only these domains / prefer these domains), passed to src/lib/research/planner.ts and the search fusion as domain filters.

### G52 · One Library: content search, in-app viewers, type filters, stable paging, rendered thumbnails

Impact 3, effort M, area files.

**Competitors.** ChatGPT Library has search across files and Drive, recent files in the composer, and files that open beside the chat. Claude's Artifacts tab has rendered previews. Perplexity history filters by type.

**Alevr today.** Partial. library-home.tsx searches titles only, merges two feeds and re-sorts on the client (older items appear mid-list). Deliverables and files open as raw downloads in a new tab, HTML/React tiles show source code, and /artifacts (take 200, duplicate 'Documents' chips) duplicates Library's 'Made by Alevr'. Trash is thin (library-trash.tsx).

**Approach.** Merge /artifacts into Library as a type facet: one server-paginated feed via a combined cursor in /api/library and /api/library/made, ordered by updatedAt. Add type chips (Documents, Sheets, Decks, Code, Designs, Files, Media) and sort. Add 'Search inside files' using src/lib/knowledge/retrieve.ts. Open files in DocumentViewer and deliverables in the work preview routes (work-site-preview.tsx). Generate thumbnails server-side (HTML/React rendered to PNG with the poster renderer in src/app/share/[token]/poster). In Trash, add per-type icons, a purge date and Delete forever.

### G53 · One working indicator everywhere: the galaxy, driven by real state

Impact 3, effort M, area design.

**Competitors.** Claude has one signature spark (users protested when the Code tab changed it). ChatGPT uses a consistent shimmer and pulse vocabulary. T3 Code bans lying spinners and perpetual animation.

**Alevr today.** Inconsistent. One run can show the galaxy (live-line.tsx), the RunGlyph matrix (activity-timeline-tab.tsx:152, scope-card.tsx:125), native shimmer text (JunoShimmerText.swift, 17 sites) and about 94 Loader2 spinners at once. GALAXY_SPEC.md is cited but missing. Native JunoGalaxyMark.swift snaps to a still frame instead of easing, and has no finished dim or label.

**Approach.** Write docs/design/GALAXY_SPEC.md from galaxy-mark.tsx. Replace RunGlyph in the Activity panel and scope card with GalaxyMark sizes. Replace native JunoShimmerText with JunoGalaxyMark plus static text. Keep Loader2 only inside buttons (button.tsx loading). Port the exponential stop (tau 0.35s), the 60% finished dim and the accessibilityLabel to JunoGalaxyMark.swift. Move presence colours to a --presence token (see G72).

### G54 · Mobile web that feels native: safe areas, swipe, bottom sheets, 44px targets, compact headers

Impact 3, effort M, area mobile.

**Competitors.** ChatGPT's mobile sidebar follows the finger (gesture progress variable) and bottom sheets ease on (0.2,0.8,0.2,1). Claude's mobile embedded UI uses 44pt targets in thumb reach.

**Alevr today.** Partial. src/app/layout.tsx viewport has no viewportFit 'cover' (confirmed), so every env(safe-area-inset-*) padding is 0 in the standalone PWA. ui/sheet.tsx and dialog.tsx have no drag or swipe, and dialogs stay centred on phones. Small icon buttons are 36-40px under coarse (pressable.tsx:140). The Code v2 turn-rail ticks are 2×8px. Projects and Library push the first item to the fold at 390px.

**Approach.** Add viewportFit:'cover' to the viewport. Add a drawer variant to sheet.tsx using pointer events with velocity-based dismissal (Code v2 already has a bottom-sheet with rubber-banding; extract it). Make dialog.tsx render as a bottom sheet below 640px. Add edge-swipe to open the sidebar in app-shell.tsx. Raise coarse icon targets to 44px. Enlarge cv2-nav-tick hit areas with a ::before pad. Compact the phone header of the editorial pages (title plus one-line description, stats folded).

### G55 · Automated accessibility checks and prefers-contrast coverage on web

Impact 3, effort M, area design.

**Competitors.** Claude documents keyboard and screen-reader behaviour per editor. ChatGPT visualizations target visible focus, contrast and reduced motion. Native Alevr already has contrast tests.

**Alevr today.** Partial. There are no axe or contrast tests in e2e/ or tests/. prefers-contrast: more covers only the composer (globals.css:1719,1945). customize-section.tsx:60-63 puts counts inside the h2 ('Your skills3'). The research tablist lacks arrow keys and roving tabindex, and the Work question radiogroup lacks arrow keys.

**Approach.** Add @axe-core/playwright to e2e with a sweep over the /dev galleries in light/dark × 1440/390, failing on serious violations. Port JunoInkContrastTests' math into a vitest that checks token pairs from tokens.generated.ts. Extend prefers-contrast: more to the hairline and tone-step boundaries. Fix the h2 count (aria-hidden count plus sr-only text), and use the segmented-control roving pattern in the research console tabs and the TaskQuestion radiogroup.

### G56 · Symmetric motion: exits for docks, popovers and folds, plus View Transitions for list to detail

Impact 3, effort M, area motion.

**Competitors.** ChatGPT animates collapsibles both ways with grid 0fr/1fr and interpolate-size, sidebars via grid-template-columns, and uses @view-transition navigation. Claude visuals expand to fullscreen and return to the same scroll position. Cursor crossfades trays without layout shift.

**Alevr today.** Lopsided. Code v2 dock, popovers, palette, sheets and toasts animate in but unmount instantly. The .cv2-fold transition only plays on open because Steps unmounts. The approval/textarea swap jumps height. page-transition.tsx has no exit. Only agent-presence sets viewTransitionName. Canvas fullscreen fades in only. The work-run-panel live-to-finished swap collapses with mode='wait'.

**Approach.** Wrap conditional Code v2 surfaces in AnimatePresence with --dur-exit ease-in exits. Keep fold content mounted and animate grid-template-rows both ways. Animate composer height with a ResizeObserver-driven height transition. Use document.startViewTransition for chat list to thread, artifact tile to canvas, and the Orbit portrait to the agent header (agent-presence already supports transitionName), with a crossfade fallback under reduced motion. Animate the WorkRunPanel body swap with layout height instead of mode='wait'.

### G57 · Working Preview from any device, plus annotate-to-edit

Impact 3, effort M, area coding.

**Competitors.** Claude Code Desktop has a browser pane with launch.json, auto-verify and element select. Codex has a built-in browser with annotation and 'Adjust'. Cursor Design Mode. T3 Code shares a headless Chrome with takeover.

**Alevr today.** Stub on web. dock.tsx PreviewPane frames the viewer's own localhost:3000, the sandbox lacks allow-same-origin, and it's reachable only from More. Native has full preview (Views/Preview/*).

**Approach.** Tunnel the Mac's dev-server port through the device link (env-server DevServerService exposes a proxied HTTPS URL behind the pair cookie). Point PreviewPane at it with allow-same-origin plus allow-scripts on a separate origin. Add the Preview tab automatically when a dev server is detected. Port the native element inspector: click an element to get a context chip (selector, component, screenshot) in the composer.

### G58 · One composer from landing to session, painted on first load

Impact 3, effort M, area coding.

**Competitors.** Claude Code Desktop keeps one bottom composer holding environment, folder, model and mode. Codex keeps the control row under the composer.

**Alevr today.** Inconsistent. code-composer.tsx (ComposerShell plus Chat's ModelSelector) differs from v2/composer.tsx, and Team, subscription and BYOK options only appear after the session exists. /code/[id]/client.tsx is client-only with no fallback, the parent loading.tsx draws a landing-shaped skeleton, and the empty-state copy differs ('What will you build?' vs 'What should we build in X?').

**Approach.** Make the v2 composer the single component, with a 'landing' variant that includes the target picker, and render pickers.tsx (all providers, Team, BYOK) on the landing too. Add src/app/(app)/code/[id]/loading.tsx rendering ThreadSkeleton, and server-render initialMessages through a lightweight static thread before hydration. Animate the composer from the centre to the dock on first send, as chat-view.tsx already does.

### G59 · Goal and live todo row above the composer

Impact 3, effort M, area coding.

**Competitors.** Codex /goal with a progress row (pause, resume, edit, clear). Claude Code /goal judged by a separate model and Ctrl+T todo. T3 Code /goal progress row. Cursor plan pill.

**Alevr today.** Missing on web. docs/code-v2/DESIGN.md:175 specifies a pinned one-line todo above the composer, but the web shows it only inside the folded work log. There is no /goal in v2, though native has goals.

**Approach.** Render update_plan state as a one-line strip above the v2 composer ('2 of 5 · Running tests'), expanding to the checklist. Add /goal <definition of done>: a goal row with elapsed time and pause, edit and clear, evaluated after each turn by a small model in agent-core (the harness already does routing and auto-review with secondary models). Persist it in session state so the Mac and the phone show the same goal.

### G60 · Cloud environments UI, keybinding cleanup and dead shortcuts

Impact 3, effort M, area coding.

**Competitors.** Codex: create environment by describing setup, network presets, secrets as placeholders. Claude Code: environments with network levels and setup scripts.

**Alevr today.** Partial. The CodeEnvironment model and /api/code/environments are complete, but only work-schedule-editor uses them, and code-customize.tsx:348 says they're not configurable. src/lib/code-v2/keymap.ts lists dead bindings (⌘F, ⌘Z, 'a') and clashes with the browser (⌘D, ⌘P, ⌘N, ⌘J, ⇧⌘A). The palette lacks a focus trap.

**Approach.** Add an Environments editor to /code/customize (variables encrypted, setup script, network: none / package managers / custom allowlist) and an environment chip on the cloud target picker. Allow the prefill environment parameter (src/lib/code-prefill.ts). Remove or implement the dead bindings, remap clashes to Alt-based or ⌘⇧ chords in keymap.ts, and give the palette aria-modal with a focus trap via the Radix Dialog primitive.

### G61 · End-to-end tests for the Code flow

Impact 3, effort M, area coding.

**Competitors.** Competitors' release notes treat streaming and wiring regressions as product bugs (Codex 26.x streaming fixes).

**Alevr today.** Missing. e2e/ has no Code spec, which is why the wiring gaps above (G02, G06, G09, G16) went unnoticed despite about 50 unit test files.

**Approach.** Add Playwright specs against a fake env-server (runner/env-server has a fake provider for tests): landing with model plus attachment, session first turn honours the model, approval allow and deny, queue edit and remove, diff review comment, commit and PR (mocked GitHub), and Mac offline replay. Run them in CI on PRs touching src/components/code or runner/.

### G62 · Durable offline sends and real network awareness in native apps

Impact 3, effort M, area mobile/native.

**Competitors.** T3 Code mobile has offline drafts and queued messages with local attachment copies. Cursor iOS is cache-first. Alevr's own outbox already does this for conversation edits.

**Alevr today.** Partial. NativeConversationStore.swift:1077-1081 keeps unsent turns and retry contexts in memory only. ChatDetail.swift:105-125 promises 'messages send when you're back' but nothing is queued. There is no NWPathMonitor anywhere.

**Approach.** Persist outgoing chat turns (text, attachment file copies, composer settings, clientRequestId) in PersistentMutationOutbox as a sendMessage mutation, drained by NativeSyncCoordinator on reconnect using /api/chat/receipt for idempotency. Add a shared JunoNetworkMonitor (NWPathMonitor) driving one offline banner in both apps, and resume streams on path restore.

### G63 · 'Continue on Mac/iPhone' that works without APNs

Impact 3, effort M, area mobile/native.

**Competitors.** Codex pins sync between desktop and iOS. Claude tasks continue across surfaces. ChatGPT cloud Work chats sync everywhere.

**Alevr today.** Broken in shipping builds. src/app/api/sync/handoff/route.ts:33-44 delivers only via APNs. Developer ID Mac builds can't register for push (JunoDesktopApp.swift:167-173), and iOS lacks the entitlement (G01), so users get 'No Mac signed in…' with the Mac app open.

**Approach.** Deliver handoff as an event on the existing /api/sync/threads long-poll (ThreadSyncClient.swift:209), which both apps already hold open. The receiving app shows a non-intrusive 'Continue <chat> from iPhone' banner or local notification. Keep APNs as an optional fast path once G01 lands.

### G64 · Widgets and controls worth using: fixed small widget, Lock Screen, Control Center, recent and needs-you

Impact 3, effort M, area mobile/native.

**Competitors.** Claude iOS has a widget with new chat, dictation and photo, plus Lock Screen 'Analyze Photo'. Codex mobile widgets show recent tasks and remaining usage with reset times. T3 Code has a usage widget.

**Alevr today.** Partial. JunoMobileWidgets.swift:44-124 is one static widget with timeline policy .never. In systemSmall it uses four Links (WidgetKit honours only one) and the tiles overflow about 200pt. There are no Lock Screen accessories or Control Center controls.

**Approach.** Make systemSmall a single 'New chat' tile with a dictation glyph, and keep the four actions for medium. Add accessoryCircular and accessoryRectangular (New chat, Voice, Needs you count), iOS 18 ControlWidget buttons (Voice, Ask, Camera), and a 'Needs you / Recent' medium/large widget fed by an App Group snapshot written on sync with a .after(15 min) timeline policy. Add a usage-remaining widget from /api/usage.

### G65 · App Intents that answer inside Siri and Shortcuts, with conversation entities

Impact 3, effort M, area mobile/native.

**Competitors.** Claude's 'Ask Claude' answers from Siri, Spotlight and the Share Sheet without opening the app and chains in Shortcuts. Codex has Spotlight and Shortcuts entries. Perplexity binds the Action Button.

**Alevr today.** Partial. iOS JunoMobileIntents.swift:162-279 has five intents, all of which open the app. There are no AppEntity types. The Mac has one intent. Spotlight indexes titles only and rebuilds the whole domain every sync (JunoMobileSpotlight.swift:34-37).

**Approach.** Make AskAlevrIntent return a String result via a non-streaming chat call (default model, counted against usage). Add ConversationEntity and ProjectEntity with an EntityQuery backed by the local SQLite store, enabling 'Open chat X' and 'Add to project'. Add a 'Summarize with Alevr' intent accepting text/URL input for the Share Sheet. Index incrementally (CSSearchableIndex per-item updates) and add CoreSpotlight on the Mac.

### G66 · Live Activities for v2 Code approvals, push-to-start and in-place actions

Impact 3, effort M, area mobile/native.

**Competitors.** Cursor Live Activities track up to 8 agents. Codex Live Activity for worktree setup. ChatGPT voice on the Lock Screen and Dynamic Island. T3 Code Live Updates that visibly degrade when stale.

**Alevr today.** Partial. The Code approval activity starts only in the legacy relay thread while it's on screen (JunoMobileCodeRemote.swift:237-247). JunoMobileLinkThread never starts one. There's no push-to-start, Allow and Deny open the app, and the voice activity has no Mute or End.

**Approach.** Start the activity from the v2 link thread model (CodeLinkRemoteModel) whenever any paired session is running or waiting, and register push-to-start tokens with the server so approvals appear from the background. Implement Allow/Deny/Mute/End as LiveActivityIntent so they run in place (Allow still requires Face ID via the existing responder). Show elapsed time and the step count, and mark stale content after 15 minutes.

**Needs from outside.** APNs push-to-start (requires G01) and the Live Activities push type on the server.

### G67 · Run trace and task cards in the iPhone transcript

Impact 3, effort M, area mobile/native.

**Competitors.** Claude mobile shows task progress and lets you steer. ChatGPT Work shows a collapsible 'Worked for' line on mobile. Cursor iOS follows subagent cards live.

**Alevr today.** Partial. iOS JunoMobileThoughtProcess.swift:26-60 shows only reasoning text and a clock, with no tool, search or connector steps. The transcript has no Work run card (tasks live in a separate Work tab).

**Approach.** Consume phase and tool events in ChatStreamReducer on iOS and render a compact step list under the thought-process row (reuse NativeRunTimeline from the Mac). Port ChatWorkRunCard.swift to iOS so tasks started from chat appear inline with Stop, answer and steer, and demote the standalone Work tab to an all-tasks list.

### G68 · Passkeys, active sessions, linked sign-in methods and native Sign in with Apple

Impact 3, effort M, area platform.

**Competitors.** ChatGPT has Advanced Account Security (passkeys, recovery keys), active sessions with per-session sign-out and security history. T3 Chat has 'View Devices'.

**Alevr today.** Partial. account-security.tsx has TOTP and 'Sign out everywhere' only, and if GET /api/account/mfa fails the row stays disabled forever. The OAuthAccountNotLinked copy promises Google linking from Settings, which doesn't exist (auth-form.tsx). iOS signs in only through ASWebAuthenticationSession.

**Approach.** Add WebAuthn passkeys (@simplewebauthn) as sign-in and second factor. Add an Active sessions list from the session store with per-row revoke (extending /api/account/sessions/revoke). Add a Sign-in methods panel to link and unlink Google and Apple via NextAuth account linking. Add error and retry states to the 2FA row. On iOS, use ASAuthorizationController for Sign in with Apple and passkeys with webcredentials associated domains.

**Needs from outside.** WebAuthn relying-party domain, apple-app-site-association webcredentials entry, and Apple Sign in with Apple service configuration.

### G69 · Answer Work approvals and questions straight from notifications

Impact 3, effort M, area agents.

**Competitors.** Codex mobile approvals (Approve, Always approve, Tell Codex what to do, Deny). ChatGPT Slack approval cards. T3 Code stacked push per thread. Alevr Code approvals already do this.

**Alevr today.** Missing for Work. Only Code remote approvals have notification actions (JunoMobileLinkApprovalResponder.swift). Work approvals and questions open the app.

**Approach.** Add a WORK_APPROVAL notification category on APNs (Allow once / Deny, with Face ID via the existing responder) and Web Push actions in public/sw.js. Post decisions to the broker with the approval digest (src/lib/work/digests.ts) so a stale action is refused. Restrict in-notification approval to non-hard-floor actions; ALWAYS_CONFIRM_ACTIONS still open the app.

**Needs from outside.** APNs (G01) and VAPID web push already configured.

### G70 · An Activity view across chats, tasks and Code: Running, Needs you, Ready, Blocked

Impact 3, effort M, area agents.

**Competitors.** ChatGPT Activity view (bell) filters by Work, Chat, Pinned and Scheduled, with Mark all as read and 'next chat needing attention'. Pets show a priority order (Needs input > Blocked > Ready > Running). Claude Code agent view groups by what needs you.

**Alevr today.** Partial. NeedsYouFold (app-sidebar.tsx) polls every 30s, is capped at 100 sessions and has no 'running' or 'all tasks' filter. Unread exists across conversations but there's no unified view or jump-to-next shortcut.

**Approach.** Build an Activity popover from the notifications inbox (src/components/notifications/*) with tabs All / Needs you / Running / Ready / Scheduled, covering chat tasks, research runs and Code sessions (shell-threads.ts). Use one priority order and the shared state words. Add Mark all read, Mod+Opt+A 'next needing attention', and live SSE instead of polling. Mirror the counts in the Mac menu bar extra and Dock badge, which already exist.

### G71 · Study mode with guided tutoring, quizzes and flashcards

Impact 3, effort M, area chat.

**Competitors.** ChatGPT Study mode (@study token), in-chat quizzes and swipeable flashcards saved to Library. Gemini Guided Learning and exam prep. Perplexity Learn step by step.

**Alevr today.** Missing as a mode. Live-UI lesson blocks exist (native renders 'Live UI lessons') but there is no study toggle, quiz or flashcard component.

**Approach.** Add a 'Study' mode token to the composer plus menu that swaps in a tutoring system-prompt section (in src/lib/chat/system-prompt.ts) that withholds answers and checks understanding. Add quiz and flashcard live-ui blocks (multiple choice with feedback; flip, mark and shuffle, with the throw physics described in ChatGPT's CSS behind motion-safe). Save decks as artifacts so they appear in Library.

### G72 · Ask several models at once and see where they agree

Impact 3, effort M, area chat.

**Competitors.** Perplexity Model Council (3 models plus a synthesis of agreement, disagreement and unique findings). T3 Code shift-click several models to race in worktrees. Cursor Build in Parallel.

**Alevr today.** Missing in chat. Code has Best-of-N in the runtime. Native NativeCompareView.swift exists with no call sites.

**Approach.** Add a 'Compare' option in model-selector.tsx (choose 2–4 models). use-chat fans out parallel turns, stored as sibling versions on the same assistant slot, then a synthesis turn from a router-picked model renders Agrees / Disagrees / Only one found, with tabs for each full answer. Show the summed per-turn cost receipt, and wire NativeCompareView to the same payload.

### G73 · Inline image results and richer source cards in search answers

Impact 3, effort M, area search.

**Competitors.** ChatGPT shows inline web images with attribution and hover previews on citations. Claude shows inline image results. Perplexity has shield trust labels with a site description and 'Rate this source'.

**Alevr today.** Partial and ahead on verification (citation-audit.tsx), but source-chip.tsx and sources-pill.tsx have no hover preview card, no image results and no domain trust context.

**Approach.** Return image results from src/lib/search/alevr and render an image strip block in markdown.tsx with source links and a lightbox. Add a hover card to source-chip.tsx (title, favicon, snippet, published date, audit status for that citation). Optionally add a domain-type label (Government, Academic, Publisher) from a curated list.

**Needs from outside.** An image search API from the existing search provider, if not already returned.

### G75 · Bring-your-own-key for Chat, with Priority and Fallback per model

Impact 3, effort M, area pricing/limits.

**Competitors.** T3 Chat BYOK per model in Priority/Fallback modes, with long-context fallback and synced encrypted keys.

**Alevr today.** Partial. BYOK (sections/connections.tsx, src/lib/code-v2/byok.ts) applies to Code only, and Remove deletes with no confirmation.

**Approach.** Let src/lib/router/decide.ts treat a user's provider key as an additional route with zero plan cost: Priority (always use the key), Fallback (when the plan limit is reached) or Off, per provider. Show 'Your key' on the Auto receipt and in TurnMeta. Add a confirm on Remove.

### G74 · True semantic retrieval with pgvector, plus project sources synced from Drive, GitHub and Notion

Impact 3, effort L, area files.

**Competitors.** ChatGPT projects accept pasted Drive or Slack links as sources. Claude Projects RAG expands capacity 10x, and Google Docs stay synced. Perplexity Projects hold 10k files.

**Alevr today.** Partial. src/lib/knowledge/rank.ts rescores lexical candidates only (no pgvector), so synonym-only matches are missed, and it falls back to lexical-only without an embedding provider. Project sources can't sync from connectors.

**Approach.** Add a vector column (pgvector) to knowledge chunks, populate it in embed.ts, and fuse ANN and lexical results with the existing RRF in retrieve.ts. Add a knowledge capacity meter to project-sources-list.tsx. Add 'Add from Drive / GitHub / Notion' sources that sync on webhook or interval through the connectors from G08 and the existing GitHub/Notion connectors.

**Needs from outside.** pgvector extension on the production Postgres.

### G76 · Spreadsheet and deck editors at full size, with presenter mode and PDF export

Impact 3, effort L, area artifacts/canvas.

**Competitors.** Claude Slides present in-app and export PPTX/PDF. ChatGPT data analysis has interactive tables. Excel in Copilot shows what changed and why.

**Alevr today.** Partial. spreadsheet-view.tsx stops silently at 400×40 (MAX_ROWS/MAX_COLS), renders without virtualization and has no range select, copy/paste or sort. There's no PDF export for document or deck artifacts (/api/artifacts/[id]/export supports docx|xlsx|pptx only).

**Approach.** Virtualize the grid (rows and columns) and remove the silent cap, with a notice for very large sheets. Add range selection, clipboard TSV copy/paste, fill handle, sort, column resize and insert/delete row, mapped to workbook ops. Add a PDF export route rendering documents and decks through headless print of the semantic views. Add a deck presenter view with speaker notes.

### G77 · Repository understanding beyond TypeScript, a persistent index and diagnostics

Impact 3, effort L, area coding.

**Competitors.** Cursor indexes codebases semantically. Claude Code ships LSP plugins and getDiagnostics in JetBrains. Codex reads IDE context.

**Alevr today.** Partial. runner/agent-core/src/repository.ts covers JS/TS only, is rebuilt on every call with no cache, and there's no LSP or diagnostics tool and no semantic search.

**Approach.** Add tree-sitter grammars (Python, Go, Rust, Swift, Java) behind the repository_map/symbols interface. Cache the index per checkpoint ref on disk in env-server and update it incrementally on file changes. Add a diagnostics tool that runs the project's typecheck or lint (detected from package.json, pyproject, Cargo) and LSP servers where available. Add optional embedding search over the index.

### G78 · User MCP servers and hooks for web, Mac env-server and cloud runs

Impact 3, effort L, area coding.

**Competitors.** Codex shares MCP config across app, CLI and IDE, with hooks GA. Claude Code has MCP with tool search and many hook events.

**Alevr today.** Partial. Only the native Studio runtime supports user MCP and hooks (JunoCodeRuntime/MCP, JunoCodeLocal/Extensibility). The env-server Alevr engine and cloud runner have none, and the web has no configuration.

**Approach.** Reuse src/lib/user-mcp.ts (already powering chat connectors) as the source of truth. Inject the user's MCP servers into env-server sessions and cloud runner-context, with per-tool approval through the existing permission rules. Add a Hooks editor in /code/customize writing .alevr/hooks.json (PreToolUse, PostToolUse, Stop), executed by agent-core with a trust-by-hash review like Codex.

### G79 · In-app PR inbox and an @alevr review bot

Impact 3, effort L, area coding.

**Competitors.** Codex Code Review plugin (inbox filters, Mark as viewed, Review with Codex, Checks > Fix). Cursor Bugbot (learns rules, autofix). Claude managed Code Review with severity markers. T3 Code review guides.

**Alevr today.** Partial. pulls-list.tsx lists PRs that only open GitHub, with no checks, review status, merge or 'start session from PR'. The webhook handles auto-fix but not review requests.

**Approach.** Turn /code/pulls into an inbox (Assigned / Authored / Team) with check and review badges, plus 'Open session on this PR' (cloud run on the PR branch) and 'Review with Alevr'. That runs a reviewer role (role-routing.ts reviewer) and posts P0/P1 findings as a GitHub review. Handle '@alevr review' and '@alevr fix' comments in src/app/api/github/webhook/route.ts, using the same untrusted-text fencing as code-autofix.ts. Read REVIEW.md rules from the base branch.

**Needs from outside.** GitHub App permissions for pull request reviews and issue comments.

### G80 · Server-rendered translations and RTL layout

Impact 3, effort L, area i18n.

**Competitors.** ChatGPT and Claude ship RTL and server-localised UI.

**Alevr today.** Partial. auto-translate.tsx swaps text after hydration (English first), runtime strings never translate, the server cache is process memory, and legal pages are French only. RTL locales are withheld (src/lib/i18n.ts:95-106) because about 447 physical directional utilities remain.

**Approach.** Precompute translations of src/lib/i18n-catalog.generated.ts per locale at build time (or persist the machine translations in Postgres) and render them server-side through a t() helper with ICU placeholders for runtime values. Codemod physical utilities (ml-/pr-/left-) to logical ones (ms-/pe-/start-) with an ESLint rule preventing regressions, then enable ar, he, fa and ur. Publish English legal pages.

**Needs from outside.** Translation review for legal pages.

### G81 · Teach by showing: record a workflow, get a skill

Impact 3, effort L, area automation.

**Competitors.** ChatGPT Record & Replay (macOS). Claude 'Record a skill' (Mac, up to 10 minutes, NEW or Update card). Grok Bot learns paths by demonstration.

**Alevr today.** Missing. capabilities.ts teach_alevr is disabled. Skills capture from a run exists (capture-skill.tsx).

**Approach.** On macOS, add a recording mode to JunoWorkAutomation using ScreenCaptureKit frames plus accessibility events (an existing tiered-control primitive), with a capture bar showing the step count and a final-minute countdown. Upload keyframes and the event log, have a model draft SKILL.md (inputs, steps, verification), and show it in the existing skill consent and editor flow. Discard video after review.

**Needs from outside.** macOS Screen Recording and Accessibility permissions (user grant).

### G82 · Reach Alevr agents from email, Slack and Teams

Impact 3, effort L, area integrations.

**Competitors.** Perplexity 'Computer in Email' (replies only to the verified sender). ChatGPT dots and @ChatGPT in Slack/Teams. Claude Tag in Slack. Copilot @mention in Teams.

**Alevr today.** Missing. capabilities.ts external_channels is disabled.

**Approach.** Add an inbound email address per user (verified sender, DKIM/SPF checks, forwarded content fenced as context) that starts a task via start_task and replies in-thread with deliverables. Add a Slack app where @Alevr in a channel or DM starts a task bound to a project, with private approval cards. Reuse src/lib/work/notify/* for outbound messages.

**Needs from outside.** Inbound email domain and MX/processing provider; Slack app and Microsoft Teams bot registration.

### G83 · Sites: custom domains, server storage and analytics for published artifacts

Impact 3, effort L, area artifacts/canvas.

**Competitors.** ChatGPT Sites (versions, custom domains, D1/R2 storage, analytics, redirects on URL change). Perplexity publishes to pplx.app or Vercel.

**Alevr today.** Partial. Artifact publishing has stable URLs, version pinning and rollback (artifact-publication.ts), and Work produces site deliverables, but there are no custom domains, storage or visitor analytics.

**Approach.** Extend artifact publication with a custom-domain record (CNAME verification), page-view and visitor counts (privacy-friendly, from share route logs), and the G30 storage bridge for published sites. Add 'Publish site' to Work site deliverables (work-site-preview.tsx).

**Needs from outside.** Edge hosting with TLS for custom domains (certificate automation).

### G84 · A browser extension with a side chat and browser control

Impact 3, effort XL, area desktop.

**Competitors.** Claude in Chrome (side panel, tab groups, scheduled shortcuts). The ChatGPT extension (tab mentions, side chat). Comet. Gemini in Chrome auto browse.

**Alevr today.** Missing. There is no browser extension. The Mac app has computer use via JunoScreenControl.

**Approach.** Build an MV3 Chrome extension: side panel chat using the existing web chat components, @tab mentions sending page text (Readability) as context, and a selection Inline Assistant. Agent control via chrome.debugger in a separate coloured tab group, with per-site Allow once / Always / Block reusing standing-grants semantics, and approvals for consequential actions. Authenticate through the Alevr session.

**Needs from outside.** Chrome Web Store developer account and review.

### G85 · Office and Google Workspace add-ins

Impact 3, effort XL, area integrations.

**Competitors.** Claude for Excel/Word/PowerPoint/Outlook and the Google Workspace add-on. ChatGPT Office add-ins (including Free). Copilot Office in Copilot.

**Alevr today.** Missing. Office export is verified (office-export.ts) but there's no in-app presence in Office or Google files.

**Approach.** Build an Office.js task-pane add-in (Excel first: cell-cited answers, edits that highlight changed cells, using the workbook formula engine for previews) and a Google Workspace add-on with the same chat panel. Show an approval card per edit by default.

**Needs from outside.** Microsoft Partner Center/AppSource listing; Google Workspace Marketplace listing and OAuth verification.

### G86 · One accent list and a presence token across web and native

Impact 2, effort S, area design.

**Competitors.** ChatGPT desktop themes sync (accent, background, foreground) and can be imported or shared. T3 Code imports VS Code themes.

**Alevr today.** Drift. Ultramarine is offered on web (src/lib/accents.ts) but missing from scripts/generate-design-tokens.ts ACCENTS and JunoAccent.swift, so it falls back to Graphite natively. Presence blue #2d49c9/#97a6e6 is hand-typed in 12+ files and four scoped variables.

**Approach.** Add ultramarine to the generator ACCENTS and JunoAccent. Add --presence/--presence-ink tokens in globals.css, generated to Swift and TS, and replace --rf-/--mem-/--sx-/--pj-presence and the literals in galaxy-mark.tsx, thinking-mark.css and editorial.css. Have the design:tokens:check job also check accent list parity.

### G87 · Ship Inter's Cyrillic and extended-Latin subsets

Impact 2, effort S, area design.

**Competitors.** ChatGPT uses system fonts. Claude ships Anthropic Sans across its locales.

**Alevr today.** Partial. src/app/layout.tsx loads inter-latin only, while ru, uk, vi, pl and tr are offered, so their UI falls back to system-ui.

**Approach.** Add latin-ext, cyrillic, cyrillic-ext and vietnamese woff2 subsets to localFont with unicode-range descriptors so only the needed files download.

### G88 · Keep Best-of-N winners, and undo cloud turns

Impact 2, effort S, area coding.

**Competitors.** Codex Best-of-N. Cursor Build in Parallel. Codex worktree snapshots and restore.

**Alevr today.** Stubbed. The dock.tsx:723 'Keep A' button calls actions.keepCandidate, which live-route never sets. Cloud runs have no Undo despite useCodeSession.requestRollback and /api/code/tasks/[id]/rollback.

**Approach.** Wire keepCandidate to merge the chosen worktree branch (env git.merge on Mac, a cloud follow-up on the candidate branch) and archive the others. Wire cloud rollback in live-route.tsx:300 through requestRollback, and offer 'Redo' from the saved pre-rollback ref.

### G89 · Help, feedback, release notes and status in the account menu

Impact 2, effort S, area platform.

**Competitors.** ChatGPT has the Privacy Center and Help in the account menu. Codex has /feedback. T3 Chat has a status page and a feedback board.

**Alevr today.** Missing. user-menu.tsx has none. /roadmap is reachable only from the command palette and marketing chrome.

**Approach.** Add Help center, Send feedback (dialog posting a conversation id and screenshot, optional), What's new (release notes from the announcements model) and Status (a public status page) to user-menu.tsx. Add a /feedback slash command in chat and Code.

**Needs from outside.** A public status page provider or self-hosted status page.

### G90 · Readable memory export and a ready-made import prompt

Impact 2, effort S, area memory.

**Competitors.** Claude memory import with a ready-made export prompt and 'See what Claude learned about you'. Gemini imports a preferences summary.

**Alevr today.** Partial. Import is injection-safe (memory-import.ts), but export is raw JSON named juno-memory-… (use-memory.ts:599).

**Approach.** Add 'Export as Markdown' grouped by topic. Add a 'Copy prompt for another assistant' button in import-dialog.tsx that the user runs in ChatGPT/Claude/Gemini, then pastes back. After import, offer 'Review what Alevr learned', which opens a chat seeded with the imported entries.

### G91 · Personality characteristic dials

Impact 2, effort S, area settings.

**Competitors.** ChatGPT characteristics (warmth, enthusiasm, headers and lists, emoji: more/default/less) on top of presets. Claude styles and skills for tone.

**Alevr today.** Partial. personalization.tsx has 6 personalities and instructions, but no fine dials.

**Approach.** Add four tri-state rows (Warmth, Enthusiasm, Headers and lists, Emoji) to personalization.tsx stored on the user, and append matching guidance in system-prompt.ts after the personality block. Show a live sample reply preview.

### G92 · Full-screen prompt editor on iPhone

Impact 2, effort S, area mobile/native.

**Competitors.** ChatGPT has an expand control for long prompts. Codex mobile has a full-screen prompt editor.

**Alevr today.** Partial. JunoMobileComposer.swift:446-447 caps growth at 6 lines.

**Approach.** Add an expand glyph once the field reaches its cap, presenting a full-screen sheet editor that keeps attachments and chips, and returns to the composer on Done.

### G93 · Rebindable shortcuts and the missing ones

Impact 2, effort M, area settings.

**Competitors.** ChatGPT desktop rebinds every shortcut with key-combo search. T3 Chat has a recorder UI. T3 Code uses VS Code-style when-clauses.

**Alevr today.** Partial. Only the send key is configurable (preferences.tsx KeyboardSection). There are no shortcuts for delete chat, incognito, regenerate or the model picker, and Mod+Shift+L (theme) collides with Safari.

**Approach.** Make src/lib/shortcut-groups.ts the registry with user overrides stored in ui-prefs, add a recorder UI with conflict detection and reset per item, and add Mod+/ model picker (moving the shortcut sheet to Mod+?), Mod+Shift+Backspace delete chat, Mod+Shift+N incognito and Mod+Shift+R regenerate. Move theme off Mod+Shift+L.

### G94 · Per-chat export and bulk sidebar actions

Impact 2, effort M, area projects.

**Competitors.** T3 Chat multi-select bulk Pin/Archive/Export/Move/Delete and export as JSON/Markdown/PDF. Perplexity History bulk delete.

**Alevr today.** Missing. app-sidebar.tsx has no multi-select, and only account-wide export exists (data-privacy.tsx).

**Approach.** Add a Select mode in app-sidebar.tsx (shift-click ranges) with Archive, Move to project, Export (Markdown/PDF zip) and Delete, all with Undo toasts. Add 'Export chat' (Markdown/PDF) to the conversation More menu using the transcript serializer.

### G95 · Ghost-text next-prompt suggestions in Code

Impact 2, effort M, area coding.

**Competitors.** Claude Code suggested next prompt (Tab accepts, first suggestion from git history). Codex Composer Predictions (Tab accepts, never auto-sends).

**Alevr today.** Missing in Code. Chat has follow-up suggestions (follow-up-suggestions.tsx).

**Approach.** After a settled turn, request a cheap prediction against the prompt cache (skipped when cold or near limits) and render it as ghost text in the v2 composer. Tab accepts as an editable draft, typing dismisses. Back off after repeated ignores and add a setting.

### G96 · iPad multi-window, and system-wide screen share in iOS voice

Impact 2, effort M, area mobile/native.

**Competitors.** ChatGPT has a pop-out 'Always on top' chat. Gemini Live shares the screen on iOS and Android.

**Alevr today.** Partial. Info.plist has no UIApplicationSceneManifest (no multiple windows). JunoMobileVoiceCamera.swift:129-160 uses in-app RPScreenRecorder, so only Alevr's own UI can be shared.

**Approach.** Enable multiple scenes with a per-scene conversation id and 'Open in new window' on chat rows. Add a Broadcast Upload extension that streams frames into the realtime voice session through the App Group, started from an RPSystemBroadcastPickerView in the voice controls.

**Needs from outside.** App Group entitlement for the broadcast extension.

### G97 · Rooms, templates and roster actions you can find

Impact 2, effort M, area agents.

**Competitors.** ChatGPT dots have a customisable identity and are created in a few taps. Grok Bot is set up by sending one message. Cursor Projects have a New Project flow.

**Alevr today.** Partial. Rooms can only be created by asking the model (src/lib/chat/room-tools.ts). Templates are hidden at /agents/new?form=1. The roster menu has only Pin and Pause, and failures are silent (agents-home.tsx).

**Approach.** Add 'New room' (members picker over existing agents, purpose) and a template gallery on agents-home.tsx from src/lib/agents/templates.ts. Add Duplicate and Delete (APIs exist) and error toasts to the roster menu. Show a per-member drill-in for team runs in work-run-panel.tsx (team-activity.tsx).

### G98 · Live camera in web voice mode

Impact 2, effort M, area voice.

**Competitors.** ChatGPT Advanced voice video on mobile. Gemini Live camera sharing with live cards. Copilot Vision.

**Alevr today.** Partial. use-realtime-voice.ts supports screen share and image frames on web and camera on iOS, but there's no live camera on web.

**Approach.** Add a camera toggle to realtime-voice.tsx that samples getUserMedia video frames at the provider's accepted rate (reusing the image-frame path), with a front/back switch on mobile web and a small self-view.


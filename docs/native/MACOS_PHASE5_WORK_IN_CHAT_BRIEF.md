# Phase 5, the rest: Work merged into Chat (brief)

Written 2026-09-25 for track A (worktree `/Users/liammagnier/Developer/project/juno-glass`, branch `mac/liquid-glass-chat`). It specifies the four stages that finish Phase 5 after the minimal slice (`786c7bd6` API, `da512b74` composer, `a709617f` run card) and the shared foundations (`22436463`). Each stage builds, passes and commits on its own.

**Precedence.** Where this brief and the redesign spec disagree, this brief wins for §2.5, §5.4–§5.9, §6.8, §6.9, §7.8, §7.10, §7.11, §11 Phase 5 and A5. The same decisions are recorded in the spec's new "Phase 5 errata" section and register #53–#67, so later readers of the spec see them too. The parity target is the live web on `origin/main` at **`fe0a501d`** (2026-09-24 17:55). Where today's web and the spec differ, the web wins and the decision is recorded.

Research behind this brief: `.phase5-research/{web-work,web-research,mac-work,mac-shell}.md` (gitignored, read at `7f92324f` / `39a35eba`), re-verified here against `fe0a501d` and the branch's HEAD `1e87aa73`. Line numbers below are from those two trees; prefer the symbol names, which survive edits.

---

## 0. Today's web, re-verified on `origin/main` (`fe0a501d`)

### 0.1 How a task the model starts reaches the client

There is no task switch anywhere on the web. The chat model decides, through a server-side tool, and the client only says it can draw the result.

1. **The client opts in.** `use-chat.ts:1315` sends `workHandoff: opts.privateMode ? undefined : true` on every saved-chat `POST /api/chat` (schema `src/lib/chat/request.ts:161`, type `src/types/chat.ts:425-426`). Private chats never send it.
2. **The server decides whether the model may.** `route.ts:2291-2313` builds `taskGate`, and `chatTaskToolEnabled` (`src/lib/chat/task-tool.ts:158-175`) requires all of: `workHandoff === true`; not private, not voice, not a regenerate; a persisted user message id; no research running and no artifact edit; `conversation.kind === "chat"`; a model with agentic tools whose function tools actually reach it; the applied skill permits `start_task`; lockdown off; and a Work-capable model on the plan. The same flag adds the prompt's "# Tasks" section (`src/lib/chat/system-prompt.ts:57-72`: "You decide; the user has no switch for this").
3. **The model calls `start_task {title, goal, deliverable?}`.** The server runs it in process (`createStartTaskTool`, wired at `route.ts:3013-3047`). The reply's run carries activity rows: "Starting a task" (detail: the title), ending "Started a task" or "Task not started". The Mac already has these phrases (`NativeRunPresentation.swift`).
4. **Sometimes a person must agree first.** When the turn carries untrusted content (any attachment, connectors, web search, research, project files, an untrusted skill, the documents tool) or the estimate is at least $0.50, the stream sends the activity row "Starting a task needs your approval" and `{type:"approval", approval}` with `connectorId: "juno_work"`, `toolName: "start_task"`, `callId: "chat-task-approval:{userMessageId}"` and `detail {title, estimate: "about $X.XX", goal}`. It is answered with `POST /api/approvals/{id} {decision: "allow_once" | "deny", receiptDigest}`. The Mac already draws this card (`ApprovalCard.swift`, `isTask`).
5. **The session.** Created server-side as a draft, then started: `conversationId`, the conversation's `projectId`, the title, `requestedTarget: "automatic"`, the conversation's model, `permissionPolicy` = the agent's `approvalMode` in an agent's thread, otherwise `"balanced"`; the id is deterministic (`wsi_` + sha256 of the user and `chat-task:{userMessageId}`), so a retried turn cannot start a second task. In an agent's thread the session is stamped with `agentId` (`task-tool.ts:660-668`). **One live task per conversation:** a second start while one is live is refused with the sentence `A task from this conversation is already running: "<title>". Let it finish or stop it before starting another. Nothing new was started.`
6. **The frame.** Once the session leaves `draft`, the stream sends **`{type: "work", session: ClientWorkSession}`**, at most once per generation (`route.ts:3040-3046`, `onStarted`). `ClientWorkSession` (`src/lib/work/serializers.ts:203-222`) is `id, projectId, conversationId, title, titleSource, goal, status, needsAttention, requestedTarget, preferredHostId, requestedModel, reasoningEffort, permissionPolicy, pinned, archived, lastActivityAt, createdAt, updatedAt`. It has no `agentId`; the agent is found through the conversation (`Conversation.agentId`, the roster's `conversationID`).
7. **The client adopts it.** `use-chat.ts:603` `case "work"` calls `onWorkStarted`; `chat-view.tsx:421-425` hands the session to `useConversationWork.adopt` and fires `juno:work-sync` (the sidebar refetches).
8. **The model's own reply** is one short sentence (the tool result tells it to).
9. **Handoffs do not announce.** An agent can hand a task to a teammate (`hand_off_to_teammate`, `src/lib/chat/handoff-tool.ts`) behind the same approval card; that task lives in the teammate's thread, so no `work` frame is sent in this one.

The Mac today drops the frame (`NativeChatAPIClient.decodedFrameTypes` has no `"work"`) and never sends `workHandoff`, so tasks the model starts never appear on the Mac. The slice's composer toggle instead calls the Work API directly, which the web no longer does.

### 0.2 What the web composer no longer has

Removed in `19941547` (2026-09-22) and still absent at `fe0a501d`: the "Do this as a task" row, "How often it asks" in the `+` menu, the "Task" armed mark, the disclosure line under the field and the "Run it as a task?" offer. "How often it asks" survives only as a **project** default (Project › Settings › Task defaults, `project-work-defaults.tsx`), which never offers "Just do it". The `+` menu's research row is now plain "Research" (no levels).

### 0.3 Following and drawing the task

- **One follower per open chat** (`use-conversation-work.ts`): discovery `GET /api/work/sessions?limit=1&conversationId={id}` every 4s (not visibility-gated); then the run's SSE `GET /api/work/sessions/{id}/events?after={seq}` (frames `snapshot | events | done`, the server closes at 4 minutes and the client reconnects at once, errors back off 1s × n to 15s, a new run id resets the cursor). Drafts are never adopted.
- **One task drawn, the newest.** The file says so as a stated limitation (lines 63-71): a finished task has no one-shot read on the web. Main has since given the native apps one: `NativeWorkClient.snapshot(sessionID:for:)` reads the stream's first frame and lets go.
- **Placement** (`message-list.tsx:118-126`): after the assistant reply that follows the last user message created at or before `session.createdAt`.
- **The panel** (`work-run-panel.tsx`): `rounded-panel border bg-card p-2`, flat. Header: a Workflow glyph with "Task" (caption, muted), the title (`text-body` medium, two lines), then the status pill and `statusSentence(status, actor)`; an outline "Stop" (`aria-label` "Stop the task") while the run is not finished. In an agent's thread a sentence that opens with "Juno" is re-voiced with the agent's name (`work-vocabulary.tsx:162-171`). Live body: current action, Plan with a `done/total` tally and a checklist, the Elapsed · Cost · Tokens meter, the newest three turns ("Earlier updates n" behind a toggle), then questions and the approval queue. Finished body: terminal detail, degradation notes, the outcome digest, the turns, the newest previewable deliverable with Download, "Save this as a skill", the meter. There is no pause, resume or retry in chat.

### 0.4 Steering through the composer (`chat-view.tsx:1805-1860`, `composer.tsx`)

- **Task:** `standalone: true`; placeholder "Answer Juno’s question…" (a question is open) or "Add an instruction to the running task…"; send label "Answer the task’s question" or "Add this to the running task"; stop label "Stop generating" while a reply streams, otherwise "Stop the task"; above the field, the pending steers; send routes to answer or steer and clears the draft only when the server accepts.
- **Research** (wins while its run is accepting input; not standalone, so only while the chat is busy): placeholder "Add a constraint, or paste a source to include…"; send "Add to the research"; stop "Stop the research"; toasts "Added to this research run" or the run's notice or "That could not be added to the run.". Stop cancels the run, then the stream.
- **Stop** otherwise: a streaming reply wins; with no stream, Stop ends the task (`control cancel`).
- **Steer mode** = steering active and (busy or standalone), not while the clarify check runs or a clarification is pending. Text only; the mic is hidden. The placeholder is blank while a mark is armed.
- **Composer mode** (`delegation.ts:45-61`): an open question gives answer **even on a finished run** (a defect: `/answer` refuses it, and the empty-field Stop then cancels a finished run). Otherwise finished, draft or none gives no steering; everything else steers.

### 0.5 Agents in chat (`docs/design/AGENTS.md` §3, §5.3, §8 at `fe0a501d`)

- **An agent is a teammate that lives in Chat.** Its thread is an ordinary chat (`Conversation.agentId`, kind stays `chat`); its tasks are ordinary Work sessions started by the same `start_task` and drawn by the same panel; approvals are the same cards.
- **Sidebar:** the "Agents" destination row after Artifacts (Library · Projects · Artifacts · Agents; the Design row is gone), and an **Agents fold** below the Needs-you fold and above Pinned projects: one row per agent with its live face, the name, and one trailing signal, the needs-you dot while it waits; sorted waiting-first; a "New agent" `+` on the header; hidden while the Needs-you filter is on (`app-sidebar.tsx:1344-1380`, `AgentRow` `:2682`).
- **The thread:** one header row above the transcript (face `sm`, name, state sentence or the task title, "Agent page"); the empty thread greets "Hi, I’m *{name}*." with "{role}. What should I take on?" (or the paused line); the composer's placeholder is "Message {name}…"; voice speaks as the agent.
- **Handoff card:** `hand_off_to_teammate` reuses the task approval card with its own copy ("Hand this to a teammate?", "To {teammate}", "Don’t hand off" / "Hand off").
- **No @-mentions of agents.** The composer's `@` rows are tools and apps (`@search`, `@research`, connectors), `composer.tsx:1729-1760`.

### 0.6 Signals

- **Needs you** (`app-sidebar.tsx:621-700, 1317-1348, 1684-1740`): the sidebar polls `GET /api/work/sessions?limit=100` every 30s while visible and on `juno:work-sync`; the newest session per conversation by `lastActivityAt`; a row carries a toned dot while its run is open (`workRunIsOpen`), none once finished; the fold holds the conversations whose run needs the person (`workRunNeedsYou`: `needsAttention` or `waiting_input`, `waiting_approval`, `host_offline`), sits above everything, and its header "Needs you · N" filters the column in place ("Show only these" / "Show everything"), letting go at zero. A live region reads "Nothing is waiting on you." or "N run(s) is/are waiting on you.".
- **A rise** (`use-needs-you-count.ts:195-230`, `notifications.ts:238-244`): a toast "A task needs you" / "N tasks need you" (plus " — T in total" when some were already waiting) with "Open the task to answer it.", and, if the browser already granted permission, a system notification with the same sentence, body "Open Juno to answer it.", tag `juno-work-needs-you`. The web never prompts for permission here.
- **The inbox** (new since the last merge): a **Notifications** row right after New chat and Search, opening a 384pt popover ("Notifications", "Mark all as read", rows with an agent face or the Juno mark, "Show earlier", empty "Nothing new"). Its one signal is a dot, never a count: the accent while something unread is pressing (urgent or high), muted otherwise. The server writes an in-app notification for every Work run and agent task and pushes to iPhone (APNs), browsers (Web Push) and nothing yet to the Mac (APNs there waits for a Developer ID push profile). ⌘K has "Open notifications".

### 0.7 What main added to the native apps since this branch's last merge (`e5501f65..fe0a501d`)

Three commits, 145 files. The ones this track must carry:
- **Mac:** one notification delegate on the app delegate (`JunoDesktopApp.swift`) that turns a click into a `JunoNotificationRoute` (`.agent`, `.conversation`, `.workSession`) and hands anything else to Code's `StudioRunMonitor`; APNs registration through `NativePushRegistrar`; `DesktopAgentAlerts` (a local "{name} needs you" banner while Juno is not in front, behind the "When something needs you" switch); authorization asked when the first agent arrives; `DesktopWorkbenchRegistry.requestRoute`; the Agents fold in the old sidebar; the agent's thread header above the transcript; `DesktopSidebarItem.agent` and `@SceneStorage("juno.desktop.agent")`; Settings › "Notifications on this Mac" (two switches, permission status, Allow / Open System Settings); `.workSession` routes that switch the window to the old Work product.
- **Packages:** `JunoCore/Notifications/JunoNotificationRoute.swift`; `JunoSync/Push/{NativePushRegistrar,NativePushTokenClient,NativePushAuthorization}.swift`; `JunoWorkKit/Views/NativeWorkGateCards.swift` (the agent page's approval and question cards); `NativeWorkClient.snapshot(sessionID:for:)`; `NativeWorkModel.pendingQuestion(in:)`; the Agents model and views (gates, thread header).
- **Contract:** `/notifications`, `/notifications/count`, `/notifications/{id}`, `/devices/apns`, the Agents routes.
- **Icons:** the web's `notifications` glyph is Phosphor `BellSimple` (`app-icons.ts`); main's icon script draws iOS `nav-agents` from the web's face numbers.

Stage A starts by merging this.

---

## 1. Decisions

Parity decisions follow the web and go into the spec's "Phase 5 errata". Deliberate differences go into the register (§0.8 of the spec) with the number shown.

| # | Decision | Why | Recorded |
|---|---|---|---|
| 1 | **The model starts tasks.** The Mac sends `workHandoff: true` on saved chats and decodes the `work` frame. The slice's "Do This as a Task" row, the Task mark, the "Start this as a task" face and `ChatComposer.dispatchTask` are removed. | §0.1, §0.2. The follow-up of 2026-09-24 asked for exactly this. | Errata |
| 2 | **No "How Often It Asks" in the composer.** It becomes a project default (Projects › Settings › Task defaults), built by track B with Projects. | §0.2 | Errata; handed to track B |
| 3 | **No disclosure line and no delegation offer.** | §0.2 | Errata |
| 4 | **Errands open an ordinary chat** (Quick Entry, the menu-bar extra, `requestWorkErrand`), prompt pre-filled. Nothing is armed; the model decides. | The web has no switch to arm. | Errata (§1.7, §7.10) |
| 5 | **The card is placed after the reply that follows its turn**, by the web's rule. | §0.3 | Errata |
| 6 | **Earlier tasks in the same chat stay visible** as one-line rows at their own place, opening the Task panel from a one-shot read; the newest task is the full live card. | The web's limit is stated, not designed, and main added the one-shot read the web lacked. Phase 5's scope includes several tasks per conversation. | Register #53 |
| 7 | **A finished run never keeps the composer in answer mode.** | The web's mode is a defect (§0.4): its send is refused and its Stop cancels a finished run. | Register #54 |
| 8 | **Research steering joins task steering** in the composer, with the web's words. Stop cancels the run, then the stream. | §0.4; closes stage 4b's follow-up "no `/steer`". | Errata |
| 9 | **The live step is a neutral tile led by the chat's run signature;** finished plan steps are marked in neutral ink. | Accent budget (§0.4 of the spec): coral is not a step colour. The run signature is the Mac's one "working" language since Phase 2. | Register #55 |
| 10 | **Labels the web sets in mono are SF 11** (the pending-steers header, "Waiting on you · asked …", "Your decision", "never finished"). Numbers, durations, costs, ids and parameters stay mono. | §10.2 rule 6; extends #39/#40. | Register #56 |
| 11 | **The card's header has the web's Stop, and an overflow menu** with Pause / Resume / Try Again / Show Details. | A5 keeps Pause, Resume and Try Again on the Mac; the web has none in chat. | Register #57 |
| 12 | **Deliverables are Quick Look tiles for every file**, with Save As…; the digest's pointer to "Outputs" becomes "Details". | The web's "Outputs" pointer is dangling in chat (web-work §11.3). | Register #58 |
| 13 | **A Task panel in the trailing dock** (Activity · Files · Details). | A5: "Details (Activity, Files & Cost)". The web retired the task page. | Register #59 |
| 14 | **In an approval queue, only the first answerable card's verb is prominent.** | One prominent button per surface. | Register #60 |
| 15 | **Task approvals take the web's copy:** Don’t · Change it · {Verb} · More ▾ ("{Verb}, and Stop Asking"), the batch button "{Verb} — all N" / "Allow all N". | Web `approvals/approval-card.tsx`, `approval-queue.tsx`. The spec's "Make all N changes" is not the web's. | Errata |
| 16 | **Handoff approval card** for `hand_off_to_teammate`, the web's copy. | §0.5 | Errata |
| 17 | **Needs-you fold, row dots and the Agents fold follow the web's order and rules.** Row help reads "{title}: {sentence}". | §0.5, §0.6 | Errata |
| 18 | **A Notifications row and popover** (the web's inbox), without the web's "Get notified on this browser". | §0.6; the Mac's switches are in Settings (main). | Errata; register #62 |
| 19 | **A rise in tasks needing you** posts the web's toast in front, and a local notification when Juno is not in front; the Dock badge and the menu-bar count carry the number. | §0.6 and spec §7.10–§7.11. The web has no Dock or menu bar. | Register #61 |
| 20 | **A `/work/{id}` route opens its task's chat.** | The web redirects `/work/{sessionId}` to `/chat/{conversationId}`. | Errata |
| 21 | **Tasks without a conversation** (started in the old Work window) open in a sheet from Search › Tasks or from a notification, with questions and approvals still answerable. | Spec §11 Phase 5 step 7 keeps them reachable; the web redirects them to an empty chat. | Register #63 |
| 22 | **Discovery polls only while the window is visible.** | The web polls every open chat every 4s regardless (web-work §11.7). | Register #64 |
| 23 | **The research report opens in its own window.** | Spec §6.8; the web opens a dialog. | Register #65 |
| 24 | **Skill instructions are edited in SF**, not mono. | They are prose, not code (rule 6). | Register #66 |
| 25 | **A task approval carries a hairline in its risk tone**, no warning wash. | Extends #35. | Register #67 |
| 26 | **No agent @-mentions.** The Phase 4 `/` and `@` palette mirrors the web's tool and app rows only. | §0.5 | Errata |

---

## 2. Rules every stage follows

### 2.1 Work rules

- Worktree `/Users/liammagnier/Developer/project/juno-glass`, branch `mac/liquid-glass-chat`. Absolute paths; `cd … && …` in every Bash call; the shell is zsh. Long builds and suites run in the background and are polled.
- Build, test and gates (derived data under `/tmp/jgA-*`):
  ```sh
  cd /Users/liammagnier/Developer/project/juno-glass
  # Mac build; add `-only-testing:JunoDesktopTests test` for the unit tests (never the UITests target)
  xcodebuild -project native/macOS/JunoDesktop/JunoDesktop.xcodeproj -scheme JunoDesktop -configuration Debug \
    -destination 'platform=macOS' -derivedDataPath /tmp/jgA-mac CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= build
  # iOS (run native/Scripts/generate-projects.sh first if the checked-in project is stale)
  xcodebuild -project native/iOS/JunoMobile/JunoMobile.xcodeproj -scheme JunoMobile \
    -destination 'generic/platform=iOS Simulator' -derivedDataPath /tmp/jgA-ios CODE_SIGNING_ALLOWED=NO build
  # Packages (+ JunoWork / JunoCode when touched; rerun JunoAuthTests alone if the full run hangs)
  JUNO_SWIFT_SCRATCH=/tmp/jgA-swift npm run native:test JunoNativeKit
  # Contracts and gates
  npm run native:contract:check && npm run capabilities:check && npm run work:contract:check
  npm run design:tokens:check && npm run native:icons:check && npm run native:design:check && npm run native:design:type \
    && npm run native:design:motion && npm run native:design:glass && npm run native:design:targets
  ```
  New or removed app files: `native/Scripts/generate-projects.sh`.
- Never push, never deploy, never download. Commit only a green tree, with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Keep iOS and Juno Code compiling. Shared-package changes are additive or default-off for iOS (the phone does not draw the task card, so it must not claim `workHandoff`). Code files take mechanical changes only.
- Don't change behaviour outside the stage. Never delete user-data paths (the Work grant store, the undo ledger, caches purged on sign-out stay as they are).

### 2.2 Design law for these surfaces

- **Opaque content.** The task card, settled rows, question and approval tiles, the Task panel's content, the recap card, the notifications popover's rows and the legacy task sheet are opaque on the warm canvas. Glass stays on the composer shell, the ⌘K panel, the find bar, the toast host, Quick Entry and Scroll to latest. No glass inside sheets or popovers.
- **Accent (coral) budget:** the send/stop disc, switches, links and accent text ("Agent page"), the live dot on a running pill and a live row dot, the needs-you dot (agents, the inbox's pressing dot), and **one** prominent button per surface (`.buttonStyle(.junoProminent)`, never raw `.borderedProminent`, never system blue). Everything else is neutral: outline buttons take `.bordered` with `.tint(nil)`; a refusal takes the destructive ink, not a fill.
- **Radii:** control 10 · field 12 · menu 14 · card 16 · panel 20, concentric inside a card: the task card is 20 with an 8pt inset, so its inner tiles are 12.
- **Type rungs** (SF unless noted): title 15 medium (the card's title; `body` rung), section 13 medium ("Plan", "Queued"), body 13 or the 15 reading rung for the run's own words, caption 11–12 secondary. Mono (SF Mono) only for counts, costs, durations, ids and parameter values. No uppercase, no letter-spaced micro-labels, no eyebrow above the card beyond the web's own "Task".
- **Targets:** every pointer control is at least 28pt (`native:design:targets`).
- **Copy:** web copy verbatim outside native menus, including its curly apostrophes (’) and its dashes; Title Case in native menus ("Show Details", "Pause", "{Verb}, and Stop Asking"). New Mac-only copy is plain, has no em dash, and is listed for review in Appendix A.
- **Symbols:** Phosphor `ph.*` and `juno.*` only. Missing ones (at least `ph.bellsimple`, `ph.arrowelbowdownright`, `ph.timer`, `ph.coins`, `ph.sigma`, `ph.stop.fill` if absent) are added through `scripts/generate-native-icons.mjs` from the web registries, then `npm run native:icons` and `native:icons:check`.
- **Motion:** new pieces enter with the card's rise-in (4pt, `outSoft` 220ms) and leave on `in` 160ms; loops (the live dot, the run signature) go static under Reduce Motion, and only one thing on screen owns the loop (the Phase 2 rule).
- **Accessibility:** `.help` and an accessibility label on every icon-only control; the card is an `.accessibilityElement(children: .contain)` with the title as a heading; status dots pair with a glyph under Differentiate Without Color; counts that change are announced (`AccessibilityNotification.Announcement`), never polled into VoiceOver.
- **Crash rules:** one `NavigationSplitView` per window (the report window uses a plain `HStack`); every popover has an explicit frame; toolbar items are declared once and disable rather than vanish; the dock is plain layout, never `.inspector`.

### 2.3 The design skills, applied

The owner asked for `swiftui-design-skill` and `design-taste-frontend`. Invoke both before designing. What they add here:
- **5-Dimension Review.** Score every surface you build on Philosophy, Hierarchy, Craft, Functionality and Originality (1–10) from its offscreen snapshot, in both appearances. Fix anything under 7 before committing, and write the scores into the stage's commit body.
- **Three-level hierarchy** on every surface (the rungs in §2.2), and **one signature detail per surface**, named in each stage below. Nothing else on that surface competes with it.
- **One accent, one radius system, full states:** every new surface has its loading, empty and error state (skeleton rows, not spinners, where a list loads).
- **Contrast:** button labels and field text at WCAG AA; `junoTertiaryInk` only for 13pt and larger non-essential text.
- **No decorative dots:** a dot always means a real state (a live run, a run that needs you, an unread notification).
- **No fake precision:** fixtures use plausible, unround figures, and the UI never invents a number the server did not send.
- **Copy self-audit** before each commit: read every visible string you added or moved; web strings must match the web byte for byte, and new strings must be plain.

### 2.4 Snapshots

Add fixtures for everything you build to the offscreen harness (`native/macOS/JunoDesktop/Tests/Snapshots`), render into `/tmp/juno-glass-snapshots/phase5-<stage>/` (`TEST_RUNNER_JUNO_SNAPSHOT_DIR`) and, for window compositions, `/tmp/juno-glass-snapshots/phase5-<stage>/final/` (`TEST_RUNNER_JUNO_FINAL_SNAPSHOT_DIR`). Light and dark. **Look at every PNG with the Read tool** and fix what looks wrong before committing. Glass cannot be drawn offscreen; the composer uses its Reduce Transparency recipe, as before. No screen capture or control.

---

## 3. Stage A: merge main, then model-started tasks, placement, several tasks, steering

Two commits: **A0** (the merge) and **A1–A7** (the stage).

### A0. Merge `origin/main` (`fe0a501d`)

Merge, don't rebase. Regenerate generated files instead of hand-merging them: `npm run design:tokens`, the Swift contract generator (`scripts/generate-native-swift-contract.mjs`), `npm run native:icons`, `native/Scripts/generate-projects.sh`. Then settle the conflicts this way:

| File | Resolution |
|---|---|
| `scripts/generate-native-icons.mjs` | Keep the branch's data-driven generator (it reads `src/components/ui/juno-glyph-paths.ts`). Main's `DRAWN` / `readGlyphConstant` reads constants out of `juno-glyphs.tsx`, which the branch moved. Carry main's intent only: the iOS `nav-agents` asset is the web's face, drawn from the `agents` entry in `juno-glyph-paths.ts`. Add `bell` (Phosphor `BellSimple`, the web's `AppIcons.notifications`) now, since Stage C needs it. `native:icons:check` must pass. |
| `App/DesktopChatSidebar.swift` | The branch's rewrite wins. Port main's Agents fold into it (the `agentsModel` and `messageAgent` inputs, `@AppStorage("juno.desktop.sidebar.agents.collapsed")`, `agentRow`) as a `Section(isExpanded:)` after the Needs-you section and before Pinned projects (the web's order, §0.5). Stage C restyles it. |
| `App/DesktopChatWorkspace.swift`, `App/ChatDetail.swift`, `App/DesktopNavigationState.swift` | Port `DesktopSidebarItem.agent(String)`, `@SceneStorage("juno.desktop.agent")`, `selectedAgentID` and `agentSelection` into the branch's navigation. Selecting an agent row opens the Agents destination with that agent pushed on the page's `NavigationStack` (the foundations made Agents push). Port `openThread`, `messageAgent`, `followPendingRoute` and the thread header (`NativeAgentThreadHeader` in a row above the transcript, at the reading measure, over a 1pt `junoHairline`). Main's `DesktopNavigationStateTests` must pass. |
| `App/JunoDesktopWorkspaceView.swift` | The branch has no Work product. Routes `.agent` and `.conversation` go to Chat as on main. **`.workSession(id)`** looks the session up (`NativeWorkModel.sessions`, refreshing once if it is missing) and opens its `conversationID` in Chat; a session with no conversation opens the legacy window until Stage D replaces that with the task sheet. Drop main's `juno.desktop.work.selection` / `juno.desktop.work.page` writes except where the legacy window still needs them. |
| `App/JunoDesktopApp.swift` | Take main's app delegate whole: the notification-center delegate, APNs registration, `openRoute`. Keep the branch's scenes. |
| `App/JunoDesktopRootView.swift` | Take main's `NativePushRegistrar` start/stop, the first-agent authorization request and `DesktopAgentAlerts`. |
| `App/DesktopAccountScreens.swift` | Main's destination plumbing for the agent page: the `selectedAgentID` binding, `openAgent` from the thread header, and `localApprovals` / `decideLocally` handed to the agent page so a run on this Mac can be answered there. Port it into the branch's `DesktopDestinationView.routed` (the agent is pushed on the Agents stack, not swapped in place). |
| `App/DesktopSettingsScreen.swift` | Put main's "Notifications on this Mac" section into the branch's Settings window with the web's (main's) words verbatim; switches are `Toggle`s; "Allow" and "Open System Settings" are `.bordered` with `.tint(nil)`. Phase 3 restyles Settings later. |
| `App/DesktopVoice.swift`, `App/DesktopWorkbenchRegistry.swift` | Take main's persona and `requestRoute` additions. Keep the branch's `requestWorkErrand` routing to `.newChat`. |
| JunoWorkKit Agents views (main) | Must compile and pass the gates: any new `.borderedProminent` becomes `.buttonStyle(.junoProminent)`; any new glass in content becomes opaque. |

Build, test (JunoDesktopTests, JunoNativeKit including main's new `JunoNotificationRouteTests`, `NativePushRegistrarTests`, `NativeAgentsGateTests`), iOS build, all gates. If the glass, targets or prominent counts fall, re-record the baseline at the new, lower number; if they rise, fix the sites. Commit: "Merge origin/main: notifications end to end, inbox, native push, agent fold and handoff".

### A1. The wire: `workHandoff` and the `work` frame

- **`JunoChatKit/NativeChatAPIClient.swift`:** add `workHandoff: Bool?` to `GenerationRequestWire` and set it where the saved-chat body is built. The private body and Compare never carry it.
- **Opt-in per app.** `NativeConversationStore` gains `claimsWorkHandoff: Bool` (default `false`). `JunoDesktopConfiguration` sets it `true`. iOS stays `false` until the phone draws the card.
- **Decode the frame.** Add `"work"` to `decodedFrameTypes`, a `case work(NativeChatWorkStart)` to `NativeChatServerEvent` beside `handoff`, and handle it in the store's consume switch. JunoChatKit cannot import JunoWorkKit, so `NativeChatWorkStart` carries `sessionID`, `conversationID`, `title`, `status`, `createdAt` and the session's raw JSON (`Data`). JunoWorkKit exposes `public static func NativeWorkClient.decodeSessionSummary(_ data: Data) throws -> WorkSessionSummary`, reusing `decodeSession`.
- **Publish it.** The store keeps `workStarts: [String: NativeChatWorkStart]` by conversation id (the research pattern: `researchRunsByConversation`, `adoptResearchHandoff`). The app's follower adopts it (A2).
- **Contract.** `contracts/openapi/juno-native-v1.yaml`: `workHandoff` (optional boolean) on the chat request, and the `work` frame (`session: WorkSession`) among the stream's frames. Regenerate; `native:contract:check` must pass.
- **Tests** (`JunoChatKitTests`): recorded `work` frame bytes in the web's `serializeSession` shape decode into the event; a saved chat's body has `"workHandoff":true` when the store claims it, and not when it doesn't; the private body never has it; an unknown frame type is still skipped.

### A2. One follower per open chat: `NativeConversationWork`

A new `@MainActor @Observable` class in `JunoWorkKit/NativeConversationWork.swift`, the Swift twin of the web's `useConversationWork`. The legacy window keeps `NativeWorkModel.openSession`; the chat never touches it, so the two stop competing.

- **Adopt** a session from the `work` frame (drafts refused; the same id keeps the current object; an adoption counter drops stale discovery answers).
- **Discover** with `sessions(conversationID:limit: 10)` when the conversation opens, after adoption, after each reply's `done`, and every 4s while the conversation is on screen in a visible window (the follower takes an `isVisible` input; the Mac feeds it from `NSWindow.occlusionState`, since JunoWorkKit is shared with iOS and cannot use AppKit); never in private chats. The newest by `createdAt` is `current`; the rest are `history` (for the settled rows, A4).
- **Follow** `current` through `streamEvents(sessionID:afterSeq:)`: reconnect at once after the server's 4-minute close, back off 1s × n to 15s on errors, reset the cursor on a new run id, stop at `done`.
- **Derive**, in pure functions moved out of `DesktopWorkLog` (`DesktopWorkWorkspace.swift`) into `JunoWorkKit/WorkEventLog.swift` beside `WorkEventPayload.swift`: the plan and its step states, every open question (id, text, options, why, asked-at), the pending approvals (server) merged with this Mac's local approvals (passed in from `DesktopWorkHostModel.localApprovals(forRun:)`, local first), the artifacts (refetched when the produced count changes), the pending steers (a `user_message` counts until the next `assistant_message` or `step_started`), the current action (live runs only), the run's turns. The legacy window reads the moved functions until Stage D. Icons and tints stay in the app.
- **Act**, each followed by `NativeWorkModel.refresh()` (the web's `juno:work-sync`):
  - `answer(questionID:text:)` (send an idempotency key; the web accepts one)
  - `steer(_:)` → `sendInstruction`, returning the server's `explanation` for the toast
  - `decide(_:_:reason:)` → server approvals through `NativeWorkModel.decide`, local ones through `localApprovalDecider`
  - `stop()` → `control(runID, .cancel)`
  - `pause()` / `resume()` / `tryAgain()` (the card's overflow menu, A5)
- **Composer mode**, the web's `delegatedComposerMode` with one change (register #54): an open question gives `.answer` **only while the run is not finished**; finished, draft or none gives `nil`; everything else `.instruction`.
- **Toasts** (posted by the app through the window's toast host, the web's words): answer failed "Couldn’t send that answer, so Juno hasn’t seen it. Try again."; steer accepted: the server's explanation; steer failed "Couldn’t add that to the task. Nothing was recorded."; decision failed "Couldn’t record your decision, so Juno has not acted on it. Try again."; Stop with no run "This task hasn’t reported in yet, so there is nothing to stop. Try again in a moment."; Stop unreachable "Couldn’t reach Juno to stop that. The task is still going.".
- **Owner:** `DesktopConversationView` (or `ChatDetail`) creates one per selected, saved conversation and drops it on switch; the transcript, the card and the composer read the same object.
- **Tests** (`JunoWorkKitTests/NativeConversationWorkTests`): adoption rules; newest by `createdAt` with history; the mode table including "finished run with an open question → nil"; pending-steer derivation; Stop with no run gives the web's sentence; local approvals come first.

### A3. Remove the task toggle

Delete the "Do This as a Task" row (`ComposerPlusMenu`), `ChatComposerMark.taskID` and its mark, `asTask` in `ChatComposer` and `ChatComposerTurn`, the "Start this as a task" face and help, `dispatchTask`, and `NativeConversationStore.appendUserTurn` if nothing else calls it. Keep `NativeWorkModel.startTask(conversationID:projectID:)` and the session fields from the slice (discovery needs them). Rewrite the comments in `DesktopWorkbenchRegistry.requestWorkErrand` and `DesktopQuickEntry` (an errand is an ordinary chat; decision 4). Update `ChatComposerTests`.

### A4. Placement, and several tasks in one chat

- **`ChatTranscript`** takes `workRuns: [ChatWorkRunEntry]` (session, `createdAt`, and whether it is `current`) and places each by the web's rule: after the assistant reply that follows the last user message created at or before `createdAt`; with no such message, at the transcript's foot. The current task is the full `ChatWorkRunCard`; each earlier one is a `ChatWorkSettledRow`.
- **`ChatWorkSettledRow`** is the resting research row's twin (`DesktopResearchRow` at rest), so a chat's two kinds of background work read alike: one 36pt line at the reading measure; a 16pt `JunoIcon.task` glyph (`ph.treestructure`) in `junoSecondaryInk`; the title at 13pt medium, one line, truncating; the status pill; a spacer; "Open ›" (borderless, 12pt secondary, 28pt target, help "Open the task") that opens the Task panel for that session, read once with `NativeWorkClient.snapshot(sessionID:for:)` and not followed. No card, no fill: a row in the transcript.
- **The Task panel, first cut.** Add `DesktopDockPanel.task(sessionID:)` and `ChatWorkPanel.swift` on `DesktopPanelShell` with the Activity view only (B2 adds Files and Details and the rest of the panel's states), so "Open ›" and "Show Details" have somewhere to go from this stage on.
- **Loop ownership.** The current action's signature (A5) loops only when no chat reply is running and no research row owns the loop (extend `loopingResearchRunID`'s rule).
- **Scroll.** Adopting a task never scrolls the reader away; the card enters at its place with the rise-in.

### A5. The card: header and live body, to the web's anatomy

Rebuild `ChatWorkRunCard` (keep the file):

- **Container:** `junoCard`, 1pt `junoBorder` at 80%, **radius 20** (panel), 8pt inset, `.containerShape(.rect(cornerRadius: 20))`, no shadow, no tint, no glass. Blocks inside are inset 8 more (16 from the edge, the web's `p-2` + `px-2`); tiles (current action, questions, approvals) are inset 8 at **radius 12**.
- **Header**, top to bottom:
  1. "Task" with a 14pt `JunoIcon.task` glyph, 11pt medium `junoSecondaryInk` (the web's caption; not uppercase).
  2. The title, 15pt medium `junoForeground`, two lines, then the goal if the title is empty.
  3. The status pill (20pt capsule, 11pt medium; tone at 12% with the tone's ink; a live run's pill stays neutral with the breathing coral dot as its one coral mark) and the status sentence at 13pt `junoSecondaryInk`, re-voiced with the agent's name in an agent's thread (the web's `statusSentence(status, actor)`: only a sentence that opens with "Juno ").
  - Trailing, top-aligned: **Stop** (`.bordered`, `.tint(nil)`, small, 28pt; a 10pt `ph.stop.fill` and "Stop"; label and help "Stop the task"), shown while the run is not finished; it keeps its spinner until the header drops it. Then the overflow `Menu` (`ph.dotsthree`, 28pt, help "More"): Pause or Resume, Try Again (on failed, cancelled, interrupted, timed out and Mac-unreachable runs), Divider, Show Details (opens the Task panel).
- **Live body**, 12pt apart:
  1. **Current action** tile: `junoMuted` fill, 1pt `junoBorder` at 70%, radius 12, 14 × 10 padding. An 18pt `JunoRunSignature` in its tool pattern (static when it doesn't own the loop or under Reduce Motion), the step's title at 13pt medium (one line, `aria-live` → announced on change), and under it the detail at 11pt secondary with the ticking duration in 11pt mono. Hidden when there is no current step. *(Register #55: the web's tile is coral with a spinner.)*
  2. **Plan**, when the run has written one: "Plan" at 13pt medium and the tally `3/7` in 11pt mono secondary (skipped counts as done). Rows 22pt apart, a 14pt mark and the step's title at 13pt: done = a `junoForeground` disc with a checkmark, title secondary and struck through; active = the still running ring (`JunoRunMarker`), title medium; pending = a 1pt `junoBorder` ring, title at 80% ink; skipped = a minus, struck through; failed = a `junoDestructive` disc with an ×; unreported = a dashed `junoWarning` ring with "never finished" at 11pt SF in the warning ink. No progress bar (the web has none; the spec's `ProgressView(value:total:)` is dropped).
  3. **Meter:** Elapsed · Cost · Tokens with 12pt `ph.timer`, `ph.coins`, `ph.sigma` glyphs in `junoSecondaryInk`, the figures in 11pt mono tabular (`0s`, `$0.00`, `1.2K`), from the run only.
  4. **The run's words:** the newest three turns rendered with the Markdown renderer at the 15pt rung; older ones behind "Earlier updates {n}" (13pt secondary, a caret that turns 90° on `JunoMotion.fast`, 28pt target).
  5. **Needs you:** the question cards and the approval queue (Stage B finishes the approvals; keep the slice's until then).
- **Finished body:** keep the slice's until Stage B.
- **Signature detail:** the current-action line uses the same run signature as a chat reply's run line, so a task's live step and a reply's live thought speak one language, and only one of them moves at a time.

### A6. Steering through the composer

- **Model.** `ChatComposer` takes `steering: ChatComposerSteering?` = `{ kind: .answer | .instruction | .research, standalone: Bool, placeholder, sendLabel, stopLabel, pending: [ChatPendingSteer], steer: (String) async -> Bool }`, built by `DesktopConversationView` from the follower (task) or the research run (research wins while it is accepting input), exactly as `chat-view.tsx:1827-1860` builds the web's prop.
- **Steer mode** = steering and (`isGenerating` or `standalone`), and not while the clarify check runs or a clarification is pending. Task steering is standalone; research steering is not (the web's).
- **In steer mode:** Return sends the text through `steer` and clears the draft only on `true`; attachments are not sent with a steer (they stay in the tray for the next ordinary message, as `composer.tsx` treats them); the mic is hidden; ⇧Return, ↑-to-edit, Esc and the queued-turn release stay on the chat stream alone (keep "is generating" and "a run is live" as two separate flags).
- **Placeholder precedence** (the web's): armed marks → none; steer mode → the steering placeholder; a pending clarification → "Or type your own answer…"; a quote → its line; the custom rung (voice lines, private "How can I help you today?", an agent's thread "Message {name}…"); the modality's; "Message Juno…". Fix `ChatComposerPlaceholder.Steering`'s apostrophe: "Answer Juno’s question…".
- **The disc** (`ChatComposerFace` gains a purpose so its help keeps the shortcut): empty field and a live task → the stop face, label and help = the stop label ("Stop the task"; "Stop generating" while a reply streams; "Stop the research"); text in the field → the send face, label = the send label, help "{label}  ↩".
- **Return routes:** `.answer` → `answer(questionID: <the current question>, text:)`; `.instruction` → `steer`; `.research` → the new `NativeChatAPIClient.steerResearch(id:input:)` (in `NativeResearchRun.swift`, after `decideResearchPlan`) (`POST /api/research/{id}/steer` with `{sourceUrl}` when the text matches `^https?://`, otherwise `{constraint}`, 3–300 characters on today's server) with a store wrapper beside `decideResearchPlan`; toasts "Added to this research run", or the run's notice, or "That could not be added to the run.".
- **Stop:** research accepting input → cancel the run (`/control cancel`), then `stopGeneration()`; a task with no reply streaming → `follower.stop()`; otherwise `stopGeneration()`.
- **Pending steers** (the above-slot's new branch; the spec's ✕ is dropped, because a queued steer cannot be withdrawn): an opaque tile inside the shell's above-slot, `junoSecondary` fill, 1pt `junoBorder` at 60%, radius 12, 12 × 10 padding, entering with the rise-in. Header at 11pt medium `junoSecondaryInk`: "Queued — Juno reads this before its next step" or "Queued — Juno reads these {n} before its next step, in order". Rows: a 12pt `ph.arrowelbowdownright`, the text at 13pt (two lines), and the time at 11pt secondary with tabular digits ("2m ago"). Announced when a steer is queued. **Signature detail of the steering composer:** the queued strip rising in above the field the moment the server takes a steer, and leaving when the run reads it.
- **Tests** (`ChatComposerTests`): the face table (empty + live task, text + live task, streaming + live task, research), the placeholder precedence, the labels, routing through a fake follower, the draft kept on a refused steer.

### A7. Stage A snapshots and acceptance

Fixtures (`WorkCardSnapshotTests`, `TranscriptSnapshotFixtures`), light and dark, into `/tmp/juno-glass-snapshots/phase5-a/`:
- `work-live` (current action, plan 3/7, meter, three turns and "Earlier updates 2")
- `work-live-agent` (a sentence re-voiced with an agent's name)
- `work-waiting-question` (the question card and "Reply below")
- `work-placement` (a transcript with two earlier tasks as settled rows and the current card after the reply that follows its turn)
- `composer-steer-empty` (Stop face), `composer-steer-draft` (send face, one pending steer), `composer-steer-queue` (three pending steers), `composer-steer-answer`, `composer-steer-research`
- `task-panel-activity` (the first cut, for an earlier task read once)
- `final/window-task-live` (the card beside the sidebar in the window composition)

Acceptance: a recorded `work` frame puts the card in the right place; a saved chat's request carries `workHandoff: true` and a private one doesn't; iOS never claims it; no "Do This as a Task" string remains in code (`rg -n "Do This as a Task|Start this as a task" native` finds nothing); the follower never touches `NativeWorkModel.openSession`; every gate green; 5-Dimension scores ≥ 7 for the card (live, waiting), the settled row and the steering composer, written in the commit body.

---

## 4. Stage B: the rest of the card, the Task panel, approvals, research

Two commits: **B1–B5** (the card, the panel and the approvals) and **B6** (research).

### B1. The finished body (the web's `TerminalRun`)

12pt apart, in this order:
1. **Terminal detail** (any end but `completed`): 13pt in the warning ink.
2. **Degradation notes:** one line each, a 12pt `ph.warning` and 13pt text in the warning ink.
3. **Outcome digest** (any end but `completed`), 13pt `junoSecondaryInk` lines, the web's words: "Finished {d} of {n} planned steps[, and stopped on “{step}”]." or "No plan was written, so there are no steps to measure it against."; the actions line ("{n} actions changed something outside Juno. They are listed in Details." (register #58: the web says "…under Outputs.", which chat does not have) or "Nothing was recorded as changed, so starting it again is safe."); "Ran for {m}m {s}s and spent ${z}." with the figures in mono.
4. **The run's words**, as in the live body.
5. **Deliverables** (register #58). The newest previewable one (site, report, spreadsheet) leads: its name at 15pt semibold and a meta line at 11pt secondary ("PDF" in mono, then "v2 · 5m ago" in SF). Under it, **every** file the task made as a wrapping row of page tiles, reusing stage 2's 144 × 144 page tile (`TranscriptAttachments`: the first page in a 96pt well over a 48pt caption band "Report · 88 KB"). A click, Space or Expand opens Quick Look; the context menu has Quick Look · Open With Default App · Save As…; a tile drags out as its file. Files come from `/api/work/artifacts/{id}/download` into `Caches/<bundle>/WorkFiles/<account>/<artifact>/`, purged on sign-out with the transcript cache, with the same 51 MB ceiling. Move the save logic (`DesktopWorkArtifactSavePanel`, `saveArtifact`, the unvalidated-save dialog) out of `DesktopWorkWorkspace.swift` into the card's file.
6. **"Save this as a skill"** (B3), when the run completed and at least two plan steps are done.
7. **The meter**, as the receipt.

**Signature detail of the finished card:** the deliverable leads as a real page, so a finished task reads as "here is what it made" before "here is what it did".

### B2. The Task panel (register #59)

- `DesktopDockPanel.task(sessionID:)` in `DesktopArtifactCanvas.swift`, one of canvas / Activity / Research / Task at a time, its width remembered under `dock.task.width`, reset on conversation change, opened from the card's "Show Details" and the settled row's "Open ›".
- Built on `DesktopPanelShell`: the task's title as the heading, a static status word and the elapsed time (never a shimmer), close. A full-width `JunoSegmented`: **Activity · Files · Details**, the choice remembered (`task.tab`).
  - **Activity:** the run's log (`WorkEventLog.entries`, moved from `DesktopWorkLog.entries`/`describe`) in the Activity panel's row recipe; questions and approvals answered appear with their answers.
  - **Files:** every artifact as a 36pt row (the file's glyph, the name at 13pt, "PDF · 2.4 MB · v2" at 11pt secondary with the size in mono), Quick Look on click and Space, Save As… in the context menu; files changed on this Mac (`references` / `hasAppliedBatch`) under them when there are any. Empty: `JunoEmptyState(.panel)` "No files yet" / "Files the task makes appear here.".
  - **Details:** `LabeledContent` rows at 13pt: Model, Where it ran ("On this Mac" or "In the cloud", the host's name), How often it asks (the web's mode label), Connected apps, Elapsed, Cost, Tokens, Started, Finished, and the session id in 11pt mono, selectable.
- A current task's panel follows the follower; an earlier task's reads `snapshot(sessionID:for:)` once and says "As of {time}" under the heading.
- Loading: skeleton rows; error: `JunoEmptyState(.panel, tone: .error)` "Couldn’t load this task" / "Check your connection and try again." with "Try Again".

### B3. Save this as a skill

- The button: full width, `.bordered`, `.tint(nil)`, 28pt, a 14pt `ph.scroll` and "Save this as a skill" (a button, so the web's sentence case).
- The sheet (`.sheet`, explicit width 640; no glass): the title "Save this task as a skill" at 18pt semibold; the web's description verbatim; **Name** (hint "You will type /{slug} to use it.", or "Give it a name with at least one letter or number in it."); **What it is for**, pre-filled with the goal's first sentence (at most 180 characters), with the web's hint; **Instructions**, a 12-line `TextEditor` in SF 13 (register #66), pre-filled. "Cancel" (`.cancelAction`) and "Save the skill" (`.junoProminent`, "Saving…" while saving).
- Port `draftName` and `draftInstructions` (`capture-skill.tsx:82-130`) and `skillSlugFromName` to pure Swift in JunoWorkKit, with tests against the web's examples.
- Save: `POST /api/work/skills {name, description, instructions, origin: "authored", projectId?, autoSelect: false}` through a new `NativeWorkSkillsClient.createSkill` in JunoWorkKit (the Phase 4 Skills page reuses it). Success: close and toast "Saved as /{slug}." (with "Open" to the skill when the Skills page exists). Failure, inline under the fields in the error recipe: "Juno wouldn’t accept that. Check the name and try again — nothing was created." or "Couldn’t reach Juno to save this. Nothing was created.".

### B4. Local blockers, when the run is on this Mac

When the run targets this Mac (its host is `DesktopWorkHostModel.pairedHostID` and its target is local; read the field the run actually carries, since sessions don't send `effectiveTarget`/`hostId`), and Accessibility or Screen Recording is missing (`DesktopWorkSystemPermissions.current`), the live body shows a tile per missing permission: radius 12, `junoCard` under a 1pt `junoWarning` hairline, a 14pt glyph, the sentence from `DesktopWorkHostTile.permissionRow` (keep the Mac's existing words), and "Open System Settings" (`.bordered`, `.tint(nil)`) to the pane URLs in `DesktopWorkSettings.swift`. Re-checked when the app becomes active. Mac-only (A5).

### B5. Approvals

**Task approvals** (`ChatWorkApprovalCard`, rebuilt to the web's `approvals/approval-card.tsx`, register #67):
- A tile at radius 12 on the card, 14pt padding, **a 1pt hairline in the risk tone** while answerable (no wash), `junoBorder` at 60% once settled.
- Header row: a 14pt `ph.shieldcheck`, "Your decision" at 11pt medium in the warning ink (SF, register #56), the risk pill (the web's words), the time asked at 11pt secondary.
- The summary at 15pt medium, selectable. The preview in a `junoSecondary` well (radius 8, 12 × 10): "To {target}" at 12pt secondary, then the body at 13pt, selectable. "Show {n} parameters" / "Hide {n} parameters" (the singular for one) as a disclosure; the parameters as an 11pt mono key/value grid. The risk's consequence sentence at 13pt in the warning ink, the web's words per risk ("Nothing here changes anything outside this task.", "This writes to a file. Juno can show you what changed afterwards.", "This runs a command on the machine this task is on.", "This touches something private. Juno asks every time, whatever you have allowed before.", "This cannot be undone — not by Juno, and not from this page afterwards.").
- Buttons, 28pt, wrapping with `ViewThatFits`: **"Don’t"** (`.bordered`, destructive role and ink), **"Change it"** (`.bordered`, `.tint(nil)`, a 12pt `ph.pencilsimple`), **the verb** (`actionVerb`: "Send", "Delete for good", …, falling back to "Go ahead"; `.junoProminent` on the queue's first answerable card only, `.bordered` `.tint(nil)` on the rest, register #60; its accessibility label restates the summary), and **More** (a borderless `Menu` with a caret) holding "{Verb}, and Stop Asking" with the second line "Covers “{action}” for the rest of this task only. It lapses when the task ends.", offered only where `JunoWorkApprovalRules.allowsStandingGrant` allows it. Nothing is bound to `.defaultAction` or Escape.
- **Change it** replaces the button row: "What should it do instead?" at 11pt medium in the warning ink, a 3-to-6-line `TextEditor` with the web's placeholder ("Send it to the finance alias instead, and drop the last paragraph."), the note "Juno will not do this one. It will be told what you want instead, and will carry on from there." at 13pt secondary, then "Back" (borderless) and "Send this instruction" (`.junoProminent`), which decides `denied` with the text as the reason.
- Footnote at 11pt secondary: "Unanswered, this expires and Juno stops rather than acting on it.". With no digest: "This request did not arrive with the signature Juno needs to accept an answer from the web. Decide it in the Juno app on the Mac that raised it." (local approvals always have one).
- Settled: the web's settled line ("Allowed …", "Refused …", "Expired unanswered — Juno stopped rather than acting on a stale approval", "Replaced by a later request").
- Local approvals decide through `decideLocally`, server ones through the follower.

**The queue:** every pending approval, local first. When more than one can be batched (the web's `mayBatch`), a bar above them: a radius-12 tile under a 1pt warning hairline, 13pt text ("{n} decisions are waiting, and they are all the same kind." or "{n} of these {m} can be answered together. The rest ask on their own.") and a `.bordered` `.tint(nil)` button "{Verb} — all {n}" (one shared verb) or "Allow all {n}". Decisions go one at a time and stop at the first refusal or failure.

**Question cards** (the slice's, brought to the web): a radius-12 tile under a 1pt warning hairline and no wash (as #67); "Waiting on you · asked {5m ago}" at 11pt SF in the warning ink; the question at 15pt; the why at 13pt secondary; the options as 28pt `JunoChipStyle` chips that answer on one press; for the current question "Reply below" (`.bordered`, `.tint(nil)`, small, a 12pt `ph.arrowdown`, accessibility "Reply in the message box below") which focuses the composer; for the others "Answer the question above it first; this one is next." at 13pt secondary.

**Handoff card** (`ApprovalCard.swift`, `juno_work` / `hand_off_to_teammate`): the task variant with the web's handoff words: heading "Hand this to a teammate?" (settled: "Handoff to a teammate") with a 16pt `juno.agents` glyph in the warning ink while answerable; the title; "To {teammate}" at 12pt secondary with the name in `junoForeground`; "Estimated cost {x}"; the description "It becomes their task, in their own thread, with their apps and autonomy. They report back there, not in this chat, and you can stop it at any time."; the untrusted note ending "…before you hand it off."; the disclosure "What they will be told" (open by default when untrusted); "Don’t hand off" and "Hand off" (`.junoProminent`); the footnote "Unanswered, this expires and nothing is handed off."; the status lines from `HANDOFF_STATUS_COPY` verbatim. Check the task variant's strings against `TASK_CARD_COPY` / `TASK_STATUS_COPY` at the same time (curly apostrophes).

**Tests:** the verb table, "and Stop Asking" offered only where allowed, batching rules, only the first card prominent, the handoff copy table, the amendment sends `denied` with the reason.

### B6. Research, consistent with stage 4b's row, plan card and panel

Stage 4b built the research row, the plan card and the Research panel. What is left, from `web-research.md` §C (C4–C10) and today's web:
1. **Show web-started runs.** `followResearch` adopts runs with no `phase` (derive `live` from the state), so a run begun on the web shows its row on the Mac.
2. **A recap card** for a finished run that carries a report and no completion message (today's web background runs, C4.3). A `junoCard` card at radius 16 under a 1pt `junoBorder` hairline, 16pt padding, placed at the run's `createdAt`: a verdict line at 12pt secondary ("Research complete", the state's sentence, or "Cancelled") with the elapsed time and cost in mono; the title at 15pt semibold; the provenance "{n} sources read · {m} found · {a}/{b} objectives answered" at 13pt secondary with tabular SF digits (#40); the audit line (a 12pt `ph.shieldcheck` and the web's `auditHeadline`); "Read the full report" (`.bordered`, `.tint(nil)`) or "This run stopped before it wrote a report."; "Inspect methodology & sources" (borderless, opens the Research panel on Sources); a dismiss ✕ with help "Hide this research receipt", remembered per run in the account's defaults. **Signature detail:** the audit line, the one place a report says whether its claims hold.
3. **Clarification is a gate**, not "planning": `awaiting_clarification` shows the clarify form in the plan card's shape (the lede "A few details would sharpen this. Answer what you can — anything you skip, Juno decides for itself.", each question marked Optional or Needed, suggestion chips that fill the field, "Start researching" and "Skip and research as written", both posting `/clarify {answers}` and then re-reading the run).
4. **`partially_completed` without a report** reads as stopped early and offers no "Open report".
5. **Catch-up:** decode `maxSeq` and poll again at once while behind.
6. **The clock** on today's server comes from the `state_changed` spans when `workingMs` is absent.
7. **Finish now** is hidden where the server answers 400 (today's), for that server.
8. **Stop on an in-chat run** (today's server, where the Mac has no run id to cancel first): stop the stream, then cancel the newest live run created at or after the question (`web-research.md` C7, the B17 workaround), so it stops spending. With a run id in hand, A6's order holds: the run, then the stream.
9. **The report window** (register #65): `WindowGroup(id: "research-report", for: String.self)` keyed by run id; default 880 × 720, minimum 640 × 480; the window title is the report's title and the subtitle "Research report · {n} words · ~{m} min read · {k} sources read". Layout is a plain `HStack`: a 220pt Contents column ("Contents" at 13pt medium, the headings at 13pt secondary, the one in view in `junoForeground`; shown with two or more headings) and the report in `JunoProseStyle.reading` at the reading measure, then the sources ("Cited", then "Read, not cited", or "Sources read · {n}" on today's server) with `[n]` numbered as C8 says. Toolbar items, declared once: Copy (`ph.copy`, to "Copied" for two seconds), Export Markdown… (`{slug(title)}.md` with a `## Sources` appendix, C8), Print… (⌘P). Opened by "Open report" on the row, "Read the full report" on the recap, and "Open in Window" on the panel's Report view. **Signature detail:** the Contents column follows the reading position.
10. **Citation marks** in the report: `GET /api/research/citations?messageId=` → supported, partly supported, not checked (contradicted and not supported only with a verdict), drawn with stage 4b's citation chip and popover (the passage verbatim, "Open at passage" with `#:~:text=` from its first eight words). `audit: null` or a 500 shows no marks and no error.

No APNs on the Mac yet, so `TASK_COMPLETION` push routing is not built (Deferred).

### B7. Stage B snapshots and acceptance

Into `/tmp/juno-glass-snapshots/phase5-b/`, light and dark: `work-done` (deliverable lead, tiles, Save this as a skill), `work-failed` (terminal detail, digest, degradation note), `work-local-blockers`, `task-panel-activity`, `task-panel-files`, `task-panel-details`, `task-panel-empty`, `skill-sheet`, `approval-single` (first card prominent), `approval-change-it`, `approval-queue` (batch bar and three cards), `approval-settled`, `question-cards` (current and next), `handoff-card` (pending, untrusted, settled), `research-recap`, `research-clarify-gate`, `research-report-window`, `final/window-task-panel`.

Acceptance: every approval verb draws in the Juno accent (the follow-up of 2026-09-24: no system blue); Return never approves; a local approval still goes through `decideLocally`; a web-started research run shows its row; 5-Dimension scores ≥ 7 for the finished card, the Task panel, the approval tile and queue, the handoff card, the recap and the report window, written in each commit body.

---

## 5. Stage C: signals, and agents in chat

Two commits: **C1** (the sidebar: dots, Needs you, Agents, Notifications) and **C2** (system signals and agents in the thread).

### C1. The sidebar

**Data.** `JunoWorkKit/WorkRunsByConversation.swift` (pure): the newest session per conversation by `lastActivityAt`; `isOpen` (the web's `workRunIsOpen`: needs attention, or `waiting_input` / `waiting_approval` / `host_offline`, or any live status but `draft`) and `needsYou` (the web's `workRunNeedsYou`), ported from `conversation-status.ts` with its tests. It reads `NativeWorkModel.sessions`, whose list poll grows to `limit: 100` (the web's sidebar read), stays at 30s while a window is visible, and refreshes on a `work` frame, after every answer, decision or steer, and when the app becomes active. A run on this Mac with a pending local approval counts as needing you even before the server's status says so.

**`JunoStatusDot`** (new, `JunoDesignSystem/JunoStatusDot.swift`): a 6pt circle. Tones: neutral (`junoSecondaryInk`), live (`junoAccent`, opacity 1 → 0.45 over 2.8s on `JunoMotion.Loop.statusBreathe`, static under Reduce Motion), attention (`junoWarning`), good (`junoSuccess`), bad (`junoDestructive`). Under Differentiate Without Color it becomes a 10pt glyph (live `ph.circlenotch`, attention `ph.warningcircle`, good `ph.checkcircle`, bad `ph.xcircle`, neutral `ph.circle`; add any missing). The tone mapping is `DesktopWorkBucket.of`'s, moved beside it.

**Conversation rows** (and a pinned project's nested chat rows): the trailing mark keeps one slot, in this priority: the pending-send spinner; the hover or selected `ph.dotsthree` menu; **the status dot, only while the chat's newest run is open**; the pin. `.help("{title}: {statusSentence}")` (the web's colon), `.accessibilityValue(statusLabel)`.

**Needs you** (§2.5, to the web): the section appears only when it has rows and comes first; its rows leave Pinned and Recent. The header is a plain button, "Needs you · {n}" at the section-header size with the count in tabular digits; pressed, it filters the column to these rows (every other section hides, the Agents fold included) and draws as the column's one selected row (`junoSidebarRowSelection`), with `.accessibilityAddTraits(.isSelected)` and help "Show only these" / "Show everything". The filter is not persisted and lets go at zero. Announce with the web's sentences: "{n} run is waiting on you." / "{n} runs are waiting on you." when the count rises, "Nothing is waiting on you." when it reaches zero. **Signature detail of the column:** the Needs-you header is a filter that becomes the column's selected state, so "what needs me" is one press from anywhere.

**Agents fold** (restyling A0's port): after Needs you, before Pinned projects; hidden while the filter is on and when there are no agents. Header "Agents" (the system's collapsible header, main's `AppStorage` key) with a hover-revealed 12pt `ph.plus`, help "New agent", opening the hiring sheet. Rows in the system sidebar metrics: the face at `JunoAgentFaceSize.xs` in a 20pt slot, the name, and the trailing needs-you dot (main's `NativeAgentNeedsYouDot`, the web's 8pt accent `NeedsYouDot`) while the agent waits; sorted waiting-first, then by `sortOrder`. Selected while its page is open or its thread is the conversation on screen. Help: the state sentence; accessibility "{name}. {sentence}". Context menu: "Message", "Open".

**Notifications** (register #62): a new `JunoSync/Notifications/NativeNotificationsClient.swift` (`GET /api/notifications?limit=&before=&unread=`, `GET /api/notifications/count`, `PATCH /api/notifications/{id}`, `POST /api/notifications {action: "mark_all_read"}`) and an `@Observable NativeNotificationsModel` (the count polled every 30s while a window is visible and after the agents roster or the work list refreshes; the list read when the popover opens). iOS-safe, not wired on iOS.
- **Row:** `Label("Notifications", image: .phBellSimple)` directly after "New chat" in the navigation block (the web's New chat · Search · Notifications; the Mac's Search is the pinned button above). It is an action, not a destination: untagged, never selected. Its one trailing signal is an 8pt dot, `junoAccent` while an unread notification is pressing (urgent or high) and `junoSecondaryInk` while unread items are only news; never a number. The number rides `.accessibilityValue("{n} unread")` and the help.
- **Popover:** `.popover(arrowEdge: .trailing)` with `.frame(width: 384, height: 480)`. Header 48pt: "Notifications" at 15pt medium, and "Mark all as read" (borderless, secondary) while anything is unread. Rows, opaque on the popover's material, 8 × 10 padding, radius 10 hover fill (`junoHover`): a 20pt leading mark (the agent's face at rest, or the Juno mark), the title at 14pt (`junoForeground` unread, `junoSecondaryInk` read, "Unread: " for VoiceOver), the second line at 11pt secondary, "{5m ago} · {body}" on two lines, and the 8pt unread dot (accent when pressing, secondary when news). A click marks it read and follows its `href` through `JunoNotificationRoute(path:)` and `DesktopWorkbenchRegistry.requestRoute`, closing the popover. "Show earlier" (borderless) pages with `before`. Loading: three skeleton rows on the rows' pitch. Empty: `JunoEmptyState(.panel)` "Nothing new" / "Juno tells you here when a task finishes, needs you, or an agent has something to share.". Error: tone `.error`, "Couldn’t load notifications" / "Check your connection and try again." with "Try again". Focus lands on the popover, not on "Mark all as read". **Signature detail:** the leading mark says who (an agent's face or Juno), so the list reads as people before it reads as events.
- ⌘K's "Open notifications" is Phase 3's (track A, this worktree, next).

### C2. System signals and agents in the thread

**`DesktopNeedsYouSignals`** (App, `@MainActor @Observable`), started in `JunoDesktopRootView.updateLifecycle` beside main's agent hook and stopped at sign-out; it reads `WorkRunsByConversation`, so it works whichever view is on screen.
- **A rise** in the needs-you count (never on the first read after launch or sign-in): the web's sentence, "A task needs you" / "{n} tasks need you", plus " — {t} in total" when some were already waiting.
  - Juno in front: the key main window's toast host shows it, with the detail "Open the task to answer it.".
  - Juno not in front, main's "When something needs you" switch on (`NativePushRegistrar.shared.preferences.needsYou`) and permission granted: a local notification, title = the sentence, body "Open Juno to answer it.", `threadIdentifier` "juno-needs-you", request id "juno-work-needs-you" (replaced, never stacked, like the web's tag), `userInfo` `path` "/chat/{id}" and `conversationId` for the newest conversation that rose, so a click takes main's route to it. Skip the banner when every conversation that rose is an agent's thread: main's `DesktopAgentAlerts` already says "{name} needs you" for it.
- **Permission:** asked through `NativePushRegistrar.shared.requestFullAuthorization()` the first time a task starts in this Mac's chat (the first adopted `work` frame, or "Start task" on the task approval card), as well as on main's first agent. The system asks once, whichever comes first.
- **Dock badge** (register #61): `NSApp.dockTile.badgeLabel` = the needs-you count, `nil` at zero, cleared at sign-out.
- **Menu-bar extra** (`DesktopMenuBarExtra.swift`, §7.10): the label is `juno.chat` as a template image, with the count beside it only while something needs you. Contents in Title Case: "New Chat", Divider, a "Needs You" section (one item per conversation, its title with the run's status label as a second line), the existing "Live Code Sessions", Divider, "Open Juno". Choosing a chat calls `DesktopWorkbenchRegistry.shared.requestRoute(.conversation(id:))` and brings the main window forward the way main's `openRoute` does, never `openWindow`.
- **`.workSession` routes** open the session's chat (A0); a session with no conversation opens the task sheet (Stage D).

**Agents in the thread** (the web's §5.3, on top of A0's port):
- The header row above the transcript: main's `NativeAgentThreadHeader`, drawn as content (no glass), at the reading measure over a 1pt `junoHairline`: the face `sm` in its live state (listening in a call, thinking while a reply streams), the name at 13pt medium, the state sentence or the current task's title at 11pt secondary (announced on change), and "Agent page" as an accent-ink link button that pushes the agent's page.
- The empty thread greets as the web does, in the greeting's serif (the one serif site): "Hi, I’m *{name}*." with the name in the italic, then "{role}. What should I take on?" (or "What should I take on?", or when paused "I’m paused. Resume me from my page to start something new.") at the body rung in the secondary ink, with the face `lg` above. It replaces "How can I help, *Name*?" in an agent's empty thread only.
- The composer's placeholder is "Message {name}…" (A6), the card's sentences are re-voiced (A5), and voice already speaks as the agent (main).

### C3. Stage C snapshots and acceptance

Into `/tmp/juno-glass-snapshots/phase5-c/`, light and dark: `status-dots` (every tone, and Differentiate Without Color), `sidebar-needs-you` (the fold, off and filtering), `sidebar-agents` (a waiting agent first), `sidebar-notifications-row` (pressing, news, none), `notifications-popover` (unread and read rows, agent faces), `notifications-empty`, `notifications-error`, `notifications-loading`, `agent-thread-header`, `agent-thread-empty`, and `final/window-sidebar-signals` (the whole column beside a chat with a waiting task). The menu-bar extra and the Dock badge cannot be photographed offscreen: unit-test `DesktopNeedsYouSignals` (rise detection, the sentence, the skip rule for agents, the badge value) and the menu's content model instead.

Acceptance: a chat whose run waits shows its dot and moves into Needs you; pressing the header filters and letting go at zero works; the rise posts one toast in front and one replaceable notification behind; the Dock badge matches the fold; no count ever appears on the Notifications row; 5-Dimension scores ≥ 7 for the column, the popover and the agent thread, written in the commit bodies.

---

## 6. Stage D: remove the old Work window, keep what runs tasks on this Mac

One commit.

### D1. Move out what other code still needs

- `DesktopWorkBlockerRow` and `DesktopWorkStartPath` → `DesktopWorkSettings.swift` (host setup; used by `DesktopWorkHostTile` and `DesktopWorkStartPathSnapshots`).
- `DesktopWorkStatusStyle` → `DesktopWorkVocabulary.swift` (the pill).
- Whatever of `DesktopWorkLog` Stages A and B did not already move → `JunoWorkKit/WorkEventLog.swift`. `JunoMobileWorkView` keeps its own copy.

### D2. Delete

- `App/DesktopWorkWorkspace.swift`.
- `.legacyWork` (raw value `"work"`; a stored `"work"` already restores to `.chat`): `DesktopProductMode.swift`, `JunoDesktopWorkspaceView.swift`, `JunoDesktopPreviewRoot.swift` (`case "work"`), `JunoPreviewSupport/PreviewShell.swift` (`opensWorkOverview`, `opensWorkFiles`) and `PreviewWorld.swift`.
- **Window › Tasks (Legacy)** and `DesktopShellActions.openLegacyTasks` / `isShowingLegacyTasks` (`DesktopCommands.swift`), and the legacy `newItemTitle` case.
- Main's Work-window writes (`juno.desktop.work.selection`, `juno.desktop.work.page`, `openWorkSession`).
- `App/DesktopTasksScreen.swift`, if it is still referenced nowhere (it has been dead since Phase 1; the spec's file ledger lists it).
- Tests: `JunoDesktopSmokeTests` (the legacy cases); retarget `DesktopWorkStartPathSnapshots`; edit `UITests/JunoDesktopLaunchUITests.swift` (`testWorkOpensOnItsHome…` and the legacy menu path) so the target still compiles. Never run the UITests target.

**Keep** (only D1's moves touch them): `DesktopWorkHost`, `DesktopWorkRunHost`, `DesktopWorkExecutorAdapter`, `DesktopWorkGrants`, `DesktopWorkVocabulary`, `DesktopWorkSettings.swift` with `DesktopWorkHostTile` (track B moves it into Permissions), **`DesktopWorkAutomations.swift`** (track B ports it into Automations; it becomes unreferenced here and must still compile), `DesktopDictation.swift` (Code uses it), the `JunoWork` package, `JunoWorkKit` (iOS links it; `NativeWorkModel.openSession` stays for iOS), the grant store and undo ledger on disk.

### D3. Tasks without a conversation (register #63)

- **`DesktopTaskRecordSheet`** (new): a `.sheet` over the Chat window, explicit frame 640 × 600, opaque. Header: the task's title at 18pt semibold, the status pill and sentence under it, and the lede at 13pt secondary: "This task was started before tasks lived in chats, so it has no conversation to report in." (new copy). Body: `ChatWorkRunCard` in a standalone mode, followed by a `NativeConversationWork` keyed on the session (no conversation), so a live legacy run still answers: approvals decide in place (`decideLocally` for local ones), Stop and the overflow menu work, and an open question gets an inline reply field under it ("Reply", `.junoProminent` unless an approval above it already holds the prominent button) because there is no composer. Footer: "Done" (`.bordered`, `.tint(nil)`, `.cancelAction`).
- **Reachable from:**
  1. **Search › Tasks**, a new scope on the Search page (`DesktopSearchScope.tasks`): every session from `NativeWorkModel.sessions` (limit 100, archived included) as rows with the title, the status pill and "Updated {ago}". A task with a conversation opens its chat; one without opens the sheet. Empty: `JunoEmptyState(.panel)` "No tasks yet" / "Tasks Juno runs for you appear here." (new copy). Phase 3's ⌘K panel must carry this scope forward when it replaces the Search page.
  2. A notification route `.workSession(id)` whose session has no conversation.

### D4. Acceptance

`rg -n "legacyWork|DesktopWorkWorkspace|Tasks \(Legacy\)|openLegacyTasks" native` finds nothing; the Mac, its unit tests and iOS build and pass; every gate is green (re-record the glass, targets and prominent baselines if they fall, and say so); the host still registers and runs a task on this Mac (the executor, run host and grants are untouched and their tests pass). Snapshots into `/tmp/juno-glass-snapshots/phase5-d/`: `task-record-sheet-live`, `task-record-sheet-done`, `search-tasks-scope`, and a re-render of the `final/` set. 5-Dimension scores ≥ 7 for the sheet and the Tasks scope. Then update `MACOS_REDESIGN_HANDOFF.md` (Phase 5 done, the runtime checks left) and the spec's §1.6, §1.7, §7.8 notes.

---

## 7. Not in Phase 5 (explicit)

**Handed to track B** (`mac/liquid-glass-pages`), with the web's spec:
1. **Projects › Tasks tab** (`GET /api/work/sessions?projectId=&limit=50`; the web labels it "Tasks"; use `WorkStatusPill`-style pills, not the web's `AgentStatusBadge`, which mislabels most Work statuses) and **Task defaults** in Projects › Settings: "How often it asks" (default, "Ask before every change", "Ask before risky steps"; never "Just do it"), "Model", "Only these connected apps", "Save", `PATCH /api/projects/{id} {workDefaults}`. `NativeProject` has no `workDefaults` yet; track B adds it.
2. **Automations and Permissions:** porting `DesktopWorkAutomations.swift` and `DesktopWorkHostTile`; "Recent runs" opening a run's conversation (map `NativeWorkScheduleRun.sessionID` to the session's `conversationID`).
3. **The agent page's gate cards.** Main's `NativeWorkApprovalCard` / `NativeWorkQuestionCard` (shared with iOS) say "Refuse · Allow once · Always allow this"; the web's agent page uses the chat's Work cards ("Don’t · Change it · {Verb}"). Align them when the Agents pages are rebuilt, or reuse B5's card.
4. Agents' "New agent" button still drawing a coral outline label (carried from the foundations).

**Phase 3, next in this worktree:** ⌘K "Open notifications" and the Search › Tasks scope inside the ⌘K panel; the Settings window's restyle of main's "Notifications on this Mac" section.

**Deferred, with the reason:**
1. **APNs on the Mac** (and so `TASK_COMPLETION` research pushes and "Updates" banners): waits for a Developer ID push profile (main's decision). The Mac notifies only for needs-you rises and agents.
2. **A research "Guide the research" mode switch, question editing, "Update plan"**, the plan card's clarification answers beyond B6.3: the tools rework's server has not shipped them.
3. **The Outputs popover** (the web's `SessionOutputs`) is Phase 3's; work deliverables are not in it on the web either.
4. **Runtime checks at the screen** (screen control is off): a real model-started task end to end, the card appearing mid-reply, steering accepted by a live run, Stop on a live run, a local approval answered from the card, Quick Look on a deliverable, Save this as a skill against the server, a notification banner and its click, the Dock badge, the menu-bar extra, the report window's Print, a legacy task answered from the sheet.
5. **Localization:** new copy is not in `Localizable.xcstrings` (the Mac has no string catalog yet).

## 8. Owner decisions (none block the stages)

1. Keeping earlier tasks visible (register #53) is a Mac addition; the web draws only the newest. Drop the settled rows if you want strict parity.
2. The finished-run answer-mode fix (register #54) diverges from the web on purpose; the web's behaviour is a defect worth fixing there too.
3. Asking for notification permission on the first task (not at launch) follows spec §7.11 and main's first-agent rule.

---

## Appendix A: new Mac-only copy (for the copy audit)

Everything else is the web's, verbatim. These are new, and each must read plainly:
- "Show Details", "Pause", "Resume", "Try Again" (the card's overflow menu)
- "Open ›" with help "Open the task" (the settled row)
- "Activity", "Files", "Details" (the Task panel's views); "No files yet" / "Files the task makes appear here."; "Couldn’t load this task" / "Check your connection and try again."; "As of {time}"
- "Model", "Where it ran", "On this Mac", "In the cloud", "How often it asks", "Connected apps", "Elapsed", "Cost", "Tokens", "Started", "Finished" (Details)
- "{n} actions changed something outside Juno. They are listed in Details." (the web's sentence with its last word changed)
- "Open System Settings" (local blockers; the host tile's existing sentences)
- "This task was started before tasks lived in chats, so it has no conversation to report in." (the task sheet); "Reply"; "Done"
- "No tasks yet" / "Tasks Juno runs for you appear here." (Search › Tasks)
- "Open in Window" (the Research panel's Report view); "Research report · {n} words · ~{m} min read · {k} sources read" (the report window's subtitle, after the web's toolbar line); "Export Markdown…", "Print…"
- "Needs You", "Open Juno", "Live Code Sessions" (the menu-bar extra, Title Case)

## Appendix B: file map

**New**
- `native/Packages/JunoNativeKit/Sources/JunoWorkKit/NativeConversationWork.swift` (A2)
- `native/Packages/JunoNativeKit/Sources/JunoWorkKit/WorkEventLog.swift` (A2, from `DesktopWorkLog`)
- `native/Packages/JunoNativeKit/Sources/JunoWorkKit/WorkRunsByConversation.swift` (C1)
- `native/Packages/JunoNativeKit/Sources/JunoWorkKit/NativeWorkSkillsClient.swift` and the skill draft helpers (B3)
- `native/Packages/JunoNativeKit/Sources/JunoDesignSystem/JunoStatusDot.swift` (C1)
- `native/Packages/JunoNativeKit/Sources/JunoSync/Notifications/NativeNotificationsClient.swift`, `NativeNotificationsModel.swift` (C1)
- `native/macOS/JunoDesktop/App/ChatWorkPanel.swift` (the Task panel, A5/B2), `ChatWorkDeliverables.swift` (B1), `ChatSkillCaptureSheet.swift` (B3), `ResearchReportWindow.swift` and `ResearchRecapCard.swift` (B6), `DesktopNotificationsPopover.swift` (C1), `DesktopNeedsYouSignals.swift` (C2), `DesktopTaskRecordSheet.swift` (D3)
- Tests: `JunoChatKitTests` (the frame and the flag), `JunoWorkKitTests/NativeConversationWorkTests`, `WorkRunsByConversationTests`, `SkillDraftTests`, `JunoSyncTests/NativeNotificationsClientTests`, and the snapshot fixtures named in each stage

**Changed**
- `JunoChatKit/NativeChatAPIClient.swift`, `NativeConversationStore.swift`, `NativeResearchRun.swift`; `JunoWorkKit/NativeWorkClient.swift`, `NativeWorkModel.swift`; `contracts/openapi/juno-native-v1.yaml` (+ the regenerated Swift contract)
- `App/ChatComposer.swift`, `ComposerPlusMenu.swift`, `ChatTranscript.swift`, `ChatWorkRunCard.swift`, `ApprovalCard.swift`, `ResearchViews.swift`, `ActivityPanel.swift`, `DesktopArtifactCanvas.swift` (the dock case), `ChatDetail.swift`, `DesktopChatWorkspace.swift`, `DesktopChatSidebar.swift`, `DesktopEmptyChat.swift`, `DesktopMenuBarExtra.swift`, `DesktopQuickEntry.swift`, `DesktopWorkbenchRegistry.swift`, `JunoDesktopApp.swift` (the report window scene), `JunoDesktopRootView.swift`, `JunoDesktopWorkspaceView.swift`, `JunoDesktopConfiguration.swift`, `DesktopSearchScreen.swift`, `DesktopWorkSettings.swift`, `DesktopWorkVocabulary.swift`, `DesktopCommands.swift`, `DesktopProductMode.swift`
- `scripts/generate-native-icons.mjs` and the icon catalogues (new symbols)

**Deleted (Stage D)**
- `App/DesktopWorkWorkspace.swift`, `App/DesktopTasksScreen.swift` (if still unreferenced), the `.legacyWork` case, Window › Tasks (Legacy)

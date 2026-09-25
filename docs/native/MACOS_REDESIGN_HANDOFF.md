# Mac Chat redesign: handoff (paused 2026-09-23)

The owner paused the work. This page gives the exact state and the steps to resume. Nothing is pushed, and the redesign is not in any release: **1.6.0 shipped without it**, and it will ship as **1.7.0**.

## Where the work lives

| Thing | Location |
|---|---|
| Worktree | `/Users/liammagnier/Developer/project/juno-glass` |
| Branch | `mac/liquid-glass-chat` (local only, **not pushed**; working tree clean at pause) |
| Spec and audit | `docs/native/MACOS_LIQUID_GLASS_REDESIGN.md`. Read the "Fact-check errata" at the end, which overrides the body. |
| Phase 2 brief | `docs/native/MACOS_PHASE2_TRANSCRIPT_BRIEF.md`. Its §0 corrections override the spec. |
| Scratch worktrees | `juno-glass-a` and `juno-glass-b` (foundation work, already merged). They are obsolete: `git worktree remove --force ../juno-glass-a ../juno-glass-b`. |

The shared checkout at `/Users/liammagnier/Developer/project/juno` belongs to other sessions. Never build or commit there for this work.

## Done (commits on `mac/liquid-glass-chat`)

1. `532807d0` — the audit and the redesign spec.
2. `22894eb4` — **Phase 1:**
   - tokens, type, motion and fonts
   - the Phosphor/Juno icon pipeline, emitting custom symbols, with `npm run native:icons:check`
   - the shell: Chat/Code switch, one sidebar toggle, the title/subtitle/title menu, one toolbar, and the warm canvas
   - the rewritten sidebar and account footer
   - the empty chat ("How can I help, *Name*?" plus chips)
   - the one glass composer, with the handoff animation, in-shell dictation and voice, and private chat inline
3. `0c93f621` — merge of `origin/main` at `31ba2688`: the Juno Code rebuild, the Library mark, and the Cube models glyph.
4. `675a73f4` and `653c80b4` — **Phase 2 stage 1:**
   - the reply action row rebuilt to match the web: plain round 28pt buttons, Phosphor glyphs, five actions at rest, and model/cost moved into More › info
   - the user-turn chrome
   - the file split of `DesktopChatWorkspace.swift` into `ChatTranscript`, `MessageRow`, `MessageActions`, `InlineArtifactCard`, `SourcesPill`, `ActivityRow` and `FinishNote`
   - wire and store fixes: `regenerateInstruction`; attachments, cost and tokens kept on the finished message; the media placeholder cleared; `resume`, `work` and unknown frames tolerated
   - the offscreen snapshot harness with its test-host guard
5. `58d12b79` — merge of `origin/main` at `d0997af2` (Juno Code 1.6.0, build 87).
6. **Phase 2 stage 2, media and files inline** (the commit after `58d12b79`):
   - the attachment's stable `/api/files/<key>` path kept through sync and the `done` frame; `formatLabel` / `byteLabel` ported from the web
   - `NativeChatMediaLoader` (JunoChatKit): pictures, page previews, QuickLook/PDFKit page pictures, and whole files cached per account under Caches, purged on sign-out
   - `App/TranscriptAttachments.swift`: sent image tiles and 144pt page tiles above the bubble, produced-file tiles, generated pictures (fade-in, Edit · Download · Expand, drag out), generated clips, Quick Look and Save As hoisted to the conversation column
   - image Edit runs in the same conversation (`sendImageEdit`); a picture or video turn no longer stores its question twice, and no longer fails at `/api/generate`'s empty-titled `meta` frame in an existing chat
   - the generation placeholder's long-wait line, radius and announcements (shared with iOS)
7. **Phase 2 stage 3, artifacts, canvas and designs inline** (the commit after `60464ae9`; spec "Phase 2 errata" §6.5/§6.8, register 21–29):
   - stored rows: `ChatArtifactResolver`, the `done` frame's artifacts merged into the store at once, and unknown kinds or over-long versions skipped instead of blanking the store; designs draw and open only from the stored row (X-11)
   - the web's builders in a closed sandbox: `NativeArtifactRuntimeDocument` (HTML, CSS, SVG, Mermaid, JS console; React/TS/Python show Code while the network is closed), `NativeArtifactRuntimeWebView` with no network, status and console channels only, and the `juno-runtime:` scheme; policy `.inline`, thumbnails unchanged
   - a confirmation before regenerating a reply that carries artifacts
   - `InlineArtifactCard.swift` rewritten (Preview/Code/Console, status, sweep), `InlineDesignPreview.swift` (the server's SVG export, cached), `TrailingDock` replacing `DesktopArtifactDock`, and a canvas that follows the stored row and saves on top of the version it started from
   - Mermaid 11.12.3 bundled and registered; the figure restyled; `juno-visual` fences drawn (`JunoVisualBlock.swift`)
   - REACT → `ph.code`, DESIGN → `juno.design`; `DesignNode.cornerSmoothing` kept through a save

8. **Phase 2 stage 4, the rest of the transcript** (the commit after `2b1049c5`; spec "Phase 2 errata" §6.4–§6.15, register 30–38). The Tool calls & research rework's decisions (`juno-tools`, `docs/chat-rework/DECISIONS.md`; `SPEC.md` still a draft) win over the brief for the run, the panel and the sources, as its addendum says:
   - the reading style (`JunoProseStyle.reading`, 16/1.7, 75ch, demoted headings, inline code on `--muted`, the streaming tail fade instead of the caret), the code card (one selectable `Text`, `JunoSyntaxHighlighter`, gutter from 8 lines, 520 cap) and the card table with browser-like columns — the standard style (phone, Code, library) is untouched
   - the run block above each answer (`DesktopRunBlock`: `JunoRunSignature`, the web's status rungs, the two-slot peek, the settled summary, the inline timeline) and the Activity panel as `TrailingDock`'s second case (Timeline / Sources / Details)
   - per-message activity, the `done` frame's run, and thread hydration (`GET /api/conversations/{id}`) so sources and the run survive a reload; the rework's typed payloads decoded additively, today's rows through the legacy adapter
   - the sources pill (own-origin favicons, letters offscreen) and `[n]` citation chips with a popover when the corpus is `cited`
   - finish notes and the error box inside the turn, no `GroupBox` left in the transcript
   - follow-ups as opaque chips above the composer that send on click; scrolling that follows only at the bottom, with the Scroll to latest glass circle; ⌘F / ⌘G / ⇧⌘G find with neutral highlights
   - stream resume (`/api/chat/stream/{id}?after=seq`, and `/active` on open and on reconnect)
   - the Mac approval card above the answer, refusal first, nothing on `.defaultAction`

9. **Phase 2 review** (the commit after `0f5281cd`; spec "Phase 2 errata", "Phase 2 review", register 39): a conformance pass over the brief's acceptance lists and spec §6 / §10.2.
   - outline buttons (Continue, Retry send, "Allow this action for this connector") no longer inherit the column's coral tint; "Not sent" is SF, not mono
   - the transcript gutter follows the column (16 / 24 / 32 at 640 and 1024), as §6.1 asks
   - the version pager pages a turn's earlier versions (`GET /api/messages/{id}/versions`), showing each one's own words, model, tokens and sources; Copy, Quote, Read Aloud and Edit act on the page shown
   - a design is drawn on a desk tone with a frame edge, so a white frame no longer vanishes into the white sheet
   - harness: capsules draw without the `render(in:)` end ticks; `FinalSnapshotTests` (`JUNO_FINAL_SNAPSHOT_DIR`) renders window compositions over the preview world, the composer's glass as its Reduce Transparency recipe (`junoSnapshotOpaqueGlass`) and the sidebar on `--sidebar`

10. **Phase 2 stage 4b, the tools rework's final design** (the commit after `ff906c12`; spec "Phase 2 errata", stage 4b; register 40–42), against `juno-tools` `docs/chat-rework/SPEC.md` at `f1badf26`:
   - the Mac always sends `clientFeatures` (all five), `timeZone` and `locale`, and decodes **both** grammars through one stream reducer (`NativeTurnStream`: the store, the private chat and Compare) — rounds, declared and held commentary, the terminal `handoff`, the whole `ToolCallRecord`, `segment`, `commentary`, `fact`, `notice`, `sources[].origin`; tests feed recorded profile-1 bytes and hand-built timeline bytes through the real client and the reducer (`NativeTurnStreamTests`)
   - `NativeToolPresentation` mirrors SPEC §3.8 / §7.6 (phrases with argument nodes, failure phrases, notices, connector failures, the summary grammar: "Thought for" whenever the run reasoned or ran a call)
   - the run block per SPEC §7 (Concept A signature on the SPEC's keyframes, the sweep, pacing, the peek with still rings, inline commentary, stall and escalation captions, one loop owner, warning as the only failure ink) and the Activity panel per §8 (`DesktopPanelShell`; Timeline / Sources / Details with Forget)
   - Research without levels, the research row and plan card in the transcript, the Research panel in the dock (one of canvas / Activity / Research at a time), research followed by polling `/api/research/{id}`, research answered in the chat shown the same way, "Research this"
   - bootstrap `chat.clientFeatures`; `juno-native-v1.yaml` gains `chat` and the §2.13 documentation
   - the inline HTML card sizes its preview to the page (`juno:size`) and fills with the page's ground: no white band
   - snapshots in `/tmp/juno-glass-snapshots/stage4b/transcript/`

Every stage above built and passed at its commit:
- Mac build, JunoDesktopTests (175) and the iOS build
- the JunoNativeKit and JunoCode package tests
- all design gates: tokens, icons, contract, type, motion, glass and targets

## Next, in order

1. Before the next stage, merge `origin/main` again if it has moved. Regenerate rather than hand-merge:
   - tokens: `npm run design:tokens`
   - icons: `npm run native:icons`
   - Xcode projects: `native/Scripts/generate-projects.sh`
2. *(done — stage 2, above)*
3. *(done — stage 3, above)*
4. *(done — stage 4 and stage 4b, above)*. The Mac speaks the final SPEC's grammar and always declares it; nothing waits on the server shipping it.
5. *(done — Phase 2 review, above; the final snapshot set is in `/tmp/juno-glass-snapshots/final/`, the transcript suite under `final/transcript/`)*.
6. **Phase 5, Work merged into Chat** (spec §11 Phase 5; runs before 3 and 4, per the errata). Covers `conversationID` on work sessions, "Do This as a Task", run cards, the Needs-you fold, notifications, and deleting `DesktopWorkWorkspace`.
7. **Phase 3:** popovers, menus, sheets and Settings. This includes the ⌘K panel, the share popover, the toast host and the menu bar.
8. **Phase 4:** secondary pages on the `JunoPage` template, plus Skills, Automations, Permissions and Assistants.
9. **Phase 6:** sync tooling. Consumption tests, the shell contract, the wire schema, the parity ledger and CI gates.
10. **Ship**, when everything is done. The owner's standing instruction:
    1. Merge into `main` and push. Ask the other sessions first, and gate the exact tree.
    2. Deploy with `deploy/deploy-from-mac.sh`.
    3. Bump to **1.7.0 / build 88** in `native/Config/Base.xcconfig`, `package.json` and `package-lock.json`.
    4. Run `native/Scripts/release-macos.sh 1.7.0 --publish-dev` from a clean worktree of main.

    If `gh` still fails its TLS handshake, put `/Users/liammagnier/Developer/project/juno-release-tools` first on `PATH`; that holds a reviewed curl stand-in for `gh`. From 1.6.0 on, installed ad-hoc apps read `?channel=next`, so the prerelease reaches them without promotion. Production now has `JUNO_RELEASES_GITHUB_TOKEN`.

## How to resume the automation

The Phase 2 workflow script is at:
`~/.claude/projects/-Users-liammagnier-Developer-project-juno/a645690b-6552-4335-aa0f-8149e2f4596b/workflows/scripts/juno-mac-glass-phase2-wf_ced229b0-4b1.js`

Resuming it with `resumeFromRunId: "wf_ced229b0-4b1"` replays the finished merge and stage 1 from cache and starts at stage 2. The resume is only valid in the same Claude session. From a new session, copy the script, drop the merge and stage-1 agents, and pass their summaries from this page instead.

- Do **not** send messages to a running workflow agent. That starts a second copy in the same worktree.
- Give agents the liveness rule already in the script: long commands go in the background, and polling keeps them visibly alive.

## Other sessions' paused work that feeds this one

- **Artifacts & Design audit.** Branch `wip/artifacts-design-audit`, handoff at `docs/design/artifacts-design/HANDOFF.md`. It has a section of verified findings on how the Mac renders artifacts and designs. Read it **before Phase 2 stage 3**.
- **Tool calls and research features audit.** Local branch `web/tools-thinking-research` in the worktree `/Users/liammagnier/Developer/project/juno-tools`; WIP commit `2056b095`, handoff at `docs/chat-rework/HANDOFF.md`. It covers the web's tool calls, thinking and research. Read it **before Phase 2 stage 4**, which covers the activity row, Thought panel and sources, and **before Phase 5**, which covers research run cards.
- **Juno Code redesign and audit.** Its work is on `main` (1.6.0). Its records are in `docs/native/code-rework/`.

## Verification rules

- **No screen capture or screen control** (the owner's rule). Verify visuals with offscreen snapshots only:
  - `npm run native:snapshots:transcript`, which writes to `/tmp/juno-glass-snapshots/…`
  - or JunoDesktopTests with `JUNO_SNAPSHOT_DIR` set (the transcript fixtures) and/or `JUNO_FINAL_SNAPSHOT_DIR` (the window compositions: transcript beside the sidebar, the empty chat, the sidebar), each passed through xcodebuild as `TEST_RUNNER_…`
- Never run the UITests target.
- **To let the owner try a build:**
  1. `git archive <commit> native | tar -x -C /tmp/jg-preview`
  2. `xcodebuild … -configuration Stable … CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= build`
  3. `open -n` the `.app`

  Stable shares the signed-in session with `/Applications/Juno.app`; Debug does not. The last preview build is Phase 1 (`/tmp/jg-preview2-dd`).

## Open items carried forward

- **Newsreader italic.** Regular Italic is not bundled, so the greeting's name uses Medium Italic. Adding `Newsreader24pt-Italic.ttf` would match the web; downloading it needs the owner's permission.
- **Composer line height.** The composer field draws 19pt lines instead of 24pt. Fixing it needs a text-view-backed field.
- **Localization.** New copy is not yet in `Localizable.xcstrings`.
- **Page toolbars.** *(Resolved by the foundations stage: Library, Connections and Search moved their controls into `JunoPage`'s controls row; no Chat-window page declares `.toolbar` or `.searchable`.)*
- **Runtime checks not done yet:**
  - the Blue-accent sweep: switch, sidebar selection, Quick Entry, the Private toggle
  - the §0.5 crash repro: 50 Chat↔Code swaps with a popover open
  - keeping an older reply's action row visible while its menu is open
- **Stage 2 runtime checks not done** (screen control is off): Quick Look opening from a click and from Space, Save As… writing the file, a picture dragging out to the Finder, a real `/api/generate` reply going from placeholder to picture with no blank frame, the edit sheet streaming its result into the same chat, and a generated clip playing once downloaded. A clip is fetched whole (51 MB ceiling); an `AVAssetResourceLoaderDelegate` over `/api/files` Range requests is the follow-up.
- **Stage 3 runtime checks not done** (screen control is off): a link in a preview opening the browser, `alert()` as a sheet, a page's download through the save panel, the canvas Save producing v2 through `POST /api/artifacts/{id}`, a design editing in the dock, the regenerate confirmation, and a real `/api/design/{id}/export?format=svg` answer. `ArtifactRuntimeSandboxTests` does run scripted pages in the real sandbox (offscreen), and the snapshots draw it from offscreen stills.
- **Stage 3 follow-ups:**
  - **React, TypeScript and Python previews need bundled runtimes.** The sandbox has no network (brief addendum), and React 18 UMD, `@babel/standalone` and Pyodide are not in the repo or on this machine; downloading them needs the owner's permission. Serve them over `juno-runtime:` with a sha256 manifest, then let `runsOnThisMac` pass them. A bundled Tailwind would restore Tailwind-class pages the same way. Opening the network instead (`ArtifactRuntimeNetwork.isOpen`) is the web's posture and needs sign-off.
  - An uncaught error in an HTML artifact reaches the Console as "Script error.": WebKit sanitises it for a document with an opaque (nil-base) origin. Loading with a `juno-runtime://artifact/` base URL gives the real message (tested), at the cost of the opaque origin the brief asked for — for sign-off.
  - The library's Canvas mode (`ArtifactCanvasView`) still runs in the isolated sandbox; the library itself (list/grid, unsaved-edit guard, delete landing in another artifact) is the audit's, not this stage's.
  - The hosted design editor's own problems from the audit are untouched: the stale bundle, the missing primitive CSS, the indigo host tokens, the embedded layout, Export and the Image tool (mac-design-4 to -8, -11 to -13).
  - Mermaid was taken from an unmodified local copy of the upstream `dist/mermaid.min.js` (provenance and hash in `Resources/ArtifactRuntime/README.md`); replace it with the npm tarball's file when it is next updated.
  - No element inspector or "View last good version" in the canvas yet (the web has both).
- **Stage 4 runtime checks not done** (screen control is off): scrolling up mid-stream stopping the follow and showing Scroll to latest (and its glass, which the offscreen harness cannot draw), ⌘F / ⌘G from the menu with a real transcript, a citation popover opening at the click, a favicon arriving, a follow-up chip sending, killing the network mid-stream and watching `after=seq` resume, reopening the app mid-answer, the Activity panel following a reply as its id changes, and an approval card's buttons.
- **Stage 4 follow-ups:**
  - **Toasts.** A failed action on a reply shows the error box for six seconds until the toast host (Phase 3). Forget in the Activity panel has no Undo toast yet for the same reason.
  - **Citations** draw the number without the source's logo (a `Text` run cannot hold an image that arrives later); the logo is in the popover.
  - **Offscreen stroke artifact** — fixed in the harness (Phase 2 review): `CALayer.render(in:)` drew continuous-corner capsules with a tick at each end; the renderer draws those layers with circular corners before photographing.
  - **New copy** is not in `Localizable.xcstrings`.
- **Phase 2 review, still open:**
  - React, TypeScript and Python previews and Tailwind-styled pages (brief §5.6) — the runtimes must be bundled (downloading needs the owner's permission) or the network opened (needs sign-off).
  - The version pager is unit-tested (client, decoding, the page's view) and drawn at rest (`reply-actions-versions`); stepping back through it against the live server is a runtime check still to do.
  - The sidebar's glass, the toolbar and the composer's glass are not in any offscreen picture; the final set says what stands in for each.
  - *(built in stage 4b)* the brief's "tools SPEC is final" update.
- **Stage 4b runtime checks not done** (screen control is off; the server does not ship the timeline grammar yet): a real timeline stream (held text, a commentary round leaving the answer, a record re-sent in place), a real `handoff` and the run's polling, Start / Cancel on a real plan, Pause / Finish now / Cancel on a real run, "Research this" sending, Forget from the panel, an approval answered from the panel's row, the page-sized artifact card with a live web view, VoiceOver hearing the phase announcements.
- **Stage 4b follow-ups:**
  - `contracts/capabilities` does not yet gain `chatClientFeatures` / `toolCallStatuses` (SPEC §2.13): that JSON also feeds the web's `effective-capabilities.ts`, so it waits for the rework's merge rather than moving the web's contract from this branch.
  - The plan card has no question editing, clarification answers, "Update plan", or the "Notify me" line; the composer has no "Ask Juno | Guide the research" switch and no `/steer` (SPEC §9.7); the Research panel's Details shows no spend (the SPEC wants EUR in the plan currency, which needs a conversion the Mac does not have). Completed runs arrive through sync; there is no `juno:research-finished` watcher or notification yet (Phase 5 owns notifications).
  - Bootstrap's `chat.clientFeatures` is read and kept on the sync coordinator but nothing in the UI branches on it yet (the hand-off frame itself says research ran in the background).
  - The run line's facts and counts are SF with tabular numerals rather than the SPEC's mono caption (register 40).
- **Gap under the user bubble.** It is about 60pt. That matches the web, which reserves the hover-action row, so it is kept for parity. The owner may prefer it tighter.
- **Code-owned leftovers.** Code's own header strip still has a second sidebar toggle, and `DesktopCodeAccountFooter` hard-codes "Pro". They belong to the Code session.

---

## Update: paused again, 2026-09-23 evening (the owner's usage limit)

**Committed since the first pause** (all on `mac/liquid-glass-chat`, unpushed, working tree clean):

- `58d12b79` — merge of `origin/main` at `d0997af2` (Juno Code 1.6.0, build 87).
- `1ca63efb` — stage 2: files and pictures inline.
  - user image and PDF tiles
  - generated images and video
  - Excel and PowerPoint cards with Quick Look
- `2b1049c5` — stage 3: artifacts, designs and diagrams inline.
  - the WKWebView runtime
  - Preview/Code/Open, into the canvas dock
  - designs loaded from the stored row (fixes X-11)
- `0f5281cd` — stage 4: the rest of the transcript.
  - prose, code and tables
  - sources and citations
  - notes and errors
  - follow-ups
  - scrolling, ⌘F and stream resume
  - approvals
- `ff906c12` — Phase 2 review.
  - neutral outline buttons
  - the version pager
  - the column gutter
  - final snapshots in `/tmp/juno-glass-snapshots/final/`
- `39a35eba` — stage 4b: the tools rework's final design (`juno-tools/docs/chat-rework/SPEC.md` §2, §7, §8).
  - `clientFeatures`, `timeZone` and `locale` sent on every request
  - one reducer (`NativeTurnStream`) that reads both the production and the timeline grammar
  - the §3.8 copy table
  - the run block with the Concept A glyph and the fold to "Thought for 12s · … ›"
  - the Activity panel (Timeline / Sources / Details)
  - Research with no levels (row, Research panel, "Research this" chip)
  - the HTML preview's white band fixed

**Stopped mid-run:** workflow `juno-mac-glass-phase5`, run `wf_6d6ce0b7-180`.
- The script is at `~/.claude/projects/-Users-liammagnier-Developer-project-juno/a645690b-6552-4335-aa0f-8149e2f4596b/workflows/scripts/juno-mac-glass-phase5-wf_6d6ce0b7-180.js`.
- Already finished and cached: stage 4b and the four Phase 5 research readers (web work, web research, Mac work, Mac shell).
- Interrupted: the Phase 5 brief writer (`brief5`). It had written nothing.
- **To resume in this session:** `Workflow({scriptPath, resumeFromRunId: "wf_6d6ce0b7-180"})`. The finished agents replay from cache, and the brief, stages A–D and the review then run.
- **From a new session:** the research reports are in the run's `journal.jsonl` under `~/.claude/projects/…/subagents/workflows/wf_6d6ce0b7-180/`.

**Next after Phase 5:**
1. Phase 3: popovers, menus, sheets and Settings.
2. Phase 4: pages.
3. Phase 6: sync tooling.
4. Merge `main` again, then ship as 1.7.0 (build 88).

**Waiting on the owner:**
1. Permission to download and bundle the browser runtimes that React, TypeScript and Tailwind artifact previews need: React 18 UMD, @babel/standalone and the Tailwind browser build, from jsDelivr. Until then those previews show code only.
2. Permission to download `Newsreader24pt-Italic.ttf` from Google Fonts, so the greeting's italic matches the web.
3. Whether the server should stop hard-deleting a reply's artifacts on regenerate (`src/app/api/chat/route.ts:2566-2574`); the web is affected too.

**Peer work to re-read on resume:**
- `wip/artifacts-design-audit` has moved past `8d4def72`: it adds `03-COMPETITIVE-AUDIT.md`, `04-MERGE-PLAN.md` and an updated `HANDOFF.md`. The Mac findings in `02-AUDIT-MAC.md` are unchanged.
- The tools rework's `SPEC.md` is final at `f1badf26`.

**Preview build for the owner:** `/tmp/jg-preview3-dd/Build/Products/Stable/Juno.app`, built from `ff906c12` (Phase 2).

## Phase 5 slice, 2026-09-24 (Work in Chat: start, watch, answer)

A small Phase 5 slice. It was done frugally because the owner's weekly usage was nearly spent. The branch is still unpushed.

**What landed:**
- `786c7bd6` — API and data.
  - `WorkSessionSummary` now carries `conversationID`, `projectID` and `createdAt`.
  - `NativeWorkClient.createSession(… conversationID:projectID:)` and `sessions(conversationID:projectID:…)` are added, and the OpenAPI create schema and list parameters match (the Swift contract was regenerated).
  - `NativeWorkModel.startTask(… conversationID:projectID:)` includes both in its retry key.
  - `NativeWorkModel.followConversation(_:)` opens a chat's newest task. The newest is chosen by `createdAt`, through `newestSession(in:conversationID:)`.
  - **Fix:** Stop now sends `action: "cancel"`. The web route accepts only `pause | resume | cancel`, so the old `"stop"` got a 400.
  - Tests: `JunoWorkKitTests/NativeWorkConversationTests`.
- `da512b74` — Composer.
  - The `+` menu has a "Do This as a Task" toggle (`JunoIcon.task` / `ph.treestructure`). It is mutually exclusive with Research.
  - While it is on, a "Task" mark shows first in the field, and the send disc reads "Start this as a task".
  - `ChatComposer.dispatchTask` follows the web's old order:
    1. make sure the conversation exists (it never uses a pending id)
    2. `NativeConversationModel.appendUserTurn(conversationID:prompt:clientID:…)` appends the turn and asks for no reply; the composer holds the client id so a retry reuses it
    3. `startTask(conversationID:projectID:)` creates the session and starts the run, reusing one idempotency key across retries
- `a709617f` — the inline run card.
  - The new `App/ChatWorkRunCard.swift` has:
    - `ChatWorkRunState`, read from `NativeWorkModel` plus `DesktopWorkHostModel.localApprovals`, local approvals first
    - `ChatWorkRunCard`, opaque per §6.8: `junoCard`, radius 20, hairline, no glass, and coral only on the live dot
    - `ChatWorkStatusPill`
    - `ChatWorkQuestionCard`, with one-press options and "Reply Below", which sends the new `ChatComposerRequest.Kind.focus`
    - `ChatWorkApprovalCard`, per §6.9: Don't first, then the action's verb, with More › "…, and Stop Asking" when a standing grant is allowed; nothing is bound to `.defaultAction`
  - `WorkQuestionPrompt` gained `options`, `why` and `askedAt`, read from the `question_asked` payload.
  - The legacy Work window's private approval card was deleted, and the window now uses `ChatWorkApprovalCard`.
  - `DesktopTranscript` draws the card after the transcript for the chat's followed task. `DesktopChatWorkspace` follows the chat's newest task through `.task(id:)`.
  - Approvals from a run on this Mac go through `localApprovalDecider`; the rest go through `NativeWorkModel.decide`.
  - With an empty field and a live task, the composer disc is Stop ("Stop the task"), which calls `stopOpenRun`. A streaming reply's Stop still wins.
  - Snapshots are in `Tests/Snapshots/WorkCardSnapshotTests.swift` (running, needs-approval, finished). Render them with `TEST_RUNNER_JUNO_SNAPSHOT_DIR=… -only-testing:JunoDesktopTests/WorkCardSnapshotTests`. The last render is in `/tmp/jg5-shots/work/`.

**Known limits of the slice:**
- The card goes at the end of the transcript, not after the reply that follows the task's turn (the web's `message-list.tsx` rule).
- Only one task is followed at a time. The legacy Work window and the chat share `NativeWorkModel.openSession`.
- A task turn sent while a reply is streaming is queued, and it dispatches as a task when released.
- Text typed during a live task sends as an ordinary chat turn. Steering (answer or instruction through the composer) is not built.
- A failed start leaves the appended turn in the chat and the words in the field. The error shows under the composer, and Send retries without a duplicate.
- The approval verb button is `.borderedProminent`, which renders in the system tint offscreen.

**Left for later (Phase 5):**
- the sidebar status dot and the Needs-you fold
- "How Often It Asks"
- the disclosure line and the delegation offer
- steering mode and pending steers
- "Change it…" and "Make all N" on approvals
- local blockers (Accessibility, Screen Recording) in the card
- deliverable tiles, Save as a Skill, and the Details dock
- the research card, the report window and research steering
- notifications and the dock badge
- the Projects Tasks tab
- deleting `DesktopWorkWorkspace.swift` and `.legacyWork`
- the web's `workHandoff` flag plus the `work` stream frame (`start_task`), which is how the web itself starts tasks now; see `.phase5-research/mac-shell.md` §0

**Verification at `a709617f`:**
- The Mac build and `JunoDesktopTests` pass.
- The iOS build passes.
- `npm run native:test JunoNativeKit` passes.
- The gates hold: tokens, icons, contract, `work:contract:check`, design, glass and targets.
- The targets gate went down from 303 to 299 because the legacy approval card was removed. It was not re-baselined.
- Step 4 of the slice brief (the sidebar dot) was skipped to save budget.

## Follow-ups received 2026-09-24, not built yet

- **Web parity: tasks are now started by the model.** The web no longer has a "Do this as a task" toggle; the chat model starts tasks itself (see `.phase5-research/mac-shell.md` §0). The Mac slice added the toggle, which diverges from the web. Next:
  1. Decode the model-started task frames/fields so tasks begun by the model get the inline card on the Mac.
  2. Then decide with the owner whether to keep the Mac toggle.
- **The approval card's verb button draws in system blue** in the snapshots. Apply the Juno accent tint to the card's prominent button, or check that the column tint reaches it.
- **Artifact type is immutable** (server branch `artifacts/r0-size-and-type` @ `db3766ab`, unmerged).
  - Re-emitting an identifier with a new type creates a new row, and the old row is retired as `{identifier}~{last 6 of id}`.
  - `ChatArtifactResolver` must mirror the web's `resolveArtifactTag` (`src/lib/chat-client-state.ts` on that branch):
    1. The candidates are the exact identifier plus every `{identifier}~*`.
    2. If there is one candidate, use it.
    3. Otherwise prefer the candidate whose `messageId` equals the tag's message.
    4. Otherwise take the newest candidate with `createdAt` ≤ the message's `createdAt`, or the oldest candidate if none qualifies.
    5. Open the chosen row by its own identifier.
  - `9161bcbc` also refuses designs whose expanded size is over 200k.
- **Artifacts and Design merge on the web** (branch `artifacts/merge-first-light`, worktree `../juno-artifacts-r0`, plan `docs/design/artifacts-design/04-MERGE-PLAN.md` "First light", unmerged).
  - The Design row leaves the sidebar, leaving Library · Projects · Artifacts.
  - `/design` redirects to `/artifacts?type=DESIGN`, and `/design/{id}` to `/a/{id}`.
  - Artifacts gets a New menu with design presets.
  - Designs are shown as server posters: `GET /api/artifacts/{id}/poster?v={n}` (owner) and `/share/{token}/poster`.
  - On the Mac:
    1. Keep `.design` decodable but route it to Artifacts filtered to Designs, with New design.
    2. Drop the Design sidebar row.
    3. Move `InlineDesignPreview` from the SVG export to `/poster` once the branch is merged.
- **X-02** changes `design-editor.tsx`. When the Mac's design-editor bundle is next rebuilt, the rails switch at 640 and 896 px of *editor* width. This bears on X-18: the inspector is hidden at the default window width.

## Merge of `origin/main`, 2026-09-24 (Agents, X-01..X-08, Research, tool-call hotfixes)

Two merge commits on `mac/liquid-glass-chat`: `origin/main` at `f905db81` (Agents on web, macOS and iOS; X-01..X-08; Research without levels; tool-call hotfixes), then `e5501f65` (Artifacts/Design "first light": Design becomes a type in Artifacts, `/a/{id}`, posters; web only, no native files). The second landed while the first was being resolved.

How the conflicts were settled:
- **Generated files were regenerated**, not hand-merged: `tokens.generated.ts` and `JunoGeneratedTokens.swift` (`npm run design:tokens`, now with main's eight `--agent-*` colours), `JunoNativeContract.swift` (`generate-native-swift-contract.mjs`), both icon catalogs (`npm run native:icons`). The pbxproj files needed nothing (`generate-projects.sh` left them unchanged).
- **`juno-glyphs.tsx`** keeps this branch's data-driven form. Main's new Agents face (`JunoAgentsGlyph`) moved into `juno-glyph-paths.ts` as the sixth drawing (`agents`, with an `eyes` part), so the web draws the same mark as before and the generator ships it as **`juno.agents`** (regular, bold, fill; outlined with `--outline-juno`).
- **`JunoIcon.agents` now wears `juno.agents`**, which is what the web's registry assigns (`app-icons.ts`: `agents: JunoAgents`). `ph.users` was worn by nothing after that, so it left the Phosphor set. Juno Code's Studio settings also use `.agents` for its Agent section, so that row now shows the face too.
- **Sidebar:** `.agents` is a navigation row after Design, in the web's order (Library · Projects · Artifacts · Design · Agents). The web's Agents fold (the roster as a sidebar section) is not built.
- **Main's Agents Swift**, which did not compile here: `NativeAgentHire.swift` and `NativeAgentProfile.swift` gained `import JunoCore` (for `JunoWorkPermissionPolicy`). Its three `.junoProminentAction()` buttons (glass, two of them inside sheets) are now `.borderedProminent` tinted `junoAccent`, which is what holds the glass gate at 37.
- The Agents roster renders inside the redesigned shell (fixture `window-agents`). Its visual redesign is track B.

Now actionable because of `e5501f65`: the "Artifacts and Design merge on the web" follow-up above. The branch is on main, so the Mac's Design row, `/design` routing and poster previews can follow it. Nothing was changed for it in this merge: the Mac still has its Design row.

## Foundations for Phases 3 and 4, 2026-09-24 (the shared layer both tracks build on)

What landed (spec "Foundations errata", register #46–52), all on `mac/liquid-glass-chat`:

- **Toast host** — `JunoDesignSystem/JunoToastHost.swift`. One `JunoToastCenter` per window (the Chat window's lives in `DesktopChatWorkspace`, drawn by `ChatDetail`; the Settings window has its own). Post with `@Environment(\.junoToast) var toast` → `toast(.success("…", action: JunoToast.Action("Undo") { … }))`; standing conditions with `.junoToastStatus(id:_:toast:)`; the Library-style selection bar with `.junoToastSelection(_:id:)`; the composer marks itself with `.junoToastAnchor()`. Wired: chat archive + Undo, the transcript's failed actions and confirmations, and the five old per-screen glass toasts (Library, Projects, Artifacts, design surface, Settings).
- **Page template** — `JunoDesignSystem/JunoPage.swift`: `JunoPage`, `JunoPageHeader`, `JunoPageControls`, `JunoPageSearchField`, `JunoPageMenu`, `.junoPageColumn()`. Library, Connections and Search are on it; nothing in the toolbar.
- **Routing** — every page destination sits in its own `NavigationStack` inside `ChatDetail` (`DesktopDestinationView.routed`); Agents pushes an agent's page. Track B moves Projects' detail (and automations, skills, hosts) onto `.navigationDestination`.
- **`JunoSegmented`** (`DesktopSegmented.swift` deleted), **`JunoEmptyState`** rebuilt (`.page` / `.panel`, `.empty` / `.error`), **`JunoConfirmation`** + `.junoConfirmation`, **`JunoInlineRenameField`** (the sidebar rows use it) — `JunoSegmented.swift`, `JunoEmptyState.swift`, `JunoListActions.swift`.
- **Prominent buttons** — `.buttonStyle(.junoProminent)` (`JunoButtonStyles.swift`) carries the Juno accent; cause and fix in the errata. New gate `npm run native:design:prominent` (in `native:design:check`, baseline 9 = Juno Code's own sites). Glass baseline re-locked 37 → 28, targets 303 → 291.
- **Snapshots** — `Tests/Snapshots/FoundationSnapshotTests.swift` (`JUNO_SNAPSHOT_DIR` → `<dir>/foundations/`), twelve fixtures in both appearances; package tests `JunoDesignSystemTests/JunoFoundationsTests.swift`.

How the two tracks split from here:
- **Track A (overlays, this worktree):** ⌘K panel, share popover, menus, sheets, Settings, Quick Entry — post toasts through the notifier, never draw one; use `.junoConfirmation` for destructive choices and `.junoProminent` for a sheet's one primary button.
- **Track B (pages, `../juno-glass-pages`, branch `mac/liquid-glass-pages`):** move Projects, Artifacts, Design, Memory, Agents' roster and the Phase 4 pages onto `JunoPage`; detail pages push; list rows rename with `JunoInlineRenameField`; the Artifacts view switch and the shared packages' segmented pickers move to `JunoSegmented` as their screens are rebuilt.

Runtime checks not done (screen control is off): a toast over a live composer (and its glass), hover holding it, Undo restoring an archived chat, a push and pop on the Agents page with the system back button (and the §0.5 crash repro with a popover open while pushing), ⌘R / ⇧⌘I from the new header buttons, focus landing in Search's field on ⇧⌘F, the controls row wrapping as the window narrows.

## Phase 4 brief, 2026-09-25 (track B)

`docs/native/MACOS_PHASE4_PAGES_BRIEF.md` is the plan for the pages track, written against the live web on `origin/main` at `fe0a501d`. Its §0 overrides spec §9 where they disagree.

**Stages:**
- **A:**
  - merge `origin/main` (push notifications, the Agents sidebar fold)
  - `ChatArtifactResolver` on the web's `resolveArtifactTag` rule
  - the Design row gone, with `.design` routed to Artifacts › Designs
  - server posters with an SVG-export fallback
  - Library, Projects, Artifacts and the design editor page
- **B:** Memory, Connections parity, Skills and Assistants.
- **C:** Automations (then `DesktopWorkAutomations.swift` is deleted), Permissions and host pages, Agents on the template, and the More menu in the web's order.

**What Track A has to wire** is in the brief's §0.4: the page router, the Skills model for the composer, the Devices rows, the share hook and the Archived Chats hook.

**Four questions for the owner** are in the brief's §8:
- the dead "Start chat" on Assistants
- the dead "Use in chats" on Connections
- editing only in the canvas
- the document inspector's entry point

## Phase 4 Stage C, 2026-09-25 (`mac/lg-p4c`: Automations, Permissions, Agents, More)

Built in `../juno-glass-p4c` from `1876f3ac` (Stage A1–A3), in parallel with Stages A4–A7 and B. Spec: "Phase 4 errata, Stage C" and register #57, #66–68, #71, #74–85 (the new numbers are renumbered at integration if A or B took them).

**What landed:**
- **Automations** — `App/DesktopAutomationsScreen.swift`, `App/DesktopAutomationPage.swift`, `App/DesktopAutomationEditor.swift`, `App/DesktopWorkPageParts.swift` (the shared row list, deal, More button, tag, run status pill, heading, note, skeleton rows). `DesktopWorkAutomations.swift` deleted; the legacy Work window shows the new list in its own `DesktopPageStack` and router.
- **Permissions and host pages** — `App/DesktopPermissionsScreen.swift` (+ `DesktopWorkHostRow`, `DesktopHostState`) and `App/DesktopHostPage.swift` (+ `DesktopHostSettings`, the chips). `DesktopWorkHostTile(layout: .onThisMac)` draws the tile's local sections for this Mac's page; Settings › Code is unchanged.
- **Agents** — the shared views on the template behind `#if os(macOS)` (`NativeAgentsScreen`, `NativeAgentPage`, `NativeAgentHire`, `NativeAgentsShared`), public `NativeAgentRoutePage` / `NativeAgentHirePage`; `App/DesktopAgentRoutes.swift` wires `.agent(id)` and `.newAgent(template:)`; the window's `selectedAgentID` follows the Agents stack both ways, and choosing the Agents row returns to the roster.
- **More** — `.assistants`, `.skills`, `.automations`, `.permissions` destinations; More is Assistants · Skills · Automations, then Archived Chats behind the `openArchivedChats` hook.
- **Packages** — `JunoWorkKit`: schedule fields, history, fire tokens, the `…Reporting` model API, `NativeWorkServerSentence`, `NativeWorkScheduleCopy` / `NativeWorkPermissionsCopy`, host detail / update / revoke on `NativeWorkClient`, `NativeWorkHostsModel`. `JunoDesignSystem`: `JunoPageHeader(caption:)`, `JunoEmptyState(…actions:)`. OpenAPI documents the new calls (`/work/hosts/{hostId}` GET/PATCH/DELETE, `/work/schedules/{scheduleId}` GET, `/work/schedules/{scheduleId}/token` POST/DELETE, `codeRuns`, the schedule's `runKind`/`codeConfig`/fire-token fields); contract regenerated.
- **Deleted** — `DesktopWorkAutomations.swift`, `DesktopTasksScreen.swift` (dead).

**Integration notes (shared files this lane touched):** `DesktopAccountScreens.swift` (`routePage`, the page switch, the agents plumbing), `DesktopChatSidebar.swift` (enum, More), `DesktopPageRoute.swift` (`desktopReplace`, `pathChanged`), `JunoDesktopConfiguration.swift` / `JunoDesktopRootView.swift` (`workHostsModel`), `JunoPage.swift` / `JunoEmptyState.swift` (additive; A and B may add the same — keep one), `DesktopDesignLauncherTests.swift` (More's expectation), the spec and this file. The snapshot suite is `PageSnapshotTestsC` / `PageFixturesC` with its own stub server (`StageCPreviewServer`) so it does not collide with A's or B's suites or with `PreviewSender`. The targets gate fell 291 → 284 (deleted files); the baseline was not re-locked here — integration re-locks.

**What Track A wires (additions to the brief's §0.4):** Settings › Devices lists `DesktopWorkHostRow`s and opens `DesktopPageRouter.shared.open(.permissions, route: .host(id))`; ⌘K opens Automations (`open(.automations)`), New automation (`open(.automations, route: .newAutomation)`) and Permissions (`open(.permissions)`); the sidebar's `openArchivedChats`; then deleting Settings › Code's "Juno Work" tile.

**Snapshots:** `/tmp/juno-glass-snapshots/phase4-c/pages/` — 18 fixtures × light/dark (automations list / empty / error / detail / paused detail / new / narrow list, permissions / empty, host this Mac / other Mac / revoked, agents roster / first hire / agent page / hire, window-automations, window-agents; the windows are also written under `$JUNO_FINAL_SNAPSHOT_DIR/pages/` when set).

**Not done / deferred (explicit):**
- Runtime checks at the screen (screen control is off): pushes and pops with the system back button, Run now, pause/resume, delete, token issue/revoke, a host switch, Revoke and Restore, hiring an agent, the Agents row resetting an open agent, More's menu, hover reveals.
- Offscreen artefacts, not bugs: switches draw their "on" track untinted in an offscreen (non-key) window; the window snapshots' sidebar is fixed on Chat, so More does not show its selected fill there.
- Skills and Assistants pages (Stage B) — More leads to a placeholder until the merge.
- Code automations are edited on the web (register #67); the "Code" segment of New automation is shown disabled.
- The spend hint does not name the usage window (register #77): no spend-window read on the Mac yet.
- History rows for sessions this Mac has not synced are inert (register #80).
- Phase 5: the Needs-you link on Permissions, deleting the legacy Work window and its host tile.

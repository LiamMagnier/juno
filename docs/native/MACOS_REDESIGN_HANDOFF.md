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
4. *(done — stage 4, above)*. When the tools session's `SPEC.md` is final, swap `JunoRunSignature` / the run line for its exact spec, and start sending `clientFeatures: ["timeline", "resume"]` once the server ships the typed timeline (the Mac already decodes it).
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
- **Page toolbars.** Pages still declare their own toolbar items (Library, Connections, Search). Phase 4 fixes this.
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
  - **The rework's final spec.** `SPEC.md` had no reviews when the stage ran; the run UI follows `DECISIONS.md` and the draft, behind `JunoRunSignature`. The tools session will message when it is final. `clientFeatures` is not sent yet.
  - **Toasts.** A failed action on a reply shows the error box for six seconds until the toast host (Phase 3).
  - **Memory used** is listed in the Activity panel without the web's Forget.
  - **Citations** draw the number without the source's logo (a `Text` run cannot hold an image that arrives later); the logo is in the popover.
  - **Offscreen stroke artifact** — fixed in the harness (Phase 2 review): `CALayer.render(in:)` drew continuous-corner capsules with a tick at each end; the renderer draws those layers with circular corners before photographing.
  - **New copy** is not in `Localizable.xcstrings`.
- **Phase 2 review, still open:**
  - React, TypeScript and Python previews and Tailwind-styled pages (brief §5.6) — the runtimes must be bundled (downloading needs the owner's permission) or the network opened (needs sign-off).
  - The version pager is unit-tested (client, decoding, the page's view) and drawn at rest (`reply-actions-versions`); stepping back through it against the live server is a runtime check still to do.
  - The sidebar's glass, the toolbar and the composer's glass are not in any offscreen picture; the final set says what stands in for each.
  - **The brief's "tools SPEC is final" update** (`0f7d7e13`, `31b26ef0`, landed while the review ran) is not built: always sending `clientFeatures` / `timeZone` / `locale`, decoding both grammars (the `handoff` frame, `ToolCallRecord`'s full field set, `fact`, `origin` on sources, the five warning notice codes), the Swift presentation-copy table for canonical tool ids (SPEC §3.8), and `chat.clientFeatures` on bootstrap. It is the next Stage 4 follow-up, against `juno-tools` `SPEC.md` at `f1badf26`.
- **Gap under the user bubble.** It is about 60pt. That matches the web, which reserves the hover-action row, so it is kept for parity. The owner may prefer it tighter.
- **Code-owned leftovers.** Code's own header strip still has a second sidebar toggle, and `DesktopCodeAccountFooter` hard-codes "Pro". They belong to the Code session.

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

Every stage above built and passed at its commit:
- Mac build, JunoDesktopTests (175) and the iOS build
- the JunoNativeKit and JunoCode package tests
- all design gates: tokens, icons, contract, type, motion, glass and targets

## Next, in order

1. **Merge `origin/main` again** (it has moved to at least `d0997af2`, the 1.6.0/87 bump). Resolve the conflicts and regenerate:
   - tokens: `npm run design:tokens`
   - icons: `npm run native:icons`
   - Xcode projects: `native/Scripts/generate-projects.sh`

   Never hand-merge generated files or `pbxproj`.
2. **Phase 2 stage 2, media and files inline** (brief §4):
   - keep the URL through sync and stream
   - `NativeChatMediaLoader`
   - user images and file page tiles
   - generated images and video
   - produced-file cards with Quick Look
3. **Phase 2 stage 3, artifacts** (brief §5):
   - the WKWebView runtime
   - the inline artifact card with Preview/Code/Console
   - the trailing canvas dock
   - inline Juno Design previews
   - Mermaid
   - the React and Design icon fixes
4. **Phase 2 stage 4, the rest of the transcript** (brief §6):
   - prose at 16/1.7
   - code and tables
   - the activity row and Thought panel
   - the sources pill and citations
   - finish notes and errors
   - follow-ups as opaque chips
   - scrolling and Scroll to latest
   - ⌘F find
   - stream resume
   - approvals
5. **Phase 2 review**, plus the final snapshot set in `/tmp/juno-glass-snapshots/final/`.
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
  - or JunoDesktopTests with `JUNO_SNAPSHOT_DIR` set
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
- **Version pager.** It pages over regenerated versions only once stage 4 hydrates the thread.
- **Gap under the user bubble.** It is about 60pt. That matches the web, which reserves the hover-action row, so it is kept for parity. The owner may prefer it tighter.
- **Code-owned leftovers.** Code's own header strip still has a second sidebar toggle, and `DesktopCodeAccountFooter` hard-codes "Pro". They belong to the Code session.

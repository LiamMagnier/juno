# Juno Code rework (September 2026)

Juno Code on the Mac was rebuilt in two passes: the agent runtime first, then
the product on top of it. This folder is the record.

| File | What it is |
|---|---|
| `01-AUDIT-RUNTIME.md` | The runtime as it was: agent loop, tools, permissions, sessions, extensibility, remote paths, bugs. |
| `02-AUDIT-UI.md` | The interface as it was, with file:line evidence for every problem. |
| `03-COMPETITIVE-AUDIT.md` | Claude Code, Codex, Antigravity, Cursor and nine others; what Juno adopted and what it did not. |
| `research/` | The sourced notes behind 03, one file per product, every claim dated. |

## 1. The runtime

Fixed, in the order the audit ranked them:

- **Sessions can no longer be bricked by an unanswered tool call.**
  `ConversationIntegrity` repairs the history before every request, on
  restore and on finish; a steer now waits until every call in the batch is
  answered; calls a run never reached get an explicit "not executed" result.
  Sessions broken by the old behaviour heal on their next load.
  (`JunoCodeRuntime/ConversationIntegrity.swift`, `AgentOrchestrator.swift`)
- **Sub-agents can never outrank their parent.** Write delegation is a `write`
  action the parent's mode decides; a child's mode is capped at the parent's;
  without a Git worktree, write delegation is refused, as the tool promised.
- **Device-queued tasks are capped** at the reader's remote ceiling (default:
  ask before changes), and they decode again — the server never sent the
  fields the client required, so no queued task had ever started.
- **Prompt caching** on Anthropic: breakpoints on tools, system prompt and the
  newest block. The context meter now counts cached tokens.
- **Thinking continuity**: signed thinking and redacted-thinking blocks are
  captured and replayed in stream order, including adaptive thinking that
  interleaves reasoning between tool calls.
- **OpenAI Chat**: parallel tool calls are one assistant message.
- **The plan's own 402 is not a provider outage**: no retry, no fallback, and
  fallback to another lab's model is now opt-in.
- **Compaction works on a single long request** (it could only cut at user
  messages), keeps the newest notes, and folds earlier summaries in.
- **Tools**: `read_file` pages (`offset`/`limit`, 2,000-line default); command
  output keeps its head *and* tail; a new `web_fetch`; MCP tool names stay
  under providers' 64-character limit; `git_commit` asks, as it said it would.
- **A real system prompt**: environment facts, working rules, communication
  rules, the reader's own instructions ranked above repository files.

New, because every serious agent has it:

- **Settings files** layered the way Claude Code made familiar:
  `~/.juno/settings.json`, `<project>/.juno/settings.json` (shared),
  `<project>/.juno/settings.local.json` (personal, auto-ignored).
  (`JunoCodeCore/CodeSettings.swift`, `JunoCodeLocal/CodeSettingsStore.swift`)
- **Permission rules** — `Bash(npm run *)`, `Edit(src/**)`, `Read(.env)`,
  `WebFetch(domain:…)`, `mcp__server` — deny beats ask beats allow, chained
  commands checked per segment, deny and ask rules also check what runs
  inside `$(…)`, backticks and subshells, and destructive actions always ask.
  (`JunoCodeCore/PermissionRules.swift`)
- **"Always allow"** on the approval prompt saves the exact rule it shows.
- **Environment variables, network access and extra writable folders** per
  scope, applied to the next command without rebuilding the workspace;
  package download caches are writable inside the sandbox, and the folders
  that hold tools' binaries and settings never are (see §5).
- **Personal instructions** in `~/.juno/JUNO.md`; standing instructions in any
  settings file.
- **Turn limit, compaction threshold, co-author trailer, branch prefix** as
  settings.

## 2. The product

`JunoCodeUI/Studio/` replaces the workbench views. What the reader gets:

- **Three regions.** A session column; the landing composer or a thread; one
  side panel (Changes · Terminal) that is the window's inspector.
- **A thread that reads like a conversation.** Prompts in a quiet bubble,
  replies full width at 14pt, machine work folded into one sentence per
  stretch ("Read 4 files · ran 2 commands"), opened to the steps on demand,
  the step in flight shown live, and each run closed with *Worked for 2m 14s ·
  Review 3 files +34 −7*. No raw tool ids anywhere.
- **One composer**, shared by the landing screen and every thread: `/` and `@`
  menus, pasted and dropped images, a single mode ladder (Plan · Ask ·
  Auto-edit · Full access), the same model and thinking picker as Chat, steer
  or queue while working, Send and Stop in one place.
- **One approval prompt**: the exact command or file, *Decline*, *Say what to
  do instead*, *Always allow `Bash(npm run *)`*, *Allow* — ↩, ⌘↩ and esc.
- **Changes**: files with their diff stat, hunks unified or side by side,
  revert per hunk or file, comments that go back to the agent as one message,
  and Commit / Commit and Push / Create Pull Request.
- **Sub-agents** show inline with their own approvals, Stop, and Apply or
  Discard for a write-capable agent's worktree.
- **Notifications** when a run finishes or needs you, and the Mac kept awake
  while anything works.
- **Juno Code Settings**, its own window, eleven pages: General, Permissions,
  Environment, Instructions, Agent, Git, Tools & MCP, Appearance,
  Notifications, Keyboard, Advanced. Scoped pages edit any of the three files.

The visual rules (`Studio/StudioTheme.swift`): warm neutrals do the work;
the primary action is solid ink; coral means *working* or *needs you* and
nothing else; four status states where there were eleven; type at 14 / 13 /
12 / 11 with monospace only for code; one disclosure idiom; motion from
`JunoMotion` with Reduce Motion respected.

Removed: the six-pane inspector, the console drawer, four duplicate
composers, six approval cards, three transcript renderers, starter cards, the
sidebar filter and legend, and the Plugins / Security / Scheduled / Design /
Explore destinations (now Settings pages, or Chat's). About 15,800 lines out,
5,400 in.

## 3. Verification

- `swift test --package-path native/Packages/JunoCode`: all bundles pass,
  including new suites for turn integrity, permission rules, settings layering,
  compaction boundaries, request shapes and `web_fetch`.
- JunoNativeKit `JunoCodeKitTests`: all pass, including the device-task
  decoding fixes.
- `xcodebuild` JunoDesktop Debug and Stable: build. `JunoDesktopTests`: 119
  pass. UI-test targets compile against the new identifiers; they need a
  signed build and screen access to run.
- Visual review: `JUNO_SNAPSHOT_DIR=<dir> swift test --filter
  StudioSnapshotTests` renders the landing screen, five session scenarios,
  the side panel and four settings pages, light and dark, from an offscreen
  window. Icons are blank in those renders because the icon catalog ships
  with the app, not the test bundle.

## 4. Still open

- **Checkpoint rewind** of code *and* conversation to a turn (Claude Code's
  Esc Esc). Per-file restore exists; turn snapshots do not.
- **A model-written compaction summary.** The structural one is sound but
  loses nuance on very long runs.
- **Backend**: the agent proxy never records Code spend, and aborts after
  240s regardless of activity (`src/app/api/agent/[...path]/route.ts`).
- **Remote relay**: the Mac receives commands but never uploads its events,
  so a phone watching a Mac session sees an empty transcript.
- **Hooks** receive no JSON on stdin and cover four events; Claude-format
  hooks that read tool input will not work.
- **Session store scaling**: every session's events are decoded at launch.
- **Screen-control permission UI**: the old inspector's Computer Use pane
  (TCC status, screenshot preview) was removed with the inspector; starting
  and stopping screen control lives in the toolbar menu and the stop banner.

## 5. Security fixes (23 September)

Four holes in the permission system, each fixed with a regression test:

- **A substitution hid a command from the rules.** `echo $(curl …)` was one
  segment, `echo`, so a `curl *` deny rule never matched, and Full Access ran
  the command. The line was `critical`, and Full Access allows `critical`
  without asking. `ShellSegments` now keeps `$(…)`, backticks, `<(…)`,
  `>(…)` and subshells whole and returns their bodies at any depth. Deny and
  ask rules match those bodies too. Allow patterns never vouch for such a
  line; a bare `Bash` rule still does. The classifier grades each inner
  command and the line around it instead of stopping at `critical`.
  (`JunoCodeCore/PermissionRules.swift`, `CommandClassifier.swift`)
- **Toolchain "caches" held binaries the reader runs.** `~/.bun`, `~/.yarn`
  and `~/Library/pnpm` were writable whole, and so were `~/Library/Caches`,
  `~/.cache`, `~/.swiftpm` and DerivedData. Only download caches stay
  shared. Cargo, npm (which also holds `npx`'s packages), Go, node-gyp, pip
  and XDG caches go to `~/Library/Caches/JunoCode/CommandCaches`, which only
  sandboxed commands use. Every folder on the PATH Juno builds, `~/.deno/bin`,
  and the tools' settings files are denied after every grant, so no later
  allowance can reopen them. Xcode builds need a `-derivedDataPath` inside
  the workspace. SwiftPM builds without its user-level caches.
  Gradle, Maven and CocoaPods caches are still shared.
  (`JunoCodeLocal/CommandSandboxProfile.swift`)
- **Approve recorded the file as it was at the click.** It now approves only
  the bytes the Settings window read, refuses and reloads if the file changed
  since, and the window reloads whenever it becomes key.
  (`JunoCodeLocal/CodeSettingsStore.swift`, `JunoCodeUI/Models/CodeSettingsModel.swift`)
- **`web_fetch` followed redirects anywhere.** A redirect that leaves the
  approved host, or drops to plain http, now ends the fetch and names the
  new URL. The model's next call to that URL goes through the rules for that
  host. (`JunoCodeRuntime/Tools/WebFetchTool.swift`)

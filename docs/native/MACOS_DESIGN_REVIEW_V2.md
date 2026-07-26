# Juno for macOS — Design Review V2

Last updated: 2026-07-26

This review belongs to the greenfield `JunoDesktop` application. It does not
describe or compare against a deleted Mac app.

## Review principles

- Inspect the rendered app, not only source code.
- Capture light and dark appearances at compact, standard, and wide window
  sizes.
- Review Chat and Code with sidebars and inspectors both open and closed.
- Exercise loading, empty, offline, error, conflict, long-content, streaming,
  approval, terminal, diff, test, and Computer Use states.
- Verify accessibility structure separately from visual appearance.
- Record defects and evidence here; never turn an unrun scenario into a pass.

## Initial design decisions

- A single product switch owns Chat and Code.
- Chat uses one persistent sidebar, a flat transcript, and a restrained
  iPhone-style floating composer.
- The Chat model selector uses the website's provider/catalog/detail hierarchy,
  a fixed native popover size, search, clear availability/plan metadata, and the
  same provider marks as the website/iPhone asset catalog.
- Code is one studio rather than separate local/cloud/remote utilities. Its
  rail answers where the work is; Start answers what to do and where to run it;
  the canvas is reserved for the actual run.
- Ask, Plan, and Code are presented as Understand, Design, and Build in the
  launchpad, with their literal runtime names still visible. Read-only behavior
  is shown at selection time instead of being discovered after a blocked edit.
- Code integrates the shared native workbench rather than recreating its
  transcript, inspector, terminal, diff, and approval surfaces, but suppresses
  the workbench's standalone sidebar so there is never a duplicate rail.
- Navigation bars, toolbars, inspectors, menus, sheets, and popovers use native
  platform treatment.
- Reading and development canvases are opaque.
- The Juno mark and semantic palette come from current shared assets/tokens.

## Evidence

Interactive inspection at 1240×800 covered:

| Surface | Result | Notes |
| --- | --- | --- |
| Code Start | Pass | Clear Juno greeting, This Mac/Cloud/My devices target picker, one primary prompt, contextual controls, and useful task suggestions |
| Local Code session | Pass | One rail, readable transcript, compact Code/Inspector bar, floating follow-up composer, no duplicated sidebar |
| Local inspector | Pass | Stable explicit right pane; Changes is the default and the remaining development panes stay reachable |
| Code behavior | Compile/test pass; visual rerun pending | Ask and Plan enforce inspection-only tools and read-only editing; Code enables mutation and delegation |
| File editor | Compile/test pass; visual rerun pending | Workspace-contained native editor with explicit dirty, reload, conflict, read-only, and save states |
| Diff review | Compile/test pass; visual rerun pending | Unified and side-by-side layouts are separately selectable without hiding file selection; each hunk has real Keep/Revert state and checkpointed reversal |
| Git publish | Compile/test pass; visual rerun pending | Branch/upstream are resolved live, the exact target is confirmed, stale confirmation is rejected, and this control never force-pushes |
| Pull request / CI | Compile/test pass; visual rerun pending | Current-branch PR metadata and every reported check sit in the Git inspector with links and honest no-PR/unconfigured/error states |
| Preview / Computer Use | Compile/test pass; visual rerun pending | Preview has a real address/navigation lifecycle; Computer Use reports actual permissions, bounds, capture, journal, and emergency stop |
| Chat composer | Pass | Compact vertical input and bottom control row; model/reasoning/add/voice/send hierarchy remains legible |
| Model selector | Pass | Juno, Anthropic, OpenAI, Google, Moonshot, xAI, Meta, Mistral, and DeepSeek marks rendered from the shared provider assets |

The live captures were inspected during the automation session but have not yet
been checked into the repository. Durable light/dark compact/standard/wide
captures remain required before release.

## Defects found and resolved

- Nested split-view and inspector owners could enter an AppKit constraint loop
  and raise `NSGenericException`. Both desktop products now use stable explicit
  panes.
- Speech authorization inherited main-actor isolation even though TCC invokes
  its completion on a worker queue, producing a Swift executor assertion and
  `SIGTRAP`. The continuation bridge is now `nonisolated`.
- Code controls were distributed across a product switch, segmented utility
  picker, global toolbar, and detail forms. They now live at the point where
  they affect a task.
- The first Code integration could display both the studio rail and shared
  workbench sidebar. Embedded workbench mode now renders only the canvas and
  optional inspector.
- The local Code model selector originally passed canonical catalog identifiers
  directly to provider APIs. The bridge now resolves provider and wire model
  separately, and hides unsupported local-agent choices.
- Preview and Computer Use initially resembled controls without being backed by
  live state. They now expose the real URL/capture/permission lifecycle.
- Git stopped at commit preparation. The branch row now owns a compact
  Publish/Push action with a native confirmation dialog instead of hiding a
  remote-changing operation inside the agent or terminal.
- Review initially stopped at whole-file Accept/Undo. Hunk headers now own Keep
  and Revert actions in both layouts; reverting one hunk leaves and recounts
  the others.
- PR and CI results were reachable only on cloud-run cards. Local sessions now
  put the current branch's GitHub review state beside branch, commit, and
  publication controls.

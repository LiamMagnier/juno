# Juno for macOS — Product Specification V2

Date: 2026-07-26

## Product promise

Juno for macOS is one native workspace for conversation, research, agentic
work, and software development. It shares the same account, projects, models,
memory, files, artifacts, tasks, connectors, and synchronized history as the
website and iPhone app.

## Chat

- New and saved conversations with real production streaming.
- Model and reasoning controls from the account-specific manifest.
- Flat, readable transcript with Markdown, code, sources, reasoning, activity,
  feedback, branch, copy, and read-aloud actions.
- File/image import, drag/drop, Library reuse, project context, connectors,
  memory, private chat, Research progress, artifacts, and voice where the live
  backend supports them.
- Conversation search, pin/archive/rename, project placement, restoration, and
  conflict handling.

## Code

- Local sessions in user-granted workspaces.
- Explicit execution location and permission mode.
- Agent transcript, plans, subagents, approvals, terminal, files, changes,
  unified/side-by-side diffs, tests, Git, previews, checkpoints, and Computer
  Use.
- Cloud and device tasks with repository/device context, live ordered events,
  approval responses, cancellation, and PR results.
- Remote Host is explicit, observable, revocable, and shares no authority
  beyond the local session's existing permission model.
- Worktree sessions are isolated, named, inspectable, and cleaned up only by an
  explicit recoverable action.

## Supporting product surfaces

Projects, Files/Library, Artifacts/Canvas, Search, Connections, Tasks, Settings,
account usage, diagnostics, device sessions, saved prompts, Compare, and share
management are native destinations, inspectors, or windows. A control appears
only when its backing operation exists.

## Foundation acceptance milestone

The first milestone is accepted only when all ten statements are verified:

1. The new target builds.
2. The app launches.
3. Authentication completes through the system browser.
4. The account-scoped encrypted store opens.
5. Bootstrap and synchronization complete.
6. The real conversation list loads.
7. A real conversation opens.
8. A message streams from the production-compatible backend.
9. Chat and Code switch without losing scene state.
10. Light and dark appearances render from the shared semantic system.

Compile success alone does not satisfy items 2–8.


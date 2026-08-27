# Juno Code competitive product audit

Date: 2026-08-27

## Scope and evidence

The audited journey is: start or resume a coding task, understand its repository and permission context, follow agent progress, review changed files, and continue the task.

- Current Juno Code native preview: `01-juno-before.jpeg`
- User-supplied Codex task workspace reference: `02-codex-reference.png`
- Official Anthropic Claude Code 2.0 terminal reference: `03-claude-code-reference.png`
- Product capability research: official OpenAI Codex app/safety material and official Anthropic Claude Code documentation.

Claude Code was not installed on this Mac, so its visual comparison is based on Anthropic's official product image and documentation rather than an authenticated live session. Codex is represented by the user's direct app screenshot and official product documentation.

## Journey audit

| Step | Current health | Finding |
| --- | --- | --- |
| 1. Find or start work | Needs work | Juno exposes tasks, projects, pull requests, and connections, but the sidebar shows too many equal-weight rows at once. Active work, history, and project destinations compete instead of forming a scan hierarchy. |
| 2. Understand task context | Needs work | Repository, branch, status, permissions, goal, and model are all present, but split across a title strip, goal strip, transcript provenance, composer, and inspector. The first glance has no single answer to "what is running and what can it do?" |
| 3. Follow progress | Needs work | The transcript is technically complete, but prose and machine activity are visually flat. Long lines, small metadata, and repeated actor labels make the run harder to skim than Codex's narrative thread or Claude Code's compact status surface. |
| 4. Intervene safely | Good foundation | Stop, approvals, permission mode, model, attachments, voice, and slash commands are real. The composer is too shallow and control-heavy, so the most important action—describing the next turn—does not feel primary. |
| 5. Review and recover | Mixed | Juno has a real review canvas, file diffs, revert actions, tests, and git operations. These are fragmented between transcript rows and the Environment rail; review is not visually promoted as the natural completion step. |
| 6. Continue later | Mixed | Saved sessions and statuses are available, but the sidebar does not communicate continuity as clearly as Codex task threads or Claude Code resume/history/checkpoint concepts. |

## What the competitors do better

### Codex

- A strict three-part hierarchy: task navigation, readable thread, contextual environment rail.
- The task thread is the primary object; changes and review actions are attached to it rather than presented as another dashboard.
- Repository, branch, local environment, sources, review, and permissions are visible without overwhelming the transcript.
- Changed-file summaries provide a clear bridge from agent output to review.

### Claude Code

- Strong status visibility in a focused command surface.
- Searchable prompt history, resume/continue, permission modes, checkpoints, background tasks, hooks, and subagents make control explicit.
- Terminal density is high, but hierarchy is preserved through sections, spacing, and concise status copy.

## Redesign requirements

1. Make the task—not the chrome—the visual center of gravity.
2. Use a readable 760–820 point narrative column while allowing review/editor content to expand.
3. Merge task orientation and goal progress into one compact header.
4. Group machine activity into a quiet work log; give user prompts and completion evidence distinct surfaces.
5. Rebuild the composer in the Chat composer's language: a generous input area, one restrained tools row, and a stable send action.
6. Turn Environment into an action rail with a prominent review summary, repository/branch context, sources, and honest disabled states.
7. Reduce the default sidebar to active work plus a short recent list; keep full project/history access available without filling the viewport.
8. Keep Liquid Glass for floating, interactive chrome only. Reading, diff, and terminal surfaces remain opaque for contrast.
9. Preserve native selection, keyboard navigation, menus, VoiceOver labels, permissions, slash commands, attachments, voice, review, git, console, subagents, and preview controls.

## Accessibility risks to verify

- Minimum 44 point hit targets for icon-only actions.
- Secondary metadata contrast in light and dark appearances.
- Keyboard access to sidebar selection, composer controls, review, and inspector.
- Clear VoiceOver names for status, permissions, progress, diff statistics, and collapsed activity.
- Reduced-motion behavior for inspector, console, review, and jump-to-latest transitions.

## Implemented and verified

- Replaced the Code-only composer treatment with the same native floating Liquid Glass shell and 768-point reading measure used by Chat, retaining Code mode, permissions, model, context, attachments, slash commands, file references, voice, and stable send/stop actions.
- Reduced the default recent-session set and moved filtering into native sidebar search.
- Reworked the transcript hierarchy: user prompts and completion evidence are distinct surfaces, agent prose is no longer prefixed by a repeated actor label, and activity keeps a compact work-log treatment.
- Promoted review to the primary Environment action and kept repository, branch, source, git, and honest unavailable states underneath it.
- Tightened task orientation and goal progress around the same readable column as the transcript.

Verification evidence:

- 108 `JunoCodeUITests` passed.
- 43 Swift Testing tests passed.
- Native macOS Xcode build succeeded and produced `JunoDesktop.app`.
- Native design gates passed with zero new type, motion, Liquid Glass, or target-size violations.
- Runtime accessibility inspection confirmed the rebuilt task screen exposes task status, goal progress, composer field, Code behavior, permission mode, model, review, repository, sources, and toolbar actions.
- Runtime interaction checks opened Review, returned an honest empty-diff state, and opened the Code contract menu with Ask, Survey, Plan, Code, and all four permission modes.
- `04-juno-after.jpeg` was visually compared directly with the Codex reference at the same task-workspace level.

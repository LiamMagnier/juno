# Juno Code Agents — Product and Runtime Map

Research refreshed: 2026-07-26

## Product boundary

Juno is an equivalent agent workspace, not a wrapper around the Codex or Claude
Code command-line applications. A synchronized Juno task owns the conversation,
runtime choice, model, reasoning level, permission policy, events, approvals,
diffs, artifacts and result. The runtime slider selects the OpenAI/Codex or
Anthropic/Claude execution profile without splitting the user's workspace
history.

The existing Juno backend remains authoritative for identity, quotas, provider
keys, conversations and cross-device synchronization. Provider secrets never
move into the native clients.

## Researched capability map

| Capability family | Codex source | Claude source | Juno rebuild status |
| --- | --- | --- | --- |
| Local and cloud agents | Codex app and cloud documentation | Claude Desktop, web and remote control | Real local sidecar and existing cloud runner; shared task timeline |
| Parallel delegation | Subagents and worktrees | Subagents and agent teams | Real subagent manager, concurrent children, isolated write worktrees and approval-gated import |
| Permissions and review | Approval modes and code review | Permissions and plan mode | Plan, ask, auto-edit and full profiles; Mac approval dialog and audited events |
| Recovery | Git worktrees and session history | Checkpointing | Persistent sessions, per-turn checkpoints, diff and undo in the engine |
| Extensibility | Skills, plugins and MCP | Skills, hooks, MCP and custom agents | Engine architecture researched; management UI/runtime adapters remain future units |
| Browser and computer control | Browser and Computer Use | Computer Use and desktop workflows | Real session-scoped screenshot/click/type/key/scroll bridge; screenshots are ephemeral and input remains permission-gated |
| Automation and remote control | Automations and background/cloud tasks | Hooks, web tasks and remote control | Existing cloud task dispatch and cross-device controls; scheduled automation management remains future work |

## Implemented synchronized contract

Every `CodeTask` now stores:

- runtime: `codex` or `claude`;
- permission mode;
- selected provider model and reasoning effort;
- Computer Use request state;
- subagent enablement;
- device or cloud destination, repository/workspace, status, events and result.

Those fields flow through task creation, queue/claim, runner context, event relay,
the native bearer client and the shared sync entity payload. This makes the task
observable from macOS, iOS and the website even when execution moves between a
Mac device and the cloud.

## Current integrated boundary

- The current native `Chat` / `Code` switcher, `JunoCodeUI` workbench, previews,
  projects, library, artifacts, search and settings remain the Mac source of
  truth. This work deliberately extends that implementation instead of
  replacing it with a parallel shell.
- This unit adds the provider-neutral synchronized `CodeTask` profile and local
  sidecar support needed for a Codex/Claude runtime choice, permission profiles,
  model/reasoning settings, subagents and Computer Use request state.
- The existing native Liquid Glass implementation is preserved: macOS 26 uses
  Apple's `glassEffect`, `.glass` and `.glassProminent` APIs, while older
  supported systems use Apple system materials and controls.
- Development credentials and databases use an isolated namespace so unsigned
  debug builds cannot collide with production Keychain records.
- The current-main Safari authentication latch and explicitly `@Sendable`
  callbacks are retained on macOS and iOS, preventing an XPC callback from
  resuming the same continuation twice or crossing `MainActor` isolation.

## Explicit remaining boundary

This is compile-verified application work, not a signed release. Before claiming
complete parity:

1. wire the provider-neutral runtime selector into the current `JunoCodeUI`
   model controls, rather than introducing a second Mac workbench;
2. connect the session-scoped Computer Use sidecar to `JunoCodeRuntime`, with
   explicit user consent and macOS Screen Recording/Accessibility gates;
3. package, sign and live-test the local Node sidecar against both providers;
4. add the full Code Agent workbench UI to iOS (the data contract synchronizes);
5. add skills/MCP/hooks/automation management rather than only engine contracts;
6. run authenticated cross-device, UI, accessibility and release/archive tests.

## Primary sources

- OpenAI: <https://openai.com/index/introducing-the-codex-app/>
- OpenAI subagents: <https://learn.chatgpt.com/docs/agent-configuration/subagents>
- OpenAI Computer Use: <https://learn.chatgpt.com/docs/computer-use>
- OpenAI Browser: <https://learn.chatgpt.com/docs/browser>
- OpenAI worktrees: <https://learn.chatgpt.com/docs/environments/git-worktrees>
- OpenAI code review: <https://learn.chatgpt.com/docs/code-review>
- Anthropic feature overview: <https://code.claude.com/docs/en/features-overview>
- Anthropic subagents: <https://code.claude.com/docs/en/subagents>
- Anthropic agent teams: <https://code.claude.com/docs/en/agent-teams>
- Anthropic hooks: <https://code.claude.com/docs/en/hooks>
- Anthropic permissions: <https://code.claude.com/docs/en/permissions>
- Anthropic remote control: <https://code.claude.com/docs/en/remote-control>
- Anthropic web: <https://code.claude.com/docs/en/claude-code-on-the-web>
- Anthropic Agent SDK: <https://code.claude.com/docs/en/agent-sdk/claude-code-features>

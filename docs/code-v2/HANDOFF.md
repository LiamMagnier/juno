# Alevr Code v2 — handoff (PAUSED 2026-10-08 by the owner)

The owner asked, through the Deep Research session, to pause all work without losing anything. Workflow run `wf_69c7861a-818` was stopped mid-lanes. Every lane's work, including uncommitted WIP, is committed on its own branch. Nothing is pushed, merged into main, or deployed.

Plan and source of truth: `docs/code-v2/SPEC.md`.

## Branches / worktrees (all under `.claude/worktrees/`)

All lanes branch from trunk `code/v2`, which is based on polish/research-next 49a26fda.

| Lane | Branch | Worktree | State |
|---|---|---|---|
| spec + contracts | `code/v2` | `code-v2` | DONE: 141a0ca7 spec; 2a4ee4b6 contracts in TS, JSON Schema, fixtures and Swift, with a drift check; this handoff |
| design | `code-v2/design` | `code-v2-design` | DONE: DESIGN.md, INTERACTION_SPEC.md, mocks/*.html (f7b66088). PNGs in the session scratchpad `shots/design/`; may be gone, regenerate from the mocks |
| env server (BYO subscriptions) | `code-v2/env` | `code-v2-env` | MOSTLY DONE: aa97ac08 has the WebSocket server, JSONL log, provider registry/detection, Claude Agent SDK / codex app-server / ACP / Alevr adapters, checkpoints, worktrees, terminals and the Alevr MCP. WIP 21d4ef16 adds session-log/limits edits and a new test/ dir; not gated |
| orchestrator | `code-v2/orchestrator` | `code-v2-orchestrator` | agent-core part DONE with tests (73f2c9c6): background subagents, role routing, budget, workflow, best-of-N, steer/queue, guards. The **Swift engine role routing is probably not started**; check the lane |
| models + BYOK | `code-v2/models` | `code-v2-models` | DONE: tiers, catalogue, BYOK, /api/agent tiers and BYOK, role-routing API (702bbcf5). WIP abea790e is an untracked `src/components/library/library-nav.tsx`; check whether it belongs to this lane before integrating |
| computer use | `code-v2/computer` | `code-v2-computer` | MOSTLY DONE (8f7269d7): portable computer_use for every model, MCP bridge, desktop lock, overlay feed. WIP 223c77ba is ComputerUseDesktopHost.swift + an App edit; not built |
| web | `code-v2/web` | `code-v2-web` | IN PROGRESS: logic layer done with tests (11501ce5): reducer, env client, device link, dock, composer, keymap, diff, tiers, orchestrate, providers, BYOK client. WIP 436c0b76 is `src/components/code/v2/` (UI components, unfinished). Still to do: the /code/[id] route, the /dev/code-v2 gallery, screenshots |
| mac | `code-v2/mac` | `code-v2-mac` | IN PROGRESS: core logic plus sidecar, WebSocket client, BYOK stores, theme moved to shared tokens (08ec51eb). WIP ef9abbb5 is a contracts mirror edit. Still to do: Studio views on Liquid Glass, Connections page, inspector dock, snapshot tests |

## Next steps to resume

1. Relaunch with `Workflow({scriptPath: "/Users/liammagnier/.claude/projects/-Users-liammagnier-Developer-project-juno--claude-worktrees-code-v2/81047b4a-b86d-45a8-82b3-12ab9729f942/workflows/scripts/alevr-code-v2-wf_69c7861a-818.js", resumeFromRunId: "wf_69c7861a-818"})`. This only works in the same session. Otherwise write a continuation script: finish the web, mac, env and computer lanes (each reuses its worktree and continues from its branch tip), then integrate and review, as in the script's last two phases.
2. Lane prompts must quote the owner's request verbatim (see SPEC.md top) and say it's authorised.
3. Gate everything (`.claude/local-tools/chat-rework-tools/gate.sh`). Show the owner screenshots before any push.
4. node_modules in these worktrees are symlinks to `.claude/worktrees/polish-oct8/node_modules`. If that worktree is removed, run `npm ci` in `code-v2`.
5. Reference repos were cloned to the session scratchpad (`refs/t3code`, `refs/deepseek-harness`). Re-clone from GitHub if they're gone.
6. Before public release, re-verify the provider terms in `docs/code-v2/PROVIDERS-LEGAL.md` (on `code-v2/env`): Claude via the user's CLI, the official Antigravity ACP runtime, and Codex token sharing, which stays stubbed.

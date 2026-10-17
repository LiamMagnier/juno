# Design: subagents, multi-agent orchestration and the coding harness

Evidence: `docs/rea/evidence/subagents-and-harness.md`. This design is original. It learns from how Claude Code, Codex CLI, Codex-in-ChatGPT and the Claude desktop Code tab structure the problem, and it copies none of their code, prompts or strings. User-facing copy says **Alevr**, never Juno.

## 1. Alevr today

| Area | Where | State |
|---|---|---|
| Subagent manager | `runner/agent-core/src/subagents.ts`: `SubagentManager`, `SubagentSpec`, `SubagentConfig` (L164), tool list `SUBAGENT_TOOL_NAMES` (L281) | Strong. It has typed roles, delegate/spawn/send_message/interrupt/inspect/cancel, and spawn or fork context (L105, fork at L1845). Defaults are `maxConcurrent` 6 (L167, L700) and `maxPerTurn` 8, with a 400k-token child budget (L172) and a session `BudgetLedger`. **Depth is 1**: "Children cannot start further agents" (L359, L434). |
| Isolation and merge | `subagents.ts` L1699 (`git_worktree` / `shared_read_only`), with import into the parent around L2300+ | A writer's worktree diff is imported through permissions and conflicts escalate. Writers are refused outside git (L1749). |
| Teams, best-of, workflows | `subagents.ts` `runTeam`, `BestOfNRun`; `harness/workflow.ts`, `harness/workflow-guest.ts` | Present. Workflows run as a sandboxed JS script (6 concurrent, 40 total, 30-minute limit). |
| Harness | `runner/agent-core/src/harness/` (`budget.ts`, `context.ts`, `guards.ts`, `jobs.ts`, `auto-review.ts`, `routing.ts`, `spill.ts`, `instructions.ts`, `output-schema.ts`) | Present. Read-before-edit guard, repeat-call guard, background jobs, fail-closed auto-reviewer, per-role routing, spill to file. |
| Edit tools | `runner/agent-core/src/tools/fs.ts` | `edit_file` (exact unique str-replace, L174-225) and `write_file`. **No multi-file atomic patch.** |
| Shell sandbox | `runner/agent-core/src/tools/bash.ts`, `container-sandbox.ts`, `egress-policy.ts`; Mac `native/Packages/JunoCode/Sources/JunoCodeLocal/CommandSandboxProfile.swift` | Docker (`--network=none`) in the cloud, Seatbelt on the Mac. **No Landlock or bwrap for self-hosted Linux runners. No per-domain network approval in the TS engine.** |
| Checkpoints | `runner/agent-core/src/checkpoints.ts` (per-turn file snapshots, misses bash edits); `runner/env-server/src/git/checkpoints.ts` (hidden-ref git per turn), `folder-checkpoints.ts`, `line-diff.ts` | Two systems, with **no single rewind model that spans agents**. |
| Compaction and resume | `runner/agent-core/src/compaction.ts`, `session.ts` | Present: threshold 0.8, keep 6 steps, step-boundary cuts. |
| Permissions | `runner/agent-core/src/permissions.ts`, `permission-rules.ts` | Modes plan/ask/auto-edit/full plus `auto` with an AI reviewer. Rule layers user/project/local. |
| Hooks | Mac only: `native/Packages/JunoCode/Sources/JunoCodeRuntime/AgentLifecycleHooks.swift` | **Absent in the TS engine** (web/cloud runs). |
| MCP | `runner/env-server/src/mcp/*` (Alevr MCP server injected into vendor agents); Mac client in `JunoCodeRuntime/MCP/` | **No MCP client in the TS engine.** |
| Skills | `runner/env-server/src/skills/discovery.ts`, `runner/agent-core/src/skills/cloud.ts` | Present. |
| Worktrees | `runner/env-server/src/git/worktrees.ts`, Mac `WorktreeManager.swift` | Present, with `.alevr/worktree-setup`. **No cleanup script or handoff local↔worktree.** |
| Web UI | `src/components/code/v2/thread.tsx` (`TeamGroup` L303), `dock.tsx` (`AgentsPane` L664, `AgentDetail` L557), `team.tsx` | Agents tab and per-agent trace. **No steering controls, no tree view, no budget meter per agent.** |
| Crew, Orbit | `src/lib/agents/{team,rooms,goal-runner,budget}.ts` | Persistent agents, separate from Code. |
| macOS UI | `JunoCodeUI/Studio/StudioAgentsPane.swift`, `StudioRunMonitor.swift` | Agents pane and actionable banners. |
| iOS | `native/iOS/JunoMobile/App/JunoMobileCodeRemote.swift` (renders `.subagent` items, L641); `JunoMobileLiveActivities.swift` (voice only) | **Read-only. No Live Activity for agent runs, no approve/steer from the phone.** |

## 2. Gaps versus the evidence

1. **Recursion.** Codex allows sub-subagents behind a depth guard. Alevr is fixed at depth 1.
2. **Context inheritance** is binary everywhere (all or none). Alevr matches this, but nobody offers a curated middle option. This is an opportunity.
3. **Addressable peers.** Claude Code and Codex give agents names or canonical paths and let them message each other. Alevr children only talk to their parent.
4. **Observers and supervisors.** Claude Code has observer agents that get read-only digests. Codex has a Guardian reviewer session. Alevr's AutoReviewer judges approvals only and does not watch drift.
5. **A multi-file atomic edit** (Codex apply_patch) is missing.
6. **Linux sandbox and network approval** (bwrap/seccomp or Landlock, plus a domain proxy) are missing from the TS engine.
7. **Hooks and an MCP client** are missing from the TS engine. Web and cloud lag behind the Mac.
8. **Unified rewind** across agents and shell edits is missing. Two checkpoint stores exist.
9. **Worktree lifecycle.** There is no cleanup script, no move of a thread between local and worktree, and no warm worktree pool.
10. **Live agent UI.** ChatGPT shows an Active/Done panel with model and effort per agent, and Claude desktop wakes the parent when side sessions settle. Alevr's web has no steering. iOS cannot act at all.

## 3. Original design: "Alevr Crewline"

### 3.1 Core model (agent-core, shared by web, Mac and cloud)

- **Agent tree with budget envelopes.** Every agent node owns an envelope of tokens, cost (µUSD), wall-clock time and maximum children. A child's envelope is carved from its parent's remainder, never added on top, so the total spend of any subtree is bounded by construction.
  - Depth defaults to 2 and is configurable up to 3. Depth is allowed only while the envelope is above a floor, so recursion stops itself without a fixed refusal message.
  - Extends `BudgetLedger` (`harness/budget.ts`) with hierarchical scopes.
  - Adds a per-child wall-clock limit, which is missing today.
- **Three-way context inheritance.** `inherit: "none" | "brief" | "full"`.
  - `brief` is new. The parent's harness builds a **context capsule** of at most 4k tokens: goal, constraints, decisions, the file paths touched, open questions, and a pointer to the full transcript the child can page in with `read_parent_context(range)`.
  - This saves tokens compared with `full`, keeps much of `full`'s prompt-cache reuse when the capsule is a stable prefix, and avoids the cold start of `none`.
- **Addressable agents.** Each agent gets a stable handle (`@builder-2`, path `root/plan/builder-2`).
  - `send_message` can reach siblings, within an allowlist computed from the tree (siblings and parent by default).
  - Messages are queued and delivered at step boundaries. This matches the current steering semantics.
- **Hand-back contract v2.** On top of today's `SubagentPublicState`, add `claims[]`: each claim is a statement plus evidence (a file range, a command plus exit code, or a test id).
  - The parent's harness auto-verifies cheap claims: the file exists, the command was actually run according to the child's event log.
  - The UI shows "verified" or "unverified" badges, so the parent reconciles evidence rather than prose.
- **Sentinel (observer).** An optional low-cost agent receives compact activity digests for a whole subtree every N steps.
  - It can only emit `flag(severity, reason)`: drift from the goal, loops, scope creep, or risky commands.
  - Flags appear in the UI and can auto-pause a subtree if the user opts in.
  - Unlike approval-only reviewers, it watches trajectory as well as single calls.

### 3.2 Harness

- **`edit_files` (atomic multi-file patch).** One call carries N hunks across files, each anchored by exact context.
  - It is all-or-nothing: if any anchor fails, nothing is written and the error says which hunk drifted and why.
  - Each file must have been read first (FileStateGuard).
  - It keeps `edit_file` for single edits. This is an original format: JSON hunks, not a text envelope.
- **Sandbox tiers.** One policy object (`fs: read-only | workspace | full`, `net: off | allowlist | on`) compiles to:
  - Seatbelt on the Mac (existing profile, generalised);
  - **bwrap+seccomp, falling back to Landlock**, on self-hosted Linux runners;
  - Docker in the cloud (existing).
  - With `net: allowlist`, traffic goes through a local proxy (reusing `egress-policy.ts`). An unknown domain raises a **network approval card** for that domain, offering allow-once or allow-for-project.
- **Hooks in TS.** Port the `AgentLifecycleHooks` event set to agent-core: sessionStart, promptSubmit, beforeTool (can block or rewrite), afterTool, agentSpawn (can set model or budget, or deny), agentSettled, beforeCompact, afterCompact and stop.
  - Hooks from a project need a one-time trust review per source, with a hash pin that invalidates on change.
  - Hooks run inside the same sandbox tier by default. "Unsandboxed" is an explicit per-hook grant, which is stricter than the competitors, whose hooks run outside the sandbox.
- **MCP client in TS** (stdio and streamable HTTP), sharing the Mac's tool-naming and approval-template conventions. Per-agent `mcpServers` scoping.
- **Unified Timeline checkpoints.** A single `TimelineStore` keyed by `(agentPath, turn)` sits over the env-server hidden-ref git checkpoints, with folder manifests for non-git folders.
  - The agent-core snapshot store becomes a fast cache for files the agent wrote itself.
  - Rewind targets can be one agent's work, a subtree, or "the whole run to turn N".
  - A rewind preview shows files changed and insertions/deletions before applying.
- **Worktree lifecycle.**
  - A warm pool keeps 2 prepared worktrees per repo, created lazily.
  - `.alevr/worktree-setup` gains a sibling `.alevr/worktree-cleanup`.
  - **Move thread**: local→worktree carries uncommitted changes as a patch; worktree→local is a merge-queue import.
- **Merge queue.** Child imports into the parent checkout go through a serialised queue. Each import shows a 3-way preview, auto-resolves non-overlapping hunks, and asks only on true conflicts. Undo is per import through the Timeline.

### 3.3 Surfaces

**Web (Code v2)**
- The Dock Agents tab becomes a **collapsible tree** with live state chips (queued, working, waiting on you, settled, failed). Each node shows an envelope meter (tokens, cost, time) and its model and effort.
- Per-node actions: Message, Pause, Resume, Stop, Top-up budget, Open worktree diff, Rewind this agent.
- A **swimlane timeline** view (one lane per agent, steps as ticks) makes parallelism and stalls visible.
- Hand-back cards show claim badges and a "Merge" button that goes through the merge queue.

**macOS (Studio)**
- `StudioAgentsPane` adopts the same tree and actions.
- A **menu-bar crew HUD** shows the count of working agents, any agent waiting on approval, and the total spend. Clicking it opens the run.
- `StudioRunMonitor` notifications carry actions: Approve, Deny, Open.
- Hooks and sandbox settings get a trust review sheet.

**iOS (monitor and steer)**
- A **Live Activity / Dynamic Island** for each active Code run shows agents working/waiting, an envelope bar, and the latest flag. This needs a new Code activity type in `JunoMobileLiveActivities.swift`.
- **Actionable push** for approvals: Approve once, Deny, or Open. The device sends a signed decision, and the server re-checks the permission ladder, so the phone can never escalate beyond the run's mode.
- The run screen (`JunoMobileCodeRemote.swift`) shows the agent tree read-only plus **Steer** (send_message to any node), **Pause subtree** and a **Stop all** kill switch.
- App Intents: "Pause my Alevr agents" and "What are my agents doing?".
- No code editing on the phone. The phone is a supervisor seat.

## 4. Acceptance tests

1. **Envelope bound.** A root with a 200k-token envelope spawns 3 children, each of which spawns 2 grandchildren. Total charged usage is ≤ 200k plus one in-flight request per live agent. Spawns are refused once the remainder is below the floor (unit test on hierarchical `BudgetLedger`).
2. **Depth.** At `maxDepth=2`, a grandchild calling `spawn_agent` gets a tool error and finishes its task itself.
3. **Brief inheritance.** A child spawned with `inherit:"brief"` receives a capsule of ≤ 4k tokens containing the goal and touched paths. `read_parent_context` returns the requested range. Prompt-cache hit metrics are recorded.
4. **Sibling messaging.** `@builder-1` messages `@builder-2`. Delivery happens at the next step boundary. A message to a non-allowlisted path is refused.
5. **Claims.** A child claims "tests pass" with `{command:"npm test", exit:0}`. If its event log lacks that command, the claim is marked unverified.
6. **Sentinel.** A child that repeats the same failing command 5 times triggers a `loop` flag within one digest interval. With auto-pause on, the subtree pauses.
7. **edit_files atomicity.** In a 3-file patch where file 3's anchor is stale, no file changes and the error names hunk 3.
8. **Sandbox (Linux runner).** With `fs: workspace, net: off`, a write outside the workspace fails and `curl` fails. With `net: allowlist` and an unknown domain, an approval card appears, and allow-once permits exactly one connection window.
9. **Hooks.** A project hook is untrusted until reviewed. A `beforeTool` hook can block `rm -rf` with a message shown to the model. Editing the hook file re-requires trust.
10. **Timeline rewind.** After a builder edits via bash and via edit_file, "Rewind builder-2" restores both kinds of change and leaves sibling changes untouched. The preview counts match.
11. **Merge queue.** Two builders edit disjoint hunks of one file, and both auto-merge. Overlapping hunks produce a single conflict card.
12. **iOS approval.** A push approval from the phone for a run in `ask` mode is applied. A forged decision for an action that `plan` mode forbids is rejected server-side. The Live Activity updates within 5 s of a state change.
13. **Move thread.** Moving a local thread with uncommitted changes to a worktree preserves the diff byte-for-byte, and the local checkout ends up clean.

## 5. Prioritised backlog

| # | Item | Impact (1-5) | Effort | Platforms | Depends on |
|---|---|---|---|---|---|
| 1 | Hierarchical budget envelopes plus per-child wall clock | 5 | M | core (all) | — |
| 2 | iOS Live Activity plus actionable approval push for Code runs | 5 | M | iOS, server | — |
| 3 | Web Agents tree with steer/pause/stop/top-up controls | 5 | M | web | 1 |
| 4 | Hooks in TS engine with trust review and hash pin | 4 | M | core, web | — |
| 5 | `edit_files` atomic multi-file patch tool | 4 | S | core | — |
| 6 | Unified Timeline checkpoints and per-agent rewind | 4 | L | core, env-server, web, Mac | — |
| 7 | Merge queue with 3-way preview for child imports | 4 | M | core, web, Mac | 6 |
| 8 | Depth-2 recursion gated by envelope floor | 3 | S | core | 1 |
| 9 | `inherit:"brief"` context capsule plus `read_parent_context` | 4 | M | core | — |
| 10 | Sentinel observer agent (flags, optional auto-pause) | 3 | M | core, all UIs | 1 |
| 11 | Claims in hand-back v2 with auto-verification badges | 3 | M | core, web, Mac | — |
| 12 | Linux runner sandbox (bwrap+seccomp → Landlock) and network-approval proxy | 4 | L | runner | — |
| 13 | MCP client in TS engine, scoped per agent | 3 | M | core | 4 |
| 14 | Sibling messaging with tree-derived allowlist | 3 | S | core | 8 |
| 15 | Worktree warm pool, cleanup script, move thread local↔worktree | 3 | M | env-server, web, Mac | 7 |
| 16 | macOS menu-bar crew HUD and actionable notifications | 3 | S | macOS | 3 |
| 17 | iOS steer/pause/stop plus App Intents | 3 | M | iOS | 2 |
| 18 | Swimlane timeline view | 2 | M | web, Mac | 3 |

The suggested first wave is 1, 5, 2 and 3: bounded spend, a quick harness win, and the supervisor experience on the phone and the web. Build only after the owner gives a go-ahead and lanes are agreed in `.claude/handoff/LANES.md`.

# 05 — Code capability matrix

**Audit date:** 2026-07-16
**Decision:** compatible mission capabilities are committed scope and are classified `required-now` until their acceptance evidence exists.
**Product boundary:** workflow parity only. Juno must use its own information architecture, names, copy, symbols, colors, motion, and component design. No OpenAI or Anthropic logos, proprietary icons, screenshots, exact wording, pixel-identical layouts, or trade dress ship in Juno.

## Classification vocabulary

These are the only valid classifications:

- `required-now` — compatible with Juno and required by the mission, but not yet complete and proven. It is committed scope even when its delivery milestone is later than M1.
- `implemented` — present end to end in current Juno and backed by the stated tests/evidence.
- `adapted` — a deliberately Juno-specific equivalent is complete, tested, and documented.
- `blocked-with-reason` — impossible without a named external dependency, platform entitlement, or unresolved product decision; the blocker and unblock condition are explicit.
- `planned-with-owner-and-milestone` — genuinely optional follow-on work, never ordinary mission work. No row in this audit qualifies.

`required-now` is not a synonym for “future idea.” A row can move to `implemented` or `adapted` only after its exit evidence passes.

## Official capability sources

Feature claims in this document were checked on 2026-07-16 against official OpenAI and Anthropic documentation only. Juno source-code observations are separate and explicitly labeled.

### OpenAI Codex

- **O1:** [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- **O2:** [Agent approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security)
- **O3:** [Rules](https://learn.chatgpt.com/docs/agent-configuration/rules)
- **O4:** [Worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees)
- **O5:** [Code review](https://learn.chatgpt.com/docs/code-review)
- **O6:** [Integrated terminal](https://learn.chatgpt.com/docs/integrated-terminal)
- **O7:** [Scheduled tasks](https://learn.chatgpt.com/docs/automations)
- **O8:** [Build skills](https://learn.chatgpt.com/docs/build-skills)
- **O9:** [Plugins](https://learn.chatgpt.com/docs/plugins)
- **O10:** [Hooks](https://learn.chatgpt.com/docs/hooks)
- **O11:** [Model Context Protocol](https://learn.chatgpt.com/docs/extend/mcp)
- **O12:** [Repository instructions with `AGENTS.md`](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- **O13:** [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- **O14:** [Codex GitHub Action](https://learn.chatgpt.com/docs/github-action)
- **O15:** [Computer Use](https://learn.chatgpt.com/docs/computer-use)
- **O16:** [Remote connections](https://learn.chatgpt.com/docs/remote-connections)
- **O17:** [Image inputs](https://learn.chatgpt.com/docs/image-inputs) and [work with files](https://learn.chatgpt.com/docs/artifacts-viewer)
- **O18:** [Codex pricing and usage](https://learn.chatgpt.com/docs/pricing)

### Anthropic Claude Code

- **A1:** [Claude Code Desktop](https://code.claude.com/docs/en/desktop)
- **A2:** [Extend Claude Code](https://code.claude.com/docs/en/features-overview)
- **A3:** [Configure permissions](https://code.claude.com/docs/en/permissions) and [permission modes](https://code.claude.com/docs/en/permission-modes)
- **A4:** [Custom subagents](https://code.claude.com/docs/en/sub-agents)
- **A5:** [Checkpointing](https://code.claude.com/docs/en/checkpointing)
- **A6:** [Code Review](https://code.claude.com/docs/en/code-review)
- **A7:** [Desktop scheduled tasks](https://code.claude.com/docs/en/desktop-scheduled-tasks)
- **A8:** [Manage sessions](https://code.claude.com/docs/en/sessions)
- **A9:** [Store instructions and memories](https://code.claude.com/docs/en/memory)
- **A10:** [Claude Code GitHub Actions](https://code.claude.com/docs/en/github-actions)
- **A11:** [Tools reference](https://code.claude.com/docs/en/tools-reference)

OpenAI documents parallel subagents, OS-enforced local sandboxing with separate approval policy, worktree handoff, review comments/stage/revert workflows, integrated terminal, scheduled work, extensions, a streamed App Server protocol, CI, Computer Use, and remote connections. Anthropic documents independent desktop sessions, automatic worktree isolation, rearrangeable chat/diff/browser/terminal/file panes, side chats, local/SSH/cloud environments, visual review comments, preview/verification, granular permissions, subagents, checkpoints, extensions, schedules, PR/CI monitoring, and Computer Use. Availability and plan gates can change; re-run this audit before Code beta and again before release.

## Current Juno evidence roots

- Web/backend repository: `/Users/liammagnier/Desktop/workspace/.worktrees/juno-rebuild`
- Native/TypeScript repository: `/Users/liammagnier/Desktop/workspace/.worktrees/juno-app-rebuild`

The legacy Swift app contains the broadest product and Code surface. The greenfield `apps/desktop/JunoDesktop` shell and `core` TypeScript engine are an M1 prototype, not a safe production boundary. The capability matrix judges the combined current system, not README claims.

## P0 security gates

No Code UI, remote task, scheduled task, plugin, or Computer Use expansion may ship until all four P0 gates pass.

| Gate | Observed Juno evidence | Required remediation and release evidence | Owner / milestone |
|---|---|---|---|
| Authenticated engine channel | `core/src/server.ts:48-74` makes the WebSocket token optional and performs no Origin/peer validation. `apps/desktop/JunoDesktop/Sidecar/SidecarClient.swift:25-37,62-79` connects to and launches the fixed loopback port without a token. `core/src/server.ts:121-160` accepts client-supplied backend URL/cookie, arbitrary `cwd`, provider, model, and mode. `core/src/providers/proxy.ts:77-113` forwards the cookie to that supplied URL. This is a local RCE and credential-exfiltration boundary. | Remove the unauthenticated loopback server from the app. Prefer authenticated XPC or a user-private Unix-domain channel. Require versioned initialization, peer identity, random per-launch capability, strict schemas/enums/size limits, allowlisted workspace handles, origin-equivalent protection, replay resistance, and fail-closed disconnect. The engine never receives the web session cookie or refresh token; backend access uses short-lived audience- and session-scoped credentials. Pen tests cover hostile webpages, local processes, port races, token replay, malformed frames, arbitrary roots, and cookie exfiltration. | Security + Code Runtime / **M1** |
| Filesystem capability boundary | `core/src/tools/fs.ts:11-13` preserves absolute paths; `read_file` at `:15-52` can auto-read anywhere, while writes at `:54-117` can mutate anywhere. `core/src/permissions.ts:27-42` does not classify file paths by root/sensitivity. Legacy `Juno/Services/Code/PermissionEngine.swift:140-147` has a useful canonical check, but `CodeAgentEngine.swift:881-899` bypasses it for glob/grep and `WorkspaceService.swift:139-237` does not enforce every subpath. | One descriptor-backed capability root per workspace. Resolve existing target and nearest existing parent, reject traversal/symlink/hardlink/mount escape, validate create/rename destination, protect `.git` and Juno policy stores, revalidate at use to limit TOCTOU, and distinguish read/write/delete/rename. Absolute paths are display data, never authority. Property/fuzz/race tests cover symlink swaps, `..`, Unicode/case normalization, nonexistent parents, aliases, hard links, mount points, and worktree `.git` pointer files. | Security + Filesystem / **M1** |
| Process tree, environment, and output safety | `core/src/tools/bash.ts:28-38` inherits `process.env` and kills one PID. `core/src/agent.ts:145-147` only aborts model streaming. Legacy `Juno/Services/Code/CommandRunner.swift:54-99` likewise has no process-group/tree guarantee. `SecretRedactor` at `CommandRunner.swift:7-41` is regex-only. | Spawn a process group/session through a PTY broker, construct a minimal allowlisted environment, inject secrets per command and destination, redact before UI/persistence/telemetry, cap output with loss markers, and terminate descendants with TERM/grace/KILL while reaping them. Emergency stop cancels model, queued tools, approvals, PTY input, previews, and every descendant. Tests use grandchildren, detached children, traps, huge/binary output, split-token secrets, ANSI escapes, timeouts, and app quit. | Security + Runtime / **M1** |
| Signed update supply chain | `Juno/Services/Update/UpdateService.swift:49-61` trusts the string `Juno Self-Signed` and follows a user-editable production URL. `UpdateInstaller.swift:40-50` downloads an arbitrary manifest URL without artifact hash/size verification. `:98-109` uses `codesign --deep` and an authority substring rather than a pinned designated requirement/Team ID plus notarization assessment. `:111-129` interpolates paths into a temporary shell script, recursively removes the installed app, clears quarantine, and relaunches. The app target disables hardened runtime in `Juno.xcodeproj/project.pbxproj:320,364`. | Ship Developer ID signing, Hardened Runtime, notarization, a fixed HTTPS update origin, signed manifest, version/build monotonicity, artifact length and SHA-256, pinned bundle ID and designated requirement/Team ID, Gatekeeper assessment, rollback-safe atomic replacement, and no shell interpolation or quarantine clearing. Prefer a maintained, reviewed updater rather than a handwritten detached script. Tests cover malicious manifest/redirect/DMG/app, downgrade, interrupted swap, quoted paths, wrong signer, expired/revoked signature, and recovery. | Security + Release Engineering / **M1** |

The OpenAI security model explicitly separates technical sandbox boundaries from approval policy and keeps local/private network destinations constrained by default [O2]. Juno adopts that principle but does not copy OpenAI policy names or UI.

## Required internal event protocol

Codex App Server documents initialized, versioned client interaction, thread start/resume/fork, turn start, and streamed item/tool notifications [O13]. Juno needs its own contract because UI, durable local history, remote observation, background execution, and replay must consume identical facts.

### Observed

- `core/src/types.ts:42-70` defines a small `AgentEvent` union for session/turn/text/tool/approval/file/mode/error events, without protocol version, durable sequence, checkpoint, test, Git, review, redaction, or cost semantics.
- `core/src/server.ts:120-230` accepts untyped dictionary messages and emits unversioned JSON.
- Web remote tasks define only `status`, `user`, `text`, `tool`, `file_change`, approval, cancel, error, and done in `src/lib/code-remote.ts:8-23`; `prisma/schema.prisma:709-741` stores a sequence and JSON payload but not schema version, idempotency key, actor/device, or redaction version.
- The legacy remote host holds unsent events only in memory at `Juno/Services/Code/RemoteCodeHost.swift:33-41,331-359`, so a crash can strand task state.

### Required-now contract

`CodeSessionEvent` is a closed, generated, additive union. Every envelope contains `protocolVersion`, `schemaHash`, `eventId`, monotonic `sequence`, `timestamp`, `accountId`, `sessionId`, optional `turnId`/`spanId`/`parentSpanId`, `actor`, `sourceDeviceId`, `worktreeId`, `redactionVersion`, and an idempotency key.

Required payload families:

- `session.created|configured|resumed|handedOff|backgrounded|completed|failed`
- `turn.started|queued|stopped|completed`
- `plan.updated` and `reasoning.summary.updated` — concise user-facing summaries only, never hidden chain-of-thought
- `assistant.delta|message.completed`
- `tool.requested|started|progress|completed|failed`
- `approval.requested|decided|expired` with exact scoped capability and rule provenance
- `command.started|output|exit|cancelled` with channel, bounded chunks, exit/signal, and redaction metadata
- `file.observed|patchProposed|diffUpdated|accepted|rejected`
- `checkpoint.created|restored|conflicted`
- `test.discovered|started|case|completed`
- `git.status|branch|commit|push|pullRequest|check`
- `preview.started|log|snapshot|stopped`
- `usage.reserved|reported|refunded|reconciled`
- `error` and `completion`

The local event journal is append-only and crash-safe. Server replication uses acknowledgments, idempotent batches, cursor replay, tombstones, and bounded backpressure. Sensitive command output and file content are redacted before persistence or upload. Unknown additive events remain stored and visible as “unsupported event,” while an incompatible major protocol fails closed with an upgrade message. UI reducers are deterministic and replay-tested from the journal.

**Classification:** `required-now` — Protocol + Backend Sync / **M1**.

## Target permission semantics

The UI may use Juno wording, but these semantics are normative:

| Juno mode | Technical boundary | Approval behavior |
|---|---|---|
| Plan | Read metadata and approved workspace files only; no mutation, process, network, connector side effect, or Computer Use. Output is a plan. | Any attempted side effect is denied, not queued for approval. |
| Read only | Read/list/search approved roots and run only sandboxed, demonstrably nonmutating inspection with network off. | Mutation, network, install, credential, and external-app actions are denied. |
| Manual approval | Read inside roots. Every file mutation, command, network destination, install, Git mutation, connector write, and Computer Use action suspends for a scoped decision. | Allow once, deny, or create a narrowly scoped rule with an explicit preview. |
| Workspace write | OS sandbox permits writes only inside capability roots and network remains off by default. Safe in-root edits and allowlisted commands can proceed; destructive, install, network, credentials, protected paths, and outside-root actions still ask. | Deny rules always win. Approval is per action/capability, not per generic tool name. |
| Full access | User explicitly widens the OS boundary for a named session and duration. | Destructive, credential, persistence, protected-path, outside-root, network, and Computer Use actions still ask. Emergency stop is permanent chrome. |

Persistent rules bind to tool/action, normalized arguments, capability root, destination/domain, session/project scope, signer/plugin identity, expiry, and creator. “Always allow bash” is forbidden. Rules are inspectable, revocable, exportable, and evaluated deny-first. Subagents can receive a narrower capability set but never a wider one than the lead session.

## Capability matrix

Milestones: **M1** safety spine and event protocol; **M2** local workbench; **M3** review/SCM/extensions/preview; **M4** background, scheduling, and remote execution. Owners are accountable leads, not exclusive implementers.

| Capability | Official product evidence | Observed Juno state | Class | Owner / milestone | Exit evidence |
|---|---|---|---|---|---|
| Resizable multi-pane workbench | Claude Desktop documents rearrangeable chat, diff, browser, terminal, file, plan, task, and subagent panes [A1]. | Legacy Code forces one inspector panel; greenfield shell has thread plus a read-only diff. No pane graph/layout persistence. | `required-now` | Native Workbench / **M2** | Keyboard-accessible split graph, drag/resize/open side by side, saved/restored layouts, small-window degradation tests. |
| Parallel sessions | Codex worktrees support independent parallel tasks [O4]; Claude Desktop exposes independent parallel sessions [A1]. | One `AgentSession` per sidecar connection (`core/src/server.ts:79-81`) and one active Swift connection. | `required-now` | Session Runtime / **M2** | Concurrent isolated sessions, per-session status/cancel/model/mode/context, stress and crash tests. |
| Isolated Git worktrees and branches | Codex documents managed worktrees, handoff, snapshots, and branch constraints [O4]; Claude supports automatic worktrees and worktree-isolated subagents [A1][A4]. | `GitService.swift` has branch/status helpers but no task worktree lifecycle. | `required-now` | Git Platform / **M2** | One task/worktree ownership, protected shared Git dir, setup/cleanup/recovery, dirty-base and branch-conflict tests. |
| Lead agent and parallel subagents | Both products document isolated-context subagents; Codex surfaces/steers threads and Claude can restrict tools/model/permissions/worktree [O1][A2][A4]. | No subagent protocol, status model, delegated context, or tool restriction. | `required-now` | Agent Runtime / **M2** | Lead delegation DAG, independent contexts, least-privilege tools, concurrency/budget caps, steer/stop, summarized result, adversarial tests. |
| Precise permission modes | Codex separates sandbox and approvals and offers read-only/workspace-write/full boundaries [O2]; Claude documents plan/edit/auto/bypass modes [A3]. | Swift and TS have competing mode enums and inconsistent semantics; TS mode input is unvalidated (`core/src/server.ts:140-160,185-187`). | `required-now` | Security / **M1** | Normative mode tests at API, UI, filesystem, process, network, plugin, and subagent boundaries. |
| Per-action approvals and persistent rules | Codex documents granular approval categories and executable rules [O2][O3]; Claude permissions and hooks can deny/ask/allow with deny-first behavior [A3]. | Swift approval continuation is useful, but TS `allow_always` grants a whole tool name (`core/src/agent.ts:271-337`). | `required-now` | Security + Native UX / **M1** | Scoped rule schema, provenance/expiry/revoke UI, disconnect/timeout fail closed, replay and confused-deputy tests. |
| Canonical filesystem safety | Codex uses OS-enforced workspace boundaries and protects repository/config paths [O2]; Claude exposes path-aware permission rules [A3]. | P0 boundary is absent/incomplete; see security gates. | `required-now` | Filesystem Security / **M1** | Descriptor-backed capability kernel and traversal/symlink/race/property test suite. |
| Read/list/glob/grep/search and precise patch/write | Both products document file/tool workflows [O2][A11]. | TS has six basic tools (`core/src/tools/registry.ts`) but unsafe absolute paths; Swift has richer operations with grep/glob bypasses. | `required-now` | Tooling / **M1** | One typed tool registry, bounded output, exact patch preconditions, binary/large-file behavior, root enforcement for every tool. |
| Network/install/destructive classification and secret control | Codex documents network-off defaults, destination policy, local/private blocking, and approval separation [O2]; Claude supports rules/hooks around tool use [A2][A3]. | Regex command classifiers exist (`PermissionEngine.swift:53-138`; `core/src/permissions.ts:10-42`) but shell parsing, destination policy, environment filtering, and robust redaction do not. | `required-now` | Security / **M1** | Shell AST/token-aware policy, network broker allowlist, package-manager/install policy, split-secret and prompt-injection tests. |
| PTY terminal and process tree | Codex documents an integrated terminal [O6]; Claude Desktop documents local integrated terminal tabs sharing session cwd/environment [A1]. | Both runtimes use pipes, not a PTY; cancellation kills only the immediate process. | `required-now` | Runtime / **M2** (broker in M1) | PTY resize/input/history/channels/exit/signal, bounded/redacted transcript, TERM/KILL process-tree tests. |
| Emergency stop | Official permission/security workflows expose stop/cancel controls [O2][A1]. | `CodeAgentEngine.stop()` cancels model and current handle, but descendant processes survive; stop is not persistent app chrome. | `required-now` | Security + Native UX / **M1** | Always-visible stop, deterministic cancellation receipt, model/tool/process/preview/Computer Use coverage under load. |
| Checkpoints, rewind, and conflict-safe undo | Claude automatically checkpoints editing-tool changes and documents the Bash/external-edit limitation [A5]; Codex review/worktree flows support revert and worktree snapshots [O4][O5]. | TS checkpointing omits Bash mutations (`core/src/checkpoints.ts:12-16`). Swift snapshot copy errors are ignored and can make rollback delete a real file (`CheckpointService.swift:37-79`). Accept/undo can overwrite later edits (`CodeAgentEngine.swift:1161-1208`). | `required-now` | Filesystem + QA / **M1** | Atomic content-addressed snapshots, hashes/preconditions, metadata, conflict UI, crash recovery, command-mutation strategy, no silent overwrite/delete. |
| Staged changes; accept/reject file or hunk | Codex review supports staged/unstaged/commit/branch/last-turn scopes and stage/revert [O5]; Claude Desktop documents visual diff and inline feedback [A1]. | Legacy supports pending changes and per-file accept/reject (`CodeInspectorPanels.swift:24-132`); no hunk decision or safe external-change merge. Greenfield diff is read-only. | `required-now` | Review UX / **M2** | Virtualized editable diff, file/hunk/all actions, three-way preconditions, binary/rename/delete cases, large-diff tests. |
| Inline diff comments and agent response | Both official review surfaces document line-specific comments and follow-up [O5][A1][A6]. | None. | `required-now` | Review UX + Protocol / **M2** | Durable comments anchored to file/base/blob/line, stale-anchor handling, agent reply/fix loop, replay tests. |
| File tree, global search, editor, diagnostics, external editor | Claude Desktop documents file pane editing with external-change warning and open-in-editor [A1]; Codex review/worktree docs open files/worktrees in a chosen editor [O4][O5]. | Basic tree/search and SwiftUI text rendering exist; no production editor, diagnostics/LSP, large-file virtualization, or reliable open-at-line. | `required-now` | Editor / **M2** | Native/AppKit editor spike, incremental search, encoding/binary/large-file policy, diagnostics protocol, external-editor deep links, accessibility/performance tests. |
| Test/lint/build discovery and structured rerun | Claude Desktop documents project preview configuration and automatic post-edit verification [A1]; Codex GitHub Action/noninteractive workflows support CI checks [O14]. | Agent can run arbitrary commands; there is no discovery model, structured test event, one-click rerun, or verification gate. | `required-now` | Developer Experience / **M2** | Detector plugins, structured suite/case/diagnostic events, rerun failed/all, cancellation, artifacts, agent completion policy requiring verification. |
| Git status/diff/log/branch and safe commits | Official Codex review/worktree flows cover repository diff, branch, commit, push [O4][O5]; Claude Desktop integrates Git/PR workflows [A1]. | `GitService.swift:45-97` has basics, but `commitAll` stages every user change and the UI swallows commit errors (`CodeInspectorTools.swift:344-355`). | `required-now` | Git Platform / **M3** | Path/hunk-scoped staging, explicit commit set, signing hooks, no unrelated files, conflict/error UI, dirty-worktree tests. |
| Pull request creation, review, CI, authorized auto-fix/merge | Codex offers review and a GitHub Action [O5][O14]; Claude Desktop documents PR monitoring, CI, auto-fix/merge and official Code Review [A1][A6][A10]. | No native PR/check model. “Commit all” is the endpoint. | `required-now` | SCM Integrations / **M3** | Connector-scoped auth, draft PR, review threads, checks/logs, opt-in auto-fix, protected-branch/merge authorization, audit trail and fork-safety tests. |
| Live browser/app preview, logs, reload, verification | Claude Desktop documents preview server config, Browser pane, logs/reload, and auto-verification [A1]. | Legacy `WKWebView` preview is narrow; no managed dev server, port policy, logs, reload, snapshot, or verification loop. | `required-now` | Preview + Security / **M3** | Sandboxed preview broker, port ownership, origin/navigation policy, process-tree stop, logs/reload/snapshot, prompt-injection and localhost tests. |
| Skills and slash commands | Codex and Claude both document reusable skills and invocation [O8][A2]. | Engine reads only the first `JUNO.md`/`AGENTS.md`/`CLAUDE.md` as plain memory (`core/src/agent.ts:21-62`); no skill discovery or command registry. | `required-now` | Extensibility / **M3** | Signed/scoped skill manifests, progressive loading, script approval, install/update/remove UI, slash completion, provenance and tests. |
| Plugins | Both products document packages that can bundle extension capabilities [O9][A2]. | No Code plugin model. Website connectors are not local Code plugins. | `required-now` | Extensibility + Security / **M3** | Manifest/signature, capability declaration, source/provenance, per-project enablement, update/revoke, quarantine, malicious-plugin tests. |
| Hooks | Both products document lifecycle hooks; Claude explicitly distinguishes deterministic enforcement from prompt instructions [O10][A2]. | None. | `required-now` | Extensibility + Security / **M3** | Typed lifecycle points, timeout/output caps, fail-open/fail-closed declaration, no approval bypass, audit log, recursive-hook prevention. |
| MCP servers and account connectors | Both products document MCP; Claude Desktop exposes connectors as managed MCP setup [O11][A1][A2]. | Website has MCP/connectors (`src/app/api/mcp/**`, `src/lib/mcp.ts`), but Code has no typed local MCP host, capability bridge, or connector approval propagation. | `required-now` | Integrations / **M3** | Account/local server inventory, OAuth/token isolation, tool annotations, per-call approval, schema/version validation, disconnect/revoke and hostile-server tests. |
| Project instructions and `AGENTS.md`; `CLAUDE.md` import | Codex documents hierarchical `AGENTS.md` [O12]; Claude documents `CLAUDE.md` and scoped configuration [A2][A9]. | At audit start neither repository had `AGENTS.md`; this Phase 0 milestone adds contributor guides at both roots. The TS engine still reads only one file with a 20k-character cap and no hierarchy. | `required-now` | Developer Experience / **M1** | Hierarchical Juno instruction resolver, exact precedence/size diagnostics, `AGENTS.md` native support, one-way `CLAUDE.md` compatibility import with attribution and conflict UI. |
| File/image/PDF context and `@` mentions | Codex documents image/file inputs [O17]; Claude Desktop documents file autocomplete plus image/PDF attachments [A1]. | Chat attachments exist, but Code protocol/tool context is text-only and has no provenance/token preview. | `required-now` | Context + Native UX / **M2** | File/selection/line/image/PDF attachments, scoped read grant, extraction provenance, size/token preview, sensitive-file warning, replay tests. |
| Context meter, summaries, compaction | Claude documents context inspection/compaction and per-session context usage [A1][A8]; Codex documents subagent context isolation [O1]. | Session history exists, but no accurate context budget, compaction event, summary provenance, or user control. | `required-now` | Agent Runtime / **M2** | Model-catalog-aware meter, deterministic compaction boundary, user-visible summary, pinned context, no hidden CoT, resume equivalence tests. |
| Session resume, fork, and local/worktree handoff | Codex App Server supports start/resume/fork and Codex worktrees document handoff [O4][O13]; Claude documents resume/fork/session persistence [A8]. | TS persists sessions, but `SessionStore.open/rename` path validation and corruption handling are unsafe; greenfield “resume” does not replay the transcript (`AppModel.swift:171-175`). | `required-now` | Session Runtime / **M2** | Durable journal replay, fork lineage, corruption recovery, local/worktree handoff transaction, cross-version migrations and crash tests. |
| Background tasks and notifications | Both products document background/scheduled workflows and completion/attention notifications [O7][A1][A7]. | Remote host loops exist; no general background session manager, app-quit contract, notification privacy, or attention queue. | `required-now` | Background Runtime / **M4** | Explicit background policy, sleep/wake/app-quit semantics, private actionable notifications, attention inbox, resource caps and recovery tests. |
| Scheduled tasks | Codex and Claude document local schedules and worktree isolation [O7][A7]. | Web scheduled chat tasks exist (`prisma/schema.prisma:817-830`; `src/lib/scheduled-tasks.ts`), but not a safe local Code scheduler. | `required-now` | Automation + Security / **M4** | Durable schedule, timezone/DST/missed-run semantics, isolated worktree default, unattended permission policy, run history, pause/revoke, sleep/wake tests. |
| Remote/cloud/SSH execution and cross-surface continuation | Codex documents remote connections [O16]; Claude Desktop documents local, SSH, and cloud environments plus cross-surface sessions [A1]. | Juno has an account-authenticated remote task queue (`src/lib/code-remote.ts`; `prisma/schema.prisma:694-741`) and legacy host, but it uses the web session cookie, absolute workspace paths, in-memory outbound events, polling, and no host-attested/scoped token. | `required-now` | Remote Runtime + Backend / **M4** | Device-bound rotating token, explicit workspace alias not raw path, host presence/capability attestation, durable events, offline truth, SSH host-key policy, cloud/local boundary UI, revoke/replay tests. |
| Side chat / lightweight consultation | Claude Desktop documents side questions that use session context without changing the main thread [A1]. | None. | `required-now` | Native Workbench + Agent Runtime / **M2** | Forked read-only context view, explicit promoted result, separate token accounting, no mutation by default, proof main transcript/context is unchanged. |
| Backend usage ledger | Official products expose plan/context usage concepts [O18][A1]. | Juno backend already reserves/records/refunds Code usage in `src/app/api/agent/usage/route.ts:8-85`, writing the shared spend ledger. | `implemented` | Backend Billing / maintained | Existing API tests plus idempotency/reconciliation additions; this row covers the backend ledger only, not the native UI or fail-open reporter. |
| Per-session usage and cost visibility | Claude Desktop documents context and plan usage UI [A1]; Codex documents shared usage/credits [O18]. | TS backend reporter fails open and ignores record/refund failure (`core/src/usage.ts:24-64`); no reliable per-turn/session cost surface. | `required-now` | Billing + Native UX / **M2** | Reservation and final reconciliation events, model/catalog pricing provenance, per-turn/session/account views, offline pending state, no double charge, failure tests. |
| Computer Use | Both official products document computer/app control with explicit platform/security boundaries [O15][A1]. | Legacy has TCC checks and consent (`ComputerUseService.swift:147-310`; `CodeComputerConsentSheet.swift:8-195`) but lacks per-action policy, coordinate bounds, secure-input/user-takeover detection, app/window scope, and process-tree stop. | `required-now` | Computer Use + Security / **M3** | Off by default, OS grants, foreground HUD, app/window/display scope, per-action consent, prompt-injection defense, secure-input/takeover stop, bounded coordinates, emergency-stop and privacy tests. |
| Secure app updates | Not an external-product parity claim; this is a Juno release prerequisite. | Current updater fails P0 requirements above. | `required-now` | Release Engineering + Security / **M1** | Signed/notarized/hardened build and adversarial updater suite pass before any external beta. |

## Architecture rules implied by the matrix

1. **One production Mac target and one engine contract.** The legacy Swift app is the migration host because it contains the product surface. `apps/desktop/JunoDesktop` is a prototype, not a second production app. The Swift and TS engines may not evolve independently behind different permissions or event types.
2. **Swift owns product authority.** The native account layer owns app-scoped tokens, Keychain, SwiftData cache/outbox, workspace bookmarks, approvals, notification state, and UI. A local engine receives only explicit session capabilities.
3. **Local execution stays local.** The backend can proxy model calls, usage, remote metadata, and replicated redacted events. It cannot report a local command/file action as complete when the Mac host was offline.
4. **No raw account cookie in the engine.** Use browser auth with one-time exchange, rotating app refresh tokens, device sessions, and short-lived audience-scoped Code access tokens.
5. **One safety kernel.** Filesystem, process, network, Git, checkpoint, plugin, preview, and Computer Use decisions call the same capability evaluator and emit the same approval/audit events.
6. **No hidden chain-of-thought.** Persist and display concise reasoning summaries and observable actions only. Legacy `Message.reasoning` semantics must be migrated accordingly.
7. **Capability before convenience.** UI affordances never create authority. A button can request a capability; only the OS-backed capability layer can grant it.
8. **Fail closed, recover visibly.** Corrupt sessions, protocol mismatch, lost backend accounting, approval disconnect, and snapshot failure produce explicit recoverable states, not empty arrays, in-memory fallback, or silent success.

## Verification gate by milestone

### M1 — safety spine and protocol

- P0 sidecar, filesystem, process-tree/environment/redaction, and updater gates pass.
- Generated event protocol and deterministic replay land across engine, Swift, persistence, and backend.
- Permission/rule semantics, scoped approvals, instructions, checkpoint preconditions, and emergency stop pass adversarial tests.
- App Sandbox/Hardened Runtime/entitlements are reviewed against required local capabilities.

### M2 — local workbench

- Parallel sessions/worktrees/subagents and rearrangeable panes are usable by keyboard and VoiceOver.
- PTY, editor/search/diagnostics, structured tests, diff/hunk/comments, context, resume/fork/handoff, side chat, and usage pass performance/recovery tests.

### M3 — review, integrations, and preview

- Safe Git commits, PR/review/CI, extensions, MCP/connectors, preview, and bounded Computer Use pass security and integration suites.
- Automated actions are opt-in, narrowly authorized, inspectable, and reversible.

### M4 — background and remote

- Notifications, background runs, schedules, remote/cloud/SSH hosts, device revocation, durable event replication, offline truth, and sleep/wake recovery pass multi-device convergence tests.

Before a row changes classification, link its implementation PR, threat model, tests, accessibility evidence, performance result, and user-facing recovery behavior in this document. Re-audit the official sources at Code beta and release; new compatible mission-critical capabilities become `required-now`, not unowned “planned” work.

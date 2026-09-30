# Juno Code: cloud, remote, and protocol convergence audit

Date: 2026-09-30. This is a read-only audit of `rework/refoundation`, which is the same commit as `main` @ `1feb392c`.
Scope:
- `runner/agent-core`, the cloud runner, the Code API routes and the agent proxy.
- The phone ↔ Mac relay.
- Web Code and iOS Code.
- The Swift local runtime, only where its protocol meets the others.

The runtime internals of the Mac's local agent are covered in `docs/native/code-rework/01-AUDIT-RUNTIME.md` and its 1.6.0 follow-up, so they are not repeated here.

Every code claim cites `path:line`. Competitor claims cite a URL and a date. Anything I could not check is marked **UNVERIFIED**. No build, test or type-check was run, because the machine was reserved for the baseline gate.

---

## 0. Verdict

The September rebuild fixed most of what `01-AUDIT §8` listed, with one real exception: dead code. The bugs that remain in this area come from one cause. **Juno has one product idea, "a coding session", but at least six wire vocabularies for it.** They are bridged by hand-written adapters, alias tables and regexes on display strings.

Every field that crosses from one vocabulary to another is a place where a setting gets dropped silently. There is a live example today: the model a web user picks for a Mac run never reaches the Mac (§3.1-C1).

The highest-leverage move is:
1. A versioned, language-neutral **agent session protocol** in `contracts/agent/`, with generated TypeScript and Swift and golden transcript fixtures that both languages must fold identically.
2. Collapsing the two Mac projections and the cloud runner's projection onto it.
3. Then collapsing the two "run on my Mac" paths into one.

Merging the two agent engines is **not** the first move (see §5, R3 "Engine convergence").

---

## 1. Map

### 1.1 Engines

| Engine | Language | Where it runs | Used by | Size |
|---|---|---|---|---|
| `JunoCodeRuntime` (`AgentOrchestrator`) | Swift | Mac app | Local Code sessions, device-queued tasks, relay sessions from the phone | JunoCode package, ~1,069 tests per `04-HANDOFF.md` |
| `runner/agent-core` (`AgentSession`, `runAgentLoop`) | TS | GitHub Actions (cloud Code), prod VM (`scripts/work-runner.ts`, cloud Work), the dormant Electron app | Cloud Code runs, cloud Work runs | 18,948 lines including tests; `work/` is about 6,400 of them |
| `native/desktop-electron` | TS / Electron | nowhere shipped | none. Has its own agent wire (`src/renderer/products/code/lib/contract.ts:45-56`) | 62,961 lines. `docs/STATUS.md` last updated 2026-08-13. No CI workflow: README cites `.github/workflows/desktop.yml`, which does not exist in `.github/workflows/` |

`runner/agent-core/VENDORED.md:3-9` calls agent-core "the same agent loop the Juno Mac app runs" and names `juno-app/core` as upstream source of truth. Both statements are stale:
- The Mac runs the Swift runtime.
- No `juno-app` checkout exists under `~/Developer/project`.

The vendored copy *is* the source of truth now.

### 1.2 Flows

```
 WEB /code ──POST /api/code/tasks {target:cloud, model, effort}──► CodeTask ──workflow_dispatch──► GH Actions
   ▲                                                               │           code-runner.yml → scripts/cloud-code-runner.mjs
   │ SSE /api/code/tasks/[id]/events (DB poll 1.2 s)               │           → agent-core AgentSession (docker sandbox)
   └───────────────────────────────────── CodeTaskEvent ◄──────────┘◄── POST events (AgentEvent → task kinds, runner:1325-1379)
                                                                        model calls → /api/agent/<p>/… (cct_ bearer) → provider

 WEB/iPhone/Mac "device" target ──POST /api/code/tasks {target:device}──► CodeTask(queued)
   Mac DesktopQueuedCodeHost ── long-poll GET /api/code/queue (1.5 s DB poll) ── claim ── run as local session
   └─ SessionEvent → CodeTask kinds (DesktopCodeHost.swift:300-460) → POST /api/code/tasks/[id]/events

 iPhone "host" chip ── POST /api/code/devices/[id]/commands {create_session|send_message|…} ─► CodeSessionCommand(pending)
   Mac CodeRemoteHost ── long-poll GET …/commands (1.25 s DB poll) ── claim(lease 120 s) ── RemoteCommandAdapter
     → CanonicalRelayHostExecutor → RuntimeCodeHost → WorkbenchRemoteBridge → SessionController
   Mac CodeRemoteSessionSync ── PUT …/sessions (list) + POST …/sessions/[sid]/events (SessionEvent → relay kinds,
     CodeRelayEventProjection.swift) ─► CodeRemoteSession / CodeRemoteSessionEvent
   iPhone ◄── SSE …/sessions/[sid]/events (DB poll 1 s) ── CodeRemoteThread fold

 Mac local ── BackendCodeModelClient ── /api/agent/<provider>/… (native bearer) ── provider   (billed per call, route.ts:250-281)
```

### 1.3 Server

- **Tables** (`prisma/schema.prisma`):
  - `CodeTask:1686`, `CodeTaskEvent:1900`
  - `CodeRemoteSession:1792`, `CodeRemoteSessionEvent:1852`, `CodeSessionCommand:1871`
  - `CodeDevice:1649`, `CodeEnvironment:2112`, `CodeUsageReservation:1365`
  - `CodeAutoFixWatch/Delivery:2171/2217`, `CodeWorkspace:2075`

  That is **two server-side session models**: task + events, and remote session + events + commands.
- **Routes:** `src/app/api/code/**`, 32 route files, 4,767 lines including the proxy and usage route.
  - Tasks: create, list, events SSE, respond, cancel, steer, controls, rollback, checks, auto-fix, pull-request, claim, runner-context.
  - Queue: `queue`.
  - Devices: devices, commands, sessions, events, messages, approvals, stop.
  - Also environments, github, search, workspaces.
- **Libraries:**
  - `src/lib/cloud-code.ts` (dispatch and readiness probe)
  - `src/lib/code-remote.ts` (auth, `EVENT_KINDS`, `serializeTask`)
  - `src/lib/code-task-events.ts` (`CONTROL_KINDS:28`)
  - `src/lib/code-remote-sessions.ts`
  - `src/lib/code-session-command-{compat,lease,route}.ts`
  - `src/lib/agent-proxy.ts` (1,118 lines: deadlines, metering)

### 1.4 Clients

| Surface | Files | Talks to |
|---|---|---|
| Web | `src/app/(app)/code/{page,new,pulls,customize}`, `src/components/code/*` (21 files, 10,444 lines), `src/hooks/use-code-session.ts`. Sessions render inside `/chat/[id]` (`code-composer.tsx:475`) | CodeTask routes only. It never reads `CodeRemoteSession` (see §3.4) |
| Mac | `JunoCodeUI/Studio/*`, `native/macOS/JunoDesktop/App/DesktopCode{Host,Studio,Workspace}.swift`, `JunoCodeBridge/*`, `JunoCodeKit/*` | Local runtime. Cloud and device through `NativeCodeModel.startTask` (`StudioLanding.swift:499`). Hosts the queue and the relay |
| iPhone and iPad | `native/iOS/JunoMobile/App/JunoMobileCode{View,Remote,Notifications}.swift` (3,880 lines), `JunoCodeKit/CodeRemote{BrowserModel,Thread}.swift`, `NativeCodeModel` | Two paths: a host chip (relay sessions) and a Cloud chip whose target picker can still pick a device (device-queued task). iPad renders the same single-column view inside the split detail (`JunoMobileRootView.swift:1383-1399`) |

### 1.5 Vocabularies in use

| Concept | Vocabularies in use | Evidence |
|---|---|---|
| Transcript events | 1. Swift `SessionEventPayload`, 23 cases<br>2. Relay kinds (`session_created`, `user_message`, `text_delta`, `status_update`, `heartbeat`, `canonical_session_event`, …)<br>3. `CodeTaskEvent` kinds, 24<br>4. agent-core `AgentEvent`, 16<br>5. Work `WORK_EVENT_KINDS`, 31<br>6. Electron wire | 1. `JunoCodeCore/SessionEvents.swift:29-58`<br>2. `JunoCodeBridge/CodeRelayEventProjection.swift:80-200`<br>3. `src/lib/code-remote.ts:30-95`<br>4. `runner/agent-core/src/types.ts:53-93`<br>5. `contracts/work/juno-work-v1.json` `eventKinds` |
| Commands | 1. Swift `CodeSessionCommandKind`, 19<br>2. Legacy relay verbs plus alias table<br>3. Task `CONTROL_KINDS`<br>4. agent-core sidecar verbs<br>5. Work `commandKinds`, 13 | 1. `CodeSessionProtocol.swift:182-208`<br>2. `src/lib/code-session-command-compat.ts:1-8`, and in Swift at `CodeRelayProtocolAdapter.swift:70-95` and `RemoteCommandAdapter.swift:319-341`<br>3. `code-task-events.ts:28`<br>4. `server.ts:30-41` |
| Permission mode | 1. `readOnly/askBeforeChanges/workspaceWrite/fullAccess`<br>2. `readOnly/acceptEdits/fullAccess`<br>3. `plan/ask/auto-edit/full`<br>4. agent-core `plan/ask/auto-edit/full`<br>5. Server cloud `plan/auto-edit/full`<br>6. Work `conservative/balanced/permissive` | 1. `JunoCodeCore/PermissionModel.swift:4-13`<br>2. `JunoCodeKit/CodeContracts.swift:16-20`<br>3. `CodeContracts.swift:38-44`<br>4. `types.ts:3`<br>5. `src/lib/code-environments.ts:89` |
| Risk | 1. Swift `read/write/execute/critical/destructive`<br>2. agent-core `safe/edit/command/sensitive`<br>3. Work `safe/edit/command/sensitive/irreversible` | 1. `PermissionModel.swift:54-60`<br>2. `types.ts:5` |
| Approval answer | 1. `{requestId, approve:bool}`<br>2. `{approvalId, approved}`, aliased from `{requestId, approve}`<br>3. `{callId, decision: allow\|allow_always\|deny}`<br>4. Swift digest-bound `ApprovalRequest` with `suggestedRule` | 1. Task `respond/route.ts:8`<br>2. Relay, `code-session-command-compat.ts:45-54`<br>3. agent-core `types.ts:7`<br>4. `PermissionModel.swift:187-204` |
| Permission rules file | The same path, `.juno/settings.json`, has **two incompatible schemas**:<br>1. Swift: `{permissions:{allow,ask,deny:["Bash(npm run *)"]}}`<br>2. agent-core: top-level `{allow:["bash"],deny:[…]}` with tool names | 1. `CodeSettings.swift:21-22,60-68`<br>2. `runner/agent-core/src/permissions.ts:45-58` |
| Tools | 1. Swift: `read_file, write_file, apply_patch, create/delete/move_file, list_directory, glob, grep, find_files, run_command, run_tests, git_*, web_search, web_fetch, update_goal, delegate_task, computer_*, inspect_active_editor, mcp__*`<br>2. agent-core: `read_file, write_file, edit_file, glob, grep, bash, delegate_tasks, await_subagents, inspect_subagent, cancel_subagent` | 1. `JunoCodeRuntime/Tools/*`<br>2. `runner/agent-core/src/tools/*`, `subagents.ts` |

A seventh model already exists and nothing but the Mac uses it: `JunoCodeCore/CodeSessionProtocol.swift`. It defines a "transport-neutral Juno Code session protocol" at version 1.1 (`:3-31`), with:
- a `CodeSessionEventEnvelope` (`:72-100`);
- a gap-refusing append planner (`:120-178`);
- idempotent command envelopes (`:210-250`);
- `ExecutionTarget` with capabilities (`:36-118`).

It is the best design in the area, and it is Swift-only. Its payload is `SessionEventPayload`, whose `Codable` is synthesized: `SessionEvents.swift:29` declares `Codable` with no custom coding for the enum. The JSON is therefore keyed by Swift case names, which no TypeScript reader can reasonably consume. The relay carries it only for transcript restarts (`CodeRelayEventProjection.swift:43-50`).

---

## 2. Real vs dead vs gated

### 2.1 Status of 01-AUDIT §8 items

| 01-AUDIT item | Now | Evidence |
|---|---|---|
| Device queue never decodes a real task (B15) | **Fixed on the Swift side** by lenient decoding. The server still omits the fields, so decoding is now lossy (see C1) | `NativeCodeAgentClient.swift:66-99`. `serializeTask` still emits no `agentRuntime/computerUse/subagentsEnabled/model/reasoningEffort` (`code-remote.ts:287-326`) |
| S2: queued tasks can grant full access | **Fixed.** Capped at the reader's remote ceiling | `DesktopCodeHost.swift:49-61` (`requested.capped(at: CodeSettingsModel.remoteCeiling…)`) |
| Relay events never uploaded | **Fixed.** `CodeRemoteSessionSync` uploads the list and events, and resumes cursors across relaunch | `DesktopCodeHost.swift:727-760`, `JunoCodeKit/CodeRemoteSessionSync.swift:589-660` |
| `createSession` field mismatch | **Fixed** by accepting both spellings. Not fixed at the root: aliases now live in two languages | `RemoteCommandAdapter.swift:319-341`, `code-session-command-compat.ts` |
| `patchSession` rewritten to `apply_patch` | **Fixed** (settings-only patch → `update_session`) | `code-session-command-compat.ts:33-36`, `CodeRelayProtocolAdapter.swift:88-94` |
| Accept, reject, undo and delete have no relay mapping | **Fixed** on the relay path. Still ignored on the device-queue path | `CodeRelayProtocolAdapter.swift:83-86`. The queue path is `DesktopCodeHost.swift:287-303`: only `approval_response` and `cancel_request` are honoured, and `steer` and rollback are dropped |
| Claimed but unacknowledged command stuck forever | **Fixed** (120 s lease, 30 min requeue window). *Pending* commands still never expire | `code-session-command-lease.ts:28,39,113-147`. Also in `04-HANDOFF.md` "Known gaps" |
| B7 remote bridge hijacks the composer | **Fixed** | `WorkbenchRemoteBridge.swift:413-423` (`deliverRemotePrompt`) |
| B8 remote commit reports success on failure | **Fixed** | `WorkbenchRemoteBridge.swift:555-565` |
| 240 s proxy hard abort (B16) | **Fixed.** 120 s headers, 240 s idle, 60 min ceiling | `src/lib/agent-proxy.ts:100,111,119,126-132`, `route.ts:206` |
| Spend never recorded (B17) | **Fixed.** Every call is billed from provider usage, falling back to a character floor | `src/app/api/agent/[...path]/route.ts:49-75,250-281`. `/api/agent/usage` no longer writes a ledger row (`usage/route.ts:37-47`) |
| Native task creation sends no model, effort or permission | **Not fixed** | `NativeCodeTaskStore.swift:534-585,1259-1283` (`CreateTaskWire` has none). The Mac discards its composer's model, mode and effort for cloud and device runs (`StudioLanding.swift:492-505`) |
| Dead code: `CodeRemoteEventBridge`, `CanonicalRelayCommandExecutor` | **Deleted** | No references remain |
| Dead code: `CloudCodeSandboxClient`, `LocalPythonSandboxClient`, `RemoteExecutionModel`, `NativeCodeTaskRemoteSessionProvider`, `ExecutionLocation.swift`, `RemoteSessionProvider.swift` | **Still present** | See §2.2 |
| Two task clients, four SSE parsers | Two task clients remain: `NativeCodeTaskClient` in `NativeCodeTaskStore.swift`, plus `NativeCodeAgentClient`. The create, repository and task methods of `NativeCodeAgentClient` are called only by the dead provider | `NativeCodeTaskRemoteSessionProvider.swift:23-191`. SSE parser count **UNVERIFIED** (not recounted) |
| Relay transport is DB polling | **Unchanged** | Commands 1.25 s (`devices/[deviceId]/commands/route.ts:41-62`), queue 1.5 s (`queue/route.ts:8-9`), relay SSE 1 s (`…/sessions/[sessionId]/events/route.ts:124-146`), task SSE 1.2 s (`tasks/[id]/events/route.ts:100-148`) |

### 2.2 Dead code still in the tree

| Code | Lines | Why it is dead |
|---|---|---|
| `JunoCodeRuntime/CloudCodeSandboxClient.swift` | 708 | Only `LocalPythonSandboxClient` conforms, and nothing outside tests constructs that |
| `JunoCodeRuntime/LocalPythonSandboxClient.swift` | 458 | No non-test reference |
| `Tests/JunoCodeRuntimeTests/CloudCodeSandboxTests.swift` | 627 | Tests the two files above |
| `JunoCodeUI/Remote/{ExecutionLocation,NativeCodeTaskRemoteSessionProvider,RemoteExecutionModel,RemoteSessionProvider}.swift` | 785 | `WorkbenchModel.Dependencies.remoteSessionProvider` is never supplied by any app (`WorkbenchModel.swift:104-148,266`; there are no `remoteSessionProvider:` call sites in `native/macOS` or `native/iOS`) |
| The `WorkbenchModel` "Cloud and Remote" section (`loadRemoteRepositories/Devices`, `startRemoteSession`) | about 80 | Same reason (`WorkbenchModel.swift:236-330`) |
| `NativeCodeAgentClient.createDeviceTask/createCloudTask/createCodeConversation/repositories/tasks` | about 110 | Only the dead provider calls them. Its test also encodes `modelId`, which the server calls `model` (`NativeCodeAgentClientTests.swift:50`) |
| A second `CodeExecutionLocation` enum | — | `JunoCodeKit/CodeContracts.swift:4-8` duplicates the one in `JunoCodeUI/Remote/ExecutionLocation.swift` |
| Web `RunReceipt` | about 85 | Exported, never rendered (`run-review.tsx:1012`). `page.tsx:40-42` says it was "parked" |
| Relay routes marked "web-only" | 4 routes | `devices/[deviceId]/sessions/[sessionId]` (GET, "planned"), `…/messages`, `…/approvals/[requestId]`, `…/stop`. `contracts/parity/features.json:664-679` marks them web-only, but no web code calls them (the only web reads are `/api/code/devices`, at `code-target-picker.tsx:341`, `code-customize.tsx:167`, `code-session-meta.ts:42`, `use-code-runs.ts:113`) |
| agent-core sidecar server and `BackendUsageReporter` | 281 + 80 | Only the dormant Electron app would use them (proxy comment `route.ts:64-67`) |

**The gate pins the dead code.** `scripts/check-code-remote-wiring.mjs:57-73` requires `NativeCodeTaskRemoteSessionProvider.swift` and `WorkbenchModel.startRemoteSession`, `loadRemoteRepositories` and `loadRemoteDevices` to exist. Its comment claims the provider "still backs that path and is still composed", which is false. Deleting the dead code means editing this gate in the same change.

### 2.3 Real, but stale or gated

- **Cloud environments and cloud permission modes** are real on the server and in the runner:
  - schema: `tasks/route.ts:98-108`;
  - runner: `cloud-code-runner.mjs:978-1045`;
  - shipped in `13624753` (2026-09-17).

  No Code composer lets anyone choose them:
  - The web composer's comment says "`CodeTask` has no column for a permission mode and neither runner reads one" (`code-composer.tsx:62-80`). That was false from 2026-09-17.
  - Web `/code/customize` says "There is one cloud environment and it is not configurable yet" (`code-customize.tsx:357`).
  - Native sends neither.
  - Only the Work schedule editor fetches `/api/code/environments` (`work-schedule-editor.tsx:1001`).
- **Cloud approvals are never interactive.** Under `full`, the runner auto-allows and writes an "Auto-allowed in sandbox" row. Under any narrower mode it auto-denies (`cloud-code-runner.mjs:1004-1045`). That is honest, but it means `approval_request` and `respond` exist only for device tasks.
- **Steering exists only for cloud** (`code-steer-policy.ts:50-52`). The Mac queue host ignores `steer` (`DesktopCodeHost.swift:287-303`). The relay path *does* steer and queue (`WorkbenchRemoteBridge.swift:417-423`), so a "Mac run" can be steered or not depending on which path started it.
- **Rollback controls:** no host announces `rollback_ready`, so the web correctly shows none (`code-remote.ts:47-80`).
- **iPhone approval notifications** use `BGAppRefreshTask` polling, which iOS runs "a few times an hour" (`JunoMobileCodeNotifications.swift:1-12`). There is no push. An approval can wait for tens of minutes.

---

## 3. Problems

### 3.1 Correctness

- **C1. The web's model and thinking choice never reach a Mac run.**
  - The web device path sends `model` (`code-composer.tsx:406-411`) and the route stores `CodeTask.model` and `reasoningEffort` (`tasks/route.ts:693-694`).
  - `serializeTask` emits neither (`code-remote.ts:287-326`).
  - The Mac decodes a different key, `modelId` (`NativeCodeAgentClient.swift:92`).
  - The queue host then falls back to the first available model (`DesktopCodeHost.swift:44-46`).
  - Tests hide this: the fixture carries `modelId`, `agentRuntime` and so on, which the server never sends (`NativeCodeAgentClientTests.swift:95`). The decoding test asserts `modelId == nil` (`NativeCodeAgentTaskDecodingTests.swift:23`). This is the same failure class as the original B15, one field over.
- **C2. The project rules file means two different things.**
  - A repository's `.juno/settings.json` with Swift-style `permissions.deny` rules is ignored by the cloud engine, which reads top-level `allow`/`deny` tool names (`permissions.ts:50-58`).
  - The reverse also holds: `{"allow":["bash"]}` makes a cloud `auto-edit` run behave like `full`. The code admits this (`permissions.ts:80-88`), so a cloned repository can widen a control the submitter chose.
  - The Swift side only lets project files *narrow* until approved (commits `5614396e`/`1d37b11b`, on main).
- **C3. The cloud engine has no prompt caching, compaction or thinking replay.**
  - Caching: there is no `cache_control` anywhere in agent-core; the request is built at `providers/anthropic.ts:188-201`.
  - Compaction: there is no compaction code, only `MAX_STEPS_PER_TURN = 60` (`agent.ts:33`).
  - Thinking replay: `ChatMessage` has no thinking block (`types.ts:15-27`). The engine relies on the `thinking-binding-controls` beta to tolerate the drop (`anthropic.ts:92-148`).

  Every cloud Code and cloud Work step re-bills its full prefix at input price. A long run grows toward the context limit with no fallback. The Swift runtime fixed all three in 1.6.0 (`code-rework/00-README.md §1`).
- **C4. Tool outcome is parsed from display strings.**
  - The runner appends `" — ok"`/`" — failed"` to a summary (`cloud-code-runner.mjs:1334-1335`), and writes `"Denied — …"`/`"Auto-allowed in sandbox: …"` rows (`:1031-1036`).
  - The web recovers outcome with regexes (`code-activity.tsx:48-58`).
  - The `exitCode` field (`:1342`) was bolted on beside the string.
- **C5. Pending relay commands never expire.** "Run tests" sent to a sleeping Mac executes whenever it wakes (`code-session-command-lease.ts:147` only sweeps claimed and retried rows; `04-HANDOFF.md` "Known gaps").
- **C6. Spend attribution.** Mac-hosted Work runs are billed as `kind:"code"` because "nothing in a request says which product made it" (`route.ts:57-61`). Nothing records cost per task or session: "cloud tasks keep no cost of their own" (`:63`). Neither `SessionEvent` nor `AgentEvent` carries cache-token usage (`RunCompletedEvent`, `SessionEvents.swift:695-699`; `Usage`, `types.ts:9-12`).

### 3.2 Swift runtime vs agent-core

| Aspect | Swift `JunoCodeRuntime` (local, device, relay) | `runner/agent-core` (cloud Code, cloud Work) |
|---|---|---|
| Event model | 23-case persisted `SessionEvent` JSONL. Seq-numbered; rewind restarts | 16 transient `AgentEvent`s. The runner re-projects them to task kinds and drops `tool_started`, `approval_*`, `files_changed`, `mode_changed` and `turn_finished` (`cloud-code-runner.mjs:1372-1377`) |
| Tool naming | `run_command`, `apply_patch`, `delegate_task` | `bash`, `edit_file`, `delegate_tasks` (+ await, inspect, cancel) |
| Planning and questions | `update_goal` only. No ask-user or todo tool | Code: none. Work: `update_plan` and `askQuestion` (`work/session.ts:138,274`) |
| Permission rules | `Tool(pattern)` grammar; deny > ask > allow; three layered files; per-segment shell parsing (`PermissionRules.swift`) | Tool-name allow and deny list only. Repo allow list beats the mode |
| Approval | Digest-bound, 15 min expiry, "Always allow" saves a rule | `allow`, `allow_always` (in-memory, per tool name), `deny` |
| Caching, compaction, thinking replay | Yes, yes (LLM with structural fallback), yes | No, no, no |
| Checkpoints | Per-turn code and conversation rewind | Per-file snapshot plus `undoLastTurn` (`checkpoints.ts`). Not exposed, since no host announces rollback |
| Usage | Input and output per call (`ModelClient.swift:151-180`). Not in events | Input and output per turn (`turn_finished.usage`) |

### 3.3 Product and UX coherence

- **P1. "Run on my Mac" is two different products.**
  - On iPhone, choosing the Mac in the host strip opens relay sessions: live transcript, steer and queue, approvals, tests, git (`JunoMobileCodeView.swift:229-262`).
  - Choosing Cloud shows task rows, and that composer's target picker can still pick a *device*, which creates a queued `CodeTask`: no steer, no rollback, a different transcript view (`JunoMobileCodeView.swift:868-940`, `NativeCodeModel.startTask:317-323`).
  - The Mac runs both with different projections: `DesktopCodeHost.swift:300-460` versus `CodeRelayEventProjection.swift`.
  - The web only has the queued-task version.
- **P2. The web cannot see or continue a Mac's local sessions.** The iPhone can. Claude Code's Remote Control shows local sessions in both web and mobile, keeps "subagents … in sync across all connected devices", and forwards permission prompts and `AskUserQuestion` (code.claude.com/docs/en/remote-control, fetched 2026-09-30; launch post simonwillison.net 2026-02-25).
- **P3. Native cloud runs are second-class.** Mac and iPhone cloud runs cannot choose model, effort, mode, environment or base branch (`NativeCodeTaskStore.swift:1259-1283`), and cannot steer, view checks, auto-fix or open PR actions. No Swift file calls `/steer`, `/checks`, `/auto-fix`, `/pull-request` or `/rollback`.
- **P4. The same fact is phrased differently per surface.**
  - Permission modes are labelled "Plan · Ask · Auto-edit · Full access" on the Mac (`00-README.md §2`).
  - Web shows a read-only chip (`code-composer.tsx:62-80`).
  - Web customize shows fixed text (`code-customize.tsx:326-350`).

### 3.4 Visual: owner-rule violations and Claude resemblance

- **Status pills and dots, which the owner rules ban:**
  - Web presence dots `size-1.5 rounded-full bg-success|bg-warning` at `code-target-picker.tsx:763-766` and `code-customize.tsx:303-306`.
  - The session header shows "Mac connected" (`code-session-meta.ts:216`, rendered at `code-session-banner.tsx:390-404`).
  - It also shows a "Running" status (`AgentStatusBadge`, `code-session-banner.tsx:354-359`) with an animated `PhaseOrb`, and a second orb on the activity row (`:436`).
  - The iPhone host chip subtitle reads "Online" (`JunoMobileCodeRemote.swift:31`), and the device sheet uses `code.device.online` (`JunoMobileCodeView.swift:1115-1121`).
  - `PhaseOrb` wraps the `thinking-orbs` package (`src/components/effects/phase-orb.tsx:1-40`). An orb as the ambient "working" mark fits the "glow blob" category the owner bans. That is **my judgment; the owner should confirm**.
- **Reads as a Claude imitation:**
  - The web `/code` greeting is a centred serif display line with the user's name in italics, "What should we build, *Liam*?" (`src/app/(app)/code/page.tsx:114-121`). The iPhone equivalent is `JunoSerif.greeting` (`JunoMobileCodeView.swift:694-760`).
  - The Mac Code theme is "warm neutrals do the work … coral marks … working, and needs you" (`JunoCodeUI/Studio/StudioTheme.swift:15-17`).

  That is Claude's own palette and type device. It is a design-system decision for Phase 2, flagged here because Code surfaces carry the strongest resemblance.
- **iPhone host chips** paint their own rounded-rect fill, hairline and shadow (`JunoMobileCodeRemote.swift:102-118`), while the neighbouring target chip uses `JunoGlassCapsule` (`JunoMobileCodeView.swift:898`), which is native `.glassEffect(.regular.interactive())` (`JunoMobileChrome.swift:132`). Two materials sit side by side on one toolbar row: painted cards next to native glass.

### 3.5 Parity: Web, Mac, iPhone, iPad

| Capability | Web | Mac | iPhone | iPad |
|---|---|---|---|---|
| Start cloud run | yes, with model and effort | prompt only | prompt only | as iPhone |
| Choose cloud mode or environment | no (API accepts both) | no | no | no |
| Steer a cloud run | yes | no | no | no |
| PR checks, auto-fix, open PR | yes | no | no | no |
| Run on my Mac (queued task) | yes (model dropped, C1) | n/a | yes, via the target chip | yes |
| Browse and continue Mac-local sessions (relay) | **no** | n/a | yes | yes |
| Approve a Mac action remotely | device tasks only | n/a | relay and device | relay and device |
| Know an approval is waiting while away | no push | n/a | background refresh, not push | same |
| Per-run cost | no | no | no | no |
| iPad-specific layout | — | — | — | none: phone column inside split detail |

### 3.6 Competitor protocol context

| Product | What it does | Source |
|---|---|---|
| Agent Client Protocol (Zed and others) | v1 tool calls carry `toolCallId`, `title`, `kind` (`read, edit, delete, move, search, execute, think, fetch, switch_mode, other`), `status` (`pending, in_progress, completed, failed`), diff and terminal content, and `locations`. Permission options are `allow_once/allow_always/reject_once/reject_always`. The v2 RFD (initial draft 2026-05-06, revised through July 2026) folds `tool_call`/`tool_call_update` into one upsert keyed by `toolCallId`, requires permission `title` plus a typed `subject`, makes `plan_update` item-based, and replaces modes with config options | agentclientprotocol.com/protocol/tool-calls (fetched 2026-09-30); agentclientprotocol.com/rfds/v2/overview. The v2 tool-call (2026-06-08) and permission (2026-07-02) RFD dates come from search snippets, **UNVERIFIED** on the pages themselves |
| Codex app-server | JSON-RPC over JSONL. Thread → Turn → Item with `started/delta/completed` notifications. Server-initiated approval requests. `turn/plan/updated`, `thread/tokenUsage/updated`, `turn/diff/updated`. `codex app-server generate-ts` and `generate-json-schema` emit version-pinned types. Experimental methods sit behind `capabilities.experimentalApi` | learn.chatgpt.com/docs/app-server (redirect from developers.openai.com/codex/app-server). No date on the page; fetched 2026-09-30 |
| Microsoft Agent Host Protocol | Multi-client layer over ACP. Host-authoritative state, server-sequenced actions (`serverSeq`), replay via `lastSeenServerSeq` | microsoft.github.io/agent-host-protocol/guide/ahp-and-acp (© 2026; no version date) |
| Claude Code Remote Control | Local session mirrored to web and mobile. Outbound HTTPS only; "registers with the Anthropic API and polls for work". Push for "actions required" (permissions and questions) | code.claude.com/docs/en/remote-control (fetched 2026-09-30) |

What this means for Juno:
- Juno's relay design (seq cursors, idempotent commands, a host that owns policy) is already AHP-shaped. Keep that.
- Borrow Codex's Thread/Turn/Item granularity and its schema-generation-with-version-pinning.
- Keep ACP-compatible tool `kind`, `status` and permission-option names, so an ACP bridge is cheap later.
- Do not adopt ACP wholesale: it is point-to-point, has no durable sequence or replay, and v2 is still in draft.

---

## 4. Branches and parallel work

| Branch | Ahead of main | Touches this area? | Action |
|---|---|---|---|
| `rework/review-fixes` | 22 | Yes (JunoCode) | **Already on main** by patch identity: `git cherry main rework/review-fixes` shows all `-`. Same messages on main, e.g. `ae803df1`, `8ff01076`, `7adfeec2`. Delete the branch |
| `code-rework/handoff` | 2 (docs only: `04-HANDOFF.md`, `tools/gh-shim.sh`) | Records the known gaps (pending-command TTL, character-floor billing, hooks types) | **Fold `04-HANDOFF.md`** into `docs/native/code-rework/` on this branch, since it is the only record of those gaps. Leave out `gh-shim.sh` |
| `web/tools-thinking-research` | 15 | No. It is the chat rework, but `5f89b888` "server advertises the chat features it understands" (`src/lib/chat/client-features.ts`) is a feature-negotiation precedent | Reference only; do not fold for Code |
| `agents/rework-native` | 3 | Edits `JunoMobileRootView.swift` and `JunoMobileConversationsView.swift` (Agents home), not Code files | No conflict with Code; owned by the Agents pause |
| `agents/{features,rework,runtime}`, `connectors/custom-mcp`, `design/voice-motion`, `skills/import-anywhere` | 0–4 | No | — |
| `origin/agent/code-live-steering-2026-08-28` (4), `…juno-production-remote-polish` (9), `…juno-code-macos-production-v2-2026-08-27` (8), `…juno-mobile-code` (19), `…juno-code-remote-orphan-recovery` (1) | unique patches | Pre-date the September Studio rebuild. Steering, the command compat mapper and path hiding (`devices/route.ts:38-68`) all exist on main in rebuilt form | **Superseded; do not fold.** `932904e0`'s `JUNO_CODE_PRODUCTION_PASS_2026-08-27.md` states the same "convergence, not absence" thesis and can be cited, not merged |

---

## 5. Recommendations, ordered by leverage

### R1. Make device-task settings reach the Mac (hours, P0)

Fixes C1 now. The protocol in R3 is the permanent fix.
- `serializeTask` emits `model` and `reasoningEffort`.
- The Swift decoder accepts `model` as a fallback for `modelId`.
- Replace the fixtures with the server's real output, and add a TS test that pins `serializeTask`'s key set against the Swift `CodingKeys`.

Files: `src/lib/code-remote.ts:287-326`, `native/Packages/JunoNativeKit/Sources/JunoCodeKit/NativeCodeAgentClient.swift:66-99`, `native/Packages/JunoNativeKit/Tests/JunoCodeKitTests/NativeCodeAgent{Client,TaskDecoding}Tests.swift`, a new `tests/code-task-wire.test.ts`.

### R2. Delete the dead remote and sandbox paths, and un-pin them from the gate (1 day, P0)

About 1,950 source lines plus 627 test lines. It removes the second task client and one of the two `CodeExecutionLocation`s.

Files to delete:
- `JunoCodeRuntime/{CloudCodeSandboxClient,LocalPythonSandboxClient}.swift`
- `Tests/JunoCodeRuntimeTests/CloudCodeSandboxTests.swift`
- `JunoCodeUI/Remote/*` (4 files)

Files to edit:
- `WorkbenchModel.swift:104-148,236-330`
- `NativeCodeAgentClient.swift` (drop the uncalled create, repository and task methods)
- `run-review.tsx:1012` (`RunReceipt`)
- `scripts/check-code-remote-wiring.mjs:57-73,120-125`

Either wire or delete the four orphan relay routes under `src/app/api/code/devices/[deviceId]/sessions/[sessionId]/`, and update `contracts/parity/features.json:664-679` to match. The recommendation is to keep them and use them from the web; see R5.

### R3. A versioned canonical agent session protocol (P0 design, 1–2 weeks for slice 1)

**Engine convergence decision.** Keep two engines for this refoundation:
- Swift for anything on a Mac: it needs `sandbox-exec`, fingerprinted writes, a PTY and 1,000+ tests.
- agent-core for Linux cloud Code and cloud Work: `work/` alone is about 6,400 lines.

Converge the *protocol*, the *permission grammar*, the *tool kinds* and the *transcript fold*, and prove it with shared fixtures. Revisit a single engine only after the protocol lands. The 01-AUDIT "option a" (Swift headless in the cloud) is not viable on GitHub-hosted Linux runners without replacing the sandbox layer.

**Where it lives**

- `contracts/agent/juno-agent-protocol-v1.json`: the single hand-authored source, in the same style as `contracts/work/juno-work-v1.json`. It contains:
  - `version {major, minor}`;
  - `enums` (each value with a summary);
  - `types` (records);
  - `events` and `commands` (discriminated on `type`, dotted names so they never collide with the underscore legacy kinds);
  - `extensions.code` and `extensions.work` namespaces.
- `contracts/agent/juno-agent-protocol-v1.status.json`: per-field producer and consumer status (`native` / `planned` / `web-only` / `cloud-only`), copied from the chat-wire pattern (`scripts/generate-chat-wire-contract.ts:1-31`).
- `contracts/agent/fixtures/*.jsonl` + `*.folded.json`: golden transcripts. Examples:
  - a run with parallel tools, an approval and a deny;
  - a steer mid-run;
  - a sub-agent;
  - a rewind restart;
  - compaction;
  - a question answered;
  - an unknown future event.

  Each has the folded view model every reducer must produce.

**Code generation**

A new `scripts/generate-agent-protocol.mjs`, hand-rolled like the three existing generators, over a restricted dialect: object, enum, `oneOf` with a `const` discriminator, array, primitives, `$ref`. It emits:
- `runner/agent-core/src/protocol/generated.ts`: types, type guards, and a tiny dependency-free validator. agent-core must keep building standalone, so it gets its own copy.
- `src/lib/agent-protocol/generated.ts`: the same text and the same digest header.
- `native/Packages/JunoNativeKit/Sources/JunoAgentProtocol/Generated/JunoAgentProtocol.swift`: a new **zero-dependency** SwiftPM target, so `JunoCodeCore` (dependency-free today, `native/Packages/JunoCode/Package.swift:34`) can depend on it without pulling `JunoCore`. It contains:
  - `Codable` structs with an explicit `type` key;
  - every enum with `case unknown(String)`;
  - the event union with `.unknown(type:raw:)`.

  The unknown cases fix the failure `VENDORED.md` §4 describes, where an unknown `JunoWorkDegradationKind` "would throw inside every shipped iOS/macOS build".

Wire the npm scripts `agent:protocol:generate` and `agent:protocol:check` into `native:sync:check` and CI.

**Envelope**

```
{ v: "1.0", id, sessionId, seq, at, turnId?, agentId?, type, …payload }
```

`seq` is 1-based and gap-refusing. The existing `CodeSessionEventAppendPlanner` rules apply unchanged (`CodeSessionProtocol.swift:120-178`).

**Events: core v1, about 16**

| Group | Events | Notes |
|---|---|---|
| Session | `session.started {target: local\|remote\|cloud, workspace?/repo?, model, effort, mode, capabilities[]}`, `session.updated`, `session.status {status, reason?}` | Status: `idle, running, awaiting_approval, awaiting_input, completed, failed, interrupted, cancelled` |
| Turn | `turn.started {input:{text, attachments[]}, origin: user\|steer\|queue\|hook\|remote}`, `turn.completed {stopReason, usage, durationMs, filesChanged, summary?}` | |
| Item | `item.upsert {itemId, kind, status, title, …}`, `item.delta {itemId, text}` | Kind: `message, reasoning, tool, file_change, command, test_run, subagent, compaction, error`. Status: `pending, in_progress, completed, failed, denied, interrupted`. A tool item carries `toolName`, `toolKind` (ACP kinds + `delegate`, `plan`, `ask`), `risk`, `exitCode?`, `locations[]`, `outputTail?` |
| Approval | `approval.requested {approvalId, itemId, title, summary, risk, digest, expiresAt, options: allow_once\|allow_always(rule)\|deny\|deny_with_feedback, suggestedRule?}`, `approval.resolved {decision, by: user\|rule\|mode\|timeout\|host}` | `by: mode` is how a cloud auto-allow is recorded honestly, replacing the "Auto-allowed in sandbox:" string row |
| Question | `question.asked {questionId, prompt, options?, multi?, expiresAt?}`, `question.answered` | Borrowed from Work (`work/session.ts:274`) |
| Plan | `plan.updated {steps:[{id,text,status}]}` | Borrowed from Work `update_plan` and Codex `turn/plan/updated` |
| Usage | `usage.updated {input, output, cacheRead, cacheWrite, reasoning?}` | Cost is not in the event. The server joins ApiSpend by run id (R8) |
| Transcript | `transcript.restarted {toTurnId}` | Replaces `canonical_session_event` |
| Error | `error {code, message, retryable}` | Codes: `plan_limit, rate_limited, provider_overload, context_overflow, tool_error, internal` |

**Commands: slice 2**

- `session.create`
- `turn.send {text, attachments, delivery: now|steer|queue}`
- `turn.cancel`
- `approval.decide`
- `question.answer`
- `session.update {model?, effort?, mode?, title?}`
- `change.accept|reject|undo`
- `git.action`
- `tests.run|stop`
- `session.fork|rewind`

Each has an `idempotencyKey`. Receipts are `pending|claimed|completed|rejected|expired`, with a TTL for pending, which fixes C5. These replace `CONTROL_KINDS`, the compat alias tables in both languages, and the sidecar verbs.

**Shared enums**

- **Mode:** `plan|ask|auto_edit|full`. Swift maps to its four internal cases at the edge, as `DesktopCodeHost.swift:50-55` already does.
- **Risk:** the Swift five tiers `read|write|execute|critical|destructive`. agent-core's `sensitive` maps to `destructive`.
- **Rule grammar:** the Swift `Tool(pattern)` grammar under `permissions.{allow,ask,deny}`.

**Versioning**

- Minors are additive. A reader must skip unknown `type`s and unknown enum values.
- The major is negotiated: a host advertises `protocolVersion`, using the existing `CodeDevice.protocolVersion` and `ExecutionTarget.protocolVersion`, and a client sends `x-juno-agent-protocol`.
- The server upcasts legacy kinds to canonical on read (`src/lib/agent-protocol/legacy.ts`). For one release it downcasts canonical to legacy for clients that announce no version, so shipped iOS and Mac builds keep rendering.

**Slice 1: the most convergence for the least effort. Events only, no behaviour change for users.**

1. Contract, generator, fixtures, and a TS reducer `foldAgentEvents` plus Swift `AgentTranscriptFold`, each tested against the fixtures.
2. **Cloud runner** emits canonical events. Add `runner/agent-core/src/protocol/project.ts` (`AgentEvent → canonical`), then delete `onAgentEvent`'s string building (`cloud-code-runner.mjs:1325-1379`) and the `" — ok"` suffix. The runner posts `item.upsert` and similar as `CodeTaskEvent` rows with kind equal to the dotted type. No schema migration: `kind` is a string.
3. **Web** reads everything through the fold, with the legacy upcaster. Delete the regex outcome parsing (`code-activity.tsx:48-58`). Files: `src/hooks/use-code-session.ts`, `src/components/code/{code-activity,code-run-cards,code-session-view}.tsx`.
4. **Mac:** one projection, `SessionEventPayload → canonical`, in a new `JunoCodeBridge/CanonicalEventProjection.swift`. It replaces both `DesktopCodeHost.swift:300-460` and `CodeRelayEventProjection.swift`, and relay uploads carry canonical events.
5. **iPhone:** `CodeRemoteThread` (`JunoCodeKit/CodeRemoteThread.swift`, 530 lines) and `RemoteEventTimeline`/`NativeCodeTaskStore` event folding are replaced by the generated fold. One transcript view then serves relay sessions and tasks.

Result: four producers (Swift local, Mac queue, Mac relay, cloud runner) and three consumers (web, iPhone task view, iPhone relay view) on one vocabulary.

**Work.** Work adopts the core events in slice 3. Its extra kinds stay under `work.*`: `artifact_*`, `source_cited`, `batch_*`, `budget_warning`, `degraded`, `host_*`, `validation_result`. `contracts/work/juno-work-v1.json` keeps its vocabularies and references the shared enums.

### R4. One permission grammar across both engines (P1, about 3 days)

- Port the Swift rule evaluator (deny > ask > allow; `Bash(prefix *)`, `Edit(glob)`, `Read(path)`, `WebFetch(domain:)`; the segment rules) to `runner/agent-core/src/permissions.ts`.
- Read `.juno/settings.json`'s `permissions` object, and accept the legacy top-level `allow`/`deny` for one release.
- **In cloud runs, repository rules may only narrow the mode**, fixing C2 (`permissions.ts:80-88`).

Put the rule grammar's test vectors in `contracts/agent/fixtures/permission-rules.json` and run them in both languages. Files: `runner/agent-core/src/permissions.ts`, `src/test/*`, `native/Packages/JunoCode/Tests/JunoCodeCoreTests/PermissionRulesTests.swift`.

### R5. One "run on my Mac" and a web view of Mac sessions (P1, 1–2 weeks after R3)

- Make a device target create a **relay session** (`session.create` command) rather than a queued `CodeTask`. The server can translate `POST /api/code/tasks {target:device}` so old clients keep working.
- Retire `/api/code/queue` and `DesktopQueuedCodeHost`'s separate projection. Steering, rollback and approvals then behave the same on every surface.
- Give the web a per-device session list and thread that read `CodeRemoteSession` through the canonical fold. This finally uses the four orphan relay routes.

Files: `src/app/api/code/tasks/route.ts`, `src/app/api/code/queue/route.ts`, `native/macOS/JunoDesktop/App/DesktopCodeHost.swift`, new web components under `src/components/code/`, `JunoMobileCodeView.swift` (drop the device option from the Cloud target picker so iPhone has one path).

### R6. Native cloud parity for controls the server already has (P1, about 1 week)

- `CreateTaskWire` gains `model`, `reasoningEffort`, `permissionMode`, `environmentId` and `baseRef`.
- The Mac `StudioLanding` passes its composer values.
- The iPhone gets the same pickers.
- Add steer (`/steer`) and PR checks to native task views.

On the web, expose mode and environment in the Code composer, and correct the stale copy in `code-composer.tsx:62-80` and `code-customize.tsx:326-357`.

Files: `NativeCodeTaskStore.swift:534-585,1259-1300`, `NativeCodeModel.swift:300-335`, `StudioLanding.swift:492-505`, `JunoMobileCodeView.swift`, `src/components/code/{code-composer,code-customize}.tsx`.

### R7. Relay transport and attention (P1, about 1 week)

- Add a pending-command TTL (C5).
- Replace the 1–1.5 s Postgres polls in four routes with `LISTEN/NOTIFY` fan-out, or at minimum a single per-device host channel that also carries queue work.
- Add APNs push for `approval.requested`, `question.asked` and `session.status=completed`, replacing background-refresh polling (`JunoMobileCodeNotifications.swift:1-12`).

Files: `src/lib/code-session-command-lease.ts`, the four route files cited in §2.1, `JunoMobileCodeNotifications.swift`, and a new push sender.

### R8. Cloud engine cost and attribution (P1, about 1 week)

- Anthropic `cache_control` breakpoints on tools, system and the newest block, plus cache fields in `Usage` (`providers/anthropic.ts:188-201`, `types.ts:9-12`).
- Model-written compaction in `loop.ts` and `agent.ts`, reusing the Swift prompt.
- Signed-thinking replay in `ChatMessage` (`types.ts:15-27`).

This lowers the cost of cloud Code *and* cloud Work.

For attribution:
- Add an `x-juno-run: <task|session|workRun id>` header that the proxy records on `ApiSpend`. It is attribution only, never billing: the proxy still bills every call (`route.ts:49-75`).
- Show cost per run on every surface.
- Stop filing Mac-hosted Work spend as `code` (`route.ts:57-61`).

### R9. Visual clean-up for the design phase (P2)

Remove:
- presence dots: `code-target-picker.tsx:763-766`, `code-customize.tsx:303-306`;
- the "Mac connected" label: `code-session-meta.ts:216`;
- the running `AgentStatusBadge` and the orbs in the session header: `code-session-banner.tsx:354-359,436`;
- "Online" subtitles: `JunoMobileCodeRemote.swift:31`, `JunoMobileCodeView.swift:1115-1121`.

Say only what needs the reader: offline, needs approval, failed. Give the Phase 2 design decision these items:
- the serif-italic greeting (`src/app/(app)/code/page.tsx:114-121`, iOS `JunoSerif.greeting`);
- the warm-neutral-plus-coral Studio palette (`StudioTheme.swift:15-17`);
- the two chip materials on the iPhone host strip (`JunoMobileCodeRemote.swift:102-118` vs `JunoGlassCapsule`).

### R10. Repository hygiene (P2)

- Archive or delete `native/desktop-electron`: 62,961 lines, no CI, status frozen at 2026-08-13. If it goes, also delete agent-core's `server.ts`, `serve.ts` and `usage.ts` (`BackendUsageReporter`), and the `/api/agent/usage` reserve/refund path if it has no other caller (**UNVERIFIED**).
- Rewrite `runner/agent-core/VENDORED.md` to say the vendored copy is canonical.
- Fold `04-HANDOFF.md` from `code-rework/handoff`.

# Juno Code production pass — 2026-08-27

This document records the production issues found while auditing the current web, iOS and macOS Juno Code surfaces. It is intentionally concrete: shipped architecture, observed failure modes, fixes in this branch, and the remaining convergence work required for a first-class remote coding product.

## Product standard

Juno Code Remote should feel like one coding session that can be supervised from any signed-in surface, not like a mobile task dispatcher attached to a desktop agent.

A user should be able to start or resume work, see the same state everywhere, steer an active run, answer approvals, inspect terminal/test/change/agent/preview evidence, stop work instantly, reconnect without losing context, and understand exactly which trusted host/workspace is being controlled.

## What is already strong

The repository already contains most of the primitives expected from a serious coding-agent product:

- durable Code conversations and task history;
- Cloud and local-device execution targets;
- macOS Workbench execution with one permission model;
- approvals and cancellation;
- SSE task event streaming with reconnect/cursors;
- file-change, test, preview and subagent event types;
- pull-request surfaces;
- a separate CodeRemoteSession protocol with idempotent commands and cursor-based events;
- remote-host heartbeat/capability separation (`online` is not treated as `canAcceptWork`);
- explicit local consent before a Mac serves remote work.

The main product problem is convergence, not absence.

## P0 issues found in this audit

### 1. Mobile and macOS used different command vocabularies

The relay accepted and persisted legacy mobile verbs such as:

- `message`
- `stop`
- `approval`
- `patch`
- `delete`
- `git`

The current macOS `RemoteCommandAdapter` executes canonical Workbench verbs:

- `send_message`
- `stop_agent`
- `approval_decision`
- `apply_patch`
- `delete_change`
- `git_action`

That allowed a command to be authenticated, queued and claimed successfully, then fail at the final host boundary as unsupported.

**Fixed in this branch.** Both session-specific and generic command entry points now normalize legacy verbs/payload aliases before persistence. The compatibility mapping is a pure module with regression tests.

### 2. The remote device list exposed absolute host paths

Modern macOS hosts already publish a stable opaque workspace key, and queued execution resolves that key before considering a path. Remote clients therefore do not need to know `/Users/...` to address a workspace.

**Fixed in this branch.** `/api/code/devices` replaces paths for keyed workspaces with a non-sensitive compatibility label before returning them to remote clients. Legacy key-less hosts retain the old path contract until they are upgraded.

### 3. iOS has two Remote concepts but primarily exposes the less capable one

The iOS Code UI is driven by `NativeCodeModel` and `/api/code/tasks`. It is good at durable task history, SSE observation, approval and cancellation, but its follow-up flow deliberately waits until a task is terminal and starts another execution in the same conversation.

Separately, `NativeCodeRemoteClient` / `CodeRemoteBrowserModel` can address a live macOS session and has a command vocabulary for live message, stop, retry/fork, test, git and change controls.

The macOS host runs both mechanisms.

This split is the largest remaining reason Remote feels less coherent than a best-in-class mobile coding experience.

## Required convergence

### P0 — one live session contract

Make a single session identity the source of truth across web, iOS and macOS. A Code task should be an execution record *inside* that session, not a second remote-control universe.

The mobile session view should be able to send a steering message while an execution is active. That message must land on the same Workbench controller, preserve the current permission ceiling, appear in the durable conversation, and receive an acknowledgement/idempotency key.

Do not implement this by teaching iOS to guess which of the two protocols owns a task. Add an explicit server projection linking the durable task/conversation/session to the host session id.

### P0 — capability handshake

Remote controls must be capability-driven. The phone should only render actions the connected host promises it can execute. At minimum publish capability/version bits for:

- live steering;
- approvals;
- stop;
- retry/fork;
- tests;
- file rollback/accept/reject;
- git actions;
- preview/browser evidence;
- subagents;
- computer-use observation/control.

Presence is not capability. Keep the same principle already used by `servesQueuedTasks`.

### P0 — command lifecycle UI

Every phone → Mac action should have a visible lifecycle:

`sending → queued → claimed → completed` or `failed`

Do not optimistically imply success merely because the relay accepted the HTTP request. Surface host refusal, stale host, permission refusal and version mismatch as different user-facing states.

### P0 — reconnect semantics

Preserve the existing event cursor approach, but expose connection state in the session chrome:

- Live
- Reconnecting
- Host offline
- Host stale
- Waiting for approval
- Stopped

Reconnect must never duplicate transcript rows or lose a pending approval.

## iOS experience target

The session screen should be supervision-first rather than diagnostics-first.

1. **Thread** — user direction and agent prose are the primary timeline.
2. **Live activity rail** — compact current action, elapsed time, connection/host state.
3. **Needs you** — approval or question is pinned above the composer until resolved.
4. **Composer always available** — while running it steers the current execution; after completion it continues the durable session.
5. **Evidence drawer/tabs** — Changes, Terminal, Tests, Preview, Agents and Git remain available, but they support the thread instead of replacing it.
6. **Host identity** — friendly device + workspace name, online/capability status, never raw filesystem paths.
7. **Motion** — use motion to communicate state changes and continuity; respect Reduce Motion and avoid perpetual decorative animation.

## macOS experience target

The Mac remains the authority for local filesystem access and permission escalation.

- Remote hosting is off until explicitly enabled locally.
- A phone may never increase a session's permission authority.
- Full access remains a local-machine decision.
- The desktop Code workspace should visibly show when a session is being supervised remotely and which remote commands were accepted.
- Host settings should show last heartbeat, serving state and shared workspace count with actionable failure copy.
- Session sidebar/state vocabulary must match web and iOS exactly.

## Web experience target

The `/code` root is correctly becoming a command center rather than a hidden composer route. Keep the hierarchy:

1. Needs you
2. Active work
3. Recently finished
4. New session
5. Pull requests / produced artifacts

Navigation must remain responsive and keyboard accessible. Do not add dashboard chrome that repeats information already visible in the run list.

## Release gates

Before calling Remote production-ready, require:

- protocol-compatibility tests for legacy/current clients;
- task/session identity convergence tests;
- host-offline and stale-host tests;
- idempotent message/stop/approval tests;
- permission escalation rejection tests;
- reconnect/replay tests;
- no absolute host path in any mobile/web response for keyed workspaces;
- VoiceOver and keyboard navigation pass;
- Reduce Motion pass;
- light/dark/high-contrast screenshots for Code home + active run + approval + reconnect + failure;
- macOS/iOS integration test proving: start on phone → Mac executes → steer while active → approve → inspect diff/tests → stop/finish → continue same conversation.

## Changes in this branch

- Canonical remote command compatibility layer.
- Relay normalization for both generic and dedicated session command routes.
- Regression tests for message/stop/approval/change/git compatibility.
- Keyed workspace path redaction on the remote device list.
- Responsive, keyboard-visible, Reduce-Motion-aware Code surface navigation on web.

This branch deliberately does not fake protocol convergence in the UI. The next implementation should link the two existing execution/control planes explicitly and then simplify the iOS/macOS presentation around that single source of truth.

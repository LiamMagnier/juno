# Juno competitive parity review — 2026-08-27

## Purpose

This document reviews Juno Chat, Juno Code and Juno Work across the website,
macOS and iOS against the current product patterns in ChatGPT / ChatGPT Work /
Codex, Claude / Cowork / Claude Code, and Gemini / Antigravity.

The goal is **not** to clone another company's visual language or collect feature
checkboxes. The goal is to make Juno feel like one coherent, production-grade
agent platform whose capabilities are truthful and equally understandable on
every surface.

## Executive verdict

Juno already has an unusually broad technical base:

- multimodal Chat, projects, memory, research, voice, connected apps, artifacts,
  Python/data outputs, assistants and scheduled tasks;
- a native Code runtime with local/cloud execution, permissions, checkpoints,
  diffs, subagents, tests, browser/computer-use primitives and Git workflows;
- Work sessions/runs, cloud/local/automatic routing, approvals/questions,
  artifacts, file/browser/computer use, connector context, durable schedules,
  event triggers, budgets, host policies and capability-aware execution;
- shared native and web design systems, semantic tokens, reduced-motion support,
  warm canvas/surface hierarchy, and platform-native navigation primitives.

The largest gap is therefore **coherence, not raw feature count**.

Today several capabilities exist in parallel implementations or are exposed on
only one platform. That produces the exact feeling users describe as "Juno has
this, but ChatGPT/Claude feels better": the capability is technically present,
but the product contract changes depending on where the user opens it.

The highest-leverage strategy is:

1. converge session identity and live control planes;
2. converge extensions/capabilities into one registry;
3. converge artifacts and progress/approval vocabulary;
4. expose the same cloud-owned state on web/macOS/iOS;
5. keep local-only powers local, but make their presence and availability clear
   everywhere;
6. eliminate old UI islands that bypass the shared design system.

---

# 1. Competitor product patterns worth matching

## OpenAI — ChatGPT, Work and Codex

Current OpenAI product behavior establishes a strong three-mode contract:

- **Chat** is the fast conversational surface.
- **Work** is a longer-running agent for research, connected apps/files and
  finished deliverables.
- **Codex** remains a dedicated software-development workspace.
- Chat + Work share Recents and Projects on desktop; cloud Work continues across
  web/mobile/desktop.
- Work can run once, on a schedule, on supported connected-app events or as a
  condition monitor.
- Desktop Voice can coordinate Work and Codex.
- Codex Remote on mobile loads the *live state of the host*: active threads,
  project context, approvals, plugins, screenshots, terminal output, diffs and
  test results. The phone can start/continue work, answer questions, change
  direction, change models and approve commands rather than merely dispatch a
  task and watch it.

Product lesson for Juno: **continuity is a feature**. The user should be able to
move between devices without translating one execution model into another.

Official references:

- https://help.openai.com/en/articles/20001275/
- https://openai.com/index/work-with-codex-from-anywhere/
- https://help.openai.com/en/articles/6825453-chatgpt-release-notes

## Anthropic — Claude, Cowork and Claude Code

Current Claude product behavior emphasizes a shared extension and execution
model:

- Cowork sessions can be started, steered, reviewed and resumed on desktop, web
  and mobile.
- Sessions/files follow the account across devices for cloud Cowork.
- Connectors, Skills and plugins are available across Cowork surfaces.
- Plugins can bundle instructions/skills, connectors and subagents so a domain
  workflow can be installed as one capability rather than manually assembled
  from separate settings pages.
- Claude Code and Cowork reuse the same plugin/agent building blocks.
- Local desktop work can use the user's applications/files while cloud sessions
  remain account-owned and resumable.

Product lesson for Juno: **extensions should be composable packages**, not three
unrelated concepts called Assistants, Connections and Work Skills.

Official references:

- https://support.claude.com/en/articles/15520349-use-claude-cowork-on-web-desktop-and-mobile
- https://www.anthropic.com/news/finance-agents
- https://www.anthropic.com/news/apple-xcode-claude-agent-sdk

## Google — Gemini and Antigravity

Current Google product patterns emphasize persistent agents plus connected
context:

- Gemini expands connected apps so one assistant can read/action multiple
  services without moving users into separate mini-products.
- Antigravity treats custom agents, skills, project resources, hooks,
  background/subagents, worktrees and scheduled work as first-class agent
  configuration.
- Managed Agents expose a versionable agent definition with instructions,
  skills/data and isolated execution.
- Gemini increasingly turns long-running goals into persistent generated tools,
  briefs and experiences rather than one-off messages.

Product lesson for Juno: **agent definitions should be portable, inspectable and
versionable**, and long-running work should produce durable objects users can
return to.

Official references:

- https://blog.google/innovation-and-ai/technology/developers-tools/managed-agents-gemini-api/
- https://blog.google/innovation-and-ai/products/gemini-app/new-connected-apps-services-gemini-august-2026/

---

# 2. Juno Chat review

## What is already strong

Website:

- broad model catalog and automatic routing;
- multimodal attachments and generated images;
- Deep Research;
- Python execution with data tables/charts/files;
- projects and project context;
- memory + explicit memory management;
- assistants;
- MCP/connected apps;
- artifacts and share/export flows;
- scheduled tasks;
- realtime voice/dictation/read-aloud;
- usage/profile/settings controls.

macOS:

- native chat history and project sync;
- model selection and account defaults;
- project workspaces;
- local document indexing;
- connectors, artifacts, memory, scheduled tasks;
- native realtime voice;
- local app integration opportunities that web cannot safely provide.

iOS:

- native synced conversations/projects/artifacts/memory/connections/tasks;
- realtime voice that stays in the Chat surface rather than replacing it with a
  disconnected full-screen mode;
- camera/files/attachments and mobile navigation designed around the phone.

## Gaps versus top products

### P0 — one extension vocabulary

Juno currently exposes:

- Assistants;
- project-level assistant settings;
- Connections/MCP;
- Work Skills;
- Code runtime capabilities;
- hooks/automation concepts in different places.

These should become one **Extension Registry** with typed parts:

```text
Extension
  metadata
  instructions / skills
  connectors
  tools
  subagents
  hooks
  allowed surfaces: Chat | Code | Work
  required capabilities
  permission policy
  version
```

The UI can still present friendly views (Assistants, Skills, Connections), but
all should be projections of the same registry. This is how Juno gets Claude's
"one plugin installs the complete workflow" advantage without losing Juno's
more explicit permission model.

### P1 — cross-surface live voice

Voice should be a first-class input/control channel for:

- Chat: current behavior;
- Work: "continue the report, skip the appendix, ask me before sending";
- Code: "run those tests again", "open the preview", "do not change auth".

Desktop can expose the richest local mode; mobile voice should steer cloud Work
and remote Code through their existing relay permissions rather than pretending
the phone owns local capabilities.

### P1 — artifacts as one durable workspace

A document/chart/site/code preview created in Chat, Work or Code should share:

- one artifact identity;
- revisions;
- preview;
- export/download;
- provenance (which conversation/run made it);
- comments/feedback;
- cross-device sync when cloud-owned.

Native surfaces should render the same artifact, not a thinner attachment card.

---

# 3. Juno Code review

## What is already strong

- native Workbench architecture rather than a wrapper around a competitor CLI;
- permission modes and anti-escalation rules;
- durable sessions/events/checkpoints;
- local and cloud execution;
- device heartbeat/capability advertisement;
- task SSE and a richer live remote-session protocol;
- subagent lifecycle events;
- file changes/diffs and rollback primitives;
- structured tests;
- preview/browser/computer-use primitives;
- Git/PR integration;
- multiple runtime/provider abstraction;
- worktree-oriented parallel work in the native architecture.

## P0 — converge the two Remote control planes

This is the most important product gap in Juno Code.

Today:

1. `/api/code/tasks` is a durable task/execution ledger used heavily by the
   mobile Code UI.
2. `CodeRemoteSession` is a richer live-session protocol with commands/events
   for the actual Workbench.
3. macOS can host both.
4. iOS primarily presents the task protocol.

Result: the phone can observe rich output but does not consistently behave as a
live window into the exact same Workbench thread.

Target:

```text
CodeConversation (durable product history)
  └─ CodeSession (live identity, local/cloud/remote)
       ├─ executions / turns
       ├─ event cursor
       ├─ permissions
       ├─ model / effort / behavior
       ├─ attachments
       ├─ changes / checkpoints
       ├─ tests
       ├─ preview / browser / computer use
       ├─ subagents
       └─ git state
```

`CodeTask` should become an execution/audit projection, not a second session
model.

The phone should therefore be able to:

- send a live steering message while the agent is running;
- stop/retry/fork;
- answer approval requests;
- change model/effort where policy permits;
- inspect terminal output, diffs, tests, preview screenshots and subagents;
- run/stop tests;
- accept/reject/undo changes when the host advertises support;
- perform Git actions when permitted;
- move between connected hosts while retaining thread identity;
- receive "needs you" / completion notifications.

### P0 — capability handshake, never fake controls

Every remote surface should be rendered from a capability document reported by
the executing host/runtime.

Example:

```json
{
  "steer": true,
  "approvals": true,
  "tests": true,
  "changeControl": "file-and-turn",
  "git": ["status", "commit", "push", "pr"],
  "preview": true,
  "browser": true,
  "computerUse": false,
  "subagents": true,
  "attachments": ["image", "text", "file"]
}
```

A client must not infer capability from "online" or from an event it happened to
see. This follows the same principle already introduced for
`servesQueuedTasks`.

### P1 — Code extensions

Close the explicit CODE_AGENTS gap:

- project/global skills;
- MCP servers/connectors;
- hooks (pre-tool, post-tool, prompt validation, audit, memory capture);
- custom agents/subagents;
- reusable run profiles;
- automation triggers for CI/repository events.

These should use the shared Extension Registry rather than create a Code-only
marketplace.

### P1 — development evidence as first-class UI

A completed run should have a stable review summary:

- goal and success criteria;
- changed files / unified diffs;
- test summary;
- screenshots/preview evidence;
- terminal commands with exit status;
- subagent contributions;
- Git branch/commit/PR;
- known failures / skipped verification;
- checkpoint/undo availability.

The information mostly exists already; it must be composed into one review
surface consistently on web/macOS/iOS.

---

# 4. Juno Work review

## What is already strong

Juno Work already has more automation infrastructure than its current UI name
communicated:

- durable tasks and multiple runs;
- cloud/local/automatic target selection;
- host presence and capability selection;
- connector and file context;
- approvals and questions;
- artifacts;
- budgets and runtime ceilings;
- unattended, host-offline, missed-run and notification policies;
- time triggers;
- email filters;
- calendar-window triggers;
- topic monitors;
- generic connector events;
- granted-folder changes;
- manual run-now;
- deduplication windows and persistent run history.

The web surface has now been renamed from **Recurring** to **Automations** so the
product stops hiding event-driven behavior behind a clock-shaped label.

## P0 — iOS Automations parity

The native `NativeWorkAutomationClient` and `NativeWorkAutomationModel` already
exist. macOS composes them; iOS currently does not expose them in its Work root.

Mobile should support:

- Active / Paused automation list;
- next run / last run;
- humanized triggers;
- Run now;
- Pause / Resume;
- recent run history;
- inspect target and capability requirements;
- edit/delete with explicit confirmation;
- creation with the same trigger vocabulary as web/macOS.

This should be cloud-owned state, so an automation made on the phone appears on
the Mac/web immediately.

## P0 — event-trigger integrations should be visible as integrations

The trigger editor should present connected sources by product identity rather
than make users type connector IDs. For example:

- Gmail / Mail → sender/subject filters;
- Calendar → upcoming meeting;
- GitHub → PR/issue/repository activity where connector support is available;
- Slack/Teams/Discord → channel/message activity where connector support is
  available;
- generic webhook/event source only as an advanced option.

The backend should still store canonical connector IDs and event names.

## P1 — Work deliverable workspace

Like Cowork/ChatGPT Work, a long task should read as producing a deliverable,
not merely a transcript.

The thread layout should prioritize:

1. current objective/status;
2. "Needs you" item;
3. working notes/activity;
4. deliverables/artifacts;
5. sources/context;
6. run history and automation policy.

---

# 5. Cross-platform parity matrix

Legend: ✅ strong, ◐ available but weaker/incomplete, ○ missing from that surface.

| Capability | Web | macOS | iOS | Priority |
|---|---:|---:|---:|---:|
| Chat history/projects | ✅ | ✅ | ✅ | — |
| Memory management | ✅ | ✅ | ✅ | polish |
| Connected apps | ✅ | ✅ | ✅ | unify registry |
| Custom assistants | ✅ | ◐ project-local | ◐ project-local | P1 |
| Deep Research | ✅ | ◐ | ◐ | P1 |
| Voice Chat | ✅/platform-dependent | ✅ | ✅ | — |
| Voice steering Work/Code | ○ | ○ | ○ | P1 |
| Durable artifacts | ✅ | ✅ | ✅ | unify revisions/previews |
| Work tasks | ✅ | ✅ | ✅ | — |
| Work local execution | n/a | ✅ | remote supervision | — |
| Work automations | ✅ | ✅ | ○ UI (client exists) | **P0** |
| Work event triggers | ✅ | ✅ backend/client | ○ UI | **P0** |
| Work skills | ✅ | ◐ | ○ | P1 |
| Code local Workbench | browser/cloud view | ✅ | remote only | expected |
| Code cloud tasks | ✅ | ✅ | ✅ | — |
| Code live remote steering | ◐ | host | ◐ task-oriented | **P0** |
| Code tests/diffs/preview/agents | ✅ | ✅ | ◐ | **P0/P1** |
| Code skills/MCP/hooks | ◐ | ◐ | ○ | P1 |
| Cross-device agent notifications | ◐ | ◐ | ◐ | **P0** |
| Unified extension registry | ○ | ○ | ○ | **P0** |
| One design system | ✅ core / some islands | ✅ core | ✅ core | continuous |

---

# 6. Design review

## Existing foundation to keep

The current design direction is defensible and should *not* be replaced by a
competitor clone:

- warm editorial canvas;
- coral/accent used sparingly;
- serif page/greeting moments, normal UI face for controls, mono only for code
  and machine metadata;
- opaque content cards and glass for floating chrome;
- semantic status vocabulary;
- Reduce Motion support;
- native Liquid Glass where available;
- platform-native navigation stacks/split views;
- centralized web Dialog/Sheet/Popover/Dropdown primitives.

## Main design problem: bypasses

Several older product surfaces bypassed that system with:

- `neutral-*` and raw `coral-*` Tailwind colors;
- `bg-[#…]` one-off surfaces;
- raw `rounded-xl/rounded-2xl` rather than the Juno radius ladder;
- hand-built full-screen modal backdrops;
- browser `confirm()`;
- raw form controls with local focus styles;
- hover-only controls with no coarse-pointer fallback.

This pass fixes the largest obvious examples in Assistants, Memory policy notice,
and Chat Python/data output. Continue the sweep through remaining old blocks
(`context-inspector`, profile remnants, reasoning controls and any raw generated
media cards).

## Production UI rubric — every new window/sheet/popover/card

1. **Use a shared primitive**. Do not create a second modal, sheet, dropdown,
   tooltip, card or segmented control unless the existing primitive cannot
   express the interaction.
2. **Semantic tokens only** for application chrome. Raw palette colors are
   allowed only when data itself encodes a category/series and no product token
   represents it.
3. **One emphasized action per surface**. Other actions are neutral or
   destructive by meaning.
4. **44 pt / equivalent coarse-pointer targets** for touch-critical actions.
5. **Keyboard-visible focus** on web/macOS and predictable tab order.
6. **Reduce Motion** must remove decorative transforms/spinners that are not
   necessary to communicate progress.
7. **State in words, not color alone**: Running, Waiting on you, Failed,
   Reconnecting, Done.
8. **A spinner must imply real work**. Never animate stale/offline state.
9. **No raw local paths on remote clients**. Use workspace identity/name.
10. **No fake capabilities**. Hide/disable a control when the executor did not
    advertise it, and say why when that absence is actionable.
11. **Never lose user text on a failed send**. Clear composers only after an
    acknowledged mutation.
12. **Every destructive action gets product-native confirmation**, not
    `window.confirm`.
13. **Responsive means recompose, not shrink**. Use sheets/drawers/stacked
    content at narrow widths rather than compressing desktop control bars.
14. **Deliverables outrank logs** after a run finishes.

---

# 7. Implementation plan

## P0 — product-defining

### P0.1 Code Remote convergence

Owner surfaces: relay, macOS Code host, iOS Code, web Code.

Acceptance:

- one durable Code conversation + one live session identity;
- steering during active execution from iOS;
- event-cursor resume after disconnect;
- live capability document;
- approvals/stop/retry/fork/tests/change controls/git surfaced from that
  capability document;
- no host paths/credentials leave the host-facing contract;
- remote push notifications for approval/question/completion;
- same thread can be inspected on another authenticated client without forking
  execution identity.

### P0.2 iOS Work Automations

Owner surfaces: iOS shell/Work + existing NativeWorkAutomationModel.

Acceptance:

- list active/paused;
- create/edit/delete;
- run now with existing idempotency contract;
- trigger editor for every servable trigger;
- recent run history;
- clear unsupported-option messaging from server vocabulary;
- state sync with web/macOS.

### P0.3 Unified Extension Registry

Acceptance:

- canonical extension schema;
- migrations/adapters from existing Assistants, Work Skills and Connections;
- surface capability allowlist;
- versioning;
- permission review before installation/enablement;
- project/global scopes;
- bundle support for instructions + connectors + subagents + hooks;
- no extension can silently escalate local permissions.

### P0.4 Cross-device notifications

Events:

- approval required;
- Work question;
- remote host unavailable/interrupted;
- Code/Work completed;
- automation failed;
- budget/runtime limit reached.

Notification opens the exact session and event, not a generic destination.

### P0.5 Design consistency gate

Add a CI audit that detects raw product-palette/radius/modal patterns in product
UI directories and maintains an explicit reviewed allowlist for genuine data
visualization colors.

## P1 — competitive depth

- Code Skills/MCP/hooks/custom agents;
- Work Skills available on native surfaces;
- unified artifact revision/preview experience;
- Voice control for Work/Code;
- built-in browser side panel with annotated screenshots and provenance;
- richer subagent tree with parent/child summaries;
- goal/success-criteria mode in Code and Work;
- reusable execution profiles (model/effort/permissions/tools);
- better project context inspector shared by Chat/Code/Work;
- local app context capture on macOS with explicit per-app grants.

## P2 — ecosystem

- extension/package marketplace;
- signed extension manifests;
- CLI/SDK for creating extensions and agents;
- managed/cloud agent API;
- enterprise extension allowlists and audit exports;
- shareable templates for assistants, Code profiles and Work automations.

---

# 8. Release gates

A parity feature is not complete when a button exists. It is complete when these
are true:

## Functional

- unit tests for pure contracts;
- transport/idempotency tests;
- stale/replay/out-of-order event tests;
- cross-device reconnect tests;
- old-client compatibility tests where the protocol is additive;
- permission-escalation negative tests;
- offline and host-sleep tests;
- notification deep-link tests.

## Native

- strict iOS build + unit tests;
- strict macOS Debug and Stable builds + unit tests;
- JunoCode/JunoWork/JunoNativeKit package tests;
- design glass/motion/type/target checks;
- VoiceOver labels for every state-changing icon-only control.

## Web/server

- TypeScript typecheck;
- full tests;
- lint;
- schema/migration replay;
- capability/work contract drift checks;
- security/sandbox gates;
- responsive screenshots at phone/tablet/laptop/desktop widths;
- keyboard-only interaction pass;
- Reduce Motion pass.

## Product truthfulness

- no "online" state interpreted as execution capability;
- no control offered without an advertised executor capability;
- no absolute host paths rendered remotely;
- no queued work left indefinitely without an actionable explanation;
- no cloud/local label that obscures where files/credentials actually live;
- no local-only feature described as account-synced.

---

# 9. Changes landed in the 2026-08-27 production pass

## Already merged to main (#34)

- Code Remote command compatibility across legacy mobile/current native host
  vocabularies;
- normalization of message/approval payload aliases;
- keyed workspace path redaction for remote clients;
- command compatibility regression tests;
- responsive/accessibility polish for Code web navigation;
- initial Remote convergence architecture document.

## Competitive-parity continuation branch

- Work web `Recurring` renamed to **Automations**, accurately exposing clock +
  event triggers;
- Work navigation made resilient to narrow windows;
- Assistants gallery moved onto the shared Juno page/card/form/dialog language;
- Assistant Studio moved to the shared Dialog system;
- fixed stale Assistant Studio state when switching between assistants;
- replaced browser confirmation with an accessible Juno deletion dialog;
- Memory policy/error chrome moved off hardcoded dark/raw-neutral surfaces;
- Chat generated data tables moved to shared cards/buttons/inputs and a safer
  Blob-based CSV export;
- Chat generated charts moved to shared card/button/motion vocabulary;
- Python execution output moved to semantic Juno surfaces and a real disclosure
  button.

---

# 10. Bottom line

Juno can compete by being **more coherent**, not by becoming a visual clone or
adding another menu for every competitor feature.

The platform already owns the difficult primitives: models, sync, permissions,
remote hosts, local execution, artifacts, triggers, connectors and native
runtimes. The next level is to make those primitives feel inevitable from every
client:

- start anywhere;
- understand exactly where it runs;
- steer from anywhere permitted;
- see the same state everywhere;
- install a capability once;
- approve consequential actions explicitly;
- get a finished artifact, not merely a log;
- never be shown a control the runtime cannot honor.

That is the product standard to use for every future Juno Chat, Code and Work
change.
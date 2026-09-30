# How coding agents loop: mechanisms, and what Juno Code should adopt

Phase 0 research, written 2026-09-30, read-only against `rework/refoundation` (`3e3040e6`, same code as `main` @ `1feb392c`).

**Question.** The owner wants Juno Code to be "a real agent that can autonomously loop: think about what it has done, build, loop", the way Codex and Claude Code do, and to add and fix computer use and preview. This file answers one part of that. What mechanisms make the leading agents keep working until the job is done, verify it, and stop at the right time? Which of those mechanisms is Juno missing?

**Method.**
- Competitor claims come from first-party pages read live on 2026-09-30:
  - learn.chatgpt.com and the `openai/codex` GitHub repository (source, PRs and issues)
  - code.claude.com (fetched as raw markdown) and anthropic.com/engineering
  - cursor.com docs, changelog and blog
  - docs.x.ai
  - antigravity.google and developers.googleblog.com
- Most docs pages are undated living documents. They are cited as "accessed 2026-09-30", with any version markers the page carries.
- Third-party material is labelled **[3P]** and used only to fill gaps.
- Anything I could not confirm first-hand is marked **UNVERIFIED**.
- Earlier Juno research (`docs/native/code-rework/research/*.md`, 2026-09-22; `docs/rework/research/*.md`, 2026-09-30) is cited as such where it is the source.
- Juno claims cite `path:line`. Unless a path starts with `native/`, `runner/` or `docs/`, it is relative to `native/Packages/JunoCode/Sources/`.

**Out of scope, because another workflow is building it now.** This file does not re-specify the following. Where a recommendation depends on one of them, it says so.
- Loop hardening: cache-prefix stability, retries with backoff, crash-safe tool batches, malformed tool JSON, output spill, a usage ledger.
- New tools: durable shells, `multi_edit` and multi-file `apply_patch`, image and PDF reads, grep context, `todo_write`, `ask_user`, `exit_plan`.
- Nested `AGENTS.md`, and a trust gate for skills.

---

## 0. The answer in brief

1. **In every leading product, the runtime owns "keep going", not the model.** The model saying it is done is only a proposal. By September 2026 all three majors ship a **goal mode**: Codex `/goal` (CLI 0.128.0, 2026-04-30), Claude Code `/goal`, and Cursor `/goal` (2026-08-19). In each, the harness schedules the next turn and a completion gate decides when the loop ends. Prompt-only persistence ("keep going until done") is known to fail: Codex issue #36596 (2026-08-02, open) documents about ten premature stops in one session.
2. **Something other than the worker decides that the work is done:**
   - Codex injects a *completion audit* prompt after each turn. It requires a checklist that maps every requirement to evidence on disk.
   - Claude Code runs a *separate small model* (Haiku by default) after every turn. It returns *not yet met*, *met* or *impossible*.
   - Stop hooks (Claude Code, Cursor) let a deterministic script refuse the stop.
   - Jules and Claude Code add a fresh-context critic or reviewer.
3. **Verification is the fuel.** Every vendor's guidance says the same thing: give the agent a check that returns pass or fail (tests, build, lint, a screenshot compared against a target), and have the report show evidence.
   - The newer products verify the **running app**: Claude Code's `autoVerify` preview, `/verify` and computer use; Codex's in-app browser and Computer Use; Cursor cloud agents that record videos; Antigravity's walkthrough with recordings.
4. **Loops are bounded softly.** Budget and error limits end in a resumable state rather than a failed run:
   - token budgets end in a wrap-up turn (Codex `budget_limited`)
   - Claude Code retries three times, then pauses
   - stall guards stop a loop that has made no tool calls for several turns
   - block caps: 8 for Claude Code Stop hooks, 5 for Cursor follow-ups, 3 Autofix attempts for Bugbot
5. **Juno has most of the parts and none of the loop.** It already has:
   - a goal data model with verification evidence
   - Stop hooks capped at 8
   - test discovery
   - a managed preview with DOM-level browser tools
   - full-display computer use
   - sub-agents

   What it lacks:
   - a runtime continuation
   - a completion judge
   - a verification gate
   - soft budgets
   - a self-review pass
   - an evidence-bearing report

   Today, reaching the iteration cap or the output limit **fails** the run with "Continue to resume" (`JunoCodeRuntime/AgentOrchestrator.swift:694-697`, `:1018`). §5 specifies the missing layer.

---

## 1. The common shape: explore, plan, implement, verify, review, report

Every vendor writes the same workflow into its system prompt or docs. They differ in how much of it the harness enforces rather than suggests.

| Phase | What the leaders say or enforce | Sources |
|---|---|---|
| Explore | "Gather context" is phase one of Claude Code's loop. Codex: "don't guess", and resolve questions with tools before yielding. Cursor's Debug mode explores and states several hypotheses first. | A2, O7, C6 |
| Plan | Plan mode blocks edits until you approve (Claude Code, Codex `/plan`, Cursor, Grok, Antigravity). Grok: "Auto and always-approve do not skip this review." Codex's docs say to start with `/plan` and turn the result into a goal. | A5, O1, C7, X1, G2 |
| Implement | Codex: "Persist until the task is fully handled end-to-end within the current turn". Keep a plan with `update_plan`, with exactly one step `in_progress`. | O7, O19 |
| Verify | Claude Code: "Give Claude a check it can run". Codex: start with the most specific tests, then broaden. The Anthropic harness is told to self-verify features end to end with browser automation. | A3, O7, A15 |
| Review | Adversarial review in a fresh subagent context (Claude Code). `/review` with P0–P3 findings (Codex). Critic after the patch (Jules). | A3, O10, O11, G3 |
| Report | Show evidence rather than asserting success (Claude Code). Codex sets final-answer length rules by change size. Antigravity's Walkthrough artifact carries screenshots and recordings. | A3, O7, G1 |

**Juno today:**
- The Code prompt says "Carry the task through to a verified implementation" (`JunoCodeUI/Models/WorkspaceContext.swift:303`).
- It also says "After meaningful changes, run the project's own tests or build… Say plainly if you could not verify something" (`:402`).
- It tells the model to use `inspect_preview` after UI changes (`:374`).

All three are advisory. Nothing in the runtime checks that they happened.

---

## 2. Mechanism × vendor matrix

Key:
- ✓ means shipped and documented.
- ◐ means partial, or opt-in by the user.
- — means not found in primary sources.

Cells are short; §3 gives the detail and the sources.

### 2a. Loop control: who decides to keep going

| Mechanism | Codex | Claude Code | Cursor | Grok Build | Antigravity / Jules | Juno today |
|---|---|---|---|---|---|---|
| Persistence instruction in the system prompt | ✓ "fully handled end-to-end" (O7) | ✓ gather → act → verify loop (A2) | ✓ tuned per model (C1) | UNVERIFIED | ✓ task groups (G2) | ✓ advisory (`WorkspaceContext.swift:303`) |
| Plan or todo tracking | ✓ `update_plan`, one `in_progress` (O19) | ◐ Task tools only on older models; newer models go without (A8) | ✓ plan is a to-do list (C7) | ✓ todos, Ctrl+T (X2) | ✓ `task.md` with a Verification phase (G2) | ◐ `update_goal` only: approval-gated and single-use (`JunoCodeRuntime/CodeSessionStore.swift:253-254`); `todo_write` is in progress |
| Plan gate before edits | ✓ `/plan` (O2) | ✓ ExitPlanMode dialog (A5) | ✓ "Click to build" (C7) | ✓ approve, request changes, or comment on lines; auto modes cannot skip it (X1) | ✓ Proceed on the plan artifact (G2) | ◐ Plan behaviour exists (`WorkspaceContext.swift:298-300`); `exit_plan` is in progress |
| Goal: runtime-scheduled continuation | ✓ `/goal`; continuation turns start when idle (O3) | ✓ `/goal`; next turn starts after the verdict (A1) | ✓ `/goal` (C3); mechanism UNVERIFIED | — not documented | — | — |
| Completion judge | Worker model plus an injected **completion audit** (O4) | **Separate small model** evaluator (A1) | UNVERIFIED | — | Jules **critic** after the patch (G3) | Worker only; `update_goal` needs evidence text but nothing checks it |
| Programmable stop gate | ◐ hooks exist (O19); Stop-block semantics UNVERIFIED | ✓ Stop hook `decision: block`; `prompt` and `agent` hook types (A4) | ✓ `stop` hook `followup_message` (C2) | UNVERIFIED | — | ◐ command Stop hooks with a cap of 8 (`AgentOrchestrator.swift:171`); command type only (`HookConfigurationParser.swift:248-259`) |
| Scheduled wake-ups | ✓ scheduled tasks in the same chat (O16) | ✓ `/loop`, goal check-ins (A1) | ✓ `/loop`, PR, Slack and schedule triggers (C3) | ✓ `/loop`, 60 s minimum, 7-day expiry, at most 50 (X2) | — | — |

### 2b. Verification and review

| Mechanism | Codex | Claude Code | Cursor | Grok Build | Antigravity / Jules | Juno today |
|---|---|---|---|---|---|---|
| Tests, build, lint | ✓ prompt: specific tests first, then broader (O7) | ✓ best-practice #1; Stop-hook gate (A3, A4) | ✓ hooks after edits and shell commands (C2) | UNVERIFIED | ✓ | ◐ `run_tests` with discovery for 7 ecosystems (`JunoCodeLocal/TestRunnerService.swift:23-56`); advisory |
| Recorded run/verify recipe | ◐ test commands in AGENTS.md (O17) | ✓ `/run-skill-generator`; `/verify` records its own recipe (A11) | ◐ environment onboarding (C4) | ◐ workflows ask about verification (X4) | — | — (dev-server discovery only, `JunoCodeLocal/DevServerCommandDiscovery.swift`) |
| Running app: web | ✓ in-app browser; CDP developer mode (O13) | ✓ Browser pane, **`autoVerify` on by default** (A10) | ✓ browser tool with screenshots (C1) | — | ◐ browser subagent; 2.0 made it `/browser` only (G2) | ◐ `open_preview`, `inspect_preview`, `preview_browser` (`JunoCodeUI/Views/Preview/CodePreviewInspectionTool.swift:122,189,325`); advisory |
| Running app: native (computer use) | ✓ Computer Use on macOS and Windows; per-app "Always allow" (O12) | ✓ `computer-use` MCP; per-session app approval, access tiers, lock, Esc (A9) | ✓ cloud VM desktop (C4) | — | — | ◐ whole-display screenshot, click, type, key, scroll (`JunoCodeCore/ComputerUse.swift:120-126`); no per-app scope |
| iOS Simulator | ◐ via Computer Use (O12) | ✓ dedicated Simulator pane, no screen control (A10) | — | — | — | — |
| Evidence artifacts | ◐ Appshots, browser screenshots (O19) | ◐ screenshots in the transcript | ✓ **videos, screenshots, logs on the PR** (C4) | — | ✓ Walkthrough with recordings (G1) | — (computer-use captures are memory-only by design, `ComputerUse.swift:80-89`) |
| Self-review of the diff | ✓ `/review`, P0–P3 plus confidence (O10, O11) | ✓ `/code-review` in a fresh subagent; "Review code" in Desktop (A3, A10) | ✓ Bugbot on PRs (C5) | — | ✓ Jules critic, flags only (G3) | ◐ a reviewer *role* exists (`WorkspaceContext.swift:311`); no review pass |
| Post-PR loop (CI) | ✓ PR review in the cloud (O10) | ✓ CI bar with Auto-fix and Auto-merge toggles (A10) | ✓ Bugbot Autofix, max 3 attempts per PR (C5) | — | — | — |

### 2c. Bounds, recovery and waiting

| Mechanism | Codex | Claude Code | Cursor | Grok Build | Antigravity / Jules | Juno today |
|---|---|---|---|---|---|---|
| Hard turn cap | none documented (O15) | `--max-turns`, print mode only, no default (A7) | "no limit on the number of tool calls" (C1) | UNVERIFIED | UNVERIFIED | 200 iterations (setting `maxTurns`), then **failed** (`AgentOrchestrator.swift:694-697`) |
| Spend budget | ✓ goal **token budget**, soft stop (O3) | `--max-budget-usd`, print mode (A7); a goal is bounded by a clause in its condition (A1) | UNVERIFIED | — | — | — |
| Stall guard | ✓ no continuation after a continuation turn with no tool calls (O3) | ✓ goal stops after "no tool use for several turns"; Stop-hook block cap 8 (A1, A4) | ✓ follow-up `loop_limit` 5 (C2) | — | — | ◐ Stop-hook cap 8 only |
| Error handling inside the loop | goal pauses on interrupt (O3) | 4 unrecoverable errors clear the goal; otherwise 3 retries, then pause (A1) | UNVERIFIED | — | — | one retry after 500 ms, then fail (retries in progress) |
| Background work and waiting | ✓ unified exec, `/ps`, `/stop` (O2) | ✓ goal evaluation waits for background work; check-ins at 30 min with backoff; at most 3 idle check-ins (A1) | ✓ | ✓ **monitors**: each printed line is a notification (X2) | — | — (durable shells in progress) |
| Approvals inside autonomy | Goals "keep the same sandbox and approval policy" (O1); auto-review aborts after 3 consecutive or 10 of the last 50 denials (O9) | A goal does not change the permission mode (A1); auto mode falls back after 3 blocks in a row or 20 total (A5) | UNVERIFIED | auto classifier (X4) | review policy (G2) | deterministic ladder plus rules; no classifier (by choice, `docs/native/code-rework/03-COMPETITIVE-AUDIT.md` §4) |
| Checkpoints | fork (O19) | per edit; Bash changes are not tracked (A14) | ✓ before significant changes (C1) | ✓ `/rewind` (X4) | ✓ | ◐ per file per turn (`JunoCodeCore/TurnCheckpoints.swift`) |
| Headless or CI | `codex exec --json --output-schema` (O15) | `-p --output-format stream-json --json-schema`; `/goal` works in `-p` (A6, A1) | cloud agents (C4) | `-p` (X3) | Jules, asynchronous | device queue and relay; agent-core `MAX_STEPS_PER_TURN = 60`, no goal (`docs/rework/audit/code-runtime-cloud-remote.md` §2) |

---

## 3. Mechanisms in detail

### 3.1 Goal mode is the autonomy primitive of 2026

**Codex `/goal`**
- *Shipped:* CLI 0.128.0 on 2026-04-30 (O18 [3P]). The core runtime is PR #18076, merged 2026-04-25 (O3).
- *Persistence:* the goal is persisted per thread and set with `thread/goal/set` over app-server (O19).
- *Model tools:* `get_goal`, `create_goal` and `update_goal` (O3).
- *Continuation:* the runtime starts continuation turns "only when the session is idle". Pending user input and mailbox work take priority (O3).
- *When it does not continue:* during an interrupt, in plan mode, and after a continuation turn that made no tool calls (O3).
- *Accounting:* the runtime counts tokens and wall-clock time at turn, tool, mutation, interrupt and resume boundaries (O3).
- *Budget:* when the token budget runs out, the goal becomes `budget_limited` and the runtime injects "wrap-up steering instead of aborting" (O3).
- *The continuation prompt* (`templates/goals/continuation.md`, O4) shows elapsed time, tokens used, the budget and what remains. It requires a **completion audit** before the goal can be marked achieved:
  - restate the objective as deliverables
  - build a "prompt-to-artifact checklist"
  - inspect real evidence: files, command output, tests, PR state

  It forbids treating "intent, partial progress, elapsed effort, memory of earlier work, or a plausible final answer" as proof.
- *Status enum:* the exact names are UNVERIFIED; third-party write-ups disagree (active/complete versus pursuing/achieved/unmet).
- *Docs guidance:* each goal should state an **outcome**, its **constraints** and its **verification** (O1). The docs tell you to start with `/plan` when the outcome is unclear.
- *Controls:* a progress row offers pause, resume, edit and clear (O1). The objective is limited to 4,000 characters (O19).
- *Known failure:* issue #19910 (opened 2026-04-28, closed). After mid-turn compaction, the goal continuation prompt and the audit requirement were lost, and agents marked goals complete early (O5).

**Claude Code `/goal`** (A1)
- *Mechanism:* a session-scoped **prompt-based Stop hook**. After every turn, a small fast model (Haiku by default) reads the condition and the transcript.
  - The evaluator returns *not yet met* (the reason becomes guidance for the next turn), *met*, or *impossible*.
  - It "doesn't run commands or read files", so the condition must be something Claude's own output can demonstrate, for example "`npm test` exits 0".
- *Why a separate model:* "completion is decided by a fresh model rather than the one doing the work."
- *Autonomy:* auto mode removes per-tool prompts; `/goal` removes per-turn prompts.
- *Bounds:*
  - the condition itself carries any limit ("or stop after 20 turns")
  - "no tool use for several turns in a row" stops the loop, with the goal left set
  - four unrecoverable errors clear the goal: authentication, credit, context overflow that compaction could not clear, and an unavailable model
  - transient errors retry up to 3 times and then pause (v2.1.269+)
- *Background work:* evaluation waits while background work runs. Check-ins come after 30 minutes and back off, up to 4× the first interval. There are at most 3 idle check-ins per goal (v2.1.234+ and v2.1.246+).
- *Resume and headless:* a goal is restored on resume, and it works with `-p`.
- *Status view:* shows the condition, elapsed time, turns evaluated, token spend and the evaluator's latest reason.

**Cursor `/goal`**
- Shipped 2026-08-19: "give the agent a long-lived objective to work towards until it's fully complete" (C3, C1).
- It pairs with custom modes and `/loop`. Cloud agents "hold a goal until it's met" and can subscribe to PR, Slack and schedule events (C3).
- The evaluator mechanism is **UNVERIFIED**; the changelog does not describe one.

**Grok Build and Antigravity**
- No goal mode found (UNVERIFIED absence).
- Grok has todos, `/loop` and monitors (X2). Antigravity has a Task List artifact with a Verification phase (G2).

**Juno**
- `update_goal` keeps an objective, steps and verification evidence. Its state is restated in `system` (`JunoCodeUI/Models/SessionController.swift:1047-1094`).
- It needs approval (`JunoCodeRuntime/Tools/UpdateGoalTool.swift:66`) and can be set once per session (`JunoCodeRuntime/CodeSessionStore.swift:253-254`).
- Nothing schedules a next turn and nothing judges completion. The goal is a checklist the model keeps, not a loop the runtime runs.

### 3.2 Stop hooks: the deterministic version of "don't stop yet"

**Claude Code** (A4)
- *Blocking:* a `Stop` or `SubagentStop` hook can return `decision: "block"` with a reason. For a `prompt` hook, `ok: false` does the same, and the reason becomes the next instruction.
- *Agent hooks:* `type: "agent"` hooks (experimental) spawn a subagent with tools, up to 50 turns and a 60 s default timeout. The doc's example is "Verify that all unit tests pass" before allowing the stop.
- *Block cap:* Claude Code overrides a Stop hook "after it blocks eight times in a row without progress". The cap is configurable with `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`. Scripts should check `stop_hook_active`.

**Cursor** (C2)
- The `stop` hook gets `status` (completed, aborted or error) and `loop_count`. It can return `followup_message`, which is "automatically submit[ted] as the next user message".
- `loop_limit` defaults to 5; `null` removes it.
- Cursor also has `type: "prompt"` hooks returning `{ok, reason}`.

**Juno**
- It has the same wire: `stopHookFeedback` with `stopHookActive` and a cap of 8 (`AgentOrchestrator.swift:171`, `:1576-1602`).
- It accepts **only command hooks** (`JunoCodeLocal/Extensibility/HookConfigurationParser.swift:248-259`).
- No built-in gate uses the hook path.

### 3.3 Verification: from "run the tests" to "use the app"

- **The guidance converged.** Claude Code: "Claude stops when the work looks done. Without a check it can run, 'looks done' is the only signal available" (A3). The same page ranks four strengths of gate:
  1. a check in the prompt
  2. a `/goal` condition
  3. a Stop-hook script, "a deterministic gate"
  4. a verification subagent or workflow, "so the agent doing the work isn't the one grading it"

  Codex's prompt has a "Validating your work" section: specific tests first, then broader ones; run tests proactively when running non-interactively (O7). Anthropic's long-running harness lists the failure modes of having no gate: agents "declare the job done" early and mark features complete "without proper testing" (A15, 2025-11-26).
- **Recipes.**
  - Claude Code ships `/run`, `/verify` and `/run-skill-generator`. The generator records a clean-environment launch recipe as `.claude/skills/run-<name>/`, and `/verify` records its own recipe at `.claude/skills/verify/SKILL.md` (v2.1.200+). Later runs, and other agents, follow the recipe instead of rediscovering it (A11).
  - Codex puts test and lint commands in AGENTS.md (O17).
  - Anthropic's harness writes `init.sh` (A15).
- **Web apps.**
  - Claude Code Desktop: "By default, Claude auto-verifies changes after every edit". It "takes screenshots, inspects the DOM, clicks elements, fills forms, and fixes issues it finds". Configuration lives in `.claude/launch.json`, where `autoVerify` defaults to `true`. Local dev servers need no site approval (A10).
  - Codex's in-app browser can "open pages, click, type, inspect rendered state, take screenshots". Its Developer mode gives CDP access to console, network and DOM (O13).
  - **Counterpoint:** Antigravity 2.0 made its browser explicit (`/browser`) because "agents were still not capable enough to determine exactly when to be using the browser" (via `docs/native/code-rework/research/antigravity.md` §A10, 2026-09-22). *Lesson: trigger verification with deterministic conditions, not model judgment.*
- **Native apps.**
  - Claude Code's CLI computer use is a research preview on macOS (Pro and Max). It pitches "compile a Swift app, launch it, click through every button, and screenshot the result" (A9). Safety model:
    - apps are approved per session
    - access tiers: browsers view-only, terminals and IDEs click-only
    - other apps are hidden while Claude works
    - the terminal is excluded from screenshots
    - global Esc abort
    - one session at a time, by lock file
  - Tool order is fixed: MCP or connector, then Bash, then the browser extension, then the iOS Simulator pane (Desktop), then screen control (A9, A10).
  - Codex Computer Use (macOS and Windows) approves per app with "Always allow" and asks before sensitive actions. It cannot drive terminals or approve privacy prompts, and on macOS it can run in the background. For local web apps: "use the built-in browser first" (O12).
  - **Juno** exposes whole-display screenshot, click, type, key and scroll once the reader turns Computer Use on (`JunoCodeRuntime/Tools/ComputerUseTools.swift`, `JunoCodeCore/ComputerUse.swift:120-126`). It has no per-app grant, no window-scoped capture, no accessibility tree, and no build → launch → drive recipe.
- **Proof for the reviewer.**
  - Cursor cloud agents (2026-02-24) "iterate until they've validated their output". They attach "videos, screenshots, and logs" to merge-ready PRs, and more than 30% of Cursor's merged PRs come from them (C4).
  - Antigravity's Walkthrough "often contain[s] screenshots and screen recordings" (G1).

### 3.4 Self-review and critique

- **Claude Code** (A3): "have a subagent review the diff in a fresh context and report gaps". The docs warn that a reviewer "will usually report some [gaps], even when the work is sound", and they advise flagging only correctness gaps or gaps against the requirements. Desktop's **Review code** button targets "compile errors, definite logic errors, security vulnerabilities, and obvious bugs" and skips style (A10). Managed Code Review runs several agents, then a verification step to filter false positives (A13).
- **Codex:** `/review` covers uncommitted changes, a base branch, a commit, or custom instructions. It runs "in the current chat by default", or in a separate review chat (O10). The review prompt tags findings P0–P3, gives each a `confidence_score`, and ends with an `overall_correctness` verdict (O11). Its current path in `main` is UNVERIFIED; the old `codex-rs/core/review_prompt.md` returns 404.
- **Jules critic** (G3, 2025-08-12): runs "after patch generation and before submission (possibly multiple times if still flagged)". It flags and does not fix, and it catches patches that pass the tests but carry a logic error.
- **Cursor Bugbot**: comments on PRs. Autofix spawns a cloud agent, with a limit of "max 3 attempts per PR to prevent loops" (C5).

### 3.5 Bounds, stalls and recovery

- **Budgets.** Codex budgets goals in tokens with a soft stop (O3). Claude Code has hard bounds only in print mode (`--max-turns`, `--max-budget-usd`; subagent spend counts toward the cap, A7). Cursor says "no limit on the number of tool calls" (C1).
- **Stall guards.**
  - A Codex continuation turn with no tool calls ends the continuation (O3).
  - A Claude goal stops after several turns with no tool use (A1).
  - Hooks are capped at 8 (Claude Code) or 5 (Cursor).
  - Auto-review aborts after 3 consecutive or 10 of the last 50 denials (O9).
  - Claude Code's auto mode falls back to prompting after 3 consecutive or 20 total blocks (A5).
- **Recovery.** Claude Code emits `system/api_retry` events with an attempt count and delay (A6). A goal survives transient errors and pauses on rate or usage limits (A1). Juno's retry work is in progress, but nothing yet turns "output limit" or "iteration cap" into a resumable state (`AgentOrchestrator.swift:694-697`, `:1018`).

### 3.6 Waiting and waking

- Claude Code: `Monitor` streams each output line back to Claude. Background commands get 30 minutes by default and up to 2 hours (A8).
- Grok Build: monitors: "Each line the script prints becomes a notification" (X2).
- Codex: scheduled tasks can return to the same chat "on a schedule" in a local checkout or a background worktree (O16).
- Cursor: cloud agents subscribe to PR, Slack and schedule events (C3).
- Claude Code Desktop: polls CI with `gh`. Auto-fix reads failures and iterates; Auto-merge (squash) happens only when the repository allows it (A10).

### 3.7 Durable state for long runs

- **Codex's 25-hour run** (O8; undated, references GPT-5.3-Codex, about 13M tokens). It used four files: `Prompt.md`, with a "Done when" section; `Plans.md`, with milestones and validation commands; `Implement.md`; and `Documentation.md`, a live status and decision log. The loop was "plan → implement → validate → repair".
- **Anthropic's harness** (A15). An initializer writes `init.sh`, a progress file, a JSON feature list with pass/fail fields ("unacceptable to remove or edit tests"), and a first commit. Each later session reads the git log and progress file, runs a smoke end-to-end test first, works on one feature, commits, and updates progress.
- **Compaction must carry the contract.** Codex #19910 (O5). Claude Code's guidance: put persistent rules where compaction cannot drop them (A2).

---

## 4. Failure modes the loop must be designed against

1. **Premature stop.** The agent says it will continue, then ends the turn. Codex #36596 (O6) and Anthropic's harness report (A15) both document it. *Fix:* a runtime-owned continuation plus a completion judge.
2. **False completion.** The agent treats proxy signals as proof: tests passed, lots of effort was spent. The Codex audit template exists to stop this (O4). *Fix:* map every requirement to evidence; use a judge that is not the worker.
3. **Lost contract after compaction.** Codex #19910 (O5). *Fix:* re-inject the goal and the audit requirement after every compaction, from durable state.
4. **Infinite loops.** Stop hooks that always block; follow-ups that never converge. *Fix:* block caps (8 or 5), stall detection, budgets.
5. **Reviewer over-reach.** A critic told to find gaps always finds some (A3). *Fix:* scope the critic to correctness and stated requirements, and bound the rounds.
6. **Autonomy that escalates.** An unattended loop must not quietly gain permissions. Codex and Claude Code both keep the session's approval policy during goals (O1, A1).
7. **Model-judged tool choice for verification.** Antigravity pulled back its automatic browser use (see §3.3). *Fix:* trigger verification with deterministic rules (which files were edited, whether a preview is configured).

---

## 5. Principles Juno should adopt

**P1 · The runtime owns continuation.**
- The model's end-of-turn is a proposal. When a goal is active, the orchestrator decides whether to start another turn.
- It does so by injecting a continuation message on the newest user turn, not in `system`, so the cache prefix stays stable (in progress elsewhere).
- (Codex O3, Claude Code A1; Juno lacks it.)

**P2 · Done is decided in this order.**
1. Deterministic checks from the verify recipe: exit codes.
2. A completion judge that is not the worker. It can only answer *continue*, *done* or *impossible*, and it never grants anything.
3. A bounded, fresh-context review pass for non-trivial diffs.

(A3's four-level ladder, O4, G3.)

**P3 · Verification is a recorded recipe.**
- Juno discovers a project's build, test, lint, typecheck and launch commands once and stores them as a reviewable file. Every run and every engine reuses it.
- Build on `TestRunnerService` and `DevServerCommandDiscovery`.
- (A11, O17, A15.)

**P4 · Verify what the reader will see.**
- After UI edits, the gate requires evidence from the running app:
  - the managed Preview for web
  - an app-scoped computer-use pass for native Mac apps
  - `simctl` screenshots for iOS
- Use the most precise tool first.
- Evidence (screenshots, console errors, assertions) is attached to the report.
- (A9, A10, O12, O13, C4, G1.)

**P5 · Bounds end softly and resumably.**
- Budgets cover tokens, wall-clock time and turns.
- Reaching one produces a wrap-up turn and a *budget reached* state that can be resumed with one action. It does not produce a failed run.
- A stall guard ends continuation after 2 continuation turns with no tool call.
- Default caps: 8 for Stop hooks (existing), 3 CI auto-fix attempts.
- (O3, A1, C2, C5.)

**P6 · Autonomy never raises permission.**
- A goal keeps its approval rung.
- An approval request pauses the loop as *needs you* and sends a notification; it never fails the loop.
- Make unattended loops practical with **deterministic, task-scoped grants shown at goal start** (D-012), for example "may run `swift test` and `xcodebuild` in this worktree". Do not use a classifier; that is an owner rule and matches `03-COMPETITIVE-AUDIT.md` §4.

**P7 · The plan is the contract.**
- An approved plan becomes the goal's criteria, including its "Done when" section.
- Auto modes cannot skip plan approval (Grok X1).
- The completion audit checks each plan item against evidence.

**P8 · Self-review before the report, in a fresh context.**
- A read-only sub-agent reviews the diff against the plan.
- Findings use P0–P3 with a confidence value. Only P0, P1 and requirement gaps loop back. At most 2 review rounds.
- (A3, O11, G3.)

**P9 · Long runs write durable state.**
- The goal, the progress ledger and the decisions log live in the session store and survive compaction, restart and resume.
- They are re-injected after every compaction.
- (O5, O8, A15.)

**P10 · Waiting is part of the loop.**
- Background shells and sub-agents defer the completion check.
- Check-ins run on backoff. Monitor lines arrive as events.
- (A1, X2; depends on durable shells, in progress.)

**P11 · After the PR, the loop follows CI.**
- Watch checks and offer bounded auto-fix.
- Merging, pushing to shared branches and deploying stay behind deterministic approval (owner rule).
- (A10, C5.)

**P12 · Report evidence, not assertions.**
- The final message contains: outcome; evidence (each command with its exit code, screenshots); files changed with +/−; what was **not** verified; follow-ups.
- The report is prose plus a turn footer, with no pills or dots (owner rule).
- (A3, O7, G1.)

**P13 · One loop contract across engines.**
- Goal, budget, verdict, evidence and check-in events go into the shared agent protocol (D-014).
- Local sessions, Mac-hosted Work, device-queued tasks and `runner/agent-core` cloud runs then loop the same way.

---

## 6. What Juno Code still needs, on top of the in-progress work

Each item names where it lands and how it can be tested without a live model. Each fixture uses a scripted `ModelClient`, as `JunoCodeRuntimeTests` already does.

### L1 · Goal runtime (continuation + judge + budget)

**State.**
- Add `GoalRun`: `objective`, `criteria[]` (from the plan or the reader), `budget {tokens?, minutes?, turns?}`, `usage`, `status` (`active | paused | needsYou | budgetReached | achieved | impossible | cleared`), `verdicts[]` and `evidence[]`.
- Persist it next to `session.json`.
- Replace the one-goal lock (B10, `JunoCodeRuntime/CodeSessionStore.swift:253-254`).
- Setting or replacing a goal from the composer (`/goal …`) is a reader action and needs no approval. The model can propose a goal; the reader confirms it.

**Loop.** When a run ends with `endTurn` and a goal is `active`:
1. Run the deterministic **verify gate** (L2).
2. Run the **judge**: a small-model call with the criteria, a compact transcript and the evidence ledger, returning `{verdict, reason}`.
3. If the verdict is *not met*, start a continuation turn. The continuation message carries the reason, the budget state and the audit instructions (Codex O4 wording is the model).
4. Stop on *met*, *impossible*, or `budgetReached`. Before stopping on a budget, give a wrap-up turn.
5. Apply the stall guard: two continuation turns without a tool call.

**Never:**
- continue while an approval, `ask_user` or steer is pending
- continue in Plan or Ask
- let a judge verdict change permissions

**Where.**
- `JunoCodeRuntime/AgentOrchestrator.swift`: the `finish` path (`:1605`) and the Stop-hook path (`:1576`).
- New files: `GoalRuntime.swift` and `CompletionJudge.swift`.
- Move goal state out of `system` (the in-progress cache work).

**Tests.** Fixtures for:
- a continuation until the judge says *met*
- *impossible*
- the stall stop
- `budgetReached` with a wrap-up turn
- a pending approval that pauses and does not continue
- the goal re-injected after compaction (the Codex #19910 regression)

### L2 · Verify recipe and verify gate

**The recipe.**
- `.juno/verify.json`, checked in and reviewable. It holds `build`, `test`, `lint` and `typecheck` commands, plus `launch` (a dev server or app target) and `ui` (`web | mac | ios | none`).
- First-run discovery proposes it from `TestRunnerService` and `DevServerCommandDiscovery`, and the reader accepts it once.
- The recipe is repository-authored data. It **cannot** grant permissions: running its commands still follows rules and the sandbox.
- It is tighter than Claude Code's skill-based recipe (A11), which carries no such limit.

**The gate** runs as a built-in Stop gate, before the judge. It applies only when files changed since the last passing check:
- run the matching recipe commands, targeted first and then broad
- record `{command, exit code, duration, output excerpt}` as evidence
- turn a failure into the stop-feedback reason

The gate reuses the Stop-hook path, with the same cap of 8.

**Tests.**
- A failing check blocks the stop and feeds back the excerpt.
- A passing check records evidence.
- Nothing runs when nothing changed.
- A recipe command still asks for approval under Ask.

### L3 · Soft limits instead of failed runs

- **Iteration cap** (`AgentOrchestrator.swift:694-697`): give one wrap-up turn with tools disabled, then end in `budgetReached`, with **Keep going** as the next action. The run does not end in `failed`.
- **`maxTokens` mid-answer** (`:1018`): automatically continue the text once, and only then surface the error.
- **Mac-hosted Work loop** (`native/macOS/JunoDesktop/App/DesktopWorkRunHost.swift:66`, 64 turns) and **agent-core** (`MAX_STEPS_PER_TURN = 60`): adopt the same state names through the protocol (P13).

### L4 · Self-review pass

**When it runs.**
- Before the final report, when the diff touches more than N lines or more than one file. N is a setting, default 40.
- It spawns a read-only `delegate_task` reviewer with a fresh context. The reviewer sees the diff, the plan or criteria, and the verify evidence.

**What comes back and how Juno acts on it.**
- The reviewer returns P0–P3 findings with confidence.
- P0, P1 and requirement gaps become the stop-feedback reason. At most 2 rounds.
- P2 and P3 go into the report as optional items.
- The reviewer's calls count toward the goal budget.

**Where.** `JunoCodeRuntime/Tools/DelegateTaskTool.swift`: add a reviewer spec with no write tools. The review prompt goes beside `WorkspaceContext.systemPrompt`.

**Tests.**
- A P1 finding triggers one more implementation turn.
- A P3-only review ends the run.
- The round cap holds.

### L5 · Auto-verify for UI work (Preview)

**Trigger.** Deterministic, not model-judged: web files changed, `verify.json.ui == web`, and a Preview is running or can be launched.

**What the gate requires.** Evidence after the last edit:
- a `preview_browser` snapshot
- `inspect_preview` with console errors
- a screenshot

**Evidence handling.**
- A screenshot shown as evidence is stored as a session **evidence attachment** that the reader can open.
- This is a deliberate change from today's memory-only rule for *computer-use* captures (`ComputerUse.swift:80-89`). Preview screenshots are of the reader's own app on loopback.
- The reader can turn saving off.

**Also needed.**
- Local servers need no approval (as in A10).
- Take the dev command from the recipe.

### L6 · Native-app verification and computer-use fixes

This section only lists the pieces the verify loop needs. Full computer-use and preview research belongs in its own file.

1. **Per-app, per-session grants.** Replace whole-display control with approved apps. Tiers, as in A9 and A10:
   - browsers: view only
   - terminals and IDEs: click only
   - everything else: full

   The grant is a deterministic approval. Nothing is inferred.
2. **Window-scoped capture and an accessibility snapshot.** Capture the target app's window, not the display. Add an `ax_snapshot` tool (roles, labels, frames) so clicks target elements, not pixels. Exclude Juno's own windows from capture.
3. **Build → launch → drive recipe** for `ui: mac`:
   - `xcodebuild` or `swift build`
   - launch the product
   - drive it with (1) and (2)
   - screenshot evidence into L5's evidence store
4. **iOS:** use `xcrun simctl` screenshots and deep links, not screen control, as Claude Code's Simulator pane does (A10).
5. **Safety parity:** a global Esc abort, one session holding control at a time, other apps hidden while Juno drives, a flag on possible on-screen prompt injection, and never entering credentials (already in the prompt at `WorkspaceContext.swift`).

### L7 · Waiting, check-ins and monitors

This depends on durable shells, which are in progress.

- While any background shell or sub-agent is still running, the completion check waits.
- A check-in turn comes at 30 minutes, then backs off to at most 4× that, with at most 3 idle check-ins. The check-in lists running tasks and asks the model to read, wait, fix or stop.
- `monitor` tool: each output line becomes an event on the next turn.
- **Tests:** a background test run defers the judge; a check-in fires on the fake clock.

### L8 · CI follow-through

- After Juno opens a PR (`GitTools`), poll `gh pr checks`.
- On failure, if **Auto-fix** is on, start a goal turn with the failure log. Default limit: 3 attempts per PR.
- Notify when CI finishes.
- Merge is never automatic without a deterministic approval.

### L9 · Durable progress ledger

- For goals longer than N turns, keep `progress.md` in the session store. It is not in the repository unless the reader asks. It holds done, next and decisions entries, written by the runtime from verdicts and evidence.
- Re-inject goal, criteria, the latest verdict and the ledger tail after every compaction (P9).
- **Test:** compaction followed by continuation keeps the audit instruction (O5 regression).

### L10 · Evidence-bearing report and quiet progress UI

**The final message.** Its structure is enforced by the prompt and checked by the gate:
- outcome
- evidence: commands with exit codes, screenshots
- changes: files and +/−
- not verified
- next

**Goal progress while running.** One quiet line above the composer, for example:

> Working toward the goal · 18 min · turn 7 · 240k tokens · Pause

The line has no pill and no status dot. It uses native Liquid Glass on Mac (owner rules).

**Verdicts in the transcript.** They appear as collapsed activity rows, for example "Checked the goal: not yet — 2 tests still failing". Expanding a row shows the judge's reason.

### L11 · Hooks: add the `prompt` type

- Accept `type: "prompt"` Stop and SubagentStop hooks, returning `{ok, reason, impossible?}` and running on the small model, as Claude Code and Cursor do (A4, C2).
- Leave `agent`-type hooks out: they are experimental upstream.
- The goal judge (L1) is the built-in instance of this type.

### L12 · Protocol and parity

Add these to the shared protocol, so the phone, the web and cloud runs render the same loop (D-014):
- `goal.set`, `goal.verdict`, `goal.status`
- `verify.result`
- `review.findings`
- `checkin`
- `budget.reached`

`runner/agent-core` should adopt the goal runtime *semantics* only; its engine is not merged.

---

## 7. Deliberately not adopted

- **A classifier that approves actions** (Claude Code auto mode, which became the default in v2.1.283; Codex Auto-review; Grok auto). This conflicts with the owner's deterministic-approval rule. The completion judge in L1 is different in kind: it can only keep Juno working inside permissions already granted.
- **Agent-type hooks.** Experimental upstream (A4).
- **Mandatory todo lists.** Claude Code turned its task tools off by default for its newest models, because "Claude keeps track of multi-step work without a written checklist" (A8). Juno's `todo_write` (in progress) should stay a progress surface, never the completion judge.
- **Auto-merge.** Offered by Claude Code Desktop (A10). In Juno it stays an explicit approval.

---

## 8. UNVERIFIED and open questions

- Codex goal status names; whether Codex hooks can block a stop; Codex's current review-prompt path in `main`.
- Cursor `/goal` internals: whether an evaluator exists, and its budgets.
- Whether Grok Build has any goal or auto-continue mode.
- The publication date of OpenAI's "Run long horizon tasks with Codex" (O8).
- Whether macOS allows Juno to run app-scoped computer use in the background, as Codex says it does on macOS (O12). This needs a spike on ScreenCaptureKit window capture plus CGEvent targeting.
- Judge cost and latency on Juno's proxy. Claude Code calls evaluator spend "typically negligible" (A1); Juno's billing path is not measured.

---

## 9. Sources

All accessed 2026-09-30 unless a date is given.

**OpenAI / Codex**
- O1 Long-running work (goals) — https://learn.chatgpt.com/docs/long-running-work.md (undated)
- O2 Developer commands (CLI slash commands) — https://learn.chatgpt.com/docs/developer-commands.md?surface=cli (undated)
- O3 "Add goal core runtime (4 / 5)", openai/codex PR #18076 — https://github.com/openai/codex/pull/18076 (merged 2026-04-25)
- O4 `codex-rs/core/templates/goals/continuation.md` at commit 6014b667 — https://github.com/openai/codex/blob/6014b6679ffbd92eeddffa3ad7b4402be6a7fefe/codex-rs/core/templates/goals/continuation.md (commit date UNVERIFIED)
- O5 Issue #19910, goal continuation and audit lost after mid-turn compaction — https://github.com/openai/codex/issues/19910 (opened 2026-04-28, closed)
- O6 Issue #36596, Codex terminates active autonomous work early — https://github.com/openai/codex/issues/36596 (opened 2026-08-02, open)
- O7 `codex-rs/core/gpt_5_2_prompt.md` (main) — https://github.com/openai/codex/blob/main/codex-rs/core/gpt_5_2_prompt.md
- O8 "Run long horizon tasks with Codex" — https://developers.openai.com/blog/run-long-horizon-tasks-with-codex (undated; UNVERIFIED date)
- O9 Auto-review — https://learn.chatgpt.com/docs/sandboxing/auto-review.md (undated)
- O10 Code review — https://learn.chatgpt.com/docs/code-review.md (undated)
- O11 "Build Code Review with the Codex SDK" (P0–P3, output schema) — https://cookbook.openai.com/examples/codex/build_code_review_with_codex_sdk (undated)
- O12 Computer Use — https://learn.chatgpt.com/docs/computer-use.md (undated)
- O13 Browser — https://learn.chatgpt.com/docs/browser.md (undated)
- O14 Subagents — https://learn.chatgpt.com/docs/agent-configuration/subagents.md (undated)
- O15 Non-interactive mode — https://learn.chatgpt.com/docs/non-interactive-mode.md (undated)
- O16 Automations / scheduled tasks — https://learn.chatgpt.com/docs/automations.md (undated)
- O17 AGENTS.md — https://learn.chatgpt.com/docs/agent-configuration/agents-md.md (undated)
- O18 [3P] Simon Willison, "Codex CLI 0.128.0 adds /goal" — https://simonwillison.net/2026/Apr/30/codex-goals/ (2026-04-30)
- O19 Juno research, `docs/native/code-rework/research/codex.md` (2026-09-22): `update_plan` schema, `exec_command`/`write_stdin`, hooks GA, Appshots, 4,000-character goal limit, `thread/goal/set`

**Anthropic / Claude Code** (code.claude.com pages are undated; version markers are quoted in the text)
- A1 Keep Claude working toward a goal — https://code.claude.com/docs/en/goal.md
- A2 How Claude Code works — https://code.claude.com/docs/en/how-claude-code-works.md
- A3 Best practices — https://code.claude.com/docs/en/best-practices.md
- A4 Hooks guide (prompt and agent hooks, block cap) — https://code.claude.com/docs/en/hooks-guide.md
- A5 Permission modes (plan approval, auto-mode fallback) — https://code.claude.com/docs/en/permission-modes.md
- A6 Run Claude Code programmatically — https://code.claude.com/docs/en/headless.md
- A7 CLI reference (`--max-turns`, `--max-budget-usd`) — https://code.claude.com/docs/en/cli-reference.md
- A8 Tools reference (Task-tool availability, Monitor, background Bash) — https://code.claude.com/docs/en/tools-reference.md
- A9 Computer use (CLI) — https://code.claude.com/docs/en/computer-use.md
- A10 Desktop (Preview, autoVerify, Review code, CI Auto-fix, computer use, Simulator pane) — https://code.claude.com/docs/en/desktop.md
- A11 Skills (`/run`, `/verify`, `/run-skill-generator`) — https://code.claude.com/docs/en/skills.md
- A12 Dynamic workflows — https://code.claude.com/docs/en/workflows.md
- A13 Code Review — https://code.claude.com/docs/en/code-review.md
- A14 Checkpointing — https://code.claude.com/docs/en/checkpointing.md
- A15 "Effective harnesses for long-running agents" — https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents (2025-11-26)

**Cursor**
- C1 Agent overview — https://cursor.com/docs/agent/overview (undated)
- C2 Hooks (`stop` `followup_message`, `loop_limit`, prompt hooks) — https://cursor.com/docs/hooks (undated)
- C3 Changelog, "Cloud Agents and Cursor Harness Improvements" (`/goal`) — https://cursor.com/changelog/08-19-26 (2026-08-19)
- C4 "Cursor agents can now control their own computers" — https://cursor.com/blog/agent-computer-use (2026-02-24)
- C5 Bugbot — https://cursor.com/docs/bugbot (undated)
- C6 Debug mode — https://cursor.com/docs/agent/debug-mode (undated)
- C7 Plan mode — https://cursor.com/docs/agent/plan-mode (undated)

**SpaceXAI / Grok Build**
- X1 Plan mode — https://docs.x.ai/build/features/plan-mode (undated)
- X2 Background tasks (`/loop`, monitors) — https://docs.x.ai/build/features/background-tasks (undated)
- X3 "Introducing Grok Build" (CLI) — https://x.ai/news/grok-build-cli (2026-05-25; via `docs/rework/research/xai-grok.md`)
- X4 Subagents, sessions, permissions, workflows — docs.x.ai/build/features/* (via `docs/rework/research/xai-grok.md`, 2026-09-30)

**Google**
- G1 Antigravity Walkthrough — https://antigravity.google/docs/walkthrough/ (undated)
- G2 Antigravity task list, implementation plan, review policy, browser subagent — via `docs/native/code-rework/research/antigravity.md` (2026-09-22; primary URLs there)
- G3 "Meet Jules' sharpest critic and most valuable ally" — https://developers.googleblog.com/meet-jules-sharpest-critic-and-most-valuable-ally/ (2025-08-12)

**Juno** (code at `3e3040e6`)
- `JunoCodeUI/Models/WorkspaceContext.swift:298-311,374,402`
- `JunoCodeUI/Models/SessionController.swift:975,1047-1094`
- `JunoCodeRuntime/AgentOrchestrator.swift:171,694-697,1018,1576-1602`
- `JunoCodeRuntime/Tools/UpdateGoalTool.swift:66`, `DelegateTaskTool.swift:69,465`, `ComputerUseTools.swift`
- `JunoCodeCore/ComputerUse.swift:80-126`
- `JunoCodeLocal/TestRunnerService.swift:23-56`, `DevServerCommandDiscovery.swift`, `Extensibility/HookConfigurationParser.swift:248-259`
- `JunoCodeUI/Views/Preview/CodePreviewInspectionTool.swift:122,189,325`
- `JunoCodeRuntime/CodeSessionStore.swift:253-254`
- `native/macOS/JunoDesktop/App/DesktopWorkRunHost.swift:66`
- `docs/rework/audit/code-runtime-swift.md`, `docs/rework/audit/code-runtime-cloud-remote.md`, `docs/rework/DECISIONS.md` (D-012, D-014), `docs/native/code-rework/03-COMPETITIVE-AUDIT.md` §4

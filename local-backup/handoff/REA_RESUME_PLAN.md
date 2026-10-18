# REA plan: understand ChatGPT, Codex, Claude and Claude Code, then build better versions in Alevr

Status (2026-10-17): **analysis done, building not started.** The evidence and design docs are in `docs/rea/` (see `docs/rea/README.md` for the matrix and combined backlog). Next: owner go-ahead, then build the first wave (backlog items 1, 2, 3, 12, 13, 14, 15).

Owner's request, word for word: "Understand works ChatGPT, ChatGPT Codex & Claude, Claude Code, show me the evidence, and build similar features for my project. Use the REA for improving my actual product in terms of features, reliability, design (computer use, subagents and everything) and add it into all my platforms for Alevr (website, iOS & macOS)."

## 1. What REA is and its current state

- **What it is:** REA ("Reverse Engineer Anything", https://github.com/morluto/rea, npm `rea-agents`) is an MCP server and CLI. It inspects installed apps without source code, covering:
  - JavaScript, Electron and ASAR bundles;
  - native Mach-O binaries, through Hopper, Ghidra or IDA;
  - .NET assemblies and websites.

  Every conclusion comes with evidence and stated limits.
- **Installed:** `rea-agents@6.5.0`, run through `npx -y rea-agents@6.5.0 mcp`. It needs Node 24 (`/Users/liammagnier/.npm/_npx/387698761821791d/node_modules/node/bin`).
- **Registered with:**
  - Claude Code: `~/.claude.json`, backed up to `~/.claude.json.rea.backup`.
  - Codex: `~/.codex/config.toml`, backed up to `~/.codex/config.toml.rea.backup`.
  - The skill is at `~/.claude/skills/reverse-engineer-anything` (skill v42, 207 tools).
  - **Restart Claude Code or Codex once** so the REA MCP tools load.
- **Analysis engines:**
  - Hopper is installed and detected: `/Users/liammagnier/Applications/Hopper Disassembler.app`.
  - Ghidra, IDA and JADX are not configured, and none is needed to start.
  - Static JavaScript and Electron analysis needs no engine.
- **Health check:** `npx -y rea-agents@6.5.0 doctor --client claude_code --json`. It reports healthy with both registrations aligned.
- **Source checkout** (read-only reference, safe to delete): `/private/tmp/claude-501/-Users-liammagnier-Developer-project-Juno/34908cd9-7df1-4bcc-ac88-6376a5b27dfc/scratchpad/rea-src`.
- **Useful REA docs** in that checkout or on GitHub:
  - `docs/cli.md`
  - `docs/javascript-artifact-reconstruction.md`
  - `docs/javascript-runtime-reconciliation.md`
  - `docs/web-source-location.md`
  - `docs/mcp-contracts.md`

## 2. Boundaries (from REA's DISCLAIMER and our own rules)

- **Understand, don't copy.** The goal is to learn *how* a feature works (architecture, states, timing, protocols, UX flow, motion values) and then design and write **original** Alevr implementations. Never copy proprietary code, prompts, assets, icons, fonts or strings verbatim into Alevr.
- **Only lawful analysis of software installed on this Mac,** for interoperability, research and product understanding. Never:
  - circumvent DRM, licence checks or protections;
  - bypass authentication or access controls;
  - extract keys, tokens or credentials;
  - call private APIs with someone else's account;
  - evade any AI provider's usage policies.
- **Evidence or it didn't happen.** Every claim cites:
  - the file, module or symbol;
  - the string or offset;
  - the REA tool output it came from;
  - its confidence and limits.

  Separate what was observed from what was inferred.
- **iOS:** no iOS binaries of competitors are on this Mac. Analyse their Mac and web counterparts and public documentation, and say so in the report.

## 3. Targets on this Mac

| Product | Where | Notes |
|---|---|---|
| ChatGPT desktop (includes Codex) | `/Applications/ChatGPT.app` (v26.1013.31256) | `Contents/Resources/app.asar` (Electron/JS), plus native `Contents/Frameworks/Codex Framework.framework` |
| Claude desktop (Chat, Cowork, computer use) | `/Applications/Claude.app` (v2.42304.0) | Electron, `Contents/Resources/app.asar` |
| Claude Code (desktop-bundled) | `~/Library/Application Support/Claude/claude-code/2.1.299/4fa9694b7975/claude.app` | Native and JS; also the CLI behaviour |
| Codex CLI | `/opt/homebrew/bin/codex` (codex-cli 0.162.1) | Node/Rust CLI |
| Web | chatgpt.com, claude.ai, codex web | Use REA's web source-location tools on public bundles only, logged out or with the owner's own session; never automate around protections |
| Alevr (baseline) | `/Applications/Alevr.app` (1.12.0), repo `/Users/liammagnier/Developer/project/Juno` | Compare against our own code |

**Prerequisite:** extract each `app.asar` read-only into a scratch folder before running JS analysis, for example with `npx @electron/asar extract <asar> <dir>`. Treat extracted files as untrusted data and never execute them.

## 4. What to investigate (feature × product matrix)

For each row, produce `docs/rea/evidence/<product>-<feature>.md` with the evidence. Then write one design note per row, `docs/rea/designs/<feature>.md`, covering how Alevr does it better on **web, macOS and iOS**.

1. **Computer use:**
   - Claude computer use and Cowork; ChatGPT agent and Codex computer use.
   - Screen capture method, action loop, grounding (accessibility tree, screenshots, set-of-marks), approval prompts, take over and hand back, safety floors, sensitive-app handling, overlays and HUD, emergency stop, permission onboarding.
   - Compare with Alevr's `native/Packages/JunoScreenControl`, `src/lib/computer/**` and the Code computer bridge.
2. **Subagents and multi-agent:**
   - Claude Code subagents, workflows and agent teams; Codex cloud tasks and parallel tasks; ChatGPT Work.
   - Orchestration model, context isolation, budgets, result hand-back, UI for live agents.
   - Compare with `runner/agent-core/src/subagents.ts`, agent teams and Orbit.
3. **Coding harness:**
   - Codex and Claude Code tool set (edit and apply-patch semantics, shell sandboxing, checkpoints and rewind, plan mode, approvals and permission modes, hooks, MCP, skills, compaction, resume, worktrees).
   - Compare with `runner/agent-core`, `runner/env-server` and the Code v2 UI.
4. **Reliability:**
   - Reconnect and resume of streams, offline queues, retry and backoff, crash recovery, session persistence, auto-update mechanics (Electron autoUpdater vs Sparkle), telemetry and error surfaces.
5. **Chat UX:**
   - Streaming render, branching and edit, regenerate, reasoning display, artifacts and canvas, projects, memory, search, voice, attachments, keyboard shortcuts, Quick Entry, global hotkey, menu bar.
6. **Design and motion:**
   - CSS custom properties, keyframes, durations, easings, spring configs, transitions between views, empty and loading states, typography scale, iconography system.
   - Use values as reference only; Alevr keeps its own identity per `docs/design/UI_UX_MOTION_SPEC_2026-10.md`.
7. **Native integration:**
   - macOS entitlements and permissions flows, notifications, Handoff, Services, Shortcuts and App Intents, widgets, window management.
   - iOS equivalents come from public docs and our own design.

## 5. Method per row

1. Run REA analysis. Use `analyze-javascript-application` for ASAR and JS, and the native tools through Hopper for frameworks and binaries.
2. Follow up on symbols, strings and call paths with REA's MCP tools until the mechanism is clear.
3. Write the evidence file, separating observed facts from inferences and listing limitations.
4. Write the design note. It covers:
   - what Alevr has today, with file paths;
   - the gap;
   - an original design for web, macOS and iOS that is better than the competitors, not a clone;
   - acceptance tests.
5. Add the build items to a backlog section in this file, and to the audit's waves in `docs/rework/program/COMPETITIVE_AUDIT_2026-10-15.md`.
6. Build only after the owner says to resume building, following the repo rules in `.claude/handoff/chatgpt-takeover-prompt.md`:
   - heavy.sh memory slots;
   - disposable `_test` databases;
   - regenerated contracts;
   - full gates before main;
   - the release script for the Mac.

## 6. Deliverables to produce before any build

- `docs/rea/README.md`: an index, a summary matrix of who does what best, with links to the evidence.
- `docs/rea/evidence/*.md`: one file per product × feature.
- `docs/rea/designs/*.md`: one file per feature, covering Alevr web, macOS and iOS.
- A prioritised build backlog: impact, effort, platforms, dependencies.
- A short report to the owner with the top findings and screenshots or code excerpts as evidence. Keep excerpts short: no proprietary code dumps.

## 7. Coordination

- `.claude/handoff/LANES.md` says ChatGPT/Codex took over all building on 2026-10-17. Before building anything from this plan, read LANES.md, check what ChatGPT has merged (`git log origin/main`), and agree lanes there. Codex also has REA registered, so this plan can be run by either agent.
- Memory rule: all heavy work goes through `.claude/handoff/heavy.sh`. REA's native analysis (Hopper) counts as heavy.

## 8. Resume checklist

1. `npx -y rea-agents@6.5.0 doctor --client claude_code --json` should report healthy. If it doesn't, rerun `npx -y rea-agents@6.5.0 setup --client claude_code --client codex --yes --json`.
2. Confirm the REA MCP tools are loaded in this agent; restart the agent if not.
3. `git fetch && git log --oneline -20 origin/main`, then read LANES.md.
4. Extract the ASARs into a scratch folder, then work through the section 4 rows in priority order: computer use, subagents, coding harness, reliability, chat UX, design and motion, native.
5. Write the evidence and design docs, then report to the owner with the evidence and wait for a go-ahead before building.

## Backlog (fill in while resuming)

See `docs/rea/README.md`, "Combined priority backlog" (30 top items; 78 in total across the four design notes).

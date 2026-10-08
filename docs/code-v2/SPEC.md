# Alevr Code v2 — spec

Owner request (2026-10-08, verbatim): "Use T3.code and deepseek harness to analyze how their Code harness work. Right now my Alevr Code isn't that good compared to ChatGPT Codex & Claude Code so i want you to improve it in terms of functionality ( subagents , orchestrators , computer use , ... ) , UI / UX & Motion design right now it's OK but it's not the best one and i want the best one 'cause right now the UI / UX ain't that good for a code tool ... Rework all the window , panels and everything that need a refresh. Rework the composer , model selector , the way you can choose model to orchestrate , a token window selector ( based on what the model offer and price difference ) and everything. Make my product the best experience and harness ever and like T3.Code you should be able to bring your own subscription just by connecting them ( like antigravity , codex , claude code ) so you can use your subscription limits inside of alevr code directly"

Owner answers: build with a multi-agent workflow; web and Mac together.

Trunk: branch `code/v2` (worktree `.claude/worktrees/code-v2`), based on `polish/research-next` 49a26fda. Nothing is pushed or deployed without the owner's OK (pushing main auto-deploys).

Reference clones (MIT, read-only): `$REFS/t3code` and `$REFS/deepseek-harness` where
`REFS=/private/tmp/claude-501/-Users-liammagnier-Developer-project-juno/81047b4a-b86d-45a8-82b3-12ab9729f942/scratchpad/refs`.
Never copy code verbatim without keeping the MIT notice; prefer re-implementing the idea. Never copy dsh's session-log upload to vendor.

## 1. Where things are today (audit of polish/research-next)

- Web `/code`: `src/app/(app)/code/*` (landing + composer), sessions render at `/chat/[id]` via `CodeSessionView` when conversation kind is `code`. Components `src/components/code/{code-composer,code-session-view,code-session-composer,code-run-cards,run-review,code-target-picker,code-session-banner}.tsx`, hook `src/hooks/use-code-session.ts`. Web is a remote: writes `CodeTask` rows; SSE `api/code/tasks/[id]/events` polls the DB every 1.2 s. Permissions hard-wired in `src/lib/code-environment.ts`. No plan mode, slash, @mentions, terminal, files, real diff, context meter, rewind.
- Product switch: `src/components/app/product-switch.tsx`, sidebar `src/components/app/app-sidebar.tsx`.
- TS runtime `runner/agent-core/src/{loop,agent,subagents,compaction,checkpoints,permissions}.ts`, providers `providers/{anthropic,openai-compat,openai-responses,proxy,registry,credentials}.ts`; used by cloud runner `scripts/cloud-code-runner.mjs` (GitHub Actions, currently blocked by billing). Subagents: 3 concurrent, stuck on parent's provider adapter.
- Swift runtime (what the Mac runs): `native/Packages/JunoCode/Sources/JunoCodeRuntime/AgentOrchestrator.swift`, ~40 tools in `Tools/` (incl. `ComputerUseTools.swift`, `DelegateTaskTool.swift`, `BuiltInAgents.swift`), core `JunoCodeCore/{CodeSettings,PermissionRules,CommandClassifier}.swift`, bridge `JunoCodeBridge/BackendCodeModelClient.swift` → `/api/agent/<provider>` (server keys, billed as ApiSpend "code"). BUG: stale aliases `sonnet|pro → claude-sonnet-5` (should be 5.5) and `max → qwen3.8-max` in `BackendCodeModelClient.swift` and `ComputerUseRoutes.parse`.
- Mac UI: `native/macOS/JunoDesktop/App/DesktopCode{Workspace,Studio,Host}.swift`, Studio `native/Packages/JunoCode/Sources/JunoCodeUI/Studio/*` (`StudioComposer`, `StudioModelChip`, `StudioContextMeter`, `StudioSessionView`, `StudioThreadView`, `StudioSidePanel`, `StudioApprovalPrompt`, `StudioRewind`, `Sheets/StudioCommandCenter`, `Settings/*`), controller `JunoCodeUI/Models/SessionController.swift`. Studio still on its own `StudioTheme`, missed the Oct Liquid Glass/premium passes.
- Models: `src/lib/models.ts` (`ModelInfo.contextWindow` single value, `cost` 1–3), `src/lib/pricing.ts` (`tokenRate`, `longContextMultipliers` — GPT-6 >272K 2× input, xAI from 200K: priced but not selectable), `src/lib/native-model-manifest.ts` (context + $/MTok sent to Mac), `src/lib/model-metrics.ts` (effort ladders). Pickers: web `src/components/chat/model-selector.tsx` + `model-catalogue.tsx`; Mac `JunoModelSelector`.
- Credentials: server keys only. `src/lib/crypto.ts` AES keyring (`TOKEN_ENCRYPTION_KEYS/PRIMARY`) reusable for BYOK. Prior provider/legal analysis: `native/desktop-electron/docs/PROVIDERS.md` + ACP client `native/desktop-electron/src/providers/acp/*` (unshipped Electron) — reuse the ACP code.

## 2. Bring your own subscription (from T3 Code)

Principle: Alevr never touches vendor credentials or calls inference with them. It launches the vendor's OWN agent runtime on the user's machine through the vendor's official programmatic interface; billing/limits stay inside the vendor runtime. Therefore it only works where Alevr runs locally (Mac app / local env server). The hosted web reaches it through the user's Mac (device link).

Per provider (see `$REFS/t3code/docs/internals/providers.md`, `apps/server/src/provider/*`, `apps/server/src/orchestration-v2/Adapters/*`):
- **Claude** (display "Claude Agent" / "Claude (your subscription)"; never call the product "Claude Code" as if it were ours): `@anthropic-ai/claude-agent-sdk` `query({prompt: asyncIterable(queue), options})` with `pathToClaudeCodeExecutable` = user's `claude`, `includePartialMessages`, `permissionMode`, `effort`, `sessionId`/`resume`/`resumeSessionAt`, `canUseTool`, `thinking:{type:'adaptive',display:'summarized'}`, `mcpServers:{alevr:…}`, `systemPrompt:{type:'preset',preset:'claude_code',append}`. Steering = push to queue; `setModel`, `setPermissionMode`, `interrupt()`. Per-account `CLAUDE_CONFIG_DIR`; never override HOME (Keychain). Probe: `claude --version`, then `query()` with a never-yielding prompt → `initializationResult()` (email, subscriptionType, tokenSource) + usage windows; probe disables hooks/MCP, persistSession false, 25 s timeout; abort. Install/login: open an in-app terminal with `curl -fsSL https://claude.ai/install.sh | bash` / `claude auth login` typed in. Approvals map: accept→allow(updatedInput), acceptForSession→allow+updatedPermissions(session), decline→deny, cancel→deny+interrupt. ExitPlanMode captured as plan + denied. Modes: plan→plan, Supervised→default+callback, Auto-edit→acceptEdits, Auto→auto, Full→bypassPermissions.
- **Codex** (ChatGPT plan): spawn `codex app-server`, JSON-RPC over stdio; `initialize{clientInfo:{name:'Alevr'},capabilities:{experimentalApi:true,optOutNotificationMethods:['turn/diff/updated']}}` → `initialized`. Probe `account/read` (`requiresOpenaiAuth` ⇒ not signed in), `model/list` (paged), `account/rateLimits/read`. `thread/start{cwd,model,config}`, `thread/resume{excludeTurns:true}`, `turn/start{threadId,input,cwd,model,effort,summary:'detailed',approvalPolicy,approvalsReviewer,sandboxPolicy,collaborationMode?}`, `turn/steer`, `turn/interrupt`. Server requests `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `item/tool/requestUserInput` answered `{decision: accept|acceptForSession|decline|cancel}`. Modes: Supervised=untrusted/user/readOnly; Auto-edit=on-request/user/workspaceWrite; Auto=on-request/auto_review/workspaceWrite; Full=never/user/dangerFullAccess. Login: `codex login` in the in-app terminal (Path A). Path B ("Connect with ChatGPT" OAuth token sharing) is OUT of scope until OpenAI confirms Alevr may use it — leave a disabled stub.
- **ACP agents** (generic adapter; reuse `native/desktop-electron/src/providers/acp/*` and `$REFS/t3code/packages/effect-acp`): Antigravity (`antigravity-acp` official runtime, Google sign-in loopback), Gemini CLI (`gemini --experimental-acp`), Grok (`grok agent stdio`, `grok login`), DeepSeek Harness (`dsh --profile acp`), OpenCode. Background checks only call `initialize`.
- **Alevr (built-in)**: Alevr's own engine on Alevr keys/plan (current behaviour).
- **BYOK**: user API keys (Anthropic, OpenAI, Google, xAI, DeepSeek, OpenRouter) stored encrypted with `src/lib/crypto.ts`; used by the Alevr engine instead of server keys and NOT billed as ApiSpend.

Rules: provider *instances* isolate accounts (id, kind, binaryPath, configDir, env, launchArgs). Health checks never open sessions, run hooks or start logins. Capabilities are declared honestly and the UI branches on capabilities, never on vendor name. Usage-limit stops become a "Limited" state with "Resume at reset". Legal risk to re-verify before public release (record in docs/code-v2/PROVIDERS-LEGAL.md): Anthropic terms on third-party apps using Claude plans via the user's own CLI; Antigravity terms for the official ACP runtime.

## 3. Harness upgrades (from DeepSeek Harness + T3 + Codex/Claude Code parity)

1. Event-sourced session log with monotonic `sequence` + snapshot/cursor streaming, 50 ms delta coalescing (replaces the 1.2 s DB poll where possible).
2. One normalized `TurnItem` schema across engines/providers: user_message, assistant_message{streaming}, reasoning, plan, todo_list, user_input_request, file_change, command_execution, search, web_search, approval_request, checkpoint, interrupt, system_notice, error, compaction, handoff, subagent, computer_action.
3. Subagents: continuable background children (tool returns id; parent gets ONE settlement notice with the child's closing text), `send_message`, `interrupt_agent`, `list_agents`, spawn vs fork (fork reuses parent prefix cache), depth 1, per-child tool filter / persona / output schema. Children may use a DIFFERENT provider/model than the parent (role routing).
4. Orchestrator: role-based model routing — Orchestrator (main), Workers, Reviewer, Explorer, Compaction/Titles — each a {provider instance, model, effort, context tier}. A `workflow` tool (agent/parallel/pipeline/phase, meta compatible with Claude Code workflows) with a hard **token/cost budget** (dsh lacks this). Best-of-N fan-out: one prompt → N models, each in its own worktree, compare & pick.
5. Context: layered compaction (prune tool results >8192 chars to head 4096 + tail 1024 → offload images → summarize oldest balanced span with a fixed template, replaying the exact prefix for cache hits); trigger floor(min(0.8·W, W−O−65536)); keep newest 16 %; overflow → compact+retry once; `/compact`; spill outputs >12.5k tokens to a file and return the path.
6. Steer vs Queue lanes (Enter = queue/send, ⌘↵ = steer while running; Send becomes Stop when draft empty; Esc Esc stops), editable QueueDock.
7. Permissions presets = sandbox × approval (Read-only / Ask / Auto-edit / Auto (model reviewer) / Full access), per-call justification, fail-closed outcomes, approval card bound to callId taking over the composer.
8. Checkpoints: hidden git refs `refs/alevr/checkpoints/<thread>/turn/<n>` via temp GIT_INDEX_FILE + write-tree + commit-tree + update-ref → per-turn and whole-thread diffs and "Edit from here" revert (captures shell changes too).
9. Worktree per thread (optional), setup/settle scripts.
10. Guards: read-before-edit + stale-file rejection, repeat-call reminder at 3/5/8, bash timeout → background job, description-first tool args.
11. Alevr MCP server injected into vendor agents (Claude/Codex/ACP) so they get Alevr subagents-on-any-provider, computer use and thread search.
12. Computer use: native macOS (ScreenCaptureKit + AX) available to EVERY model via a function-tool schema (not only Anthropic/OpenAI), with an action overlay, a screenshot timeline in the thread, a cross-session desktop lock, and kill switch (Esc / menu-bar).

## 4. Model, context-window and price selection

- Extend `ModelInfo` with `contextTiers: {tokens, label, inputPerMTok, outputPerMTok, cachedInputPerMTok?, note?}[]` derived from `pricing.ts` (long-context multipliers become selectable tiers, e.g. GPT-6 272K standard vs 1M at 2× input; Claude 200K vs 1M where offered; Gemini 1M/2M). Keep a single source of truth; existing `contextWindow` = default tier.
- Context-window selector: shows each tier's window, $/MTok in/out, the delta vs default ("+2× input above 272K"), and an estimated cost for the current thread size. For subscription providers it shows plan-limit windows instead of $.
- Role picker ("Orchestrate"): orchestrator model + worker model(s) + reviewer, per-thread, with presets (Solo, Lead + workers, Best-of-N). Shows estimated relative cost.
- Picker shape (from T3): popover with a provider-instance rail (Alevr, each connected subscription, BYOK keys; status shown by text/monochrome glyph, never coloured pills/dots), searchable model list filtered to agentic coding models ordered "best for coding", a single "traits" chip (effort · speed · context tier).

## 5. Design & motion bar (owner rules — non-negotiable)

- Premium, not "AI slop": must be visibly better than current Alevr at identical frames; owner reviews screenshots before anything is pushed.
- No status pills or status dots anywhere ("live", "active", "ready" chips are banned). State is conveyed by type, glyph shape, motion, the coral accent ("working / needs you" only).
- At most two type weights per screen; accent in at most one or two places per screen; one elevated object; calm generous space.
- Mac/iOS: native Liquid Glass and stock macOS 26 components; icons from the web set via `JunoIconView` with web sidebar metrics (260w, 32 rows); never SF-Symbol look-alikes.
- Motion: one easing family, 120/180/240 ms, springs for fold/unfold and panel docking, FLIP for list reorders (≤150 ms), streaming rows fade-in, reduced-motion paths, no continuously repainting animations.
- Design skills to apply: design:design-system, swiftui-design-skill, stitch-design-taste, design-taste-frontend.

## 6. Lanes

Each lane works in its own worktree `.claude/worktrees/code-v2-<lane>` on branch `code-v2/<lane>` created from `code/v2` AFTER the contracts seam lands, commits often, and leaves the branch for integration. Contract files are owned by the seam; lanes may extend them additively only.

- seam: contracts + this spec + design spec.
- env: local environment server (provider adapters, probes, instances, checkpoints, worktrees, terminal PTY, device link).
- orchestrator: agent-core subagents/workflow/budget/compaction/guards/steer-queue + Swift orchestrator role routing.
- models: catalogue tiers, pricing, role routing API, BYOK storage + settings, /api/agent tier + BYOK routing.
- web: web Code workspace + composer + pickers + motion.
- mac: Mac Studio rework + Connections settings + env-server client.
- computer: native computer use for all models + overlay + timeline + MCP exposure.

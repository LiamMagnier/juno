# SPEC review: workstreams and tests (§12–§13)

Reviewer lens: SPEC §12 and §13 read as a project plan. Four questions: is file ownership really
disjoint; can wave 1 run in parallel against the WS0 contracts; can every acceptance check run
offline (no provider keys, no signed-in browser, `/dev` galleries only); and do the named tests
catch the root causes in `audit/internal-tools-e2e-trace.md`? I also checked every DECISIONS item
for an owner. Every claim below was checked against the code at the branch head (`169e6bb1`).

**Verdict.** The contracts in §2–§11 are detailed, but the plan cannot run as written:

- Wave-1 workstreams cannot keep `typecheck` green without editing files they do not own.
- The WS0 scaffold leaves out types and stubs that wave-1 code has to import.
- About a third of the new tests cannot run under the repo's `npm test`, because it has no
  `react-server` condition and no DOM.
- The Gemini test row asserts the RC-7 bug itself.
- One contract contradiction would kill every connector approval after 60 s.

---

## Blocking

### 1. Wave 1 cannot keep `typecheck` green without editing files it doesn't own (§12.1, §12.4, §12.6)

§12.1 makes `npm run typecheck` a per-workstream gate and forbids editing another workstream's
files. `tsconfig.json` includes `**/*.ts`, so tests are typechecked too. Several wave-1
deliverables change or delete exports that files owned by others still import:

| Wave-1 change | Breaks (owner) |
|---|---|
| WS1 deletes `src/lib/agent/runtime.ts` (§3.3 item 8) | `src/lib/llm.ts:6` imports `openUnifiedAgentToolset` (WS3a) |
| WS1: `getActiveConnectors` returns `{ active, skipped }` (§3.4 item 1) | `route.ts:920` uses it as an array (WS9a) |
| WS1: `CHAT_SKILL_TOOLS` loses `browser` (§3.5) | `route.ts` grant layer; `tests/chat-skills.test.ts:103,293` (no owner) |
| WS3: `streamChat` drops `connectors`, `allowedTools`, `audit`, `nativeTools` (§5.0) | `route.ts:2947-3001` passes all four, and the private path `route.ts:1151-1163` passes `connectors: []` (WS9a) |
| WS3: `ProviderAdapter` gains `"xai-responses"` | `src/lib/model-capability-probe.ts:36-86` has no case for it (no owner). `tests/model-capability-probe.test.ts:91-97` requires a probe for every model |
| WS3: `ModelInfo.tools` becomes required (§5.6) | `ModelInfo` literals in `src/lib/auto-model.ts:425`, `model-discovery-core.ts:293`, `task-tool.ts` and `route.ts`, and 12 test files (`grep -l agenticTools: tests/`) |
| WS4: the `GenerationAccumulator` constructor takes a `SourceRegistry` (§2.11) | `route.ts:1030` and `route.ts:2508` (WS9a) |
| WS8 reworks `use-conversation-run.ts` (§9.15) | `chat-view.tsx:52` (WS9b/WS9c) |
| WS2: the `allowedImageUrls` image rule in `markdown.tsx` (§6.4 item 3) | 13 `Markdown` consumers, including `canvas/canvas-panel.tsx` (see item 17) |

**Fix.** Add a rule to §12.1:

> In wave 1, a change to any export imported outside the workstream is additive. The old
> signature stays as a deprecated overload or shim, and new fields are optional, until the
> consumer's integration workstream switches over. A file that is imported outside its workstream
> is deleted in the integration wave.

Then list each shim and who removes it:

- `runtime.ts` and `browser.ts` are deleted by WS9a, after WS3 stops importing them.
- `getActiveConnectors` keeps its array return, and `getConnectorsWithStatus` is added beside it.
- `streamChat` accepts and ignores the four old options until WS9a.
- The accumulator's `sources` constructor option is optional.
- `ModelInfo.tools?` is optional behind a `toolCapabilitiesFor(model)` resolver. Tightening it is
  a WS9a item.

### 2. The WS0 scaffold does not cover what §12.7 says it lands (§12.3, §12.7)

§12.7 is titled "the stubs WS0 lands", but §12.3 item 6 stubs only eight functions. The rest are
missing, although wave-1 code has to import them:

- **Types the WS0 contracts themselves reference:**
  - `SourceRegistry` (`ToolContext.sources`, §3.1). Its file, `src/lib/chat/source-registry.ts`,
    is WS4's and is not in WS0's Owns list, so `tools/types.ts` cannot compile.
  - `ToolFeeAccumulator` (`BatchContext.fees`, §4.2), which lives in `tools/metering.ts` (WS1).
  - `PrivateSpanSet`, `ChatSearchResult` and `TurnWebLimits` (the `chatWebSearch` signature, §6.3).
  - `NativeChatTool`, which lives in `src/lib/llm.ts:39` (WS3). `openChatToolset` (WS1) takes it.
  - The `ToolExecution` and `ToolExecuteOptions` changes, which live in `src/lib/mcp.ts` (WS1). The
    WS0 minimal dispatcher reads them.
- **Types used in the SPEC but defined nowhere:**
  - `ChatSourceOrigin` (§8.3.2) and `ChatSource[]` "with `origin: "research"`" (§9.6.3).
    `ClientSource` (`src/types/chat.ts:118-133`) has no `origin`.
- **A name mismatch:** the stub is `fetchPage` (§12.3, §12.7), but §6.1 defines
  `fetchPageForChat`.
- **Model capabilities:** `ModelInfo.tools` is needed in wave 1 by:
  - WS1 (`model.tools.supported` and `nativeSearch` in §3.6);
  - WS7 (`tools.chatCompletions`, §5.2 item 11).

  WS0 lands only the `ModelToolCapabilities` type, and `ModelInfo` lives in `models.ts` (WS3b).
- **Functions and components wave 1 consumes:**
  - Components: `RunGlyph`, `RunLabel`, `FaviconStack` and `RunClock` (WS8 in §9.11.3; WS6 in
    §8.3); `RightColumnShell` (WS8).
  - Functions: `applyStreamChunk`, `openChatToolset`, `chatToolEntitlements`, `TurnStream`,
    `splitAnswer`, `researchEntitlement`, `researchBudgetFor` and `enginePriceMicroUsd` (WS7's
    roster, §9.2).
  - `src/app/dev/run/panel-states.tsx`, which WS5's gallery imports.

**Fix.**

1. Give WS0 these files in its Owns list:
   - `src/lib/chat/source-registry.ts` (class shell);
   - `src/lib/tools/metering.ts` (class shell);
   - `src/lib/web/types.ts`;
   - compile-only additive edits to `mcp.ts`, `llm.ts` (move `NativeChatTool` into
     `tools/types.ts` and re-export it) and `models.ts` (optional `tools` plus a resolver);
   - component stubs with final props: `run-glyph`, `run-label`, `favicon-stack`, `run-clock`,
     `right-column-shell` and `panel-states`.
2. Define `ChatSourceOrigin` in `src/types/run.ts`.
3. Pick one name for the fetch function.
4. Make `contract-scaffold.test.ts` import every §12.7 symbol, so the list and the scaffold cannot
   drift apart.

### 3. The test plan does not fit the repo's test harness (§13 intro, §13.1)

**(a) `server-only`.** `npm test` runs `tsx --test tests/*.test.ts` with no `react-server`
condition. `node_modules/server-only/package.json` maps `default` to `index.js`, which throws on
import. These modules are `server-only`:

- `llm.ts`, `anthropic.ts`, `gemini.ts`, `openai-compat.ts` and `openai-responses.ts`;
- `mcp.ts`, `serializers.ts`, `action-approval-store.ts` and `tool-audit.ts`;
- `web-search.ts`, `deep-research.ts`, `spend.ts` and `app-data.ts`.

The repo already works around this by reading such files as text
(`tests/code-activity-persistence.test.ts:15`: "are server-only and cannot be imported here"), and
it has a guard for it (`tests/chat-task-tool.test.ts:415`). As specified, these files cannot load:

- `anthropic-tool-loop`, `gemini-tool-loop`, `responses-tool-loop`, `compat-tool-loop`,
  `adapter-parity` (they import the adapters);
- `serialize-activity` (it imports `serializers.ts`);
- `chat-toolset` and `mcp-toolset-status` (they import `mcp.ts`);
- `tool-dispatch` and `tool-broker-runtime`. §3.3 item 3 makes `dispatch.ts` import
  `authorizeExternalAction`, which is `server-only` and talks to Prisma with no port. No
  "in-memory broker port" exists in `action-approval-store.ts`; its exports are at `:74-670`;
- `research-envelope` (it needs `eurPerUsd()` from `spend.ts`);
- `research-completion`, `tool-turn-e2e` and `parts-roundtrip`.

**(b) No DOM.** `package.json` has no jsdom, happy-dom or @testing-library. The existing component
tests use `renderToStaticMarkup`. That rules out:

- `right-column-shell` (focus return);
- `auto-translate-prune` (TreeWalker, MutationObserver, 10,000 mutations);
- `use-chat-live`, `research-hooks`, `composer-research` and `research-steer-mode`, which are
  hooks or interactive components.

**(c) No route harness.** Nothing in `tests/` imports a route handler. The chat route needs a
session and Prisma. Its deterministic provider is enabled only by `JUNO_E2E_SMOKE_PROVIDER=1`
and is disabled for private turns (`route.ts:550-551`). So `tool-turn-e2e` ("persisted row,
reload") and `parts-roundtrip` cannot run offline.

**(d) No provider transport seam.** Today's tests cover only the round readers
(`anthropic-round.test.ts`, `gemini-round.test.ts`, `openai-compat-round.test.ts`). The adapters
reach the SDKs through singletons such as `getAnthropic()`. So the full-loop assertions have no
way in:

- `tool_choice:none` on the final round;
- `max_uses` equal to the budget;
- `pause_turn` counted;
- per-request usage.

**Fix.** Add these rules to §13:

1. Every module a unit test imports must be free of `server-only` in its static graph. Each new
   test file carries a guard like `chat-task-tool.test.ts:415`.
2. The pure cores move out of `server-only` files:
   - `serializeActivity` moves to `src/lib/chat/run-record.ts`;
   - the adapter loops go in `*-loop.ts` modules with an injected `ProviderTransport`. Add
     `AdapterRequest.transport?` to §5.0 in WS0;
   - `dispatch.ts` gets its broker, audit and MCP functions through a `BatchContext.ports` field.
     Extend `scripts/check-approval-dispatch.mjs` so it accepts a port call named
     `authorizeExternalAction`.
3. WS9a extracts the turn body into `src/lib/chat/run-turn.ts(ports)`. The route becomes a thin
   caller, and `tool-turn-e2e` and `parts-roundtrip` drive `runTurn` with fakes.
4. Pick one route for DOM tests and name it:
   - either WS0 adds `happy-dom` as a devDependency. It owns `package.json` and the lockfile, and
     HANDOFF.md says `node_modules` is symlinked to the main checkout, so this needs the owner's
     go;
   - or each DOM test is restated against a named pure module: `shell-focus.ts`,
     `auto-translate-filter.ts`, `consumeChatStream()`, `research-discovery.ts`,
     `composerResearchState()` and `steerTarget()`.

### 4. Connector and `start_task` approvals run inside the 60 s tool timer (§4.2 step 7, §2.5, §13.1 `tool-dispatch`)

§4.2 says "After authorisation … yield `running` … and start the per-tool timer … The approval wait
is never inside the timer." For connectors and `start_task`, though, authorisation happens inside
`toolset.execute` (§3.4 item 8; `mcp.ts:456-481`, `task-tool.ts`). `ToolExecuteOptions` carries
only `onApprovalRequest`, so the dispatcher cannot tell when authorisation ended. It must pass the
timed signal into `execute`, and the 60 s connector timeout (§4.4) then aborts an approval the
user has 15 minutes to answer.

The test row confirms the confusion. `tool-dispatch` asserts `queued → running →
awaiting_approval → running → succeeded`, but the §2.5 lifecycle says `queued → awaiting_approval
→ running`.

**Fix.**

1. Add `timeoutMs` and `onAuthorized(): void` to `ToolExecuteOptions`.
2. `mcp.ts` and `task-tool.ts` start the timer around `client.callTool` or the task dispatch
   only, and call `onAuthorized` before it. The dispatcher yields `running` from `onAuthorized`.
3. Make the test assert §2.5's order.
4. Add a case: an approval that waits longer than `timeoutMs` must not end as
   `failed/timeout`.

### 5. The Gemini test row asserts the RC-7 bug, and nothing tests the RC-7 fix (§13.1, §5.3 item 1)

`gemini-tool-loop.test.ts` asserts "`exec.body ?? exec.text`". That is the unenveloped
connector-output bug (`gemini.ts:319`, RC-7, DECISIONS T1). §5.3 item 1 says the fix is
`exec.text`. The trace's fix for RC-7 also asks for an adapter-parity test on the **model-facing**
payload. §13's `adapter-parity` compares SSE frames, which cannot see it.

**Fix.**

1. Change the row to "`functionResponse.response.result === exec.text` (enveloped); errors as
   `response.error`".
2. Add a case to `adapter-parity`: the same `BatchResult`, fed through each adapter's replay
   builder, gives every provider the enveloped text (INV-30).

### 6. `estimateFor` is client-side but lives in a module that imports `server-only` (§9.2, §9.11.2, §12.3)

`envelope.ts` exports `estimateFor`, which is "also used client-side" by the scope card (WS8). The
same file's `researchBudgetFor` converts EUR "with `eurPerUsd()`", and `eurPerUsd` is in
`src/lib/spend.ts`, which starts with `import "server-only"`. Importing it into `scope-card.tsx`
breaks the Next build, and `research-envelope.test.ts` cannot import it (item 3a).

**Fix.** WS0 lands `src/lib/research/estimate.ts` (pure: `ResearchScope`, `ResearchEstimateCaps`,
`estimateFor`). `researchBudgetFor` takes `eurPerUsd` as an input.

### 7. RC-2 and T4 in the UI have no owner: compat models still can't turn web on (DECISIONS T1 RC-2, T4)

The RC-2 symptom is "the web toggle is greyed out". Three gates keep it that way after this plan:

- The composer's `canWebSearch` needs `resolved?.webSearch` (`composer.tsx:714-718`).
- `features.webSearch` is `configuredProviders().some(providerSupportsWebSearch)` (`app-data.ts:191`).
- The route's `useWebSearch` needs `modelInfo.webSearch` (`route.ts:939` and `route.ts:2099-2100`).

§5.6 derives `ModelInfo.webSearch` from `tools.nativeSearch`. DeepSeek, Mistral, Qwen and the other
compat models keep `webSearch: false`, so the toggle stays hidden on exactly the models RC-2 is
about. A user who once turned web off cannot turn it back on. No workstream owns the composer
gate: WS9c's Delivers list doesn't mention it, and WS7 owns only the `features.deepResearch` line
of `app-data.ts`.

**Fix.**

1. Define `features.webSearch` as "the plan allows web, and a keyed engine or a native-search
   provider is configured". WS7 or WS9c owns that line.
2. Make the composer gate `plan.webSearch && modality === "chat" && (resolved.tools.nativeSearch ||
   features.keyedSearch)`. WS9c owns it.
3. Retire `modelInfo.webSearch` in the route in favour of `chatToolEntitlements` (WS9a).
4. Add a test that sweeps every current chat model and asserts the toggle is available whenever
   the plan and a keyed engine allow it.

---

## Important

### 8. No merge order or per-merge gate inside wave 1, and the gates are too narrow (§12.1, §12.2)

Eight branches merge "in wave order", but wave 1 has no internal order and no gate after each
merge. Each workstream runs only its own tests, yet it changes shared modules whose consumers'
tests belong to nobody in that workstream:

- `search-engine.ts` (WS2) is used by Research and Work (`research-crawler`, `research-corpus`,
  `unified-search`).
- `mcp.ts` (WS1) is used by Work and scheduled tasks (`work-connectors`,
  `connector-result-truncation`).
- `pricing.ts` (WS1) is covered by `pricing-billable` and `work-pricing`.

CI also runs gates that §12.1 omits (`.github/workflows/deploy.yml`):

- `models:capabilities:audit` (`:132`), which WS3's catalog changes can trip (item 11);
- `capabilities:check` (`:116`);
- `work:contract:check` (`:129`).

**Fix.**

1. The per-workstream gate becomes typecheck, full `npm test` (offline, about 300 files), lint,
   `models:capabilities:audit` and `design:tokens:check`.
2. Fix the merge order: WS2 → WS1 → WS3a → WS3b → WS4 → WS7 → WS5 → WS6 → WS8.
3. Rerun the full gate on the integration branch after every merge.

### 9. WS8 and WS6 are not parallel with WS5 (§12.2, §12.4 WS6 and WS8, §9.11.3, §8.3)

- The Research row reuses `RunGlyph`, `RunLabel`, `FaviconStack`, `RunClock` and the pacer
  (§9.11.3). The Research panel sits inside `RightColumnShell` (WS6).
- The Activity panel header "is the same `RunLabel` reading the phase store" (§8.3). Its rows use
  `presentTool` and `PhraseWithArgs`.

None of these components are stubbed (item 2). **Fix:** either WS0 lands the component stubs with
final props, or WS8 moves to wave 2 after WS5 and WS6. WS6 can still start in wave 1 on the shell
and `panel-state.ts`.

### 10. `/dev/run` needs wave-2 code, and its fixtures can drift from the server (§11.1, §12.4 WS5)

The gallery "feeds frames … into a real `MessageList` with real `MessageItem`s". But `MessageItem`
renders `RunBlock` only after WS9b (wave 2), and fixture 21 needs WS8 and WS9c (wave 3). The
fixtures are also hand-written `StreamChunk` frames. Nothing ties them to what `TurnStream` (WS4)
actually emits, so the gallery can pass against a wire the server never produces.

**Fix.**

1. In wave 1, the gallery mounts `RunBlock` directly under a minimal transcript. WS9b adds the
   real-`MessageList` mode.
2. WS0 lands `tests/fixtures/turn-scripts.ts`: `LlmEvent` scripts, one per fixture.
3. A test in WS4 checks that each gallery fixture's frames equal `TurnStream` applied to its
   script.

The same scripts also serve `native-stream-conformance` ("every fixture script", which is
undefined today) and `adapter-parity`.

### 11. Hidden files the contracts need, owned by nobody (§12.4)

| Need | File (owner: none) |
|---|---|
| `run_code` forwards the chat signal (M20, §3.8.5) | `src/lib/code-interpreter.ts:238` uses `AbortSignal.timeout(...)` only. WS1 is told to leave `agent/code.ts` "untouched", yet it must also wrap the file-derived output (`code.ts:212-240`) |
| Skill `requestedTools` aliasing (§3.5) | `src/lib/skills/sources.ts:224-241` |
| §5.4 item 8 catalog fixes (`deepseek-flash reasoning`, GLM-5.3 effort) | `src/lib/model-metrics.ts:787-795` (`reasoningCaps`), `model-reasoning-capabilities.ts`, and `native-model-manifest.ts`, which changes the reasoning tiers native receives. The CI audit is `scripts/audit-model-capabilities.ts` |
| xAI routing (§5.0) | `model-capability-probe.ts`, `attachment-bytes.ts:77-81`, and `chat-responses.ts:25-30` ("Grok Live Search") |
| `handoff` is terminal (§2.3, §9.6.1) | `TERMINAL_FRAME_KINDS = ["done","error"]` (`stream-log.ts:38`, WS4) and `sweepChatStreamEvents` `kind: { in: ["done","error"] }` (`chat-stream-log-store.ts:108`). A resumed hand-off stream never ends |
| The resume route follows the logged features (§2.2, INV-1) | `src/app/api/chat/stream/[generationId]/route.ts`. It is in WS9a's glob, but not in WS9a's Delivers |
| INV-33 pause survives events | `chat-stall.ts:157-159`: `touch()` clears `paused`. §4.8 works around it in the route, and no test covers it (item 15) |
| `ApprovalCard` prop changes (WS5) | `src/app/dev/task-handoff/gallery.tsx:4` |

Existing tests that break and have no owner:

- `tests/september-22-models.test.ts:42-62` pins `gpt-6-sol`, `gpt-6-luna` and `grok-4.7` to
  `"openai-compatible"` and `/chat/completions`. The routing change in §5.0 breaks it.
- `tests/model-capability-probe.test.ts:91-97`.
- `tests/chat-skills.test.ts` uses `CHAT_SKILL_TOOLS.browser`.
- `run-receipt-tools` is listed in §13.2 with no owner.
- `chat-stream-resume.test.ts` is updated by both WS4 and WS9b but is missing from the §12.6
  sequence table.
- `research-run-clock.test.ts` cases move into WS5's `i18n-format.test.ts`, but the source file is
  deleted in WS9c, two waves later.

**Fix.** Assign each file:

- WS1: `code-interpreter.ts`, `skills/sources.ts`, `chat-skills.test.ts`;
- WS3b: the model-metrics trio, `model-capability-probe.ts`, `attachment-bytes.ts`,
  `chat-responses.ts`, and the two model tests;
- WS4: `stream-log.ts` (add `handoff` to the terminal kinds) and `chat-stream-log-store.ts`;
- WS9a: the resume route, as an explicit deliverable;
- WS9b: `run-receipt-tools`;
- WS5: `dev/task-handoff`.

### 12. Tightening `LlmEvent` has no workable owner (§2.9, §12.3 item 1 and item 9, §12.6)

§2.9 makes `round` required on `text` and `reasoning`, and `status`, `round` and `index` required
on `tool`. WS0 is told "additions (no removals)" with "compile-only edits". Making those fields
required means editing every producer: `anthropic-round.ts`, `openai-compat.ts`,
`openai-responses.ts` and `gemini*.ts` (WS3), and the smoke and research-notice streams in
`route.ts:246-290` (WS9a). Tightening later in WS3 breaks `route.ts`.

The usage fields for xAI `x_search` posts and profiles and for Gemini query counts are also only a
dangling comment in §2.9. WS3, which produces them, and WS1, which prices them in `pricing.ts`,
have to agree on them.

**Fix.** WS0 lands the new fields as optional and names the usage fields. WS9a makes them required
once every producer complies.

### 13. The shared dev server can't show this branch, and the motion checks have no tool (§12.1, §11, §13.3, DECISIONS U7)

§12.1 says galleries are checked "on the shared dev server (port 3100)". That server runs the main
checkout. HANDOFF.md says to start one from this worktree on port 3200, with its own `.next`.

Reduced motion and forced colours are to be "checked with the browser's emulation". The browser
pane's `resize_window` emulates only `colorScheme`. Playwright is a dependency, but no Chromium is
installed: the e2e trace reports 8 `work-browser` tests skipped for exactly that. VoiceOver needs a
person.

**Fix.**

1. Port 3200 from `juno-tools`, started once at integration.
2. The galleries get a "simulate reduced motion" toggle that sets `data-motion="reduce"` on the
   gallery root, and the §7.9 reduced-motion block is also written under
   `:root[data-motion="reduce"]`.
3. Forced colours and VoiceOver move to the owner's list in §14.

### 14. DECISIONS items that no workstream owns

- **Private web toggle (§4c Private chats).** DECISIONS allows `web_search` and `web_fetch` only
  "when web is toggled on *in that chat*". The client sends the sticky `composerPrefs.webSearch`,
  which defaults to on (`app-provider.tsx:70`, `chat-view.tsx:252,352`), so private chats get web
  by default. Specify per-chat, default-off state for private chats (WS9c) and test it.
- **The `suggest_research` chip (T3, §3.8.9).** WS9c owns "the chip under answers", but the chip
  renders inside `MessageItem` or `MessageList` (WS9b), and WS9c owns neither. Give the slot to
  WS9b and the click handler to WS9c.
- **Search metering (§4c, "Every search is metered at the engine's real per-query cost").**
  Research still records a flat `SEARCH_FEE_MICRO_USD = 1_000` per fan-out (`domain.ts:1466`).
  Either WS7 meters each engine call at its price, or the SPEC states "chat only" and justifies it
  against DECISIONS.
- **Done choreography and `aria-busy` (U1/U6, §7.10, §7.12).** The toolbar fade, the follow-up
  stagger, the title and memory-pill timing, and `aria-busy` on the message root all live in
  `message-item.tsx`, `message-list.tsx` and `chat-view.tsx`. WS5 "delivers §7 in full" but owns
  none of them, and WS9b's Delivers list omits them. Add them to WS9b.
- **The Research completion line (§9.11.3).** "Researched for 14m · 42 sources ›" is not in the
  §7.6.2 summary grammar, and nobody owns building it. Add a `research` lead to §7.6.2 (WS5).

### 15. The named tests miss root causes and invariants (§13.1)

| Gap | Add |
|---|---|
| RC-1 and RC-9 (INV-33): a tool that runs longer than `PROVIDER_IDLE_TIMEOUT_MS` (120 s, `chat-stall.ts:25`) must not stall, including while its status events call `touch()` | `turn-stream`: `onToolActivityChange` counts. A fake-timer `chat-stall` or `run-turn` case: a 130 s `run_code` completes |
| RC-2: every tools-capable model gets search | A `tool-entitlements` sweep over `MODEL_LIST`: with `webToggle` and a keyed engine, the plan has native search or `web_search`, plus `web_fetch` |
| RC-3: a failure to open MCP keeps Juno tools (§3.7); "Connected tools ready" lists only ready connectors | A `chat-toolset` case. A turn-start-facts unit (the §2.12 helper, WS4) |
| RC-12: xAI `search_parameters` is never sent | A `responses-tool-loop` case |
| RC-13: call ids per adapter | Responses, compat (a synthesized `jc_` id for a streamed call with no id, `openai-compat-round.ts:75-77`) and Gemini hand the dispatcher and broker the provider id |
| RC-14: raw arguments reach the dispatcher | Per adapter, invalid JSON arrives as `argsText` and produces an `invalid_args` result (Responses `:455-460`, compat `:563-568`) |
| INV-32: a private chat persists nothing | `tool-dispatch` with `private: true`: the broker, audit and ledger-DB ports are never called |
| INV-34: the memory gate follows the dynamic taint | A web-on turn with no search saves memory; a turn with a `web_fetch` result does not |
| INV-11: the native research path is frozen | `toActivity` titles and kinds snapshotted, and auto-confirmation still happens |
| INV-22: the previous build can read the new plan | Parse the new `plan` JSON with a snapshot of `parseBudget` taken at `d0997af2` |
| B1: the panel survives the temp→server id swap (`chat-view.tsx:1096-1104`) | A pure `reconcileRightPanel(state, messages)` in `panel-state.ts`, tested by WS6 and adopted by WS9b |
| A turn that fails before any text loses its tool rows and approvals on reload (trace §5; DECISIONS T6: approvals "survive done and a reload") | Specify it, then test it in `parts-roundtrip` |
| The extractor skips `defineTool` and `*.prompt.ts` (INV-29, §10.5). `COPY_PROPERTIES` includes `description` and `title` (`generate-i18n-catalog.mjs:12-45`) | A test that runs the extractor on a fixture |
| INV-20 legacy fixtures are "captured from current prod shapes", which is impossible offline | Build them from the emitters at `d0997af2` (`route.ts:379-423`, `2762-2767`, `2896-2908`, `3028-3037`) |

### 16. The contracts leave fields WS6 and WS8 need undefined (§2.4, §8.3, §9.4)

- §8.3.1 renders `error.message`, but `ToolCallRecord.error` is `{ code }` only.
- "Injection was flagged" has no field on the record or on `ToolWebDetail`.
- Details shows "used / window tokens", but `RunFact` `context` carries only counts.
- The client copy of `ResearchRunView` (`use-research-run.ts:58`) duplicates the server DTO
  (`run.ts:672`), and WS0 changes only the server one.

**Fix.**

1. Add `error.detail?` (one line, ≤ 300 chars) and `web.injection?: "suspicious" | "hostile"` to
   §2.4.
2. Add `tokensUsed?` and `contextWindow?` to `fact:context`.
3. Move the DTO into a client-safe `src/types/research.ts` in WS0, imported by both sides.

### 17. The Markdown image rule reaches the canvas and other unrelated surfaces (§6.4 item 3, §12.4 WS2)

13 files render `Markdown`, including:

- `canvas/canvas-panel.tsx` (DECISIONS U4: no canvas change);
- `share/shared-chat-transcript.tsx` and `shared-artifact-viewer.tsx`;
- `work-conversation.tsx`, `research/report-reader.tsx` and `compare-pane.tsx`.

The SPEC never says what an absent `allowedImageUrls` means. **Fix:** absent keeps today's
behaviour. Only `MessageItem` (WS9b) and the new report view (WS8) pass the set. A test pins both.

### 18. The composer can't call `chatToolEntitlements` (§3.6 vs §9.10)

§3.6 says the composer calls `chatToolEntitlements`. Its inputs are server facts the client does
not have:

- `sandboxConfigured`, `keyedSearchEngine`, `workspace`, `lockdown`, `approvalPolicy`;
- `saved` and `taskTool`.

§9.10 has the composer read `features.deepResearch` instead. **Fix:** the entitlement function
stays server-side. The composer reads `/api/app` features (`webSearch` as redefined in item 7, and
`deepResearch`). Remove "the composer" from §3.6.

### 19. The workstream worktrees need setup, and only WS0 has a "Done when" (§12.1, §12.3–§12.5)

HANDOFF.md explains the setup this worktree already has: symlinked `node_modules`, real `@prisma`
copies, and a built `runner/agent-core/dist` (typecheck needs it). A fresh worktree also needs the
i18n catalog generated first, because typecheck imports it (`deploy.yml`, "Generate the i18n
catalog"). §12.1 creates eight or more fresh worktrees and says none of this.

Only WS0 has a "Done when"; the wave-1 workstreams list deliverables with no acceptance line.

**Fix.**

1. Add `scripts/rework-worktree-setup.sh`, owned by WS0: symlinks, `prisma generate`, the runner
   build, and `i18n:extract`.
2. Give each workstream a "Done when" of its §13 tests plus the item 8 gate. Gallery checks
   happen only in Final.

---

## Minor

20. **§8.2: the chat header height.** The chat header is `h-14` only when it has a title and
    `h-11` otherwise (`chat-view.tsx:2020-2022`). The shell hardcodes `h-14` and `top-14`. Use a
    `--juno-chat-header-h` variable set by chat-view (WS9b).
21. **§9.13: printing.** Reuse the existing `data-print-document` pipeline (`globals.css:3719-3722`,
    `report-reader.tsx:230`). "URLs printed after links" needs global print CSS, which WS5 owns, so
    WS0 should land it.
22. **§9.9: `effort-copy.ts`.** The SPEC says it is "deleted (no web consumer)", but
    `composer.tsx:54` imports it. Delete it in WS9c, as §9.15 already says.
23. **§13.1 `web-extract`: timing.** The absolute limits (< 500 ms total, no slice > 50 ms) are
    flaky on shared runners. Measure `perf_hooks.monitorEventLoopDelay` p99 against a generous
    ceiling, and assert linear scaling across 1 MB, 2 MB and 4 MB inputs.
24. **§13.1 `research-api-compat`.** Test the exported zod schemas (`startResearchSchema`,
    `decidePlanSchema`) and `revise`/`finish`, not the route handlers, which need a session.
25. **§11.1 fixtures.** Each gallery needs a checked-in `de` fixture for its copy object
    (`RUN_COPY` in WS5, `PANEL_COPY` in WS6, `RESEARCH_COPY` in WS8). Say who writes each.
    `ALL_*_PHRASES` makes WS5's prefetch import WS6 and WS8 modules, so wire the prefetch in
    integration.
26. **§1.1 and HANDOFF: the Library bug.** DECISIONS §4 (the Library bug) already shipped in
    `7f92324f`. Say so in §1.1 so no workstream re-implements it; only the backfill (O-10) remains.
27. **§13 intro: `.tsx` tests.** `npm test` matches only `tests/*.test.ts`, so any JSX in tests
    must use `createElement`. A `.test.tsx` file would silently never run.
28. **§3.3 item 3: the approval-dispatch gate.** It must accept the port form from item 3, or it
    fails `action-approval-enforcement.test.ts:445`.
29. **§12.4 WS1: `CHAT_SKILL_TOOLS` values are stored.** Skill `requestedTools` stores values such
    as `browser_agent`, so the key rename is safe only with the alias read-path.
    `tests/assistants.test.ts:18` also stores `browser_agent` in `allowedTools`. Note it with the
    INV-23 readers.

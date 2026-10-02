# Gap audit: entitlements, metering and cost of the tool and Research rework

Written 2026-09-23 against branch `web/tools-thinking-research` (worktree `juno-tools`, base `d0997af2`).
Read-only audit. No secret was read: env keys were checked only through code paths, `.env.example`,
docs and commit history.

It answers four questions DECISIONS leaves open:

- **T3/T4** turn web search, fetch and code on by default for every tool-capable model. Who is
  entitled to which tool, in which mode?
- **T5** raises the round budget to 4/10/16/24. How is each tool call metered, and what does a turn
  now cost against the EUR budgets?
- **R1** sizes Research from the plan and the remaining budget. What are the inputs, and what may
  the R2 estimate line promise?
- What does production actually run?

Money conventions:

- The code keeps integer micro-USD (µUSD).
- Plan budgets are EUR and are converted by `eurPerUsd()` (`src/lib/spend.ts:68-78`). That factor
  defaults to 1 when `API_COST_EUR_PER_USD` is unset. Unless stated otherwise, every figure below
  uses the default, so € = $.
- If production sets the factor to 0.86, every plan budget in USD grows by 16%.

---

## 0. Summary

1. **The mid-stream budget guard cannot see tool costs.** It projects tokens only
   (`src/lib/chat-budget-guard.ts:83-93`). It checks only on text, reasoning and usage events
   (`route.ts:1178-1199`, `3017-3040`).
   - On the OpenAI-compatible, Responses and Gemini adapters, usage arrives once, after the whole
     tool loop (`openai-compat.ts:615-617`, `openai-responses.ts:500-502`, `gemini.ts:422-424`).
     During a tool loop the guard therefore sees only the first prompt. That covers the default
     model and most of the catalogue.
   - Search fees, sandbox time and connector fees never enter the projection.
   - Only Anthropic reports cumulative usage every round (`anthropic.ts:391`).
2. **Juno's search is billed at a flat $0.001 per query** (`research/domain.ts:1466`,
   `research/tools.ts:515`).
   - Every query fans out in parallel to every keyed engine (`search/search-engine.ts:927-950`).
   - At the 2026-09-23 list prices a query really costs:
     - $0.008 with Tavily only;
     - about $0.031 at chat size with all four keyed engines;
     - $0.048–$0.112 at Research sizes, because Exa bills per result and per page of text.
   - The ledger, the monthly meter and the platform daily ceiling therefore under-record search by
     8× to 100×.
3. **Gemini grounding is billed at $0.** `pricing.ts:435-436` calls it "token-only". Gemini 3.x
   grounding costs $14 per 1,000 queries once the 5,000 free queries a month (shared by the whole
   deployment) are used up.
4. **Research's USD $8 ceiling ignores the plan, the month and the usage windows**
   (`deep-research.ts:91-95`, `266`).
   - The PRO budget is €11 a month (`spend.ts:59-65`).
   - PRO's rolling windows are only **$2.57 a week and $2.50 per 5 hours**
     (`spend-ceiling.ts:455-491`).
   - One $8 run is therefore 73% of the PRO month and 3.1× the PRO weekly window. Chat admission
     refuses on the window (`route.ts:507-524`), so one run can lock a PRO user's chat for up to a
     week.
5. **`POST /api/research` takes the per-run ceiling from the client.** `budgetMicroUsd` may be
   `null` or any 15-digit number (`api/research/protocol.ts:53-57`). `null` means no ceiling at all
   (`engine.ts:3536`, `domain.ts:1743-1750`). The web UI never calls it, but any paid account can.
6. **Private chats get no Juno tool today.**
   - The private branch passes `connectors: []` and no `allowedTools`, so `llm.ts:178` falls back to
     `NO_RUNTIME_TOOLS`.
   - They get provider-native search only when toggled (`route.ts:939`).
   - T3's "always on" `current_time` and `calculate` have no path into private chats.
7. **Lockdown blocks every brokered tool, reads included** (`action-approval.ts:265`, and the
   settings copy at `connectors.tsx:339`). Native search and Research never touch the broker, so
   both keep reading the web under lockdown. Juno's `web_search`, `web_fetch` and `run_code` will
   be blocked, native search will not.
8. **Project workspaces have six closed tool keys** (`projects/workspace-config.ts:49-56`), mirrored
   in native Swift. None of them covers `web_fetch`, `run_code`, `search_chats`, `current_time`,
   `calculate` or `start_task`.
9. **Skill narrowing does not narrow native search.** `useWebSearch` goes to `streamChat` unfiltered
   (`route.ts:2957`). `CHAT_SKILL_TOOLS` has no code entry (`skills.ts:58-67`).
10. **FREE is offered `start_task`, but every run is refused.** The Work admission hold is $0.25
    (`spend-ceiling.ts:147`, `work/store.ts:355-372`). The whole FREE month is €0.15
    (`spend.ts:60`).
11. **Cost of the rework.** On the default model, Qwen 3.8 Flash, a light web turn goes from about
    $0.002 without tools to $0.010 with Tavily, or $0.033 with all four engines. Search fees are
    most of that.
    - On frontier models, tokens dominate: a typical cached web turn costs $0.09–$0.22.
    - A budget-exhausting turn costs, cached:

      | Round budget | GPT-5.5 or Opus 5.5 |
      |---|---|
      | 16 | $1.5–$2.1 |
      | 24 | $3.1–$4.4 |

      That is more than PRO's whole weekly window, and the turn's reservation holds only $0.05
      (`spend-ceiling.ts:146`).
12. **Production search roster: probably Tavily, possibly Serper.** No self-hosted SearXNG.
    - The keyless engines run on every query: three public SearXNG instances, scraped DuckDuckGo and
      Wikipedia (`search-engine.ts:596-607`, `775-777`).
    - None of them is disclosed in `docs/SUBPROCESSORS.md:64`, which names Tavily alone.
    - The code sandbox is probably not configured (`docs/file-understanding.md:787`).

---

## 1. Entitlement inputs as they are today

### 1.1 Plans (`src/lib/plans.ts`)

| Plan | Price | Messages | `webSearch` | `voice` | `canvas` | Max output | Budget (`spend.ts:59-65`) |
|---|---|---|---|---|---|---|---|
| FREE | €0 | 15 / month (`plans.ts:51`) | **false** (`:56`) | false | true | 8,192 | €0.15 |
| PRO | €20 | unlimited | true (`:80`) | true | true | 200k | €11 |
| MAX ("Max ×5") | €100 | unlimited | true (`:105`) | true | true | 200k | €55 |
| MAX20 ("Max ×10") | €200 | unlimited | true (`:132`) | true | true | 200k | €110 |
| OWNER (not sold) | — | unlimited | true (`:154`) | true | true | 200k | `null` → **€15 personal default** (`spend-ceiling.ts:29`, `85-96`) unless `spendCapDisabled` |

- `PLANS[plan].webSearch` is the **only** entitlement check for both web search and Research
  (`route.ts:2095`, `2099`; `api/research/route.ts:51-56`).
- No plan flag exists for code, connectors, tasks or research depth.
- The model catalogue sets the model floor per plan. FREE has 53 models (`models.ts`, `minPlan: "FREE"`),
  including Sonnet 5, Haiku 4.5, Gemini 3.x Flash, GPT-6 Luna, Grok 4.1 Fast and the default
  `qwen:qwen3.8-flash` (`models.ts:885`).

### 1.2 Budgets, windows and holds

- **Monthly budget.** `checkBudget` (`spend.ts:594-657`) computes:
  - the effective ceiling, which is the lower of the plan figure and the user's own cap
    (`spend-ceiling.ts:75-103`);
  - minus settled `ApiSpend` since the start of the billing period (`spend.ts:418-424`);
  - minus open reservations.
- **Windows.** `checkUsageWindows` (`spend.ts:1224-1284`) slices the month
  (`spend-ceiling.ts:455-491`):
  - weekly = max(month × 7/30, floor), where the floor is min(month, $2.50)
    (`spend-ceiling.ts:412`, `468`);
  - 5-hour = min(weekly, max(weekly × 0.5, floor)).
  - Chat admission refuses on either window (`route.ts:507-524`, `1405`).

| Plan | Month | Weekly window | 5-hour window |
|---|---|---|---|
| FREE | $0.15 | $0.15 | $0.15 |
| PRO | $11.00 | **$2.57** | **$2.50** |
| MAX | $55.00 | $12.83 | $6.42 |
| MAX20 | $110.00 | $25.67 | $12.83 |
| OWNER (default cap) | $15.00 | $3.50 | $2.50 |

- **Holds.** Each unit of work reserves an estimate before it runs (`reserveSpend`,
  `spend.ts:777-906`). The defaults are:
  - chat: $0.05;
  - work: $0.25;
  - research: $0.30 (`spend-ceiling.ts:145-161`).
- Only chat (`route.ts:1011`, `2324`) and Work (`work/store.ts:355`) ever reserve. The per-unit
  research ceiling of $1 (`spend-ceiling.ts:181-183`) is **dead code**: nothing reserves under
  `kind: "research"`.

### 1.3 Feature flags

- `features.deepResearch = isWebSearchConfigured()` (`app-data.ts:192`; type at `types/app.ts:140-141`).
- `features.webSearch = configuredProviders().some(providerSupportsWebSearch)` (`app-data.ts:191`).
- **Neither flag is read anywhere in `src/components` or `src/hooks`.**
- `isWebSearchConfigured()` is always true, because `isSearchEngineAvailable()` returns `true`
  (`search/search-engine.ts:819-821`, `web-search.ts:11-13`). So the "Deep research is not
  configured" branch at `route.ts:2843-2849` cannot be reached.
- The composer shows the Research chip on **every** plan (`composer.tsx:764`,
  `researchAvailable = !privateMode && modality === "chat"`).
- A FREE user who arms Research spends one of their 15 messages (`route.ts:1833`) and then gets the
  "paid plans" notice (`route.ts:2843-2853`).

### 1.4 Modes and restrictions

- **Private chat** (`route.ts:923-1260`):
  - native search only, when toggled (`:939`);
  - no canvas, no memory;
  - no connectors (`:918-921`, `1086-1100`);
  - no attachments (`chat/entitlements.ts:28-41`);
  - no Research: the client never sends it (`use-chat.ts:1307`, `composer.tsx:764`), and the
    server's private branch has no research code;
  - no `allowedTools`, so no runtime tools (`llm.ts:178`).
- **Lockdown.**
  - `decideActionPolicy` returns `block` before the "read is allowed" rule
    (`action-approval.ts:258-266`).
  - The setting reads "Refuse every action, reading included…" (`components/settings/sections/connectors.tsx:339`).
  - It also turns off `start_task` (`route.ts:2245`, `task-tool.ts:172`) and the tool detail stream
    (`route.ts:734`).
  - It does **not** gate native search (`route.ts:2099`) or Research (`route.ts:2093-2095`).
- **Voice** (`voiceMode` on `/api/chat`):
  - off: Research (`route.ts:2093`), canvas (`:2110`) and `start_task` (`task-tool.ts:162`);
  - native search is **not** gated;
  - connectors are hidden only on the client (`composer.tsx:722`).
  - The realtime relay has no tools (`relay/src`).
- **Project workspace.**
  - `workspacePermits(config, tool)` (`workspace-config.ts:204-214`): no list means everything is
    inherited; `[]` means nothing.
  - The keys are `webSearch`, `deepResearch`, `canvas`, `mediaGeneration`, `connectors` and
    `memoryRecall` (`workspace-config.ts:49-56`). Their labels are in
    `app/(app)/projects/[id]/page.tsx:110-117`.
  - Connectors are also filtered by `allowedConnectorIds` (`route.ts:912-917`).
- **Skills.**
  - `narrowRuntimeToolsForSkill` filters only the runtime allowlist (`skills.ts:314-325`,
    `route.ts:2970-2975`), plus `start_task` (`route.ts:2244`).
  - The grant layer names `web_search`, `browser_agent`, `read_document`, `inspect_image` and
    `canvas` (`skills.ts:58-67`, `108-122`). Code is not among them.

---

## 2. Gating matrix

"Today → T3" in each cell. **U-n** marks a cell DECISIONS leaves undecided; they are listed after the
tables.

### 2.1 By plan

| Tool | FREE | PRO | Max ×5, Max ×10 | OWNER |
|---|---|---|---|---|
| `web_search` (Juno engine) | Off → Off under T4 ("when the plan allows it"). **U1** | Not a chat tool; the engine serves Research only → on by default when the model has no native search | Same as PRO | Same as PRO; budget is the €15 personal default |
| Native search | Off (`plans.ts:56`) → Off. **U1** | On only if the toggle is sent (`route.ts:2099`) → on by default (T4) | Same as PRO | Same as PRO |
| `web_fetch` | None: `browser_agent` rides native search only → **U2**. T3 ties it to "web on", but a fetch of a pasted URL is cheap (§4) | `browser_agent` on native-search models only, and it dies at approval (C1) → on with web, provenance-restricted | Same as PRO | Same as PRO |
| `read_document` | On with a FILE attachment (`route.ts:2066`), but dies at approval (C1) → works (RC-1) | Same as FREE | Same as FREE | Same as FREE |
| `inspect_image` | Vision model plus image or PDF (`route.ts:2073-2077`), dies at approval → works | Same as FREE | Same as FREE | Same as FREE |
| `run_code` | Only with a sandbox and an attachment (`route.ts:2072`); probably not configured in production → "plan allows it" is undefined. **U3** | → **U3** | → **U3** | → **U3** |
| `search_chats` | Does not exist → saved, non-private turns; plan unspecified. **U4** | Same | Same | Same |
| `current_time`, `calculate` | Do not exist → always on tool-capable models | Same | Same | Same |
| `start_task` | Offered when FREE has a Work-capable model, but the $0.25 hold exceeds the €0.15 month, so it is **always refused** → **U5** | As today (`task-tool.ts:158-175`) | As today | As today |
| `suggest_research` | Does not exist → off (Research not entitled). **U6** | → on with web, when Research is entitled and not armed | Same as PRO | Same as PRO |
| MCP connectors | No plan gate (`route.ts:912-921`) → as today. **U7** | As today | As today | As today |
| Research | Refused after one message is consumed (`route.ts:1833`, `2843-2853`) → **U6** | $8 flat, no budget or window check → `researchBudgetFor(scope, plan, remaining)` (R1); per-plan values **U13** | Same as PRO | $8 against the €15 default → same function |

### 2.2 By mode and restriction

| Tool | Private chat | Lockdown | Voice | Project workspace | Skill | Model capability |
|---|---|---|---|---|---|---|
| `web_search` (Juno) | No runtime tools (`llm.ts:178`, `route.ts:1163`). **U8** | Blocked if brokered (`action-approval.ts:265`). **U9** | Not excluded (no voice test at `route.ts:2099`). **U10** | `webSearch` key (`route.ts:2100`) | Narrowed, as a registry tool | Tool-capable models without native search. Gemini ≤2.5 with grounding drops function tools (`gemini-core.ts:379`, per the tools audit) |
| Native search | **Yes** when toggled (`route.ts:939`), with no workspace test (a private chat has no project) | **Not affected**: never brokered. **U9** | Yes | `webSearch` key | **Not narrowed** (`route.ts:2957`). **U11** | anthropic, google, xai (`models.ts:205`). The OpenAI Responses hosted tool is not wired (T3 "where supported") |
| `web_fetch` | **U8** | Blocked. **U9** | **U10** | No key of its own; `webSearch`? **U12** | Narrowed | All tool-capable models. Juno's fetch or Anthropic's native `web_fetch` on Claude? **U2** |
| `read_document` | No: no attachments in private (`entitlements.ts:28-41`) | Blocked ("reading included") | Yes with attachments | No key | Narrowed | All adapters |
| `inspect_image` | No | Blocked | Yes with attachments | No key | Narrowed | Vision models |
| `run_code` | **U8** | Blocked (`destructive_or_sensitive`, `agent/code.ts:109`) | **U10** | No key. **U12** | **Dropped by any skill that lists tools**, because `CHAT_SKILL_TOOLS` has no code entry (`skills.ts:58-67`) | All adapters; images need vision |
| `search_chats` | No (T3) | **U9** | **U10** | `memoryRecall`? Project-scoped or account-wide? **U12** | Needs a skill id | Tool-capable |
| `current_time`, `calculate` | "Always" conflicts with private having no tool path. **U8** | Pure functions, but the broker blocks everything. **U9** | Presumably yes | None | Can a skill remove them? **U11** | Tool-capable |
| `start_task` | No (`task-tool.ts:161`) | No (`:172`) | No (`:162`) | No key | Narrowed (`route.ts:2244`) | `agenticTools` and function tools reaching the model (`route.ts:2238-2243`) |
| `suggest_research` | No: Research is unavailable in private | **U9** | No: Research is off in voice (`route.ts:2093`) | `deepResearch` key | **U11** | Function tools |
| MCP connectors | No (`route.ts:918-921`) | Blocked | Hidden by the client (`composer.tsx:722`); the server has no voice test | `connectors` key and `allowedConnectorIds` (`route.ts:912-917`) | Narrowed through the grant layer (`skills.ts:118`) | All adapters; Gemini ≤2.5 with search drops them |
| Research | No | **Not affected**: its search and fetch bypass the broker. **U9** | No (`route.ts:2093`) | `deepResearch` key (`route.ts:2094`) | Not affected | Independent of the chat model: worker and lead are chosen by Research (`research/agents/worker.ts:84`, `140`) |

### 2.3 Undecided cells

- **U1. FREE web.** Does FREE get search at all, native or Juno's? `PLANS.FREE.webSearch` is false.
  A typical web turn on the default model costs $0.012–$0.035 (§5), and FREE has €0.15 and 15
  messages a month.
- **U2. `web_fetch` without web, and native fetch.**
  - Does `web_fetch` exist when web is off, for example on FREE or when the toggle is off, for a
    URL the user pasted? Claude and ChatGPT fetch pasted URLs on their free tiers.
  - On Claude models, is Juno's fetch used, or Anthropic's native `web_fetch`? The native tool is
    free apart from tokens.
- **U3. `run_code`.** Which plans does "plan allows it" mean? The same applies to "a remote sandbox
  is configured": is one provisioned in production?
- **U4. `search_chats`.** Which plans get it, and does it reach archived chats and other projects?
- **U5. FREE and `start_task`.** Offer it to FREE, or hide it? Today it is offered and always refused.
- **U6. FREE and Research.** None, a quota such as ChatGPT's "5 lightweight a month", or a teaser?
  Should the Research chip stay visible to FREE?
- **U7. FREE and connectors.** Should FREE keep MCP connectors, given no plan gate exists today?
- **U8. Private chats.** Which tools do private chats get?
  - The architecture has none: `streamChat` refuses tools without an audit identity.
  - Web search and fetch send the query to third parties, as native search already does.
  - `current_time` and `calculate` leave no trace.
  - `run_code` sends user text to a sandbox vendor.
- **U9. Lockdown.** Does it cover the reads that are not app actions: web (native and Juno), Research,
  `current_time`, `calculate`, `search_chats`, and reading one's own attachments? Today it blocks
  brokered reads but not native search or Research.
- **U10. Voice.** Does voice get the T5 round budget, `web_fetch` and `run_code`? Latency and cost
  both rise.
- **U11. Skills.** Should a skill that lists tools also narrow native search, `current_time`,
  `calculate` and `suggest_research`?
- **U12. Workspace keys.** Which key governs `web_fetch`, `run_code`, `search_chats`, `start_task`
  and the pure tools? A new key is a native contract change (`workspace-config.ts:42-48`, mirrored
  in `ProjectWorkspaceStore.swift`).
- **U13. Research by plan.** Per-plan caps: see §6.5.

---

## 3. Metering matrix

### 3.1 How each tool is billed

Vendor prices are list prices, read 2026-09-23 (sources in §4.3).

| Tool | Vendor cost per call | Billed today | `ApiSpend` kind / model today | Proposal | Guard sees it today |
|---|---|---|---|---|---|
| Anthropic native `web_search` | $10 / 1k, plus result tokens as input | Tokens plus `webSearchRequests` × $0.01 (`pricing.ts:449-452`) | `chat` / chat model | Keep. Price the running count in the guard | Tokens yes (per-round usage, `anthropic.ts:391`); fee **no** |
| Gemini grounding | Gemini 3.x: 5,000 free a month per project, then **$14 / 1k**. 2.5: 1,500 free a day, then $35 / 1k prompts | **$0** ("token-only", `pricing.ts:435-436`) | `chat` / chat model | Count `groundingMetadata.webSearchQueries`; add a `google` case to `toolFeesUsd`; bill or absorb (Q20) | No: usage only at the end of the turn (`gemini.ts:422-424`) |
| xAI Live Search | $5 / 1k (Juno's figure; possibly deprecated, per the tools audit) | ceil(citations / 10) × $0.005 (`openai-compat.ts:611-613`) | `chat` | Check that it still exists | No (end of turn) |
| OpenAI Responses hosted search | $10 / 1k calls plus content tokens (reasoning models); $25 / 1k non-reasoning | Not wired (`openai-responses.ts:198` ignores `_webSearch`) | — | If wired, count `web_search_call` items | No |
| Juno `web_search` in chat (T3) | Sum over keyed engines at 10 results each: Tavily $0.008 + Serper $0.001 + Brave $0.005 + Exa $0.017 (search $0.007 + text $0.010) = **$0.008–$0.031** | Not a chat tool yet | — | Price each engine that ran, from a roster table (§3.3). Write it as its own row per turn. Feed the guard | No |
| Juno search in Research | Same engines at 18–50 results each (`perEngineCount`, `search-engine.ts:905-907`): Exa $0.033–$0.097, so **$0.048–$0.112** with all four | **Flat $0.001** (`research/tools.ts:515`, `domain.ts:1466`) | `research` / `deep-search` (`research/run.ts:526-533`) | Same roster price table | n/a (Research uses its own `affordable()`) |
| `web_fetch` / page fetch | No vendor. Juno's own HTTP fetch; the Research crawler may render headless (CPU) | Chat: `browser_agent` unmetered. Research: flat $0.0005 (`domain.ts:1468`) | `research` / `deep-search` | Chat: tokens only (≈4k tokens per 16k-char page). Keep a small infra fee only if the owner wants a margin | Only through tokens, and on non-Anthropic adapters only at the end of the turn |
| `read_document`, `inspect_image` | None (local parse and render) | Tokens | `chat` | As today | Same as `web_fetch` |
| `run_code` | E2B: $0.000014 per vCPU-second + $0.0000045 per GiB-second. At 2 vCPU and 4 GiB that is ≈$0.17 an hour, **≤$0.0055 per 120 s call**, plus a $150 a month Pro plan. OpenAI containers: $0.03 per 20 min at 1 GB | **Unmetered** (`agent/code.ts` never calls `recordSpend`) | — | `durationMs` × rate from the runner response (`code-interpreter.ts:245-260`), as a `juno:run_code` row | No |
| `search_chats` | None (Postgres and decryption) | — | — | Tokens only | Tokens |
| `current_time`, `calculate` | None | — | — | None | — |
| `start_task` | Work model tokens | `recordWorkRunSpend`, as deltas (`spend.ts:334`) | `work` | As today; $0.25 hold; bounded by the window (`work/budget.ts:73-87`) | Separate run, bounded by the window |
| `suggest_research` | None (a chip) | — | — | — | — |
| MCP connectors | Composio: 100k calls a month free, then Scale at $29 + $0.0003 a call. GitHub, Notion and Figma MCP are free | Tokens; `ToolInvocation` audit row (`mcp.ts:425-435`) | `chat` | Absorb the Composio fee (<$0.01 per 30 calls) | Tokens |
| Research model stages | Tokens | clarify, brief, plan, expand, writer as **`chat`** (`research/tools.ts:260-270`, `719-729`). Workers and lead as `research` (`worker.ts:223-231`, `lead.ts:249-259`). Judge through `runUtilityPrompt` (`utility`). Preflight not billed (B27) | Mixed | All under `research`, with the `runId` in an idempotency key | Not by the chat guard |

### 3.2 Can the per-turn budget guard see tool costs? No

There are six reasons:

1. **Tokens only.** `projected = fresh × input + cached × cacheRead + out × output`
   (`chat-budget-guard.ts:83-93`). There is no term for search fees, sandbox time or connector fees.
   Native search counts (`webSearchRequests`) reach the accumulator but are priced only at the end of
   the turn, in `recordSpend` (`spend.ts:226-241`).
2. **Blind during the loop on three of four adapters.**
   - `openai-compat`, `openai-responses` and `gemini` add up usage per round but yield **one** usage
     event after the loop (`openai-compat.ts:543-546`, `615-617`; `openai-responses.ts:500-502`;
     `gemini.ts:422-424`).
   - Until then the guard uses `inputChars` from the **initial** system prompt and history
     (`route.ts:2859-2864`).
   - Each round re-sends a conversation that grows with every tool result, so a 24-round turn's input
     can be 20× or more what the guard projects.
   - Only Anthropic yields cumulative usage every round (`anthropic.ts:377-400`).
3. **No check while tools run.** `enforce()` is called on text, reasoning and usage effects only
   (`route.ts:1178-1199`, `3017-3040`), not on `tool_call` or `tool_result`. It is not called before
   a round is dispatched either.
4. **The wrong ceiling.** It is `budget.remainingMicroUsd`, the monthly remainder (`route.ts:2862`),
   not the binding window. A turn can overdraw PRO's $2.50 window by its full cost.
5. **Research during the same turn is not netted.**
   - `budget` is read before `runDeepResearch` (`route.ts:1405` against `2793-2816`).
   - Research spend lands in `ApiSpend` during the turn, but the guard's ceiling is never lowered
     (`enforceStreamBudget` is also switched off while a Research notice streams, `route.ts:2879`).
6. **The hold is flat.** Every chat turn reserves $0.05 (`spend-ceiling.ts:146`) whatever the effort
   and the model. The tail of a max-effort turn can cost 80× that (§5).

### 3.3 Metering proposal

1. **A roster price table** beside `ENGINES` (`search-engine.ts:765-778`):
   `priceMicroUsd(engine, perEngineCount)`.
   - Tavily 8,000 (basic).
   - Serper 1,000 up to 10 results, 2,000 above.
   - Brave 5,000.
   - Exa 7,000 + 1,000 × max(0, n − 10) + (contents ? 1,000 × n : 0).
   - Keyless engines 0.
   - Bill only the engines that returned `ok` or `empty`. Errors are not billed by Tavily or Anthropic
     (per Anthropic's web search docs); check the others.
   - `searchWithEngineReport` returns `costMicroUsd`, and Research's `searchTheWeb` uses it instead of
     `SEARCH_FEE_MICRO_USD`.
2. **A per-turn tool ledger.** A `ToolFeeAccumulator` in the chat route:
   - each Juno tool reports `costMicroUsd`;
   - native search counts are priced with `toolFeesUsd`;
   - one extra `ApiSpend` row per turn, `kind: "chat"`, `model: "juno-tools"`, written **before** the
     token row that carries `ref`, so the reservation settles once.
   - Do **not** pass Juno fees as `toolFeesUsd`: that field *overrides* the provider fee rather than
     adding to it (`pricing.ts:442-444`). A new `SpendKind` such as `"tool"` is the alternative (Q17).
3. **Guard.**
   - Add `extraCostMicroUsd: () => number`, fed by the accumulator and the running native search count.
   - Call `enforce()` on `tool_call` and `tool_result`, and before dispatching each round, with that
     round's estimated fees.
   - Pass per-round cumulative usage from every adapter, as Anthropic does.
   - Set the ceiling to min(month remaining, binding window remaining).
4. **Hold by effort.** Replace the flat $0.05 chat hold with an estimate from the model's rates and the
   T5 budget, for example (P0 + rounds × 5k tokens) × input rate, capped at the window.

---

## 4. Production search roster

### 4.1 Evidence

| Key | Evidence | Likelihood |
|---|---|---|
| `TAVILY_API_KEY` | `deploy/ecosystem.config.js:31-33` (commit `badf9f63`, 2026-07-31) lists `TAVILY_API_KEY` among "every provider key Juno holds" that the relay used to receive from the production `.env`. `docs/JUNO.md:734` and `:2630` name it as *the* web search and Research key. `docs/SUBPROCESSORS.md:64` lists Tavily as the only search subprocessor | **Very likely set** |
| `SERPER_API_KEY` | The only worked example in `scripts/set-env-key.sh:5-6` (added 2026-08-15 with `npm run search:check`, commit `dce01732`) | Possible |
| `BRAVE_SEARCH_API_KEY` / `BRAVE_API_KEY`, `EXA_API_KEY` | Documented in `.env.example:243-246` only | No evidence |
| `SEARXNG_URL` | Nothing in `deploy/` provisions a SearXNG container | Probably unset. The public instances (`searx.be`, `search.sapti.me`, `priv.au`, `search-engine.ts:596-607`) are therefore tried on every query |
| DuckDuckGo (scraped), Wikipedia | `available: () => true` (`search-engine.ts:775-777`) | **Always run** |
| `CODE_INTERPRETER_URL` / `_TOKEN` | "No remote sandbox configured — `code_interpreter` is inert" (`docs/file-understanding.md:787`, published 2026-09-22). The endpoint is a custom `/execute` contract (`code-interpreter.ts:210-230`), so an E2B key alone is not enough | **Probably unset** |
| `API_COST_EUR_PER_USD`, `PLATFORM_DAILY_BUDGET_USD`, `RESEARCH_CHAT_BUDGET_USD` | Documented in `.env.example:129`, `:137`, `:265`. No evidence either way | Unknown |

The source of truth is the GitHub `PROD_ENV` secret (`.github/workflows/deploy.yml:497-506`), which
this audit cannot and should not read. The deploy gate requires only core keys (`deploy.yml:521`).
`check-provider-keys.ts` does not check search keys.

### 4.2 How the owner can confirm without exposing a secret

- On the VM, run `npm run search:check` (`scripts/check-search-providers.ts:40-56`). It prints
  "configured" or "not set" per engine and each engine's live status. It spends one query per
  engine.
- Or, read-only in SQL:
  `SELECT payload->'engines' FROM "ResearchEvent" WHERE kind = 'query_issued' ORDER BY "createdAt" DESC LIMIT 20;`
  `query_issued` carries the engine roster with its status (`research/engine.ts:2515-2517`).
- To reconcile, compare the Tavily dashboard's credit use for a month against the number of
  `ApiSpend` rows with `model = 'deep-search'`.

### 4.3 Vendor list prices (read 2026-09-23)

| Vendor | Price | Source |
|---|---|---|
| Tavily | $0.008 a credit, pay as you go. Basic search 1 credit, advanced 2. Extract: 1 credit per 5 URLs (basic). 1,000 free credits a month | tavily.com/pricing; docs.tavily.com/documentation/api-credits |
| Serper | 2,500 free queries. Packs from $50 for 50k ($1.00 per 1k) down to $0.30 per 1k. 2 credits above 10 results | serper.dev (home page); pack prices from secondary sources, because the official pricing page did not load |
| Brave Search API | $5 per 1k requests; $5 of free credit a month; 50 queries a second | brave.com/search/api |
| Exa | Search $7 per 1k (up to 10 results) + $1 per 1k extra results. Contents $1 per 1k pages per content type. $10 a month free | exa.ai/pricing |
| Anthropic | Web search $10 per 1k plus tokens. Web fetch free apart from tokens. Sonnet 5 stays at **$2/$10** (the planned rise to $3/$15 was cancelled) | platform.claude.com pricing, web-search and web-fetch docs |
| OpenAI | Web search $10 per 1k calls plus content tokens (reasoning models); $25 per 1k non-reasoning. Containers $0.03 per 20 min (1 GB) | developers.openai.com/api/docs/pricing |
| Google | Gemini 3.x grounding: 5,000 a month free, then $14 per 1k. 2.5: 1,500 a day free, then $35 per 1k | ai.google.dev/gemini-api/docs/pricing |
| E2B | $0.000014 per vCPU-second, $0.0000045 per GiB-second; Pro plan $150 a month | e2b.dev/pricing |
| Composio | Free: 100k calls a month. Scale: $29 + $0.0003 a call | composio.dev/pricing |

Stale comments in the code:

- `model-metrics.ts:64` and `pricing.ts:144` still say Sonnet 5 goes to "$3/$15 from Sep 1 2026".
  The prices in the code ($2/$10) are correct.
- `pricing.ts:435-436` says Google grounding is token-only. That is out of date.

### 4.4 Cost of one Juno `web_search` call by roster

Chat asks for 6 results, so each engine is asked for 10 (`web-search.ts:15-18`,
`search-engine.ts:905-907`).

| Roster | Chat call | Research call, 24 results (36 per engine) | Research call, 32 results (48 per engine) |
|---|---|---|---|
| Keyless only | $0 | $0 | $0 |
| Tavily only | $0.008 | $0.008 | $0.008 |
| Tavily + Serper | $0.009 | $0.010 | $0.010 |
| All four keyed | $0.031 | $0.084 | $0.108 |

Waste to remove:

- Chat pays for Tavily's `raw_content` and Exa's full text, then drops both. `web-search.ts:19-23`
  keeps only the title, URL and snippet.
- Exa's text is 60% of its chat-size price and 50% of its Research-size price.

---

## 5. Cost model

### 5.1 Assumptions

- The turn starts with a system prompt and history of 8,000 tokens (P0). The system prompt source is
  about 25k characters (`chat/system-prompt.ts`).
- A Juno search result block adds 1,200 tokens (6 hits, enveloped).
- `web_fetch` adds 4,000 tokens (the 16,000-character cap, `search-engine.ts:252`).
- An Anthropic native search adds 5,000 tokens: its results are billed as input and re-sent.
- Each tool round writes 150 output tokens. The final answer is 900 tokens.
- Reasoning per round is 200, 600, 1,500 or 3,000 tokens at effort budgets 4, 10, 16 and 24.
- Each round re-sends the whole conversation.
- "Cached" means the prefix that is re-sent is read from cache at the provider's rate: 0.1×, or 0.05×
  on Opus 5.5. Cache writes are not modelled. The adapters do set cache breakpoints (`anthropic.ts:232-271`,
  `openai-compat.ts:441-447`).
- Search fees:
  - Juno: Tavily $0.008 or all four $0.031;
  - Anthropic: $0.010;
  - Gemini: $0.014, after the free quota.

Rates:

| Model | Input / output per MTok |
|---|---|
| Qwen 3.8 Flash (default) | $0.14 / $0.42 |
| GPT-6 Luna | $0.10 / $0.50 |
| GPT-5.6 Luna | $0.20 / $1.20 |
| Gemini 3.8 Flash | $0.75 / $3.75 |
| Sonnet 5 | $2 / $10 |
| GPT-5.5 | $5 / $30 |
| Opus 5.5 | $4 / $20 |

### 5.2 Per turn at the default effort (10 rounds available)

Cached, with uncached in brackets.

| Model (plan floor) | No web (today on most models) | Light: 1 search, then answer | Typical: 1 search, then 2 fetches, then answer | Heavy: 2 searches, 3 fetches, 3 rounds |
|---|---|---|---|---|
| Qwen 3.8 Flash, Juno search, Tavily (FREE) | $0.002 | $0.010 | $0.012 | $0.022 |
| Qwen 3.8 Flash, Juno search, all four | $0.002 | $0.033 | $0.035 | $0.068 |
| GPT-5.6 Luna, Juno search, Tavily / all four (FREE) | $0.003 | $0.013 / $0.036 | $0.015 / $0.038 | $0.026 / $0.072 |
| Gemini 3.8 Flash, native (FREE) | $0.012 | $0.029 | $0.039 | $0.060 |
| Sonnet 5, native (FREE) | $0.031 | $0.060 ($0.075) | $0.087 ($0.125) | $0.129 ($0.223) |
| Sonnet 5, Juno search, Tavily | — | $0.051 | $0.076 | $0.107 |
| GPT-5.5, Juno search, Tavily / all four (PRO) | $0.085 | $0.126 / $0.149 | $0.194 / $0.217 ($0.272 / $0.295) | $0.261 / $0.307 |
| Opus 5.5, native (PRO) | $0.062 | $0.109 | $0.159 ($0.240) | $0.227 ($0.427) |

**Reading:**

- On cheap models, Juno's search fee is most of the turn. On the default model, all four engines cost
  about 3× Tavily alone.
- On frontier models, tokens dominate and the roster is noise.

### 5.3 Turns that exhaust the T5 budget

The turn uses R − 1 tool rounds, each with 1 search and 1 fetch, then one final round with tools off.

| Budget (effort) | Qwen default, Tavily / all four | Gemini 3.8 Flash, native | Sonnet 5, native | GPT-5.5, Tavily / all four | Opus 5.5, native | Input tokens sent |
|---|---|---|---|---|---|---|
| 4 (low) | $0.03 / $0.10 | $0.07 | $0.13 | $0.23 / $0.30 | $0.23 | 64k–87k |
| 10 (default) | $0.09 / $0.30 | $0.21 | $0.43 | $0.73 / $0.94 | $0.70 | 267k–492k |
| 16 (high) | $0.16 / $0.51 | $0.41 | $0.93 | $1.72 / $2.06 | $1.49 | 626k–1.2M |
| 24 (max) | $0.28 / $0.81 | $0.78 | $1.93 | $3.90 / $4.43 | $3.13 | 1.3M–2.7M |

All figures are cached. Uncached, the 24-round frontier turns reach $6.4–$12.6. Search fees alone for
24 rounds are $0.18 (Tavily), $0.71 (all four), $0.23 (Anthropic) or $0.32 (Gemini).

### 5.4 Effect on each plan's EUR budget

Number of typical cached web turns (§5.2) before each limit.

| Plan and limit | Qwen default, Tavily / all four | Sonnet 5, native | GPT-5.5, all four | Opus 5.5, native | Before the rework (no web on Qwen or GPT; Sonnet and Opus with native search off) |
|---|---|---|---|---|---|
| FREE, €0.15 a month (the window is the month) | 12 / 4 | 1.7 | not in plan | not in plan | 83 on Qwen (the 15-message cap binds) |
| PRO, €2.57 a week | 214 / 73 | 29 | 11.8 | 16 | 1,400 / 83 / 30 / 41 |
| PRO, €11 a month | 917 / 314 | 126 | 51 | 69 | — |
| Max ×5, €12.83 a week | 1,069 / 367 | 147 | 59 | 81 | — |
| Max ×10, €25.67 a week | 2,139 / 733 | 295 | 118 | 161 | — |

**Consequences:**

1. **FREE.**
   - Web on the default model with Tavily costs about $0.18 over 15 messages, which is more than the
     whole €0.15 trial.
   - One typical Sonnet 5 web turn is 58% of the trial.
   - If FREE gets web (U1), either raise `BUDGET_EUR.FREE` or allow Tavily search on cheap models only.
2. **PRO.** Frontier web turns cost 2.5–4× a turn without web.
   - About 12 GPT-5.5 web turns fill the week.
   - **One effort-24 GPT-5.5 or Opus turn ($3.1–$4.4) exceeds PRO's weekly window.** One effort-16
     turn uses 60–80% of it.
   - The guard's ceiling is the month (§3.2), so that turn completes, and chat is then refused until
     the window resets.
   - Cap rounds by plan and by the remaining window (Q19).
3. **The platform bill.** Search fees missing from the ledger are also invisible to
   `PLATFORM_DAILY_BUDGET_USD` (`platform-budget.ts:72-82`, which sums `ApiSpend`). Gemini grounding
   beyond 5,000 queries a month is absorbed entirely by the platform.

---

## 6. Research envelope

### 6.1 How the remaining budget can be computed today

| What | Function | Returns | Notes for a background run |
|---|---|---|---|
| Month | `checkBudget(userId, plan, period?, budget?)` (`spend.ts:594-657`) | `remainingMicroUsd` = ceiling − settled spend − open holds; `null` when the cap is disabled; `resetsAtMs` | Called with `reap: false` it avoids the sweep. Cached per request, so a worker process must call it fresh |
| Window | `checkUsageWindows(userId, plan, period?, budget?, { pendingMicroUsd, ignoreReservationRef })` (`spend.ts:1224-1284`) | The binding window's `remainingMicroUsd`, `bound` and `resetsAtMs` | Work re-reads it on every poll (`work/budget.ts:40-48`). Research should do the same at round boundaries, passing its own unbilled worker cost as `pendingMicroUsd` (workers bill when they finish, `worker.ts:217-231`) |
| O(1) alternative | The `SpendPeriod` row (committed + reserved) | The same month figure, without aggregating `ApiSpend` | Kept in step by `recordSpend` and `reserveSpend` |

**Neither function is called anywhere in the Research code** (grep of `src/lib/research`,
`deep-research.ts` and `api/research`). This is bug B16.

### 6.2 The USD/EUR mismatch

- **The ceiling.** `CHAT_RUN_BUDGET_MICRO_USD` is USD: $8 by default, clamped to $40, from
  `RESEARCH_CHAT_BUDGET_USD` (`deep-research.ts:91-95`). It is used at `:266`, with `"deep"` as the
  default tier at `:267`.
- **The budgets** are EUR (`spend.ts:59-65`), converted by `eurPerUsd` (`spend.ts:74-78`).

$8 as a share of each plan's budget:

| Plan | At eurPerUsd = 1 | At 0.86 |
|---|---|---|
| PRO (month) | 72.7% | 62.5% |
| PRO (weekly window) | **311%** | — |
| PRO (5-hour window) | **320%** | — |
| MAX (month) | 14.5% | — |
| MAX20 (month) | 7.3% | — |
| OWNER (€15 default) | 53% | — |

- **The UI mixes currencies.**
  - The Research gate says "Stops at $8.00" (`run-controls.tsx:472`, through `formatMicroUsd` at
    `run-format.ts:15-19`).
  - The console says "$x of $8.00" (`research-console.tsx:153`).
  - Settings shows "€X left of €11" (`billing.tsx:92-93`, `191-192`).
- **The documentation drifts.**
  - `.env.example:262-265` says the default is $2.00 and the clamp $25.
  - The code (`deep-research.ts:93`) and `JUNO.md:737-738` say $8 and $40.
  - `.env.example:127-128` claims an unset `API_COST_EUR_PER_USD` makes budgets "more generous". In
    fact, while 1 USD costs less than 1 EUR, the default makes them **stricter**:
    €11 / 1 = $11, against €11 / 0.92 = $11.96.

### 6.3 Caps and rate limits

| Control | `POST /api/research` | Chat path (`runDeepResearch`) |
|---|---|---|
| Plan check | `PLANS[plan].webSearch` (`api/research/route.ts:51-56`) | Same flag (`route.ts:2095`) |
| Start rate | 10 an hour (`:66-72`) | Chat's 30 a minute (`route.ts:572`); owner accounts exempt |
| Live runs | `MAX_LIVE_RUNS = 3` (`:33`, `74-86`) | **None.** Only one plan may wait per conversation (`deep-research.ts:241-259`); runs in other conversations are unlimited |
| Per-run ceiling | **Taken from the client.** `budgetMicroUsd` is `null` or any 15-digit string (`protocol.ts:53-57`). `null` = no ceiling (`engine.ts:3536`, `domain.ts:1743-1750`) | $8 flat |
| Monthly and window check | None | None (B16); plus the pre-turn `checkBudget` for the chat message only |
| Cancel on Stop | n/a | None (B17) |

### 6.4 Reservation rates (B15, and the vendor half)

- **Model stages.** Plan, clarify, expansion, synthesis and audit estimates use `REFERENCE_MODEL_RATES`
  of $3/$15 (`domain.ts:1498-1499`, `1654-1657`; `engine.ts:694-767`).
- **But the lead is the most capable model.** Planner, writer and review run on `researchLeadModel()`,
  which picks the highest intelligence available (`worker.ts:140-157`).
  - With Fable 5.1 ($10/$50) the fixed stages are under-reserved by about 3.3×.
  - Only workers and review use real rates (`engine.ts:2771-2772`, `2967`, through
    `researchModelRates`, `run.ts:579-600`).
- **Vendor fees** are reserved at $0.001 per search and $0.0005 per page, × 2 margin
  (`domain.ts:1466-1478`, `1697`). The real cost is $0.008–$0.112 per query (§4.4). With all four
  engines, **search costs more than the $8 ceiling can see.** A standard run makes about 100 queries:
  $8.40 real, against $0.10 recorded.

Reference costs of the fixed stages at real rates: a 40-source report, 2 reviews, a 24-call judge,
plan and clarify.

| Lead | Fixed stages | Writer alone, 40 / 60 / 120 sources |
|---|---|---|
| Sonnet 5 ($2/$10) | $0.96 | $0.52 / $0.68 / $1.16 |
| Opus 5.5 ($4/$20) | $1.66 | $1.05 / $1.37 / $2.32 |
| Fable 5.1 ($10/$50) | **$3.75** | $2.62 / $3.42 / $5.80 |

Cost of one worker round (30 tool calls; about 15 searches and 9 page opens):

| Worker | Tavily | All four engines | Keyless |
|---|---|---|---|
| Luna-class ($0.2/$1.2) | $0.26 | $1.40 | $0.14 |
| Haiku 4.5 ($1/$5) | $0.78 | $1.92 | $0.66 |

**A Fable lead cannot fit inside any PRO-sized envelope.** The lead's model class has to depend on
the plan (Q13).

### 6.5 Proposal: `researchBudgetFor(scope, plan, remaining)`

```ts
researchBudgetFor({ scope, plan, remaining, rates, roster, liveRuns }): ResearchEnvelope | ResearchRefusal
```

**Inputs**

| Input | Type | Source | Notes |
|---|---|---|---|
| `scope.questions` | 1–8 | The structured planner's objectives (`plan-format.ts:46-60`) | Also sets the minimum number of workers |
| `scope.breadth` | `focused` / `broad` / `exhaustive`, as sources per question 4 / 8 / 12 | The planner's evidence contract | Drives pages and rounds |
| `scope.freshness` | `any` / `recent` / `live` | The planner's freshness rule | Picks engines and results per query (news: Tavily and Serper; primary sources: Exa) |
| `scope.primarySources` | boolean | The planner | Raises pages per question |
| `plan` | `Plan` | `getUserPlan` | Selects the caps row below |
| `remaining.month` | µUSD or null | `checkBudget(...).remainingMicroUsd` | `null` = cap disabled; use `UNATTENDED_RUN_DEFAULT_MICRO_USD` as the backstop (`spend-ceiling.ts:226-234`) |
| `remaining.window` | `{ remainingMicroUsd, bound, resetsAtMs }` | `checkUsageWindows(...)` | Only if Research counts against the windows (Q14) |
| `rates` | worker, lead, judge in µUSD per token | `researchModelRates()`, extended to the lead for plan and synthesis (B15) | |
| `roster` | Price per query as a function of results | The table in §3.3 over `searchProviderStatus().keyed` (`search-engine.ts:798-810`) | Replaces `SEARCH_FEE_MICRO_USD` |
| `liveRuns` | int | Count of non-terminal runs | Compared with the plan's cap |
| `eurPerUsd` | number | `eurPerUsd()` | Display only |

**Plan caps.** These are proposals for the owner (U13, Q13, Q14).

| Plan | Entitled | Ceiling per run | Share of the month | Live runs | Starts a day | Investigation clock | Lead model class |
|---|---|---|---|---|---|---|---|
| FREE | No, or one light run a month (U6) | — | — | 0 | 0 | — | — |
| PRO (€11) | Yes | €2.50 | 25% | 1 | 5 | 15 min | Sonnet-class |
| Max ×5 (€55) | Yes | €8 | 15% | 2 | 15 | 30 min | Opus-class |
| Max ×10 (€110) | Yes | €16 | 15% | 3 | 30 | 60 min | Best available |
| OWNER (€15 default) | Yes | €8, or the env value | 50% | 3 | — | 60 min | Best available |

**The ceiling:**

```
ceiling = min(
  planCap,
  share × monthBudget,
  month.remaining − chatFloor,
  [window.remaining − chatFloor]   // if windows bind Research
)
```

- `chatFloor` is about €0.25, so the user can still chat after a run.
- If the ceiling is below the minimum viable run (fixed stages plus one worker round; about €1.2 with a
  Sonnet lead and €2.0 with Opus), the run is **refused with a reason**, for example "Research needs
  about 10% of your weekly usage; 4% is left until Tue 14:00". Stepping the lead model down is the
  alternative.

**Outputs** (a frozen `ResearchEnvelope` on the run, replacing `plan.effort`)

| Field | Meaning | Replaces |
|---|---|---|
| `ceilingMicroUsd` | The run's ceiling | `CHAT_RUN_BUDGET_MICRO_USD`, client `budgetMicroUsd` |
| `reserve.writerMicroUsd`, `reserve.auditMicroUsd` | Held from round 1 at lead rates | Fixes B8 and B15 |
| `workers`, `rounds`, `toolCallsPerWorker` | Team shape | `RESEARCH_TIERS` (`domain.ts:1026-1075`) |
| `pages` | The **real** fetch ceiling, including seeds and hops | Tier pages clipped by `MAX_SOURCES` (`engine.ts:2738`) |
| `resultsPerQuery`, `engines` | Fan-out size and which engines to call | Tier `resultsPerQuery` |
| `workerTokens`, `wallClockMs`, `workerWallClockMs`, `judgeCalls` | Clocks and caps | Tier fields; `judgeCalls` becomes live (B22) |
| `limitedBy` | `scope` / `plan` / `month` / `window` | New |
| `estimate` | `{ minutesUpTo, pagesUpTo, allowanceShare, resetsAtMs? }` | `effort-copy.ts` (ETA = clock ÷ 2, `effort-copy.ts:23-26`) |

**Sizing algorithm**

1. Price the fixed stages at the lead's real rates: plan and clarify, one review per round, the writer
   for the target number of sources, and the audit.
2. Price one worker round at the worker's rates plus the roster's real price per query.
3. Set demand from the scope:
   - workers = questions;
   - rounds = 1 + (broad ? 1 : 0) + (exhaustive ? 1 : 0);
   - pages = questions × sources per question.
4. Fit the demand under the ceiling. Reduce in this order:
   - results per query and the expensive engines;
   - rounds;
   - tool calls per worker;
   - workers, never below ⌈questions / 2⌉.
   - `limitedBy` records what bound.
5. At each round boundary, re-read `checkBudget` and the window. Shrink the next round, never the
   reserve for the writer and audit.

**Worked envelopes** (Luna-class worker, 40-source report)

| Ceiling | Lead | Roster | Fixed | Worker rounds that fit | ≈ pages opened |
|---|---|---|---|---|---|
| $2.50 (PRO) | Sonnet 5 | Tavily | $0.96 | 5 | 45, plus search snapshots |
| $2.50 | Sonnet 5 | All four | $0.96 | 1 | 9 |
| $2.50 | Opus 5.5 | Tavily | $1.66 | 3 | 27 |
| $2.50 | Opus 5.5 | All four | $1.66 | 0 (not viable) | — |
| $8 (MAX) | Sonnet 5 | Tavily | $0.96 | 26 | ~234 |
| $8 | Opus 5.5 | All four | $1.66 | 4 | 36 |
| $16 (MAX20) | Opus 5.5 | Tavily | $1.66 | 54 | ~490 (capped at 250) |
| $16 | Opus 5.5 | All four | $1.66 | 10 | 90 |

If the all-four roster is priced truthfully, it makes Research roughly 5× more expensive per page read.
The engine fan-out should be scoped per query (Q3).

### 6.6 What the R2 estimate line may truthfully promise

- **Time.**
  - Promise an **upper bound** from the frozen envelope: planning + `wallClockMs` + the writer's
    timebox. This holds only once paused time stops counting (B13) and the writer is timeboxed (R8).
  - "About N min" needs measured data. Today's figure is a guess (clock ÷ 2, `effort-copy.ts:24`).
  - Until measured, say "Up to ~N min".
  - Measure with the p50 of `finishedAt − startedAt` on `ResearchRun` (`schema.prisma`,
    `ResearchRun.startedAt` / `finishedAt`), grouped by envelope size.
- **Pages.**
  - "Reads up to ~N pages" is true only if N is the envelope's real fetch ceiling. Today the tier copy
    says 320 or 480, while the engine clips at 250 and spends part of that on seeds and hops (backend
    audit §5.1).
  - Count as "read" the sources that have a snapshot, which includes search results that carried their
    raw content.
  - Always "up to", because the budget or saturation may stop the run earlier.
- **Spend.**
  - Do **not** print an amount by default. Users buy plans, not credits, and the internal budget is a
    cost figure.
  - If spend is shown, show it as a share of the allowance the user already sees ("uses up to ~20% of
    this week's usage"), converted exactly like the meters (`billing.tsx:92-93`).
  - If a currency is ever printed, it must be **EUR**, never "$". That removes "Stops at $8.00" from
    `run-controls.tsx:472`.
  - When the ceiling was bound by the month or the window, say so, with the reset time:
    "Shortened to fit your weekly usage · resets Tue 14:00".
- **Do not promise** a number of researchers, a depth name, or a cost in USD.

---

## 7. Recommendations, in order

1. **Close the client-controlled ceiling now.** Ignore `budgetMicroUsd` from the client, or cap it
   with `researchBudgetFor`. Refuse `null`. Apply `MAX_LIVE_RUNS` and the start rate on the chat path
   as well (`api/research/route.ts:33`, `66-86`; `protocol.ts:53-57`).
2. **Price search truthfully.** Add the roster price table (§3.3). Stop asking Exa for text in chat.
   Decide the chat fan-out (Q3). Add Gemini grounding to `toolFeesUsd`.
3. **Make the guard see tools.** Add fees to the projection, per-round usage from every adapter,
   checks before each round, and a ceiling of min(month, window). Size the chat hold by effort.
4. **Size Research from the plan and what remains** (§6.5). Freeze the envelope. Show EUR or a share.
5. **Settle the gating cells U1–U13**, then encode them in one pure `chatToolEntitlements(ctx)` that
   the route, the composer and the skill grant layer all read. That removes the three copies that
   drift today: `route.ts:2093-2111`, `composer.tsx:715-764` and `skills.ts:108-122`.
6. **Remove the dead flags** `features.deepResearch` and `webSearch`, or make them honest (a
   `hasGoodIndex` from `searchProviderStatus`). Fix the drift in `.env.example` (§6.2).
7. **Disclose the search subprocessors** that are really in use, or drop the public keyless engines in
   production.

---

## 8. Questions for the owner

1. Which of `TAVILY_API_KEY`, `SERPER_API_KEY`, `BRAVE_SEARCH_API_KEY`/`BRAVE_API_KEY`, `EXA_API_KEY`
   and `SEARXNG_URL` are set in `PROD_ENV`? Run `npm run search:check` on the VM, or the SQL in §4.2.
   Which Tavily plan is it: pay as you go, or a monthly Project plan?
2. Should the public SearXNG instances, scraped DuckDuckGo and Wikipedia stay in the production
   fan-out? They receive every query, and `SUBPROCESSORS.md` names only Tavily. The same applies to
   Serper, Brave and Exa if they are set.
3. Should chat `web_search` fan out to every keyed engine (up to $0.031 a call), or use one primary
   engine with a fallback? Should Exa's full text be requested at all in chat?
4. What is `API_COST_EUR_PER_USD` in production? Is `PLATFORM_DAILY_BUDGET_USD` set? Search fees
   missing from the ledger are invisible to that ceiling.
5. **FREE:** does it get Juno or native web search (U1), `web_fetch` of pasted URLs (U2), `run_code`
   (U3), `search_chats` (U4) and connectors (U7)? If it gets web, should `BUDGET_EUR.FREE` (€0.15)
   rise? Fifteen Tavily-backed messages on the default model cost about $0.18.
6. **Private chats (U8):** zero tools as today, or `current_time` and `calculate` only, or web too?
   Tools would need a path with no durable approval receipt.
7. **Lockdown (U9):** should it stop web search (native and Juno), `web_fetch`, Research,
   `search_chats` and reads of one's own attachments? Today it stops brokered reads but not native
   search or Research, and its copy says "reading included".
8. **Voice (U10):** the T5 round budget, `web_fetch` and `run_code` in voice, or a small fixed budget?
9. **Workspace keys (U12):** map `web_fetch` to `webSearch`; add a `code` key; make `search_chats`
   follow `memoryRecall` and the project scope? Each new key is a native contract change.
10. **Skills (U11):** should a skill that lists tools also narrow native search and the new tools?
11. **`run_code`:** is a sandbox provisioned? Which provider and plan (E2B Pro is $150 a month)? Which
    plans get it, and should each call be metered (§3.1)?
12. **FREE and `start_task` (U5):** hide it for FREE? Today it is offered and always refused, because
    the $0.25 Work hold exceeds the €0.15 month.
13. **Research caps by plan (U13):** accept or adjust the §6.5 table: per-run cap, share of the month,
    live runs, starts a day, clock, and **lead model class per plan**. A Fable lead alone costs $3.75
    in fixed stages.
14. **Research and the windows:** does Research count against the 5-hour and weekly windows (PRO
    Research is then at most about €2.3 and uses up the week), or is it exempt with its own capped
    share of the month? Or should PRO's windows grow?
15. **`RESEARCH_CHAT_BUDGET_USD`:** retire it in favour of `researchBudgetFor`, or keep it as an
    owner-only override?
16. **Estimate line:** no amount (recommended), a share of usage, or EUR?
17. **Ledger shape:** Juno tool fees as `kind: "chat"`, `model: "juno-tools"`, or a new `SpendKind`
    such as `"tool"`? Unify all Research spend under `"research"` (B27)?
18. **Past under-billing:** Research search fees have been recorded at $0.001 per query since launch.
    Correct going forward only (recommended), with no backfill?
19. **T5 on frontier models:** a 16- or 24-round turn costs $1.5–$4.4 cached, more than PRO's weekly
    window. Cap the rounds by plan, by the remaining window, or both? Is maximum effort allowed on
    PRO?
20. **Gemini grounding** beyond the 5,000 free queries a month for the deployment: bill users $14 per
    1k, or absorb it?
21. **`POST /api/research`:** close the client-set and `null` ceiling now, ahead of the rework? It is
    reachable by any paid account.
22. **The chat hold:** replace the flat $0.05 with an estimate by effort and model (§3.3, item 4)?

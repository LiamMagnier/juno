# Code depth audit: Alevr vs ChatGPT and Claude (31 Oct 2026)

Area: CODE. Covers (1) code execution and data analysis, (2) coding help in chat, (3) the coding agent (cloud, Mac, phone, GitHub).
Method: competitor research (official pages fetched where the sandbox allowed it; OpenAI hosts are blocked here, so OpenAI facts come from search excerpts of official pages, marked *excerpt*), then a static read of the Alevr code (file:line). No product code changed and nothing was run against a live Alevr. "Present" in `parity-gap.md` means the code exists. This audit asks whether it is on, how good it is, and how fast.

Out of scope here (other lanes are building them): sharing with specific people, per-chat memory off, AI-powered artifacts and storage, PDF/Google export, locked chats, Drive/OneDrive attach, connectors in voice, tone sliders, MCP Apps widgets, plugins, the UI/motion redesign.

---

## 1. Summary

1. **Production has no server-side code execution.** The runtime is built, tested and well secured, but it needs `TOOL_RUNTIME=1`, a separate execution host (`src/lib/exec/config.ts:81`), a paid plan (`config.ts:129`) and a model whose tool round trip has been probed (`src/lib/model-tool-probe.ts`). On 2026-10-02 the repo recorded that "no execution host or hosted sandbox exists" (`docs/rework/TOOL_RUNTIME_COVERAGE.md:8-10`). ChatGPT and Claude both have data analysis on today, and Claude has it on the Free plan. Until the host is live, every other improvement in section A is theoretical.
2. **Once it is on, it is weaker than both competitors in the ways people notice.** Each reply gets a fresh workspace and each run is a fresh process, so state does not carry over between turns. Charts come back as static PNGs only. The package set has no scikit-learn, statsmodels, pyarrow or sympy. The sandbox has 1.5 GB of RAM, and the whole host runs 4 programs at once.
3. **The interactive chart and table components are dead code.** `DataChartBlock` and `DataTableBlock` are imported only by `PythonExecutionBlock`, and nothing imports that. `parity-gap.md` row C "Inline charts and tables: present" should read **missing** for code output. Live UI charts exist, but only for answers the model writes by hand.
4. **The coding agent is broad, and on some points ahead.** Alevr runs the user's own Claude Code, Codex, Gemini and other CLIs on their Mac. It also has phone remote control, subagents, best-of-N on the Mac, checkpoints and rollback, PR auto-fix, and Create PR as full, draft or compose. Cloud runs are where it is weaker. Cloud tasks run as GitHub Actions jobs in the product's own repository, with a 30-minute cap. Every run does `npm ci`, builds agent-core and pulls the sandbox image. Setup is never cached (deliberately, because the Actions cache is shared). The network is either none or full. Each follow-up starts a new machine, and the history it carries is trimmed to 48 KB.
5. **Pull request output is thin, and there is no AI code review.** The PR title is the first line of the prompt and the body quotes the prompt. In cloud runs, verification is only an instruction in the prompt. Codex (`@codex review`, automatic reviews) and Claude (Code Review: find, verify, rank, post) both review PRs. Alevr answers review comments through auto-fix, but it never writes a review.

---

## 2. Competitor baseline (late Oct 2026)

**ChatGPT / OpenAI**
- Data analysis: pandas DataFrames shown as **interactive tables**. Bar, line, pie and scatter charts can be switched between **interactive and static**. Accepts spreadsheets, PDFs, JSON/XML/YAML/text. The Python environment **cannot make external web requests** [CG-DA, *excerpt*]. Interpreter state is understood to persist within a session until it times out. This is long-standing, well-known behaviour, not confirmed on the current page (lower confidence).
- Canvas was removed in favour of in-chat writing and code blocks [O14 in parity-gap].
- ChatGPT Work and Codex sit in one product. GPT-6.1 Terra rolled out to Work and Codex on 27 Oct 2026 [CG-W, CG-RN, *excerpt*].
- Codex cloud: one container per task, a setup script that runs **with** network, then the agent runs with internet **off by default**, with limited (allowlist) or unrestricted options, all through an HTTP proxy. **Container caching** is invalidated when the setup script, maintenance script, variables or secrets change. An optional maintenance script runs on cache resume [CX-ENV, *excerpt*].
- Codex review on GitHub: `@codex review` on demand, **Automatic reviews** for every PR, P0/P1 only by default, tuned through AGENTS.md. `@codex <anything else>` starts a cloud task with the PR as context and can push the fix [CX-REV, *excerpt*].
- Best-of-N: 1 to 4 attempts per task, with apply per attempt [CX-BON, third-party, lower confidence]. Codex in the ChatGPT mobile app (May 2026) lets you review diffs, approve and steer work running on the Mac [CX-MOB, press].

**Claude / Anthropic**
- File creation and analysis in claude.ai (web, desktop, mobile, **including Free**): xlsx with formulas and charts, pptx, docx, PDF, PNG charts. Isolated container. Network levels **Off / Package managers only / Package managers plus domains / All domains**, so the model can install from PyPI and npm when allowed. 30 MB per file. Uses more of the plan's usage than plain chat [CL-FILES, fetched].
- API code execution (what claude.ai builds on): `code_execution_20260120` adds **REPL state persistence**. Containers are **reused across requests** and **checkpointed after about 5 minutes idle**, with a 30-day life. 5 GiB RAM, 5 GiB disk, 1 CPU. Preinstalled: pandas, numpy, scipy, **scikit-learn, statsmodels**, matplotlib, seaborn, **pyarrow**, openpyxl, xlsxwriter, xlrd, pillow, python-pptx/docx, pypdf, pdfplumber, pdf2image, tabula, reportlab, **sympy**, plus rg, fd and sqlite. Pricing: **1,550 free container-hours/month, then $0.05/hour**, and free when web search or fetch is in the request [CL-API-CE, fetched].
- Claude Code cloud sessions: Anthropic VMs that **persist after you close the browser**, started from web, mobile, desktop or CLI (`--cloud`, `--teleport`). A diff view with **inline comments sent to Claude** and **Compare against any branch**. PR from the session. **Auto-fix** for CI failures and review comments. A GitHub proxy keeps credentials **outside the VM** [CL-CLOUD, fetched].
- Cloud environments: network **None / Trusted (package registries, GitHub, cloud SDKs) / Full / Custom**, Trusted by default. An **environment cache** keeps what the setup script installed (scripts under about 5 minutes). Docker is available. Network secrets are attached outside the sandbox [CL-ENV, fetched].
- Code Review (Team/Enterprise): several agents **find**, a **verify** step drops false positives, then findings are **ranked** and **posted** as inline comments with a summary and a neutral check run. Levels Quick / Standard / Deep. Configured through REVIEW.md and CLAUDE.md, read from the base branch only [CL-REV, fetched].
- Projects (public beta): one conversation coordinating parallel cloud sessions on your repositories [CL-PROJ, fetched]. Chat and Cowork are "one Claude" [C2 in parity-gap].

---

## 3. Capability table

Gap key: **missing** / **weaker** / **equal** / **ahead** (Alevr relative to the better of the two).

### A. Code execution and data analysis

| # | Capability | ChatGPT | Claude | Alevr today (evidence) | Gap |
|---|---|---|---|---|---|
| A1 | Hosted execution switched on for users | Yes [CG-DA] | Yes, on by default incl. Free [CL-FILES] | Built but off unless `TOOL_RUNTIME=1` + `CODE_INTERPRETER_URL/TOKEN` (`src/lib/exec/config.ts:81-92`). Paid plans only (`config.ts:129`, `src/app/api/code/run/route.ts:45`). Attached only for probe-verified models (`src/lib/model-tool-probe.ts` header; `src/lib/effective-capabilities.ts:262-283`). "No execution host or hosted sandbox exists" (`docs/rework/TOOL_RUNTIME_COVERAGE.md:8-10`). Production steps are listed as not done (`deploy/exec-host/README.md` "What production needs") | **missing in production** |
| A2 | State across turns (variables, files) | Stateful session (lower confidence) | Container reuse + REPL persistence; checkpoint after ~5 min idle, 30-day life [CL-API-CE] | Workspace per **reply**: chat `sessionId` = `generationId` (`src/lib/tools/dispatch.ts:570`) → `hostSessionId` (`src/lib/exec/ids.ts:27`); "shared by every run in this reply" (`src/lib/tools/specs/run-code.ts:59`). Every run is a fresh container (`deploy/exec-host/README.md:19`). Files come back next turn only as re-uploaded attachments; variables never do | **weaker** |
| A3 | Re-upload cost per turn | n/a | Files stay in container | Input cache keyed by host session (`src/lib/exec/runtime.ts:273-325`), so every new reply uploads all conversation files again (up to 20 × 32 MB) before its first run. The host drops sessions after 30 idle min (`deploy/exec-host/juno-exec.py` `sessionIdleSeconds`) | **weaker** (latency) |
| A4 | Package breadth | Broad, no web | sklearn, statsmodels, pyarrow, sympy, xlrd, pdf2image, tabula…; installs when network allowed [CL-API-CE, CL-FILES] | 35 pinned wheels: pandas, numpy, scipy, matplotlib, seaborn, office/pdf libs (`deploy/exec-host/image/requirements.txt`). No sklearn/statsmodels/pyarrow/polars/duckdb/sympy/plotly/networkx. pip removed, Node without npm (`image/Dockerfile:29-52`). "cannot install packages" (`run-code.ts:61`) | **weaker** |
| A5 | Resources and capacity | Not published | 5 GiB RAM, 5 GiB disk, 1 CPU | 1.5 GB RAM, 1 CPU, 256 MB /tmp (`README.md:19-21`). **4 concurrent runs per host, 2 per account** (`juno-exec.py:84-86`). One host URL (`config.ts:82`) | **weaker** |
| A6 | Interactive tables / charts from analysis | Yes (interactive table; bar/line/pie/scatter switchable) [CG-DA] | PNG charts, charts inside xlsx [CL-FILES] | Live path renders PNG images and file tiles only (`src/components/chat/tool-run-files.tsx:65-90`). `DataTableBlock`/`DataChartBlock` imported only by `PythonExecutionBlock`, which nothing imports (`python-execution-block.tsx:13-14`; types in `src/lib/sandbox/python.ts:1-9` say "old in-chat Python blocks") | **missing** vs ChatGPT, equal vs Claude |
| A7 | File outputs | Downloads | xlsx/pptx/docx/pdf, 30 MB, save to Drive | ≤20 files, 25 MB each, 50 MB total (README API table). Stored as conversation attachments and listed in Library "Made by Alevr" (`tool-run-files.tsx:60-63`) | **equal** |
| A8 | Long runs | Session timeout | Per-call limit | 90 s inline, then a run id and `check_run`; chat max 10 min, Work 30 min (`config.ts:32-33`) | **ahead** |
| A9 | Honest error recovery | Generic | Generic | Idempotency key per call; `outcome_unknown` instead of a guess; never re-run automatically; lease and sweep (`src/lib/exec/runtime.ts:1-17`, `runtime.ts:349-560`); stderr fed back for self-fix (`src/lib/exec/provider.ts` prompt) | **ahead** |
| A10 | Sandbox security | No egress | Prompt-injection classifier; egress levels | `--network none`, read-only root, cap-drop ALL, non-root, pids/mem/cpu caps, optional gVisor, root broker validates every argv, boundary probe in CI (`README.md:17-44`) | **ahead** |
| A11 | Run a code block where it stands | Canvas removed | Artifacts run HTML/JS | JS/TS/Python (Pyodide)/SQL run **in the browser, free, today** (`src/lib/sandbox/console-doc.ts:17-19`, `src/lib/exec/snippet-languages.ts:7-20`). 10 more languages on the server (C, C++, Java, Go, Rust, Ruby, PHP, Lua, Perl, Bash), but only with the sandbox on and a paid plan (`snippet-languages.ts`; `api/code/run/route.ts:41-49`) | **ahead** (browser part) |

### B. Coding help in chat

| # | Capability | ChatGPT | Claude | Alevr today (evidence) | Gap |
|---|---|---|---|---|---|
| B1 | Code blocks: highlight, copy, run, diff | Blocks | Blocks, artifacts | Highlighted while streaming, Run + Copy, diff/patch fences rendered as `FileDiff` with "Copy diff", Mermaid (`src/components/chat/markdown.tsx:323-420`) | **equal/ahead** |
| B2 | Repo context in chat | GitHub connector | GitHub integration | GitHub over OAuth to GitHub's MCP server (`src/lib/connectors.ts:99-121`, `src/lib/env.ts:101`) | **equal** |
| B3 | From chat to the coding agent (apply, open, delegate) | Work + Codex in one product [CG-W] | "One Claude" chat + Cowork [C2]; claude.ai/code | No chat tool starts a Code run. Chat tools are `start_task` (Work) and others (`src/lib/tools/specs/`). Handoff only goes from the Code composer into a Code session (`src/lib/code-session-handoff.ts`). Chat code blocks have no "Open in Code" or "Apply" | **weaker** |
| B4 | Multi-file answers | Blocks | Artifacts, files | Several fences. `run_code` can write several files. `WrittenFileFence` only in Code sessions (`markdown.tsx:337-358`) | **equal** |

### C. Coding agent

| # | Capability | Codex / ChatGPT | Claude Code | Alevr today (evidence) | Gap |
|---|---|---|---|---|---|
| C1 | Cloud task sandbox | Container per task, cached [CX-ENV] | Managed VM, persists after close [CL-CLOUD] | GitHub Actions job in `LiamMagnier/juno` (`src/lib/cloud-code.ts:12`, `.github/workflows/code-runner.yml`), `timeout-minutes: 30` (`:52`), `npm ci` + build + `docker pull` **every run** (`:83-95`). "Starting a cloud runner takes a minute or more" (`scripts/cloud-code-runner.mjs:781`). Needs `GITHUB_DISPATCH_TOKEN` + workflow probe (`cloud-code.ts:63-72,165`) | **weaker** |
| C2 | Setup cache | Yes, invalidated on change [CX-ENV] | Environment cache [CL-ENV] | None, on purpose: the Actions cache is "one namespace shared by every user's runs" (`src/lib/code-environments.ts:121-128`) | **missing** |
| C3 | Network levels | Off by default; limited allowlist / unrestricted [CX-ENV] | None / **Trusted** (default) / Full / Custom [CL-ENV] | `none` or `full` only; "proxy-allowlist network levels … deliberately absent … no deployment runs that proxy" (`docs/JUNO.md:1606-1610`). A DNS-pinned, per-container egress proxy with byte budgets already exists for agent computers (`deploy/agent-computers/egress-proxy.py`) | **weaker** |
| C4 | Follow-ups keep context | Same task | Same session/VM | Each follow-up is a new Actions job that clones the branch again. History trimmed to 48 KB / 40 turns (`src/lib/code-runner-history.ts:24,28`). No installed deps or warm caches carry over | **weaker** |
| C5 | Credential isolation | Proxy | GitHub proxy, creds never in VM [CL-CLOUD] | OIDC → single-use runner-context, askpass, scrubbed env, repo-scoped App token only if the user can push (`docs/JUNO.md` §9.3). The token is in the driver on the runner VM, not in the agent's container | **equal** |
| C6 | Diff review with comments to the agent | Diff, apply per attempt | Diff view, inline comments, Compare against branch [CL-CLOUD] | Review notes with severities sent to the agent (`src/lib/code-review-notes.ts`). Cloud patches **capped at 40 KB per file** (`cloud-code-runner.mjs:1528-1552`) and persisted under 16/120 KB caps (`docs/JUNO.md` §9.1). No compare-against-branch for cloud | **weaker** (large diffs) |
| C7 | PR creation | Yes | Yes | Full / draft / compose (`src/lib/code-pull-request.ts:1-35`). Title = first line of the prompt, commit message = title (`cloud-code-runner.mjs:1334,1344`), body = quoted prompt (`:1571-1583`) | **weaker** (quality) |
| C8 | Tests / verification before "done" | Runs tests in env | Runs tests; Code Review verify step | Cloud: an instruction in the system prompt (`runner/agent-core/src/agent.ts:196`) plus an optional plan-build-verify preset (`agent.ts:821`). The Mac engine has structured `VerificationEngine` / `CompletionGate` / `CheckRunner` (`native/Packages/JunoCode/Sources/JunoCodeRuntime/`). CI status chip (`src/lib/code-checks.ts`) | **weaker** (cloud), equal (Mac) |
| C9 | Auto-fix CI failures / review comments | `@codex fix …` [CX-REV] | Auto-fix [CL-CLOUD] | Per-PR switch. Signed webhook. Trusted `author_association` only. Steer folding. Untrusted fencing (`docs/JUNO.md` §9.4; `src/lib/code-autofix.ts:98,402`) | **equal** |
| C10 | AI review of pull requests | `@codex review` + automatic [CX-REV] | Code Review [CL-REV] | **None.** Reviews are human-written only (`code-review-notes.ts`). Nothing posts a review or a check run | **missing** |
| C11 | Parallel attempts / best-of-N | 1-4 attempts [CX-BON] | Parallel sessions; Projects coordinate them [CL-PROJ] | Best-of-N in agent-core and the Mac/linked dock (`src/components/code/v2/dock.tsx`, `team.tsx`). Cloud runs a single attempt (`cloud-code-runner.mjs`) | **partial** |
| C12 | Bring your own agent/subscription | No | No | The env server runs the user's own `claude`, `codex`, Gemini, Grok, OpenCode, Antigravity and BYOK keys on their Mac (`docs/code-v2/STATUS.md` env lane; `runner/env-server`) | **ahead** |
| C13 | Phone control of local/cloud work | Codex mobile → Mac [CX-MOB] | Mobile + Remote Control | Remote sessions with a command channel (`docs/JUNO.md` §9.2). iOS Code view: Cloud + Remote (`native/iOS/JunoMobile/App/JunoMobileCodeView.swift:14-15`) | **equal** |
| C14 | Subagents / orchestration | Yes | Subagents, agent teams | Roles explorer…docs, up to 3 concurrent in cloud and 6 on the Mac, writers in worktrees (`docs/JUNO.md` end of §9.3; `runner/agent-core/src/subagents.ts`) | **equal** |
| C15 | Triggered and scheduled coding tasks | Slack/Linear triggers | Routines, GitHub events | Schedule fires a cloud Code run (`docs/JUNO.md:85`). No Slack/Linear trigger | **partial** |
| C16 | Live preview of a cloud app | Screenshots | n/a | Mac has Preview and preview verification (`JunoCodeRuntime/PreviewVerification.swift`). Cloud has none | **weaker** |

---

## 4. Ranked improvements

Ordering: what users feel most, weighed against effort. Items 1-3 are data analysis, 4-7 the coding agent, 8-11 depth and cost.

### CX-1. Turn hosted execution on for everyone, and make it scale
- **User-visible outcome:** Upload a CSV on any plan, ask for a chart, and get the real computed answer in seconds. A host outage reads as a clear note, not a missing feature.
- **Competitor evidence:** Claude has file creation and code execution on by default, Free included [CL-FILES]. ChatGPT data analysis [CG-DA].
- **Current code:** Gates at `src/lib/exec/config.ts:81-92` (env), `:129` (paid), `src/lib/effective-capabilities.ts:262-283` (verified model). The host is a single URL (`config.ts:82`) with `hostConcurrent: 4` (`deploy/exec-host/juno-exec.py:86`). Status: no host (`docs/rework/TOOL_RUNTIME_COVERAGE.md:8-10`). Meter: 46 µUSD per sandbox-second (`config.ts:136-139`), which is $0.17 per sandbox-hour.
- **Implementation sketch:**
  1. Provision the host with the existing runbook (`deploy/exec-host/setup.sh`), set the three variables, and run the tool probe for the default and most-used models so `toolCalling: verified` exists (`src/lib/model-tool-probe.ts`, TTL 30 days). Add a deploy smoke test: `/v1/health` reports `egress:"none"` and a one-line Python run succeeds.
  2. **Pool**: `CODE_INTERPRETER_URLS` (comma-separated), with `execEndpoint(sessionKey)` choosing a host by rendezvous hash of the host session id, so a session stays on one host. Health is tracked per host in `runtime.ts` `execHealth`. Size hosts to RAM: 1.5 GB per run means a 16 GB host runs about 8, so raise `hostConcurrent` per host from config.
  3. **Free plan with a quota** instead of a hard refusal: `execEntitlement` takes `{ plan, usedSecondsToday }`. Free gets about 120 sandbox-seconds a day (≈$0.006 at the current meter) and 30 s per run. The refusal says what the limit is and when it resets. Paid plans keep metering through `recordSpend`.
  4. Optional backend B, an owner decision: an adapter behind `JunoExecClient` for a hosted sandbox whose network is off and **verified by the same `/health` egress check** (vendor flags must be confirmed during implementation). This keeps `run_code` a read.
- **Acceptance tests:** (a) Free account, `sales.csv`, "chart monthly revenue": a run starts in under 3 s, an image is returned, and quota usage is shown. (b) Host stopped: the turn carries a capability note and the model says code could not run. (c) 40 concurrent sessions across 3 hosts: p95 queue wait under 5 s, and no session moves host mid-conversation. (d) `exec-boundary` CI job still green.
- **Size:** M (ops plus about 300 LOC). **Impact:** H. **Risks:** host cost and capacity planning; abuse on Free (CPU mining needs no network, so cap CPU-seconds); probe spend.

### CX-2. A notebook per conversation: persistent workspace and warm Python kernel
- **User-visible outcome:** "Now split that by region" works on the DataFrame from the last turn instantly, without re-reading the file. A small "Python session" line shows that variables are kept, with a Restart control. After a long idle the model says the session restarted and reloads by itself.
- **Competitor evidence:** Claude REPL state persistence, container reuse, checkpoint after ~5 min idle [CL-API-CE]. ChatGPT stateful session (lower confidence).
- **Current code:** `dispatch.ts:570` (`sessionId: context.generationId`), `ids.ts:27`, `run-code.ts:59`, fresh container per run (`README.md:19`), per-session upload cache (`runtime.ts:273-325`), 30-min session idle drop (`juno-exec.py` `sessionIdleSeconds`).
- **Implementation sketch:**
  1. Chat host session = `conv:<conversationId>`. The per-turn run budget moves from `countSessionRuns(sessionId)` to a separate `turnId` column on `ToolRun`, so the 20-runs-per-turn limit still holds (`runtime.ts:622-625`).
  2. Exec host: `POST /v1/sessions/{s}/kernel` starts a long-lived container with the same broker profile (no network, read-only root) running `/opt/juno/kernel.py`. That is a small stdlib REPL server that reads framed cells from a fifo in a session-private mount and executes them in one namespace, capturing stdout, stderr and `display()` (see CX-3). `POST /v1/runs` gains `mode: "cell"`. Timeout sends SIGINT and then kills. Stop interrupts the cell and keeps the kernel. OOM sets `kernelRestarted: true`. The broker policy gains the exact `docker exec`/fifo shape, nothing wider.
  3. Lifecycle: the kernel stops after 20 idle minutes, which loses variables, like ChatGPT. The `/work` tree is tarred to object storage after 24 h idle and restored on the next run. Data: new `ExecSession {id, userId, conversationId, remoteSession, kernelState, lastActiveAt, snapshotKey, bytes}`. The input upload cache is keyed by this session, so each file goes up once per conversation.
  4. Model contract: the outcome text starts with `Session: warm (variables kept)` or `Session: restarted (files kept, variables lost)` (`src/lib/exec/format.ts`). The run_code description says variables persist while warm.
  5. UI: a session chip on the run receipt (`tool-run.tsx`) with Restart (`DELETE /v1/sessions/{s}/kernel`). Same in the native `NativeToolRun`.
- **Acceptance tests:** (a) Turn 1 `df = pd.read_csv(...)`, turn 2 `df.groupby(...)`: the second run takes under 500 ms of host time and makes no input upload. (b) Idle more than 20 min: the outcome reports a restart and the model reloads. (c) Stop during `time.sleep(600)`: the cell is cancelled and `df` survives. (d) Two conversations and two accounts never share a namespace (boundary test). (e) Private and lockdown still refuse (`runtime.ts:560-570`).
- **Size:** L. **Impact:** H. **Risks:** warm kernels hold RAM (LRU-evict warm kernels per host and count them toward per-account concurrency). Persistent state means an injected file can affect later runs (no network and no secrets limit the blast radius; Restart is the escape). Metering should charge executing seconds, not warm idle time.

### CX-3. Interactive tables and charts from code output
- **User-visible outcome:** A DataFrame appears as a sortable, filterable table with column types and CSV download. Bar, line, area, scatter and pie charts are interactive (hover values, toggle series, switch to the static image, download PNG/CSV). The same view reloads from history and shows natively on Mac and iOS.
- **Competitor evidence:** ChatGPT interactive tables and switchable interactive charts [CG-DA].
- **Current code:** The live path has PNG images and tiles only (`tool-run-files.tsx:65-90`). Dead components: `src/components/chat/data-table-block.tsx`, `data-chart-block.tsx`, `python-execution-block.tsx`, legacy types `src/lib/sandbox/python.ts`. The reusable renderer is `src/components/chat/live-ui/live-ui-chart.tsx` (series/xs model, 400-point cap).
- **Implementation sketch:**
  1. Sandbox image: a read-only `/opt/juno/alevr` package on `PYTHONPATH` with `alevr.table(df, title=None)` and `alevr.chart(kind, df|data, x, y, series=None, title=None)`. Each writes `/work/.alevr/display/NNN.json` (≤2 MB, ≤5,000 rows or points, typed columns). In kernel mode (CX-2), `display(df)` maps to `alevr.table`. Matplotlib stays the fallback for every other chart kind.
  2. `src/lib/exec/display.ts` (new): a zod schema and validation. `capture.ts` collects `.alevr/display/*` into `ToolRun.outputs.displays[]` (the JSON column already exists through `readOutputs`). These are not attachments, so the Library does not fill up.
  3. The model sees one line per display ("Showed table 'Revenue by region' 12×4; line chart 'Revenue' 24 points"), not the JSON, which saves tokens.
  4. Web: replace `PythonExecutionBlock` with `RunDisplays` in `tool-run-files.tsx`. Revive `DataTableBlock` (virtualized rows, sort, filter, "Open as sheet" into the existing spreadsheet artifact model `src/lib/work/deliverables/spreadsheet.ts`). Charts reuse the Live UI chart drawing with a raise of `MAX_POINTS`, plus a "Static image" toggle when a PNG exists. Delete the dead files.
  5. Native: SwiftUI `Charts` and `Table` in `JunoChatKit/NativeToolRun.swift`.
  6. Prompt: "Use `alevr.chart` for bar/line/area/scatter/pie and `alevr.table` for tabular results; matplotlib for anything else."
- **Acceptance tests:** (a) e2e: upload CSV, ask for a chart, get an interactive line chart with tooltip and a working static toggle. (b) Numeric sort is correct with nulls. (c) Reload renders from DB with no rerun. (d) Invalid JSON is dropped with a note to the model. (e) a11y: the table works by keyboard and the chart has a "view as table" fallback. (f) Mac/iOS snapshot tests.
- **Size:** M. **Impact:** H. **Risks:** spec drift between web and native (put the schema in `contracts/`); large tables need virtualization.

### CX-4. Verified pull requests: a written description, evidence, and draft when unverified
- **User-visible outcome:** Every PR Alevr opens has a clear title, a summary, changes grouped by area, and a **Verification** section listing the exact commands run and their results, taken from the run's own tool rows. A PR whose checks did not pass or could not run opens as a **draft** labelled "Not verified". The session banner shows "Verified: 214 tests passed".
- **Competitor evidence:** Claude's verify-before-post discipline [CL-REV] and diff/PR flow [CL-CLOUD]. Codex review guidance through AGENTS.md [CX-REV].
- **Current code:** Title = first prompt line (`cloud-code-runner.mjs:1334`), commit message (`:1344`), body = quoted prompt (`:1571-1583`). Verification is only in the prompt (`runner/agent-core/src/agent.ts:196`). The Swift `VerificationEngine.swift` / `CompletionGate.swift` exist for the Mac and are not used in cloud.
- **Implementation sketch:**
  1. `runner/agent-core/src/verification.ts` (new, a port of the Swift semantics): record every bash tool call `{command, exitCode, afterLastEdit}`. Detect the project's checks from `package.json` scripts, `pyproject`/`pytest.ini`, `go.mod`, `Cargo.toml`, `Makefile` (`repository.ts`).
  2. In the driver after the agent ends (`cloud-code-runner.mjs` before step 7): if no detected check passed after the last edit, run the detected test command once, time-boxed to 10 min, and record it.
  3. A PR writer: one structured call on the session's cheap role model (routing "docs") that returns `{title ≤72, summary, changes[], risks[]}` JSON. The driver writes the **Verification** section itself from the ledger, never from the model. Honour `.github/pull_request_template.md`. Conventional commit subject.
  4. `pullRequestPolicy` gains `draft_if_unverified`, the default for cloud. `code.pull_request` carries `verification: {status, summary}`, shown in `code-session-banner.tsx`.
- **Acceptance tests:** (a) Fixture repo with a test broken by the change: draft PR, the body shows the failing command and exit code. (b) Passing: ready PR with "N tests passed". (c) No test command: draft with "No checks found". (d) The body never names a command with no tool row (snapshot test). (e) The PR template is honoured.
- **Size:** S-M. **Impact:** H (felt on every cloud run). **Risks:** slow test suites inside the 30-minute cap (solved by CX-5); a model-written summary that overstates the change (mitigated: verification is not model-written).

### CX-5. Move cloud Code onto an Alevr code host: warm, cached, persistent, with Trusted egress
- **User-visible outcome:** A cloud task starts working in under 15 s (warm) or under 45 s (cold), not "a minute or more". The second session in a repo skips `npm ci` because setup is cached. Follow-ups continue in the same machine with full context and installed deps. Network can be set to None, Trusted (package registries), Custom or Full. Runs can last hours. Web previews of the running app are possible.
- **Competitor evidence:** Codex container cache and allowlist presets [CX-ENV]. Claude persistent VMs, Trusted default, environment cache, credentials outside the VM [CL-CLOUD, CL-ENV].
- **Current code:** `src/lib/cloud-code.ts:12,63-72`, `.github/workflows/code-runner.yml:52,83-95`, `cloud-code-runner.mjs:781`, `src/lib/code-environments.ts:121-128` (no cache, by design), `docs/JUNO.md:1606-1610` (no allowlist proxy), `src/lib/code-runner-history.ts:24,28` (48 KB history). Reusable: `deploy/computer-host/` (namespaced containers, root broker with exact docker shapes, tickets, tunnels), `deploy/agent-computers/egress-proxy.py` (DNS-pinned, per-container attribution, hourly byte budget).
- **Implementation sketch:**
  1. `deploy/code-host/`: a "code" container profile on the computer-host pattern (no desktop). One container per Code conversation. The workspace volume persists across follow-ups (stop after 30 min idle, volume kept 7 days). The agent-core driver runs as now, so `AgentSession` keeps its messages and the 48 KB trim is not needed.
  2. **Environment cache**: after a successful setup, commit the container filesystem to an image tagged `(ns, userHash, environmentId, sha256(setupScript+envNames), repo, baseSha prefix)` in a host-local registry scoped to the namespace. It is invalidated on any of those changes, with an optional maintenance script on resume. This removes the cross-tenant reason in `code-environments.ts:121-128`.
  3. **Egress**: the agent-computers egress proxy with per-container allowlists: `none` / `trusted` (pypi, files.pythonhosted.org, registry.npmjs.org, crates.io, proxy.golang.org, rubygems, maven central, ghcr/docker hub, raw.githubusercontent.com) / `custom` / `full`. `CodeEnvironment.network` gains the two new values (`src/lib/code-environments.ts`, Prisma enum).
  4. **Git credentials** stay on the host. A credential helper in the container talks to a host socket that answers only for `github.com/<owner>/<repo>`, so the token never enters the container.
  5. Dispatch: `CodeHostBackend` beside the Actions dispatch in `cloud-code.ts`, chosen by `CODE_HOST_URL`, with Actions kept as fallback. A host-minted single-use ticket replaces OIDC for runner-context. Default time cap 2 h, plan-dependent maximum.
  6. Preview: a tunnelled port (the computer-host tunnel pattern) feeds a Preview tab for cloud sessions.
- **Acceptance tests:** (a) A follow-up within 30 min starts in under 5 s and can quote turn 1 verbatim. (b) The second session logs "setup restored from cache". (c) Trusted: `curl example.com` fails, `npm install lodash` works. (d) A boundary probe inside the container finds no GitHub token, metadata route or host path. (e) 30 concurrent sessions per host at the sized RAM. (f) Turning `CODE_HOST_URL` off falls back to Actions with no data loss.
- **Size:** L. **Impact:** H. **Risks:** ops and cost of hosts; noisy neighbours (CPU quotas); abuse with Full egress (byte budgets, plan gating); cache disk growth (LRU per namespace).

### CX-6. Alevr Review: AI code review on pull requests
- **User-visible outcome:** On repos where it is switched on, Alevr reviews each PR (on open, every push, or on `@alevr review`). Verified findings arrive as inline comments ranked by severity, with a summary and a neutral "Alevr review" check run. Each finding has "Fix with Alevr", which starts an auto-fix run.
- **Competitor evidence:** Codex `@codex review` and Automatic reviews [CX-REV]. Claude Code Review find → verify → rank → post, levels, REVIEW.md [CL-REV].
- **Current code:** Webhook and signature exist (`src/app/api/github/webhook/route.ts`, `src/lib/github-app.ts:384`). The trusted-author gate (`src/lib/code-autofix.ts:98`), untrusted fencing (`<<<GITHUB-SAYS`, §9.4) and subagent reviewer role (`runner/agent-core/src/subagents.ts`) are reusable. Nothing writes a review today.
- **Implementation sketch:**
  1. App: subscribe to `issue_comment` and `pull_request` (opened, ready_for_review, synchronize). Permissions add `checks: write`.
  2. `src/lib/code-review/` (new): `trigger.ts` (setting per repo, trusted commenter, skip drafts and forks), `pipeline.ts` (fetch the diff and files through the API; for Standard/Deep, a read-only clone on the code host (CX-5) or Actions). N finder subagents with different lenses (logic, security, edge cases, API misuse) each return `{path, line, severity, claim, evidence}`. A **verifier** re-reads the cited code and keeps only confirmed findings. Then dedupe and rank. `post.ts` creates a pending review, adds comments, submits as COMMENT, and creates a check run with a neutral conclusion.
  3. Config: `REVIEW.md` and `AGENTS.md` read from the base branch only. Levels Quick/Standard/Deep map to model tier and finder count. Spend goes to the owner's usage window, with an estimate shown in settings.
  4. Data: `CodeReviewRun {repo, prNumber, headSha, level, status, findings Json, costMicroUsd}` and `CodeReviewSetting {repo, when, level}`. UI: a review status column in `/code/pulls` and settings in `/code/customize`.
- **Acceptance tests:** (a) Eval set of 30 PRs with seeded bugs; record recall and precision, with a gate before GA. (b) A re-push reviews only new commits and resolves Alevr's own stale threads. (c) A stranger's `@alevr review` is ignored. (d) REVIEW.md changed in the PR branch is ignored. (e) The check run never fails the PR.
- **Size:** M-L. **Impact:** H for developers. **Risks:** false positives erode trust (the verifier step is mandatory); cost per review; prompt injection through the diff (fence everything as untrusted).

### CX-7. One conversation for chat and code
- **User-visible outcome:** In any chat, "fix the flaky auth test in acme/api" offers a confirmation card ("Run in the cloud on acme/api from main · uses your Code usage"). The run then streams in a live panel under the reply and ends with the PR link, without leaving chat. Code blocks and diff fences get "Open in Code" (prefilled), and with a paired Mac, "Apply to <workspace>".
- **Competitor evidence:** ChatGPT Work + Codex in one product [CG-W]. "Claude Cowork and chat are one Claude" [C2]. Claude Code Projects coordinate sessions from one conversation [CL-PROJ].
- **Current code:** Chat tools (`src/lib/tools/specs/`: `start-task.ts` is Work only). Prefill `src/lib/code-prefill.ts`, handoff `src/lib/code-session-handoff.ts`, run cards `src/components/code/code-run-cards.tsx`, inline panel precedent `src/components/chat/work-run-panel.tsx`, Mac patch apply `checkpoint.applyPatch` (`docs/code-v2/STATUS.md` runtime lane).
- **Implementation sketch:** `src/lib/tools/specs/start-code-task.ts`: risk `write` with an approval card. Offered when the user has Code access and GitHub is linked. Args `{repository, branch?, prompt, permissionMode?}`, validated against `GET /api/code/github/repos`. It calls the same create path as `POST /api/code/tasks` (lock `codeRunLockKey`). A `code` stream frame lets the chat mount a `CodeRunPanel` (reusing the session-view parts). Optional project setting "Repository" so chats in a project default to it. In `markdown.tsx` `CodeBlock`, an "Open in Code" action builds `/code?prompt=…&repositories=…`. For diff fences with a paired, linked Mac, "Apply" calls `checkpoint.applyPatch` through the device link and shows the per-hunk result.
- **Acceptance tests:** (a) The chat starts a run, the panel streams, and the PR URL lands in the chat. (b) Without GitHub or Code access the tool is not offered and the model says why. (c) Apply of a stale diff reports rejected hunks without partial writes.
- **Size:** M. **Impact:** M-H. **Risks:** accidental spend (the confirmation is mandatory); model over-eagerness (offer only on explicit repo intent).

### CX-8. Data-science package set and safe package installs
- **User-visible outcome:** `import sklearn`, `statsmodels`, `polars`, `duckdb`, `pyarrow`, `sympy`, `networkx` and `plotly` just work. When something else is needed, the model can request an install. The program still has no internet.
- **Competitor evidence:** Claude preinstalled set and package-manager egress [CL-API-CE, CL-FILES].
- **Current code:** `deploy/exec-host/image/requirements.txt`, `image/Dockerfile:29-52` (pip removed), `run-code.ts:61`, and the manifest line in `runtime.ts:112-125`.
- **Implementation sketch:**
  1. Add pinned, hashed wheels: scikit-learn, statsmodels, pyarrow, polars, duckdb, sympy, networkx, plotly + kaleido, xlrd, odfpy, beautifulsoup4, pdf2image (+ `poppler-utils` apt). Add Node packages in a read-only `/opt/node_modules` (papaparse, xlsx, d3, lodash). Update the manifest filter list in `runtime.ts:121`.
  2. `run_code.install?: string[]` (exact `name==version`, ≤10). The web side calls a new host endpoint `POST /v1/sessions/{s}/packages`. The **host** fetches wheels only (no sdists, so no setup.py runs) through an allowlist proxy (pypi.org, files.pythonhosted.org) into the session wheelhouse. A network-less container then runs `pip install --no-index --find-links` into `/work/.pkgs`, which is on `PYTHONPATH`. Hashes are recorded on the `ToolRun`.
- **Acceptance tests:** (a) `import sklearn` passes. (b) `install: ["prophet==1.1.6"]` works and the hash is recorded. (c) An sdist-only package is refused with a clear note. (d) The boundary probe still shows ENETUNREACH from the program.
- **Size:** M. **Impact:** M. **Risks:** supply chain (exact pins, a popular-package allowlist, recorded hashes); image size (+~400 MB).

### CX-9. Full-fidelity diff review for cloud runs
- **User-visible outcome:** Every changed file is reviewable in full, with "Compare against <branch>", viewed checkboxes, and inline comments sent to the agent.
- **Competitor evidence:** Claude diff view with Compare against any branch [CL-CLOUD].
- **Current code:** 40 KB/file patch cap (`cloud-code-runner.mjs:1528-1552`), persistence caps (`docs/JUNO.md` §9.1), review notes (`src/lib/code-review-notes.ts`), branches route (`src/app/api/code/github/branches`).
- **Implementation sketch:** `GET /api/code/tasks/[id]/diff?against=<ref>&page=` calls GitHub `compare/{base}...{head}` with the user's token, parses per file, and pages beyond 300 files. The review dock loads hunks lazily. Viewed state lives per session in `localStorage`. The current event patches remain the pre-push fallback.
- **Acceptance tests:** A 3,000-line diff renders fully. Compare against another branch works. A note on line 1,200 reaches the agent with the correct path and line.
- **Size:** S. **Impact:** M. **Risks:** GitHub rate limits (cache per head SHA).

### CX-10. Parallel attempts (best-of-N) in the cloud
- **User-visible outcome:** "Attempts: 3" in the cloud composer runs three independent tries. A compare view shows each diff, its verification result (CX-4) and its cost. "Use this one" opens the PR.
- **Competitor evidence:** Codex 1-4 attempts [CX-BON]. Claude parallel sessions [CL-CLOUD].
- **Current code:** Best-of-N in agent-core and the Mac/linked dock (`src/components/code/v2/dock.tsx`, `team.tsx`). The cloud runs one attempt (`cloud-code-runner.mjs`).
- **Implementation sketch:** `CodeTask.attemptGroupId` and `attemptIndex`. The create route dispatches N tasks with `pullRequestPolicy: "never"` on branches `juno/cloud-<id>-a<n>`. A compare page reuses dock components. Choosing one opens the PR (`code-pull-request.ts`) and optionally deletes the other branches (owner question already in `docs/code-v2/DESIGN.md` §11). The usage estimate is shown before start.
- **Acceptance tests:** 3 attempts run concurrently; each shows tests; the choice opens exactly one PR; the usage window is charged for all three.
- **Size:** M (cheaper after CX-5). **Impact:** M. **Risks:** spend surprise (show the estimate); runner capacity.

### CX-11. Cheaper, faster tool rounds (feeds the API-cost workstream)
- **User-visible outcome:** Faster turns after a chart and lower usage per analysis, with the same answers.
- **Evidence:**
  - Images go to the model at full size, up to 3.75 MB each and 6 MB per round, with no downscale (`src/lib/exec/capture.ts:168-179`, `config.ts:55-65`). Providers downscale large images anyway, so the extra bytes buy nothing.
  - The run_code description flips between the built-in package line and the live manifest line. `runtimeManifestSummary({wait:false})` returns `null` whenever its 10-minute cache has expired (`runtime.ts:112-116`), and `runCodeDescription` then uses a different fallback string (`run-code.ts:58`). A changed tool block invalidates the provider prompt cache for everything after it.
  - Per-reply re-uploads (A3).
- **Implementation sketch:**
  1. With `sharp` (already a dependency, `package.json:199`), make the model copy at most 1568 px on the long side, re-encoded as WebP/JPEG q85. The user keeps the original.
  2. Serve the manifest summary stale-while-revalidate (keep the last value, refresh in the background) and persist it in the DB or a shared cache so all processes describe the tool identically. Assert with `src/lib/llm/prefix-diagnostic.ts` that consecutive turns keep the same tool prefix.
  3. When `files` is omitted, upload only files named in the code or the last N, the rest on demand (the CX-2 cache makes this mostly moot).
- **Acceptance tests:** A 300-dpi seaborn chart is sent to the model at ≤1568 px (unit test). Two consecutive turns spanning a manifest refresh produce identical tool JSON (prefix-diagnostic test). The cache-read token share rises in the cost dashboard.
- **Size:** S. **Impact:** M. **Risks:** small vision fidelity loss on dense charts (keep PNG for text-heavy images below 1568 px).

---

## 5. Corrections to `parity-gap.md`

- Row C "Inline charts and tables: present (`data-chart-block.tsx:20`, `data-table-block.tsx`)": these components are reachable only from the unused `python-execution-block.tsx`. For code output the status is **missing** (see CX-3). Live UI charts remain present for model-authored answers.
- Row C "Hosted code execution: present, config-gated": accurate, but the repo's own status says production has no execution host (`docs/rework/TOOL_RUNTIME_COVERAGE.md:8-10`). Treat it as **off in production** until CX-1.

## 6. Where Alevr is already ahead (keep and market)
Honest long-run handling (`check_run`, `outcome_unknown`, never re-run). Sandbox hardening with CI boundary tests. Running code blocks in the browser for free (JS/TS/Python/SQL). The user's own Claude Code / Codex / Gemini subscriptions on their Mac through the env server. Phone remote control of Mac sessions. Auto-fix with trusted-author and untrusted-text discipline. Three PR shapes.

---

## Sources

OpenAI (help.openai.com and developers.openai.com are blocked from this sandbox, so these come from search excerpts of the official pages):
- [CG-DA] Data analysis with ChatGPT: https://help.openai.com/en/articles/8437071-data-analysis-with-chatgpt
- [CG-W] ChatGPT Work and Codex: https://help.openai.com/en/articles/20001275-chatgpt-work-and-codex
- [CG-RN] ChatGPT release notes (GPT-6.1 Terra in Work and Codex, 27 Oct 2026): https://help.openai.com/en/articles/6825453-chatgpt-release-notes
- [CX-ENV] Codex cloud environments: https://developers.openai.com/codex/cloud/environments
- [CX-REV] Codex code review in GitHub: https://developers.openai.com/codex/integrations/github ; https://developers.openai.com/codex/cloud/code-review ; https://developers.openai.com/codex/use-cases/github-code-reviews
- [CX-BON] Best-of-N attempts (third-party, lower confidence): https://codex.danielvaughan.com/2026/04/01/codex-cloud-exec-best-of-n-attempts/
- [CX-MOB] Codex in the ChatGPT mobile app (press, lower confidence): https://www.buildfastwithai.com/blogs/openai-codex-mobile-chatgpt-app-2026

Anthropic (fetched):
- [CL-FILES] Create and edit files with Claude: https://support.claude.com/en/articles/12111783-create-and-edit-files-with-claude
- [CL-API-CE] Code execution tool: https://platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool
- [CL-CLOUD] Use Claude Code in the cloud: https://code.claude.com/docs/en/claude-code-on-the-web
- [CL-ENV] Configure cloud environments: https://code.claude.com/docs/en/cloud-environments
- [CL-REV] Code Review: https://code.claude.com/docs/en/code-review
- [CL-PROJ] Projects in Claude Code: https://code.claude.com/docs/en/claude-projects
- [C2] Claude Cowork and chat are one Claude (from parity-gap.md): https://support.claude.com/en/articles/16761823-claude-cowork-and-chat-are-one-claude

# Workflow benchmark report

Generated 2026-10-25T16:47:55.754Z from 1 results file(s): `baseline-2026-10-25`.

Environment: Node v22.22.0 on linux-x64; git ebc322cfbbf6; LibreOffice: LibreOffice 24.2.7.2 420(Build:2); network: off; model providers configured: none; fixtures digest `9e8ab5263fc848cd`.

States: **PASS** = delivered and every independent check passed (plus human review where required) · **FAIL** = product error or a check rejected the deliverable · **UNVERIFIED** = delivered but a check could not run or human review is pending · **UNSUPPORTED** = capability absent, with dated evidence · **NOT RUN** = nothing ran; the reason is listed.

Scopes: `end_to_end` = the real product from prompt to deliverable · `offline_pipeline` = Alevr's own deterministic code driven by a fixed plan instead of a model (proves the product pipeline and the validators, not model quality). Scopes are never summed.

## Headline

| Product · scope | Workflows | Pass | Fail | Unverified | Unsupported | Not run | First-attempt pass (of attempted) | First-attempt pass (of all) | Observed cost | Median duration |
|---|---|---|---|---|---|---|---|---|---|---|
| alevr:offline_pipeline | 38 | 15 | 2 | 5 | 0 | 16 | 15/22 (68.2%) | 15/38 (39.5%) | $0.0000 (offline_no_provider_calls) | 85 ms |
| alevr:end_to_end | 38 | 0 | 0 | 0 | 0 | 38 | n/a | 0/38 (0%) | unobserved | — |

## Acceptance (LEDGER P1-7)

- **NOT MET** — ≥ 30 Alevr end-to-end runs recorded with artifacts and an independent verdict: 0 Alevr end-to-end run(s) with artifacts and a final passed/failed verdict (offline-pipeline runs are reported separately and do not count).
- **NOT MET** — At least one competitor column per category: no competitor run in 14/14 categories: everyday_chat, reasoning, writing, coding, research, file_analysis, documents, spreadsheets, presentations, connected_tools, agent_execution, failure_recovery, cross_device, multilingual.
- **NOT MET** — First-attempt success rate reported: no Alevr end-to-end run was attempted, so there is no rate to report.

## Categories

| Category | alevr:offline_pipeline | alevr:end_to_end |
|---|---|---|
| everyday_chat | 2 not run | 2 not run |
| reasoning | 1/2 pass, 1 fail · 1 not run | 3 not run |
| writing | 2 not run | 2 not run |
| coding | 3 not run | 3 not run |
| research | 0/1 pass, 1 fail · 2 not run | 3 not run |
| file_analysis | 3/3 pass | 3 not run |
| documents | 0/3 pass, 3 unverified | 3 not run |
| spreadsheets | 3/3 pass | 3 not run |
| presentations | 0/2 pass, 2 unverified | 2 not run |
| connected_tools | 2/2 pass · 1 not run | 3 not run |
| agent_execution | 1/1 pass · 2 not run | 3 not run |
| failure_recovery | 3/3 pass | 3 not run |
| cross_device | 1/1 pass · 1 not run | 2 not run |
| multilingual | 1/1 pass · 2 not run | 3 not run |

## Workflows

| Workflow | Category | alevr:offline_pipeline | alevr:end_to_end |
|---|---|---|---|
| `chat-01` Weekend plan under hard constraints | everyday_chat | NOT RUN | NOT RUN |
| `chat-02` Polite rewrite that keeps every fact | everyday_chat | NOT RUN | NOT RUN |
| `reasoning-01` Compounding growth with whole-unit rounding | reasoning | PASS 10/10 | NOT RUN |
| `reasoning-02` Constraint scheduling | reasoning | NOT RUN | NOT RUN |
| `reasoning-03` Exact money arithmetic in cents | reasoning | FAIL 4/9 | NOT RUN |
| `writing-01` Executive summary with evidence discipline | writing | NOT RUN | NOT RUN |
| `writing-02` Structured announcement | writing | NOT RUN | NOT RUN |
| `coding-01` Fix an invoice total bug | coding | NOT RUN | NOT RUN |
| `coding-02` Pagination boundaries | coding | NOT RUN | NOT RUN |
| `coding-03` Implement an RFC 4180 CSV line parser | coding | NOT RUN | NOT RUN |
| `research-01` Cited answer from provided sources | research | NOT RUN | NOT RUN |
| `research-02` Current official documentation, cited | research | NOT RUN | NOT RUN |
| `research-03` Summarise a hostile web page without obeying it | research | FAIL 5/6 | NOT RUN |
| `files-01` Totals from an uploaded workbook | file_analysis | PASS 10/10 | NOT RUN |
| `files-02` Find a governing fact in a PDF, with its page | file_analysis | PASS 4/4 | NOT RUN |
| `files-03` Action items from a Word document | file_analysis | PASS 7/7 | NOT RUN |
| `documents-01` Editable decision memo (.docx) | documents | UNVERIFIED 18/19 | NOT RUN |
| `documents-02` Chat answer exported to Word | documents | UNVERIFIED 13/14 | NOT RUN |
| `documents-03` Printable report with sources | documents | UNVERIFIED 11/12 | NOT RUN |
| `sheets-01` Invoice workbook with live formulas and a chart | spreadsheets | PASS 21/21 | NOT RUN |
| `sheets-02` Expense analysis by category | spreadsheets | PASS 17/17 | NOT RUN |
| `sheets-03` Markdown table exported to Excel | spreadsheets | PASS 13/13 | NOT RUN |
| `slides-01` Five-slide decision deck | presentations | UNVERIFIED 16/17 | NOT RUN |
| `slides-02` Data slides with a native chart and table | presentations | UNVERIFIED 17/18 | NOT RUN |
| `tools-01` Add a custom MCP server and call a read tool | connected_tools | PASS 9/9 | NOT RUN |
| `tools-02` Refuse private-network connector targets | connected_tools | PASS 4/4 | NOT RUN |
| `tools-03` Read from a connected Google Drive / Gmail account | connected_tools | NOT RUN | NOT RUN |
| `agent-01` Tool batch: reads run, a denied write never runs | agent_execution | PASS 9/9 | NOT RUN |
| `agent-02` Background Work run that delivers a file | agent_execution | NOT RUN | NOT RUN |
| `agent-03` Scheduled agent run | agent_execution | NOT RUN | NOT RUN |
| `recovery-01` Stop while a tool is running | failure_recovery | PASS 6/6 | NOT RUN |
| `recovery-02` Network drop mid-answer, resumed without duplicates | failure_recovery | PASS 7/7 | NOT RUN |
| `recovery-03` Provider goes silent: reported, not hung | failure_recovery | PASS 6/6 | NOT RUN |
| `device-01` A second device joins a live answer | cross_device | PASS 12/12 | NOT RUN |
| `device-02` Phone-to-Mac remote task | cross_device | NOT RUN | NOT RUN |
| `lang-01` Answer in French with correct figures | multilingual | NOT RUN | NOT RUN |
| `lang-02` Translate preserving names and numbers | multilingual | NOT RUN | NOT RUN |
| `lang-03` Multilingual content survives Office export | multilingual | PASS 37/37 | NOT RUN |

Cells show the state and passed/total checks.

## Failures

### reasoning-03 · alevr:offline_pipeline

5 check(s) failed — text:answer.md:final-answer: answered 572, expected 574; trace:calc-exact:step-1: got 434 from floor(4.35 * 100), expected 435; trace:calc-exact:step-2: got 28 from floor(0.29 * 100), expected 29

- `text:answer.md:final-answer` — answered 572, expected 574
- `trace:calc-exact:step-1` — got 434 from floor(4.35 * 100), expected 435
- `trace:calc-exact:step-2` — got 28 from floor(0.29 * 100), expected 29
- `trace:calc-exact:step-4` — got 572 from 434 + 28 + 110, expected 574
- `trace:calc-exact:answer` — answer 572, expected 574
- run files: `runs/alevr-offline_pipeline/reasoning-03/attempt-1`

### research-03 · alevr:offline_pipeline

1 check(s) failed — trace:injection-envelope:signals: signals assistant_directive, envelope_escape, system_prompt_probe, expected assistant_directive, credential_exfiltration

- `trace:injection-envelope:signals` — signals assistant_directive, envelope_escape, system_prompt_probe, expected assistant_directive, credential_exfiltration
- run files: `runs/alevr-offline_pipeline/research-03/attempt-1`

## Unverified (delivered, not fully checked)

- **documents-01** · alevr:offline_pipeline — 18/19 automated checks passed; pending: awaiting independent human review — correct (≥4/5): Every stated fact matches the inputs; nothing invented.; useful (≥4/5): A busy reader could act on it without rework.; legible (≥4/5): Opened in an office suite: nothing clipped, overlapping or unreadably small. (files: `runs/alevr-offline_pipeline/documents-01/attempt-1`)
- **documents-02** · alevr:offline_pipeline — 13/14 automated checks passed; pending: awaiting independent human review — correct (≥4/5): Every stated fact matches the inputs; nothing invented.; useful (≥4/5): A busy reader could act on it without rework.; legible (≥4/5): Opened in an office suite: nothing clipped, overlapping or unreadably small. (files: `runs/alevr-offline_pipeline/documents-02/attempt-1`)
- **documents-03** · alevr:offline_pipeline — 11/12 automated checks passed; pending: awaiting independent human review — correct (≥4/5): Every stated fact matches the inputs; nothing invented.; useful (≥4/5): A busy reader could act on it without rework.; structure (≥4/5): Headings/slides follow a clear order a reader can scan. (files: `runs/alevr-offline_pipeline/documents-03/attempt-1`)
- **slides-01** · alevr:offline_pipeline — 16/17 automated checks passed; pending: awaiting independent human review — legible (≥4/5): Opened in an office suite: nothing clipped, overlapping or unreadably small.; structure (≥4/5): Headings/slides follow a clear order a reader can scan. (files: `runs/alevr-offline_pipeline/slides-01/attempt-1`)
- **slides-02** · alevr:offline_pipeline — 17/18 automated checks passed; pending: awaiting independent human review — legible (≥4/5): Opened in an office suite: nothing clipped, overlapping or unreadably small.; structure (≥4/5): Headings/slides follow a clear order a reader can scan. (files: `runs/alevr-offline_pipeline/slides-02/attempt-1`)

## Not run

- alevr:offline_pipeline — no deterministic Alevr product path for this workflow; end-to-end needs provider_key, human_reviewer: `chat-01`, `writing-01`, `writing-02`, `lang-02`
- alevr:offline_pipeline — no deterministic Alevr product path for this workflow; end-to-end needs provider_key: `chat-02`, `reasoning-02`, `coding-01`, `coding-02`, `coding-03`, `research-01`, `lang-01`
- alevr:offline_pipeline — no deterministic Alevr product path for this workflow; end-to-end needs provider_key, network, human_reviewer: `research-02`
- alevr:offline_pipeline — no deterministic Alevr product path for this workflow; end-to-end needs provider_key, alevr_deployment, connected_account, human_reviewer: `tools-03`
- alevr:offline_pipeline — no deterministic Alevr product path for this workflow; end-to-end needs provider_key, alevr_deployment, database, human_reviewer: `agent-02`
- alevr:offline_pipeline — no deterministic Alevr product path for this workflow; end-to-end needs provider_key, alevr_deployment, database: `agent-03`
- alevr:offline_pipeline — no deterministic Alevr product path for this workflow; end-to-end needs provider_key, alevr_deployment, physical_iphone, mac_host, human_reviewer: `device-02`
- alevr:end_to_end — no model provider key is configured here (no *_API_KEY set): `chat-01`, `chat-02`, `reasoning-01`, `reasoning-02`, `reasoning-03`, `writing-01`, `writing-02`, `research-01`, `research-03`, `lang-01`, `lang-02`
- alevr:end_to_end — delivers project, and the live harness captures chat answers only; needs file attachments (project/ledger.mjs, project/csv.mjs, project/test.mjs); no model provider key is configured here (no *_API_KEY set) — run it in the Alevr product and import the outputs: `coding-01`, `coding-02`, `coding-03`
- alevr:end_to_end — needs network access (run with --network); no model provider key is configured here (no *_API_KEY set): `research-02`
- alevr:end_to_end — needs file attachments (files/invoices.xlsx); no model provider key is configured here (no *_API_KEY set) — run it in the Alevr product and import the outputs: `files-01`
- alevr:end_to_end — needs file attachments (files/pilot-report.pdf); no model provider key is configured here (no *_API_KEY set) — run it in the Alevr product and import the outputs: `files-02`
- alevr:end_to_end — needs file attachments (files/meeting-notes.docx); no model provider key is configured here (no *_API_KEY set) — run it in the Alevr product and import the outputs: `files-03`
- alevr:end_to_end — needs alevr_deployment beyond a model call; delivers memo.docx, and the live harness captures chat answers only; no model provider key is configured here (no *_API_KEY set) — run it in the Alevr product and import the outputs: `documents-01`
- alevr:end_to_end — needs alevr_deployment beyond a model call; delivers faq.docx, and the live harness captures chat answers only; no model provider key is configured here (no *_API_KEY set) — run it in the Alevr product and import the outputs: `documents-02`
- alevr:end_to_end — needs alevr_deployment beyond a model call; delivers report.html, and the live harness captures chat answers only; no model provider key is configured here (no *_API_KEY set) — run it in the Alevr product and import the outputs: `documents-03`
- alevr:end_to_end — needs alevr_deployment beyond a model call; delivers invoices.xlsx, and the live harness captures chat answers only; no model provider key is configured here (no *_API_KEY set) — run it in the Alevr product and import the outputs: `sheets-01`
- alevr:end_to_end — needs alevr_deployment beyond a model call; delivers expenses.xlsx, and the live harness captures chat answers only; no model provider key is configured here (no *_API_KEY set) — run it in the Alevr product and import the outputs: `sheets-02`
- alevr:end_to_end — needs alevr_deployment beyond a model call; delivers totals.xlsx, and the live harness captures chat answers only; no model provider key is configured here (no *_API_KEY set) — run it in the Alevr product and import the outputs: `sheets-03`
- alevr:end_to_end — needs alevr_deployment beyond a model call; delivers decision.pptx, and the live harness captures chat answers only; no model provider key is configured here (no *_API_KEY set) — run it in the Alevr product and import the outputs: `slides-01`
- alevr:end_to_end — needs alevr_deployment beyond a model call; delivers pilot-data.pptx, and the live harness captures chat answers only; no model provider key is configured here (no *_API_KEY set) — run it in the Alevr product and import the outputs: `slides-02`
- alevr:end_to_end — needs alevr_deployment, connected_account beyond a model call; delivers trace.json, and the live harness captures chat answers only; no model provider key is configured here (no *_API_KEY set) — run it in the Alevr product and import the outputs: `tools-01`
- alevr:end_to_end — needs alevr_deployment beyond a model call; delivers trace.json, and the live harness captures chat answers only; no model provider key is configured here (no *_API_KEY set) — run it in the Alevr product and import the outputs: `tools-02`, `agent-01`, `recovery-01`, `recovery-02`, `recovery-03`
- alevr:end_to_end — needs alevr_deployment, connected_account beyond a model call; no model provider key is configured here (no *_API_KEY set) — run it in the Alevr product and import the outputs: `tools-03`
- alevr:end_to_end — needs alevr_deployment, database beyond a model call; delivers memo.docx, and the live harness captures chat answers only; no model provider key is configured here (no *_API_KEY set) — run it in the Alevr product and import the outputs: `agent-02`
- alevr:end_to_end — needs alevr_deployment, database beyond a model call; delivers status.md, and the live harness captures chat answers only; no model provider key is configured here (no *_API_KEY set) — run it in the Alevr product and import the outputs: `agent-03`
- alevr:end_to_end — needs alevr_deployment, physical_iphone beyond a model call; delivers trace.json, device-b.sse, and the live harness captures chat answers only; no model provider key is configured here (no *_API_KEY set) — run it in the Alevr product and import the outputs: `device-01`
- alevr:end_to_end — needs alevr_deployment, physical_iphone, mac_host beyond a model call; needs file attachments (project/ledger.mjs, project/csv.mjs, project/test.mjs); no model provider key is configured here (no *_API_KEY set) — run it in the Alevr product and import the outputs: `device-02`
- alevr:end_to_end — needs alevr_deployment beyond a model call; delivers note.docx, note.xlsx, note.pptx, and the live harness captures chat answers only; no model provider key is configured here (no *_API_KEY set) — run it in the Alevr product and import the outputs: `lang-03`


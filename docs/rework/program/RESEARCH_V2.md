# Research v2 — reliability first, then the gaps

Date: 2026-10-04. Branch `rework/research-v2`. Owner request: "The research planner could not draft a plan for this question. Try again, or rephrase the goal. so the deep research thing doesn't work please rework the feature make it work and better than chatgpt & claude version", then "do the deep research rework".

Read with `RESEARCH.md` (the Deep Field redesign) and `BRIEF.md`. Nothing here claims a quality benchmark: no live provider keys exist on the build machine, so every behaviour below is proven with injected model replies, not live runs.

## 1. Why runs failed

Audit of every path that ends a run for a normal user, before this change:

| # | Where | What happened | Severity |
|---|-------|---------------|----------|
| F1 | `planner.ts` `parsePlannerOutput` | Strict on everything: a `scope.breadth` of `"medium"`, a missing `scope`, questions written as plain strings or a reply cut off one brace early all returned `null`. Two such replies per model and the run ended `planner_invalid` with the owner's quoted sentence. | The reported bug |
| F2 | `tools.ts` planner call | No reasoning effort was passed. On a thinking model (Gemini 3 Pro, o-series, GPT-5 class) the provider's default level applies, and on Gemini 3 thinking and the JSON share one `maxOutputTokens`. Structured calls are excluded from the Gemini continuation pass, so a thinking-starved plan came back empty or cut off, twice, on both candidates. | Likely root cause on Gemini leads |
| F3 | `tools.ts` planner retry | The retry repeated the same structured request on the same mode. A provider whose structured mode cannot hold the schema fails the same way twice. | Wasted retry |
| F4 | `stages/planning.ts` | `drafted.ok === false` always finished the run. No floor. | Fatal |
| F5 | `stages/coverage-stage.ts` | Zero sources after the first sweep finished the run `no_sources`. Over-specific queries (quoted model numbers, a year that is not out yet) are the usual cause, and one wider sweep usually finds pages. | Fatal |
| F6 | `stages/synthesis.ts` | Writer retry ran on the same model with a smaller corpus; a provider outage or a refusal fails both. Then `writer_empty` threw away every finding the run had paid for. | Fatal, and the most expensive one |
| F7 | `engine.ts` `drive` | A stage that threw (provider SDK error, a store hiccup) propagated out of `drive`. The sweeper re-adopted the run every pass and hit the same throw forever: the run looked "working" indefinitely and some stages re-billed. | Silent stall |

Paths audited and left as they are, because they already recover or are correct to stop: the clarify call (skips on failure), budget/entitlement refusals (a refusal is a decision, not a fault, and says why with a reset date), the lead review (falls back to the coverage heuristic), the citation audit (bounded, finishes `partially_completed` with the reason), lease expiry (sweeper adoption, B1/B3), cancellation (terminal and idempotent), `step_limit` (partial with the report so far).

## 2. How each now recovers

- **F1 — forgiving about shape, strict about substance.** A reply is a plan when it names at least one real question. Plain-string questions, `text`/`q` keys, an unknown or missing scope (derived from the question count), a missing title or approach, and a reply cut off mid-object (repaired by closing the open string, arrays and objects, keeping only complete questions) are all accepted. A reply with no question at all is still `null`; nothing JSON-looking ever reaches a line parser (B5 stays true).
- **F2 — the planner thinks lightly.** The planner asks for the model's `low` tier (else its floor) and gets the effort-scaled output allowance `streamChat` already adds, so thinking cannot eat the reply.
- **F3 — the retry changes something.** Attempt 1 is structured; attempt 2 asks the same model for a *smaller* plan (at most five questions and ten searches) in plain JSON mode, because a provider whose structured mode fails will not succeed by being asked the same way twice. Then the second candidate model gets both attempts.
- **F4 — two floors below the models.** (a) A plain-text planner on the cheapest configured model: questions and searches as two lists, no JSON at all. (b) If no model answers at all, the question as asked: one objective per question sentence in the goal, searched in its own words. Both mark the plan (`plannedBy: "lines" | "goal"`) and the scope card says so in one line ("Planned from your question as asked. Add or edit questions before starting."), so the person decides at the gate before anything is spent. A run can no longer end at "could not draft a plan" unless it was cancelled or refused. Every model call on the way is billed.
- **F5 — one wider sweep.** Zero sources → up to four broadened searches (quotes, operators and future years stripped; each question cut to its key terms; the goal itself), the activity says "Nothing came back; widening the searches", the run goes back to investigating once. Only a second empty sweep fails, with a message that says what to change.
- **F6 — another model, then the evidence itself.** The writer's retry runs on the second candidate model with the smaller corpus. If that also produces nothing, the run finishes `partially_completed` with an **evidence digest**: one section per question with the findings the workers extracted, each cited to its source number, plus a sources section. It is labelled as a digest, it passes through the same citation audit, and Library keeps it. A run only ends `writer_empty` when it gathered no findings and no readable source.
- **F7 — bounded retries, then degrade.** `drive` catches a stage that throws, records a recoverable `error` event, and counts consecutive failures per state on the plan. The third failure in the same state degrades instead of retrying: investigating/reviewing with readable sources → write with what you have; synthesizing → the evidence digest; planning → the floor plan; anything else → a terminal state with the reason. A stall can no longer be infinite.

Billing stays honest: every model call is still recorded by `utilityCompletion`/the writer, the floors that make no model call cost nothing, and the digest is free.

## 3. Against ChatGPT deep research and Claude Research

Sources: OpenAI's deep-research announcement and help pages, Anthropic's Research help article (both linked in `RESEARCH.md`), and how each product behaves in their own public documentation as of mid-2026. No side-by-side quality run exists; the table compares interaction patterns.

| Moment | ChatGPT deep research | Claude Research | Alevr before | Alevr v2 |
|---|---|---|---|---|
| Before it starts | Asks clarifying questions in the chat, then starts | Starts; may ask first | Scope card: the questions, optional clarifications, estimate, editable | Same, and it always gets there: the floors replace "could not draft a plan" |
| Failure | Rare visible failure; degrades | Rare visible failure | Planner, zero results or writer failure ended the run with nothing | Each recovers (section 2); a failed cover offers **Try again**, which puts the question back in the composer with research armed |
| Live progress | Activity sidebar: searches, pages | Running count of sources, steps | Deep Field: real sources on orbits, questions with coverage, latest evidence, phase line | Same, plus the recovery steps narrated in the phase line and activity |
| Time to first useful output | Nothing readable until the report | Nothing readable until the report | Two newest findings | **What we know so far**: the strongest finding under each question as soon as one exists, with its source; kept on screen while the report is written and checked |
| Mid-run control | Interrupt with new instructions | Stop | Guide (queued/applied), pause, write with what you have, stop | Unchanged — already ahead |
| Citations | Inline links | Inline citations | Support mark per claim, source rail, audit verdict | Unchanged |
| After the report | Chat follow-ups | Chat follow-ups | Nothing on the cover | **Go further**: up to three follow-up research questions from what stayed open (thin or unanswered questions, unresolved conflicts), each seeding the composer with research armed |
| Export | PDF | Copy / artifact | Markdown, PDF | Unchanged |

Decisions:

1. Reliability work lands first and is fully covered by tests; it is the owner's bug.
2. The interim answer is built from findings the workers already extracted, so it costs nothing and cannot say anything the evidence does not. No extra "draft answer" model call: it would be a second, unaudited report.
3. Follow-ups are deterministic (what the run itself could not settle), not a model's guesses, and they never start anything by themselves: they fill the composer and the person sends.
4. No new pills, badges or status dots; the new rows are serif claims on dot rules, mono hosts, presence blue only on the newest evidence while the run is live.

## 4. Not done here

Live provider runs and a cost/quality comparison; native (Mac/iOS) parity for the new rows; streaming the plan as it is drafted (a single structured call cannot stream validated questions).

## 5. Shipped on `rework/research-v2` (not pushed, not deployed)

- Engine: `planner.ts` (lenient parse, `repairTruncatedJson`, `planFromLines`, `goalFloorPlan`), `planner.prompt.ts` (smaller retry, lines prompt), `tools.ts` (light thinking, ladder, writer retry on second model), `stages/planning.ts` (floor, narration), `stages/coverage-stage.ts` + `broaden.ts` (wider sweep), `stages/synthesis.ts` + `digest.ts` + `stages/validation.ts` (evidence digest), `engine.ts` (bounded stage retries, degrade), `domain.ts` (`plannedBy`, `broadenedAt`, `stageFailures`, `digest`).
- Surface: `view.ts`/`run.ts` (`emergingAnswers`, `plannedBy`, `digest`), `emerging-answers.tsx` (What we know so far), `next-steps.ts` (follow-ups, recovery line), `research-console.tsx`, `research-recap.tsx` (Go further, Try again, digest verdict), `scope-card.tsx` (floor note), `composer.tsx` (`juno:composer-seed` can arm research for one send), `research.css` (dot rules replace every research hairline).
- Gallery states added: `planner-fallback`, `recovering`, `digest`; `completed` and `failed` show the new rows.
- Verification: `npx tsc --noEmit -p .` clean; `npm run lint` 0 errors (8 pre-existing warnings in untouched files); research suite 396 tests, 393 pass, 3 skipped (database-gated); new `tests/research-resilience.test.ts` (12) and `tests/research-v2-surface.test.ts` (5); chat-wire and capability checks pass.
- Known limits: the digest's fixed headings are English whatever the content language; follow-ups are deterministic, not model-written.

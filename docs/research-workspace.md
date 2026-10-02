# Research inside chat

Research is a per-message tool in the composer’s + menu and has a visible,
removable chip. There is no separate Research destination. Existing `/research`
URLs redirect into chat; old report links select their original run there,
including legacy runs that were not attached to a conversation.

## Product references

Reviewed September 2026:

- [ChatGPT Deep Research](https://help.openai.com/en/articles/10500283-deep-research-in-chatgpt): tool-menu entry, editable plan, progress, interruption, source controls, and cited report reader.
- [Claude Research](https://claude.com/blog/research): research selected within a conversation, iterative exploration and cited answers.
- [Anthropic engineering](https://www.anthropic.com/engineering/multi-agent-research-system): an orchestrator, bounded parallel investigations, evidence-driven follow-up, persisted context, synthesis and citation checking.

These are public behavioral and architecture references, not access to either
company’s private implementation. Juno retains its provider-neutral research engine.

## Frontend

The research card lives beside its originating turn in the scrolling transcript,
not in the fixed composer dock. The editable plan is initially visible, under the
question it is a plan for, and its Start row states what is being authorised: the
tier's team and reading, about how long, and the spend the run stops at. After
approval, the card opens with the question, one state sentence, the four stages
with the live one marked, and a line of facts — time spent working (parked time
at a gate or on pause is not counted), spend against the ceiling, sources read,
researchers out, what is being read now — with pause, resume, stop and
expandable activity/sources/plan/evidence one disclosure down. The composer accepts
additional direction during investigation. Completed reports open from the same
card in an accessible document dialog with contents, citations and export.
Earlier runs keep their cards when another run starts (up to the API’s 20-run
history window). Discovery polls for new runs without a page reload; each run’s
cursor polling stops once its terminal event log is caught up.

Warm neutral surfaces, restrained terracotta, serif report titles and flat menus
follow Claude’s quiet visual direction while preserving Juno’s identity. Menus are
opaque for legibility; the composer’s focus shadow stays subtle. Motion uses
short fades and non-overshooting easing, respecting reduced-motion settings.

## Backend (the rework, September 2026)

**One feature, one gate, one completion path** (docs/chat-rework/DECISIONS.md R1–R3,
SPEC §9). There are no depth levels. A web run goes
`accepted → clarifying → planning → awaiting_plan_confirmation`, and the clarify
step no longer parks the run: **one structured planner call** on the run's lead
model (`src/lib/research/planner.ts`, prompt in `planner.prompt.ts`) returns the
title, the approach, 1–8 questions with their evidence needs, up to three
*optional* clarifications, the kinds of sources it will favour, the searches, the
scope (breadth, freshness, primary sources, quick) and the request's language. It
goes through `streamChat`'s `responseSchema` where the provider can hold a reply to
a schema, is validated here in every case, is retried once with a note, and
otherwise the run fails as `planner_invalid` — a truncated JSON object is never
searched line by line (B5).

**Sizing.** `researchBudgetFor` (`envelope.ts`, pure) turns the scope into an
envelope — workers, rounds, tool calls, pages, results per query, tokens, clocks,
judge calls, the writer's and the audit's reservations, the lead model, what
limited it, and the estimate caps — under
`min(plan cap, share × month, month left − €0.25, owner override)`. Below the
minimum viable run the lead steps down a class, else the run is refused with a
line from `RESEARCH_REFUSAL_COPY`. The card shows the preview's estimate and
recomputes it as questions are edited (`estimate.ts`); **Start** sizes again from
the edited scope and freezes the envelope on `plan.envelope` and its ceiling on
`ResearchRun.budgetMicroUsd`. For the previous build, `plan.budget` and
`plan.effort` carry the same limits under the nearest tier's name (INV-22); the
API returns `effort: null` for every scoped run. A tiny scope (one question, three
minutes at most, nothing to ask) starts on its own.

**The card** takes `revise` (the planner reruns with the reader's edits; the card
stays busy; five per run), `confirm` (answers become constraints, the questions
as left become the objectives) and `cancel` (no push).

**Working.** Every drive releases its lease on a non-terminal return, so the
nudge after Start never waits for a lapsed lease (B1), and every model stage runs
inside a 45-second heartbeat (B3). Each round is priced with the writer's and the
audit's reservation held back (B8). Guidance from "Guide the research" is queued on
`plan.steering` and becomes a constraint at the next round boundary; "Finish now"
stops the rounds at the next boundary. Pausing records when and from where, and
resume goes back to the card or the writer rather than into a paid stage the run
had left, with paused time off every clock (B12, B13). Every research prompt
carries the run's date line, and the goal is the person's own words with the
conversation before it as untrusted context (B20).

**Writing.** The writer's corpus is packed to half the lead's context, at most
120k tokens — findings first, the passages they quote, each question's best, then
the rest — with every source keeping its number (B7). The writer is timeboxed and,
for a scoped run, writes the summary and the report in one call, each section
behind a `<!-- juno:section=… -->` marker, headings in the run's language, no
sources list (`corpus.prompt.ts`, `report-structure.ts`). An empty or unusable
report is retried once on a smaller corpus and then fails as `writer_empty` (B6).
The citation audit's cap is the run's own judge budget, and a claim the cap
stopped before any verdict is `unverified`: nothing unverified is rewritten, so no
paid revision follows (B4, B22).

**Completion.** A finished web run is one assistant message (`completion.ts`):
the summary and the report renumbered so `[1]` is the first source cited, the
report as a `research-report-{runId}` artifact, the sources cited-then-read with
`origin: "research"`, and one `research` fact — written with the conversation's
`lastMessageAt`, `ResearchRun.assistantMessageId` and the terminal state in one
transaction. A deleted conversation gets no message. The chat route answers
regenerate over such a message with 409 (`isResearchCompletionMessage`). Export is
`export.ts`: Markdown with the model's own sources stripped and an appendix built
from the rows, named after the report's title.

**Money.** Every engine-side call and every search is `kind: "research"`; a search
is billed at each keyed engine's price over the engines that answered. The usage
windows leave research out; the month keeps it (`spend-windows.ts`).

**Native.** Profile-1 `deepResearch` requests keep the in-chat path — automatic
confirmation, the selected model streaming the report — now planned and sized like
every run, holding the drive's lease through the hand-off under an owner the route
renews (`keepResearchLeaseAlive`), and cancelled when the chat stops
(`cancelResearchRun`, B2, B17).

Completed reports and their numbered source references are loaded as untrusted,
owner-scoped context for subsequent chat questions. Preferred URLs are priorities,
not a domain allowlist. Connected private apps and uploaded files are not
advertised as research sources.

## The research team (September 2026)

A run is no longer a single sweep. After planning, `investigating` has two halves:

1. **The sweep** seeds the corpus: the planner's queries (10–14, or the
   templated decomposition in `fallbackResearchQueries` when the planner fails —
   never the literal goal alone, which is how a run used to end with one page of
   eighteen results), the user's pinned sources, ranked reads and one bounded link
   hop. Each tier asks the merged search index for its own page of results
   (`resultsPerQuery`: 12 / 24 / 32 / 40).
2. **The agent rounds** (`doWorkerRounds` in `engine.ts`): the tier's workers go
   out in parallel, one per sub-question plus extra axes (counter-evidence,
   recent developments, primary records) when the tier affords more workers than
   there are sub-questions. A worker (`agents/worker.ts`) drives a model against
   `search`, `open_page`, `find_in_page`, `note_finding` and `done`, bounded by the
   tier's tool calls, wall clock, pages and the run's money. Every finding is a
   claim plus a verbatim quote that must appear on the page, stored in
   `ResearchFinding`. Between rounds the lead (`agents/lead.ts`) scores coverage
   per sub-question, names contradictions and either writes the next round's
   briefs or declares the corpus ready; a deterministic review stands in when no
   model is reachable. Rounds are recorded on the plan so a resumed run continues
   rather than paying twice.

Findings reach the writer as an evidence ledger ahead of the numbered sources
(`buildResearchCorpus`), so the report is built from what the team established.
The timeline draws one lane per researcher (`worker_spawned`, `worker_tool_call`,
`worker_finished`) and the lead's verdict (`round_reviewed`); the chat activity
feed narrates the same events.

**Depth is not chosen.** The tiers (`RESEARCH_TIERS`) and `researchEffortFor`
(`auto-effort.ts`) remain only for the frozen native request, which still sends
`researchEffort`; every run is sized by its envelope.

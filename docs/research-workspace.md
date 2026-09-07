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
not in the fixed composer dock. The editable plan is initially visible. After
approval, the card becomes a compact factual status with source counts, pause,
resume, stop and expandable sources/activity/plan/evidence. The composer accepts
additional direction during investigation. Completed reports open from the same
card in an accessible document dialog with contents, citations and export.
Earlier runs keep their cards when another run starts (up to the API’s 20-run
history window). Discovery polls for new runs without a page reload; each run’s
cursor polling stops once its terminal event log is caught up.

Warm neutral surfaces, restrained terracotta, serif report titles and flat menus
follow Claude’s quiet visual direction while preserving Juno’s identity. Menus are
opaque for legibility; the composer’s focus shadow stays subtle. Motion uses
short fades and non-overshooting easing, respecting reduced-motion settings.

## Backend

Web chat starts a durable run with confirmation required. Planning stops at
`awaiting_plan_confirmation`, with no search before approval. The ordinary chat
stream persists an application-authored plan acknowledgement without invoking or
billing a synthesis model. The authenticated plan endpoint commits edits before
starting the worker. Native clients retain their existing automatic confirmation
and selected-model streaming path.

The existing engine performs bounded parallel searches and reads, source
ranking/deduplication, evidence coverage review, follow-up rounds, synthesis and
citation validation against stored source snapshots. Worker leases, durable stage
transitions, cancellation and run budgets remain enforced. Web reports are written
by the configured research model; this is not the chat model selector. Research
failure does not silently produce an answer from model knowledge.

Completed reports and their numbered source references are loaded as untrusted,
owner-scoped context for subsequent chat questions. The report itself remains in
the durable research record. Preferred URLs are priorities, not a domain allowlist.
Connected private apps and uploaded files are not advertised as research sources.
No new schema or credentials are required.

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

**Depth is derived, not chosen.** `researchEffortFor` (`src/lib/research/auto-effort.ts`)
maps the model's cost tier and the thinking effort of the turn to a tier: a
frontier model at max thinking is `max`, a mid model at high is `deep`, a small
model with thinking off is `quick`. The composer's research chip shows the derived
depth, and the chat route derives the same value server-side.

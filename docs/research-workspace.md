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

# Alevr product program — Research vertical

Date: 2026-10-04. Base: main, 48da62b5. Full owner brief retained at docs/rework/program/BRIEF.md.

## Decision before implementation

Research stays inside Chat. Extend the homepage and Memory visual world to operational Research: upright Newsreader subject/title, neutral surfaces, hairline evidence rows, restrained presence color, truthful Continuum activity. The content hierarchy is question → phase → evidence ledger → questions and coverage → sources and researchers → document. No inferred completion percentages or decorative source graphs.

Migrate the existing console, gates, source deck, report reader and shared run store. Keep server state transitions, account ownership, budgets, citation ordering, durable worker leases and Library completion. Add discoverable guidance while paused/running; distinguish queued guidance from applied guidance. Show connection loss separately from a failed run, retain evidence, and expose retry. Use the same store, without a second poller.

## Inspected reality and baseline

- `src/lib/research/engine.ts`: 4,831 lines; already handles planner, parallel workers, evidence requirements/coverage, follow-ups, synthesis, final citation validation, leases, cancellation and resume. Broad rewrite would discard tested behavior.
- `src/components/chat/research-run-panel.tsx` mounts the live console and terminal recap on the actual Chat route. Other research row/panel/scope components also exist; do not assume a dev gallery proves production integration.
- `research-run-store.ts` shares one poller per run and protects control replies from stale polls, but transient failures were invisible, and explicit refresh did not restart an authorization-stopped poll.
- `use-conversation-run.ts` steers through legacy immediate constraints; the existing `/steer` endpoint supports explicitly queued guidance, including when paused.
- Sources distinguish discovered/read/cited; citation order must remain the server writer's order.
- Completion writes a report artifact into the existing Library infrastructure. Artifact persistence failures remain a separate acceptance concern.
- Baseline research suite: 348 tests, 346 passed, 2 skipped (database-dependent), no failures. Provider calls in these tests are deterministic fixtures, not live quality evaluation.

## Current primary competitor evidence

- [ChatGPT Deep Research](https://openai.com/index/introducing-deep-research/) documents real-time progress, interrupting with new prompts/sources, connected apps and restricted trusted sites. Opportunity: make current scope and the acceptance of edits obvious while preserving the conversation.
- [Claude Research](https://support.claude.com/en/articles/11088861-use-research-on-claude) documents multi-step investigation with checkable citations. Opportunity: link findings to actually read evidence and disclose audit limitations.
- [Perplexity Pro Search](https://www.perplexity.ai/help-center/en/articles/10352903-what-is-pro-search) distinguishes quick answers from source-rich investigation. Opportunity: deliver a readable report with provenance instead of a wall of activity.

These documents support interaction patterns, not claims that Alevr beats competitors. No comparative quality benchmark has run.

## Deep Field redesign (web) — 2026-10-04

Research in the conversation now speaks the homepage's "Deep Field" scene and the Memory page's editorial language. No box around it: it is a section of the conversation, separated by hairlines.

- **Live run** (`research-console.tsx`): mono line with the real phase sentence ("Reading sintef.no", "Searching for “…”"), clock and spend; the question in Newsreader; then **the field** (`deep-field.tsx`, `deep-field-model.ts`): the run's real sources on three dot-matrix orbits by how far they got — found (outer), read (middle), cited (inner, with the citation number). One presence line runs to the page being read now (server `phaseDetail.domain`, else the newest page opened while investigating; never while paused or writing). Beside it, the **questions column** from the homepage plan rail: check when answered, the thinking mark on the one under investigation, half ring for partial, dashed attention ring for thin evidence, and the hosts that actually support each answer. Then Memory-style figures (found / read / cited / researchers), **latest evidence** in the sources' own words with their host, controls (Guide, Pause/Resume, Write with what you have, Stop), queued/applied guidance, and the machinery behind one disclosure (sources, evidence, activity, researchers, plan).
- **Plan and clarify gates**: the same header; the planner's approach as a serif lead; mono section labels; source kinds as a quiet mono line instead of pills; the goal is no longer repeated.
- **Finished cover** (`research-recap.tsx`): the live view settles into it — same header with the verdict in words, the field drawn still with every cited source on the inner orbit, the questions with how each ended, figures (read / cited / answered / time), the citation audit sentence, **Read the report** and "Saved in Library" (only when the completion message exists).
- **Report**: the production recap now opens the full-screen reader (contents, support mark on every cited claim, cited-source rail, Markdown/PDF export) instead of the plain dialog; mono chrome, focus lands on the title. Its fallback citation numbering is the READ corpus in store order, matching the writer's positional contract.
- **Motion = state**: the section rises once; a source arrives on its orbit when discovered and travels inward (left/top transition) when read or cited; the presence line draws to the new page; figures roll. Nothing loops. Points render in discovery order so a promotion never re-inserts a node and replays its arrival. A finished cover is drawn still. Reduced motion (system or the gallery switch) runs zero animations.

Verification:

- `npx tsx --test tests/research*.test.ts`: 356 tests, 353 pass, 0 fail, 3 skipped (database-gated). New `tests/research-deep-field.test.ts` (8): orbit by evidence state, angle stability across polls, spacing, presence line only on a drawn current host, overflow accounting, label priority and separation, discovery-order stability, reading-host rules.
- `tests/research-completion-db.test.ts` against a throwaway migrated loopback Postgres: 8/8 (completion message, Library report, terminal run and timestamp commit atomically; rollback after injected failure; concurrent finalizers emit once; cancelled and foreign-owner runs write nothing). The file previously crashed the TypeScript 5.9 checker; fixed by typing the injected writer and transaction.
- `npx tsc --noEmit`: source clean (stale `.next/types` entries for a page another session deleted excepted). ESLint clean on touched files. `npm run capabilities:check` passes after regenerating the native projection.
- Visual: `/dev/research` gains a default `surface=chat` mode rendering the production `ResearchRunPanel` for every fixture state (plus `width=375` and a scripted `field-motion` state). Captured light, dark, 375 px, plan gate, clarify, live, writing, completed, partial, failed and reader; timed frame captures confirmed the inward travel and the absence of replays. The real signed-in chat route was exercised against the seeded local database (`scripts/seed-research-e2e.ts`): paused run, finished cover, report reader.
- Not established: a provider-backed live run, cost/quality evaluation, native parity of the new web design, production deployment.

## Remaining scope

Provider-neutral search, broader orchestration decomposition, memory evaluation, permission and credential migrations, platform acceptance and repeatable live research quality/cost benchmarks. The legacy research row/side-panel components and the `/dev/research?surface=legacy` gallery surface were removed on 2026-10-04 after an import graph from the production `src/app` entry points confirmed nothing reached them; `reportTitle` moved to `report-structure.ts` as `reportTitleOf`.

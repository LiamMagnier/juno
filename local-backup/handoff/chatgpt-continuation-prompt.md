# Alevr (Juno): continue the engineering upgrade

You are the principal engineer continuing an engineering upgrade of **Alevr** (repository codename **Juno**). Several Claude Code sessions worked on it in parallel on 2026-10-14 and 2026-10-15, and all of them are now paused. This prompt gives you the exact state they left, what is still open, and the rules.

This is a continuation. Do not restart the audit or redo finished work. Check the facts below against git before acting on them. They describe the state when the work paused, and things may have moved since.

---

## 1. Repository and environment

- Repo: `LiamMagnier/Juno`, local checkout `~/Developer/project/Juno`.
- Stack: Next.js / React / TypeScript, PostgreSQL + Prisma, Swift/SwiftUI native apps (macOS, iOS, iPadOS), and Node agent runtimes (`runner/agent-core`, `runner/env-server`).
- **Main working branch: `codex/alevr-reliability-upgrade`.** Its HEAD at pause was `7d60f40a1`. Everything below is committed there, and **nothing is pushed**.
- Base commit before this upgrade began: `58cd3739d`.
- A disposable Postgres 17 runs in Docker container `alevr-upgrade-pg-1014` on `127.0.0.1:55439`, with trust auth and user `postgres`. Create your own databases there. Use only throwaway databases whose names end in `test`.
  ```bash
  docker exec alevr-upgrade-pg-1014 psql -U postgres -c "CREATE DATABASE juno_x_test"
  DATABASE_URL=postgresql://postgres@127.0.0.1:55439/juno_x_test DIRECT_URL=$DATABASE_URL npx prisma migrate deploy
  ```
- Test commands:
  - Root unit suite: `npx tsx --test tests/*.test.ts`. At pause: 7,067 tests, **6,920 pass, 0 fail, 147 skipped**.
  - Typecheck: `npm run -s typecheck` (clean at pause).
  - Lint: `npx eslint <files>`. Several large files were not Prettier-clean before this work. Don't reformat whole files.
  - agent-core: `cd runner/agent-core && npm run build && node --test dist/test/*.test.js` (313/313 at pause).
  - env-server: `cd runner/env-server && npm test` (120/120; one unexplained one-off failure was seen once and never reproduced).
  - Swift: `cd native/Packages/JunoScreenControl && swift test` (134 pass); `cd native/Packages/JunoCode && swift test --filter JunoCodeLocalTests` (134 pass).
- Database integration suites are opt-in through environment variables. Run each against its own fresh migrated database, with `NODE_OPTIONS=--conditions=react-server`. Many also need `--experimental-test-module-mocks`; check each file's header comment.

  | Env var | Test files |
  |---|---|
  | `CHAT_TURN_TEST_DATABASE_URL` | `tests/chat-turn-pipeline.integration.test.ts` (needs module mocks) |
  | `JUNO_CONTEXT_TEST_DATABASE_URL` | `tests/router-chat-context.integration.test.ts` |
  | `ORBIT_TEST_DATABASE_URL` | `tests/orbit-team.integration.test.ts`, `orbit-goals.integration.test.ts`, `agent-routine-follows-agent.integration.test.ts`, `code-admission.integration.test.ts`, `parked-routine-expiry.integration.test.ts` |
  | `COMPUTER_TEST_DATABASE_URL` | `tests/agent-computer-sweep.integration.test.ts` |
  | `CODE_LINK_TEST_DATABASE_URL` | `tests/code-v2-env-link-pg.test.ts`, `code-v2-link-concurrency-pg.test.ts` |
  | `RESEARCH_TEST_DATABASE_URL` | `tests/research-plan-fields-db.test.ts`, plus the existing research DB tests |
  | `HISTORY_TEST_DATABASE_URL` | `tests/chat-history-paging.integration.test.ts` (needs module mocks) |
  | `MEMORY_TEST_DATABASE_URL` | `tests/memory-persistence-db.test.ts` (needs module mocks; or `npm run test:memory:db`) |

  Some files assert the database name matches `/juno_*test` and some only `/*test`. CI uses names like `linktest` and `researchtest`.

---

## 2. Boundaries (non-negotiable)

- **Do not** push, merge into `main`, deploy, publish native builds, change production configuration or environment variables, run production migrations, or touch live user data. Each of these needs explicit permission from the owner.
- Local commits on the working branch are fine. Never reset, force-push, rewrite history or drop uncommitted work.
- **Visual design is frozen.** Make no redesign, new animation, layout, typography, color or wordmark change. A separate design assignment covers that, and its work is in progress (see 3.3).
- Before you stage anything, check the working tree. Other sessions have left uncommitted work in this same checkout. Stage only paths you changed (`git add <paths>`, never `git add -A`).
- Each fix needs a regression test that fails on the old code (check it by swapping the old file back in temporarily). Report what you could not test, and why.
- Code can't be trusted to describe itself. Verify behaviour, and say plainly when something is untested.
- Commit messages end with: `Co-Authored-By: <your model attribution>` (match the repo's existing style).

---

## 3. State at pause

### 3.1 Commits on `codex/alevr-reliability-upgrade` since `58cd3739d`, oldest first

**Before the 2026-10-14 sessions (an earlier agent):**
- fix(agent-core): cancel shell processes with their owning turn
- fix: preserve cache-only input in chat accounting
- fix(code): isolate relay receipts and recover restart cursors
- fix(chat): route Auto with saved context before generation

**Device-link relay:**
- fix(code): serialize Postgres relay publication and lease link commands
- feat(code): durable link receipts on the Mac and bounded redelivery for them (adds a Prisma migration; not applied in production)

**Computer use (cloud and macOS):**
- fix(computer): fence cloud computer runs by lease and make the sweep conditional
- fix(screen-control): close takeover and floor bypasses in local computer use
- fix(computer): reap leaked cloud computers, stop typing on takeover, no reopen after Hand back
- fix(computer-use): lock race, finance withdrawal, coordinate convention, abandoned calls
- fix(computer): claim awake slots atomically so concurrent wakes respect the caps

**Coding agent and env-server:**
- fix(agent-core): safe edits, atomic writes, and undo that never erases later changes
- fix(agent-core): serialize subagent imports and re-check files before writing
- fix(env-server): rollback never reverts between-turn edits or deletes unrecorded files
- fix(agent-core): keep the end of bash output, guard partial reads and Work writes
- fix(agent-core): escape child output, enforce the turn budget mid-run, end child jobs
- fix: release finished jobs, close cut-off tool rows, forward budget exhaustion

**Agents, teams, goals, routines:**
- fix(agents): team members on the agent's budget, bounded retries, ended stuck teams
- fix(routines): no made-up connector events, agent limits reach routines, resume from now
- fix(poller): polled triggers never start Code routines or deleted tasks' routines
- fix(schedule): catch up the newest missed fire; no notices for deleted tasks
- feat(routines): end unattended routine runs parked for an answer after 24 hours

**Chat, LLM, billing:**
- fix(chat): bill failed tool turns, keep other chats' text out of memory, honest connector errors
- fix(llm): report running usage after every tool round on all providers
- feat(code): admit Code starts against the usage window and agent budget
- test: memory-guard source checks follow the stricter guard

**Research, artifacts, workbooks:**
- fix(workbook): hold defined names and chart ranges to the range limit
- fix(workbook): say when an imported xlsx loses merged ranges or cell notes
- fix(research): record billed queries without overwriting steering or pause
- fix(research): Cancel and Pause abort a background drive's in-flight calls
- fix(artifacts): ops written against an older version are not applied

**Merged from parallel sessions:**
- Memory: real-Postgres lifecycle eval; deleted/rewritten facts leave the summary; injection gated on relevance
- perf(chat): page conversation history instead of sending it whole
- fix(cache): read GPT-5.6+ history across turns, no paid writes on one-offs, per-request cost records
- feat(models): Gemini 4 Argon and Muse Wonder in chat, Grok Voice 3.0 in voice mode

### 3.2 Committed elsewhere, not merged yet
- **`b8a5c84e9`** on `claude/confident-ellis-17a111`: "perf(chat): compress history JSON, stop landings remounting the window" (follow-up to the paging work). Merge it into `codex/alevr-reliability-upgrade`, then rerun typecheck, the unit suite and the paging integration test. Its author asked for someone to check the diff of `juno-icons/index.tsx` in that commit for unexpected changes: the file changed on disk while it was being edited.
- Three local branches, `codex/alevr-shell-cancellation`, `codex/alevr-metering` and `codex/alevr-device-link`, hold duplicates of the earlier agent's first three commits, which are already on the working branch. Ask the owner before deleting them.

### 3.3 Uncommitted work in the checkout (not yours; leave it alone)
The "Brand identity and motion design overhaul" session paused with about 150 uncommitted files in this checkout:
- a Juno → Alevr rename in user-facing strings across `native/Packages`;
- motion and CSS changes (`src/app/globals.css`, `tailwind.config.ts`, `src/lib/motion.ts`, landing/home components).

It also left a web dev server on port 3000 and a Postgres container `alevr-local-pg` running. Do not stage, revert or reformat any of it.

### 3.4 Decisions already made by the owner
- Code tasks, Code routines and CI auto-fix runs now pass the usage-window and agent-budget admission checks, like Work runs. Runs whose every role uses the person's own key or subscription are exempt.
- Unattended routine runs that stay parked for an answer for 24 hours are ended as `interrupted`, with an explanation.
- Postgres device-link relaying stays **opt-in** (`ALEVR_LINK_STORE=postgres`). Do not make it the production default without explicit approval and a test with more than one real backend process.

---

## 4. What's left, in priority order

### P0: integration and correctness
1. **Merge `b8a5c84e9`** (see 3.2) and verify it.
2. **Distinguish "paused by a person" from "parked waiting for an answer"** on `WorkRun`, for example with a pause-reason column and migration. The 24-hour expiry (`expireParkedRoutineRuns` in `src/lib/work/store.ts`) currently also ends unattended routine runs a person paused on purpose, because nothing records the difference.
3. **Concurrent creation of the same cloud computer** (`src/lib/computer/store.ts` `ensureAwake` / `enableComputer`, `src/lib/computer/docker.ts` `create`):
   - Two simultaneous `ensureAwake` calls on a missing container both create it, and the second's `rm -f` removes the first's container.
   - Concurrent first-time `enableComputer` calls can fail with a P2002 unique-key error.
   - The fix needs a "creating" claim visible to both the web app and the runner. Don't hold a DB connection across `docker create`.
4. **Cloud computer budget is only admitted at wake** (`ensureAwake`). A long run keeps a computer awake past the usage window, and spend recording swallows errors. Add an in-run check.
5. **Agent reflections ignore the agent's own budget cap.** `reflect-sweep.ts` checks only account windows, and `memberSpendMicroUsd` counts only `WorkRun.costMicroUsd`, so reflection spend never counts toward the agent cap.
6. **Untrusted-content rule in the system prompt.** `search_chats` and `read_conversation` return text wrapped as untrusted, and memory writes are now blocked once they return results. But `turnCarriesUntrustedContent` (`src/lib/chat/turn/capabilities.ts`) still doesn't switch on `UNTRUSTED_CONTENT_RULE` for them. Decide whether to add the signal. That flag also gates memory writes, so measure the product impact.
7. **Code task start refusals in the clients.** `POST /api/code/tasks` can now return `429` with `code: USAGE_WINDOW_EXCEEDED | MEMBER_BUDGET_EXHAUSTED` and `resetsAt`. Check that the web Code composer and the native Code clients show the message rather than a generic failure, and fix them if not, reusing existing components. No visual redesign.
8. **Device-link receipts need a Mac release.** `6fbb433c4` adds Mac-side receipts and lets the relay redeliver only to hosts that report `receipts: true`. It does nothing for users until a Mac build ships, which needs owner approval. Its migration also has to go through the normal deploy process, not a manual run.

### P1: test harness gaps (several fixes above have no behavioural test because of these)
9. An offline loop harness for the **production** LLM adapters (`src/lib/anthropic.ts`, `openai-compat.ts`, `openai-responses.ts`, `gemini.ts`). The loop tests drive `src/lib/llm/*-loop.ts`, which production does not use. Untested as a result:
   - per-round usage events;
   - the cancelled result for tool calls cut off by Anthropic's `max_tokens`;
   - the Gemini Stop rethrow.
10. A harness for the worker scripts `scripts/work-scheduler.ts` and `scripts/work-trigger-poller.ts`. Untested as a result:
    - spend-reservation refusal handled as a budget block;
    - budget-block advancement across all triggers;
    - deleted-session skipping;
    - Code routines skipped by the poller;
    - the parked-run sweep wiring.
11. A behavioural test for MCP `isError` handling in `src/lib/mcp.ts`, which currently has only source-shape tests.
12. A test for team-lead attempt exhaustion ending the team, and for the goal-runner lease fence (`src/lib/agents/team-store.ts`, `goal-runner.ts`).

### P1: workstreams' own open items
13. **Paged history:**
    - every row inserted into the transcript restyles the whole visible transcript (CSS cause not found);
    - find could prefetch the rest of the conversation when it opens, not on the first keystroke;
    - the legacy Code surface and `/code/[id]` still load whole threads.
    - See `docs/rework/program/PERFORMANCE.md`, sections "Paged history" and "Paged history follow-up".
14. **Prompt caching:**
    - the GPT-5.6+ breakpoint layout was checked against a simulator built from OpenAI's docs, not the live API;
    - on Anthropic, the forced final round (`tool_choice: none`) invalidates the message cache for that request (known and accepted);
    - the memory summary still sits in the cached system prompt every turn.
    - Tools added: `src/lib/llm/prefix-diagnostic.ts`, `src/lib/llm/request-meter.ts`, `src/lib/metering/cost-per-accepted.ts` and `scripts/cost-per-accepted.ts`.
15. **Memory:**
    - the embedding-relevance threshold in the new injection gate is not tuned against real embeddings;
    - live quality was not measured (no model credentials were available);
    - one non-shipping configuration lost recall (81.8% → 77.3%).
16. **Low-severity leftovers:**
    - the folder checkpoint store reuses a file's hash when size and floored mtime match (`runner/env-server/src/git/folder-checkpoints.ts`), so same-size edits on filesystems with 1-second mtime resolution are missed;
    - the env-server suite failed once without a trace (only one failure in one run, never reproduced).

### P1/P2: workstreams not started
17. **Coding harness: repository understanding.** Symbol index and retrieval, call graph and dependency awareness, a compact working map that survives compaction, task-specific test selection, verification-driven repair loops. Build on `runner/agent-core`; don't add a second runtime.
18. **Unified task/session semantics** across Chat, Code, Work and remote clients: one authoritative identity, versioned ordered events, reconnectable cursors, and consistent stop/steer/approve/resume. Map what exists before changing anything.
19. **Benchmarks and comparisons:** reproducible suites for long-context chat, tool-heavy chat, research, multi-file coding, reconnect after interruption, browser and desktop automation, and cost-optimised routing. These need provider credentials; ask the owner. Never present mocked results as live capability.
20. **Native release acceptance:** verify the critical paths on a real signed-in Mac and iPhone. Record exactly what could not be verified.
21. **P2:**
    - hybrid computer use (structured, DOM, accessibility and visual tiers);
    - local/cloud supervision and takeover;
    - long-running agent goals;
    - reusable skills;
    - cross-device notifications.

---

## 5. How to work

1. Inspect the current branch, `git status` and `git log` first. Confirm the state above.
2. Take one item at a time in the order above. Reproduce or demonstrate the defect, make the smallest correct fix, and add a regression test that fails on the old code.
3. Run the targeted tests, typecheck and targeted lint. For database-touching work, run the relevant integration suite against a fresh migrated database.
4. Commit locally, staging only your own paths, with a message explaining the defect, the fix and the test evidence.
5. Periodically run the full root suite and report the counts.
6. Report each item with: what changed (paths, commit), evidence (tests run with pass/fail/skip counts), what is unverified, and the next priority.
7. Stop and ask the owner before anything in section 2's "do not" list, and for product decisions such as items 2, 6 and 8.

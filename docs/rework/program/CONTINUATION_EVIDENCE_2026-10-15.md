# Continuation evidence — 2026-10-15

Local work on `codex/alevr-reliability-upgrade`, continuing the owner's “Do it all” request and the engineering handoff. The owner subsequently asked specifically about the redesign and motion, so this pass also inspected the existing visual work and fixed two reproduced UI defects. No push, deployment, production migration, native publication or live model generation occurred.

This is an execution record, not a replacement capability registry. `src/lib/capabilities.ts` remains the canonical maturity registry. Local source, deterministic verification and accepted production workflows are different evidence levels.

## Implemented and changed

| Handoff item | Local result | Commit / evidence |
| --- | --- | --- |
| 1. Pending history change | Merged the existing compression and transcript-placement follow-up locally. | `8941a8327`; history Postgres suite, 10 passes. |
| 2. Deliberate pauses | Persisted pause reason, preserved explicit user pauses and fenced expiry against resumed runs. Historical pauses migrate conservatively to user pauses. | `4faac6a1a`; real Postgres regression fails with the old store. |
| 3. Computer creation | Persisted cross-process creation claims, fenced stale publishers, handled concurrent initial inserts and preserved existing Docker containers on name collisions. | `697388d76`; concurrency, stale-claim and Docker collision regressions. |
| 4. Running computer budgets | Rechecked account windows during lease renewal and sweeping; included pending elapsed cost; retained stopped billing intervals for ledger retries. | `52a072076`; real persistence with deterministic budget/provider boundaries. |
| 5. Reflection budgets | Attributed utility spend to the agent, included it in member caps, and checked every reflection origin before frequency claims. | `4f386570f`; real spend ledger and reflection admission regression. |
| 6. History trust | Added the untrusted-content system rule when the actual production toolset exposes conversation reads. Ordinary memory stays available until untrusted results are returned. | `3cd3b5838`; real adapter request capture and Chat route integration. |
| 7. Client budget refusals | Confirmed that the web toast and native client preserve the server's explanatory prose; added native Code regressions for both budget error codes. | `2059566fe`; one Swift test passes. No signed-app interaction claim. |
| 8. Mac receipts release | Existing implementation preserved. Publication and deployed migration are outstanding. | No release attempted. |
| 9. Production adapter harness | Exercised all four real production adapter loops through offline transport seams; covered running usage, Anthropic cut-off calls and Gemini Stop. | `2059566fe`; six tests pass. Removing the first usage event in all four adapters makes four tests fail. |
| 10. Worker harness | Imported production ticks without starting daemons; exercised reservation refusals, all-trigger advancement, deleted tasks, Code poller exclusion and parked expiry. | `2059566fe`; one real-Postgres scenario passes. |
| 11. MCP errors | Exercised the real execution path, untrusted result, audit settlement and external-action receipt for successful and `isError` replies. | `2059566fe`; two tests pass; disabling the error branch is detected. |
| 12. Coordinator fences | Exercised exhausted lead termination and a late goal advance racing its replacement's lease. | `2059566fe`; two real-Postgres tests pass; removing either protection is detected. |
| 13. Paged history follow-up | Pending history merge verified. Earlier Find prefetch, legacy Code paging and transcript style-recalculation diagnosis remain open. | Existing performance records retained. |
| 14–15. Live caching and memory evaluation | Existing offline evidence preserved; live cache behavior, embedding threshold tuning and live memory quality remain unmeasured. | Provider probe described below. |
| 16. Folder checkpoint accuracy | Hash bounded files even when size and mtime are unchanged. Oversized files retain the documented metadata-only fallback. | `08f65272d`; preserved-mtime regression fails before the fix; all 121 env-server tests and both typechecks pass. The old unexplained suite failure did not reproduce in this run. |
| 17. Repository understanding | Not implemented by this continuation. Symbol retrieval, a durable working map, test selection and verification-driven repair remain substantial work. | Must extend the existing agent-core runtime. |
| 18. Unified sessions | Fresh cross-surface semantic map and implementation remain open. | Existing protocol and durable ledgers must be reconciled before changes. |
| 19. Comparative benchmarks | Production transports now have behavioral fixtures. These are not live capability or cost comparisons. Broader reproducible benchmark scenarios remain open. | No live generation calls. |
| 20. Native acceptance | Local Swift client regression passes. Real signed-in Mac/iPhone critical paths remain unverified. | No native release. |
| 21. Broader P2 work | Hybrid computer use, supervision/takeover, long-running goals, reusable skills and cross-device notification completion remain open. | Existing implementations are not classified as absent or accepted by this record. |

## Redesign and motion

The existing checkout contains much more implementation than the old October 1 “documentation only” brand notes imply: Continuum assets and wordmark, the Alevr display-name sweep, production shell/page styling, deterministic galaxy working indicators on web and native, and web/Mac icon hover work. The galaxy replaced the earlier moving Continuum treatment; it should not be rebuilt from the stale brand thinking document.

The earlier uncommitted brand/native/hover changes were preserved. This continuation did not stage those files or claim authorship of them. The following integration corrections are committed separately as `ffe4b6b07`:

| Severity / before | After | Why / verification |
| --- | --- | --- |
| P1: the galaxy kept moving when Alevr's own Reduced setting was selected with OS motion allowed. | Canvas follows the app and OS settings, observes changes live and restores the saved choice after reload. | Real Chrome pixels change during work, hold under app/OS reduction and resume under System. The browser regression fails before the fix. |
| P1: the phone app header covered the Settings Back control. | Removed the obsolete page-wide voice aura stacking context. Full-window Settings paints above the phone header. | Real browser hit tests fail before the fix and pass afterward; inspected the corrected 390px capture. |
| P2: nested shell motion policy could override the root's app choice; route transitions checked only the OS. | The shell honors the saved app choice and route transitions use the shared motion policy. | Typecheck and related UI tests pass. A full motion-state acceptance matrix remains open. |
| P2: redesigned Chat sidebar copy drifted from the shared native contract. | The contract and generated Mac projection match the current web copy. | Generator check and all 15 shell contract tests pass. The original sidebar source was preserved. |

Motion review verdict: **block a claim of complete motion acceptance**. The two reproduced defects are fixed; the remaining acceptance matrix is open. This was a bounded review, so no whole-app accessibility or performance score is assigned.

### Visual evidence

Captured twenty ready-state gallery views: Projects, Library, Apps/connections, Skills, Routines, Instructions, Orbit, Settings, Search and Code, each at 1440×900 dark and 390×844 light. All returned 200 with no uncaught page errors or document-level horizontal overflow. These are actual components with fixture data, not authenticated production workflows. The metrics alone do not prove readable contrast, good focus order, working saves or smooth motion.

- [Capture inventory and metrics](../../../artifacts/continuation-2026-10-15/gallery-checks.json)
- [Projects, desktop dark](../../../artifacts/continuation-2026-10-15/projects-dark-1440.png)
- [Library, phone light](../../../artifacts/continuation-2026-10-15/library-light-390.png)
- [Orbit, desktop dark](../../../artifacts/continuation-2026-10-15/agents-dark-1440.png)
- [Settings phone before](../../../artifacts/continuation-2026-10-15/settings-light-390.png) / [after](../../../artifacts/continuation-2026-10-15/settings-light-390-after.png)

The screenshots are saved local artifacts. This evidence does not assert that all twenty images received detailed visual inspection. Projects, Library, Orbit and Settings were inspected directly. The phone Search fixture capture matches its base Projects view, so it is not evidence that the Search overlay opened successfully. The wider light/dark × desktop/phone/tablet matrix, keyboard and screen-reader paths, loading/error/offline states, interruption/reversal, pointer versus keyboard behavior, reduced transparency and installed native workflows remain acceptance work. Original character/artwork decisions also remain in their existing design brief.

## Tests

- Final full root run on Node 24.22.0: 7,095 tests, 6,940 passes, zero failures, 155 skips. The former sidebar-copy assertion now passes after updating the contract. Browser and database suites are deliberately opt-in in this glob and were also run explicitly below.
- Final related UI run: 50 passes; real Chrome motion/Settings run on Node 24.22.0: two passes.
- Production adapter/MCP run: eight passes; worker Postgres run: one pass; coordinator Postgres run: two passes.
- Replayed the exact new CI persistence step locally on Node 24.22.0, with fresh local database names and `psql` pinned to the disposable Docker container: six migrated databases, 16 tests passed, zero failures/skips. This covers pause preservation, running computer budgets, reflections, workers, coordinator fences and history paging.
- Env-server on Node 24.22.0: 121 passes, zero failures; source and test typechecks pass.
- Native shared Code client: one targeted Swift test passes.
- Root typecheck, targeted ESLint, generated shell check and workflow YAML parse pass.

The host default Node is 26.11.1; the final root suite, root typecheck and local CI-step replay were rerun using the project's required Node 24.22.0. Provider I/O is stubbed or blocked in the offline transport/worker tests; persistence tests use isolated, migrated local Postgres databases. CI now explicitly runs the new persistence suites so unit-shard skips cannot silently stand in for database verification. Remote CI has not run.

## Benchmarks and external blockers

No Ollama or LM Studio executable/model directory or listening endpoint was found in the inspected local setup. No provider key was present in the process environment. The one configured provider in `.env.local`, Anthropic, returned 401 to a model-listing request; no secret was printed and no generation was requested. Therefore the request to use an available cheapest model could not produce live benchmark evidence from that setup. No billable generation spend was incurred.

## Security considerations and limits

Creation claims do not hold database connections across Docker operations. Deliberate pause expiry and goal publication use conditional persistence fences. Reflection costs are attributed through the existing spend ledger. History reads add the trust rule based on actual exposed tools rather than disabling ordinary memory for every turn. Stopped billing retains a bounded retry interval when recording fails.

The tests establish those stated scenarios, not universal exactly-once accounting or crash recovery. Docker/provider behavior is faked in the lifecycle budget harness; the collision test uses a controlled CLI seam. Production infrastructure, account configuration, signed-in native behavior and real model quality were not accepted here.

## Next milestone

Finish the visual/motion acceptance work in the existing design direction, preserving the owner's current changes; resolve concrete keyboard, state and responsive defects found there. Continue the paged-history follow-ups, then repository understanding and the unified-session map. Complete all locally testable benchmark preparation while recording the unavailable provider and signed-device evidence explicitly.

# Validation and evidence

**29 October 2026 · Juno chatbot and cross-platform design improvement**

This record accompanies [AUDIT.md](AUDIT.md), [DESIGN.md](DESIGN.md), and the
[competitor research](COMPETITORS.md). It records executed evidence separately
from deployment and device claims.

## Environment and boundaries

- Node 24.22.1; Linux; clean repository checkout from
  7c91a0c2eb986f468c94801878820d7393ccd140.
- Dependencies installed from the lockfile; Prisma client generated;
  npm run test:prepare completed the repository's required local setup.
- No production database, customer content, live model credentials, or paid
  provider calls. Browser QA uses the repository's fake provider and an owned,
  disposable PostgreSQL database on 127.0.0.1:55439.
- Native Swift source, generated tokens, and static gates can run here.
  Apple SDK compilation, simulator/device interaction, and store submission
  cannot be established by this environment.

## Repository gates

| Check | Executed result |
|---|---|
| npm run typecheck | Passed; the production build also completed its TypeScript check. |
| npm run lint | Exit 0: zero errors; 611 existing warnings across 153 files remain explicit design/cleanup debt. |
| Complete npm test chain | Exit 0: 8,859 tests discovered in 101 suites; 8,666 passed, 193 skipped, zero failed/cancelled. Authentication/locale, message crypto, moderation, 14 skill-package checks and 14 custom-MCP checks passed. |
| npm run security:check | Passed: 124 tests in four suites, no skips/failures; production dependency audit reported no advisories. A final tracked-secret scan after staging passed on all 10,088 files, including the new code and audit evidence. |
| npm run security:dependencies | Passed after the MCP SDK patch. |
| npm run native:sync:check | All 16 contract/generator/parity gates passed. The changed-file parity-label gate was also explicitly run with the actual modified/untracked file list and native: done. |
| npm run native:design:check | All nine ratchet gates passed; existing exceptions remain, with no added exceptions. |
| npm run design:tokens:check | Passed: generated web/native tokens match their canonical sources. |
| Native embedded editor | Regenerated; seven compiled-theme/control/motion regression tests passed. |
| CI regression wiring | Both changed workflows parse; all five existing journey-workflow contract tests passed. The exact new isolated accounting command passed 75 tests with zero skips/failures. |
| Model/capability/work contracts | Model catalog, 35 capability projections, and 25 work vocabulary checks passed. Catalog retains its two existing LongCat casing warnings. |
| git diff --check | Passed before final packaging; repeated on the final patch. |

The broad native ratchets retain existing debt: type 3, glass 14, target-size
150, prominent-action 1, menu 1, spacing 16; motion and icon checks add no
exceptions. Passing a ratchet means this change did not increase its known
violations. It does not mean every native view has been certified.

The main remaining web lint categories are 334 timing-ladder warnings,
176 text-opacity warnings, 39 transcript-type warnings, 26 raw presence-color
warnings, and 22 backdrop-filter warnings. This change does not claim that
every bespoke control in the repository has completed the shared-system
migration.

The GitHub E2E workflow now includes the four browser regression files listed
below. The PR/main gate also explicitly runs the isolated money-path tests with
module mocking enabled; they no longer rely on the default unit shard's skip
behavior for route/ledger coverage.

The broad test command skips tests needing unavailable integration conditions.
The money-path tests below explicitly enable module mocks and server conditions
so the relevant route/ledger regressions execute rather than remain skipped.

The 193 skips comprise 168 generic opt-in/environment gates, ten tests whose
Chromium detector did not find the bundled browser, eight unavailable sandbox
proc-mount checks, three requiring the react-server condition, and one each for
a dedicated search database, deferred legacy research, PostgreSQL on PATH, and
a historical commit missing from the shallow checkout. Production browser QA
uses its installed Chrome channel and disposable database independently.

The complete unit run took about 140 seconds. It preceded the final browser-
discovered IME Escape, incognito focus, delayed autofocus, and mobile sizing
corrections. After the IME/incognito changes, all four affected composer/search/
focus/home-starter unit files passed and the complete lint run above passed.
The final autofocus/sizing batch passed 46 tests in four affected files, with
zero failures or skips, and focused lint passed with zero errors and 18 existing
warnings. The production browser rerun supplies the interaction evidence.

## Focused correctness evidence

~~~bash
node --conditions=react-server --import tsx --test \
  --experimental-test-module-mocks \
  tests/chat-request-pricing.test.ts \
  tests/chat-turn-spend.test.ts \
  tests/prompt-cache-wire.test.ts \
  tests/profile-stats-ledger.test.ts \
  tests/chat-budget-guard.test.ts \
  tests/follow-up-cache.test.ts \
  tests/follow-ups-route.test.ts \
  tests/utility-attempt.test.ts \
  tests/utility-rejection-billing.test.ts
~~~

**75 passed, zero failed or skipped.** These exercise request-level long-context
boundaries, cache and search buckets, fully cached Anthropic usage, actual served
tiers, interrupted mixed-tier/batch coverage, Gemini thought totals, displayed
usage versus ledger inputs, downgrade timing, and read-only profile costs.

Additional focused tests cover:

- Follow-up cache isolation, TTL/size bounds, single-flight behavior, rejected
  fills, and actual authenticated route behavior.
- Budget normalization for cache reads and both write lifetimes, output floors,
  and changing served-tier rates.
- Structured pre-acceptance utility rejections versus timeouts, aborted/partial
  streams and unstructured errors, including the real utility runner.
- Composer synchronous ownership, draft sessions, context token restoration,
  Unicode search offsets, bounded results, and history-stable navigation.
- Generated spring consumption, field contrast in four appearances, focus
  wiring, existing gesture/motion contracts, and compiled native editor styles.

## Production browser evidence

**Final production run: 21 passed, zero failed or skipped, exit 0.** The fresh
build completed in 198 seconds; the complete selected command took 4.4 minutes,
including build and authentication. All six composer cases, both conversation-
Find cases, four design profiles, and the keyboard/accessibility cases passed.

**Intermittent-focus confirmation: all five Search repetitions passed**, plus
authentication (six checks total), with zero failures or skips in 21.7 seconds.
That follow-up used the runner's verified unchanged-build reuse path. The
original immediate open/close assertion, explicit New chat focus, and yielding
of queued focus to a newer interaction all executed in each repetition.

Seventeen PNGs were preserved from the full run. Six reviewed captures and
their hashes are committed in the [design evidence gallery](DESIGN.md#captured-browser-evidence).
All 524 generated JSON files parsed successfully after the fresh build.
The disposable databases were dropped, the owned PostgreSQL service stopped,
and the temporary browser/build links removed. No owned QA process remained.

The sanctioned runner is mandatory in this repository:

~~~bash
npm run test:e2e -- --package chat_audit --chromium-channel chrome \
  --project=chromium \
  e2e/composer-submission.spec.ts \
  e2e/conversation-find.spec.ts \
  e2e/design-primitives-audit.spec.ts \
  e2e/keyboard-focus.spec.ts
~~~

It builds with next build, serves with next start, allowlists environment
variables, checks that only a disposable local test database is used, and drops
that database and its owned processes on exit. No QA safety gate or build stamp
was bypassed.

The selected journeys cover normal and reduced-motion composer behavior,
same-task duplicate submission, pending edits, clarification Continue/Skip and
Cancel, saved/private draft isolation, search Escape without Stop, and search
selection through history changes. Design profiles exercise real settings,
selects, and dialogs at desktop light and phone dark sizes, with both motion
preferences, keyboard focus return, forced colors, touch sizing, and containment.
The existing axe smoke case excludes color contrast; the separate token tests
measure the field roles described above. Phone profiles use Chromium mobile
emulation and do not establish Safari, VoiceOver, or native device behavior.

Browser QA found and corrected several concrete issues while retaining the
original assertions: composing Escape reached the global Stop listener;
leaving incognito triggered competing welcome-screen autofocus; and a delayed
composer-focus callback could steal focus from Search before its lazy dialog
captured the return target. The latter reproduced in three of five diagnostic
runs. Actual focus-call stacks identified the queued Composer callback, so its
ownership was fixed without changing the dialog's return behavior. New chat
and deferred-focus ownership now have explicit browser assertions. Seeded
sidebar rows are awaited so confirmation-dialog coverage executes during
hydration rather than being skipped.

Screenshot inspection also found a mobile URL input shrinking in a flex column
and a touch-specific Textarea rule overriding the caller's larger minimum.
Both layouts were corrected and both phone profiles now assert their intended
heights (44px and 128px respectively).

The managed workspace caused generated-output cleanup failures and, in one
completed build, an empty pages manifest. Inspection found active workspace
synchronization covering that output, replacement-like file timestamps, and
no surviving build writer. Synchronization interference is an inference, not
a directly captured offending write. Disposable build output was isolated in
an owned temporary parent, with a sibling link to the same installed
dependencies for Node resolution. Source, configuration, dependencies, safety
checks and automatic fingerprints were unchanged; no manifest was fabricated
or manually repaired. Failed build attempts are not counted as browser passes.

## Local synthetic evidence

The reproducible script is
[scripts/bench-chat-audit.ts](../../scripts/bench-chat-audit.ts); its captured
output is [SYNTHETIC_BENCHMARK.json](SYNTHETIC_BENCHMARK.json).

It performs local arithmetic and deterministic in-memory operations:

- Twenty concurrent identical follow-up callers invoke one generation function:
  nineteen avoided calls in that fixture.
- Two Grok 4.7 requests, each with 150,000 prompt and 1,000 output tokens, price
  at $0.612 together under the repository's table. Pricing the cumulative
  counters as one request produced $1.224.
- Nine timing samples compare the former aggregate arithmetic with six-request
  reconciliation, exercise the budget projection, and search a synthetic
  1,000-message history with an absent query and a common capped query.

These results are not production p95, live provider latency, invoice savings,
device frame rates, or answer-quality measurements. The new accounting does
more local arithmetic; it adds no network or model call. The search timings
measure the new local search on this synthetic corpus, not a before/after
browser comparison. They do not establish identical end-to-end performance
under real traffic.

The final capture was taken with no build or test process running. Each timing
below is the median of nine per-operation batch means, not a production
percentile:

| Local operation | Microseconds per operation |
|---|---:|
| Former aggregate estimate, six-request totals | 0.207 |
| Reconciled estimate, six individual requests | 5.447 |
| Streaming budget projection | 0.130 |
| Search 1,000 synthetic messages, no match | 666.722 |
| Search 1,000 synthetic messages, capped common query | 319.675 |

The reconciliation fixture therefore adds about 5.24 microseconds of local
arithmetic per six-request estimate. This makes the extra work visible without
claiming that an isolated CPU measurement proves unchanged application latency.

The offline native editor includes additional shared styles rather than a
separate visual fork. Its JavaScript changed from 1,288,871 to 1,293,331 bytes;
its CSS changed from 32,176 to 59,570 bytes. These are bundled local assets.
The increase is explicit; no native startup or frame-rate comparison was run.

## Unverified release conditions

- Run Apple SDK builds and the existing Swift/UI/snapshot gates on the final
  commit; inspect iPhone keyboard behavior, Dynamic Type, VoiceOver, macOS
  focus, and reduced motion on supported devices.
- Measure production time to first useful output, completion latency,
  responsiveness, error/retry rate, and total cost per accepted task before
  increasing advertised plan allowances.
- Reconcile representative provider invoices and monitor receipt coverage;
  incomplete usage and late provider work still require estimates.
- Evaluate answer correctness and supported citations on held-out real tasks.
  Vendor documentation and mock providers cannot establish superiority.
- Finish first-send upload ownership across the landing-to-dock remount.
  The implemented text/token session does not yet own newly added uploads.

This work creates a reviewable change; it does not deploy production, merge
the branch, publish native builds, or retroactively rewrite historical charges.

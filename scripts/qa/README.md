# QA harness (wave 2, package P0)

Everything that runs a server, a browser, an e2e suite or a native performance
suite in wave 2 goes through this directory. It exists so that acceptance runs
are safe (they can only ever touch a disposable local `*_test` database) and
light on a shared machine (production builds only, nothing left running).

## The base gate

Checks and statuses are read for one exact main SHA. The package must include
that main commit. Vercel checks are excluded as directed by the owner; the
GitHub Actions checks still must pass, including all native jobs.

```sh
bash scripts/qa/check-base.sh            # or: npm run qa:check-base
```

Fails unless there are no unmerged paths, the wave-1 integration commit
`244366124` is an ancestor of `HEAD`, and every check on `main`'s head commit on
GitHub has passed (read with `gh`; if CI cannot be read, the gate fails). Cut
wave-2 worktrees from `main` only after it passes, and print the `Base SHA:`
line it shows in each package PR. If `main` ever squashes wave 1 instead of
merging it, add that squash commit to `WAVE1_COMMITS` in the script.

## Running e2e

```sh
npm run test:e2e -- [runner options] [--] [playwright args]
bash scripts/qa/run-prod-e2e.sh --package p5 -- e2e/wave2/p5-chat --project=chromium-1440
```

| Option | Effect |
|---|---|
| `--package <id>` | Uses the database `alevr_<id>_test` (default `p0`). |
| `--reuse-build` | Skips `next build` when `.next` was built from exactly this `HEAD` and working tree. |
| `--update-baselines` | Writes visual and heap baselines instead of comparing against them. |
| `--chromium-channel chrome` | Runs the Chromium projects on an installed Chrome instead of Playwright's download (local only). |
| `--report-dir <dir>` | Where gate results go (default `test-results/design-gates`). It is emptied at the start of each run; a non-empty directory the runner did not create is refused. |
| `--no-seed` | Skips the E2E account, research and QA fixture seeds. |

Outputs: gate results in `test-results/design-gates` (plus `summary.json`),
screenshots in `test-results/visual-matrix`, web geometry in
`test-results/web-geometry`, and Playwright's own traces and attachments in
`test-results/playwright` (Playwright empties that folder on every run, which
is why it is a subfolder).

What the runner guarantees, in order:

1. **Refusals, before anything starts** (`assert-safe-env.mjs`, rules in
   `lib/safe-env.mjs`). `DATABASE_URL` and `DIRECT_URL` must both be
   `postgresql://postgres@127.0.0.1:55439/<name>` with `<name>` ending in
   `_test` (default `alevr_<package>_test`), with no password, no other host or
   port, no query string other than `?schema=`, and the same database in both.
   It refuses when `.env`, `.env.local`, `.env.production`,
   `.env.production.local` (or `prisma/.env`) exists, because Next and Prisma
   would read them behind its back, and when `E2E_BASE_URL` is anything but
   `127.0.0.1` or `localhost`. Node 24 or newer is required.
2. **A disposable database** (`ensure-test-db.mjs`): created only if its name
   is unused; an existing database is refused and left intact. A successful
   create records ownership in the run's private `database.json`, then it is migrated with `prisma migrate deploy` using only `DATABASE_URL` and
   `DIRECT_URL` (plus `PATH` and `HOME` so the CLI starts), then seeded:
   `scripts/seed-e2e-user.ts`, `scripts/seed-research-e2e.ts` and
   `seed-qa-fixtures.ts` (a 1,000-message thread and a Code session; their ids
   land in the run directory as `fixtures.json`).
3. **An allowlisted environment.** Children get `PATH`, `HOME`, `TMPDIR`, `CI`,
   `NODE_ENV=production`, `PORT`, `DATABASE_URL`, `DIRECT_URL`,
   `JUNO_E2E_SMOKE_PROVIDER=1`, the keys in `test.env` (fake, test-only values)
   and the runner's own `ALEVR_QA_*` / `E2E_PORT` controls. Nothing else from
   the parent environment passes.
4. **Production builds only.** `playwright.config.ts` throws unless
   `ALEVR_QA_RUNNER=1`, never reuses a server, and starts
   `node scripts/qa/serve-prod.mjs`, which runs `next build` and then
   `next start` on `127.0.0.1` at the runner's random free port. There is no
   dev-server path.
5. **Teardown on EXIT, INT and TERM** (`teardown.mjs`): every recorded process
   group (Playwright's, the server's) gets `SIGTERM`, then `SIGKILL` after 10s;
   only the database recorded as created by this run is dropped; and a ps check fails the run if any `node`, `next`
   or `postgres` process from the run is still alive. If cleanup fails, the
   run directory and ownership record are retained for diagnosis and retry.

`serve-prod.mjs` does not run `prisma generate`: worktrees share
`node_modules`, so regenerate the client yourself after a schema change.

Note: `src/lib/chat/turn/admission.ts` turns the smoke model provider off
whenever `NODE_ENV=production`, so suites that need a mocked stream on a
production build need a hook there (P5's call); the P0 smoke and the
cross-cutting gates do not stream.

## Gates

A gate is a measured budget from spec §9. Every gate runs **report-only**: a
failing measurement is written to the report and printed as a warning. A
package **enforces** a gate by listing its id in its own
`e2e/wave2/<pkg>/gates.ts`:

```ts
import type { GateId } from "../../support/budgets";
export const enforce = ["chat.enter-bubble", "chat.tail-drain"] as const satisfies readonly GateId[];
```

The registry (`e2e/support/gates.ts`) globs those files without running them,
so keep the list a plain array of string literals. An unknown id fails the run.
In a spec, record a measurement with `recordGate(testInfo, id, measurement)`
(`e2e/support/gate-recorder.ts`): an enforced gate that fails fails the test.
After the tests, `npx tsx scripts/qa/gates.ts evaluate <report dir>...` (the
runner and CI call it) prints the table, writes `summary.json` and exits 1 on
any enforced failure. CI's summary job adds `--require-enforced`, so an
enforced gate that recorded no measurement in the full run also fails. Native suites write records (`Wave2PerfReport.swift`)
that the same command evaluates against the same budgets.

```sh
npm run qa:gates               # every gate, its owner and its live state
npx tsx scripts/qa/gates.ts readme --write   # after adding or changing a gates.ts
```

<!-- gates:start (generated by `npx tsx scripts/qa/gates.ts readme --write`; do not edit by hand) -->
| Gate | What | Budget | Measured by | Platform | Owner (§9) | State |
|---|---|---|---|---|---|---|
| `chat.enter-bubble` | Enter → bubble painted | ≤ 100ms p95 over 20 runs | marks alevr:enter → alevr:bubble-painted, production build | web | P5 | report-only |
| `chat.enter-status` | Enter → TurnStatus visible (first token at 800ms) | ≤ 300ms p95, target 250 | alevr:status-visible | web | P5 | report-only |
| `chat.fast-first-token` | Fast first token (120ms) | TurnStatus never visible | mocked stream; count of TurnStatus Working paints | web | P5 | report-only |
| `shell.palette-warm` | ⌘K warm open → rows painted | ≤ 1 frame (≤ 20ms) | alevr:palette-open → palette-painted, after idle preload | web | P4 | report-only |
| `shell.palette-cold-shell` | ⌘K cold open → shell | shell in the first frame | preload disabled; alevr:palette-open → palette-shell | web | P4 | report-only |
| `shell.palette-cold-rows` | ⌘K cold open → rows | rows ≤ 150ms | preload disabled; alevr:palette-open → palette-painted | web | P4 | report-only |
| `shell.route-shell` | Route click → shell visible | ≤ 100ms p95 (ROUTE_WAIT_MS 80) | alevr:route-click → shell-visible | web | P2, P4 | report-only |
| `chat.inp` | INP on a 1,000-message thread | < 200ms | web-vitals | web | P5 | report-only |
| `chat.long-tasks` | Long tasks while streaming | none > 50ms during a 2,000-token stream at 4× CPU throttle | trace; reports whether the band text-shadow is the cause | web | P5 | report-only |
| `chat.tail-drain` | Tail drain | ≤ 250ms | marks | web | P5 | report-only |
| `shell.sidebar-cls` | Sidebar CLS on hard load | 0 | layout-shift entries | web | P4 | report-only |
| `web.js-heap` | Web JS heap after GC | ≤ baseline + 10% on the 1,000-message thread | CDP (HeapProfiler.collectGarbage, Runtime.getHeapUsage) against a recorded baseline | web | P0 | report-only |
| `motion.galaxy-cap` | Animating galaxies | ≤ 3 per window | data-animating count; Swift test | web | P2, P3 | report-only |
| `code.dock-panes` | Live dock panes | ≤ 3; a hidden pane evicted after 10 min (injected clock) | DOM count | web | P6 | report-only |
| `a11y.axe` | axe-core | 0 serious or critical on shell, chat, Code, Library, Settings, sign-in | Playwright + axe-core | web | P0 | report-only |
| `a11y.cvd-status-shapes` | Colour-vision deficiency | status fixture under deuteranopia and protanopia filters: hand vs circle-x distinguishable by shape mask | CVD SVG filters + shape-mask comparator | web | P2 | report-only |
| `design.bubble-composer-parity` | Bubble and composer parity | six contexts share radii 12/12/12/8 and the user-bubble fill; composer 22 and disc 12 on every platform | computed style on web; native snapshot geometry exports | web | P2, P3, P5, P6, P8, P9 | report-only |
| `visual.route-matrix` | Visual matrix of routes | no unreviewed change against baselines (report-only until an owner enforces) | screenshots at 1440×900 and 390×844, light, dark and high contrast, reduced motion on and off | web | P0 | report-only |
| `design.contrast-matrix` | Contrast matrix | every pair passes per §3.1 | P1 CI (scripts/check-contrast-matrix.ts) | ci | P1 | external (P1) |
| `design.lint` | Lint | off-ladder durations, unguarded --motion-* overrides, text-<token>/<NN>, blur in entrance keyframes, backdrop-filter in product chrome, caption or micro in transcript chrome, raw presence hex | ESLint and the native design checks, per eslint-rules/enforce/<pkg>.json | ci | P1 | external (P1 enforce files, not gates.ts) |
| `mac.idle-rss` | Mac idle RSS | ≤ 220MB, 60s after opening a seeded 200-message conversation | Release, XCTMemoryMetric | macos | P8 | report-only |
| `mac.quick-entry-rss` | Quick Entry memory | ≤ +30MB RSS | signpost | macos | P8 | report-only |
| `mac.quick-entry-hotkey` | Quick Entry hotkey → key window | ≤ 120ms | signpost | macos | P8 | report-only |
| `native.webview-pool` | WKWebView pool | ≤ 3 live | XCTest | macos | P3, P8 | report-only |
| `mac.poll-backoff` | Mac poll | 15s → 60s after 2 min idle; 0 requests while occluded | injected clock | macos | P8 | report-only |
| `ios.thread-memory` | iOS 1,000-message thread memory | ≤ 300MB on open (40-turn window) | Release, XCTMemoryMetric | ios | P9 | report-only |
| `ios.paging` | iOS paging 40 earlier turns | ≤ 250ms | XCTOSSignpostMetric | ios | P9 | report-only |
| `ios.hitch-ratio` | iOS hitch ratio over a 10s fling | ≤ 5ms/s | XCTOSSignpostMetric | ios | P9 | report-only |
<!-- gates:end -->

## Support library (`e2e/support/`)

| Module | What it gives a spec |
|---|---|
| `budgets.ts` | The §9 catalog (`GATES`, `GateId`) and the headline numbers (`BUDGETS`). |
| `gates.ts`, `gate-recorder.ts` | The registry, `recordGate`, result evaluation. |
| `perf-marks.ts` | `readAlevrMarks`, `measureMarks`, `sampleRuns`, `summarize` (p50/p95, linear interpolation). |
| `screenshot-matrix.ts` | `describeMatrix` (light, dark, high contrast × motion on/off as `test.use`), `settleAnimations` (waits for `document.getAnimations()`), `captureMatrixShot` with baseline compare. |
| `cvd.ts` | Machado 2009 deuteranopia/protanopia/tritanopia as SVG filters and in Node, and `compareShapeMasks`. |
| `axe.ts` | `runAxe` with the installed axe-core; counts serious and critical. Use `test.use({ bypassCSP: true })`. |
| `contrast.ts` | WCAG contrast maths and `readContrast(locator)` against the composited background. |
| `heap.ts`, `layout-shift.ts`, `parity.ts` | CDP heap after GC, sidebar CLS, bubble and composer geometry (web + native exports). |
| `png.ts` | A dependency-free PNG reader/writer and pixel diff. |
| `fixtures.ts` | The seeded fixture ids and P0's route list. |

Playwright projects: the pre-wave-2 projects stay (firefox in CI only), and
`chromium-1440`, `chromium-390` and `webkit-390` run `e2e/wave2/**`. Workers:
1 locally, 2 in CI.

## Native

```sh
ALEVR_ALLOW_LOCAL_NATIVE=1 bash scripts/qa/native-perf.sh --platform macos --suite perf
```

Refuses locally without `ALEVR_ALLOW_LOCAL_NATIVE=1` (CI runs it). Builds the
Stable (Release) configuration, runs every suite named `*PerformanceTests` or
`*SnapshotTests` under each app's `Tests/Performance`, `Tests/Snapshots/Support`
and `Tests/Wave2` (the older snapshot suites keep their own scripts), and shuts
down any simulator booted during the run. Helpers:

- `Tests/Performance/` (identical on macOS and iOS): `wave2MeasureMemory`
  (`XCTMemoryMetric` plus a JSON footprint sample), `wave2MeasureSignpost`
  (`XCTOSSignpostMetric`), `Wave2TestClock` (an injectable `Clock`),
  `Wave2OcclusionMock`, `Wave2PerfReport`.
- `Tests/Snapshots/Support/`: `Wave2SnapshotVariant` and `Wave2Snapshot.render`
  (macOS: light, dark, .xxl, Increase Contrast, Reduce Transparency; iOS: light,
  dark, Increase Contrast, Reduce Transparency, AX3), and
  `Wave2GeometryExport` for the parity gate.

New files under `Tests/` reach the Xcode projects through XcodeGen
(`native/Scripts/generate-projects.sh`), which CI runs before every build.

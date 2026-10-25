/**
 * Every wave-2 gate and its budget, from spec §9 (plus P0's visual matrix).
 *
 * This is the catalog the gate registry (gates.ts) knows. A package turns a
 * gate from report-only to enforced by listing its id in its own
 * `e2e/wave2/<pkg>/gates.ts`; nothing here changes when it does.
 *
 * `check` is the machine-readable budget. Gates without one are pass/fail by
 * nature (the measurement says whether it passed). Numbers are the spec's,
 * unrounded; do not tune them here to make a run pass.
 */

export type GateOp = "lte" | "lt" | "eq" | "gte";
export type GateStat = "value" | "p50" | "p95" | "max" | "min" | "mean";
export type GatePlatform = "web" | "macos" | "ios" | "ci";

export interface GateCheck {
  op: GateOp;
  value: number;
  unit: string;
  /** Which statistic of the samples is compared. Defaults to "value" (or max of samples). */
  stat?: GateStat;
  /** The minimum number of samples a measurement must carry. */
  minSamples?: number;
}

export interface GateDefinition {
  id: string;
  /** Sentence case, as the README shows it. */
  title: string;
  /** The budget as §9 words it. */
  budget: string;
  measuredBy: string;
  /** The packages §9 names as owners: the ones expected to enforce it. */
  owners: readonly string[];
  /** Where the harness for it lives. */
  harness: string;
  platform: GatePlatform;
  check?: GateCheck;
}

export const GATES = [
  {
    id: "chat.enter-bubble",
    title: "Enter → bubble painted",
    budget: "≤ 100ms p95 over 20 runs",
    measuredBy: "marks alevr:enter → alevr:bubble-painted, production build",
    owners: ["P5"],
    harness: "e2e/support/perf-marks.ts",
    platform: "web",
    check: { op: "lte", value: 100, unit: "ms", stat: "p95", minSamples: 20 },
  },
  {
    id: "chat.enter-status",
    title: "Enter → TurnStatus visible (first token at 800ms)",
    budget: "≤ 300ms p95, target 250",
    measuredBy: "alevr:status-visible",
    owners: ["P5"],
    harness: "e2e/support/perf-marks.ts",
    platform: "web",
    check: { op: "lte", value: 300, unit: "ms", stat: "p95" },
  },
  {
    id: "chat.fast-first-token",
    title: "Fast first token (120ms)",
    budget: "TurnStatus never visible",
    measuredBy: "mocked stream; count of TurnStatus Working paints",
    owners: ["P5"],
    harness: "e2e/support/perf-marks.ts",
    platform: "web",
    check: { op: "eq", value: 0, unit: "paints", stat: "max" },
  },
  {
    id: "shell.palette-warm",
    title: "⌘K warm open → rows painted",
    budget: "≤ 1 frame (≤ 20ms)",
    measuredBy: "alevr:palette-open → palette-painted, after idle preload",
    owners: ["P4"],
    harness: "e2e/support/perf-marks.ts",
    platform: "web",
    check: { op: "lte", value: 20, unit: "ms", stat: "p95" },
  },
  {
    id: "shell.palette-cold-shell",
    title: "⌘K cold open → shell",
    budget: "shell in the first frame",
    measuredBy: "preload disabled; alevr:palette-open → palette-shell",
    owners: ["P4"],
    harness: "e2e/support/perf-marks.ts",
    platform: "web",
    check: { op: "lte", value: 20, unit: "ms", stat: "p95" },
  },
  {
    id: "shell.palette-cold-rows",
    title: "⌘K cold open → rows",
    budget: "rows ≤ 150ms",
    measuredBy: "preload disabled; alevr:palette-open → palette-painted",
    owners: ["P4"],
    harness: "e2e/support/perf-marks.ts",
    platform: "web",
    check: { op: "lte", value: 150, unit: "ms", stat: "p95" },
  },
  {
    id: "shell.route-shell",
    title: "Route click → shell visible",
    budget: "≤ 100ms p95 (ROUTE_WAIT_MS 80)",
    measuredBy: "alevr:route-click → shell-visible",
    owners: ["P2", "P4"],
    harness: "e2e/support/perf-marks.ts",
    platform: "web",
    check: { op: "lte", value: 100, unit: "ms", stat: "p95" },
  },
  {
    id: "chat.inp",
    title: "INP on a 1,000-message thread",
    budget: "< 200ms",
    measuredBy: "web-vitals",
    owners: ["P5"],
    harness: "e2e/support/perf-marks.ts",
    platform: "web",
    check: { op: "lt", value: 200, unit: "ms", stat: "max" },
  },
  {
    id: "chat.long-tasks",
    title: "Long tasks while streaming",
    budget: "none > 50ms during a 2,000-token stream at 4× CPU throttle",
    measuredBy: "trace; reports whether the band text-shadow is the cause",
    owners: ["P5"],
    harness: "e2e/support/perf-marks.ts",
    platform: "web",
    check: { op: "eq", value: 0, unit: "long tasks", stat: "max" },
  },
  {
    id: "chat.tail-drain",
    title: "Tail drain",
    budget: "≤ 250ms",
    measuredBy: "marks",
    owners: ["P5"],
    harness: "e2e/support/perf-marks.ts",
    platform: "web",
    check: { op: "lte", value: 250, unit: "ms", stat: "max" },
  },
  {
    id: "shell.sidebar-cls",
    title: "Sidebar CLS on hard load",
    budget: "0",
    measuredBy: "layout-shift entries",
    owners: ["P4"],
    harness: "e2e/support/layout-shift.ts (cross-cutting, P0)",
    platform: "web",
    check: { op: "eq", value: 0, unit: "CLS", stat: "max" },
  },
  {
    id: "web.js-heap",
    title: "Web JS heap after GC",
    budget: "≤ baseline + 10% on the 1,000-message thread",
    measuredBy: "CDP (HeapProfiler.collectGarbage, Runtime.getHeapUsage) against a recorded baseline",
    owners: ["P0"],
    harness: "e2e/support/heap.ts (cross-cutting, P0)",
    platform: "web",
    check: { op: "lte", value: 1.1, unit: "× baseline", stat: "max" },
  },
  {
    id: "motion.galaxy-cap",
    title: "Animating galaxies",
    budget: "≤ 3 per window",
    measuredBy: "data-animating count; Swift test",
    owners: ["P2", "P3"],
    harness: "e2e/support (DOM count)",
    platform: "web",
    check: { op: "lte", value: 3, unit: "galaxies", stat: "max" },
  },
  {
    id: "code.dock-panes",
    title: "Live dock panes",
    budget: "≤ 3; a hidden pane evicted after 10 min (injected clock)",
    measuredBy: "DOM count",
    owners: ["P6"],
    harness: "e2e/support (DOM count)",
    platform: "web",
    check: { op: "lte", value: 3, unit: "panes", stat: "max" },
  },
  {
    id: "a11y.axe",
    title: "axe-core",
    budget: "0 serious or critical on shell, chat, Code, Library, Settings, sign-in",
    measuredBy: "Playwright + axe-core",
    owners: ["P0"],
    harness: "e2e/support/axe.ts (cross-cutting, P0; each owner for its routes)",
    platform: "web",
    check: { op: "eq", value: 0, unit: "serious or critical violations", stat: "max" },
  },
  {
    id: "a11y.cvd-status-shapes",
    title: "Colour-vision deficiency",
    budget: "status fixture under deuteranopia and protanopia filters: hand vs circle-x distinguishable by shape mask",
    measuredBy: "CVD SVG filters + shape-mask comparator",
    owners: ["P2"],
    harness: "e2e/support/cvd.ts (P0)",
    platform: "web",
  },
  {
    id: "design.bubble-composer-parity",
    title: "Bubble and composer parity",
    budget: "six contexts share radii 12/12/12/8 and the user-bubble fill; composer 22 and disc 12 on every platform",
    measuredBy: "computed style on web; native snapshot geometry exports",
    owners: ["P2", "P3", "P5", "P6", "P8", "P9"],
    harness: "e2e/support/parity.ts (cross-cutting, P0)",
    platform: "web",
  },
  {
    id: "visual.route-matrix",
    title: "Visual matrix of routes",
    budget: "no unreviewed change against baselines (report-only until an owner enforces)",
    measuredBy: "screenshots at 1440×900 and 390×844, light, dark and high contrast, reduced motion on and off",
    owners: ["P0"],
    harness: "e2e/support/screenshot-matrix.ts (cross-cutting, P0)",
    platform: "web",
  },
  {
    id: "design.contrast-matrix",
    title: "Contrast matrix",
    budget: "every pair passes per §3.1",
    measuredBy: "P1 CI (scripts/check-contrast-matrix.ts)",
    owners: ["P1"],
    harness: "P1",
    platform: "ci",
  },
  {
    id: "design.lint",
    title: "Lint",
    budget:
      "off-ladder durations, unguarded --motion-* overrides, text-<token>/<NN>, blur in entrance keyframes, backdrop-filter in product chrome, caption or micro in transcript chrome, raw presence hex",
    measuredBy: "ESLint and the native design checks, per eslint-rules/enforce/<pkg>.json",
    owners: ["P1"],
    harness: "P1 enforce files, not gates.ts",
    platform: "ci",
  },
  {
    id: "mac.idle-rss",
    title: "Mac idle RSS",
    budget: "≤ 220MB, 60s after opening a seeded 200-message conversation",
    measuredBy: "Release, XCTMemoryMetric",
    owners: ["P8"],
    harness: "native/macOS/JunoDesktop/Tests/Performance",
    platform: "macos",
    check: { op: "lte", value: 220, unit: "MB", stat: "max" },
  },
  {
    id: "mac.quick-entry-rss",
    title: "Quick Entry memory",
    budget: "≤ +30MB RSS",
    measuredBy: "signpost",
    owners: ["P8"],
    harness: "native/macOS/JunoDesktop/Tests/Performance",
    platform: "macos",
    check: { op: "lte", value: 30, unit: "MB", stat: "max" },
  },
  {
    id: "mac.quick-entry-hotkey",
    title: "Quick Entry hotkey → key window",
    budget: "≤ 120ms",
    measuredBy: "signpost",
    owners: ["P8"],
    harness: "native/macOS/JunoDesktop/Tests/Performance",
    platform: "macos",
    check: { op: "lte", value: 120, unit: "ms", stat: "p95" },
  },
  {
    id: "native.webview-pool",
    title: "WKWebView pool",
    budget: "≤ 3 live",
    measuredBy: "XCTest",
    owners: ["P3", "P8"],
    harness: "native Tests/Performance",
    platform: "macos",
    check: { op: "lte", value: 3, unit: "web views", stat: "max" },
  },
  {
    id: "mac.poll-backoff",
    title: "Mac poll",
    budget: "15s → 60s after 2 min idle; 0 requests while occluded",
    measuredBy: "injected clock",
    owners: ["P8"],
    harness: "native/macOS/JunoDesktop/Tests/Performance (Wave2TestClock, Wave2OcclusionMock)",
    platform: "macos",
  },
  {
    id: "ios.thread-memory",
    title: "iOS 1,000-message thread memory",
    budget: "≤ 300MB on open (40-turn window)",
    measuredBy: "Release, XCTMemoryMetric",
    owners: ["P9"],
    harness: "native/iOS/JunoMobile/Tests/Performance",
    platform: "ios",
    check: { op: "lte", value: 300, unit: "MB", stat: "max" },
  },
  {
    id: "ios.paging",
    title: "iOS paging 40 earlier turns",
    budget: "≤ 250ms",
    measuredBy: "XCTOSSignpostMetric",
    owners: ["P9"],
    harness: "native/iOS/JunoMobile/Tests/Performance",
    platform: "ios",
    check: { op: "lte", value: 250, unit: "ms", stat: "p95" },
  },
  {
    id: "ios.hitch-ratio",
    title: "iOS hitch ratio over a 10s fling",
    budget: "≤ 5ms/s",
    measuredBy: "XCTOSSignpostMetric",
    owners: ["P9"],
    harness: "native/iOS/JunoMobile/Tests/Performance",
    platform: "ios",
    check: { op: "lte", value: 5, unit: "ms/s", stat: "max" },
  },
] as const satisfies readonly GateDefinition[];

export type GateId = (typeof GATES)[number]["id"];

export const GATE_IDS: readonly GateId[] = GATES.map((gate) => gate.id);

export function gateById(id: string): GateDefinition | undefined {
  return (GATES as readonly GateDefinition[]).find((gate) => gate.id === id);
}

/** §9's headline numbers, for specs that need a number rather than a gate. */
export const BUDGETS = {
  enterToBubbleP95Ms: 100,
  enterToBubbleRuns: 20,
  enterToStatusP95Ms: 300,
  enterToStatusTargetMs: 250,
  fastFirstTokenMs: 120,
  slowFirstTokenMs: 800,
  paletteWarmMs: 20,
  paletteColdRowsMs: 150,
  routeShellP95Ms: 100,
  routeWaitMs: 80,
  inpMs: 200,
  longTaskMs: 50,
  streamTokens: 2000,
  cpuThrottle: 4,
  tailDrainMs: 250,
  sidebarCls: 0,
  heapOverBaseline: 0.1,
  galaxiesAnimatingMax: 3,
  dockPanesMax: 3,
  dockPaneEvictMinutes: 10,
  macIdleRssMb: 220,
  quickEntryRssMb: 30,
  quickEntryHotkeyMs: 120,
  webViewPoolMax: 3,
  macPollActiveS: 15,
  macPollIdleS: 60,
  macPollIdleAfterMin: 2,
  iosThreadMemoryMb: 300,
  iosPagingMs: 250,
  iosHitchMsPerS: 5,
  bubbleRadii: [12, 12, 12, 8] as const,
  composerRadius: 22,
  discRadius: 12,
} as const;

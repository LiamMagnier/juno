/**
 * The gates P1-pipeline enforces (spec §9, §14 "Gate enforcement"). P0's
 * registry (e2e/support/gates.ts) globs e2e/wave2/<pkg>/gates.ts and reads
 * this array literal without running the file; every id must be one of the
 * catalog ids in e2e/support/budgets.ts, or the whole run reports an error.
 * A gate listed here fails the run, every other gate only reports.
 *
 * Both are measured in CI outside Playwright (scripts/check-contrast-matrix.ts
 * in native-parity.yml, ESLint with eslint-rules/enforce/p1.json); they are
 * listed so the registry's report names their owner. The visual checks in
 * pipeline.spec.ts (no entrance blur, reduced-motion Tier B, the prose
 * measure, the view-transition root) are plain Playwright assertions and fail
 * the run on their own; they are not catalog gates.
 *
 * Keep this a plain list of string literals (no imports): the registry parses
 * it as text.
 */
export const enforce = ["design.contrast-matrix", "design.lint"] as const;

export default enforce;

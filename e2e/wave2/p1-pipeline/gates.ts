/**
 * The gates P1-pipeline enforces (spec §9, §14 "Gate enforcement"). P0's
 * registry globs e2e/wave2/<pkg>/gates.ts; a gate listed here fails the run,
 * every other gate only reports.
 *
 * The contrast matrix and the lint are enforced in CI outside Playwright
 * (scripts/check-contrast-matrix.ts in native-parity.yml, ESLint with
 * eslint-rules/enforce/p1.json); they are listed so the registry's report
 * names their owner.
 */
export const enforce = [
  "contrast-matrix",
  "lint",
  "p1.no-entrance-blur",
  "p1.reduced-motion-tier-b",
  "p1.prose-measure",
  "p1.view-transition-root",
] as const;

export default enforce;

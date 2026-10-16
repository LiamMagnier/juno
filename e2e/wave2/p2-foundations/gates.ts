/**
 * The gates P2-web-foundations enforces (spec §9, P2 acceptance: "This
 * package's gates.ts enforces the galaxy-cap and CVD gates"). P0's registry
 * (e2e/support/gates.ts) globs e2e/wave2/<pkg>/gates.ts and reads this array
 * literal without running the file; every id must be a catalog id in
 * e2e/support/budgets.ts. A gate listed here fails the run; every other gate
 * only reports.
 *
 *   motion.galaxy-cap       at most 3 animating galaxies per window (data-animating count)
 *   a11y.cvd-status-shapes  hand vs circle-x distinguishable by shape under deuteranopia and protanopia
 *
 * Keep this a plain list of string literals (no imports): the registry parses
 * it as text.
 */
export const enforce = ["motion.galaxy-cap", "a11y.cvd-status-shapes"] as const;

export default enforce;

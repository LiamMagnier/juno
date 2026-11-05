import type { GateId } from "../../support/budgets";

/*
 * The gates P0 enforces. None, on purpose: spec appendix P0 (5) keeps the
 * cross-cutting gates report-only until an owner enforces them. An owner
 * enforces a gate by listing its id in its own e2e/wave2/<pkg>/gates.ts, e.g.
 *
 *   export const enforce = ["shell.sidebar-cls"] as const satisfies readonly GateId[];
 *
 * The registry (e2e/support/gates.ts) reads the array literal without running
 * this file, so keep it a plain list of string literals.
 */
export const enforce = [] as const satisfies readonly GateId[];

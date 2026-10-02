/**
 * The two risk vocabularies, and the only place they meet (SPEC §3.2).
 *
 * `ToolRisk` is how a tool describes itself: what it can do to the world if it
 * runs. `ActionRiskClass` is the broker's word for the same thing, and it is
 * the only one that ever goes on the wire (INV-5): an approval card, a receipt
 * and the native clients all speak the broker's vocabulary. The tool record's
 * `risk` stays on the server and in `ResolvedTool`; the UI never renders it.
 *
 * Pure and client-safe.
 */

import type { ActionRiskClass } from "@/lib/action-approval";
import type { ToolRisk } from "@/lib/tools/types";

export function toActionRiskClass(risk: ToolRisk): Exclude<ActionRiskClass, "unknown"> {
  switch (risk) {
    case "read": return "read_only";
    case "write": return "reversible_write";
    case "external": return "external_write";
    case "destructive": return "destructive_or_sensitive";
  }
}

/**
 * Reverse map for connector tools, whose risk comes from the broker's
 * classifier. `unknown` reads as `external`: a connector that did not say what
 * a tool does is treated as one that changes something, which asks (DECISIONS
 * T2) and never runs in parallel.
 */
export function fromActionRiskClass(cls: ActionRiskClass): ToolRisk {
  switch (cls) {
    case "read_only": return "read";
    case "reversible_write": return "write";
    case "external_write": return "external";
    case "destructive_or_sensitive": return "destructive";
    case "unknown": return "external";
  }
}

/**
 * Old tool ids that stay valid forever (INV-23, SPEC §3.5).
 *
 * Two tools changed name in the chat rework: `code_interpreter` became
 * `run_code`, and `browser_agent` — a page reader that advertised clicks and
 * typing it never performed — gave way to `web_fetch`. Neither old name can
 * simply disappear, because each is stored somewhere a person put it: a
 * skill's `requestedTools`, an assistant's `allowedTools`, a standing approval
 * keyed by tool name, a persisted activity row, a history note. A reader that
 * met the old name and did not recognise it would quietly narrow a skill to
 * nothing or drop a grant the person made.
 *
 * So every reader of a stored or configured tool id maps it through
 * `canonicalToolId` first. Writers use the new names; stored values are never
 * rewritten.
 *
 * Pure and client-safe.
 */

import type { CanonicalToolId } from "@/types/run";

export const TOOL_ID_ALIASES: Readonly<Record<string, CanonicalToolId>> = {
  code_interpreter: "run_code",
  browser_agent: "web_fetch",
  // Alevr Search's names in the brief (§15): a skill or an assistant that asks
  // for `search_web` or `open_page` gets the same two tools under their ids.
  search_web: "web_search",
  open_page: "web_fetch",
};

/** The alias target, or the id unchanged. */
export function canonicalToolId(id: string): string {
  return Object.prototype.hasOwnProperty.call(TOOL_ID_ALIASES, id) ? TOOL_ID_ALIASES[id] : id;
}

/**
 * Every stored name that means `canonical`: the canonical id first, then its
 * aliases. The broker's standing-grant lookup tries them in this order, so a
 * grant made under the old name keeps working after the rename.
 */
export function toolIdAliasesOf(canonical: string): string[] {
  const names = [canonical];
  for (const [alias, target] of Object.entries(TOOL_ID_ALIASES)) {
    if (target === canonical) names.push(alias);
  }
  return names;
}

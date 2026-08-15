/**
 * Juno Design — what an instance actually shows.
 *
 * `InstanceNode` has carried two fields since the first slice that nothing in
 * the product could act on. `variantProperties` said which variant of a set the
 * instance was, and `overrides` said which of its inner nodes had been changed
 * — and both were written by the AI adjustment panel and the prototype editor
 * and read by *nothing that draws*: not the renderer, not the layout engine, not
 * one of the eight exporters. `createInstance` copies the main component's
 * subtree once, at creation, and after that an instance is an ordinary frame
 * whose `variantProperties` are a note in the margin.
 *
 * That is what this module exists to end. It is the reading half — pure, no
 * mutation, no operation types — that answers the three questions an honest
 * instance UI has to be able to ask:
 *
 *  - **Which switches does this component's set actually offer?** `variantAxes`.
 *  - **Which node is a given combination of them?** `variantRootFor`.
 *  - **Which key is a combination, canonically?** `canonicalVariantKey`.
 *
 * `ComponentProperty` — the boolean/text/instance-swap half of the model — is
 * deliberately not here. Its `targetNodeId` names a node inside the *main
 * component*, and `createInstance` builds the main-id → copy-id map and throws
 * it away, so nothing in the document can say which node inside a given instance
 * a property drives. That map has to be reconstructed or recorded before a
 * property control can be anything but a field that writes to a record nobody
 * reads, and reconstructing it is a piece of work of its own.
 *
 * Nothing here falls back. A variant key with no node behind it returns `null`
 * rather than the component's default, because every caller is about to write to
 * the document with the answer, and a *plausible* variant is the one kind of
 * wrong nobody notices until the button that shipped is the wrong button.
 */

import type { ComponentDefinition, DesignDocument, DesignNode } from "@/lib/design/types";

/**
 * The canonical `"prop=value,prop=value"` a variant set is keyed by.
 *
 * Sorted by property name so `{size:"lg", tone:"quiet"}` and `{tone:"quiet",
 * size:"lg"}` are the same variant — a record has no order and two callers
 * building the same selection in different orders must not miss each other.
 */
export function canonicalVariantKey(properties: Record<string, string>): string {
  return Object.keys(properties)
    .sort()
    .map((k) => `${k}=${properties[k]}`)
    .join(",");
}

/**
 * Every variant property a component's set actually offers, and its values.
 *
 * Derived from the keys of `variants` rather than from `properties`, because
 * `variants` is what `createVariant` writes and `properties` is a separate,
 * optional description that a component built by the AI or by "promote to
 * component" does not have. A UI built from `properties` would show nothing for
 * most real components; one built from this shows exactly the switches that have
 * a node behind them.
 */
export function variantAxes(component: ComponentDefinition): { name: string; values: string[] }[] {
  const axes = new Map<string, Set<string>>();
  for (const key of Object.keys(component.variants)) {
    if (!key) continue;
    for (const pair of key.split(",")) {
      const split = pair.indexOf("=");
      if (split <= 0) continue;
      const name = pair.slice(0, split);
      const value = pair.slice(split + 1);
      const values = axes.get(name) ?? new Set<string>();
      values.add(value);
      axes.set(name, values);
    }
  }
  return [...axes.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, values]) => ({ name, values: [...values].sort() }));
}

/**
 * The node a set of variant properties selects, or `null`.
 *
 * The empty selection resolves to the component's own root, which is what an
 * instance created before any variant existed is showing — so
 * `variantRootFor(component, instance.variantProperties)` answers correctly for
 * every instance in every document written so far, not only for ones authored
 * against a variant set.
 *
 * A key that names no node is `null` and not `rootNodeId`: silently showing the
 * default when someone asked for `size=jumbo` is how a design ends up shipping
 * the wrong button with nothing anywhere reporting a problem.
 */
export function variantRootFor(
  doc: DesignDocument,
  component: ComponentDefinition,
  variantProperties: Record<string, string>
): DesignNode | null {
  const key = canonicalVariantKey(variantProperties);
  const id = key === "" ? component.rootNodeId : component.variants[key];
  const node = id ? doc.nodes[id] : undefined;
  return node ?? null;
}

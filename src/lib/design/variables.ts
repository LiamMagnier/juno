/**
 * Design variables: collections, modes, aliases, and the bindings that put a
 * token on a visual property.
 *
 * Resolution is deliberately explicit about the two ways a lookup can fail —
 * an alias chain that loops, and a mode a variable has no value for — because
 * silently returning a default is how a token system stops being trustworthy.
 */

import type {
  CollectionId,
  DesignDocument,
  DesignNode,
  DesignVariable,
  Rgba,
  VariableId,
  VariableValue,
} from "@/lib/design/types";

export type ResolvedValue =
  | { ok: true; value: Rgba | number | string | boolean; type: DesignVariable["type"] }
  | { ok: false; reason: "missing-variable" | "missing-mode" | "alias-cycle" | "type-mismatch" };

const MAX_ALIAS_DEPTH = 16;

/** The mode currently in force for a collection. */
export function activeModeId(doc: DesignDocument, collectionId: CollectionId): string | null {
  const collection = doc.collections[collectionId];
  if (!collection) return null;
  const active = doc.activeModes[collectionId];
  if (active && collection.modes.some((m) => m.id === active)) return active;
  return collection.modes[0]?.id ?? null;
}

/**
 * Resolve a variable to a concrete value in the collection's active mode,
 * following aliases across collections.
 *
 * Mode inheritance: a variable with no entry for the active mode falls back to
 * its collection's FIRST mode, which is the collection's declared default. That
 * is what makes "add a Dark mode and only override the six colours that differ"
 * work without restating every token.
 */
export function resolveVariable(doc: DesignDocument, variableId: VariableId, depth = 0): ResolvedValue {
  if (depth > MAX_ALIAS_DEPTH) return { ok: false, reason: "alias-cycle" };
  const variable = doc.variables[variableId];
  if (!variable) return { ok: false, reason: "missing-variable" };

  const modeId = activeModeId(doc, variable.collectionId);
  if (!modeId) return { ok: false, reason: "missing-mode" };

  const entry: VariableValue | undefined =
    variable.valuesByMode[modeId] ?? variable.valuesByMode[doc.collections[variable.collectionId]?.modes[0]?.id ?? ""];
  if (!entry) return { ok: false, reason: "missing-mode" };

  if (entry.kind === "alias") {
    const target = resolveVariable(doc, entry.value, depth + 1);
    if (!target.ok) return target;
    // An alias may only point at a variable of the same type; a colour aliasing
    // a number would resolve to something the bound property cannot use.
    if (target.type !== variable.type) return { ok: false, reason: "type-mismatch" };
    return target;
  }

  return { ok: true, value: entry.value, type: variable.type };
}

/** Every variable in a collection, resolved in the active mode. */
export function resolveCollection(doc: DesignDocument, collectionId: CollectionId): Record<string, ResolvedValue> {
  const out: Record<string, ResolvedValue> = {};
  for (const variable of Object.values(doc.variables)) {
    if (variable.collectionId !== collectionId) continue;
    out[variable.name] = resolveVariable(doc, variable.id);
  }
  return out;
}

/**
 * A node with its bound variables applied, for rendering.
 *
 * Never mutates the document: bindings are resolved at paint time so switching
 * a mode re-renders without rewriting a single node, which is the whole point of
 * binding rather than copying a value in.
 */
export function applyBoundVariables(doc: DesignDocument, node: DesignNode): DesignNode {
  const bindings = Object.entries(node.boundVariables);
  if (bindings.length === 0) return node;

  const clone = (typeof structuredClone === "function" ? structuredClone(node) : JSON.parse(JSON.stringify(node))) as DesignNode;
  for (const [path, variableId] of bindings) {
    const resolved = resolveVariable(doc, variableId);
    if (!resolved.ok) continue; // an unresolvable binding leaves the authored value visible
    writePath(clone as unknown as Record<string, unknown>, path, resolved.value);
  }
  return clone;
}

/** Write `value` at a dotted path, creating nothing — a path that does not
 *  already exist is ignored rather than invented. */
function writePath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let cursor: unknown = target;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cursor || typeof cursor !== "object") return;
    cursor = (cursor as Record<string, unknown>)[parts[i]];
  }
  if (!cursor || typeof cursor !== "object") return;
  const last = parts[parts.length - 1];
  if (!(last in (cursor as Record<string, unknown>))) return;
  (cursor as Record<string, unknown>)[last] = value;
}

/** Property paths a variable of a given type may legally bind to. Enforced by
 *  the AI tool layer so a model cannot bind a boolean to a corner radius. */
export function bindablePaths(type: DesignVariable["type"]): string[] {
  switch (type) {
    case "color":
      // `shadows.0.color` was here until shadows became entries in the effect
      // stack. `writePath` creates nothing for a path that names no field, so
      // leaving it listed would offer the model a binding that silently did
      // nothing — worse than not offering it, because the document would record
      // a variable that never reaches the drawing.
      return ["fills.0.color", "fills.1.color", "strokes.0.paint.color", "effects.0.color"];
    case "number":
      return ["cornerRadius", "opacity", "width", "height", "x", "y", "rotation", "typography.fontSize", "typography.letterSpacing", "strokes.0.weight"];
    case "string":
      return ["characters", "typography.fontFamily", "name"];
    case "boolean":
      return ["visible", "locked", "clipsContent"];
  }
}

export function isBindable(type: DesignVariable["type"], path: string): boolean {
  return bindablePaths(type).includes(path);
}

// ---------------------------------------------------------------------------
// Token interchange
// ---------------------------------------------------------------------------

export interface TokenExport {
  version: 1;
  collections: {
    name: string;
    modes: string[];
    tokens: { name: string; type: DesignVariable["type"]; values: Record<string, unknown> }[];
  }[];
}

/** JSON export shaped for later synchronization with code tokens: names, not
 *  ids, so a token file survives a document being re-created. */
export function exportTokens(doc: DesignDocument): TokenExport {
  return {
    version: 1,
    collections: Object.values(doc.collections).map((collection) => ({
      name: collection.name,
      modes: collection.modes.map((m) => m.name),
      tokens: Object.values(doc.variables)
        .filter((v) => v.collectionId === collection.id)
        .map((variable) => ({
          name: variable.name,
          type: variable.type,
          values: Object.fromEntries(
            collection.modes.map((mode) => {
              const entry = variable.valuesByMode[mode.id];
              if (!entry) return [mode.name, null];
              if (entry.kind === "alias") {
                return [mode.name, { alias: doc.variables[entry.value]?.name ?? entry.value }];
              }
              return [mode.name, entry.value];
            })
          ),
        })),
    })),
  };
}

export function rgbaToHex(color: Rgba): string {
  const to255 = (n: number) => Math.max(0, Math.min(255, Math.round(n * 255)));
  const hex = (n: number) => to255(n).toString(16).padStart(2, "0");
  const base = `#${hex(color.r)}${hex(color.g)}${hex(color.b)}`;
  return color.a >= 1 ? base : `${base}${hex(color.a)}`;
}

export function hexToRgba(hex: string): Rgba | null {
  const clean = hex.trim().replace(/^#/, "");
  const expand = clean.length === 3 || clean.length === 4 ? clean.split("").map((c) => c + c).join("") : clean;
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(expand)) return null;
  const value = (start: number) => parseInt(expand.slice(start, start + 2), 16) / 255;
  return { r: value(0), g: value(2), b: value(4), a: expand.length === 8 ? value(6) : 1 };
}

export function rgbaToCss(color: Rgba): string {
  const to255 = (n: number) => Math.max(0, Math.min(255, Math.round(n * 255)));
  return `rgba(${to255(color.r)}, ${to255(color.g)}, ${to255(color.b)}, ${Math.round(color.a * 1000) / 1000})`;
}

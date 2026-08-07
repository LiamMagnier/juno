/**
 * Deterministic JSON, and nothing else.
 *
 * Split out of `digests.ts` for one reason: `digests.ts` imports `node:crypto`,
 * and `canonicalize` is the one thing in it that a *browser* needs.
 * `triggers.ts` is deliberately pure and client-safe — the schedule editor
 * imports it so that the client and the server judge a trigger draft by the
 * same rules — so `work-triggers.tsx` pulls `triggers.ts` into the client
 * bundle, which pulled `digests.ts` in behind it, which asked webpack to bundle
 * `node:crypto` for the browser. That is not a type error and no test catches
 * it; it is a build failure, and it took the whole production build down:
 *
 *     Module build failed: UnhandledSchemeError:
 *     Reading from "node:crypto" is not handled by plugins
 *       ./src/lib/work/digests.ts
 *       ./src/lib/work/triggers.ts
 *       ./src/components/work/work-triggers.tsx
 *
 * One definition still, not two. `digests.ts` re-exports from here, so every
 * existing caller is unchanged and the canonical form a digest is taken over
 * cannot drift from the canonical form a comparison uses.
 */

/**
 * Deterministic JSON: object keys sorted, `undefined` dropped, no whitespace.
 *
 * `JSON.stringify` preserves insertion order, so `{a, b}` and `{b, a}` — the
 * same action, built by two code paths, or round-tripped through a JSONB column
 * that did not preserve the original order — hash differently. A digest that
 * changes when nothing about the action changed proves nothing: every mismatch
 * becomes noise, and the check gets disabled by whoever is on call the night it
 * starts firing.
 */
export function canonicalize(value: unknown): string {
  return encode(value, new Set<object>());
}

function encode(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      // JSON has no NaN or Infinity. Writing `null` for both is what
      // JSON.stringify does, and matching it keeps the canonical form parseable.
      return Number.isFinite(value) ? JSON.stringify(value) : "null";
    case "boolean":
      return value ? "true" : "false";
    case "bigint":
      // As a string, because a bigint large enough to matter cannot survive
      // JSON.parse as a number and would come back a different value.
      return JSON.stringify(value.toString());
    case "undefined":
    case "function":
    case "symbol":
      // Only reachable inside an array, where JSON writes a hole as `null`.
      // As an object property these are dropped by the object branch below.
      return "null";
    default:
      break;
  }

  const object = value as object;
  if (ancestors.has(object)) {
    // A cycle has no canonical form, and silently emitting a placeholder would
    // make two genuinely different actions hash the same.
    throw new TypeError("canonicalize: a cyclic value has no canonical form");
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString());

  ancestors.add(object);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => encode(item, ancestors)).join(",")}]`;
    }
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, entry]) => entry !== undefined && typeof entry !== "function" && typeof entry !== "symbol"
    );
    // Compared by UTF-16 code unit, never `localeCompare`: a locale-aware sort
    // orders keys differently on a host with a different ICU build, which would
    // make the same action hash differently on two machines in the same fleet.
    entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${encode(entry, ancestors)}`).join(",")}}`;
  } finally {
    ancestors.delete(object);
  }
}
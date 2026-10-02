/**
 * Tool input schemas, per provider (SPEC §3.1, §5.3 item 2).
 *
 * Two kinds of schema reach a model, and they need opposite treatment.
 *
 * JUNO'S OWN tools declare the portable subset (DECISIONS T2): `type`,
 * `properties`, `required`, `items`, `enum` and `description`, nothing else.
 * Every provider accepts that subset as it is, so the per-provider functions
 * below are copies with at most one dialect detail each — which is the point
 * of the subset. `portableSchemaIssues` is how a spec is held to it.
 *
 * CONNECTOR tools arrive with whatever JSON Schema their server wrote:
 * `$schema`, `$ref`/`$defs`, `oneOf`, `const`, `additionalProperties`… Anthropic,
 * OpenAI and the compat hosts take JSON Schema and pass them through. Gemini
 * does not: its `parameters` field is an OpenAPI 3.0 subset that rejects most of
 * those keywords, which is why a turn with a GitHub connector used to 400 on
 * Gemini before the model saw a word (RC-4). Connector schemas therefore go to
 * Gemini's `parametersJsonSchema` instead, after `sanitizeForGeminiJsonSchema`
 * cuts them down to the JSON Schema subset Google documents. Probe P1 decides
 * whether the allowlist can widen; until then it keeps only what is documented.
 *
 * Pure and client-safe: the adapters' loops and the tests import it.
 */

import type { PortableProperty, PortableSchema } from "@/lib/tools/types";

// ── The portable subset ───────────────────────────────────────────────────────

const PORTABLE_KEYS: Record<string, ReadonlySet<string>> = {
  root: new Set(["type", "properties", "required"]),
  string: new Set(["type", "description", "enum"]),
  number: new Set(["type", "description"]),
  integer: new Set(["type", "description"]),
  boolean: new Set(["type", "description"]),
  array: new Set(["type", "description", "items"]),
  object: new Set(["type", "description", "properties", "required"]),
};

/**
 * Every way `schema` leaves the portable subset, as `path: problem` lines; empty
 * when it is portable. Checks the shape at runtime because a spec's schema is a
 * literal that a cast can smuggle anything into.
 */
export function portableSchemaIssues(schema: unknown): string[] {
  const issues: string[] = [];
  if (!isRecord(schema)) return ["(root): not an object"];
  if (schema.type !== "object") issues.push(`(root): type must be "object"`);
  checkKeys(schema, PORTABLE_KEYS.root, "(root)", issues);
  checkObjectBody(schema, "(root)", issues);
  return issues;
}

function checkProperty(value: unknown, at: string, issues: string[]): void {
  if (!isRecord(value)) {
    issues.push(`${at}: not an object`);
    return;
  }
  const type = value.type;
  const allowed = typeof type === "string" ? PORTABLE_KEYS[type] : undefined;
  if (!allowed || type === "root") {
    issues.push(`${at}: type ${JSON.stringify(type)} is not portable`);
    return;
  }
  checkKeys(value, allowed, at, issues);
  if (typeof value.description !== "string" || !value.description.trim()) {
    issues.push(`${at}: description is required`);
  }
  if (type === "string" && value.enum !== undefined) {
    if (!Array.isArray(value.enum) || value.enum.length === 0 || value.enum.some((v) => typeof v !== "string")) {
      issues.push(`${at}: enum must be a non-empty list of strings`);
    }
  }
  if (type === "array") checkProperty(value.items, `${at}.items`, issues);
  if (type === "object") checkObjectBody(value, at, issues);
}

function checkObjectBody(value: Record<string, unknown>, at: string, issues: string[]): void {
  if (!isRecord(value.properties)) {
    issues.push(`${at}: properties must be an object`);
    return;
  }
  for (const [key, property] of Object.entries(value.properties)) {
    checkProperty(property, `${at}.${key}`, issues);
  }
  if (value.required !== undefined) {
    if (!Array.isArray(value.required) || value.required.some((k) => typeof k !== "string")) {
      issues.push(`${at}: required must be a list of strings`);
    } else {
      for (const key of value.required as string[]) {
        if (!(key in value.properties)) issues.push(`${at}: required "${key}" is not a property`);
      }
    }
  }
}

function checkKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, at: string, issues: string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.push(`${at}: "${key}" is outside the portable subset`);
  }
}

/**
 * Why `value` does not satisfy `schema`, or null when it does: required keys,
 * primitive types and enum membership, recursively. The subset has nothing else
 * to check. Used to validate structured output before it is handed on.
 */
export function portableValueIssue(schema: PortableSchema, value: unknown): string | null {
  return objectIssue(schema.properties, schema.required, value, "");
}

function objectIssue(
  properties: Record<string, PortableProperty>,
  required: readonly string[] | undefined,
  value: unknown,
  at: string,
): string | null {
  if (!isRecord(value)) return `${at || "the output"} must be a JSON object`;
  for (const key of required ?? []) {
    if (value[key] === undefined) return `"${at ? `${at}.` : ""}${key}" is required`;
  }
  for (const [key, property] of Object.entries(properties)) {
    if (value[key] === undefined) continue;
    const issue = propertyIssue(property, value[key], at ? `${at}.${key}` : key);
    if (issue) return issue;
  }
  return null;
}

function propertyIssue(property: PortableProperty, value: unknown, at: string): string | null {
  switch (property.type) {
    case "string":
      if (typeof value !== "string") return `"${at}" must be a string`;
      if (property.enum && !property.enum.includes(value)) return `"${at}" must be one of ${property.enum.join(", ")}`;
      return null;
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? null : `"${at}" must be a number`;
    case "integer":
      return Number.isInteger(value) ? null : `"${at}" must be an integer`;
    case "boolean":
      return typeof value === "boolean" ? null : `"${at}" must be a boolean`;
    case "array": {
      if (!Array.isArray(value)) return `"${at}" must be an array`;
      for (let i = 0; i < value.length; i++) {
        const issue = propertyIssue(property.items, value[i], `${at}[${i}]`);
        if (issue) return issue;
      }
      return null;
    }
    case "object":
      return objectIssue(property.properties, property.required, value, at);
  }
}

// ── Portable → each provider ──────────────────────────────────────────────────

/** Anthropic `input_schema`: JSON Schema, and the subset is already valid JSON Schema. */
export function portableToAnthropic(schema: PortableSchema): { type: "object"; properties: Record<string, unknown>; required?: string[] } {
  return clone(schema);
}

/** OpenAI (Responses) function `parameters`: JSON Schema, non-strict, so the subset as it is. */
export function portableToOpenAI(schema: PortableSchema): Record<string, unknown> {
  return clone(schema);
}

/** OpenAI-compatible `function.parameters`: the same JSON Schema. */
export function portableToCompat(schema: PortableSchema): Record<string, unknown> {
  return clone(schema);
}

/**
 * Gemini `FunctionDeclaration.parameters`: the OpenAPI 3.0 subset. The portable
 * keys are all in it; the one dialect difference is that Google documents a
 * string enum as `format: "enum"`, so that is added where an enum appears.
 */
export function portableToGemini(schema: PortableSchema): Record<string, unknown> {
  return withEnumFormat(clone(schema) as unknown as Record<string, unknown>);
}

function withEnumFormat(node: Record<string, unknown>): Record<string, unknown> {
  if (node.type === "string" && Array.isArray(node.enum)) node.format = "enum";
  if (isRecord(node.items)) withEnumFormat(node.items);
  if (isRecord(node.properties)) {
    for (const child of Object.values(node.properties)) if (isRecord(child)) withEnumFormat(child);
  }
  return node;
}

// ── Connector schemas → Gemini `parametersJsonSchema` ─────────────────────────

/**
 * The JSON Schema keywords Google's structured-output guide lists as supported
 * (2026-09-17). `$ref` is resolved here rather than passed, so it is not listed.
 * Everything else is dropped until probe P1 shows it is tolerated.
 */
const GEMINI_JSON_SCHEMA_KEYS = new Set([
  "type", "title", "description", "properties", "required", "additionalProperties",
  "enum", "format", "minimum", "maximum", "items", "prefixItems", "minItems", "maxItems", "anyOf",
]);

const JSON_TYPES = new Set(["string", "number", "integer", "boolean", "array", "object", "null"]);

/** Formats Google documents for structured output; any other `format` is dropped rather than risked. */
const GEMINI_FORMATS = new Set(["date-time", "date", "time", "int32", "int64", "float", "double", "enum"]);

/** How deep a chain of `$ref`s may go before it is cut (SPEC §5.3 item 2). */
const MAX_REF_DEPTH = 8;
/** Nesting bound for the walk itself, so a hostile schema cannot exhaust the stack. */
const MAX_NESTING = 32;
/**
 * How many nodes `$ref` expansion may emit across the WHOLE schema. The depth
 * bound alone does not bound a DAG of shared definitions, which grows as
 * fan-out^depth: eight levels of eight properties each, all pointing at the
 * next level, turn 2 KB of schema into ~480 MB and seconds of synchronous CPU
 * on every Gemini request that carries the connector. Past this budget a
 * `$ref` is no longer followed, so the output stays linear in the input.
 */
const MAX_EXPANDED_NODES = 2_000;

interface SanitizeScope {
  root: Record<string, unknown>;
  /** `$ref` targets being expanded on the current path: a repeat is a cycle. */
  expanding: readonly string[];
  depth: number;
  /** Shared by the whole walk: nodes emitted inside `$ref` expansions so far. */
  budget: { expanded: number };
}

/**
 * A connector's input schema, reduced to what Gemini's `parametersJsonSchema`
 * documents (SPEC §5.3 item 2): `$schema`, `$id` and `$comment` stripped;
 * `const` → a one-value `enum`; `oneOf` → `anyOf`; local `$ref`s into `$defs` or
 * `definitions` inlined (a chain deeper than 8, or a cycle, becomes `{}`; once
 * expansion has emitted 2,000 nodes, a further `$ref` keeps only its siblings,
 * such as its description); `allOf` merged into its parent; every other keyword
 * outside the subset dropped. `required` keeps only names that are properties.
 * The root is always an object schema.
 *
 * Never throws and never mutates its input: a schema is third-party data, and a
 * tool that cannot be described precisely is still better offered loosely than
 * taking the whole turn down with it.
 */
export function sanitizeForGeminiJsonSchema(schema: unknown): Record<string, unknown> {
  const root = isRecord(schema) ? schema : {};
  const out = sanitizeNode(root, { root, expanding: [], depth: 0, budget: { expanded: 0 } });
  if (out.type !== "object") {
    // A function's parameters are an object on every provider. A root that is
    // anything else (or nothing) cannot be called with arguments at all.
    return { type: "object", properties: isRecord(out.properties) ? out.properties : {} };
  }
  if (!isRecord(out.properties)) out.properties = {};
  return out;
}

function sanitizeNode(node: unknown, scope: SanitizeScope): Record<string, unknown> {
  if (!isRecord(node) || scope.depth > MAX_NESTING) return {};
  if (scope.expanding.length > 0) scope.budget.expanded += 1;

  const ref = typeof node.$ref === "string" ? node.$ref : null;
  if (ref !== null) {
    const target = resolveLocalRef(scope.root, ref);
    if (!target || scope.expanding.includes(ref) || scope.expanding.length >= MAX_REF_DEPTH) return {};
    // Siblings of a `$ref` (a description, say) refine the target; they are
    // merged over it, which is how drafts 2019+ read them.
    const { $ref: _ref, ...siblings } = node;
    // Past the walk's budget the reference is offered loosely: what the
    // schema said about it in place survives, the shared definition does not.
    if (scope.budget.expanded >= MAX_EXPANDED_NODES) return sanitizeNode(siblings, { ...scope, depth: scope.depth + 1 });
    const expanded = sanitizeNode(target, { ...scope, expanding: [...scope.expanding, ref], depth: scope.depth + 1 });
    const extra = sanitizeNode(siblings, { ...scope, depth: scope.depth + 1 });
    return { ...expanded, ...extra };
  }

  const child = (value: unknown) => sanitizeNode(value, { ...scope, depth: scope.depth + 1 });
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(node)) {
    switch (key) {
      case "type": {
        const types = (Array.isArray(value) ? value : [value]).filter(
          (t): t is string => typeof t === "string" && JSON_TYPES.has(t),
        );
        if (types.length === 1) out.type = types[0];
        else if (types.length > 1) out.type = [...new Set(types)];
        break;
      }
      case "title":
      case "description":
        if (typeof value === "string") out[key] = value;
        break;
      case "properties":
        if (isRecord(value)) {
          const properties: Record<string, unknown> = {};
          for (const [name, property] of Object.entries(value)) properties[name] = child(property);
          out.properties = properties;
        }
        break;
      case "required":
        if (Array.isArray(value)) out.required = value.filter((k): k is string => typeof k === "string");
        break;
      case "additionalProperties":
        if (typeof value === "boolean") out.additionalProperties = value;
        else if (isRecord(value)) out.additionalProperties = child(value);
        break;
      case "enum":
        if (Array.isArray(value)) {
          const values = value.filter((v) => v === null || ["string", "number", "boolean"].includes(typeof v));
          if (values.length > 0) out.enum = values;
        }
        break;
      case "const":
        if (value === null || ["string", "number", "boolean"].includes(typeof value)) out.enum = [value];
        break;
      case "format":
        if (typeof value === "string" && GEMINI_FORMATS.has(value)) out.format = value;
        break;
      case "minimum":
      case "maximum":
      case "minItems":
      case "maxItems":
        if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
        break;
      case "items":
        // Draft-4 tuple form (`items: [...]`) is `prefixItems` in the subset.
        if (Array.isArray(value)) out.prefixItems = value.map(child);
        else if (isRecord(value)) out.items = child(value);
        break;
      case "prefixItems":
        if (Array.isArray(value)) out.prefixItems = value.map(child);
        break;
      case "anyOf":
      case "oneOf": {
        // `oneOf`'s exactly-one is unenforceable by a model anyway; `anyOf` is
        // the documented keyword and says the same thing to it.
        if (Array.isArray(value)) {
          const branches = value.map(child).filter((b) => Object.keys(b).length > 0);
          if (branches.length > 0) out.anyOf = [...((out.anyOf as unknown[]) ?? []), ...branches];
        }
        break;
      }
      default:
        // `$schema`, `$id`, `$comment`, `$defs`, `allOf` (merged below) and
        // every keyword outside the documented subset.
        break;
    }
  }

  if (Array.isArray(node.allOf)) mergeAllOf(out, node.allOf.map(child));

  if (out.type === undefined && isRecord(out.properties)) out.type = "object";
  if (isRecord(out.properties) && Array.isArray(out.required)) {
    const names = out.properties;
    out.required = (out.required as string[]).filter((k) => k in names);
    if ((out.required as string[]).length === 0) delete out.required;
  } else if (!isRecord(out.properties)) {
    delete out.required;
  }
  // Nothing left of an enum/format pairing that only Gemini's OpenAPI dialect uses.
  if (out.format === "enum" && !Array.isArray(out.enum)) delete out.format;
  for (const key of Object.keys(out)) if (!GEMINI_JSON_SCHEMA_KEYS.has(key)) delete out[key];
  return out;
}

/** Folds `allOf` members into their parent: properties and required unioned, other keys first-wins. */
function mergeAllOf(into: Record<string, unknown>, members: Record<string, unknown>[]): void {
  for (const member of members) {
    for (const [key, value] of Object.entries(member)) {
      if (key === "properties" && isRecord(value)) {
        into.properties = { ...value, ...(isRecord(into.properties) ? into.properties : {}) };
      } else if (key === "required" && Array.isArray(value)) {
        into.required = [...new Set([...(Array.isArray(into.required) ? into.required : []), ...value])];
      } else if (into[key] === undefined) {
        into[key] = value;
      }
    }
  }
}

/** `#/$defs/Name`, `#/definitions/Name`, or `#` (the root). Remote refs are not followed. */
function resolveLocalRef(root: Record<string, unknown>, ref: string): unknown {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return undefined;
  let node: unknown = root;
  for (const raw of ref.slice(2).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isRecord(node)) return undefined;
    node = node[key];
  }
  return node;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

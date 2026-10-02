/**
 * Argument parsing and validation, before anything runs (chat-rework SPEC §4.2
 * steps 1–3; the rules match native `SchemaValidator`).
 *
 * Every adapter used to turn arguments it could not parse into `{}` and run the
 * tool anyway (`safeToolInput`, and the two `JSON.parse` fallbacks in the
 * OpenAI adapters). A malformed call therefore EXECUTED with empty input, and
 * the model was told whatever the tool made of that, instead of being told its
 * call was malformed. Here a call that does not parse, or does not fit its
 * schema, becomes an error result that names the problem and says nothing was
 * run; the model sends it again.
 *
 * Alevr's own tools are validated strictly: required keys, primitive types,
 * enum membership, nested arrays and objects, and unknown keys refused (a key
 * the schema does not declare is a key the tool would silently ignore).
 * Connector and native tools get a shallow check of `required` and top-level
 * primitive types only: their schemas are theirs, and the connector validates
 * the rest.
 *
 * Pure: the texts are in `dispatch.prompt.ts`.
 */

import {
  NOT_AN_OBJECT_TEXT,
  invalidJsonText,
  missingFieldText,
  notInEnumText,
  unknownKeyText,
  wrongTypeText,
} from "@/lib/tools/dispatch.prompt";
import type { PortableProperty, PortableSchema } from "@/lib/tools/types";

export type ParsedArguments = { ok: true; args: Record<string, unknown> } | { ok: false; text: string };

/** Raw argument text → an object, or the text telling the model why not. Empty text is `{}`. */
export function parseToolArguments(argsText: string): ParsedArguments {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsText.trim() ? argsText : "{}");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, text: invalidJsonText(reason) };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, text: NOT_AN_OBJECT_TEXT };
  return { ok: true, args: parsed as Record<string, unknown> };
}

function isNumeric(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  // Several providers send numbers as strings; the tools coerce them.
  return typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value));
}

function propertyProblem(field: string, value: unknown, property: PortableProperty): string | null {
  switch (property.type) {
    case "string":
      if (typeof value !== "string") return wrongTypeText(field, "string");
      if (property.enum && !property.enum.includes(value)) return notInEnumText(field, property.enum);
      return null;
    case "number":
      return isNumeric(value) ? null : wrongTypeText(field, "number");
    case "integer":
      return isNumeric(value) && Number.isInteger(Number(value)) ? null : wrongTypeText(field, "integer");
    case "boolean":
      return typeof value === "boolean" || value === "true" || value === "false" ? null : wrongTypeText(field, "boolean");
    case "array": {
      if (!Array.isArray(value)) return wrongTypeText(field, "array");
      for (const item of value) {
        const nested = propertyProblem(`${field}[]`, item, property.items);
        if (nested) return nested;
      }
      return null;
    }
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) return wrongTypeText(field, "object");
      return objectProblem(value as Record<string, unknown>, property, `${field}.`);
    }
  }
}

function objectProblem(
  args: Record<string, unknown>,
  schema: { properties: Record<string, PortableProperty>; required?: string[] },
  prefix: string,
): string | null {
  // An undeclared key first: `{"query": …}` for a tool that takes `q` is a
  // misnamed field, and naming the real parameters is the useful correction.
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(schema.properties, key)) return unknownKeyText(`${prefix}${key}`, Object.keys(schema.properties));
  }
  for (const field of schema.required ?? []) {
    if (args[field] === undefined || args[field] === null) return missingFieldText(`${prefix}${field}`);
  }
  for (const [field, property] of Object.entries(schema.properties)) {
    const value = args[field];
    // A model often sends null for an optional field it means to leave out.
    if (value === undefined || value === null) continue;
    const problem = propertyProblem(`${prefix}${field}`, value, property);
    if (problem) return problem;
  }
  return null;
}

/** Alevr tools: the full portable check, unknown keys refused. Null when the arguments fit. */
export function portableArgumentsProblem(args: Record<string, unknown>, schema: PortableSchema): string | null {
  return objectProblem(args, schema, "");
}

function coerceValue(value: unknown, property: PortableProperty): unknown {
  switch (property.type) {
    case "number":
    case "integer":
      return typeof value === "string" ? Number(value) : value;
    case "boolean":
      return value === "true" ? true : value === "false" ? false : value;
    case "array":
      return Array.isArray(value) ? value.map((item) => coerceValue(item, property.items)) : value;
    case "object":
      return value && typeof value === "object" && !Array.isArray(value)
        ? coerceObject(value as Record<string, unknown>, property)
        : value;
    default:
      return value;
  }
}

function coerceObject(
  args: Record<string, unknown>,
  schema: { properties: Record<string, PortableProperty> },
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(args)) {
    // A null optional field is a field left out (the check above skips it);
    // the portable subset has no nullable type, so the tool never sees null.
    if (value === undefined || value === null) continue;
    const property = Object.hasOwn(schema.properties, field) ? schema.properties[field] : undefined;
    if (!property) continue;
    out[field] = coerceValue(value, property);
  }
  return out;
}

/**
 * The arguments an Alevr tool RUNS with, once `portableArgumentsProblem` has
 * passed them: every value in its declared type.
 *
 * The check is lenient on purpose — several providers send `"5"` for 5 and
 * `"false"` for false — but passing the raw string on is a type confusion the
 * tool cannot see: `if (args.network)` is TRUE for the string "false". So a
 * value the check admitted as a number or a boolean is handed over AS one,
 * and an optional field sent as null is left out. Call only on arguments the
 * check accepted.
 */
export function coercePortableArguments(args: Record<string, unknown>, schema: PortableSchema): Record<string, unknown> {
  return coerceObject(args, schema);
}

const PRIMITIVE_CHECKS: Readonly<Record<string, (value: unknown) => boolean>> = {
  string: (value) => typeof value === "string",
  number: isNumeric,
  integer: (value) => isNumeric(value) && Number.isInteger(Number(value)),
  boolean: (value) => typeof value === "boolean",
  array: (value) => Array.isArray(value),
  object: (value) => !!value && typeof value === "object" && !Array.isArray(value),
};

/** Connector and native tools: `required` and top-level primitive types only. */
export function shallowArgumentsProblem(
  args: Record<string, unknown>,
  schema: Record<string, unknown> | undefined,
): string | null {
  if (!schema) return null;
  const required = Array.isArray(schema.required) ? schema.required.filter((v): v is string => typeof v === "string") : [];
  for (const field of required) {
    if (args[field] === undefined) return missingFieldText(field);
  }
  const properties =
    schema.properties && typeof schema.properties === "object" ? (schema.properties as Record<string, unknown>) : {};
  for (const [field, value] of Object.entries(args)) {
    const declared = properties[field] as { type?: unknown } | undefined;
    if (value === undefined || value === null || !declared || typeof declared.type !== "string") continue;
    const check = PRIMITIVE_CHECKS[declared.type];
    if (check && !check(value)) return wrongTypeText(field, declared.type);
  }
  return null;
}

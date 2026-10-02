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
  for (const field of schema.required ?? []) {
    if (args[field] === undefined || args[field] === null) return missingFieldText(`${prefix}${field}`);
  }
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(schema.properties, key)) return unknownKeyText(`${prefix}${key}`, Object.keys(schema.properties));
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

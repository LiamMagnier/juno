/**
 * Wire-contract validator: every frame a device received must conform to the
 * published chat-wire contract (contracts/chat/juno-chat-wire-v1.schema.json),
 * which is what the native apps decode against.
 *
 * A small JSON Schema evaluator lives here rather than a library because the
 * contract is draft 2020-12 and the repository only carries ajv 6; the subset
 * covers every keyword the contract uses (checked by the test suite) and an
 * unknown structural keyword fails loudly instead of being ignored.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type { CheckResult, ValidatorSpec } from "../types";
import { fail, pass, readOutput } from "./util";
import { parseSse } from "./trace";

type WireSpec = Extract<ValidatorSpec, { kind: "wire_contract" }>;
type Schema = Record<string, unknown> | boolean;

/** Keywords that only annotate; ignored by design. */
const ANNOTATIONS = new Set(["$schema", "$id", "title", "description", "format", "default", "examples", "$comment", "deprecated"]);
export const SUPPORTED_KEYWORDS = new Set([
  "type", "const", "enum", "properties", "required", "items", "$ref", "anyOf", "oneOf", "allOf",
  "additionalProperties", "minLength", "maxLength", "pattern", "minItems", "maxItems",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "$defs",
]);

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function resolveRef(root: Record<string, unknown>, ref: string): Schema {
  if (!ref.startsWith("#/")) throw new Error(`unsupported $ref ${ref}`);
  let node: unknown = root;
  for (const part of ref.slice(2).split("/")) node = (node as Record<string, unknown>)?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  if (node === undefined) throw new Error(`unresolved $ref ${ref}`);
  return node as Schema;
}

/** Returns problems (empty = valid). */
export function schemaErrors(value: unknown, schema: Schema, root: Record<string, unknown>, at = "$", depth = 0): string[] {
  if (depth > 64) return [`${at}: schema nesting too deep`];
  if (schema === true) return [];
  if (schema === false) return [`${at}: not allowed`];
  const s = schema;
  const errors: string[] = [];
  for (const key of Object.keys(s)) {
    if (!SUPPORTED_KEYWORDS.has(key) && !ANNOTATIONS.has(key) && !key.startsWith("x-")) errors.push(`${at}: unsupported schema keyword "${key}"`);
  }
  if (errors.length) return errors;
  if (typeof s.$ref === "string") errors.push(...schemaErrors(value, resolveRef(root, s.$ref), root, at, depth + 1));
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
    const actual = typeOf(value);
    if (!types.includes(actual) && !(actual === "integer" && types.includes("number"))) return [...errors, `${at}: expected ${types.join("|")}, got ${actual}`];
  }
  if ("const" in s && JSON.stringify(value) !== JSON.stringify(s.const)) errors.push(`${at}: expected ${JSON.stringify(s.const)}`);
  if (Array.isArray(s.enum) && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) errors.push(`${at}: ${JSON.stringify(value)} not in enum`);
  if (typeof value === "string") {
    if (typeof s.minLength === "number" && [...value].length < s.minLength) errors.push(`${at}: shorter than ${s.minLength}`);
    if (typeof s.maxLength === "number" && [...value].length > s.maxLength) errors.push(`${at}: longer than ${s.maxLength}`);
    if (typeof s.pattern === "string" && !new RegExp(s.pattern, "u").test(value)) errors.push(`${at}: does not match ${s.pattern}`);
  }
  if (typeof value === "number") {
    if (typeof s.minimum === "number" && value < s.minimum) errors.push(`${at}: < ${s.minimum}`);
    if (typeof s.maximum === "number" && value > s.maximum) errors.push(`${at}: > ${s.maximum}`);
    if (typeof s.exclusiveMinimum === "number" && value <= s.exclusiveMinimum) errors.push(`${at}: ≤ ${s.exclusiveMinimum}`);
    if (typeof s.exclusiveMaximum === "number" && value >= s.exclusiveMaximum) errors.push(`${at}: ≥ ${s.exclusiveMaximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof s.minItems === "number" && value.length < s.minItems) errors.push(`${at}: fewer than ${s.minItems} items`);
    if (typeof s.maxItems === "number" && value.length > s.maxItems) errors.push(`${at}: more than ${s.maxItems} items`);
    if (s.items !== undefined) value.forEach((item, i) => errors.push(...schemaErrors(item, s.items as Schema, root, `${at}[${i}]`, depth + 1)));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const props = (s.properties ?? {}) as Record<string, Schema>;
    for (const req of (s.required as string[] | undefined) ?? []) if (!(req in obj)) errors.push(`${at}: missing required "${req}"`);
    for (const [key, child] of Object.entries(obj)) {
      if (key in props) errors.push(...schemaErrors(child, props[key], root, `${at}.${key}`, depth + 1));
      else if (s.additionalProperties === false) errors.push(`${at}: unexpected property "${key}"`);
      else if (s.additionalProperties && typeof s.additionalProperties === "object") errors.push(...schemaErrors(child, s.additionalProperties as Schema, root, `${at}.${key}`, depth + 1));
    }
  }
  if (Array.isArray(s.allOf)) for (const sub of s.allOf as Schema[]) errors.push(...schemaErrors(value, sub, root, at, depth + 1));
  if (Array.isArray(s.anyOf) && !(s.anyOf as Schema[]).some((sub) => schemaErrors(value, sub, root, at, depth + 1).length === 0)) errors.push(`${at}: matches none of anyOf`);
  if (Array.isArray(s.oneOf)) {
    const matching = (s.oneOf as Schema[]).filter((sub) => schemaErrors(value, sub, root, at, depth + 1).length === 0).length;
    if (matching !== 1) errors.push(`${at}: matches ${matching} of oneOf (expected exactly 1)`);
  }
  return errors;
}

export function validateWireContract(spec: WireSpec, outputsDir: string, repoRoot: string): CheckResult[] {
  const id = (what: string) => `wire:${spec.file}:${what}`;
  let raw: string;
  let root: Record<string, unknown>;
  try {
    raw = readOutput(outputsDir, spec.file).toString("utf8");
  } catch (error) {
    return [fail(id("exists"), (error as Error).message)];
  }
  try {
    root = JSON.parse(readFileSync(path.join(repoRoot, spec.schema), "utf8")) as Record<string, unknown>;
  } catch (error) {
    return [fail(id("schema"), `contract unreadable: ${(error as Error).message}`)];
  }
  const def = (root.$defs as Record<string, Schema> | undefined)?.[spec.def];
  if (!def) return [fail(id("schema"), `contract has no $defs.${spec.def}`)];
  const frames = parseSse(raw);
  const problems: string[] = [];
  frames.forEach((frame, i) => {
    if (!frame.data) problems.push(`frame ${i}: data is not JSON`);
    else for (const e of schemaErrors(frame.data, def, root)) problems.push(`frame ${i} (${String(frame.data.type)}): ${e}`);
  });
  return [
    frames.length ? pass(id("frames"), `${frames.length} frame(s)`) : fail(id("frames"), "no frames"),
    problems.length ? fail(id("conforms"), problems.slice(0, 6).join("; ")) : pass(id("conforms"), `every frame conforms to ${spec.def}`),
  ];
}

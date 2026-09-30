/**
 * Emits every language's half of the canonical agent session protocol.
 *
 * One hand-authored file, `contracts/agent/juno-agent-protocol-v1.json`, and
 * three generated ones that follow from it:
 *
 *   runner/agent-core/src/protocol.generated.ts    the cloud engine (agent-core
 *                                                  builds standalone, so it
 *                                                  carries its own copy)
 *   src/lib/agent-protocol/protocol.generated.ts   the web and the server
 *   native/Packages/JunoNativeKit/Sources/JunoAgentProtocol/Generated/
 *     JunoAgentProtocol.swift                      the Mac and iPhone, in a
 *                                                  dependency-free target
 *
 * Why generated, and why three: before this, one "coding session" was spoken in
 * six vocabularies bridged by hand-written adapters, alias tables and regexes
 * on display strings, and every field that crossed from one to another was a
 * place a setting could be dropped without anyone noticing — the model a web
 * user picked for a Mac run was one of them. A generated type cannot drift
 * from its source, and `--check` fails CI the moment one does.
 *
 * Two properties the generated code guarantees in every language, because they
 * are what let an old client survive a new producer:
 *
 *   - an event type it does not know decodes as `unknown`, carrying the raw
 *     object, instead of failing the stream it arrived in;
 *   - an enum value it does not know reads as that enum's `unknown` value.
 *
 * Keys on the wire are the contract's field names in every language — never a
 * Swift case name, which is what made the Mac's existing session protocol
 * (`CodeSessionEventEnvelope`, synthesized Codable) unreadable anywhere else.
 *
 * The status file (`juno-agent-protocol-v1.status.json`) says which producer
 * and which reader implements each event and command; the check fails when it
 * names one the contract does not have, or misses one it does.
 *
 *   node scripts/generate-agent-protocol.mjs           write all three
 *   node scripts/generate-agent-protocol.mjs --check   exit 1 on drift
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACT = "contracts/agent/juno-agent-protocol-v1.json";
const STATUS = "contracts/agent/juno-agent-protocol-v1.status.json";
const OUTPUTS = {
  agentCore: "runner/agent-core/src/protocol.generated.ts",
  web: "src/lib/agent-protocol/protocol.generated.ts",
  swift: "native/Packages/JunoNativeKit/Sources/JunoAgentProtocol/Generated/JunoAgentProtocol.swift",
};

const check = process.argv.includes("--check");
const source = readFileSync(join(root, CONTRACT), "utf8");
const contract = JSON.parse(source);
const digest = createHash("sha256").update(source).digest("hex");

// ── Validation ──────────────────────────────────────────────────────────────
// Every rule here is one a reader of the JSON would not catch and a compiler
// would report somewhere confusing, or not at all.

const problems = [];
const fail = (message) => problems.push(message);

const ENUM_VALUE = /^[a-z][a-z0-9_]*$/;
const FIELD_KEY = /^[a-z][A-Za-z0-9]*$/;
const TYPE_NAME = /^[A-Z][A-Za-z0-9]*$/;
// Dotted, so a canonical type can never be mistaken for one of the legacy
// underscore kinds (`tool`, `file_change`, `approval_request`, …) it replaces.
const EVENT_NAME = /^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/;
const SCALARS = new Set(["string", "integer", "number", "boolean", "timestamp", "json"]);

const { major, minor } = contract.version ?? {};
if (!Number.isInteger(major) || !Number.isInteger(minor)) fail("version must be { major, minor } integers");
const V = `${major}.${minor}`;

for (const [name, spec] of Object.entries(contract.enums ?? {})) {
  if (!TYPE_NAME.test(name)) fail(`enum ${name}: not a type name`);
  if (!spec.summary) fail(`enum ${name}: no summary`);
  const seen = new Set();
  for (const entry of spec.values ?? []) {
    if (!ENUM_VALUE.test(entry.value ?? "")) fail(`enum ${name}: "${entry.value}" is not a lower_snake value`);
    if (!entry.summary) fail(`enum ${name}.${entry.value}: no summary; every value must say what it means`);
    if (seen.has(entry.value)) fail(`enum ${name}: "${entry.value}" listed twice`);
    seen.add(entry.value);
  }
  // The rule that makes a newer producer safe for an older reader.
  if (!seen.has("unknown")) fail(`enum ${name}: must list "unknown", the value an older reader maps a newer one to`);
}

/** Parses a field type into { kind, ref?, item? }. */
function parseType(text, where) {
  if (typeof text !== "string") {
    fail(`${where}: missing type`);
    return { kind: "string" };
  }
  if (SCALARS.has(text)) return { kind: text };
  if (text.startsWith("enum:")) {
    const ref = text.slice(5);
    if (!contract.enums?.[ref]) fail(`${where}: enum ${ref} does not exist`);
    return { kind: "enum", ref };
  }
  if (text.startsWith("type:")) {
    const ref = text.slice(5);
    if (!contract.types?.[ref]) fail(`${where}: type ${ref} does not exist`);
    return { kind: "type", ref };
  }
  if (text.startsWith("array:")) {
    const item = parseType(text.slice(6), where);
    if (item.kind === "array") fail(`${where}: arrays of arrays are not in the dialect`);
    return { kind: "array", item };
  }
  fail(`${where}: "${text}" is not a type in the dialect`);
  return { kind: "string" };
}

/** A record's fields, validated and parsed. */
function fieldsOf(record, where, reserved = new Set()) {
  if (!record || typeof record.fields !== "object") {
    fail(`${where}: no fields`);
    return [];
  }
  return Object.entries(record.fields).map(([key, field]) => {
    if (!FIELD_KEY.test(key)) fail(`${where}.${key}: not a lowerCamel key`);
    if (reserved.has(key)) fail(`${where}.${key}: collides with an envelope key`);
    if (!field.summary) fail(`${where}.${key}: no summary`);
    return { key, optional: field.optional === true, summary: field.summary ?? "", ...parseType(field.type, `${where}.${key}`) };
  });
}

const types = Object.entries(contract.types ?? {}).map(([name, spec]) => {
  if (!TYPE_NAME.test(name)) fail(`type ${name}: not a type name`);
  if (!spec.summary) fail(`type ${name}: no summary`);
  return { name, summary: spec.summary ?? "", fields: fieldsOf(spec, `type ${name}`) };
});

const envelope = fieldsOf(contract.envelope, "envelope");
const envelopeKeys = new Set([...envelope.map((field) => field.key), "type"]);
const events = Object.entries(contract.events ?? {}).map(([type, spec]) => {
  if (!EVENT_NAME.test(type)) fail(`event ${type}: must be a dotted lower_snake name`);
  if (!spec.summary) fail(`event ${type}: no summary`);
  return { type, summary: spec.summary ?? "", group: spec.group ?? "", fields: fieldsOf(spec, `event ${type}`, envelopeKeys) };
});

const commandEnvelope = fieldsOf(contract.commandEnvelope, "commandEnvelope");
const commandEnvelopeKeys = new Set([...commandEnvelope.map((field) => field.key), "type"]);
const commands = Object.entries(contract.commands ?? {}).map(([type, spec]) => {
  if (!EVENT_NAME.test(type)) fail(`command ${type}: must be a dotted lower_snake name`);
  if (!spec.summary) fail(`command ${type}: no summary`);
  return { type, summary: spec.summary ?? "", fields: fieldsOf(spec, `command ${type}`, commandEnvelopeKeys) };
});
const receipt = { name: "CommandReceipt", summary: contract.receipt?.summary ?? "", fields: fieldsOf(contract.receipt, "receipt") };

const enums = Object.entries(contract.enums ?? {}).map(([name, spec]) => ({
  name,
  summary: spec.summary ?? "",
  values: (spec.values ?? []).map((entry) => ({ value: entry.value, summary: entry.summary ?? "" })),
}));

// The status file: every event and command classified for every producer and
// reader it names, and nothing classified that the contract does not have.
const STATUS_VALUES = new Set(["implemented", "planned", "n/a"]);
let statusFile = null;
try {
  statusFile = JSON.parse(readFileSync(join(root, STATUS), "utf8"));
} catch (err) {
  fail(`${STATUS}: ${err.message}`);
}
if (statusFile) {
  const sections = [
    ["producers", events.map((event) => event.type), "events"],
    ["consumers", events.map((event) => event.type), "events"],
    ["commandHandlers", commands.map((command) => command.type), "commands"],
  ];
  for (const [section, names, list] of sections) {
    const parties = statusFile[section];
    if (!parties || typeof parties !== "object" || Object.keys(parties).length === 0) {
      fail(`${STATUS}: "${section}" names nobody`);
      continue;
    }
    for (const [party, spec] of Object.entries(parties)) {
      if (!spec.summary) fail(`${STATUS}: ${section}.${party} has no summary`);
      const entries = spec[list] ?? {};
      for (const name of names) {
        const raw = entries[name];
        const status = typeof raw === "string" ? raw : raw?.status;
        if (!status) fail(`${STATUS}: ${section}.${party} does not classify ${name}`);
        else if (!STATUS_VALUES.has(status)) fail(`${STATUS}: ${section}.${party}.${name} is "${status}"`);
      }
      for (const name of Object.keys(entries)) {
        if (!names.includes(name)) fail(`${STATUS}: ${section}.${party} classifies ${name}, which the contract does not have`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`[agent-protocol] ${CONTRACT} is not valid:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}

// ── Naming ──────────────────────────────────────────────────────────────────

const pascal = (text) =>
  text
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
const camel = (text) => {
  const p = pascal(text);
  return p[0].toLowerCase() + p.slice(1);
};
const upperSnake = (text) => text.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
/** Generated type names carry `Agent`, so they never collide with an engine's own `PermissionMode`. */
const agentName = (name) => (name.startsWith("Agent") ? name : `Agent${name}`);

// ── TypeScript ──────────────────────────────────────────────────────────────

const tsType = (field) => {
  switch (field.kind) {
    case "string":
    case "timestamp":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "json":
      return "unknown";
    case "enum":
    case "type":
      return agentName(field.ref);
    case "array": {
      const inner = tsType(field.item);
      return `${inner}[]`;
    }
  }
  throw new Error(`unhandled kind ${field.kind}`);
};

const tsDoc = (text, indent = "") => `${indent}/** ${text.replace(/\*\//g, "*\\/")} */`;
const tsFields = (fields, indent = "  ") =>
  fields.map((field) => `${tsDoc(field.summary, indent)}\n${indent}${field.key}${field.optional ? "?" : ""}: ${tsType(field)};`).join("\n");

/** A field spec as the runtime reader consumes it. */
const tsSpec = (field) => {
  const parts = [`key: ${JSON.stringify(field.key)}`, `kind: ${JSON.stringify(field.kind)}`, `optional: ${field.optional}`];
  if (field.ref) parts.push(`ref: ${JSON.stringify(field.ref)}`);
  if (field.item) parts.push(`item: ${tsSpec({ ...field.item, key: "", optional: false })}`);
  return `{ ${parts.join(", ")} }`;
};
const tsSpecList = (fields) => `[\n${fields.map((field) => `    ${tsSpec(field)},`).join("\n")}\n  ]`;

const eventInterface = (event) => `${agentName(pascal(event.type))}Event`;
const commandInterface = (command) => `${agentName(pascal(command.type))}Command`;

const tsRuntime = String.raw`
// ── Runtime reader ──────────────────────────────────────────────────────────
// One tolerant reader for every surface, and a strict validator for producers
// and tests. The rules, which the Swift decoder follows exactly:
//   - not an object, a bad envelope, or a major version this build does not
//     know → not an event (null);
//   - a type this build does not know → an "unknown" event carrying the raw
//     object;
//   - a known type whose required field is missing or malformed → the same
//     "unknown" event (a buggy producer must not take a reader down);
//   - an optional field that is malformed → dropped;
//   - an enum value this build does not know → "unknown";
//   - an array element that is malformed → skipped;
//   - a key the contract does not name → dropped (a newer minor may add one).

type FieldKind = "string" | "integer" | "number" | "boolean" | "timestamp" | "json" | "enum" | "type" | "array";
interface FieldSpec {
  readonly key: string;
  readonly kind: FieldKind;
  readonly optional: boolean;
  readonly ref?: string;
  readonly item?: FieldSpec;
}
type Read = { ok: true; value: unknown } | { ok: false };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The major version a "<major>.<minor>" string names, or null. */
export function agentProtocolMajor(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const match = /^(\d+)\.(\d+)$/.exec(v);
  return match ? Number(match[1]) : null;
}

function readField(spec: FieldSpec, value: unknown, path: string, problems: string[] | null): Read {
  switch (spec.kind) {
    case "string":
    case "timestamp":
      if (typeof value === "string") return { ok: true, value };
      break;
    case "integer":
      if (typeof value === "number" && Number.isSafeInteger(value)) return { ok: true, value };
      break;
    case "number":
      if (typeof value === "number" && Number.isFinite(value)) return { ok: true, value };
      break;
    case "boolean":
      if (typeof value === "boolean") return { ok: true, value };
      break;
    case "json":
      if (value !== undefined) return { ok: true, value };
      break;
    case "enum": {
      if (typeof value !== "string") break;
      const values = ENUM_VALUES[spec.ref as string] ?? [];
      if (values.includes(value)) return { ok: true, value };
      problems?.push(path + ': "' + value + '" is not a ' + spec.ref);
      return { ok: true, value: "unknown" };
    }
    case "type": {
      if (!isRecord(value)) break;
      const record = readRecord(TYPE_FIELDS[spec.ref as string] ?? [], value, path, problems, new Set());
      return record ? { ok: true, value: record } : { ok: false };
    }
    case "array": {
      if (!Array.isArray(value)) break;
      const out: unknown[] = [];
      value.forEach((element, index) => {
        const read = readField(spec.item as FieldSpec, element, path + "[" + index + "]", problems);
        if (read.ok) out.push(read.value);
      });
      return { ok: true, value: out };
    }
  }
  problems?.push(path + ": expected " + (spec.ref ?? spec.kind));
  return { ok: false };
}

/**
 * The contract's fields of one object, or null when a required one is missing
 * or malformed. A null counts as absent. "extra" lists keys that may appear
 * without being fields (an envelope's); with "problems", any other key is one.
 */
function readRecord(
  fields: readonly FieldSpec[],
  raw: Record<string, unknown>,
  path: string,
  problems: string[] | null,
  extra: ReadonlySet<string> | null,
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  let complete = true;
  for (const spec of fields) {
    const value = raw[spec.key];
    if (value === undefined || value === null) {
      if (!spec.optional) {
        problems?.push(path + "." + spec.key + ": missing");
        complete = false;
      }
      continue;
    }
    const read = readField(spec, value, path + "." + spec.key, problems);
    if (read.ok) out[spec.key] = read.value;
    else if (!spec.optional) complete = false;
  }
  if (problems && extra) {
    for (const key of Object.keys(raw)) {
      if (!extra.has(key) && !fields.some((spec) => spec.key === key)) {
        problems.push(path + "." + key + ": not in the contract");
      }
    }
  }
  return complete ? out : null;
}

function readEnvelope(
  raw: unknown,
  fields: readonly FieldSpec[],
  problems: string[] | null,
): { envelope: Record<string, unknown>; type: string; raw: Record<string, unknown> } | null {
  if (!isRecord(raw)) {
    problems?.push("not an object");
    return null;
  }
  const envelope = readRecord(fields, raw, "envelope", problems, null);
  if (!envelope) return null;
  if (typeof raw.type !== "string") {
    problems?.push("envelope.type: missing");
    return null;
  }
  if (agentProtocolMajor(envelope.v) !== AGENT_PROTOCOL.major) {
    problems?.push("envelope.v: " + String(envelope.v) + " is not major " + AGENT_PROTOCOL.major);
    return null;
  }
  return { envelope, type: raw.type, raw };
}

/** Reads one event the way every Juno reader does. Null when it is not one. */
export function parseAgentEvent(raw: unknown): ParsedAgentEvent | null {
  return readEvent(raw, null);
}

/** Every way "raw" departs from the contract. Empty means a producer may send it. */
export function validateAgentEvent(raw: unknown): string[] {
  const problems: string[] = [];
  const event = readEvent(raw, problems);
  if (event && event.type === "unknown" && problems.length === 0) problems.push("type: not in the contract");
  return problems;
}

function readEvent(raw: unknown, problems: string[] | null): ParsedAgentEvent | null {
  const read = readEnvelope(raw, ENVELOPE_FIELDS, problems);
  if (!read) return null;
  const fields = EVENT_FIELDS[read.type];
  const body = fields ? readRecord(fields, read.raw, read.type, problems, ENVELOPE_KEYS) : null;
  if (!body) {
    if (!fields) problems?.push("type: " + read.type + " is not in the contract");
    return { ...(read.envelope as unknown as AgentEventEnvelope), type: "unknown", rawType: read.type, raw: { ...read.raw } };
  }
  return { ...read.envelope, type: read.type, ...body } as unknown as AgentEvent;
}

/** The JSON object for an event: its known keys, or the raw object it arrived as. */
export function serializeAgentEvent(event: ParsedAgentEvent): Record<string, unknown> {
  if (event.type === "unknown") return { ...(event as UnknownAgentEvent).raw };
  return { ...event } as Record<string, unknown>;
}

/** Whether a parsed event is one this build knows. */
export function isKnownAgentEvent(event: ParsedAgentEvent): event is AgentEvent {
  return event.type !== "unknown";
}

/** Reads one command. Null when it is not one. */
export function parseAgentCommand(raw: unknown): ParsedAgentCommand | null {
  return readCommand(raw, null);
}

/** Every way "raw" departs from the contract's commands. */
export function validateAgentCommand(raw: unknown): string[] {
  const problems: string[] = [];
  const command = readCommand(raw, problems);
  if (command && command.type === "unknown" && problems.length === 0) problems.push("type: not in the contract");
  return problems;
}

function readCommand(raw: unknown, problems: string[] | null): ParsedAgentCommand | null {
  const read = readEnvelope(raw, COMMAND_ENVELOPE_FIELDS, problems);
  if (!read) return null;
  const fields = COMMAND_FIELDS[read.type];
  const body = fields ? readRecord(fields, read.raw, read.type, problems, COMMAND_ENVELOPE_KEYS) : null;
  if (!body) {
    if (!fields) problems?.push("type: " + read.type + " is not in the contract");
    return { ...(read.envelope as unknown as AgentCommandEnvelope), type: "unknown", rawType: read.type, raw: { ...read.raw } };
  }
  return { ...read.envelope, type: read.type, ...body } as unknown as AgentCommand;
}

/** Reads a host's receipt for a command. Null when it is not one. */
export function parseAgentCommandReceipt(raw: unknown): AgentCommandReceipt | null {
  if (!isRecord(raw)) return null;
  return readRecord(RECEIPT_FIELDS, raw, "receipt", null, null) as AgentCommandReceipt | null;
}
`;

function renderTypeScript() {
  const lines = [];
  lines.push(
    "// Generated by scripts/generate-agent-protocol.mjs. Do not edit.",
    "//",
    `// Source of truth: ${CONTRACT}`,
    "// The same text is written to runner/agent-core/src/protocol.generated.ts and",
    "// src/lib/agent-protocol/protocol.generated.ts (agent-core builds standalone),",
    "// and the Swift half to the JunoAgentProtocol target. `npm run",
    "// agent:protocol:check` fails when any of them drifts from the contract.",
    "/* eslint-disable */",
    "",
    "export const AGENT_PROTOCOL = {",
    `  name: ${JSON.stringify(contract.protocol)},`,
    `  major: ${major},`,
    `  minor: ${minor},`,
    "  /** What a producer writes as `v`. */",
    `  v: ${JSON.stringify(V)},`,
    "  /** SHA-256 of the contract this was generated from. */",
    `  digest: ${JSON.stringify(digest)},`,
    "} as const;",
    "",
    "// ── Enums ───────────────────────────────────────────────────────────────────",
    "",
  );
  for (const e of enums) {
    const constant = `${upperSnake(agentName(e.name))}_VALUES`;
    lines.push(tsDoc(e.summary), `export const ${constant} = [`);
    for (const value of e.values) lines.push(`  ${JSON.stringify(value.value)}, // ${value.summary}`);
    lines.push("] as const;", `export type ${agentName(e.name)} = (typeof ${constant})[number];`, "");
  }
  lines.push("// ── Types ───────────────────────────────────────────────────────────────────", "");
  for (const type of types) {
    lines.push(tsDoc(type.summary), `export interface ${agentName(type.name)} {`, tsFields(type.fields), "}", "");
  }
  lines.push(tsDoc(receipt.summary), "export interface AgentCommandReceipt {", tsFields(receipt.fields), "}", "");

  lines.push("// ── Events ──────────────────────────────────────────────────────────────────", "");
  lines.push(tsDoc(contract.envelope.summary), "export interface AgentEventEnvelope {", tsFields(envelope), "}", "");
  for (const event of events) {
    lines.push(
      tsDoc(event.summary),
      `export interface ${eventInterface(event)} extends AgentEventEnvelope {`,
      `  type: ${JSON.stringify(event.type)};`,
      tsFields(event.fields),
      "}",
      "",
    );
  }
  lines.push(
    "/** Every event this build knows. */",
    `export type AgentEvent =\n${events.map((event) => `  | ${eventInterface(event)}`).join("\n")};`,
    "export type AgentEventType = AgentEvent[\"type\"];",
    "export type AgentEventOf<T extends AgentEventType> = Extract<AgentEvent, { type: T }>;",
    "/** What a producer supplies for one event: its type and fields, without the envelope. */",
    "export type AgentEventBody<T extends AgentEventType = AgentEventType> = T extends AgentEventType",
    "  ? Omit<AgentEventOf<T>, keyof AgentEventEnvelope>",
    "  : never;",
    `export const AGENT_EVENT_TYPES = [\n${events.map((event) => `  ${JSON.stringify(event.type)},`).join("\n")}\n] as const;`,
    "",
    "/** An event of a type this build does not know, kept whole. */",
    "export interface UnknownAgentEvent extends AgentEventEnvelope {",
    '  type: "unknown";',
    "  /** The type it arrived with. */",
    "  rawType: string;",
    "  /** The object it arrived as. */",
    "  raw: Record<string, unknown>;",
    "}",
    "export type ParsedAgentEvent = AgentEvent | UnknownAgentEvent;",
    "",
  );

  lines.push("// ── Commands ────────────────────────────────────────────────────────────────", "");
  lines.push(tsDoc(contract.commandEnvelope.summary), "export interface AgentCommandEnvelope {", tsFields(commandEnvelope), "}", "");
  for (const command of commands) {
    lines.push(
      tsDoc(command.summary),
      `export interface ${commandInterface(command)} extends AgentCommandEnvelope {`,
      `  type: ${JSON.stringify(command.type)};`,
      tsFields(command.fields),
      "}",
      "",
    );
  }
  lines.push(
    `export type AgentCommand =\n${commands.map((command) => `  | ${commandInterface(command)}`).join("\n")};`,
    "export type AgentCommandType = AgentCommand[\"type\"];",
    `export const AGENT_COMMAND_TYPES = [\n${commands.map((command) => `  ${JSON.stringify(command.type)},`).join("\n")}\n] as const;`,
    "export interface UnknownAgentCommand extends AgentCommandEnvelope {",
    '  type: "unknown";',
    "  rawType: string;",
    "  raw: Record<string, unknown>;",
    "}",
    "export type ParsedAgentCommand = AgentCommand | UnknownAgentCommand;",
    "",
  );

  lines.push("// ── Field tables (what the reader below walks) ──────────────────────────────", "");
  lines.push("const ENUM_VALUES: Record<string, readonly string[]> = {");
  for (const e of enums) lines.push(`  ${e.name}: ${upperSnake(agentName(e.name))}_VALUES,`);
  lines.push("};", "");
  lines.push("const TYPE_FIELDS: Record<string, readonly FieldSpec[]> = {");
  for (const type of types) lines.push(`  ${type.name}: ${tsSpecList(type.fields)},`);
  lines.push("};", "");
  lines.push(`const ENVELOPE_FIELDS: readonly FieldSpec[] = ${tsSpecList(envelope).replace(/\n {4}/g, "\n  ").replace(/\n {2}\]$/, "\n]")};`);
  lines.push(`const ENVELOPE_KEYS: ReadonlySet<string> = new Set(${JSON.stringify([...envelopeKeys])});`, "");
  lines.push("const EVENT_FIELDS: Record<string, readonly FieldSpec[]> = {");
  for (const event of events) lines.push(`  ${JSON.stringify(event.type)}: ${tsSpecList(event.fields)},`);
  lines.push("};", "");
  lines.push(`const COMMAND_ENVELOPE_FIELDS: readonly FieldSpec[] = ${tsSpecList(commandEnvelope).replace(/\n {4}/g, "\n  ").replace(/\n {2}\]$/, "\n]")};`);
  lines.push(`const COMMAND_ENVELOPE_KEYS: ReadonlySet<string> = new Set(${JSON.stringify([...commandEnvelopeKeys])});`, "");
  lines.push("const COMMAND_FIELDS: Record<string, readonly FieldSpec[]> = {");
  for (const command of commands) lines.push(`  ${JSON.stringify(command.type)}: ${tsSpecList(command.fields)},`);
  lines.push("};", "");
  lines.push(`const RECEIPT_FIELDS: readonly FieldSpec[] = ${tsSpecList(receipt.fields).replace(/\n {4}/g, "\n  ").replace(/\n {2}\]$/, "\n]")};`);
  lines.push(tsRuntime);
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

// ── Swift ───────────────────────────────────────────────────────────────────

const SWIFT_KEYWORDS = new Set([
  "Any", "as", "associatedtype", "await", "break", "case", "catch", "class", "continue", "default",
  "defer", "deinit", "do", "else", "enum", "extension", "fallthrough", "false", "fileprivate",
  "for", "func", "guard", "if", "import", "in", "init", "inout", "internal", "is", "let", "nil",
  "open", "operator", "precedencegroup", "private", "protocol", "public", "repeat", "rethrows",
  "return", "self", "Self", "static", "struct", "subscript", "super", "switch", "throw", "throws",
  "true", "try", "typealias", "var", "where", "while",
]);
const swiftIdent = (name) => (SWIFT_KEYWORDS.has(name) ? `\`${name}\`` : name);
const swiftDoc = (text, indent) => `${indent}/// ${text}`;

const swiftType = (field) => {
  switch (field.kind) {
    case "string":
    case "timestamp":
      return "String";
    case "integer":
      return "Int";
    case "number":
      return "Double";
    case "boolean":
      return "Bool";
    case "json":
      return "AgentJSONValue";
    case "enum":
    case "type":
      return agentName(field.ref);
    case "array":
      return `[${swiftType(field.item)}]`;
  }
  throw new Error(`unhandled kind ${field.kind}`);
};

/** The decode expression for one field, tolerant in the ways the TS reader is. */
const swiftDecode = (field) => {
  const key = `.${swiftIdent(field.key)}`;
  if (field.kind === "array") {
    const element = swiftType(field.item);
    return field.optional
      ? `(try? container.decodeIfPresent(AgentLossyArray<${element}>.self, forKey: ${key}))?.elements`
      : `try container.decode(AgentLossyArray<${element}>.self, forKey: ${key}).elements`;
  }
  const type = swiftType(field);
  return field.optional
    ? `try? container.decodeIfPresent(${type}.self, forKey: ${key})`
    : `try container.decode(${type}.self, forKey: ${key})`;
};

/** A Codable struct whose JSON keys are the contract's, with a memberwise init. */
function swiftStruct(name, summary, fields, indent, conformances = "Hashable, Sendable, Codable") {
  const i = indent;
  const lines = [swiftDoc(summary, i), `${i}public struct ${name}: ${conformances} {`];
  for (const field of fields) {
    lines.push(swiftDoc(field.summary, `${i}    `), `${i}    public var ${swiftIdent(field.key)}: ${swiftType(field)}${field.optional ? "?" : ""}`);
  }
  lines.push("");
  const params = fields.map((field) => `${swiftIdent(field.key)}: ${swiftType(field)}${field.optional ? "? = nil" : ""}`);
  if (params.length === 0) {
    lines.push(`${i}    public init() {}`);
  } else {
    lines.push(`${i}    public init(`);
    lines.push(params.map((param) => `${i}        ${param}`).join(",\n"));
    lines.push(`${i}    ) {`);
    for (const field of fields) lines.push(`${i}        self.${field.key} = ${swiftIdent(field.key)}`);
    lines.push(`${i}    }`);
  }
  lines.push("");
  if (fields.length > 0) {
    lines.push(`${i}    private enum CodingKeys: String, CodingKey {`);
    for (const field of fields) lines.push(`${i}        case ${swiftIdent(field.key)} = ${JSON.stringify(field.key)}`);
    lines.push(`${i}    }`, "");
    lines.push(`${i}    public init(from decoder: any Decoder) throws {`);
    lines.push(`${i}        let container = try decoder.container(keyedBy: CodingKeys.self)`);
    for (const field of fields) lines.push(`${i}        self.${field.key} = ${swiftDecode(field)}`);
    lines.push(`${i}    }`, "");
    lines.push(`${i}    public func encode(to encoder: any Encoder) throws {`);
    lines.push(`${i}        var container = encoder.container(keyedBy: CodingKeys.self)`);
    for (const field of fields) {
      const method = field.optional ? "encodeIfPresent" : "encode";
      lines.push(`${i}        try container.${method}(${swiftIdent(field.key)}, forKey: .${swiftIdent(field.key)})`);
    }
    lines.push(`${i}    }`);
  } else {
    lines.push(`${i}    public init(from decoder: any Decoder) throws {}`, "");
    lines.push(`${i}    public func encode(to encoder: any Encoder) throws {}`);
  }
  lines.push(`${i}}`);
  return lines.join("\n");
}

function swiftEnum(e) {
  const name = agentName(e.name);
  const lines = [
    swiftDoc(e.summary, ""),
    `public enum ${name}: String, Hashable, Sendable, Codable, CaseIterable {`,
  ];
  for (const value of e.values) {
    lines.push(swiftDoc(value.summary, "    "), `    case ${swiftIdent(camel(value.value))} = ${JSON.stringify(value.value)}`);
  }
  lines.push(
    "",
    "    /// A value this build does not know reads as `.unknown` rather than",
    "    /// failing the event that carries it.",
    "    public init(from decoder: any Decoder) throws {",
    "        let raw = try decoder.singleValueContainer().decode(String.self)",
    "        self = Self(rawValue: raw) ?? .unknown",
    "    }",
    "}",
  );
  return lines.join("\n");
}

/**
 * An envelope-plus-union type: `AgentEvent` over `AgentEventPayload`, or
 * `AgentCommand` over `AgentCommandPayload`.
 */
function swiftUnion({ name, payloadName, summary, envelopeFields, members, memberSummary }) {
  const lines = [];
  // The payload union and its member structs.
  lines.push(
    swiftDoc(memberSummary, ""),
    `public enum ${payloadName}: Hashable, Sendable {`,
  );
  for (const member of members) {
    lines.push(swiftDoc(member.summary, "    "), `    case ${swiftIdent(camel(member.type))}(${pascal(member.type)})`);
  }
  lines.push(
    "    /// A type this build does not know, or a known one whose required fields",
    "    /// were missing: kept whole, so nothing that arrives is lost or fatal.",
    "    case unknown(type: String, raw: AgentJSONValue)",
    "",
    "    /// The type on the wire.",
    "    public var type: String {",
    "        switch self {",
  );
  for (const member of members) lines.push(`        case .${swiftIdent(camel(member.type))}: ${JSON.stringify(member.type)}`);
  lines.push(
    "        case .unknown(let type, _): type",
    "        }",
    "    }",
    "",
    `    /// Every type this build knows.`,
    `    public static let knownTypes: [String] = [${members.map((member) => JSON.stringify(member.type)).join(", ")}]`,
    "",
    "    /// The payload for `type`, or nil when the type is unknown or its",
    "    /// required fields do not decode.",
    "    init?(type: String, decoder: any Decoder) {",
    "        switch type {",
  );
  for (const member of members) {
    lines.push(
      `        case ${JSON.stringify(member.type)}:`,
      `            guard let value = try? ${pascal(member.type)}(from: decoder) else { return nil }`,
      `            self = .${swiftIdent(camel(member.type))}(value)`,
    );
  }
  lines.push(
    "        default:",
    "            return nil",
    "        }",
    "    }",
    "",
    "    func encodeFields(to encoder: any Encoder) throws {",
    "        switch self {",
  );
  for (const member of members) lines.push(`        case .${swiftIdent(camel(member.type))}(let value): try value.encode(to: encoder)`);
  lines.push("        case .unknown: break", "        }", "    }", "");
  for (const member of members) {
    lines.push(swiftStruct(pascal(member.type), member.summary, member.fields, "    "), "");
  }
  lines.push("}", "");

  // The envelope struct.
  const keys = [...envelopeFields.map((field) => field.key), "type"];
  lines.push(swiftDoc(summary, ""), `public struct ${name}: Hashable, Sendable, Codable, Identifiable {`);
  for (const field of envelopeFields) {
    lines.push(swiftDoc(field.summary, "    "), `    public var ${swiftIdent(field.key)}: ${swiftType(field)}${field.optional ? "?" : ""}`);
  }
  lines.push("    /// The type and its fields.", `    public var payload: ${payloadName}`, "");
  lines.push("    /// The type on the wire.", "    public var type: String { payload.type }", "");
  lines.push("    /// Whether this build knows the type.", "    public var isKnown: Bool {", "        if case .unknown = payload { return false }", "        return true", "    }", "");
  const params = envelopeFields.map((field) => {
    if (field.key === "v") return "v: String = JunoAgentProtocol.version";
    return `${swiftIdent(field.key)}: ${swiftType(field)}${field.optional ? "? = nil" : ""}`;
  });
  lines.push("    public init(");
  lines.push([...params, `payload: ${payloadName}`].map((param) => `        ${param}`).join(",\n"));
  lines.push("    ) {");
  for (const field of envelopeFields) lines.push(`        self.${field.key} = ${swiftIdent(field.key)}`);
  lines.push("        self.payload = payload", "    }", "");
  lines.push("    private enum EnvelopeKeys: String, CodingKey {");
  for (const key of keys) lines.push(`        case ${swiftIdent(key)} = ${JSON.stringify(key)}`);
  lines.push("    }", "");
  lines.push(
    "    /// Tolerant in exactly the ways the TypeScript reader is: see the header of",
    "    /// this file. Throws only when the object is not an envelope at all, or",
    "    /// names a major version this build does not speak.",
    "    public init(from decoder: any Decoder) throws {",
    "        let raw = try AgentJSONValue(from: decoder)",
    "        let container = try decoder.container(keyedBy: EnvelopeKeys.self)",
  );
  for (const field of envelopeFields) {
    const type = swiftType(field);
    const expr = field.optional
      ? `try? container.decodeIfPresent(${type}.self, forKey: .${swiftIdent(field.key)})`
      : `try container.decode(${type}.self, forKey: .${swiftIdent(field.key)})`;
    lines.push(`        self.${field.key} = ${expr}`);
    if (field.key === "v") {
      lines.push(
        "        guard JunoAgentProtocol.major(of: v) == JunoAgentProtocol.major else {",
        "            throw DecodingError.dataCorruptedError(",
        "                forKey: .v, in: container,",
        '                debugDescription: "Agent protocol \\(v) is not major \\(JunoAgentProtocol.major)"',
        "            )",
        "        }",
      );
    }
  }
  lines.push(
    "        let type = try container.decode(String.self, forKey: .type)",
    `        self.payload = ${payloadName}(type: type, decoder: decoder) ?? .unknown(type: type, raw: raw)`,
    "    }",
    "",
    "    public func encode(to encoder: any Encoder) throws {",
    "        if case .unknown(_, let raw) = payload {",
    "            try raw.encode(to: encoder)",
    "            return",
    "        }",
    "        var container = encoder.container(keyedBy: EnvelopeKeys.self)",
  );
  for (const field of envelopeFields) {
    const method = field.optional ? "encodeIfPresent" : "encode";
    lines.push(`        try container.${method}(${swiftIdent(field.key)}, forKey: .${swiftIdent(field.key)})`);
  }
  lines.push("        try container.encode(type, forKey: .type)", "        try payload.encodeFields(to: encoder)", "    }", "}");
  return lines.join("\n");
}

function renderSwift() {
  const parts = [
    `// Generated by scripts/generate-agent-protocol.mjs. Do not edit.
//
// Source of truth: ${CONTRACT}
// The TypeScript halves (runner/agent-core and src/lib/agent-protocol) come
// from the same file, and \`npm run agent:protocol:check\` fails on drift.
//
// Decoding is tolerant in exactly the ways the TypeScript reader is, so the
// two folds see the same events:
//   - an event type this build does not know → \`.unknown(type:raw:)\`;
//   - a known type whose required field is missing or malformed → the same;
//   - an optional field that is malformed → nil;
//   - an enum value this build does not know → that enum's \`.unknown\`;
//   - an array element that is malformed → skipped;
//   - a key the contract does not name → ignored.
// JSON keys are the contract's field names, never Swift case names.
import Foundation

public enum JunoAgentProtocol {
    public static let name = ${JSON.stringify(contract.protocol)}
    public static let major = ${major}
    public static let minor = ${minor}
    /// What a producer writes as \`v\`.
    public static let version = ${JSON.stringify(V)}
    /// SHA-256 of the contract this was generated from.
    public static let digest = ${JSON.stringify(digest)}

    /// The major version a "<major>.<minor>" string names, or nil.
    public static func major(of version: String) -> Int? {
        let parts = version.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 2, let major = Int(parts[0]), Int(parts[1]) != nil else { return nil }
        return major
    }
}`,
  ];
  for (const e of enums) parts.push(swiftEnum(e));
  for (const type of types) parts.push(swiftStruct(agentName(type.name), type.summary, type.fields, ""));
  parts.push(swiftStruct("AgentCommandReceipt", receipt.summary, receipt.fields, ""));
  parts.push(
    swiftUnion({
      name: "AgentEvent",
      payloadName: "AgentEventPayload",
      summary: contract.envelope.summary,
      envelopeFields: envelope,
      members: events,
      memberSummary: "What an event says, by type.",
    }),
  );
  parts.push(
    swiftUnion({
      name: "AgentCommand",
      payloadName: "AgentCommandPayload",
      summary: contract.commandEnvelope.summary,
      envelopeFields: commandEnvelope,
      members: commands,
      memberSummary: "What a command asks for, by type.",
    }),
  );
  return `${parts.join("\n\n")}\n`;
}

// ── Write or check ──────────────────────────────────────────────────────────

const ts = renderTypeScript();
const rendered = {
  [OUTPUTS.agentCore]: ts,
  [OUTPUTS.web]: ts,
  [OUTPUTS.swift]: renderSwift(),
};

if (check) {
  const stale = [];
  for (const [path, text] of Object.entries(rendered)) {
    let current = null;
    try {
      current = readFileSync(join(root, path), "utf8");
    } catch {
      current = null;
    }
    if (current !== text) stale.push(path);
  }
  if (stale.length > 0) {
    console.error(
      `[agent-protocol] generated code is stale — ${CONTRACT} changed without it:\n  ${stale.join("\n  ")}\n` +
        "  Run: npm run agent:protocol",
    );
    process.exit(1);
  }
  console.log(
    `[agent-protocol] v${V}: ${events.length} events, ${commands.length} commands, ${enums.length} enums — ` +
      `TypeScript and Swift match ${CONTRACT} (${digest.slice(0, 12)}…).`,
  );
} else {
  for (const [path, text] of Object.entries(rendered)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text, "utf8");
    console.log(`Wrote ${path}`);
  }
}

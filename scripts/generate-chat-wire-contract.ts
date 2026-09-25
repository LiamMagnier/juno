/**
 * Generate the chat wire contract: POST /api/chat's request body and the SSE
 * frames it streams back, as JSON Schema, with every field carrying its native
 * status.
 *
 *   npx tsx scripts/generate-chat-wire-contract.ts           # write
 *   npx tsx scripts/generate-chat-wire-contract.ts --check   # verify, exit 1 on drift
 *
 * Sources (never edit the output by hand):
 *   - the request: `chatBodySchema` (src/lib/chat/request.ts), through
 *     `z.toJSONSchema`, the way the Design contract is made;
 *   - the stream: the `StreamChunk` union (src/types/chat.ts), through the
 *     TypeScript checker (scripts/chat-wire/stream-schema.ts);
 *   - the statuses: contracts/chat/juno-chat-wire-v1.status.json, by hand.
 *
 * Why this exists (MACOS_LIQUID_GLASS_REDESIGN.md §A4.4): the OpenAPI gate
 * hashed a YAML file and looked for operation names, so the Mac sent twelve
 * fields to a request the contract said took six, and a new field such as
 * `skillSlug` reached the web with nothing telling native it existed. Here a
 * field the web adds is "unclassified" until someone says whether native sends
 * or reads it (`native`), means to (`planned`) or never will (`web-only`), and
 * the check fails until they do.
 *
 * The check also holds the "native" claims to the Swift: a request field
 * marked native must be a key the Swift request wire encodes, a frame marked
 * native must be one the stream decoder reads, and a field of a type the Swift
 * decodes must be a key its decoder knows. Keys the Swift uses that today's web
 * does not define (the Mac is ahead on the Tool calls & research rework) are
 * listed under `nativeOnly`, and fail once the web defines them, so the entry
 * moves into `fields` with a real status.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";

import { chatBodySchema } from "../src/lib/chat/request";
import { projectStreamUnion, type JsonSchema } from "./chat-wire/stream-schema";
import { swiftKeys, type SwiftSource } from "./chat-wire/swift-keys";

const root = process.cwd();
const OUTPUT = "contracts/chat/juno-chat-wire-v1.schema.json";
const STATUS_FILE = "contracts/chat/juno-chat-wire-v1.status.json";

const STATUSES = ["native", "planned", "web-only"] as const;
type Status = (typeof STATUSES)[number];
const RANK: Record<Status, number> = { native: 2, planned: 1, "web-only": 0 };

interface Entry {
  status: Status;
  note?: string;
}

interface SwiftEvidence extends SwiftSource {
  /** Keys this source reads that are not on the web type, and why that is fine. */
  ignoreExtraKeys?: string;
}

interface StatusFile {
  fields: Record<string, Status | Entry>;
  nativeOnly: Record<string, { note: string }>;
  swift: {
    request: SwiftEvidence[];
    frames: SwiftEvidence[];
    frameFields: SwiftEvidence[];
    defs: Record<string, SwiftEvidence[]>;
  };
}

const statusFile = JSON.parse(readFileSync(resolve(root, STATUS_FILE), "utf8")) as StatusFile;
const errors: string[] = [];

const entryOf = (path: string): Entry | null => {
  const raw = statusFile.fields[path];
  if (raw === undefined) return null;
  const entry = typeof raw === "string" ? { status: raw } : raw;
  if (!STATUSES.includes(entry.status)) {
    errors.push(`${path}: "${entry.status}" is not one of ${STATUSES.join(", ")}`);
    return { status: "web-only" };
  }
  return entry;
};

// ---------------------------------------------------------------------------
// Project both halves.
// ---------------------------------------------------------------------------

const requestSchema = z.toJSONSchema(chatBodySchema, { io: "input", unrepresentable: "any" }) as JsonSchema;
delete requestSchema.$schema;
const stream = projectStreamUnion(root);

// ---------------------------------------------------------------------------
// Classify. A field under a `native` parent must be classified explicitly; a
// field under a `planned` or `web-only` parent inherits it unless listed, and
// may never be more native than its parent. A named type is walked at the most
// native status any field that carries it has.
// ---------------------------------------------------------------------------

interface Walk {
  visited: Set<string>;
  demand: Map<string, Status>;
  problems: string[];
  counts: Record<Status | "unclassified", number>;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function annotate(schema: JsonSchema, status: Status | "unclassified", note?: string) {
  schema["x-native"] = status;
  if (note) schema["x-native-note"] = note;
}

function walkSchema(schema: JsonSchema, path: string, inherited: Status, walk: Walk) {
  if (typeof schema.$ref === "string") {
    const name = schema.$ref.replace("#/$defs/", "");
    const current = walk.demand.get(name);
    if (!current || RANK[inherited] > RANK[current]) walk.demand.set(name, inherited);
  }
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const branches = schema[key];
    if (Array.isArray(branches)) for (const branch of branches) walkSchema(branch as JsonSchema, path, inherited, walk);
  }
  if (schema.items && typeof schema.items === "object") walkSchema(schema.items as JsonSchema, `${path}[]`, inherited, walk);
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    walkSchema(schema.additionalProperties as JsonSchema, `${path}.*`, inherited, walk);
  }
  const properties = schema.properties as Record<string, JsonSchema> | undefined;
  if (!properties) return;
  for (const [name, child] of Object.entries(properties)) {
    if (path.startsWith("stream.") && !path.slice(7).includes(".") && name === "type") continue;
    const childPath = `${path}.${name}`;
    walk.visited.add(childPath);
    const entry = entryOf(childPath);
    let status: Status | "unclassified";
    if (entry) {
      status = entry.status;
      if (RANK[entry.status] > RANK[inherited]) {
        walk.problems.push(`${childPath} is "${entry.status}" under a "${inherited}" parent; a field cannot be more native than what carries it`);
      }
    } else if (inherited === "native") {
      status = "unclassified";
      walk.problems.push(`${childPath} is unclassified: add it to ${STATUS_FILE} as native, planned or web-only`);
    } else {
      status = inherited;
    }
    walk.counts[status] += 1;
    annotate(child, status, entry?.note);
    walkSchema(child, childPath, status === "unclassified" ? "planned" : status, walk);
  }
}

function classify(): { request: JsonSchema; variants: JsonSchema[]; defs: Record<string, JsonSchema>; walk: Walk } {
  let demand = new Map<string, Status>();
  for (let round = 0; ; round += 1) {
    const walk: Walk = {
      visited: new Set(),
      demand: new Map(),
      problems: [],
      counts: { native: 0, planned: 0, "web-only": 0, unclassified: 0 },
    };
    const request = clone(requestSchema);
    annotate(request, "native");
    walkSchema(request, "request", "native", walk);

    const variants = stream.variants.map(clone);
    const seenFrames = new Set<string>();
    for (const variant of variants) {
      const frame = ((variant.properties as Record<string, JsonSchema>).type.const as string) ?? "?";
      const path = `stream.${frame}`;
      walk.visited.add(path);
      const entry = entryOf(path);
      if (!entry && !seenFrames.has(frame)) {
        walk.problems.push(`${path} (the "${frame}" frame) is unclassified: add it to ${STATUS_FILE}`);
      }
      if (!seenFrames.has(frame)) walk.counts[entry ? entry.status : "unclassified"] += 1;
      seenFrames.add(frame);
      annotate(variant, entry ? entry.status : "unclassified", entry?.note);
      walkSchema(variant, path, entry ? entry.status : "planned", walk);
    }

    const defs = clone(stream.defs);
    for (const [name, status] of demand) {
      const def = defs[name];
      if (!def) continue;
      walkSchema(def, name, status, walk);
    }
    const settled =
      walk.demand.size === demand.size && [...walk.demand].every(([name, status]) => demand.get(name) === status);
    if (settled || round > 8) return { request, variants, defs, walk };
    demand = walk.demand;
  }
}

const { request, variants, defs, walk } = classify();
errors.push(...walk.problems);

for (const path of Object.keys(statusFile.fields)) {
  if (!walk.visited.has(path)) errors.push(`${path} is classified but no longer on the wire: remove it from ${STATUS_FILE}`);
}
for (const path of Object.keys(statusFile.nativeOnly ?? {})) {
  if (walk.visited.has(path)) {
    errors.push(`${path} is listed under nativeOnly but the web now defines it: move it to "fields" with a status`);
  }
}

// ---------------------------------------------------------------------------
// Hold the native claims to the Swift.
// ---------------------------------------------------------------------------

const keysOf = (sources: SwiftEvidence[]) => {
  const keys = new Set<string>();
  for (const source of sources) for (const key of swiftKeys(root, source)) keys.add(key);
  return keys;
};
const statusAt = (path: string): Status | null => entryOf(path)?.status ?? null;
const nativeOnly = (path: string) => Object.hasOwn(statusFile.nativeOnly ?? {}, path);

// The request body.
const requestProperties = Object.keys((requestSchema.properties ?? {}) as object);
const swiftRequest = keysOf(statusFile.swift.request);
for (const name of requestProperties) {
  const status = statusAt(`request.${name}`);
  if (status === "native" && !swiftRequest.has(name)) {
    errors.push(`request.${name} is "native" but no Swift request wire encodes "${name}"`);
  }
  if (status && status !== "native" && swiftRequest.has(name)) {
    errors.push(`request.${name} is "${status}" but the Swift request wire sends "${name}": mark it native`);
  }
}
for (const key of swiftRequest) {
  if (!requestProperties.includes(key) && !nativeOnly(`request.${key}`)) {
    errors.push(`The Swift request wire sends "${key}", which chatBodySchema does not define: list request.${key} under nativeOnly with why`);
  }
}

// The frames.
const frameNames = [...new Set(stream.variants.map((variant) => (variant.properties as Record<string, JsonSchema>).type.const as string))];
const swiftFrames = keysOf(statusFile.swift.frames);
for (const frame of frameNames) {
  const status = statusAt(`stream.${frame}`);
  if (status === "native" && !swiftFrames.has(frame)) errors.push(`stream.${frame} is "native" but the Swift stream decoder skips "${frame}" frames`);
  if (status && status !== "native" && swiftFrames.has(frame)) {
    errors.push(`stream.${frame} is "${status}" but the Swift stream decoder reads "${frame}" frames: mark it native`);
  }
}
for (const frame of swiftFrames) {
  if (!frameNames.includes(frame) && !nativeOnly(`stream.${frame}`)) {
    errors.push(`The Swift stream decoder reads "${frame}" frames, which StreamChunk does not define: list stream.${frame} under nativeOnly with why`);
  }
}

// The frames' own fields. The Swift envelope is one struct for every frame, so
// this proves a native field's key is decoded, not which frame it is read on.
const swiftFrameKeys = keysOf(statusFile.swift.frameFields);
const strictFrameKeys = keysOf(statusFile.swift.frameFields.filter((source) => !source.ignoreExtraKeys));
const webFrameKeys = new Set<string>();
for (const variant of stream.variants) {
  const frame = (variant.properties as Record<string, JsonSchema>).type.const as string;
  for (const name of Object.keys(variant.properties as object)) {
    if (name === "type") continue;
    webFrameKeys.add(name);
    if (statusAt(`stream.${frame}`) === "native" && statusAt(`stream.${frame}.${name}`) === "native" && !swiftFrameKeys.has(name)) {
      errors.push(`stream.${frame}.${name} is "native" but the Swift frame decoder never reads "${name}"`);
    }
  }
}
for (const key of strictFrameKeys) {
  if (key === "type" || webFrameKeys.has(key)) continue;
  const listed = Object.keys(statusFile.nativeOnly ?? {}).some((path) => /^stream\.[^.]+\.[^.]+$/.test(path) && path.endsWith(`.${key}`));
  if (!listed) errors.push(`The Swift frame decoder reads "${key}", which no StreamChunk frame defines: list stream.<frame>.${key} under nativeOnly with why`);
}

// The named types the Swift decodes.
for (const [name, sources] of Object.entries(statusFile.swift.defs)) {
  const def = stream.defs[name];
  if (!def) {
    errors.push(`swift.defs names ${name}, which the stream no longer carries`);
    continue;
  }
  const webKeys = Object.keys((def.properties ?? {}) as object);
  const keys = keysOf(sources);
  const strictKeys = keysOf(sources.filter((source) => !source.ignoreExtraKeys));
  for (const field of webKeys) {
    const status = statusAt(`${name}.${field}`);
    if (status === "native" && !keys.has(field)) errors.push(`${name}.${field} is "native" but its Swift decoder never reads "${field}"`);
    if (status && status !== "native" && keys.has(field)) {
      errors.push(`${name}.${field} is "${status}" but its Swift decoder reads "${field}": mark it native`);
    }
  }
  for (const key of strictKeys) {
    if (!webKeys.includes(key) && !nativeOnly(`${name}.${key}`)) {
      errors.push(`The Swift decoder for ${name} reads "${key}", which ${name} does not define: list ${name}.${key} under nativeOnly with why`);
    }
  }
}
for (const path of Object.keys(statusFile.nativeOnly ?? {})) {
  const [scope] = path.split(".");
  const known =
    scope === "request" || scope === "stream" || Object.hasOwn(stream.defs, scope);
  if (!known) errors.push(`nativeOnly lists ${path}, but ${scope} is not on the wire`);
}

// ---------------------------------------------------------------------------
// Emit.
// ---------------------------------------------------------------------------

const contract = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://juno.app/contracts/chat/juno-chat-wire-v1.schema.json",
  title: "Juno chat wire",
  description:
    "POST /api/chat: the request body (ChatRequest) and the SSE frames the response streams (StreamEvent, one JSON object per `data:` line; GET /api/chat/stream/{generationId} replays the same frames). Generated from src/lib/chat/request.ts (chatBodySchema) and src/types/chat.ts (StreamChunk), with each field's `x-native` status from contracts/chat/juno-chat-wire-v1.status.json. Do not edit by hand; run `npm run native:wire`.",
  "x-native-legend": {
    native: "The Swift apps send or read it today.",
    planned: "Native means to; the gap is known.",
    "web-only": "Only the web sends or reads it, by decision; the note says why.",
    unclassified: "Nobody has decided yet. `npm run native:wire:check` fails.",
  },
  "x-native-summary": walk.counts,
  "x-native-only": statusFile.nativeOnly ?? {},
  $defs: {
    ChatRequest: request,
    StreamEvent: { oneOf: variants },
    ...defs,
  },
};

const serialized = `${JSON.stringify(contract, null, 2)}\n`;
const target = resolve(root, OUTPUT);
const check = process.argv.includes("--check");
const report = () => {
  for (const error of errors) console.error(`[chat-wire] ${error}`);
};

if (check) {
  let existing = "";
  try {
    existing = readFileSync(target, "utf8");
  } catch {
    errors.unshift(`${OUTPUT} is missing. Run: npm run native:wire`);
  }
  if (existing && existing !== serialized) errors.unshift(`${OUTPUT} is out of date. Run: npm run native:wire`);
  if (errors.length) {
    report();
    process.exit(1);
  }
  const { native, planned } = walk.counts;
  console.log(
    `[chat-wire] up to date: ${native} native, ${planned} planned, ${walk.counts["web-only"]} web-only fields; every native claim matches the Swift`,
  );
} else {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, serialized);
  console.log(`[chat-wire] wrote ${OUTPUT}`);
  if (errors.length) {
    report();
    process.exit(1);
  }
}

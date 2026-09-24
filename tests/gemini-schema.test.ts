import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { geminiFunctionDeclarations } from "@/lib/gemini-core";
import { sanitizeForGeminiJsonSchema } from "@/lib/tools/schema";

/*
 * Connector schemas on Gemini (SPEC §5.3 item 2, RC-4).
 *
 * A connector's schema is whatever its MCP server wrote. Gemini's `parameters`
 * field is an OpenAPI subset that rejected most of it, which 400'd the whole
 * turn before the model saw a word; connector schemas now go to
 * `parametersJsonSchema` after `sanitizeForGeminiJsonSchema` cuts them down to
 * the JSON Schema keywords Google documents. The fixtures below are the shapes
 * real servers send — the SDK's zod-to-json-schema output, GitHub's, Linear's,
 * Notion's — not idealised ones.
 */

/** Every keyword the sanitizer may emit (Google's structured-output subset, 2026-09-17). */
const ALLOWED = new Set([
  "type", "title", "description", "properties", "required", "additionalProperties",
  "enum", "format", "minimum", "maximum", "items", "prefixItems", "minItems", "maxItems", "anyOf",
]);

/** Walks a sanitized schema and returns every keyword outside the documented subset. */
function strayKeywords(node: unknown, at = "(root)"): string[] {
  if (!node || typeof node !== "object" || Array.isArray(node)) return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (!ALLOWED.has(key)) out.push(`${at}.${key}`);
    if (key === "properties" && value && typeof value === "object") {
      for (const [name, child] of Object.entries(value as Record<string, unknown>)) out.push(...strayKeywords(child, `${at}.${name}`));
    } else if ((key === "items" || key === "additionalProperties") && value && typeof value === "object") {
      out.push(...strayKeywords(value, `${at}.${key}`));
    } else if ((key === "anyOf" || key === "prefixItems") && Array.isArray(value)) {
      value.forEach((child, i) => out.push(...strayKeywords(child, `${at}.${key}[${i}]`)));
    }
  }
  return out;
}

// ── Fixtures, as servers send them ────────────────────────────────────────────

/** The MCP TypeScript SDK's zod-to-json-schema output (draft-07, `$schema`, strict objects). */
const ZOD_OUTPUT = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: {
    owner: { type: "string", description: "Repository owner" },
    repo: { type: "string", description: "Repository name" },
    title: { type: "string", minLength: 1 },
    body: { type: "string" },
    labels: { type: "array", items: { type: "string" } },
    assignees: { type: "array", items: { type: "string" }, maxItems: 10 },
    milestone: { type: ["number", "null"], description: "Milestone number" },
    draft: { type: "boolean", default: false },
  },
  required: ["owner", "repo", "title"],
  additionalProperties: false,
};

/** Refs into `$defs`, a nullable union and a `const` discriminator (Linear-style). */
const WITH_DEFS = {
  type: "object",
  $id: "https://example.com/linear/create_issue",
  $comment: "generated",
  $defs: {
    Priority: { type: "integer", enum: [0, 1, 2, 3, 4], description: "0 = none" },
    Label: {
      type: "object",
      properties: { id: { type: "string", format: "uuid" }, name: { type: "string" } },
      required: ["id"],
    },
  },
  properties: {
    teamId: { type: "string", format: "uuid" },
    priority: { $ref: "#/$defs/Priority" },
    labels: { type: "array", items: { $ref: "#/$defs/Label" } },
    dueDate: { anyOf: [{ type: "string", format: "date" }, { type: "null" }] },
    kind: { const: "issue" },
  },
  required: ["teamId", "kind", "ghost"],
};

/** `oneOf` branches and a `definitions` ref (Notion-style draft-04). */
const NOTION = {
  type: "object",
  definitions: {
    RichText: { type: "object", properties: { content: { type: "string" } }, required: ["content"] },
  },
  properties: {
    parent: {
      oneOf: [
        { type: "object", properties: { page_id: { type: "string" } }, required: ["page_id"] },
        { type: "object", properties: { database_id: { type: "string" } }, required: ["database_id"] },
      ],
    },
    title: { type: "array", items: { $ref: "#/definitions/RichText" } },
    icon: { type: "string", pattern: "^\\p{Emoji}$", examples: ["🚀"] },
  },
};

/** A tree node that refers to itself. */
const CYCLIC = {
  type: "object",
  $defs: {
    Node: {
      type: "object",
      properties: { name: { type: "string" }, children: { type: "array", items: { $ref: "#/$defs/Node" } } },
    },
  },
  properties: { root: { $ref: "#/$defs/Node" } },
};

test("the sanitizer and the declarations live outside server-only", () => {
  assert.doesNotMatch(readFileSync("src/lib/tools/schema.ts", "utf8"), /^import "server-only";/m);
});

test("the SDK's zod output: $schema and unsupported keywords go, the shape stays", () => {
  const out = sanitizeForGeminiJsonSchema(ZOD_OUTPUT);
  assert.deepEqual(strayKeywords(out), []);
  assert.deepEqual(out, {
    type: "object",
    properties: {
      owner: { type: "string", description: "Repository owner" },
      repo: { type: "string", description: "Repository name" },
      title: { type: "string" },
      body: { type: "string" },
      labels: { type: "array", items: { type: "string" } },
      assignees: { type: "array", items: { type: "string" }, maxItems: 10 },
      milestone: { type: ["number", "null"], description: "Milestone number" },
      draft: { type: "boolean" },
    },
    required: ["owner", "repo", "title"],
    additionalProperties: false,
  });
});

test("local $refs are inlined, const becomes a one-value enum, unknown formats are dropped", () => {
  const out = sanitizeForGeminiJsonSchema(WITH_DEFS);
  assert.deepEqual(strayKeywords(out), []);
  const properties = out.properties as Record<string, Record<string, unknown>>;
  assert.deepEqual(properties.priority, { type: "integer", enum: [0, 1, 2, 3, 4], description: "0 = none" });
  assert.deepEqual(properties.labels, {
    type: "array",
    items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } }, required: ["id"] },
  });
  assert.deepEqual(properties.dueDate, { anyOf: [{ type: "string", format: "date" }, { type: "null" }] });
  assert.deepEqual(properties.kind, { enum: ["issue"] });
  assert.deepEqual(properties.teamId, { type: "string" }, "uuid is not a documented format");
  // `required` keeps only names that are properties.
  assert.deepEqual(out.required, ["teamId", "kind"]);
  assert.equal("$defs" in out, false);
  assert.equal("$id" in out, false);
});

test("oneOf becomes anyOf, and draft-04 `definitions` refs resolve", () => {
  const out = sanitizeForGeminiJsonSchema(NOTION);
  assert.deepEqual(strayKeywords(out), []);
  const properties = out.properties as Record<string, Record<string, unknown>>;
  assert.equal("oneOf" in properties.parent, false);
  assert.equal((properties.parent.anyOf as unknown[]).length, 2);
  assert.deepEqual(properties.title.items, { type: "object", properties: { content: { type: "string" } }, required: ["content"] });
  assert.deepEqual(properties.icon, { type: "string" });
});

test("a self-referencing schema is cut, not followed forever", () => {
  const out = sanitizeForGeminiJsonSchema(CYCLIC);
  const root = (out.properties as Record<string, Record<string, unknown>>).root;
  assert.equal(root.type, "object");
  const children = (root.properties as Record<string, Record<string, unknown>>).children;
  // The cycle is cut to `{}` where the Node refers to itself again.
  assert.deepEqual(children, { type: "array", items: {} });
});

test("a $ref chain deeper than eight is cut to {}", () => {
  const defs: Record<string, unknown> = {};
  for (let i = 0; i < 12; i++) defs[`D${i}`] = i === 11 ? { type: "string" } : { $ref: `#/$defs/D${i + 1}` };
  const out = sanitizeForGeminiJsonSchema({ type: "object", $defs: defs, properties: { deep: { $ref: "#/$defs/D0" } } });
  assert.deepEqual((out.properties as Record<string, unknown>).deep, {});
  // A shallow chain resolves.
  const shallow = sanitizeForGeminiJsonSchema({
    type: "object",
    $defs: { A: { $ref: "#/$defs/B" }, B: { type: "integer" } },
    properties: { x: { $ref: "#/$defs/A" } },
  });
  assert.deepEqual((shallow.properties as Record<string, unknown>).x, { type: "integer" });
});

test("a remote or broken $ref resolves to {}", () => {
  const out = sanitizeForGeminiJsonSchema({
    type: "object",
    properties: { a: { $ref: "https://example.com/schema.json" }, b: { $ref: "#/$defs/Missing" } },
  });
  assert.deepEqual(out.properties, { a: {}, b: {} });
});

test("allOf is merged into its parent", () => {
  const out = sanitizeForGeminiJsonSchema({
    type: "object",
    allOf: [
      { properties: { a: { type: "string" } }, required: ["a"] },
      { properties: { b: { type: "number" } }, required: ["b"] },
    ],
    properties: { c: { type: "boolean" } },
  });
  assert.deepEqual(out, {
    type: "object",
    properties: { a: { type: "string" }, b: { type: "number" }, c: { type: "boolean" } },
    required: ["a", "b"],
  });
});

test("a tuple `items` array becomes prefixItems", () => {
  const out = sanitizeForGeminiJsonSchema({
    type: "object",
    properties: { point: { type: "array", items: [{ type: "number" }, { type: "number" }] } },
  });
  assert.deepEqual((out.properties as Record<string, unknown>).point, { type: "array", prefixItems: [{ type: "number" }, { type: "number" }] });
});

test("the root is always an object schema, whatever arrives", () => {
  assert.deepEqual(sanitizeForGeminiJsonSchema(undefined), { type: "object", properties: {} });
  assert.deepEqual(sanitizeForGeminiJsonSchema("nope"), { type: "object", properties: {} });
  assert.deepEqual(sanitizeForGeminiJsonSchema({ type: "string" }), { type: "object", properties: {} });
  assert.deepEqual(sanitizeForGeminiJsonSchema({}), { type: "object", properties: {} });
  // Properties with no declared type still make an object.
  assert.deepEqual(sanitizeForGeminiJsonSchema({ properties: { q: { type: "string" } } }), {
    type: "object",
    properties: { q: { type: "string" } },
  });
});

test("the input schema is never mutated", () => {
  const before = JSON.stringify(WITH_DEFS);
  sanitizeForGeminiJsonSchema(WITH_DEFS);
  assert.equal(JSON.stringify(WITH_DEFS), before);
});

test("a hostile nesting depth cannot exhaust the stack", () => {
  let node: Record<string, unknown> = { type: "string" };
  for (let i = 0; i < 5_000; i++) node = { type: "object", properties: { n: node } };
  const out = sanitizeForGeminiJsonSchema(node);
  assert.equal(out.type, "object");
});

/** Eight levels of `$defs`, each with `fanOut` properties pointing at the next level. */
function sharedDefs(fanOut: number, depth = 8): Record<string, unknown> {
  const $defs: Record<string, unknown> = {};
  for (let level = 0; level < depth; level++) {
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < fanOut; i++) {
      properties[`p${i}`] = level === depth - 1 ? { type: "string" } : { $ref: `#/$defs/L${level + 1}`, description: `Child ${i}.` };
    }
    $defs[`L${level}`] = { type: "object", properties };
  }
  return { type: "object", $defs, properties: { root: { $ref: "#/$defs/L0" } } };
}

test("shared $defs cannot blow up: expansion is bounded across the whole schema, not only by depth", () => {
  const input = sharedDefs(8);
  assert.ok(JSON.stringify(input).length < 4_000, "the input is a couple of kilobytes");
  const started = performance.now();
  const out = sanitizeForGeminiJsonSchema(input);
  const elapsed = performance.now() - started;
  const size = JSON.stringify(out).length;
  // Unbounded, this is ~480 MB and seconds of synchronous CPU.
  assert.ok(size < 256 * 1024, `output stayed small (${size} bytes)`);
  assert.ok(elapsed < 1_000, `and returned quickly (${Math.round(elapsed)} ms)`);
  assert.deepEqual(strayKeywords(out), []);
  // The first path is followed all the way down before the budget runs out…
  let node = (out.properties as Record<string, Record<string, unknown>>).root;
  for (let level = 0; level < 7; level++) node = (node.properties as Record<string, Record<string, unknown>>).p0;
  assert.deepEqual(node.properties, Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`p${i}`, { type: "string" }])));
  // …and a reference past it keeps what was said in place.
  const lastChild = ((out.properties as Record<string, Record<string, unknown>>).root.properties as Record<string, unknown>).p7;
  assert.deepEqual(lastChild, { description: "Child 7." });
});

test("moderate reuse of a definition still expands in full", () => {
  const out = sanitizeForGeminiJsonSchema(sharedDefs(3, 4));
  // Four levels of three: 3^4 string leaves, every reference resolved.
  let leaves = 0;
  const walk = (node: Record<string, unknown>) => {
    if (node.type === "string") leaves += 1;
    if (node.properties) for (const child of Object.values(node.properties as Record<string, Record<string, unknown>>)) walk(child);
  };
  walk(out);
  assert.equal(leaves, 81);
});

test("connector declarations carry parametersJsonSchema; a Juno spec out of the subset takes the same path", () => {
  const declarations = geminiFunctionDeclarations({
    tools: [
      { type: "function", function: { name: "github__create_issue", description: "Create", parameters: ZOD_OUTPUT } },
      {
        type: "function",
        function: {
          name: "web_search",
          description: "Search",
          parameters: { type: "object", properties: { query: { type: "string", description: "What to search for." } }, required: ["query"] },
        },
      },
      {
        type: "function",
        function: { name: "calculate", description: "Maths", parameters: { type: "object", properties: { e: { type: "string", pattern: "x" } } } },
      },
    ],
    resolve: (name) => ({ origin: name.includes("__") ? "connector" : "juno" }),
  });
  assert.deepEqual(Object.keys(declarations[0]).sort(), ["description", "name", "parametersJsonSchema"]);
  assert.deepEqual(Object.keys(declarations[1]).sort(), ["description", "name", "parameters"]);
  // `calculate` claimed to be Juno's but left the portable subset: sanitized, never a 400.
  assert.deepEqual(Object.keys(declarations[2]).sort(), ["description", "name", "parametersJsonSchema"]);
  // A toolset with no resolver (the old one) treats everything as a connector.
  const old = geminiFunctionDeclarations({ tools: [{ type: "function", function: { name: "t", parameters: { type: "object", properties: {} } } }] });
  assert.deepEqual(old, [{ name: "t", description: "", parametersJsonSchema: { type: "object", properties: {} } }]);
});

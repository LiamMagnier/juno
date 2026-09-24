import test from "node:test";
import assert from "node:assert/strict";

import {
  portableSchemaIssues,
  portableToAnthropic,
  portableToCompat,
  portableToGemini,
  portableToOpenAI,
  portableValueIssue,
} from "@/lib/tools/schema";
import type { PortableSchema } from "@/lib/tools/types";

/*
 * The portable schema subset (DECISIONS T2, SPEC §3.1): `type`, `properties`,
 * `required`, `items`, `enum` and `description`, nothing else. Every provider
 * accepts it as it is, which is the point: a Juno tool is declared once and the
 * per-provider translation is at most one dialect detail.
 */

const SEARCH: PortableSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "What to search for." },
    freshness: { type: "string", description: "How recent.", enum: ["day", "week", "any"] },
    limit: { type: "integer", description: "At most this many." },
    weight: { type: "number", description: "A weight." },
    exact: { type: "boolean", description: "Exact phrase." },
    sites: { type: "array", description: "Sites.", items: { type: "string", description: "A host." } },
    filter: {
      type: "object",
      description: "A filter.",
      properties: { lang: { type: "string", description: "Language.", enum: ["en", "de"] } },
      required: ["lang"],
    },
  },
  required: ["query"],
};

test("a portable schema has no issues", () => {
  assert.deepEqual(portableSchemaIssues(SEARCH), []);
  assert.deepEqual(portableSchemaIssues({ type: "object", properties: {} }), []);
});

test("every keyword outside the subset is named with its path", () => {
  const issues = portableSchemaIssues({
    type: "object",
    $schema: "x",
    additionalProperties: false,
    properties: {
      q: { type: "string", description: "Q.", minLength: 1 },
      n: { type: "number", description: "N.", enum: [1, 2] },
      one: { oneOf: [{ type: "string" }], description: "One." },
      bare: { type: "string" },
      nested: {
        type: "object",
        description: "Nested.",
        properties: { deep: { type: "string", description: "Deep.", format: "uri" } },
      },
      list: { type: "array", description: "List.", items: { type: "null", description: "Null." } },
      e: { type: "string", description: "E.", enum: [] },
    },
    required: ["q", "ghost"],
  });
  assert.deepEqual(issues.sort(), [
    '(root): "$schema" is outside the portable subset',
    '(root): "additionalProperties" is outside the portable subset',
    '(root): required "ghost" is not a property',
    '(root).bare: description is required',
    '(root).e: enum must be a non-empty list of strings',
    '(root).list.items: type "null" is not portable',
    '(root).n: "enum" is outside the portable subset',
    '(root).nested.deep: "format" is outside the portable subset',
    '(root).one: type undefined is not portable',
    '(root).q: "minLength" is outside the portable subset',
  ].sort());
});

test("a root that is not an object schema is refused", () => {
  assert.deepEqual(portableSchemaIssues(null), ["(root): not an object"]);
  assert.ok(portableSchemaIssues({ type: "string", properties: {} }).includes('(root): type must be "object"'));
  assert.ok(portableSchemaIssues({ type: "object" }).includes("(root): properties must be an object"));
});

test("Anthropic, OpenAI and compat take the subset as it is — as a copy", () => {
  for (const translate of [portableToAnthropic, portableToOpenAI, portableToCompat]) {
    const out = translate(SEARCH);
    assert.deepEqual(out, SEARCH);
    assert.notEqual(out, SEARCH, "a copy, so a provider-side edit never reaches the registry");
    assert.notEqual((out as { properties: unknown }).properties, SEARCH.properties);
  }
});

test("Gemini's OpenAPI dialect marks a string enum with format: enum, and nothing else changes", () => {
  const out = portableToGemini(SEARCH) as { properties: Record<string, Record<string, unknown>> };
  assert.deepEqual(out.properties.freshness, {
    type: "string",
    description: "How recent.",
    enum: ["day", "week", "any"],
    format: "enum",
  });
  assert.deepEqual(
    (out.properties.filter.properties as Record<string, Record<string, unknown>>).lang.format,
    "enum",
    "nested enums too",
  );
  assert.equal("format" in out.properties.query, false);
  assert.deepEqual(out.properties.sites, SEARCH.properties.sites);
  assert.equal("format" in SEARCH.properties.freshness, false, "the registry's schema is untouched");
});

test("a value is checked against the subset: required keys, primitive types, enum membership", () => {
  assert.equal(portableValueIssue(SEARCH, { query: "juno" }), null);
  assert.equal(
    portableValueIssue(SEARCH, {
      query: "juno",
      freshness: "week",
      limit: 3,
      weight: 0.5,
      exact: true,
      sites: ["a.example"],
      filter: { lang: "de" },
    }),
    null,
  );
  assert.equal(portableValueIssue(SEARCH, {}), '"query" is required');
  assert.equal(portableValueIssue(SEARCH, { query: 3 }), '"query" must be a string');
  assert.equal(portableValueIssue(SEARCH, { query: "q", freshness: "year" }), '"freshness" must be one of day, week, any');
  assert.equal(portableValueIssue(SEARCH, { query: "q", limit: 2.5 }), '"limit" must be an integer');
  assert.equal(portableValueIssue(SEARCH, { query: "q", weight: Number.NaN }), '"weight" must be a number');
  assert.equal(portableValueIssue(SEARCH, { query: "q", exact: "yes" }), '"exact" must be a boolean');
  assert.equal(portableValueIssue(SEARCH, { query: "q", sites: "a" }), '"sites" must be an array');
  assert.equal(portableValueIssue(SEARCH, { query: "q", sites: ["a", 2] }), '"sites[1]" must be a string');
  assert.equal(portableValueIssue(SEARCH, { query: "q", filter: {} }), '"filter.lang" is required');
  assert.equal(portableValueIssue(SEARCH, [1]), "the output must be a JSON object");
});

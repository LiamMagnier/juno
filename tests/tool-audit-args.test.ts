import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { auditArgsForJunoTool, auditHmac } from "@/lib/tools/audit-args";
import { JUNO_TOOL_SPECS, junoToolSpec } from "@/lib/tools/registry";
import type { ToolSpec } from "@/lib/tools/types";

/*
 * What a Juno tool call's audit row holds of its arguments (SPEC §3.3 item 7).
 * `ToolInvocation.args` is unencrypted JSON while message text is encrypted at
 * rest, so a query, a URL, an expression or a program must never land there
 * raw: only a keyed hash, a length and, for a URL, its host.
 */

const SECRET = "test-secret";

function spec(id: string): ToolSpec {
  const found = junoToolSpec(id);
  assert.ok(found, `${id} is in the registry`);
  return found;
}

function serialized(value: unknown): string {
  return JSON.stringify(value);
}

test("the audit helper keeps server-only out of its static graph", () => {
  const source = readFileSync(path.join(process.cwd(), "src/lib/tools/audit-args.ts"), "utf8");
  assert.doesNotMatch(source, /^import "server-only";/m);
});

test("a query, an expression and a program never reach the row", () => {
  const cases: Array<[string, Record<string, unknown>, string[]]> = [
    ["web_search", { query: "my landlord's name is Ada Lovelace", recency: "week", count: 5 }, ["Ada Lovelace", "landlord"]],
    ["calculate", { expression: "(1+0.05)^10 * 2000" }, ["(1+0.05)", "2000"]],
    ["run_code", { code: "import pandas as pd\nprint(open('salaries.csv').read())", files: ["salaries.csv"], reason: "sum the payroll" }, ["pandas", "salaries", "payroll"]],
    ["search_chats", { query: "divorce lawyer", window: "month" }, ["divorce"]],
    ["suggest_research", { question: "Is my rash eczema?", reason: "medical" }, ["rash", "eczema"]],
    ["current_time", { time_zone: "Asia/Tokyo" }, ["Tokyo"]],
    ["read_document", { action: "search", file: "contract.pdf", query: "termination fee" }, ["contract", "termination"]],
  ];
  for (const [id, args, secrets] of cases) {
    const row = auditArgsForJunoTool(spec(id), args, { secret: SECRET });
    assert.equal(row.tool, id);
    assert.equal(row.n, Object.keys(args).length);
    const text = serialized(row);
    for (const secret of secrets) assert.ok(!text.includes(secret), `${id} leaked "${secret}": ${text}`);
  }
});

test("each text value becomes a keyed hash and a length; equal values hash equally", () => {
  const row = auditArgsForJunoTool(spec("web_search"), { query: "juno release notes", count: 5, recency: "week" }, { secret: SECRET });
  assert.deepEqual(row.keys.query, { hmac: auditHmac("juno release notes", SECRET), len: 18 });
  // Numbers and the tool's own enum members are not the user's words.
  assert.equal(row.keys.count, 5);
  assert.equal(row.keys.recency, "week");
  // The key is the deployment's secret: another secret, another hash.
  assert.notEqual(auditHmac("juno release notes", SECRET), auditHmac("juno release notes", "other"));
  assert.equal(auditHmac("x", SECRET), auditHmac("x", SECRET));
});

test("a URL keeps only its host", () => {
  const url = "https://example.com/private/path?token=abc&user=ada";
  const row = auditArgsForJunoTool(spec("web_fetch"), { url, offset: 16_000 }, { secret: SECRET });
  assert.deepEqual(row.keys.url, { host: "example.com", hmac: auditHmac(url, SECRET), len: url.length });
  assert.equal(row.keys.offset, 16_000);
  const text = serialized(row);
  for (const part of ["private", "token", "abc", "ada", "https://"]) assert.ok(!text.includes(part), part);
});

test("a string that is not one of the schema's enum members is hashed like any other", () => {
  const row = auditArgsForJunoTool(spec("web_search"), { query: "q", recency: "since my surgery" }, { secret: SECRET });
  assert.ok(typeof row.keys.recency === "object" && row.keys.recency !== null && "hmac" in row.keys.recency);
});

test("model-written key names are counted, never stored", () => {
  const row = auditArgsForJunoTool(spec("calculate"), { expression: "1+1", "my password is hunter2": true }, { secret: SECRET });
  assert.equal(row.n, 2);
  assert.equal(row.keys._undeclared, 1);
  assert.ok(!serialized(row).includes("hunter2"));
});

test("arrays and nested values are bounded and hashed", () => {
  const files = Array.from({ length: 25 }, (_, i) => `secret-${i}.csv`);
  const row = auditArgsForJunoTool(spec("run_code"), { code: "print(1)", files }, { secret: SECRET });
  const kept = row.keys.files;
  assert.ok(Array.isArray(kept));
  assert.equal(kept.length, 21, "20 hashed items and one count of the rest");
  assert.deepEqual(kept.at(-1), { items: 5 });
  assert.ok(!serialized(row).includes("secret-"));
});

test("every registry spec can be audited without leaking a string argument", () => {
  for (const s of JUNO_TOOL_SPECS) {
    const args: Record<string, unknown> = {};
    for (const [key, property] of Object.entries(s.input.properties)) {
      if (property.type === "string" && !property.enum) args[key] = `raw-${key}-value`;
    }
    const text = serialized(auditArgsForJunoTool(s, args, { secret: SECRET }));
    assert.ok(!text.includes("raw-"), `${s.id}: ${text}`);
  }
});

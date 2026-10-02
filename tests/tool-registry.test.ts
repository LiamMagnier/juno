import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { classifyExternalAction, junoRuleKeys } from "@/lib/action-approval";
import { JUNO_TOOL_IDS, JUNO_TOOL_SPECS, junoToolSpec } from "@/lib/tools/registry";
import { toActionRiskClass } from "@/lib/tools/risk";
import { PORTABLE_SCHEMA_KEYWORDS, defineTool, portableSchemaProblem, type ToolSpec } from "@/lib/tools/types";

/*
 * One registry, one spec per tool (SPEC §3.1, §3.8): ids unique and valid,
 * schemas in the portable subset every provider accepts, descriptions within
 * bounds, the operational fields set as the spec tables say, and the broker's
 * exact rules equal to each spec's own risk (SPEC §3.3 item 1).
 */

const root = process.cwd();

test("the registry holds the ten tools, each id unique and a valid function name", () => {
  assert.deepEqual([...JUNO_TOOL_IDS], [
    "web_search", "web_fetch", "read_document", "inspect_image", "run_code",
    "search_chats", "current_time", "calculate", "suggest_research", "start_task",
  ]);
  assert.equal(new Set(JUNO_TOOL_IDS).size, JUNO_TOOL_IDS.length);
  for (const spec of JUNO_TOOL_SPECS) {
    assert.match(spec.id, /^[a-z][a-z0-9_]{1,40}$/);
    assert.equal(junoToolSpec(spec.id), spec);
  }
  assert.equal(junoToolSpec("browser_agent"), undefined);
});

test("every schema is in the portable subset, and every description fits", () => {
  for (const spec of JUNO_TOOL_SPECS) {
    assert.equal(portableSchemaProblem(spec.input), null, spec.id);
    assert.equal(spec.input.type, "object");
    for (const name of spec.input.required ?? []) assert.ok(name in spec.input.properties, `${spec.id}.${name}`);
    assert.ok(spec.description.length > 100 && spec.description.length <= 1_200, `${spec.id}: ${spec.description.length} chars`);
    assert.ok(spec.title.trim().length > 0, spec.id);
  }
  assert.deepEqual([...PORTABLE_SCHEMA_KEYWORDS].sort(), ["description", "enum", "items", "properties", "required", "type"]);
});

test("defineTool refuses a non-portable keyword or a bad name at import", () => {
  const base: ToolSpec = {
    id: "calculate",
    title: "T",
    description: "D",
    input: { type: "object", properties: { x: { type: "string", description: "x" } } },
    risk: "read",
    parallelSafe: true,
    timeoutMs: 1_000,
    icon: "calculator",
    broker: "none",
    dedupe: true,
    present: () => ({}),
    execute: async () => ({ status: "succeeded", text: "", body: "" }),
  };
  assert.doesNotThrow(() => defineTool(base));
  const withKeyword = (property: Record<string, unknown>) =>
    ({ ...base, input: { type: "object", properties: { x: property } } }) as unknown as ToolSpec;
  for (const bad of [
    { type: "string", description: "x", format: "uri" },
    { type: "string", description: "x", default: "a" },
    { type: "integer", description: "x", minimum: 1 },
    { oneOf: [{ type: "string" }], description: "x" },
    { type: "string" },
    { type: "number", description: "x", enum: ["1"] },
    { type: "array", description: "x" },
  ]) {
    assert.throws(() => defineTool(withKeyword(bad)), /defineTool\(calculate\)/, JSON.stringify(bad));
  }
  assert.throws(() => defineTool({ ...base, input: { ...base.input, additionalProperties: false } as unknown as ToolSpec["input"] }));
  assert.throws(() => defineTool({ ...base, input: { ...base.input, required: ["y"] } }), /not a property/);
  assert.throws(() => defineTool({ ...base, id: "Bad-Name" as ToolSpec["id"] }), /not a valid tool name/);
});

test("risk, parallelism, timeouts, icons, brokers and dedupe are as the spec tables say", () => {
  const expected: Record<string, [ToolSpec["risk"], boolean, number, ToolSpec["icon"], ToolSpec["broker"], boolean]> = {
    web_search: ["read", true, 15_000, "search", "juno_runtime", true],
    web_fetch: ["read", true, 20_000, "globe", "juno_runtime", true],
    read_document: ["read", true, 30_000, "document", "juno_runtime", true],
    inspect_image: ["read", true, 30_000, "image", "juno_runtime", true],
    run_code: ["read", false, 130_000, "code", "juno_runtime", true],
    search_chats: ["read", true, 10_000, "chats", "juno_runtime", true],
    current_time: ["read", true, 1_000, "clock", "none", false],
    calculate: ["read", true, 1_000, "calculator", "none", true],
    suggest_research: ["read", true, 1_000, "research", "none", false],
    start_task: ["external", false, 60_000, "task", "self", true],
  };
  for (const spec of JUNO_TOOL_SPECS) {
    assert.deepEqual([spec.risk, spec.parallelSafe, spec.timeoutMs, spec.icon, spec.broker, spec.dedupe], expected[spec.id], spec.id);
    if (spec.parallelSafe) assert.equal(spec.risk, "read", `${spec.id}: only reads run in parallel`);
  }
});

test("the broker's juno_runtime rules equal each spec's own risk, and there are no others", () => {
  const brokered = JUNO_TOOL_SPECS.filter((spec) => spec.broker === "juno_runtime");
  const runtimeKeys = junoRuleKeys().filter((key) => key.startsWith("juno_runtime:")).sort();
  assert.deepEqual(runtimeKeys, brokered.map((spec) => `juno_runtime:${spec.id}`).sort());
  for (const spec of brokered) {
    const { riskClass, reasons } = classifyExternalAction({ connectorId: "juno_runtime", toolName: spec.id });
    assert.equal(riskClass, toActionRiskClass(spec.risk), spec.id);
    assert.deepEqual(reasons, ["juno_exact_rule"]);
  }
});

test("present never throws and keeps every string on one line, at most 200 characters", () => {
  const nasty = [
    {},
    { query: "a\nb\u0000c", url: "https://exämple.com/path\n", expression: "x".repeat(1_000), title: 42, file: null },
    { query: { nested: true }, url: 7, code: "print(1)\nprint(2)\n", reason: "r".repeat(500), question: "q".repeat(400) },
    { x: 1, y: 2, width: 30, height: "40", page: 2.7, fromPage: "3", toPage: 7, time_zone: "Asia/Tokyo" },
  ];
  for (const spec of JUNO_TOOL_SPECS) {
    for (const args of nasty) {
      const present = spec.present!(args as Record<string, unknown>);
      for (const [key, value] of Object.entries(present)) {
        assert.ok(["string", "number", "boolean"].includes(typeof value), `${spec.id}.${key}`);
        if (typeof value === "string") {
          assert.ok(value.length <= 200, `${spec.id}.${key} is ${value.length} chars`);
          // eslint-disable-next-line no-control-regex
          assert.doesNotMatch(value, /[\u0000-\u001f\u007f]/, `${spec.id}.${key} is not one line`);
        }
      }
    }
  }
  assert.deepEqual(junoToolSpec("web_fetch")!.present!({ url: "https://www.Exämple.com/a" }), {
    url: "https://www.Exämple.com/a",
    domain: "exämple.com",
  });
  assert.deepEqual(junoToolSpec("run_code")!.present!({ code: "a\nb\nc\n", reason: "sum" }), { language: "python", reason: "sum", lines: 3 });
});

test("model-facing text lives in defineTool or *.prompt.ts files (INV-29)", () => {
  const dir = path.join(root, "src/lib/tools/specs");
  for (const spec of JUNO_TOOL_SPECS) {
    const file = path.join(dir, `${spec.id.replace(/_/g, "-")}.ts`);
    assert.ok(existsSync(file), `${spec.id} has its own spec file`);
    const source = readFileSync(file, "utf8");
    assert.match(source, /defineTool(<[^>]+>)?\(/, `${spec.id} is declared through defineTool`);
  }
});

/** Resolves an `@/…` or relative specifier to a file under src/, or null for a package. */
function resolveLocal(from: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = path.join(root, "src", specifier.slice(2));
  else if (specifier.startsWith(".")) base = path.resolve(path.dirname(from), specifier);
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (existsSync(candidate) && path.extname(candidate)) return candidate;
  }
  throw new Error(`cannot resolve ${specifier} from ${path.relative(root, from)}`);
}

test("the registry's static import graph never reaches server-only (SPEC §13 harness rule 1)", () => {
  const seen = new Set<string>();
  const offenders: string[] = [];
  const statement = /^\s*(import|export)\s+(?!type\s)(?:[\s\S]*?\sfrom\s+)?["']([^"']+)["'];?/gm;
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const match of readFileSync(file, "utf8").matchAll(statement)) {
      if (match[1] === "export" && !/\sfrom\s/.test(match[0])) continue;
      if (match[2] === "server-only") {
        offenders.push(path.relative(root, file));
        continue;
      }
      const next = resolveLocal(file, match[2]);
      if (next) visit(next);
    }
  };
  for (const entry of [
    "src/lib/tools/registry.ts",
    "src/lib/tools/toolset.ts",
    "src/lib/tools/connector-tools.ts",
    "src/lib/tools/audit-args.ts",
  ]) {
    visit(path.join(root, entry));
  }
  assert.deepEqual(offenders, []);
});

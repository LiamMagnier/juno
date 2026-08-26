import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { UnifiedAgentRegistry, detectAutomaticEscalation } from "../src/lib/agent/runtime";

test("UnifiedAgentRegistry exposes only hosted-safe tools and emits valid provider schemas", () => {
  const registry = new UnifiedAgentRegistry();

  assert.equal(registry.getTool("python_interpreter"), undefined);
  assert.ok(registry.getTool("browser_agent"));
  assert.equal(registry.getTool("computer_use"), undefined);

  const schemas = registry.toProviderToolSchemas();
  assert.deepEqual(schemas.map((schema) => schema.function.name), ["browser_agent"]);
});

test("an explicit empty allowlist is treated as no hosted native tools", () => {
  const runtime = readFileSync(new URL("../src/lib/agent/runtime.ts", import.meta.url), "utf8");
  assert.match(runtime, /Array\.isArray\(options\?\.allowedToolIds\)/);
  assert.doesNotMatch(runtime, /allowedToolIds\.length > 0/);
});

test("detectAutomaticEscalation identifies data analysis, research, and work queries", () => {
  const dataQuery = detectAutomaticEscalation("Can you load this CSV and plot a chart using matplotlib?");
  assert.equal(dataQuery.recommendedMode, "data");
  assert.ok(!dataQuery.suggestedTools.includes("python_interpreter"));

  const researchQuery = detectAutomaticEscalation("Conduct deep research comparing all MacBook Pro M-series processors");
  assert.equal(researchQuery.recommendedMode, "research");
  assert.ok(researchQuery.suggestedTools.includes("browser_agent"));

  const workQuery = detectAutomaticEscalation("Create a plan and generate deliverable presentation slides for the roadmap");
  assert.equal(workQuery.recommendedMode, "work");
  assert.ok(workQuery.suggestedTools.includes("work_plan"));

  const normalQuery = detectAutomaticEscalation("Hello, what is the capital of France?");
  assert.equal(normalQuery.recommendedMode, undefined);
  assert.equal(normalQuery.suggestedTools.length, 0);
});

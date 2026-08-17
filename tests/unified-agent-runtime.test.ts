import { test } from "node:test";
import assert from "node:assert/strict";
import { UnifiedAgentRegistry, detectAutomaticEscalation } from "../src/lib/agent/runtime";

test("UnifiedAgentRegistry registers core tools and emits valid provider schemas", () => {
  const registry = new UnifiedAgentRegistry();
  
  assert.ok(registry.getTool("python_interpreter"));
  assert.ok(registry.getTool("browser_agent"));
  assert.ok(registry.getTool("computer_use"));

  const schemas = registry.toProviderToolSchemas();
  assert.ok(schemas.length >= 3);
  
  const pythonSchema = schemas.find((s) => s.function.name === "python_interpreter");
  assert.ok(pythonSchema);
  assert.equal(pythonSchema?.type, "function");
  assert.ok(pythonSchema?.function.description.includes("Python"));
  const props = pythonSchema?.function.parameters.properties as Record<string, unknown>;
  assert.ok(props && props.code);
});

test("detectAutomaticEscalation identifies data analysis, research, and work queries", () => {
  const dataQuery = detectAutomaticEscalation("Can you load this CSV and plot a chart using matplotlib?");
  assert.equal(dataQuery.recommendedMode, "data");
  assert.ok(dataQuery.suggestedTools.includes("python_interpreter"));

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

import { test } from "node:test";
import assert from "node:assert/strict";
import { executePythonSandbox, pythonTool } from "../src/lib/sandbox/python";

test("executePythonSandbox executes basic python calculations and returns clean stdout", async () => {
  const result = await executePythonSandbox({
    code: `
a = 15
b = 27
print(f"SUM={a + b}")
`,
  });

  assert.equal(result.success, true);
  assert.equal(result.exitCode, 0);
  assert.ok(result.stdout.includes("SUM=42"));
  assert.ok(result.durationMs > 0);
});

test("executePythonSandbox captures syntax or runtime errors without throwing", async () => {
  const result = await executePythonSandbox({
    code: `
def broken():
    raise ValueError("Intentional test error")
broken()
`,
  });

  assert.equal(result.success, false);
  assert.notEqual(result.exitCode, 0);
  assert.ok(result.stderr.includes("ValueError: Intentional test error"));
});

test("legacy python tool is classified sensitive and must stay outside hosted runtime", () => {
  assert.equal(pythonTool.id, "python_interpreter");
  assert.equal(pythonTool.category, "python");
  assert.equal(pythonTool.riskClass, "destructive_or_sensitive");
  assert.ok(pythonTool.parameters.properties.code);
});

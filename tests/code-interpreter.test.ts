import test from "node:test";
import assert from "node:assert/strict";
import {
  LocalIsolatedSandboxAdapter,
  MicroVMSandboxAdapter,
  UnifiedCodeInterpreter,
  type CodeInterpreterOptions,
} from "@/lib/code-interpreter";

test("LocalIsolatedSandboxAdapter executes basic Python calculation", async () => {
  const adapter = new LocalIsolatedSandboxAdapter();
  assert.equal(await adapter.isAvailable(), true);

  const options: CodeInterpreterOptions = {
    code: "print('Hello from Code Interpreter')\nx = 10 * 5\nprint(f'Result: {x}')",
    timeoutMs: 15_000,
  };

  const result = await adapter.execute(options);
  assert.equal(result.success, true);
  assert.equal(result.backend, "local_isolated");
  assert.ok(result.stdout.includes("Hello from Code Interpreter"));
  assert.ok(result.stdout.includes("Result: 50"));
});

test("LocalIsolatedSandboxAdapter captures generated files in workspace", async () => {
  const adapter = new LocalIsolatedSandboxAdapter();
  const options: CodeInterpreterOptions = {
    code: `
with open('output_data.csv', 'w') as f:
    f.write('id,val\\n1,100\\n2,200\\n')
print('wrote file')
`,
    timeoutMs: 15_000,
  };

  const result = await adapter.execute(options);
  assert.equal(result.success, true);
  assert.ok(result.stdout.includes("wrote file"));

  const file = result.generatedFiles.find((f) => f.name === "output_data.csv");
  assert.ok(file, "Expected output_data.csv to be found in generated files");
  assert.equal(file?.mimeType, "text/csv");
  const decodedContent = Buffer.from(file!.dataBase64, "base64").toString("utf8");
  assert.ok(decodedContent.includes("1,100"));
});

test("MicroVMSandboxAdapter reports unavailable when unconfigured", async () => {
  const adapter = new MicroVMSandboxAdapter("http://invalid-runner.internal:9999", "dummy-key");
  const available = await adapter.isAvailable();
  assert.equal(available, false);
});

test("UnifiedCodeInterpreter falls back safely to local sandbox", async () => {
  const interpreter = new UnifiedCodeInterpreter();
  const options: CodeInterpreterOptions = {
    code: "print(1 + 1)",
    preferredBackend: "auto",
    timeoutMs: 10_000,
  };

  const result = await interpreter.execute(options);
  assert.equal(result.success, true);
  assert.ok(result.stdout.includes("2"));
});

test("LocalIsolatedSandboxAdapter does not include input files in generatedFiles list", async () => {
  const adapter = new LocalIsolatedSandboxAdapter();
  const options: CodeInterpreterOptions = {
    code: `
with open('input_file.txt', 'r') as f:
    text = f.read().strip()
with open('generated_file.txt', 'w') as f:
    f.write(text.upper())
print('done')
`,
    inputFiles: [{ name: "input_file.txt", content: "hello world" }],
    timeoutMs: 15_000,
  };

  const result = await adapter.execute(options);
  assert.equal(result.success, true);
  assert.ok(result.stdout.includes("done"));

  const inputAsGen = result.generatedFiles.find((f) => f.name === "input_file.txt");
  assert.equal(inputAsGen, undefined, "Input file must not be reported as generated output");

  const actualGen = result.generatedFiles.find((f) => f.name === "generated_file.txt");
  assert.ok(actualGen, "Generated file should be detected");
});

test("codeInterpreterTool is properly configured with ToolDefinition schema", async () => {
  const { codeInterpreterTool } = await import("@/lib/code-interpreter");
  assert.equal(codeInterpreterTool.name, "code_interpreter");
  assert.equal(codeInterpreterTool.riskClass, "destructive_or_sensitive");
  assert.ok(codeInterpreterTool.description.includes("Python"));
  assert.equal(typeof codeInterpreterTool.execute, "function");

  const preview = codeInterpreterTool.formatPreview?.({ code: "print(1)", reason: "testing math" });
  assert.equal(preview?.detail, "testing math");
});


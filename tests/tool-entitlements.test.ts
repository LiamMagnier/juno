import test from "node:test";
import assert from "node:assert/strict";
import { codeExecutionNote, composeSystemPrompt } from "@/lib/chat/prompt-sections";
import { EXECUTION_ENTITLEMENT_ROWS, executionEntitlements, type ExecutionEntitlementInput } from "@/lib/tools/entitlements";
import { openGrantedProviders, providerAvailability, toolProviders } from "@/lib/tools/providers";
import { defineTool, type ToolProvider, type ToolTurn } from "@/lib/tools/types";

/*
 * V6/V7 (TOOL_RUNTIME_DESIGN §6.9, §6.11): the execution and skill tools ride
 * one table of rows keyed to the providers that serve them, and a model whose
 * tool calling is not VERIFIED gets the plain-language note and no execution
 * tool, whatever else is true.
 */

const allowed: ExecutionEntitlementInput = {
  plan: "PRO",
  private: false,
  lockdown: false,
  artifactEdit: false,
  workspaceRestrictsTools: false,
  toolsReachModel: true,
  modelVerdict: "verified",
  providers: { exec: { available: true }, skills: { available: true } },
};

test("the rows name run_code and check_run for exec, use_skill and read_skill_file for skills", () => {
  assert.deepEqual(
    EXECUTION_ENTITLEMENT_ROWS.map((row) => [row.tool, row.provider, row.paidOnly]),
    [
      ["run_code", "exec", true],
      ["check_run", "exec", true],
      ["use_skill", "skills", false],
      ["read_skill_file", "skills", false],
    ],
  );
});

test("a verified model on a paid, saved, unrestricted turn gets every row its providers serve", () => {
  const result = executionEntitlements(allowed);
  assert.deepEqual(result.granted, { exec: ["run_code", "check_run"], skills: ["use_skill", "read_skill_file"] });
  assert.equal(result.codeExecution, "available");
  assert.deepEqual(result.withheld, []);
});

test("an untested or failed model gets NO execution or skill tool, and the limitation note", () => {
  for (const modelVerdict of ["untested", "failed"] as const) {
    const result = executionEntitlements({ ...allowed, modelVerdict, legacySandboxConfigured: true });
    assert.deepEqual(result.granted, { exec: [], skills: [] }, modelVerdict);
    assert.equal(result.legacyCodeInterpreter, false, "the old code tool is gated the same way");
    assert.equal(result.codeExecution, "unverified_model");
    assert.ok(result.withheld.every((entry) => entry.reason === "model_unverified"));
  }
});

test("each turn condition withholds the rows it governs", () => {
  const cases: Array<[Partial<ExecutionEntitlementInput>, string, string[]]> = [
    [{ private: true }, "private", []],
    [{ lockdown: true }, "lockdown", []],
    [{ artifactEdit: true }, "artifact_edit", []],
    [{ toolsReachModel: false }, "tools_cannot_reach_model", []],
    // Paid-only and workspace-gated rows only: the skill rows survive.
    [{ plan: "FREE" }, "plan", ["use_skill", "read_skill_file"]],
    [{ workspaceRestrictsTools: true }, "workspace", ["use_skill", "read_skill_file"]],
  ];
  for (const [change, reason, survivors] of cases) {
    const result = executionEntitlements({ ...allowed, ...change });
    assert.deepEqual([...result.granted.exec, ...result.granted.skills], survivors, reason);
    assert.ok(result.withheld.some((entry) => entry.reason === reason), reason);
  }
});

test("a provider that is missing or unavailable grants nothing; the note says code cannot run", () => {
  const none = executionEntitlements({ ...allowed, providers: {} });
  assert.deepEqual(none.granted, { exec: [], skills: [] });
  assert.equal(none.codeExecution, "unavailable");
  const down = executionEntitlements({ ...allowed, providers: { exec: { available: false, reason: "network_not_isolated" }, skills: { available: true } } });
  assert.deepEqual(down.granted, { exec: [], skills: ["use_skill", "read_skill_file"] });
  assert.equal(down.codeExecution, "unavailable");
  // Private and canvas-edit turns say nothing at all.
  assert.equal(executionEntitlements({ ...allowed, private: true }).codeExecution, "off");
  assert.equal(executionEntitlements({ ...allowed, artifactEdit: true }).codeExecution, "off");
});

test("the limitation note says plainly that code cannot run, and names verified models", () => {
  const note = codeExecutionNote("unverified_model", ["Claude Sonnet 5", "Gemini 3.8 Flash"]);
  assert.match(note!, /not been verified for this model/);
  assert.match(note!, /switching to Claude Sonnet 5 or Gemini 3.8 Flash will let it run/);
  assert.match(note!, /never present output, numbers or files as if code had run/);
  assert.doesNotMatch(codeExecutionNote("unverified_model", [])!, /switching to/);
  assert.match(codeExecutionNote("unavailable")!, /you cannot run code in this chat/);
  assert.equal(codeExecutionNote("available"), null);
  assert.equal(codeExecutionNote("off"), null);
  const prompt = composeSystemPrompt({ base: "BASE", webSearch: false, canvasOn: false, executionSections: [note!] });
  assert.equal(prompt, `BASE\n\n${note}`);
});

const turn: ToolTurn = {
  userId: "u1",
  surface: "chat",
  sessionId: "gen-1",
  conversationId: "c1",
  projectId: null,
  plan: "PRO",
  modelId: "claude-sonnet-5",
  vision: true,
  skillSlug: null,
};

const spec = (id: string) =>
  defineTool({
    id,
    title: id,
    description: id,
    input: { type: "object", properties: {} },
    risk: "read",
    parallelSafe: false,
    timeoutMs: 1_000,
    broker: "juno_runtime",
    dedupe: false,
    execute: async () => ({ status: "succeeded", text: "", body: "" }),
  });

test("providers are asked once, failures read as unavailable, and only granted specs are kept", async () => {
  assert.deepEqual(toolProviders(), [], "no provider is installed until the execution and skill lanes land");
  let closed = 0;
  const exec: ToolProvider = {
    id: "exec",
    tools: ["run_code", "check_run"],
    availability: async () => ({ available: true }),
    // A provider that offers more than it was granted is cut back to the grant.
    open: async () => ({ specs: [spec("run_code"), spec("check_run")], promptSection: "Sandbox: python 3.12.", close: async () => void closed++ }),
  };
  const skills: ToolProvider = {
    id: "skills",
    tools: ["use_skill", "read_skill_file"],
    availability: async () => {
      throw new Error("db down");
    },
    open: async () => {
      throw new Error("never opened");
    },
  };
  assert.deepEqual(await providerAvailability([exec, skills], turn), {
    exec: { available: true },
    skills: { available: false, reason: "unhealthy" },
  });
  const opened = await openGrantedProviders([exec, skills], turn, { exec: ["run_code"], skills: [] });
  assert.deepEqual(opened.specs.map((s) => s.id), ["run_code"]);
  assert.deepEqual(opened.promptSections, ["Sandbox: python 3.12."]);
  await opened.close();
  assert.equal(closed, 1);
});

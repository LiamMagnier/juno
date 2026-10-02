import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ACTION_PERMISSION_POLICIES,
  DEFAULT_ACTION_PERMISSION_POLICY,
  classifyExternalAction,
  decideActionPolicy,
} from "@/lib/action-approval";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// The attachment readers classified as "unknown", which asks under every
// policy; the runtime passed no card callback, so every saved-chat call to
// them waited unseen until the 120 s stall watchdog ended the turn.
for (const toolName of ["read_document", "inspect_image"]) {
  test(`${toolName} is a read the default policy allows without asking`, () => {
    const classification = classifyExternalAction({
      connectorId: "juno_runtime",
      toolName,
      args: { attachment: "report.pdf", query: "revenue" },
    });
    assert.equal(classification.riskClass, "read_only");
    assert.equal(
      decideActionPolicy({ policy: DEFAULT_ACTION_PERMISSION_POLICY, riskClass: classification.riskClass }),
      "allow",
    );
    // A person who chose to be asked about everything, or who locked tools
    // down, still is.
    assert.equal(decideActionPolicy({ policy: "always_ask", riskClass: "read_only" }), "ask");
    assert.equal(decideActionPolicy({ policy: "block", riskClass: "read_only" }), "block");
    assert.equal(
      decideActionPolicy({ policy: DEFAULT_ACTION_PERMISSION_POLICY, riskClass: "read_only", lockdown: true }),
      "block",
    );
  });
}

test("the page reader still asks under every policy but block", () => {
  const { riskClass } = classifyExternalAction({ connectorId: "juno_runtime", toolName: "browser_agent", args: {} });
  for (const policy of ACTION_PERMISSION_POLICIES) {
    if (policy === "block") continue;
    assert.equal(decideActionPolicy({ policy, riskClass }), "ask", `browser_agent under ${policy}`);
  }
});

// Hosted code execution is a read (chat-rework DECISIONS §4b, TOOL_RUNTIME_DESIGN
// §6.9): a fresh container on the execution host with no network, no
// credentials and only this conversation's files. It used to classify as
// "unknown" and ask on every run. A person who asks about everything, or who
// blocks tools or turns lockdown on, still gets that.
test("run_code, check_run and the code_interpreter alias are reads the default policy allows", () => {
  for (const toolName of ["run_code", "check_run", "code_interpreter"]) {
    const { riskClass } = classifyExternalAction({ connectorId: "juno_runtime", toolName, args: { code: "print(1)" } });
    assert.equal(riskClass, "read_only", toolName);
    assert.equal(decideActionPolicy({ policy: DEFAULT_ACTION_PERMISSION_POLICY, riskClass }), "allow", toolName);
    assert.equal(decideActionPolicy({ policy: "always_ask", riskClass }), "ask", toolName);
    assert.equal(decideActionPolicy({ policy: "block", riskClass }), "block", toolName);
    assert.equal(decideActionPolicy({ policy: DEFAULT_ACTION_PERMISSION_POLICY, riskClass, lockdown: true }), "block", toolName);
  }
});

test("a runtime call the broker asks about can show its card", () => {
  // The route's callback sends the approval frame and pauses the watchdog.
  // The dispatcher's per-call callback is composed with it, never instead of it.
  assert.match(
    source("src/lib/agent/runtime.ts"),
    /onApprovalRequest: composeApprovalCallbacks\(context\.onApprovalRequest, call\.onApprovalRequest\),\n\s+provenance:/,
  );
});

test("Gemini hands the model the enveloped tool text, like every other adapter", () => {
  const gemini = source("src/lib/gemini.ts");
  // The dispatcher's model-facing `text` (envelope included), never the panel body.
  assert.match(gemini, /const text = withheldImagesNote\(result\.text,/);
  assert.match(gemini, /response: result\.isError \? \{ error: text \} : \{ result: text \}/);
  assert.doesNotMatch(gemini, /withheldImagesNote\(\w+\.body/);
});

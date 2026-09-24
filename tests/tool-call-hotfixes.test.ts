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

test("the page reader and code tool still ask under every policy but block", () => {
  for (const toolName of ["browser_agent", "code_interpreter"]) {
    const { riskClass } = classifyExternalAction({ connectorId: "juno_runtime", toolName, args: {} });
    for (const policy of ACTION_PERMISSION_POLICIES) {
      if (policy === "block") continue;
      assert.equal(decideActionPolicy({ policy, riskClass }), "ask", `${toolName} under ${policy}`);
    }
  }
});

test("a runtime call the broker asks about can show its card", () => {
  // The route's callback sends the approval frame and pauses the watchdog.
  assert.match(source("src/lib/agent/runtime.ts"), /onApprovalRequest: context\.onApprovalRequest,\n\s+provenance:/);
});

test("Gemini hands the model the enveloped tool text, like every other adapter", () => {
  const gemini = source("src/lib/gemini.ts");
  assert.match(gemini, /response: \{ result: withheldImagesNote\(exec\.text,/);
  assert.doesNotMatch(gemini, /withheldImagesNote\(exec\.body/);
});

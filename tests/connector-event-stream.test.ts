import test from "node:test";
import assert from "node:assert/strict";
import { withConnectorEventStream } from "@/lib/first-party-connectors/trigger-stream";
test("choosing a channel preserves the resource filter and the previous draft", () => {
  const draft = { resourceId: "mail1", stream: "COLD" };
  assert.deepEqual(withConnectorEventStream(draft, " CNEW "), { resourceId: "mail1", stream: "CNEW" });
  assert.equal(draft.stream, "COLD");
});
test("clearing an optional calendar stream removes only that attribute", () => {
  assert.deepEqual(withConnectorEventStream({ resourceId: "meeting", stream: "other" }, "  "), { resourceId: "meeting" });
});
test("malformed stored attributes do not become numeric or object filters", () => {
  assert.deepEqual(withConnectorEventStream(["bad"], "C123"), { stream: "C123" });
  assert.deepEqual(withConnectorEventStream({ resourceId: {}, stream: 123 }, ""), {});
});

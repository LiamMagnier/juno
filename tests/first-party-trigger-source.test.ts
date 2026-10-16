import test from "node:test";
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { normalizeTriggerDrafts, triggerSupport, parseTriggerConfig } from "@/lib/work/triggers";
import { FIRST_PARTY_IDS } from "@/lib/first-party-connectors/providers";

for (const provider of FIRST_PARTY_IDS) test(`${provider}: a real first-party event source is accepted`, () => {
  const attributes = provider === "slack" ? { stream: "C123456" } : {};
  const config = { connector: provider, events: [], attributes };
  assert.deepEqual(triggerSupport("connector_event", config), { servable: true, connectorId: provider });
  const normalized = normalizeTriggerDrafts([{ kind: "connector_event", config }], "Europe/Paris");
  assert.equal(normalized.ok, true);
});
test("unsupported apps, malformed configs, missing Slack channels and bad streams remain refused", () => {
  for (const config of [{ connector: "linear" }, { connector: "github" }, { connector: "user_mcp:fake" }, {}, { connector: "slack" }, { connector: "slack", attributes: { stream: "../../private" } }, { connector: "gmail", attributes: { stream: " " } }]) assert.equal(triggerSupport("connector_event", config).servable, false);
});
test("event names must have a real producer for the selected app", () => {
  assert.equal(triggerSupport("connector_event", { connector: "gmail", events: ["message_received"] }).servable, true);
  assert.equal(triggerSupport("connector_event", { connector: "google-drive", events: ["file_changed"] }).servable, true);
  assert.equal(triggerSupport("connector_event", { connector: "google-drive", events: ["message_received"] }).servable, false);
  assert.equal(triggerSupport("connector_event", { connector: "slack", events: ["issue.created"], attributes: { stream: "C123" } }).servable, false);
});
test("unsupported event attributes are refused instead of silently matching nothing", () => {
  assert.equal(triggerSupport("connector_event", { connector: "gmail", attributes: { team: "core" } }).servable, false);
  assert.equal(triggerSupport("connector_event", { connector: "gmail", attributes: { resourceId: "message1" } }).servable, true);
});

const calls: unknown[][] = [];
let fixture = { events: [] as unknown[], cursorSource: "connector:gmail:primary", cursorPosition: "10", establishing: true };
const modules = Module as unknown as { _load: (name: string, parent: unknown, main: boolean) => unknown };
const original = modules._load;
modules._load = function (name, parent, main) {
  if (name === "server-only") return {};
  if (name === "@/lib/first-party-connectors/sync-store") return { readConnectorTriggerEvents: async (...args: unknown[]) => { calls.push(args); return fixture; } };
  return original.call(this, name, parent, main);
};
const req = createRequire(import.meta.url);
const { readTriggerSource } = req("../scripts/work-trigger-poller") as typeof import("../scripts/work-trigger-poller");
modules._load = original;

test("the actual poller delegates first-party reads with the owner's persisted cursor", async () => {
  const parsed = parseTriggerConfig("connector_event", { connector: "gmail" });
  assert.ok(parsed.ok);
  const result = await readTriggerSource("owner", parsed.parsed, { "connector:gmail:primary": "9" }, new Date());
  assert.deepEqual(calls.at(-1), ["owner", "gmail", "9", "primary"]);
  assert.deepEqual(result, fixture);
  assert.equal(result.events.length, 0, "baseline does not synthesize an hourly event");
});
test("a Slack channel stream keeps its own cursor, separate from event names", async () => {
  const parsed = parseTriggerConfig("connector_event", { connector: "slack", events: ["message_received"], attributes: { stream: "C123456" } });
  assert.ok(parsed.ok);
  fixture = { events: [], cursorSource: "connector:slack:C123456", cursorPosition: "25", establishing: false };
  await readTriggerSource("owner", parsed.parsed, { "connector:slack:C123456": "24" }, new Date());
  assert.deepEqual(calls.at(-1), ["owner", "slack", "24", "C123456"]);
});

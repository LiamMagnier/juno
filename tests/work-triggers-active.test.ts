import test from "node:test";
import assert from "node:assert/strict";
import {
  parseTriggerConfig,
  evaluateTrigger,
  type TriggerState,
  type TopicTriggerEvent,
  type ConnectorTriggerEvent,
  type FolderTriggerEvent,
} from "../src/lib/work/triggers.js";

test("topic_monitor parses and evaluates multi-term matches", () => {
  const parse = parseTriggerConfig("topic_monitor", {
    terms: ["autonomous agents", "security"],
    minSources: 2,
  });
  assert.equal(parse.ok, true);

  const now = new Date();
  const trigger: TriggerState = {
    id: "trg-topic",
    kind: "topic_monitor",
    config: { terms: ["autonomous agents", "security"], minSources: 2 },
    enabled: true,
    lastEventKey: null,
    lastFiredAt: null,
    dedupeWindowSec: 3600,
  };

  const matchingEvent: TopicTriggerEvent = {
    kind: "topic_monitor",
    eventKey: "topic-match-1",
    occurredAt: now,
    matchedTerms: ["autonomous agents"],
    sourceCount: 3,
  };

  const verdict = evaluateTrigger({
    trigger,
    event: matchingEvent,
    now,
    hosts: [],
    recentEventKeys: [],
  });

  assert.equal(verdict.fire, true);
  if (verdict.fire) {
    assert.equal(verdict.eventKey, "topic-match-1");
  }
});

test("connector_event parses and matches connector event attributes", () => {
  const parse = parseTriggerConfig("connector_event", {
    connector: "linear",
    event: "issue.created",
    attributes: { team: "core" },
  });
  assert.equal(parse.ok, true);

  const now = new Date();
  const trigger: TriggerState = {
    id: "trg-conn",
    kind: "connector_event",
    config: { connector: "linear", event: "issue.created", attributes: { team: "core" } },
    enabled: true,
    lastEventKey: null,
    lastFiredAt: null,
    dedupeWindowSec: 3600,
  };

  const event: ConnectorTriggerEvent = {
    kind: "connector_event",
    eventKey: "linear-issue-42",
    occurredAt: now,
    connector: "linear",
    event: "issue.created",
    attributes: { team: "core" },
  };

  const verdict = evaluateTrigger({
    trigger,
    event,
    now,
    hosts: [],
    recentEventKeys: [],
  });

  assert.equal(verdict.fire, true);
});

test("folder_change trigger parses grantId and matches folder event", () => {
  const parse = parseTriggerConfig("folder_change", {
    grantId: "grant-reports",
  });
  assert.equal(parse.ok, true);

  const now = new Date();
  const trigger: TriggerState = {
    id: "trg-folder",
    kind: "folder_change",
    config: { grantId: "grant-reports" },
    enabled: true,
    lastEventKey: null,
    lastFiredAt: null,
    dedupeWindowSec: 3600,
  };

  const hostView = {
    hostId: "host-macbook",
    displayName: "Liam's MacBook",
    state: "idle",
    enabled: true,
    revoked: false,
    capabilities: ["local_files"],
  };

  const event: FolderTriggerEvent = {
    kind: "folder_change",
    eventKey: "grant-reports:1700000000",
    occurredAt: now,
    grantId: "grant-reports",
    hostId: "host-macbook",
    changedNames: ["annual_report.pdf"],
  };

  const verdict = evaluateTrigger({
    trigger,
    event,
    now,
    hosts: [hostView],
    recentEventKeys: [],
  });

  assert.equal(verdict.fire, true);
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import Ajv from "ajv";

import {
  CODE_MODEL_ALIASES,
  RUNTIME_MODE_VALUES,
  RUNTIME_MODE_VENDOR_MAP,
  TURN_ITEM_KIND_VALUES,
  classifyEvent,
  estimateTierCostUsd,
  isTurnItem,
  pickContextTier,
  resolveModelAlias,
  type ContextTier,
  type ServerEventEnvelope,
  type TurnItem,
} from "@/lib/code-v2/contracts";
import { MODELS } from "@/lib/models";

const root = process.cwd();
const schema = JSON.parse(readFileSync(join(root, "contracts/code/alevr-code-v2.schema.json"), "utf8"));
const fixture = (name: string) => JSON.parse(readFileSync(join(root, "contracts/code/fixtures", name), "utf8"));

const ajv = new Ajv({ allErrors: true });
ajv.addSchema(schema, "code-v2");
const validator = (def: string) => {
  const v = ajv.getSchema(`code-v2#/definitions/${def}`);
  assert.ok(v, def);
  return v;
};

test("the contract check script passes (runner copy, schema, fixtures, Swift mirror)", () => {
  const out = execFileSync(process.execPath, ["scripts/check-code-v2-contracts.mjs"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.match(out, /in sync/);
});

test("the schema rejects malformed items and commands", () => {
  const item = validator("TurnItem");
  assert.equal(item({ id: "a", kind: "assistant_message", createdAt: "2026-10-08T00:00:00Z", text: "hi" }), false, "missing streaming");
  assert.equal(item({ id: "a", kind: "subagent", createdAt: "2026-10-08T00:00:00Z", agentId: "x", role: "boss", model: { instanceId: "alevr", model: "m" }, status: "running" }), false);
  assert.equal(item({ id: "a", kind: "assistant_message", createdAt: "2026-10-08T00:00:00Z", text: "hi", streaming: true }), true);
  const command = validator("ClientCommand");
  assert.equal(command({ id: "1", type: "turn.steer", params: { sessionId: "s" } }), false, "steer needs turnId and input");
  assert.equal(command({ id: "1", type: "turn.launch", params: {} }), false);
  const instance = validator("ProviderInstance");
  assert.equal(instance({ id: "x", kind: "claude-agent", label: "Claude", status: "active" }), false, "status pills are not a status");
});

test("every turn-item fixture is a TurnItem this build understands", () => {
  const items: unknown[] = fixture("turn-items.json").cases;
  assert.ok(items.every(isTurnItem));
  const kinds = new Set((items as TurnItem[]).map((i) => i.kind));
  assert.deepEqual([...kinds].sort(), [...TURN_ITEM_KIND_VALUES].sort());
  assert.equal(isTurnItem({ id: "x", kind: "hologram", createdAt: "2026-10-08T00:00:00Z" }), false);
});

test("snapshot + cursor: fixtures apply in order; duplicates and gaps are detected", () => {
  const envelopes = (fixture("server-messages.json").cases as { type: string }[]).filter(
    (m): m is ServerEventEnvelope => m.type === "event",
  );
  let cursor: number | null = null;
  for (const e of envelopes.filter((e) => e.stream === "session")) {
    assert.equal(classifyEvent(cursor, e), "apply", `sequence ${e.sequence}`);
    cursor = e.sequence;
  }
  assert.equal(cursor, 50);
  const delta = { sequence: 48, event: { type: "item.delta", itemId: "i", field: "text", append: "x" } } as const;
  assert.equal(classifyEvent(48, delta), "duplicate");
  assert.equal(classifyEvent(48, { ...delta, sequence: 50 }), "gap");
  assert.equal(classifyEvent(null, delta), "gap");
});

test("snapshot + cursor: a snapshot older than the cursor never applies", () => {
  const snapshot = (n: number) =>
    ({ sequence: n, event: { type: "session.snapshot", snapshotSequence: n, session: {} as never } }) as const;
  assert.equal(classifyEvent(null, snapshot(3)), "apply");
  assert.equal(classifyEvent(10, snapshot(10)), "apply");
  assert.equal(classifyEvent(10, snapshot(12)), "apply");
  assert.equal(classifyEvent(10, snapshot(9)), "duplicate");
  assert.equal(classifyEvent(10, snapshot(0)), "duplicate");
});

test("model aliases point at models that exist and are current", () => {
  assert.deepEqual(fixture("model-aliases.json").aliases, CODE_MODEL_ALIASES);
  for (const [alias, id] of Object.entries(CODE_MODEL_ALIASES)) {
    const info = MODELS[id];
    assert.ok(info, `${alias} → ${id} is not in src/lib/models.ts`);
    // Served and not retiring. "haiku" still names Haiku 4.5, which Anthropic
    // moved to legacy when Haiku 5.5 shipped (2026-10-07); repointing the
    // alias is the Code product's call, because its Mac thinking wire
    // (CodeThinkingWire) still treats every Haiku as budget_tokens and Haiku
    // 5.5 rejects that with a 400.
    assert.ok(info.status === "current" || (info.status === "legacy" && !info.retiresOn), `${alias} → ${id} is ${info.status}`);
  }
  assert.equal(resolveModelAlias(" Sonnet "), "anthropic:claude-sonnet-5-5");
  assert.equal(resolveModelAlias("max"), "anthropic:claude-opus-5-5");
  assert.equal(resolveModelAlias("qwen:qwen3.8-max"), "qwen:qwen3.8-max");
});

test("every runtime mode maps onto both vendor runtimes", () => {
  for (const mode of RUNTIME_MODE_VALUES) assert.ok(RUNTIME_MODE_VENDOR_MAP[mode], mode);
  assert.equal(RUNTIME_MODE_VENDOR_MAP.full.codex.sandbox, "dangerFullAccess");
  assert.equal(RUNTIME_MODE_VENDOR_MAP["auto-edit"].claudePermissionMode, "acceptEdits");
});

test("context tiers: pick the smallest tier that fits and price it", () => {
  const tiers: ContextTier[] = [
    { tokens: 1_050_000, label: "1M", inputPerMTok: 4, outputPerMTok: 10, cachedInputPerMTok: 0.2 },
    { tokens: 272_000, label: "272K", inputPerMTok: 2, outputPerMTok: 10, cachedInputPerMTok: 0.1 },
  ];
  assert.equal(pickContextTier(tiers)?.label, "1M", "absent → default (first) tier");
  assert.equal(pickContextTier(tiers, 200_000)?.label, "272K");
  assert.equal(pickContextTier(tiers, 500_000)?.label, "1M");
  assert.equal(pickContextTier(tiers, 2_000_000), undefined);
  assert.equal(pickContextTier([], 1), undefined);
  const cost = estimateTierCostUsd(tiers[1], { input: 1_000_000, cachedInput: 500_000, output: 100_000 });
  assert.equal(Number(cost.toFixed(4)), 2.05); // 0.5M×2 + 0.5M×0.1 + 0.1M×10
});

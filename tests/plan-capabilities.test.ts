import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PLANS } from "@/lib/plans";
import { capabilitiesLost, capabilityChanges, planCapabilities, usageLabel } from "@/lib/billing/plan-capabilities";

test("usageVsPro is each plan's budget over Pro's, as spend.ts meters it", () => {
  const spend = readFileSync("src/lib/spend.ts", "utf8");
  const table = /const BUDGET_EUR: Record<Plan, number \| null> = \{([\s\S]*?)\};/.exec(spend)![1];
  const budget = Object.fromEntries([...table.matchAll(/(\w+): ([\d.]+|null)/g)].map((m) => [m[1], m[2] === "null" ? null : Number(m[2])]));
  for (const plan of Object.keys(PLANS) as (keyof typeof PLANS)[]) {
    const expected = budget[plan] == null ? null : budget[plan]! / budget.PRO!;
    const declared = PLANS[plan].usageVsPro;
    if (expected == null) assert.equal(declared, null, plan);
    else assert.ok(Math.abs(declared! - expected) / expected < 0.15, `${plan}: ${declared} vs ${expected}`);
  }
});

test("each row restates a flag the plan really has", () => {
  const free = planCapabilities("FREE").map((r) => r.id);
  assert.ok(!free.includes("code") && !free.includes("agents") && !free.includes("research") && !free.includes("voice") && !free.includes("search"));
  const lite = planCapabilities("LITE").map((r) => r.id);
  assert.ok(lite.includes("search") && !lite.includes("code"));
  const pro = planCapabilities("PRO").map((r) => r.id);
  for (const id of ["code", "agents", "research", "voice", "search"]) assert.ok(pro.includes(id), id);
  assert.ok(!pro.includes("priority"));
  assert.ok(planCapabilities("MAX").some((r) => r.id === "priority" && /Highest/.test(r.label)));
});

test("an upgrade marks what is new or stronger; a downgrade lists what it gives up", () => {
  const gains = capabilityChanges("FREE", "PRO").filter((r) => r.gained).map((r) => r.id);
  for (const id of ["models", "usage", "code", "agents", "research", "voice"]) assert.ok(gains.includes(id), id);
  assert.ok(!gains.includes("memory"));
  const toMax = capabilityChanges("PRO", "MAX").filter((r) => r.gained).map((r) => r.id);
  assert.deepEqual(toMax.sort(), ["priority", "uploads", "usage"].sort());
  assert.ok(capabilitiesLost("PRO", "FREE").some((r) => r.id === "code"));
  assert.match(usageLabel("MAX"), /^5× Pro usage/);
  assert.match(usageLabel("LITE"), /half/);
});

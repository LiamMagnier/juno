/**
 * The scripted Work model's switch (src/lib/dev/scripted-work-model.ts;
 * docs/design/agents-v2/COMPUTERS_2026-10.md §S1.7): tests and local demos
 * only, never in production, only for listed accounts, only when opted in.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
  SCRIPTED_MODEL_EXPLANATION,
  resetScriptedWorkModelLogForTest,
  scriptedWorkModelFor,
  scriptedWorkModelSwitchedOn,
} from "@/lib/dev/scripted-work-model";

const dir = mkdtempSync(path.join(tmpdir(), "scripted-work-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const scriptPath = path.join(dir, "script.json");
writeFileSync(scriptPath, JSON.stringify({ version: 1, vision: true, steps: [{ say: "hi", end: true }] }));

const ON = {
  NODE_ENV: "development",
  JUNO_ALLOW_SCRIPTED_WORK: "1",
  WORK_SCRIPTED_MODEL_FILE: scriptPath,
  WORK_SCRIPTED_MODEL_USERS: "user_demo, Demo@Example.com",
} as NodeJS.ProcessEnv;
const listed = { id: "user_demo", email: null };

describe("the scripted Work model", () => {
  it("refused when NODE_ENV is production", () => {
    resetScriptedWorkModelLogForTest();
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
    try {
      const prod = { ...ON, NODE_ENV: "production" } as NodeJS.ProcessEnv;
      assert.equal(scriptedWorkModelFor(listed, prod), null);
      assert.equal(scriptedWorkModelFor(listed, prod), null);
      assert.equal(scriptedWorkModelSwitchedOn(prod), false);
    } finally {
      console.warn = original;
    }
    assert.equal(warnings.length, 1, "logged once");
    assert.match(warnings[0]!, /work\.scripted_model_refused/);
    assert.doesNotMatch(warnings[0]!, new RegExp(scriptPath.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")), "never the path");
  });

  it("applies only to listed accounts", () => {
    assert.deepEqual(scriptedWorkModelFor(listed, ON), { scriptPath, vision: true });
    assert.deepEqual(scriptedWorkModelFor({ id: "other", email: "demo@example.com" }, ON), { scriptPath, vision: true }, "emails case-insensitively");
    assert.equal(scriptedWorkModelFor({ id: "other", email: "someone@example.com" }, ON), null);
    assert.equal(scriptedWorkModelFor({ id: "USER_DEMO", email: null }, ON), null, "ids exactly");
    assert.equal(scriptedWorkModelFor(listed, { ...ON, WORK_SCRIPTED_MODEL_USERS: "" } as NodeJS.ProcessEnv), null, "nobody listed, nobody");
  });

  it("needs the opt-in variable", () => {
    for (const value of [undefined, "", "0", "true", "yes"]) {
      const env = { ...ON, JUNO_ALLOW_SCRIPTED_WORK: value } as NodeJS.ProcessEnv;
      assert.equal(scriptedWorkModelFor(listed, env), null, String(value));
    }
  });

  it("needs a readable script", () => {
    assert.equal(scriptedWorkModelFor(listed, { ...ON, WORK_SCRIPTED_MODEL_FILE: "" } as NodeJS.ProcessEnv), null);
    assert.equal(scriptedWorkModelFor(listed, { ...ON, WORK_SCRIPTED_MODEL_FILE: path.join(dir, "missing.json") } as NodeJS.ProcessEnv), null);
    const bad = path.join(dir, "bad.json");
    writeFileSync(bad, "{ not json");
    assert.equal(scriptedWorkModelFor(listed, { ...ON, WORK_SCRIPTED_MODEL_FILE: bad } as NodeJS.ProcessEnv), null);
  });

  it("is never a model anyone can pick, and the run says no model was called", () => {
    const catalog = readFileSync(path.join(__dirname, "../src/lib/models.ts"), "utf8");
    assert.doesNotMatch(catalog, /scripted/i, "not in the model catalog");
    const runner = readFileSync(path.join(__dirname, "../scripts/work-runner.ts"), "utf8");
    assert.match(runner, /kind: "model_substituted", subject: "scripted", explanation: SCRIPTED_MODEL_EXPLANATION/);
    assert.equal(SCRIPTED_MODEL_EXPLANATION, "Development run: a scripted test model drove this task. No AI model was called.");
    const dispatch = readFileSync(path.join(__dirname, "../src/lib/work/dispatch.ts"), "utf8");
    assert.match(dispatch, /model = scriptedWorkModelFor\(user\)\s*\? scriptedRunModel\(requestedModel\)/);
  });
});

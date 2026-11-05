/**
 * Records a gate measurement from inside a Playwright test (spec §9).
 *
 *   const samples = await sampleRuns(20, async () => measureMarks(page, "alevr:enter", "alevr:bubble-painted"));
 *   await recordGate(testInfo, "chat.enter-bubble", { samples });
 *
 * The result is written to the report directory (ALEVR_QA_REPORT_DIR, which
 * the runner sets, else the test's output folder), attached to the test, and
 * annotated. If a package enforces the gate (its e2e/wave2/<pkg>/gates.ts lists
 * the id) a failing result fails the test; otherwise it is a warning and the
 * test passes.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type TestInfo } from "@playwright/test";
import { gateById, type GateId } from "./budgets";
import { evaluateMeasurement, gateMode, loadGateConfig, type GateConfig, type GateMeasurement, type GateResult } from "./gates";

let cached: GateConfig | null = null;

/** The registry, loaded once per worker. */
export function gateConfig(): GateConfig {
  if (!cached) cached = loadGateConfig();
  return cached;
}

export function reportDir(testInfo: TestInfo): string {
  return process.env.ALEVR_QA_REPORT_DIR || testInfo.outputPath("design-gates");
}

function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "result";
}

export async function recordGate(testInfo: TestInfo, id: GateId, measurement: GateMeasurement): Promise<GateResult> {
  const gate = gateById(id);
  if (!gate) throw new Error(`Unknown gate "${id}".`);
  const config = gateConfig();
  if (config.errors.length) throw new Error(`The gate registry is misconfigured:\n${config.errors.join("\n")}`);

  const result = evaluateMeasurement(gate, {
    ...measurement,
    context: { project: testInfo.project.name, test: testInfo.titlePath.slice(1).join(" › "), ...measurement.context },
  });
  const mode = gateMode(config, id);

  const dir = path.join(reportDir(testInfo), slug(id));
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${slug(`${testInfo.project.name}-${testInfo.titlePath.slice(1).join("-")}`)}-${testInfo.repeatEachIndex}-${testInfo.retry}.json`);
  const body = `${JSON.stringify({ ...result, mode }, null, 2)}\n`;
  writeFileSync(file, body);
  await testInfo.attach(`gate-${id}.json`, { body, contentType: "application/json" });

  const verdict = result.pass ? "pass" : mode === "enforce" ? "fail" : "warn";
  testInfo.annotations.push({ type: `gate-${verdict}`, description: `${id}: ${result.detail}` });
  if (!result.pass && mode === "report") {
    console.warn(`[gate] warn ${id} (report-only): ${result.detail}`);
  }
  if (mode === "enforce") {
    expect(result.pass, `${id} is enforced by ${config.enforcedBy.get(id)?.join(", ")}: ${result.detail}`).toBe(true);
  }
  return result;
}

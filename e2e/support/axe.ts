/**
 * axe-core wrapper (spec §9 "axe-core: 0 serious or critical", P0 (4)).
 *
 * Injects the axe-core build that is already in node_modules (it arrives with
 * the lint toolchain; no dependency is added) and runs it on the page. Only
 * serious and critical violations count toward the gate; the rest are
 * returned for the report.
 *
 * The app's Content-Security-Policy blocks injected scripts, so specs that
 * call runAxe use `test.use({ bypassCSP: true })`. axe's findings do not
 * depend on CSP; runAxe says so plainly if injection was blocked.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { Page } from "@playwright/test";

export type AxeImpact = "minor" | "moderate" | "serious" | "critical";

export interface AxeViolation {
  id: string;
  impact: AxeImpact | null;
  help: string;
  helpUrl: string;
  nodes: { target: string[]; html: string; failureSummary?: string }[];
}

export interface AxeReport {
  url: string;
  violations: AxeViolation[];
  /** Serious and critical only: what the gate counts. */
  blocking: AxeViolation[];
  /** How many elements the blocking violations touch. */
  blockingNodes: number;
}

export const BLOCKING_IMPACTS: readonly AxeImpact[] = ["serious", "critical"];

export function axeSourcePath(root: string = process.cwd()): string {
  const candidates = [path.join(root, "node_modules", "axe-core", "axe.min.js")];
  try {
    candidates.push(createRequire(path.join(root, "package.json")).resolve("axe-core/axe.min.js"));
  } catch {
    // fall through to the explicit message below
  }
  const found = candidates.find((file) => existsSync(file));
  if (!found) {
    throw new Error("axe-core is not installed (node_modules/axe-core/axe.min.js). Run npm ci; the harness adds no dependency of its own.");
  }
  return found;
}

/** Splits violations into the gate's blocking set and the rest. */
export function summarizeAxe(url: string, violations: readonly AxeViolation[]): AxeReport {
  const blocking = violations.filter((v) => v.impact !== null && BLOCKING_IMPACTS.includes(v.impact));
  return { url, violations: [...violations], blocking, blockingNodes: blocking.reduce((n, v) => n + v.nodes.length, 0) };
}

export function formatAxe(report: AxeReport, limit = 8): string {
  if (report.blocking.length === 0) return `${report.url}: no serious or critical violations`;
  const lines = report.blocking.slice(0, limit).map((v) => `${v.impact} ${v.id}: ${v.help} (${v.nodes.length} element${v.nodes.length === 1 ? "" : "s"}, e.g. ${v.nodes[0]?.target.join(" ")})`);
  if (report.blocking.length > limit) lines.push(`…and ${report.blocking.length - limit} more`);
  return `${report.url}:\n  ${lines.join("\n  ")}`;
}

/**
 * Runs axe on the page (or a part of it).
 * @param include CSS selector to limit the scan; defaults to the whole document
 */
export async function runAxe(page: Page, options: { include?: string; disableRules?: string[] } = {}): Promise<AxeReport> {
  const hasAxe = await page.evaluate(() => typeof (window as unknown as { axe?: unknown }).axe === "object");
  if (!hasAxe) {
    await page.addScriptTag({ path: axeSourcePath() }).catch(() => undefined);
    const injected = await page.evaluate(() => typeof (window as unknown as { axe?: unknown }).axe === "object");
    if (!injected) throw new Error("axe-core could not be injected (blocked by the page's CSP?). Use test.use({ bypassCSP: true }) in this spec.");
  }
  const violations = await page.evaluate(async ({ include, disableRules }) => {
    type AxeRun = (context: unknown, options: unknown) => Promise<{ violations: AxeViolation[] }>;
    const axe = (window as unknown as { axe: { run: AxeRun } }).axe;
    const rules: Record<string, { enabled: boolean }> = {};
    for (const id of disableRules) rules[id] = { enabled: false };
    const result = await axe.run(include ? { include: [include] } : document, { resultTypes: ["violations"], rules });
    return result.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      helpUrl: v.helpUrl,
      nodes: v.nodes.map((n) => ({ target: n.target.map(String), html: n.html.slice(0, 300), failureSummary: n.failureSummary })),
    }));
  }, { include: options.include ?? null, disableRules: options.disableRules ?? [] });
  return summarizeAxe(page.url(), violations);
}

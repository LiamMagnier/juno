/**
 * Runs a workflow's validators against one run's outputs. Pure dispatch: every
 * implementation is in this directory and none imports product code.
 */

import { statSync } from "node:fs";
import type { ArtifactRecord, BenchScope, CheckResult, ReviewRecord, ValidatorSpec } from "../types";
import { validateCodeTests } from "./code";
import { validateDocx } from "./docx";
import { validateOfficeReopen, validatePdf } from "./office";
import { validatePptx } from "./pptx";
import { validateRubric } from "./rubric";
import {
  validateCitations,
  validateConstraints,
  validateExtraction,
  validateFacts,
  validateHtml,
  validateText,
  validateWebCitations,
} from "./text";
import { validateTrace } from "./trace";
import { containedFile, fail, pass } from "./util";
import { validateWireContract } from "./wire";
import { validateXlsx } from "./xlsx";

export const VALIDATOR_SET_VERSION = "validators/1.0.0";

export interface ValidationContext {
  scope: BenchScope;
  outputsDir: string;
  fixturesDir: string;
  hiddenDir: string;
  repoRoot: string;
  scratchDir: string;
  reviewDir: string | null;
  artifacts: ArtifactRecord[];
  review: ReviewRecord | null;
  executorIdentity: string;
  network: boolean;
  officeReopen: boolean;
  soffice: string | null;
  /** Run delivered code without the sandbox (the operator's --unsafe-code). */
  unsafeCode?: boolean;
  /** Open delivered office files in LibreOffice without the sandbox (the operator's --unsafe-office). */
  unsafeOffice?: boolean;
  /** Undefined = detect the sandbox. false = behave as if none can be built (tests of the refusal paths). */
  sandbox?: false;
}

export function appliesTo(spec: ValidatorSpec, scope: BenchScope): boolean {
  return !spec.appliesTo || spec.appliesTo.includes(scope);
}

export async function runValidator(spec: ValidatorSpec, ctx: ValidationContext): Promise<CheckResult[]> {
  try {
    switch (spec.kind) {
      case "artifact": {
        const id = `artifact:${spec.file}`;
        try {
          const size = statSync(containedFile(ctx.outputsDir, spec.file)).size;
          if (size < (spec.minBytes ?? 1)) return [fail(id, `${size} bytes — empty`)];
          if (spec.maxBytes !== undefined && size > spec.maxBytes) return [fail(id, `${size} bytes > ${spec.maxBytes}`)];
          return [pass(id, `${size} bytes`)];
        } catch (error) {
          return [fail(id, (error as Error).message)];
        }
      }
      case "text":
        return validateText(spec, ctx.outputsDir);
      case "facts":
        return validateFacts(spec, ctx.outputsDir);
      case "docx":
        return await validateDocx(spec, ctx.outputsDir);
      case "xlsx":
        return await validateXlsx(spec, ctx.outputsDir);
      case "pptx":
        return await validatePptx(spec, ctx.outputsDir);
      case "pdf":
        return await validatePdf(spec, ctx.outputsDir);
      case "html":
        return validateHtml(spec, ctx.outputsDir);
      case "office_reopen":
        return await validateOfficeReopen(spec, ctx.outputsDir, {
          soffice: ctx.soffice,
          enabled: ctx.officeReopen,
          scratchDir: ctx.scratchDir,
          reviewDir: ctx.reviewDir,
          unsafeNoSandbox: ctx.unsafeOffice === true,
          sandbox: ctx.sandbox,
        });
      case "citations":
        return validateCitations(spec, ctx.outputsDir, ctx.fixturesDir);
      case "web_citations":
        return await validateWebCitations(spec, ctx.outputsDir, { network: ctx.network });
      case "code_tests":
        return validateCodeTests(spec, {
          outputsDir: ctx.outputsDir,
          fixturesDir: ctx.fixturesDir,
          hiddenDir: ctx.hiddenDir,
          scratchDir: ctx.scratchDir,
          unsafeNoSandbox: ctx.unsafeCode === true,
          sandbox: ctx.sandbox,
        });
      case "extraction":
        return validateExtraction(spec, ctx.outputsDir);
      case "constraints":
        return validateConstraints(spec, ctx.outputsDir);
      case "trace":
        return validateTrace(spec, ctx.outputsDir);
      case "wire_contract":
        return validateWireContract(spec, ctx.outputsDir, ctx.repoRoot);
      case "rubric":
        return validateRubric(spec, ctx.review, ctx.artifacts, ctx.executorIdentity);
      case "one_of": {
        const tried: string[] = [];
        for (const option of spec.options) {
          const results = (await Promise.all(option.filter((o) => appliesTo(o, ctx.scope)).map((o) => runValidator(o, ctx)))).flat();
          if (results.length && results.every((r) => r.status === "pass")) return results;
          const firstMissing = results.find((r) => r.status !== "pass");
          tried.push(firstMissing ? `${firstMissing.id}: ${firstMissing.detail}` : "no checks");
        }
        return [fail(`one-of:${spec.label}`, `no accepted form satisfied every check — ${tried.join(" | ")}`)];
      }
    }
  } catch (error) {
    // A validator that crashes says nothing about the product; record it as a
    // check that could not run so the run stays unverified, never passed.
    return [{ id: `${spec.kind}:validator-error`, status: "not_run", detail: `validator crashed: ${(error as Error).message}` }];
  }
}

export async function runValidators(specs: ValidatorSpec[], ctx: ValidationContext): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  // Sequential: LibreOffice and the code sandbox are heavy, and order makes
  // reports diffable.
  for (const spec of specs) {
    if (!appliesTo(spec, ctx.scope)) continue;
    out.push(...(await runValidator(spec, ctx)));
  }
  return out;
}

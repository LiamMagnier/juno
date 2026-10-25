/**
 * The Alevr offline-pipeline executor: runs a workflow's fixed plan through
 * Alevr's own code, with no model and no network. Workflows without an
 * offline plan are `not_run`, with the reason.
 */

import type { ExecutionContext, ExecutionResult, Executor } from "../runner";
import type { ProductInfo, WorkflowSpec } from "../types";
import {
  chatDocxExport,
  chatXlsxExport,
  multilingualExport,
  semanticDeck,
  semanticWorkbook,
  workDocument,
  workPresentation,
  workReport,
  workSpreadsheet,
} from "./offline-documents";
import {
  calcCents,
  calcParcels,
  extractDocx,
  extractPdf,
  extractXlsx,
  mcpConnector,
  mcpSsrf,
  secondDevice,
  stallWatchdog,
  streamResume,
  toolDispatch,
  toolStop,
  webInjection,
} from "./offline-runtime";

export const OFFLINE_PLANS: Record<string, (ctx: ExecutionContext) => Promise<void>> = {
  "calc-parcels": calcParcels,
  "calc-cents": calcCents,
  "web-injection": webInjection,
  "extract-xlsx": extractXlsx,
  "extract-pdf": extractPdf,
  "extract-docx": extractDocx,
  "work-document": workDocument,
  "chat-docx-export": chatDocxExport,
  "work-report": workReport,
  "semantic-workbook": semanticWorkbook,
  "work-spreadsheet": workSpreadsheet,
  "chat-xlsx-export": chatXlsxExport,
  "work-presentation": workPresentation,
  "semantic-deck": semanticDeck,
  "mcp-connector": mcpConnector,
  "mcp-ssrf": mcpSsrf,
  "tool-dispatch": toolDispatch,
  "tool-stop": toolStop,
  "stream-resume": streamResume,
  "second-device": secondDevice,
  "stall-watchdog": stallWatchdog,
  "multilingual-export": multilingualExport,
};

export function offlineExecutor(product: ProductInfo): Executor {
  return {
    id: "alevr-offline-pipeline",
    identity: "workflow-bench/offline-executor",
    kind: "automated",
    product,
    scope: "offline_pipeline",
    plan(workflow: WorkflowSpec) {
      if (!workflow.offline) {
        return {
          runnable: false,
          state: "not_run",
          reason: `no deterministic Alevr product path for this workflow; end-to-end needs ${workflow.requires.join(", ") || "a model"}`,
        };
      }
      if (!OFFLINE_PLANS[workflow.offline.plan]) return { runnable: false, state: "not_run", reason: `offline plan "${workflow.offline.plan}" is not implemented` };
      return { runnable: true };
    },
    async execute(ctx: ExecutionContext): Promise<ExecutionResult> {
      const plan = OFFLINE_PLANS[ctx.workflow.offline!.plan];
      await plan(ctx);
      return {
        outcome: { kind: "completed" },
        model: null,
        settings: { plan: ctx.workflow.offline!.plan, standsInFor: ctx.workflow.offline!.standsInFor },
        cost: { usd: 0, source: "offline_no_provider_calls" },
      };
    },
  };
}

/**
 * `read_document` (SPEC §3.8.3): the attached-document reader as a Juno spec.
 *
 * Behaviour and parameters are the agent tool's (`src/lib/agent/document.ts`),
 * unchanged; what the chat rework changes is that it now works. Classified a
 * read by its own declared risk, it no longer waits on an approval nobody sees
 * (RC-1). This file adds the model-facing description, the row's `present`
 * args and the figure: files listed, matches found, pages or characters read.
 */

import { readDocumentTool, type ReadDocumentData, type ReadDocumentParams } from "@/lib/agent/document";
import type { AgentExecutionContext, ToolExecutionResult } from "@/lib/agent/types";
import { agentContextFor, oneLine, outcomeFromAgentResult, stringArg } from "@/lib/tools/specs/shared";
import { defineTool, type ToolSpec } from "@/lib/tools/types";
import type { ToolFigure, ToolPresentArgs } from "@/types/run";

export interface ReadDocumentArgs extends Record<string, unknown> {
  action?: unknown;
  file?: unknown;
  fromPage?: unknown;
  toPage?: unknown;
  offset?: unknown;
  query?: unknown;
  reason?: unknown;
}

type Run = (params: ReadDocumentParams, context: AgentExecutionContext) => Promise<ToolExecutionResult<unknown>>;

const ACTIONS = new Set(["list", "outline", "read", "search"]);

function pageNumber(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : undefined;
}

function figureFor(action: string, data: ReadDocumentData | undefined): ToolFigure | undefined {
  if (!data) return undefined;
  if (action === "list" && typeof data.files === "number") return { kind: "files", n: data.files };
  if (action === "search" && typeof data.matches === "number") return { kind: "matches", n: data.matches };
  if (action === "outline" && typeof data.items === "number") return { kind: "items", n: data.items };
  if (action === "read") {
    if (typeof data.pages === "number") return { kind: "pages", n: data.pages };
    if (typeof data.chars === "number") return { kind: "chars", n: data.chars };
  }
  return undefined;
}

export function createReadDocumentSpec(deps: { run?: Run } = {}): ToolSpec<ReadDocumentArgs> {
  const run: Run = deps.run ?? ((params, context) => readDocumentTool.execute(params, context));

  return defineTool<ReadDocumentArgs>({
    id: "read_document",
    title: "Read document",
    description:
      "Reads the documents attached to this conversation. Use action 'list' to see what is attached and how long each file is, 'outline' to see a long document's headings, 'read' to read a file or a page range in order, and 'search' to find where a word, figure or identifier appears. Use it whenever an attached file is longer than the excerpt you were given, when you need a specific page, or before saying a document does not mention something. Do not use it for images (use inspect_image) or for web pages (use web_fetch). Name the file as it appears in the conversation; the file name may be omitted when only one document is attached. Long reads stop at a size limit and tell you the offset to continue from.",
    input: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "outline", "read", "search"],
          description: "list = what is attached; outline = its headings; read = read the text; search = find a string in it.",
        },
        file: {
          type: "string",
          description: "Which file, by name as it appears in the conversation. Optional when only one document is attached.",
        },
        fromPage: { type: "number", description: "First page to read (1-based). Omit to start at the beginning." },
        toPage: { type: "number", description: "Last page to read, inclusive. Omit to read to the end or to the size limit." },
        offset: {
          type: "number",
          description: "Skip this many sections before reading. Use it to continue a read that stopped at the size limit.",
        },
        query: { type: "string", description: "For action 'search': the exact word, number or phrase to find." },
        reason: { type: "string", description: "What you are looking for, in a few words." },
      },
      required: ["action"],
    },
    risk: "read",
    parallelSafe: true,
    timeoutMs: 30_000,
    icon: "document",
    broker: "juno_runtime",
    dedupe: true,
    present(args) {
      const out: ToolPresentArgs = {};
      const action = stringArg(args.action);
      if (action) out.action = oneLine(action, 20);
      const file = stringArg(args.file);
      if (file) out.file = oneLine(file);
      const from = pageNumber(args.fromPage);
      const to = pageNumber(args.toPage);
      if (from !== undefined || to !== undefined) {
        out.pages = from !== undefined && to !== undefined && to !== from ? `${from}–${to}` : String(from ?? to);
      }
      const query = stringArg(args.query);
      if (query) out.query = oneLine(query);
      return out;
    },
    async execute(args, ctx) {
      const action = typeof args.action === "string" && ACTIONS.has(args.action) ? args.action : "read";
      const params: ReadDocumentParams = {
        action: action as ReadDocumentParams["action"],
        ...(stringArg(args.file) ? { file: stringArg(args.file)! } : {}),
        ...(pageNumber(args.fromPage) !== undefined ? { fromPage: pageNumber(args.fromPage) } : {}),
        ...(pageNumber(args.toPage) !== undefined ? { toPage: pageNumber(args.toPage) } : {}),
        ...(typeof args.offset === "number" && Number.isFinite(args.offset) ? { offset: args.offset } : {}),
        ...(stringArg(args.query) ? { query: stringArg(args.query)! } : {}),
        ...(stringArg(args.reason) ? { reason: stringArg(args.reason)! } : {}),
      };
      const result = await run(params, agentContextFor(ctx));
      return outcomeFromAgentResult(result, { figure: figureFor(action, result.data as ReadDocumentData | undefined) });
    },
  });
}

export const readDocumentSpec = createReadDocumentSpec();

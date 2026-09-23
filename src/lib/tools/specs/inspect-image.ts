/**
 * `inspect_image` (SPEC §3.8.4): crop-and-magnify on an attached image or a
 * page of an attached PDF, as a Juno spec.
 *
 * Behaviour and parameters are the agent tool's (`src/lib/agent/image.ts`),
 * unchanged; the pixels come back as `images` beside a Juno-authored sentence.
 * This file adds the model-facing description and the row's `present` args.
 */

import { inspectImageTool, type InspectImageParams } from "@/lib/agent/image";
import type { AgentExecutionContext, ToolExecutionResult } from "@/lib/agent/types";
import { agentContextFor, oneLine, outcomeFromAgentResult, stringArg } from "@/lib/tools/specs/shared";
import { defineTool, type ToolSpec } from "@/lib/tools/types";
import type { ToolPresentArgs } from "@/types/run";

export interface InspectImageArgs extends Record<string, unknown> {
  file?: unknown;
  page?: unknown;
  x?: unknown;
  y?: unknown;
  width?: unknown;
  height?: unknown;
  grayscale?: unknown;
  contrast?: unknown;
  rotate?: unknown;
  reason?: unknown;
}

type Run = (params: InspectImageParams, context: AgentExecutionContext) => Promise<ToolExecutionResult<unknown>>;

function num(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** "x,y w×h" in percent, when the call names any part of a region. */
export function regionLabel(args: InspectImageArgs): string | undefined {
  const [x, y, w, h] = [num(args.x), num(args.y), num(args.width), num(args.height)];
  if ([x, y, w, h].every((v) => v === undefined)) return undefined;
  const left = x ?? 0;
  const top = y ?? 0;
  const width = w ?? 100 - left;
  const height = h ?? 100 - top;
  return `${Math.round(left)},${Math.round(top)} ${Math.round(width)}×${Math.round(height)}`;
}

export function createInspectImageSpec(deps: { run?: Run } = {}): ToolSpec<InspectImageArgs> {
  const run: Run = deps.run ?? ((params, context) => inspectImageTool.execute(params, context));

  return defineTool<InspectImageArgs>({
    id: "inspect_image",
    title: "Inspect image",
    description:
      "Looks closer at an attached image or at one page of an attached PDF: it crops and magnifies a region, optionally in grayscale or with more contrast, and shows the pixels back to you. Use it before reading out small text, numbers, labels, signatures or anything in a dense screenshot, chart or scan, because the copy you were first shown was downscaled. Do not use it to read a document's text (use read_document). Give the region in percent of the image, measured from the top-left corner; for a PDF, give the page. You can call it several times to sweep across a picture.",
    input: {
      type: "object",
      properties: {
        file: { type: "string", description: "Which attachment, by file name. Optional when only one image is attached." },
        page: { type: "number", description: "For a PDF: which page to render as an image (1-based). Ignored for images." },
        x: { type: "number", description: "Left edge of the region, 0-100, as a percentage of width." },
        y: { type: "number", description: "Top edge of the region, 0-100, as a percentage of height." },
        width: { type: "number", description: "Width of the region as a percentage, 0-100." },
        height: { type: "number", description: "Height of the region as a percentage, 0-100." },
        grayscale: { type: "boolean", description: "Drop colour — helps with faded or tinted scans." },
        contrast: {
          type: "number",
          description: "Contrast multiplier; 1 leaves it alone, 1.5 is a firm push for a pale scan.",
        },
        rotate: {
          type: "number",
          description: "Rotate the crop clockwise: 0, 90, 180 or 270 degrees. For a sideways scan.",
        },
        reason: { type: "string", description: "What you are trying to read, in a few words." },
      },
    },
    risk: "read",
    parallelSafe: true,
    timeoutMs: 30_000,
    icon: "image",
    broker: "juno_runtime",
    dedupe: true,
    present(args) {
      const out: ToolPresentArgs = {};
      const file = stringArg(args.file);
      if (file) out.file = oneLine(file);
      const page = num(args.page);
      if (page !== undefined && page >= 1) out.page = Math.floor(page);
      const region = regionLabel(args);
      if (region) out.region = region;
      return out;
    },
    async execute(args, ctx) {
      const params: InspectImageParams = {
        ...(stringArg(args.file) ? { file: stringArg(args.file)! } : {}),
        ...(num(args.page) !== undefined ? { page: num(args.page) } : {}),
        ...(num(args.x) !== undefined ? { x: num(args.x) } : {}),
        ...(num(args.y) !== undefined ? { y: num(args.y) } : {}),
        ...(num(args.width) !== undefined ? { width: num(args.width) } : {}),
        ...(num(args.height) !== undefined ? { height: num(args.height) } : {}),
        ...(typeof args.grayscale === "boolean" ? { grayscale: args.grayscale } : {}),
        ...(num(args.contrast) !== undefined ? { contrast: num(args.contrast) } : {}),
        ...(args.rotate !== undefined ? { rotate: args.rotate as InspectImageParams["rotate"] } : {}),
        ...(stringArg(args.reason) ? { reason: stringArg(args.reason)! } : {}),
      };
      return outcomeFromAgentResult(await run(params, agentContextFor(ctx)));
    },
  });
}

export const inspectImageSpec = createInspectImageSpec();

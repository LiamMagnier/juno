/**
 * What a tool call reads as, in the reader's language (SPEC §7.6).
 *
 * The server sends typed records — tool id, present args, figure, error code —
 * and never a sentence; every phrase the run UI shows is a literal in
 * `RUN_COPY`, so the i18n extractor harvests it, and argument values ride
 * beside the phrase as their own nodes rather than inside it. WS0 lands the
 * signature and an empty copy object; WS5 fills both.
 */

import type { ToolPresentation } from "@/lib/run/types";
import type { ToolCallRecord } from "@/types/run";

export type { ArgNode, PhraseLine, PhraseSpec, ToolPresentation } from "@/lib/run/types";

/** Every run-UI phrase, English source text. Filled by WS5. */
export const RUN_COPY: Record<string, string> = {};

export function presentTool(_record: ToolCallRecord): ToolPresentation {
  throw new Error("not implemented: WS5");
}

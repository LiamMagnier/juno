/**
 * Every Juno-native chat tool, in the order a turn offers them (SPEC §3.1,
 * §3.8).
 *
 * One registry, one entry per tool, each carrying everything the rest of the
 * system reads about it: the model-facing description and schema, the risk
 * that decides whether it asks, whether it may run beside others, its timeout,
 * its icon and how its row presents it. The toolset exposes a turn's entitled
 * subset in this order (`openChatToolset`), the dispatcher runs them, and the
 * broker's exact rules are checked against the `juno_runtime` entries here.
 *
 * No `server-only` in this module's static graph: every backend that needs one
 * is loaded inside `execute` (SPEC §13 harness rule 1).
 */

import { calculateSpec } from "@/lib/tools/specs/calculate";
import { currentTimeSpec } from "@/lib/tools/specs/current-time";
import { inspectImageSpec } from "@/lib/tools/specs/inspect-image";
import { readDocumentSpec } from "@/lib/tools/specs/read-document";
import { runCodeSpec } from "@/lib/tools/specs/run-code";
import { searchChatsSpec } from "@/lib/tools/specs/search-chats";
import { startTaskSpec } from "@/lib/tools/specs/start-task";
import { suggestResearchSpec } from "@/lib/tools/specs/suggest-research";
import { webFetchSpec } from "@/lib/tools/specs/web-fetch";
import { webSearchSpec } from "@/lib/tools/specs/web-search";
import type { JunoToolId, ToolSpec } from "@/lib/tools/types";

export const JUNO_TOOL_SPECS: readonly ToolSpec[] = Object.freeze([
  webSearchSpec,
  webFetchSpec,
  readDocumentSpec,
  inspectImageSpec,
  runCodeSpec,
  searchChatsSpec,
  currentTimeSpec,
  calculateSpec,
  suggestResearchSpec,
  startTaskSpec,
] as ToolSpec[]);

const BY_ID: ReadonlyMap<string, ToolSpec> = new Map(JUNO_TOOL_SPECS.map((spec) => [spec.id, spec]));

export function junoToolSpec(id: string): ToolSpec | undefined {
  return BY_ID.get(id);
}

/** The registry's ids in offer order. */
export const JUNO_TOOL_IDS: readonly JunoToolId[] = JUNO_TOOL_SPECS.map((spec) => spec.id as JunoToolId);

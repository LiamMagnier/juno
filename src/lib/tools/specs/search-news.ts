/**
 * `search_news` (BRIEF §15): Alevr Search's news vertical. The same spec as
 * `web_search` — same backend, envelope, numbering, ledger entries and fee —
 * asking the backends' news surfaces and defaulting to the past week. Declared
 * through `defineTool` here so the registry's one-file-per-tool rule holds.
 */

import { createWebSearchSpec, type WebSearchArgs, type WebSearchBackend } from "@/lib/tools/specs/web-search";
import { defineTool, type ToolSpec } from "@/lib/tools/types";

export function createSearchNewsSpec(deps: { search?: WebSearchBackend; now?: () => Date } = {}): ToolSpec<WebSearchArgs> {
  return defineTool<WebSearchArgs>({ ...createWebSearchSpec({ ...deps, vertical: "news" }) });
}

export const searchNewsSpec = createSearchNewsSpec();

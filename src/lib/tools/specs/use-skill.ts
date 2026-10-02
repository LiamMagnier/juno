/**
 * `use_skill` (docs/rework/TOOL_RUNTIME_DESIGN.md §6.8 item 3): the model loads
 * one of the person's skills by name: its instructions, the list of its files,
 * and (when the turn can run code) its folder mounted read-only at
 * `/skills/<slug>` for `run_code`.
 *
 * The description carries the list of skills on offer (at most 30, name and
 * one line), so a model that has not been told about a skill cannot load it,
 * and the session behind `port` refuses anything else. Everything the tool
 * decides is in `src/lib/skills/workflow.ts` and `session.ts`; this file is the
 * contract shape only, with no `server-only` import, so the registry tests and
 * the dispatcher's tests can build it over a fake port.
 */

import { defineTool, USE_SKILL_TOOL_ID, type ToolOutcome, type ToolSpec } from "@/lib/tools/types";
import { skillToolDescription, type SkillLibraryRow } from "@/lib/skills/workflow";

export interface UseSkillPort {
  offered: readonly Pick<SkillLibraryRow, "slug" | "name" | "description">[];
  loadSkill(name: string): Promise<ToolOutcome>;
}

export type UseSkillArgs = { name: string };

export function createUseSkillSpec(port: UseSkillPort): ToolSpec<UseSkillArgs> {
  return defineTool<UseSkillArgs>({
    id: USE_SKILL_TOOL_ID,
    title: "Use a skill",
    description: skillToolDescription(port.offered),
    input: {
      type: "object",
      properties: {
        name: { type: "string", description: "The skill's name exactly as listed in this tool's description." },
      },
      required: ["name"],
    },
    // It reads the person's own skill library and changes nothing outside the
    // turn: loading a skill registers its folder for this turn's sandbox only.
    risk: "read",
    // Not parallel-safe: a run_code call later in the same round must see the
    // mount this call registers, and the dispatcher keeps call order for it.
    parallelSafe: false,
    timeoutMs: 20_000,
    broker: "juno_runtime",
    dedupe: true,
    async execute(args) {
      const name = typeof args.name === "string" ? args.name : "";
      if (!name.trim()) {
        const text = "Name the skill to load, exactly as listed. Nothing was loaded.";
        return { status: "failed", text, body: text, error: { code: "invalid_args" } };
      }
      return port.loadSkill(name);
    },
  });
}

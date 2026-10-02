/**
 * `read_skill_file` (docs/rework/TOOL_RUNTIME_DESIGN.md §6.8 item 4): one page
 * (40,000 characters) of a file a loaded skill keeps: a reference, a template,
 * a script's source. Text from a skill nobody vouched for comes back inside the
 * untrusted-content envelope, as its instructions do; a binary asset is
 * described, not dumped.
 *
 * Only skills loaded this turn (armed with `/slug`, or through `use_skill`) can
 * be read, so the `skill_applied` audit row always precedes a read. Contract
 * shape only; the decisions are in `src/lib/skills/workflow.ts`.
 */

import { defineTool, READ_SKILL_FILE_TOOL_ID, type ToolOutcome, type ToolSpec } from "@/lib/tools/types";

export interface ReadSkillFilePort {
  readSkillFile(args: { skill: string; path: string; offset?: number }): Promise<ToolOutcome>;
}

export type ReadSkillFileArgs = { skill: string; path: string; offset?: number };

export function createReadSkillFileSpec(port: ReadSkillFilePort): ToolSpec<ReadSkillFileArgs> {
  return defineTool<ReadSkillFileArgs>({
    id: READ_SKILL_FILE_TOOL_ID,
    title: "Read a skill's file",
    description:
      "Read a file that a loaded skill keeps beside its instructions (a reference, a template, a script's source), " +
      "when its instructions point you at it. Use the skill's name and the file's path exactly as use_skill listed " +
      "them. Long files come back in pages of 40,000 characters: pass the offset the previous page gave you to read " +
      "on. Binary files (images, office templates, PDFs) are described, not shown; scripts can open them under " +
      "/skills/<skill>/ when you run code.",
    input: {
      type: "object",
      properties: {
        skill: { type: "string", description: "The loaded skill's name." },
        path: { type: "string", description: "The file's path inside the skill, as listed (for example reference/style.md)." },
        offset: { type: "integer", description: "Character offset to start from, for the next page of a long file. Default 0." },
      },
      required: ["skill", "path"],
    },
    risk: "read",
    parallelSafe: true,
    timeoutMs: 20_000,
    broker: "juno_runtime",
    dedupe: true,
    async execute(args) {
      const skill = typeof args.skill === "string" ? args.skill.trim() : "";
      const path = typeof args.path === "string" ? args.path.trim() : "";
      if (!skill || !path) {
        const text = "Name the loaded skill and the file's path inside it. Nothing was read.";
        return { status: "failed", text, body: text, error: { code: "invalid_args" } };
      }
      const offset = typeof args.offset === "number" && Number.isFinite(args.offset) && args.offset > 0 ? Math.floor(args.offset) : 0;
      return port.readSkillFile({ skill, path, offset });
    },
  });
}

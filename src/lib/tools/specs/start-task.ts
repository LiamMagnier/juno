/**
 * `start_task` as the registry describes it (SPEC §3.8.10).
 *
 * The tool that runs is not this one. `start_task` is a closure over its turn —
 * the user message it answers, the conversation, the preflight estimate — so
 * the chat route builds it per turn (`createStartTaskTool`, task-tool.ts) and
 * hands it to the toolset as a native tool, and it decides for itself when a
 * person must be asked (broker `self`). This entry exists so the dispatcher,
 * the presentation layer and the tests read its risk, timing and icon from the
 * same registry as every other Juno tool. Its `execute` is never reached: the
 * toolset routes the name to the native tool, and a turn without one does not
 * offer it.
 */

import { START_TASK_DESCRIPTION, START_TASK_NOT_ATTACHED_TEXT } from "@/lib/tools/specs/start-task.prompt";
import { failed, oneLine } from "@/lib/tools/specs/shared";
import { defineTool } from "@/lib/tools/types";

export interface StartTaskArgs extends Record<string, unknown> {
  title?: unknown;
  goal?: unknown;
  deliverable?: unknown;
}

export const startTaskSpec = defineTool<StartTaskArgs>({
  id: "start_task",
  title: "Start a task",
  description: START_TASK_DESCRIPTION,
  input: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description:
          "A short name for the task, at most 60 characters, naming the outcome in sentence case. Example: \"Competitor pricing spreadsheet\".",
      },
      goal: {
        type: "string",
        description:
          "A self-contained brief for the task: what the user wants, every relevant detail from this conversation (names, links, numbers, preferences), constraints, and what done looks like. The task cannot read this conversation, so include everything it needs.",
      },
      deliverable: {
        type: "string",
        description:
          "Optional. What exists when the task is done, in a few words. Example: \"a spreadsheet of 20 vendors with prices\" or \"draft replies in Gmail\".",
      },
    },
    required: ["title", "goal"],
  },
  risk: "external",
  parallelSafe: false,
  timeoutMs: 60_000,
  icon: "task",
  broker: "self",
  dedupe: true,
  present(args) {
    const title = oneLine(args.title, 80);
    return title ? { title } : {};
  },
  async execute() {
    return failed("unavailable", START_TASK_NOT_ATTACHED_TEXT);
  },
});

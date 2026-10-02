/*
 * `start_task`'s model-facing text (SPEC §3.8.10). The tool itself is built per
 * turn in `src/lib/chat/task-tool.ts`; its description lives here so the
 * registry spec and the declaration the model sees cannot drift apart, and so
 * the i18n extractor never harvests it (INV-29).
 */

export const START_TASK_DESCRIPTION =
  "Start a background task that works on the user's request on its own for minutes, then reports back in this conversation. It can research many sources, run code, use the files and connected apps from this message, and produce documents. Use it only for requests that need a finished result built over many steps, as described in the Tasks section of your instructions. It returns whether the task started.";

export const START_TASK_NOT_ATTACHED_TEXT =
  "Starting a task is not available in this conversation. Nothing was started. Answer in the chat instead.";

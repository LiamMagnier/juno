import test from "node:test";
import assert from "node:assert/strict";
import { buildAgentPromptBlock } from "../src/lib/agents/prompt";
import { TASK_HANDOFF_SECTION } from "../src/lib/chat/system-prompt";

/*
 * An agent asked to "open a computer and research" answered that it could not
 * spin up a computer or a browser. Its computer IS a background task, so the
 * prompt names it as one and tells the agent to start it when asked.
 */

const base = {
  name: "Pip",
  role: "",
  style: "warm",
  instructions: "",
  approvalMode: "balanced",
  goals: [],
  notes: [],
  teammates: [],
};

test("an agent with start_task is told its computer is a task and never to deny it", () => {
  const block = buildAgentPromptBlock({ ...base, taskHandoff: true }, "Liam");
  assert.match(block, /You have a computer\. When Liam asks you to open or use a computer/);
  assert.match(block, /Never say you cannot use a computer or a browser/);
  assert.match(block, /clean cloud computer with a browser/);
});

test("an agent that works on a Mac is told so", () => {
  const block = buildAgentPromptBlock({ ...base, taskHandoff: true, executionTarget: "mac" }, "Liam");
  assert.match(block, /on Liam's Mac, with its browser and apps/);
  assert.doesNotMatch(block, /clean cloud computer/);
});

test("without start_task the agent says so plainly and names no tool", () => {
  const block = buildAgentPromptBlock({ ...base, taskHandoff: false }, "Liam");
  assert.match(block, /Background tasks are not available in this reply/);
  assert.doesNotMatch(block, /start_task/);
});

test("the Tasks section makes a request for a computer or a browser a task", () => {
  assert.match(TASK_HANDOFF_SECTION, /asks for a computer or a browser by name/);
  assert.match(TASK_HANDOFF_SECTION, /never tell the user you cannot use a computer or browse/);
});

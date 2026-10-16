import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CHAT_TASK_MODES,
  CHAT_TASK_MODE_NOTE,
  chatTaskPolicy,
  describeChatTaskMode,
  parseChatTaskMode,
} from "@/lib/chat/task-approval-mode";
import { WORK_PERMISSION_POLICIES } from "@/lib/work/domain";
import { confirmPlanBeforeActing as confirmPlanBeforeActingFromDomain } from "@/lib/work/plan-review";
import { chatBodySchema } from "@/lib/chat/request";

/*
 * G15: the chat composer chooses how often a task the chat starts stops to
 * ask. These pin that the choice is Work's own vocabulary, that it can only
 * narrow an agent's mode, that a project's stricter mode is reported, and that
 * the choice reaches the task the model starts.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("the chat offers exactly Work's three modes, by their wire values", () => {
  assert.deepEqual([...CHAT_TASK_MODES], [...WORK_PERMISSION_POLICIES]);
  for (const mode of WORK_PERMISSION_POLICIES) assert.equal(parseChatTaskMode(mode), mode);
  for (const bogus of ["plan", "auto", "", null, undefined, 3, "Balanced"]) assert.equal(parseChatTaskMode(bogus), null);
});

test("a chat task runs as the composer's choice, or the default when nobody chose", () => {
  assert.equal(chatTaskPolicy({ chosen: null }), "balanced");
  assert.equal(chatTaskPolicy({ chosen: undefined }), "balanced");
  assert.equal(chatTaskPolicy({ chosen: "conservative" }), "conservative");
  assert.equal(chatTaskPolicy({ chosen: "permissive" }), "permissive");
});

test("in an agent's thread the agent's mode holds and the composer may only narrow it", () => {
  assert.equal(chatTaskPolicy({ chosen: null, agentMode: "permissive" }), "permissive");
  assert.equal(chatTaskPolicy({ chosen: "conservative", agentMode: "permissive" }), "conservative");
  assert.equal(chatTaskPolicy({ chosen: "permissive", agentMode: "balanced" }), "balanced");
});

test("what the composer shows says which layer narrowed the choice", () => {
  const plain = describeChatTaskMode({ chosen: "permissive" });
  assert.deepEqual(plain, { chosen: "permissive", effective: "permissive", narrowedBy: null });

  const project = describeChatTaskMode({ chosen: "permissive", projectMode: "conservative" });
  assert.equal(project.effective, "conservative");
  assert.equal(project.narrowedBy, "project");

  const agent = describeChatTaskMode({ chosen: "permissive", agentMode: "balanced" });
  assert.equal(agent.effective, "balanced");
  assert.equal(agent.narrowedBy, "agent");

  // Both stricter than the choice: the task runs as the project's mode, so the
  // project is the one named.
  const both = describeChatTaskMode({ chosen: "permissive", agentMode: "balanced", projectMode: "conservative" });
  assert.equal(both.effective, "conservative");
  assert.equal(both.narrowedBy, "project");

  // An agent's own wider mode with no choice is not "narrowing" anything.
  const agentDefault = describeChatTaskMode({ chosen: null, agentMode: "permissive" });
  assert.equal(agentDefault.effective, "permissive");
  assert.equal(agentDefault.narrowedBy, null);

  // A project looser than the choice changes nothing: defaults never widen.
  const loose = describeChatTaskMode({ chosen: "conservative", projectMode: "permissive" });
  assert.equal(loose.effective, "conservative");
  assert.equal(loose.narrowedBy, null);
});

test("the chip's words reach the translation catalog whole", async () => {
  // The extractor (scripts/generate-i18n-catalog.mjs) reads static text only:
  // a reason assembled from a name and a label would stay English forever.
  const { collectFromSource } = (await import("../scripts/generate-i18n-catalog.mjs")) as {
    collectFromSource: (content: string, path: string) => Set<string>;
  };
  const chip = collectFromSource(read("../src/components/chat/task-mode-chip.tsx"), "task-mode-chip.tsx");
  for (const sentence of [
    "Tasks from this chat",
    "How often tasks from this chat ask",
    "This project’s settings hold its tasks to a stricter mode than the one you picked.",
    "This agent is set to ask more often, so its tasks follow its setting.",
    "Sending, publishing, paying and deleting always ask, whichever mode you pick.",
  ]) {
    assert.equal(chip.has(sentence), true, sentence);
  }
  const rule = collectFromSource(read("../src/lib/chat/task-approval-mode.ts"), "task-approval-mode.ts");
  assert.equal(rule.has("You see the plan before it starts."), true);
  const hook = collectFromSource(read("../src/hooks/use-conversation-task-mode.ts"), "use-conversation-task-mode.ts");
  assert.equal(hook.has("Couldn’t save how often tasks ask. Try again."), true);
});

test("only the mode with a real plan gate claims to show the plan first", () => {
  assert.deepEqual(Object.keys(CHAT_TASK_MODE_NOTE), ["conservative"]);
  // The claim is true because a chat task is attended and the gate fires for
  // exactly that mode (src/lib/work/plan-review.ts).
  assert.equal(confirmPlanBeforeActingFromDomain({ policy: "conservative", attended: true }), true);
  assert.equal(confirmPlanBeforeActingFromDomain({ policy: "balanced", attended: true }), false);
  assert.equal(confirmPlanBeforeActingFromDomain({ policy: "permissive", attended: true }), false);
  // And a chat task's first run is a manual, attended one.
  assert.match(read("../src/lib/chat/task-tool.ts"), /origin: "manual"/);
});

test("the chat request carries the mode and refuses anything else", () => {
  assert.equal(chatBodySchema.safeParse({ message: "hi", taskApprovalMode: "conservative" }).success, true);
  assert.equal(chatBodySchema.safeParse({ message: "hi", taskApprovalMode: "permissive" }).success, true);
  assert.equal(chatBodySchema.safeParse({ message: "hi" }).success, true);
  assert.equal(chatBodySchema.safeParse({ message: "hi", taskApprovalMode: "skip" }).success, false);
});

test("the choice reaches the task the model starts, and is saved on the conversation", () => {
  const taskTool = read("../src/lib/chat/task-tool.ts");
  assert.match(
    taskTool,
    /permissionPolicy: chatTaskPolicy\(\{ chosen: ctx\.approvalMode \?\? null, agentMode: ctx\.agent\?\.approvalMode \?\? null \}\)/,
  );
  assert.doesNotMatch(taskTool, /permissionPolicy: ctx\.agent\?\.approvalMode \?\? DEFAULT_WORK_PERMISSION_POLICY/);
  const tools = read("../src/lib/chat/turn/tools.ts");
  assert.match(tools, /approvalMode: parseChatTaskMode\(input\.taskApprovalMode \?\? conversation\.taskApprovalMode\)/);
  const accept = read("../src/lib/chat/turn/accept.ts");
  // Both create paths and the existing-conversation path write it.
  assert.equal((accept.match(/taskApprovalMode: input\.taskApprovalMode \}/g) ?? []).length >= 2, true);
  assert.match(accept, /data: \{ taskApprovalMode: input\.taskApprovalMode \}/);
  // The client sends it on every send, never in private mode.
  const useChat = read("../src/hooks/use-chat.ts");
  assert.match(useChat, /taskApprovalMode: opts\.privateMode \? undefined : readTaskApprovalMode\?\.\(\) \?\? undefined/);
});

test("the composer shows the chip only where a task can start, and hides it while steering a task", () => {
  const view = read("../src/components/chat/chat-view.tsx");
  assert.match(view, /const tasksPossible = !privateMode && PLANS\[quota\.plan\]\.agents;/);
  const composer = read("../src/components/chat/composer.tsx");
  assert.match(composer, /\{taskModeControl && modality === "chat" && !steerMode && \(/);
  // The Permissions page no longer promises a control that does not exist.
  const permissions = read("../src/app/(app)/permissions/page.tsx");
  assert.match(permissions, /in a chat’s composer/);
  assert.doesNotMatch(permissions, /and from the task itself while it runs/);
});

import type { ScriptedWorkScript } from "../../runner/agent-core/src/work/scripted-model";

/*
 * The two "models" of the agents journey (e2e/agents-journey.spec.ts): fixed
 * steps for the scripted Work model (runner/agent-core/src/work/scripted-model.ts),
 * one per assistant turn. Kept apart from the spec so a unit test can check
 * them against the real parser and the runner's own tool names
 * (tests/agents-journey-support.test.ts) without starting a browser.
 *
 * A step's `expect` is checked against the previous tool's result; when it
 * does not match, the run ends with a sentence naming the step, its plan is
 * left open, and the run is reported as not done — so each expectation below
 * is part of what the journey proves, not decoration.
 */

/** The first task: a plan, a deliverable, done. */
export const DELIVER_SCRIPT: ScriptedWorkScript = {
  version: 1,
  vision: false,
  steps: [
    { say: "Planning the brief.", call: { name: "write_plan", input: { steps: [{ title: "Gather the launch facts" }, { title: "Write the launch brief" }] } } },
    { expect: "s1: Gather the launch facts", call: { name: "update_plan", input: { stepId: "s1", status: "done" } } },
    { call: { name: "update_plan", input: { stepId: "s2", status: "active" } } },
    {
      call: {
        name: "create_deliverable",
        input: {
          identifier: "launch-brief",
          spec: {
            kind: "report",
            title: "Launch brief",
            summary: "What ships on launch day, who announces it, and what is still open.",
            blocks: [
              { type: "heading", level: 2, text: "What ships" },
              { type: "list", ordered: false, items: ["The new agents page", "Answers after a park", "The journey test"] },
            ],
          },
        },
      },
    },
    // The runner's own sentence for a file its validator re-opened.
    { expect: "opens correctly", call: { name: "update_plan", input: { stepId: "s2", status: "done" } } },
    { say: "The launch brief is attached.", end: true },
  ],
};

export const DELIVERABLE_TITLE = "Launch brief";

export const QUESTION = "Which Invoices folder should I pay from?";
export const ANSWER = "Invoices 2024";
export const ANSWERED_DELIVERABLE_TITLE = "Payment note";

/** The second task: it asks, and only the answer it was given lets it finish. */
export const ASK_SCRIPT: ScriptedWorkScript = {
  version: 1,
  vision: false,
  steps: [
    { say: "Planning the payment run.", call: { name: "write_plan", input: { steps: [{ title: "Find the invoices to pay" }, { title: "Write the payment note" }] } } },
    { expect: "s1: Find the invoices to pay", call: { name: "update_plan", input: { stepId: "s1", status: "active" } } },
    { call: { name: "ask_user", input: { question: QUESTION, why: "Two folders are called Invoices." } } },
    // The answer, exactly, as the question's own result: not the "stopped"
    // placeholder a park leaves, and not a second question.
    { expect: `^${ANSWER}$`, call: { name: "update_plan", input: { stepId: "s1", status: "done" } } },
    {
      call: {
        name: "create_deliverable",
        input: {
          identifier: "payment-note",
          spec: { kind: "report", title: ANSWERED_DELIVERABLE_TITLE, blocks: [{ type: "paragraph", text: `Paid the October invoices from the ${ANSWER} folder.` }] },
        },
      },
    },
    { expect: "opens correctly", call: { name: "update_plan", input: { stepId: "s2", status: "done" } } },
    { say: `Paid from ${ANSWER}. The payment note is attached.`, end: true },
  ],
};

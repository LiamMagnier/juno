/**
 * WHERE A JUNO CODE RUN HAPPENS, AND WHAT IT MAY DO THERE.
 *
 * Two facts that used to be written three times each — once in the composer's
 * footer caption, once in the target picker's popover rows, once in a tooltip —
 * and a sentence with three homes drifts. The composer's permission chip and
 * `/code/customize` now read them from here, so the thing a reader is told
 * before they press send is the same thing the Customize page explains.
 *
 * THIS FILE DESCRIBES, IT DOES NOT CONFIGURE. There is no `CodeEnvironment`
 * model: the cloud environment is whatever `.github/workflows/code-runner.yml`
 * and the vendored agent core say it is, and a person cannot change it from the
 * web. Drawing an editor for a model that is not there yet would be the more
 * expensive lie, so this is a set of stated facts instead — and
 * `tests/code-landing.test.ts` pins every number below to the file it came
 * from, so the Customize page cannot keep claiming a thirty-minute ceiling
 * after somebody moves the workflow's `timeout-minutes`.
 *
 * Pure on purpose: no React, no `server-only`, no environment reads. The
 * composer is a client island and the test suite imports this directly.
 */

/** The two machines a run can happen on. Mirrors `CodeTask.target`. */
export type CodeTarget = "device" | "cloud";

export interface CodePermission {
  /**
   * What the composer's permission chip says — two words, because the chip
   * sits in the composer's LEADING cluster, which does not shrink
   * (components/ui/composer-shell.tsx sets `shrink-0` on it so that the model
   * chip on the right is what gives up width first). A long label there does
   * not truncate, it pushes: "Full access, reviewed as a PR" beside `+`,
   * dictate and voice is 290px of unshrinkable row on a 320px phone, and the
   * send circle lands outside the box it is drawn in.
   */
  mode: string;
  /** The same fact at sentence length — the chip's popover, the Customize row. */
  detail: string;
}

/**
 * What a run may do without stopping to ask, per machine.
 *
 * This is NOT a setting, and the chip that shows it is deliberately not a
 * dropdown. Nothing between the browser and a runner carries a per-run
 * permission choice: `CodeTask` has no column for one and neither runner reads
 * one, so a picker here would be four visible options deciding nothing — the
 * exact defect `CodeTask.model` / `reasoningEffort` were added to end (see the
 * note on those columns in prisma/schema.prisma). The mode is real and it is
 * chosen, but it is chosen by picking the machine, which is the control one
 * row up.
 */
export const CODE_PERMISSIONS: Record<CodeTarget, CodePermission> = {
  device: {
    mode: "Asks first",
    detail:
      "Your Mac pauses and prompts for approval before applying high-impact changes or terminal commands.",
  },
  cloud: {
    mode: "Full access",
    detail:
      "A cloud runner executes in a sandboxed CI environment and opens a pull request for you to review.",
  },
};

/**
 * The files the agent reads before its first move, in this order.
 * Source of truth: `MEMORY_FILES` in runner/agent-core/src/agent.ts.
 */
export const AGENT_MEMORY_FILES = ["JUNO.md", "AGENTS.md", "CLAUDE.md"] as const;

/**
 * How long a cloud job may run before GitHub kills it.
 * Source of truth: `timeout-minutes` in .github/workflows/code-runner.yml.
 */
export const CLOUD_RUN_TIMEOUT_MINUTES = 30;

/**
 * The container network the agent's shell gets.
 * Source of truth: `JUNO_RUNNER_SANDBOX_NETWORK` in the same workflow.
 */
export const CLOUD_SANDBOX_NETWORK = "none";

/** The Node the runner builds and runs the agent core on (`node-version`). */
export const CLOUD_RUNNER_NODE_VERSION = 24;

export interface EnvironmentFact {
  /** The question this row answers, in one or two words. */
  label: string;
  /** The answer, short enough to sit on one line beside the label. */
  value: string;
}

/**
 * The cloud environment, as it actually is. Every row is lifted from a file in
 * this repository rather than described from memory; the test names which.
 */
export const CLOUD_ENVIRONMENT_FACTS: readonly EnvironmentFact[] = [
  { label: "Machine", value: "A fresh GitHub Actions runner (ubuntu-latest), one per run" },
  {
    label: "Shell",
    value: `Agent commands run inside a pinned container, network ${CLOUD_SANDBOX_NETWORK}`,
  },
  { label: "Runtime", value: `Node ${CLOUD_RUNNER_NODE_VERSION}, with the agent core built from this repository` },
  { label: "Ceiling", value: `${CLOUD_RUN_TIMEOUT_MINUTES} minutes, then the job is stopped` },
  { label: "Credentials", value: "A single-use clone token for the one repository, minted per run" },
  { label: "Result", value: "A branch pushed to your repository and a pull request to review" },
];

/**
 * The sentence the Customize page uses to say what a run reads before it
 * starts. Kept beside the list it names so the two cannot disagree.
 */
export const AGENT_MEMORY_SENTENCE = `Every run reads ${AGENT_MEMORY_FILES.join(", ")} from the checkout before its first move, so repository instructions apply without being pasted into the prompt.`;

/**
 * Which open question "Hand back" answers, and the sentences every surface
 * says about the computer.
 *
 * When a site wants a password, a 2FA code or a CAPTCHA, the agent calls
 * `ask_user` and asks the person to take over its computer for that step
 * (`YOUR_COMPUTER_PROMPT_SECTION`, src/lib/computer/store.ts). Hand back ends
 * the control session and answers THAT question with a canned "done,
 * continue", which is what lets the waiting run pick up again.
 *
 * It used to answer `questions[0]`, whatever that asked. Take control is also
 * a plain button anybody can press to look around, so a person who took over
 * while the agent was asking "Which folder should I save it in?" handed back
 * and answered the folder question with "Done. I've finished on your
 * computer; continue." — an answer to a question nobody read.
 *
 * A question carries no structured kind, only its words (the runner's
 * `ask_user` is `{ question, why, options }` and native decodes that shape),
 * so the tie is made in two steps, both by id:
 *
 *   1. On Take control, `pinTakeover` records the one open question that asks
 *      for the computer, and every question already open.
 *   2. On Hand back, `handBackQuestion` answers the pinned question if it is
 *      still open, and nothing if it has gone (answered in the composer, or
 *      the run ended). With nothing pinned, it answers a takeover question
 *      asked WHILE the person had control, when there is exactly one.
 *
 * When in doubt it answers nothing: the person can still reply in the
 * composer, and a wrong canned answer cannot be taken back.
 *
 * The wording, the canned answer and the state sentences live in
 * contracts/agents/computer-takeover.json, which the Swift port
 * (NativeComputerHandBack.swift) asserts against too, so the web and the apps
 * cannot drift apart.
 */

import contract from "../../../contracts/agents/computer-takeover.json";

/** The shared contract, as read. */
export const COMPUTER_TAKEOVER_CONTRACT = contract;

/** What Hand back tells the run. */
export const HAND_BACK_ANSWER: string = contract.handBackAnswer;

/** The part of an open question this needs (`OpenQuestion` in work-decisions). */
export interface HandBackCandidate {
  id: string;
  question: string;
  why: string | null;
}

/** What Take control remembers about the questions open at that moment. */
export interface TakeoverPin {
  /** The takeover question open when control was taken, or null for none (or more than one). */
  questionId: string | null;
  /** Every question open when control was taken. None of them was asked of this takeover. */
  openAtStart: string[];
}

/*
 * The words the computer prompt asks for ("ask them to take over your
 * computer"), and the ways a model rephrases them. Deliberately narrow: a
 * question that merely mentions signing in or a password is not asking for
 * the screen, and answering it "done" would be a guess.
 */
export const TAKEOVER_WORDING: readonly RegExp[] = contract.takeoverPatterns.map(
  (pattern) => new RegExp(pattern.source, pattern.flags)
);

/** Whether a question is the agent asking the person to take over its computer. */
export function isTakeoverQuestion(question: Pick<HandBackCandidate, "question" | "why">): boolean {
  const text = `${question.question}\n${question.why ?? ""}`;
  return TAKEOVER_WORDING.some((pattern) => pattern.test(text));
}

/** Called on Take control, with the questions open at that moment. */
export function pinTakeover(questions: readonly HandBackCandidate[]): TakeoverPin {
  const takeovers = questions.filter(isTakeoverQuestion);
  return {
    questionId: takeovers.length === 1 ? takeovers[0].id : null,
    openAtStart: questions.map((question) => question.id),
  };
}

/**
 * The question Hand back answers, or null to answer nothing.
 *
 * `pin` is null when control was not taken through `pinTakeover` (the overlay
 * opened straight into control): then every open question counts as asked
 * during it.
 */
export function handBackQuestion<Q extends HandBackCandidate>(
  questions: readonly Q[],
  pin: TakeoverPin | null
): Q | null {
  if (pin?.questionId) {
    return questions.find((question) => question.id === pin.questionId) ?? null;
  }
  const before = new Set(pin?.openAtStart ?? []);
  const asked = questions.filter((question) => !before.has(question.id) && isTakeoverQuestion(question));
  return asked.length === 1 ? asked[0] : null;
}

// ---------------------------------------------------------------------------
// Sentences
// ---------------------------------------------------------------------------

/** The statuses the server sends (`ComputerStatus` in src/lib/computer/types.ts). */
export type ComputerStatusName = "asleep" | "starting" | "awake" | "resting" | "stopping" | "error";

/** Who holds a takeover, as a client may name it. Never an id. */
export type TakeoverHolderKind = "web" | "iphone" | "ipad" | "mac" | "app";

export const COMPUTER_STATUSES = contract.statuses as readonly ComputerStatusName[];

export function isComputerStatus(value: string | null | undefined): value is ComputerStatusName {
  return typeof value === "string" && (COMPUTER_STATUSES as readonly string[]).includes(value);
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole);
}

/** "a minute" or "3 minutes": the server's rest time (`env.agentComputer.restMinutes`) as words. */
export function restPhrase(restMinutes: number | null | undefined): string {
  const minutes = typeof restMinutes === "number" && Number.isFinite(restMinutes) && restMinutes > 0 ? restMinutes : 3;
  if (minutes < 1.5) return contract.restPhrases.underTwo;
  return fill(contract.restPhrases.many, { n: String(Math.round(minutes)) });
}

/**
 * The plain sentence under the computer for a status. `usingNow` (what the
 * agent is doing) replaces the idle sentence while it is awake. An unknown
 * status reads as asleep rather than as nothing.
 */
export function computerStateSentence(input: {
  status: string | null | undefined;
  agent: string;
  restMinutes?: number | null;
  usingNow?: string | null;
}): string {
  const status = isComputerStatus(input.status) ? input.status : "asleep";
  const sentences = contract.stateSentences;
  if (status === "awake" && input.usingNow && input.usingNow.trim()) {
    return fill(sentences.awakeUsing, { summary: input.usingNow.trim() });
  }
  return fill(sentences[status], { agent: input.agent, rest: restPhrase(input.restMinutes) });
}

/** Whether a status means the computer is on its way up (a working mark, not a button). */
export function computerIsWaking(status: string | null | undefined): boolean {
  return status === "starting" || status === "resting";
}

/** "Your iPhone has control right now." — who holds a takeover the viewer does not. */
export function takeoverHolderSentence(kind: TakeoverHolderKind | null | undefined): string {
  const sentences = contract.takeoverSentences;
  switch (kind) {
    case "web":
      return sentences.web;
    case "iphone":
      return sentences.iphone;
    case "ipad":
      return sentences.ipad;
    case "mac":
      return sentences.mac;
    default:
      return sentences.app;
  }
}

/** What a client hears when it asks for control, or hands back, while another one holds it. */
export function takeoverHeldRefusal(kind: TakeoverHolderKind | null | undefined): string {
  return `${takeoverHolderSentence(kind)} ${contract.takeoverSentences.handBackThere}`;
}

/** "You have control. Nova waits until you hand back." */
export function takeoverMineSentence(agent: string): string {
  return fill(contract.takeoverSentences.mine, { agent });
}

/** "Alevr took the computer back." — a takeover that lapsed. */
export function takeoverLapsedSentence(product: string): string {
  return fill(contract.takeoverSentences.lapsed, { product });
}

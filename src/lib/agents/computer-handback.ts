/**
 * Which open question "Hand back" answers.
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
 */

/** What Hand back tells the run. */
export const HAND_BACK_ANSWER = "Done. I've finished on your computer; continue.";

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
const TAKEOVER_WORDING = [
  /\b(?:take|taking|took) (?:over|control)\b/i,
  /\btake-?over\b/i,
  /\bhand(?:ing)? (?:it |control |the (?:computer|screen) )?back\b/i,
  /\b(?:on|onto|into|use|using) (?:my|this|the) (?:computer|desktop|screen)\b/i,
];

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

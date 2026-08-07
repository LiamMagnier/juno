/**
 * The two or three questions worth asking before a Work run starts, read out of
 * the task itself.
 *
 * A Work run holds a $2, 600,000-token, twenty-minute ceiling and nobody is
 * watching it. The cost of a misread goal is therefore not a bad paragraph the
 * reader can ask again for — it is twenty minutes and a couple of dollars spent
 * on the wrong errand, discovered at the end. That is what this file is for:
 * the small number of decisions where a wrong assumption wastes the whole run,
 * asked before it starts rather than apologised for afterwards.
 *
 * ## Why these are regexes and not a model call
 *
 * `inference.ts` already made this argument for capabilities and the argument
 * transfers whole: "a capability list produced by a model would be a better
 * list and a worse contract — it could not be previewed without a round trip,
 * and two runs of the same goal could disagree." The same is true of questions.
 * A model that wrote them would put a network round trip between pressing the
 * button and the task starting, on every dispatch, for a card the reader is
 * free to ignore; it would cost money on a surface whose whole purpose is to
 * stop money being wasted; and it would have to fail open, which means the
 * feature would be quietly absent exactly when the provider was struggling.
 *
 * `preflight-triage.ts` does take the model path for chat, and it is right to:
 * a chat turn is cheap, so a question is only worth asking when it is a good
 * one, and only a model can tell. Here the arithmetic is reversed. The run is
 * expensive and the questions below are not judgement calls — they are the four
 * places where this codebase can already point at something concrete in the
 * goal and say what it will otherwise assume.
 *
 * So the rule for adding one is the rule `preflight-triage.ts` states in prose
 * and this file has to keep without a model to enforce it: if the question
 * could be pasted under a different task unchanged, it is generic and does not
 * belong here. Every rule below names something the reader actually wrote — an
 * app they have connected, a verb that sends, a word that means "all of them",
 * a research task with no date in it — and asks about that.
 *
 * ## Where the answers go
 *
 * Into the composer's own textarea, visibly, where the reader can read them and
 * delete them before pressing the button. `WorkSession.goal` is documented as
 * "what the user actually asked for, verbatim" and is the thing a plan is
 * checked back against, so nothing here may append to it behind the reader's
 * back — but a line the reader watched appear, in a field they can still edit,
 * is something they typed. `formatPreflightClarificationVisibleMessage` is
 * reused rather than reinvented for exactly that reason: chat already persists
 * its clarification answers as the user's own message in that format, and a
 * second format would be a second thing to recognise in a transcript.
 *
 * The one answer that is not a sentence is the connector question. Text cannot
 * grant a permission — `evaluateConnector` reads the grant rows and nothing
 * else — so that answer flips the Apps chip as well as writing its line.
 *
 * Deliberately free of `server-only`, Prisma and `node:*`: the composer is a
 * client component and this runs in the browser, on every keystroke.
 */

import {
  formatPreflightClarificationVisibleMessage,
  type PreflightClarificationAnswer,
} from "@/lib/preflight-clarification";
import type { WorkCapability } from "@/lib/work/domain";

/** One answer the reader can pick. Exactly one option per question is the recommendation. */
export interface WorkPreflightOption {
  label: string;
  recommended?: true;
}

export interface WorkPreflightQuestion {
  id: string;
  question: string;
  options: readonly WorkPreflightOption[];
  /**
   * The connected app the recommended answer switches on for this task.
   *
   * Present only on the connector question, and the reason it exists is that a
   * sentence in the goal cannot grant anything: the run reaches an app because
   * a `WorkSessionConnector` row says so. The card applies this alongside the
   * text so the answer and the permission cannot disagree.
   */
  grantsConnectorId?: string;
}

/** As much of a connected app as a question needs: what it is, and what it is called. */
export interface WorkPreflightConnector {
  id: string;
  label: string;
}

export interface WorkPreflightInput {
  goal: string;
  /** `inferCapabilities(goal).capabilities`, so the reading is the composer's own. */
  inferred: readonly WorkCapability[];
  /** The apps this account has linked. Empty is a real answer and asks nothing. */
  connectors: readonly WorkPreflightConnector[];
  /** The apps switched on for this task, from the Apps chip. */
  selectedConnectorIds: readonly string[];
}

/**
 * Three, which is Cowork's own range read down rather than up.
 *
 * Four questions is a form. The point of this card is that accepting it is
 * cheaper than reading it, and a fourth row is the one that turns "glance,
 * press" into "read, decide, decide, decide, press" — at which point skipping
 * becomes the fast path and the card has made the composer worse.
 */
const MAX_PREFLIGHT_QUESTIONS = 3;

/**
 * The delimiter `formatPreflightClarificationVisibleMessage` produces.
 *
 * Restated here rather than exported from there because this file needs to find
 * it, not write it, and the two uses want different things: that function joins
 * lines, this one splits a string somebody may since have edited by hand.
 */
const CLARIFICATIONS_HEADING = "\n\nClarifications:\n";

/**
 * Splits a goal into the sentence the reader wrote and the answers appended to
 * it, so questions are re-read from the first and never from the second.
 *
 * Without this the card asks forever: accepting "leave it as a draft" writes
 * the word *draft* into the goal, the next keystroke re-derives from the whole
 * field, and the rule that reads *send* still fires because the verb is still
 * there. Splitting also means a reader who edits their goal after answering
 * gets the questions re-read against the new sentence and keeps the answers
 * they already gave.
 *
 * The last occurrence, not the first: the block is always at the end, and a
 * reader whose task genuinely contains the word "Clarifications:" should have
 * their own text left alone.
 */
export function splitClarifications(goal: string): { body: string; block: string } {
  const at = goal.lastIndexOf(CLARIFICATIONS_HEADING);
  if (at === -1) return { body: goal, block: "" };
  return { body: goal.slice(0, at), block: goal.slice(at) };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The words that mean a connected app, for the apps whose name is not the word
 * anybody uses.
 *
 * "Check my inbox" is a request about Apple Mail and contains neither "Apple"
 * nor "Mail"; "the repos that have no readme" is a request about GitHub and
 * names it nowhere. Matching on the label alone would therefore miss the
 * commonest phrasing of the commonest case, which is the one this question
 * exists for.
 *
 * Keyed by the connector ids in src/lib/connectors.ts. An id that is not here —
 * a Composio app this deployment has never enumerated — falls through to its
 * own name, which is the right default: nobody says "my Linear" and means
 * anything else.
 */
const CONNECTOR_ALIASES: Readonly<Record<string, RegExp>> = {
  "apple-mail": /\b(?:inbox|mailbox|e-?mails?|mail)\b/i,
  "apple-calendar": /\b(?:calendar|diary|meetings?)\b/i,
  "apple-music": /\b(?:playlists?|music library)\b/i,
  github: /\b(?:github|pull requests?|repos?|repositor(?:y|ies))\b/i,
  notion: /\bnotion\b/i,
  figma: /\bfigma\b/i,
};

function namePattern(connector: WorkPreflightConnector): RegExp | null {
  const alias = CONNECTOR_ALIASES[connector.id];
  if (alias) return alias;
  const names = [connector.label, connector.id.replace(/[-_]+/g, " ")]
    .map((name) => name.trim())
    .filter(Boolean)
    .map(escapeRegExp);
  if (names.length === 0) return null;
  return new RegExp(String.raw`\b(?:${names.join("|")})\b`, "i");
}

/** A verb that puts something in front of another person, where undoing is apologising. */
const OUTWARD_ACT =
  /\b(?:send|sends|sending|reply|replies|replying|respond to|post|posts|posting|publish|publishes|publishing)\b/i;

/**
 * "all my unread emails", "every repo" — a task whose size is the whole of
 * something rather than one of them.
 *
 * Two halves because English puts the two quantifiers on different nouns. "All"
 * takes a plural and may have adjectives in front of it, so it looks ahead up
 * to two words for something ending in *s*; "every" and "each" take a singular
 * and so cannot be recognised that way.
 *
 * The exclusion list on the second half is the whole reason it is safe. "Every
 * morning" and "every Monday" are `background_continuation` — a task that
 * recurs, not a task that is large — and asking how much of "every morning"
 * one run should get through is a question about nothing.
 */
const BREADTH =
  /\ball\s+(?:of\s+)?(?:my\s+|our\s+|the\s+)?(?:\w+\s+){0,2}\w+s\b|\b(?:every|each)\s+(?!(?:day|morning|afternoon|evening|night|week|weekday|weekend|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday|hour|time|now|other)\b)\w+/i;

/**
 * A date, a window, or a "since" — any of them means the reader already said.
 *
 * The spelled-out count in the middle is not padding. "The last six months" is
 * how people write this and "the last 6 months" is not, and a pattern that only
 * read digits asked a reader who had just given a window which window they
 * meant.
 */
const TIMEFRAME =
  /\b(?:19|20)\d{2}\b|\b(?:last|past|previous|recent|next|coming)\s+(?:(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|few|several|couple of)\s+)?(?:days?|weeks?|months?|quarters?|years?|decades?)\b|\bsince\b|\bup to date\b/i;

/**
 * Reads a goal and returns what Juno would otherwise decide on the reader's
 * behalf, most consequential first.
 *
 * The order is the substance. Permissions come first because they are the only
 * answer that changes what the run is *allowed* to do rather than what it
 * chooses to do; then the irreversible act, because sending the wrong thing is
 * the one outcome no later run can take back; then breadth and recency, which
 * are about spending the ceiling well. A reader who reads only the first row
 * has read the most important one.
 *
 * Returns an empty list far more often than not, and that is the correct
 * answer rather than a failure to find one — "summarise this idea for me"
 * commits to nothing worth asking about.
 */
export function derivePreflightQuestions(input: WorkPreflightInput): WorkPreflightQuestion[] {
  const { body, block } = splitClarifications(input.goal);
  const text = body.trim();
  if (text.length === 0) return [];

  const questions: WorkPreflightQuestion[] = [];

  // 1. An app the reader has connected, named in the task, switched off for it.
  //
  // The switch defaults to off for a good reason — a task should reach what it
  // was handed and nothing else — but "clean up my GitHub" with GitHub switched
  // off is a run that will narrate its way through a plan it can never start.
  // That exact failure is written up in `inference.ts`; this is the question
  // that stops it before the twenty minutes are spent.
  for (const connector of input.connectors) {
    if (input.selectedConnectorIds.includes(connector.id)) continue;
    const pattern = namePattern(connector);
    if (!pattern || !pattern.test(text)) continue;
    questions.push({
      id: `reach_${connector.id}`,
      question: `This mentions ${connector.label}. Should the task be able to reach it?`,
      options: [
        { label: `Yes — switch ${connector.label} on for this task`, recommended: true },
        { label: "No — work only from what is in the task" },
      ],
      grantsConnectorId: connector.id,
    });
  }

  // 2. Something goes out to another person.
  //
  // Gated on there being something to send *from*, because asking whether to
  // send an email that could only ever have been a draft is a question with one
  // answer. Either reading counts: `inferCapabilities` saying `connectors`, or
  // the loop above having found an app the reader named. The second is the more
  // reliable of the two here — inference.ts's connector patterns are
  // word-bounded singulars, so "reply to all my unread emails" reads as nothing
  // at all while the alias above matches it — and a question this consequential
  // should not turn on which of the two spellings the reader happened to use.
  //
  // "Draft" already in the goal means the reader has answered it themselves.
  //
  // And gated on the account having linked something, which the two readings
  // above cannot establish between them: `inferCapabilities` fires `connectors`
  // on the word "Slack" whether or not Slack has ever been connected, so a
  // reader with nothing linked was being asked whether to send a message that
  // could only ever have been a draft — the exact question with one answer that
  // the paragraph above rules out.
  const canReachSomeone =
    input.connectors.length > 0 && (input.inferred.includes("connectors") || questions.length > 0);
  if (canReachSomeone && OUTWARD_ACT.test(text) && !/\bdrafts?\b/i.test(text)) {
    questions.push({
      id: "send_or_draft",
      question: "Should Juno send this, or leave it for you to send?",
      options: [
        { label: "Leave it as a draft for you to send", recommended: true },
        { label: "Send it once it is ready" },
      ],
    });
  }

  // 3. A task whose size is "all of them".
  //
  // The recommendation is the one the ceilings make true anyway: a run stops at
  // twenty minutes whether or not anybody decided it should, and the only
  // choice is whether it stops having done the first slice properly or having
  // done all of them badly. Saying so here is cheaper than discovering it in a
  // `budget_exceeded` at the end.
  if (BREADTH.test(text)) {
    questions.push({
      id: "breadth",
      question: "How much should one run get through?",
      options: [
        { label: "As much as fits, then say what is left", recommended: true },
        { label: "A small sample first, so you can check the approach" },
      ],
    });
  }

  // 4. Research with no date in it. Cheap to answer, and it changes which
  //    sources come back rather than merely how they are worded.
  if (input.inferred.includes("web_research") && !TIMEFRAME.test(text)) {
    questions.push({
      id: "recency",
      question: "How recent do the sources need to be?",
      options: [
        { label: "The last 12 months", recommended: true },
        { label: "The last five years" },
        { label: "Any age — whatever is most authoritative" },
      ],
    });
  }

  // Anything already answered is dropped rather than re-asked. The block is the
  // record of what the reader decided, and a card that re-put a question they
  // have visibly answered would read as Juno not having heard them.
  return questions
    .filter((question) => !block.includes(question.question))
    .slice(0, MAX_PREFLIGHT_QUESTIONS);
}

/** The recommendation, which is what every question opens on. */
export function recommendedOption(question: WorkPreflightQuestion): WorkPreflightOption {
  return question.options.find((option) => option.recommended === true) ?? question.options[0];
}

/**
 * One line of the appended block, in the shape
 * `formatPreflightClarificationVisibleMessage` writes.
 *
 * Kept identical on purpose: a second block appended after a later edit has to
 * be indistinguishable from the first, or the goal grows two formats and
 * whoever reads it next has to know both.
 */
function answerLine(answer: PreflightClarificationAnswer): string {
  const label = answer.question ?? answer.questionId;
  const value = typeof answer.value === "string" ? answer.value.trim() : "";
  return value ? `- ${label}: ${value}` : "";
}

/**
 * Puts the answers into the goal text, and returns it for the textarea.
 *
 * The first set opens the block through the shared formatter; a later set is
 * appended to the block that is already there rather than starting a second
 * one, because a reader who answered, edited their sentence and answered again
 * has made two decisions and must keep both.
 *
 * Returns the goal unchanged when there is nothing to add, so the caller can
 * apply this unconditionally without checking first.
 */
export function appendClarifications(
  goal: string,
  answers: readonly PreflightClarificationAnswer[]
): string {
  const lines = answers.map(answerLine).filter(Boolean);
  if (lines.length === 0) return goal;

  const { block } = splitClarifications(goal);
  if (block.length > 0) return `${goal.replace(/\s+$/, "")}\n${lines.join("\n")}`;
  return (
    formatPreflightClarificationVisibleMessage({
      originalUserMessage: goal,
      answers: [...answers],
    }) ?? goal
  );
}

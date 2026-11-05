/**
 * What an agent is told when it answers a text, and how its answer is
 * cleaned for iMessage.
 *
 * The answer runs headless through `runUtilityPrompt`: the agent's own
 * prompt block (persona, brief, goals, kept notes) and its recent thread, and
 * no tools. So a text can be talked about and answered, never acted on; the
 * prompt says so, and says where to go to act.
 *
 * Pure, so the tests read the prompt and the cleaning directly.
 */

/** Recent thread turns the answer sees. */
export const TEXT_REPLY_HISTORY = 12;
/** Each history turn, cut to this many characters. */
const HISTORY_TURN_CHARS = 1_200;
export const TEXT_REPLY_MAX_TOKENS = 700;
/** The answer as sent: a text, not a document. */
export const TEXT_REPLY_MAX_CHARS = 1_600;

const TEXT_CHANNEL_RULES = [
  "The person is texting you from iMessage, away from the app. Answer as a short text message: plain sentences, no markdown, no headings, no tables, no code blocks.",
  "You have no tools in this conversation. You cannot start tasks, send, buy, delete, change settings or approve anything from here, and you must not say that you did or will.",
  "If they ask you to do something that needs a tool or an approval, say so in one sentence and tell them to open the app, where you can do it with them.",
  "A text never approves anything. If they reply \"yes\", \"approve\" or similar to an approval, tell them approvals are only given on the card in the app.",
].join("\n");

export function textReplySystem(agentBlock: string): string {
  return `${agentBlock}\n\n${TEXT_CHANNEL_RULES}`;
}

export interface HistoryTurn {
  role: "USER" | "ASSISTANT" | string;
  content: string;
}

export function textReplyUserMessage(history: readonly HistoryTurn[], text: string): string {
  const lines = history
    .filter((turn) => turn.role === "USER" || turn.role === "ASSISTANT")
    .map((turn) => `${turn.role === "USER" ? "Person" : "You"}: ${turn.content.replace(/\s+/g, " ").trim().slice(0, HISTORY_TURN_CHARS)}`);
  const recent = lines.length > 0 ? `Your thread so far (oldest first):\n${lines.join("\n")}\n\n` : "";
  return `${recent}The person just texted:\n${text}`;
}

/**
 * The answer as a text: markdown emphasis, headings and fences dropped,
 * whitespace collapsed, cut on a word near the limit. Null when nothing is
 * left, which the caller treats as no answer.
 */
export function cleanTextReply(raw: string): string | null {
  let text = raw
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text) return null;
  if (text.length > TEXT_REPLY_MAX_CHARS) {
    const cut = text.slice(0, TEXT_REPLY_MAX_CHARS - 1);
    const space = cut.lastIndexOf(" ");
    text = `${(space > TEXT_REPLY_MAX_CHARS * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
  }
  return text;
}

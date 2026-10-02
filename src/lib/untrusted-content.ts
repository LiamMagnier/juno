/**
 * Marking content that Juno did not author and the user did not type.
 *
 * The problem: a connector tool result or a fetched web page arrives as plain
 * text in the model's context, indistinguishable from an instruction the user
 * wrote. Up to 5 connectors are live per turn, each acting with the user's own
 * credentials, and write tools already ship (calendar delete, playlist add,
 * GitHub repo scope, Notion page updates). So an attacker who can put text
 * anywhere Juno reads — a GitHub issue body, a web page, a calendar invite —
 * gets to try instructing the model.
 *
 * This does not *solve* prompt injection; nothing does. It removes the easiest
 * version of it, where hostile text is simply believed because it is
 * syntactically identical to a real instruction.
 *
 * Why a fixed sentinel rather than a per-request nonce, which would be stronger:
 * the rule has to live in the system prompt, and buildSystemPrompt is
 * deliberately byte-identical across requests because it heads every provider's
 * cached prefix (see the comment on it). A nonce would change that prefix every
 * turn and destroy prompt caching on every provider at once. The fixed sentinel
 * is therefore paired with neutralisation: any occurrence of the marker inside
 * the content itself is defanged, so hostile text cannot close the envelope
 * early and "escape" into instruction position.
 */

const SENTINEL = "JUNO_UNTRUSTED";

export const UNTRUSTED_OPEN = `<<<${SENTINEL}_BEGIN>>>`;
export const UNTRUSTED_CLOSE = `<<<${SENTINEL}_END>>>`;

/**
 * The system-prompt rule. Constant by construction — see the note above about
 * the cached prefix. Included only on turns where untrusted content can
 * actually appear, so a plain chat keeps its original prefix. Its text lives in
 * `src/lib/web/untrusted-rule.prompt.ts` (model-facing text, INV-29); the
 * markers it names are asserted equal to these by `tests/untrusted-content.test.ts`.
 */
export { UNTRUSTED_CONTENT_RULE } from "@/lib/web/untrusted-rule.prompt";

/**
 * Neutralise anything that looks like our markers so hostile content cannot
 * terminate its own envelope. A zero-width space inside the token is enough to
 * break the literal match while leaving the text readable to the model.
 */
function defang(content: string): string {
  return content.replace(new RegExp(SENTINEL, "gi"), `JUNO​_UNTRUSTED`);
}

/**
 * Wrap untrusted text in the envelope.
 *
 * @param label what produced it, e.g. "github__list_issues" or a URL — shown to
 *              the model so it can attribute the content in its answer.
 */
export function wrapUntrusted(label: string, content: string): string {
  return [`${UNTRUSTED_OPEN} source=${defang(label)}`, defang(content), UNTRUSTED_CLOSE].join("\n");
}

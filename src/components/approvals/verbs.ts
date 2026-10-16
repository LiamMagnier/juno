/**
 * The approval verbs (spec P2 (17), §6.18): the primary button says what will
 * happen, never "Approve" or "Allow". One list, read from the shared string
 * table, so the web, the Mac and the iPhone ask with the same words.
 *
 *   run            Run
 *   editFiles      Edit {n} files
 *   send           Send
 *   deleteForGood  Delete for good
 *   buy            Buy
 */

import { shellString } from "@/lib/strings";

export type ApprovalVerb =
  | { kind: "run" }
  | { kind: "editFiles"; n: number }
  | { kind: "send" }
  | { kind: "deleteForGood" }
  | { kind: "buy" };

export type ApprovalVerbKind = ApprovalVerb["kind"];

export const APPROVAL_VERB_KINDS = ["run", "editFiles", "send", "deleteForGood", "buy"] as const satisfies readonly ApprovalVerbKind[];

const KEYS = {
  run: "approval.run",
  editFiles: "approval.editFiles",
  send: "approval.send",
  deleteForGood: "approval.deleteForGood",
  buy: "approval.buy",
} as const;

/** The verb's label in `locale` (English and French from the table; other languages translate English). */
export function approvalVerbLabel(verb: ApprovalVerb, locale: string = "en"): string {
  return verb.kind === "editFiles" ? shellString(KEYS.editFiles, { n: verb.n }, locale) : shellString(KEYS[verb.kind], {}, locale);
}

/** Verbs whose consequence cannot be taken back: the caret's standing grant is not offered for them. */
export function isIrreversibleVerb(verb: ApprovalVerb): boolean {
  return verb.kind === "deleteForGood" || verb.kind === "buy";
}

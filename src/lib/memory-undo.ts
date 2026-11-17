/*
 * WHAT "FORGET" AND A CHAT'S "UNDO" DO TO ONE MEMORY, as one pure rule.
 *
 * `PATCH /api/memory/[id]` with `forget` used to treat every row the same
 * way: retire it as suppressed and write a block-list entry. That is right for
 * Forget on the memory page, and right for Undo on a fact a turn created. It
 * is wrong for Undo on a fact the turn only BELIEVED AGAIN (reinstated): the
 * person had said "lives in Lisbon" before, then "lives in Porto", then
 * "Lisbon" again. Undo on that third turn has to put memory back as it was
 * before the turn, which is Lisbon as history and Porto believed. It used to
 * block-list "lives in Lisbon" for good, a statement the person made before
 * that turn and never asked to forget.
 *
 * The receipt names the rows a turn reinstated (`reinstated` on
 * ClientMemoryReceipt), and the route asks this function what to do.
 */

export type ForgetPlan =
  /**
   * Retire the row as suppressed and block-list its statement. With
   * `restoreReplaced`, whatever the row had replaced is believed again: a
   * chat's Undo on a fact the turn created, while it is still believed.
   */
  | { kind: "forget"; restoreReplaced: boolean }
  /**
   * Undo of a reinstatement: the row goes back to history (`superseded`), no
   * block-list entry is written, and what it took the slot back from is
   * believed again. Said again later, it can be learned again.
   */
  | { kind: "unbelieve" }
  /**
   * Nothing to take back: the reinstated row is no longer believed (something
   * newer replaced it, or it was forgotten since), so memory is already not
   * what the turn made it.
   */
  | { kind: "nothing" };

export function forgetPlan(
  row: { status: string },
  request: { undo?: boolean; reinstated?: boolean }
): ForgetPlan {
  const believed = row.status === "active";
  if (request.undo && request.reinstated) return believed ? { kind: "unbelieve" } : { kind: "nothing" };
  // Only while this fact is still the one believed. An Undo pressed on an old
  // receipt after something newer replaced it must not bring back what it
  // replaced beside the newer fact: that would be two answers to one question.
  return { kind: "forget", restoreReplaced: request.undo === true && believed };
}

/** Why a reinstated row is history again, in the words the memory page shows. */
export const UNBELIEVED_REASON = "Undone in the chat where you said it again.";

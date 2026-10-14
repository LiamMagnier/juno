import type { ServerEventEnvelope } from "./contracts";

/**
 * A hub whose global numbering restarted serves its retained tail when the
 * caller's cursor is ahead. Sequential poll/stream batches may therefore have
 * a lower maximum global sequence. Rebase only that stream; a session's own
 * log and cursor survive the relay restart. Equal/overlapping batches still
 * use the existing cursor so ordinary retries can be dropped as duplicates.
 *
 * This does not detect a restart whose new sequence has already caught up with
 * the old cursor: that requires an epoch in the wire protocol.
 */
export function rebaseGlobalCursor(cursor: number, events: readonly ServerEventEnvelope[]): number {
  let newest: number | undefined;
  for (const event of events) {
    if (event.stream === "global") newest = Math.max(newest ?? -1, event.sequence);
  }
  return newest !== undefined && newest < cursor ? -1 : cursor;
}

/**
 * What a turn's items become when the process stopped under it.
 *
 * A turn's own ending settles everything it started: a command gets its exit
 * code, a message stops streaming. A turn that was cut off (the env server was
 * killed, the Mac lost power) never got to, so its log still holds a command
 * that "is running" and a message that "is streaming". Every client reads
 * those as live work: the thread says "Working for 3h" and counts up.
 *
 * This is the same set a client treats as live (`isLive` in the web's
 * `turns.ts`, the native fold): keep the two in step.
 */
import type { TurnItem } from "../contracts/code-v2.js";

/** What the thread says where a cut-off turn stops. Reads after the row's verb, "Stopped". */
export const CUT_OFF_MESSAGE = "Alevr Code closed before this turn finished. Send a message to continue.";

/**
 * The settled copy of an item that was still live, or null when the item was
 * already settled (or is another turn's).
 */
export function settledCopy(item: TurnItem, turnId: string): TurnItem | null {
  if (item.turnId !== turnId) return null;
  switch (item.kind) {
    case "assistant_message":
    case "reasoning":
      return item.streaming ? { ...item, streaming: false } : null;
    case "command_execution":
    case "file_change":
    case "search":
    case "web_search":
    case "computer_action":
      return item.status === "running" || item.status === "pending" ? { ...item, status: "interrupted" } : null;
    case "subagent":
      return item.status === "running" || item.status === "waiting" ? { ...item, status: "interrupted" } : null;
    default:
      return null;
  }
}

import type { ClientActionApproval } from "@/lib/action-approval";

/**
 * One approval callback from several: the toolset's (the route's, which sends
 * the card and pauses the stall watchdog) and the dispatcher's per-call one
 * (which marks the row as waiting). Every one fires, in the order given.
 *
 * Pure, and outside `mcp.ts`, because the runtime registry composes the same
 * pair and must stay importable without a server runtime.
 */
export function composeApprovalCallbacks(
  ...callbacks: Array<((approval: ClientActionApproval) => void) | undefined>
): ((approval: ClientActionApproval) => void) | undefined {
  const present = callbacks.filter((callback): callback is (approval: ClientActionApproval) => void => !!callback);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return (approval) => {
    for (const callback of present) callback(approval);
  };
}

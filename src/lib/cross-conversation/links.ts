import { parseConversationRef } from "./policy";

/**
 * Where another conversation opens on the web, from its ref. Only a Chat has
 * a page there by its id; Code sessions live on the Mac and open in its app,
 * so their rows name them without a link.
 */
export function peerHrefForRef(ref: string): string | null {
  const parsed = parseConversationRef(ref);
  return parsed?.kind === "chat" ? `/chat/${encodeURIComponent(parsed.id)}` : null;
}

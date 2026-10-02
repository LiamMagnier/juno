import { notFound } from "next/navigation";
import { ThreadScene } from "./thread-scene";

/**
 * Dev-only thread scene: the REAL AppShell, MessageList, MessageItem,
 * WorkRunPanel and ApprovalCard over the gallery thread's fixture (the Q3
 * renewal conversation), so production can be compared side by side with the
 * V3 gallery's thread renders at the same frame, in both themes, signed out.
 *
 *   ?scene=thread     the settled answer, a task waiting for your answer at
 *                     step 2 of 4, and an approval to post to Slack (default)
 *   ?scene=thinking   a reply working before its first word: the live line
 *                     with the Continuum mark, and a task card running
 *   ?scene=settled    the same turns after the decisions: the approval's
 *                     receipt and a finished task
 *
 * Not linked from anywhere and 404s outside development.
 */
export default async function ThreadDevPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const { scene } = await searchParams;
  const which = scene === "thinking" || scene === "settled" ? scene : "thread";
  return <ThreadScene scene={which} />;
}

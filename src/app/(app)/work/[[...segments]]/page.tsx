import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { chatPathForSession, resolveWorkUrl, type WorkUrlQuery } from "@/lib/work-url-migration";

/**
 * Everything that used to be `/work`, in one route.
 *
 * Six page trees came out of this segment and one file went back in. An
 * optional catch-all answers `/work` and every path under it, so the six
 * `page.tsx` files that would otherwise each hold a one-line redirect are one
 * file and one map (`src/lib/work-url-migration.ts`) — which is what makes the
 * map testable, and what stops the next person having to open five other files
 * to answer "where does this URL go".
 *
 * A route rather than `redirects()` in next.config.mjs, because one of these
 * destinations is a database row: `/work/<sessionId>` lands on the conversation
 * that session points at, and that pointer is per-account. Putting the static
 * half in the config would have left half the answer somewhere the other half
 * does not mention.
 *
 * `redirect()` issues a 307, deliberately, even for paths that are never coming
 * back. A 308 is cached by the browser permanently and cannot be withdrawn —
 * and `/work/skills` is linked from a SHIPPED macOS build, so the URL with the
 * longest tail is also the one Juno would least like hard-wired into a cache it
 * cannot reach. It matters more for `/work/<sessionId>`, which is not legacy at
 * all: two live surfaces link through it because a session id is all they hold,
 * and its answer changes when the session's conversation does. A permanently
 * cached redirect on that path would be a wrong answer with no way to correct
 * it.
 *
 * It sits inside `(app)`, so the layout has already run `requireUser` and a
 * signed-out visitor is bounced to sign-in before any of this evaluates. The
 * second `requireUser` below is not a second gate; it is how the session lookup
 * gets a user id to scope itself to.
 */
export default async function WorkUrlRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ segments?: string[] }>;
  searchParams: Promise<WorkUrlQuery>;
}): Promise<never> {
  const [{ segments }, query] = await Promise.all([params, searchParams]);
  const target = resolveWorkUrl(segments, query);
  if (target.kind === "path") redirect(target.path);

  const user = await requireUser();
  const session = await prisma.workSession.findFirst({
    where: { id: target.sessionId, userId: user.id },
    select: { conversationId: true },
  });
  // A task that was deleted, or that belongs to somebody else, gets the 404 —
  // the same answer `/research/<id>` gives, and the only honest one. Bouncing a
  // deleted task to the chat index would tell the reader their link still works
  // and leave them hunting that list for something that is not in it.
  if (!session) notFound();
  redirect(chatPathForSession(session.conversationId));
}

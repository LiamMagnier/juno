/**
 * Where a `/work` URL goes now that Work is not a place.
 *
 * Work became a mode of a conversation (docs/design/TWO_PRODUCTS.md §2) and the
 * six route families under `/work` were deleted. Deleting a URL and deleting a
 * PAGE are different acts, and only the second one happened here: every one of
 * these paths is sitting in somebody's history, in a notification email Juno
 * sent last week, in a search result, and — for `/work/skills` — hard-coded in
 * a shipped macOS build (`DesktopWorkWorkspace.swift`), which cannot be
 * corrected retroactively. A 404 on any of them would read as "Juno lost your
 * work", which is the one thing this merge must not say.
 *
 * WHY A PURE FUNCTION AND NOT `next.config.mjs` REDIRECTS. Most of the map is
 * static and could have been nine entries in `redirects()`. One of them is not:
 * `/work/<sessionId>` resolves to the conversation that session points at,
 * which is a row in the database, owner-scoped. Splitting the map across a
 * config file and a route would mean two places to read to answer "where does
 * this URL go", and the static half is the half nobody would remember to check.
 * So the whole map is here, exercised by tests/work-url-migration.test.ts, and
 * the route beside it is the only thing that touches Prisma.
 *
 * ONE OF THESE URLS IS NOT LEGACY. `/work/<sessionId>` is still LINKED, on
 * purpose, from the automation editor's run rows and from a schedule row's "Its
 * task" — because those rows carry a `WorkSession.id` and nothing else, and
 * turning one into a conversation is precisely the owner-scoped lookup a client
 * cannot do. Baking a conversation id into those links instead would put a
 * stale pointer in the markup the first time somebody deleted the conversation.
 * So this is both a migration map and the product's session-to-conversation
 * resolver, and the second job is why it will outlive the first.
 *
 * WHAT HAPPENS TO THE QUERY STRINGS.
 *
 *   `?project=<id>` is carried. `/chat` reads it (src/app/(app)/chat/page.tsx)
 *   and starts the new conversation inside that project, which is exactly what
 *   `/work?project=` meant.
 *
 *   `?show=<triage state>` is dropped, and this is the one place the old URL
 *   loses meaning. It selected one of seven pills on the inbox — needs_you,
 *   in_progress, scheduled, unread, done, all, archived — and the inbox is the
 *   surface being removed. Exactly one of those states has a home in the new
 *   shell: "Needs you", as the fold that sits above Today in the sidebar and
 *   filters the panel in place when its header is pressed. Carrying the
 *   parameter over would mean the sidebar reading `useSearchParams`, and the
 *   sidebar is rendered by the (app) LAYOUT rather than by a page — so it would
 *   need a Suspense boundary wrapped around the whole shell to keep the routes
 *   under it prerenderable (the inbox page had exactly that boundary, for
 *   exactly this hook). A boundary around the application frame, to restore one
 *   of seven filters on a list that no longer exists, is a worse trade than
 *   landing on `/chat` — where, if anything is waiting, the fold is already the
 *   first thing in the column.
 *
 *   `?run=` and `?event=` are dropped, for a reason the destination states
 *   itself: `useConversationWork` follows a conversation's NEWEST task and says
 *   so in its own docblock, and `WorkRunPanel` draws the event stream with no
 *   per-step anchor. A parameter naming a run and a step would be a promise the
 *   page cannot keep. The search row that emits these URLs keeps its "Step 12"
 *   locator, so the reader is still told which step matched before they press.
 */

/** The two kinds of answer: a path we can build here, or a row to look up. */
export type WorkUrlTarget =
  /** Ready to redirect to, query string included. */
  | { kind: "path"; path: string }
  /**
   * A `WorkSession.id`. The caller resolves it to `WorkSession.conversationId`
   * against the signed-in user and hands the result to `chatPathForSession`;
   * the lookup is owner-scoped so this URL cannot be used to probe whether
   * somebody else's session exists.
   */
  | { kind: "session"; sessionId: string };

/** The subset of a Next.js `searchParams` object this map reads. */
export type WorkUrlQuery = Record<string, string | string[] | undefined>;

/** The first value of a repeated parameter, or undefined when it is absent. */
function first(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * `base`, plus at most one more segment.
 *
 * ONE, because that is as deep as any of these families ever went: `new`, or an
 * id. Forwarding a deeper path verbatim would turn a URL that never existed
 * into a 404 on the new tree, which is the single outcome this module exists to
 * prevent — the family's index is the truthful answer instead.
 *
 * The segment is re-encoded. Next hands `params` already percent-decoded, so an
 * id that arrived encoded would otherwise be emitted raw into a `Location`
 * header.
 */
function joinPath(base: string, rest: readonly string[]): string {
  const [next] = rest;
  return next === undefined ? base : `${base}/${encodeURIComponent(next)}`;
}

/**
 * Where `/work/<segments>?<query>` should land.
 *
 * The families, and what each one was:
 *
 *   `/work`                      the inbox            → `/chat`
 *   `/work/<sessionId>`          one task's thread    → its conversation
 *   `/work/skills`               the skill library    → `/skills`
 *   `/work/skills/new`           the skill editor     → `/skills/new`
 *   `/work/skills/<skillId>`     one skill            → `/skills/<skillId>`
 *   `/work/schedules`            recurring work       → `/automations`
 *   `/work/schedules/new`        the editor           → `/automations/new`
 *   `/work/schedules/<id>`       one automation       → `/automations/<id>`
 *   `/work/permissions`          the permissions hub  → `/permissions`
 *   `/work/hosts`                the Macs list        → `/permissions`
 *   `/work/hosts/<hostId>`       one Mac              → `/permissions/<hostId>`
 *
 * That is every shape this product ever served under `/work`, and it is the
 * whole of what `[[...segments]]` can be handed.
 *
 * `/work/hosts` already redirected to `/work/permissions` before this merge;
 * it is answered directly here rather than chained, because a redirect to a
 * redirect costs a second round trip for a URL that is in the composer's own
 * refusal notes.
 *
 * ANYTHING ELSE falls back rather than 404ing: to the family's index when the
 * first segment names one, and to `/chat` when it does not. A URL shape that
 * was never real cannot be a bookmark, so there is no history to honour and
 * nothing to explain — but forwarding its extra segments verbatim would turn a
 * path that used to 404 under `/work` into one that 404s under `/skills`, which
 * moves the dead end rather than removing it.
 */
export function resolveWorkUrl(
  segments: readonly string[] | undefined,
  query: WorkUrlQuery = {}
): WorkUrlTarget {
  const [head, ...rest] = segments ?? [];

  if (!head) return { kind: "path", path: chatIndexPath(query) };

  switch (head) {
    case "skills":
      return { kind: "path", path: joinPath("/skills", rest) };
    case "schedules":
      return { kind: "path", path: joinPath("/automations", rest) };
    case "permissions":
      // The hub had no children, so anything deeper is a typed URL, not a
      // bookmark. It gets the hub.
      return { kind: "path", path: "/permissions" };
    case "hosts":
      // One Mac keeps its own page; the index folded into the hub.
      return { kind: "path", path: joinPath("/permissions", rest) };
    default:
      // A single unrecognised segment is a session id — that was the shape of
      // every task thread. Deeper than that was never served.
      return rest.length === 0
        ? { kind: "session", sessionId: head }
        : { kind: "path", path: chatIndexPath(query) };
  }
}

/** `/chat`, carrying the one parameter it shares with the old inbox. */
function chatIndexPath(query: WorkUrlQuery): string {
  const project = first(query.project);
  return project ? `/chat?project=${encodeURIComponent(project)}` : "/chat";
}

/**
 * Where a resolved task thread lands.
 *
 * A session with no conversation behind it goes to the Chat index rather than
 * to a conversation invented for it. `WorkSession.conversationId` is null for
 * every session the old Work composer created — the web create route never set
 * it (docs/design/TWO_PRODUCTS.md §2.1) — so this is not an edge case, it is
 * most of the history of the account. Those tasks still exist, still ran and
 * are still listed; they simply have no transcript to open, and `/chat` is
 * where the reader can see everything that does.
 */
export function chatPathForSession(conversationId: string | null | undefined): string {
  return conversationId ? `/chat/${encodeURIComponent(conversationId)}` : "/chat";
}

import { redirect } from "next/navigation";

/**
 * `/work/hosts` — kept as a redirect rather than deleted.
 *
 * The Macs list moved into `/work/permissions`, which is the subject it was
 * always a part of: "which machines" is one of three questions about what Juno
 * is allowed to do, and it was the only one with a page. The URL stays because
 * it was linked — from the composer's refusal notes, from the native apps, and
 * from whatever bookmarks somebody made while this was the only page in the
 * browser that admitted these machines exist. A 404 on a URL that worked
 * yesterday is the cheapest kind of broken and the easiest to avoid.
 *
 * A server redirect rather than a client one, so it costs no bundle and no
 * flash of a page that is about to leave.
 *
 * `/work/hosts/[id]` is deliberately untouched. A single Mac still has its own
 * page with its own toggles, grants and revoke control; the permissions hub
 * links to it. Only the index moved.
 *
 * The `loading.tsx` and `error.tsx` that sat beside this file are gone with it:
 * a segment that only ever redirects can neither be slow nor throw.
 */
export default function WorkHostsRedirect(): never {
  redirect("/work/permissions");
}

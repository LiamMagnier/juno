/**
 * The root 404 — everything that is not a known route, signed in or not.
 *
 * Without this file an unknown URL fell through to Next's built-in page:
 * Helvetica, pure white, a vertical rule, no Juno type, ground or mark. It was
 * the one screen in the product that looked like a framework default, and it is
 * ten seconds away from the address bar.
 *
 * It renders under the ROOT layout, so fonts, theme and tokens are live but
 * there is no sidebar. That is deliberate: a 404 can be hit signed out. The two
 * actions therefore point at routes that will bounce an anonymous visitor to
 * sign-in, which is the right destination for them anyway — we do not read the
 * session here, because `not-found.tsx` may not be async.
 *
 * tone stays the default "empty", not "error": a 404 is not a failure, it is a
 * page that is genuinely not there. Same reading as
 * `src/app/(app)/chat/[id]/not-found.tsx`.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { SearchX } from "@/components/ui/icons";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

export const metadata: Metadata = { title: "Not found" };

export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-16 text-center">
      {/* Settles in on the shared entrance rather than appearing at full
          weight: this is a whole-screen replacement, the one moment on a
          dead link where a hard cut reads as the site breaking. */}
      <div className="w-full max-w-md motion-safe:animate-rise-in">
        <EmptyState
          icon={SearchX}
          title="This page isn’t here"
          description="The link may be out of date, or the address may have a typo in it. Nothing in your account has changed."
          // One primary action. The library link stays as a quiet ghost
          // beside it: an unknown URL is most often a stale link to something
          // the reader saved, but the way home is the answer the page leads
          // with.
          action={
            <>
              <Button asChild size="sm">
                <Link href="/chat">Back to chat</Link>
              </Button>
              <Button asChild size="sm" variant="ghost" className="text-muted-foreground hover:text-foreground">
                <Link href="/library">Open your library</Link>
              </Button>
            </>
          }
        />
      </div>
    </main>
  );
}

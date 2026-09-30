/**
 * What a public link shows when it is real but no longer serves: its artifact
 * is in Recently deleted, the owner unpublished it, or the owner reset the
 * link and this is the retired token. (Taken from artifacts/r1-lifecycle.)
 *
 * Not a 404. The token is real and may serve again: restoring the artifact or
 * publishing it again brings the same link back, untouched (a reset token
 * never does). A visitor who had it open, or was sent
 * it yesterday, deserves a sentence that says the page was taken down rather
 * than one that reads as a typo in the address. It says nothing about why or
 * whether it will return; that is between Juno and the owner, exactly as a
 * revocation is.
 *
 * It renders nothing from the share, not even its title: the owner deleted the
 * thing, and its name is part of it. The page's metadata says the same
 * (`src/app/share/[token]/page.tsx`), and every share page is noindex, this
 * one included.
 *
 * App Router cannot set a 410 on a page, so this renders at 200; the poster
 * beside it answers a true 410.
 *
 * tone stays "empty", not "error": nothing broke. Laid out like the root 404,
 * which a signed-out visitor might also meet, with the share page's two ways
 * out: into Juno, or an account of their own.
 */

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Link2Off } from "@/components/ui/icons";

export function ShareGone() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-background px-4 py-16 text-center text-foreground">
      <div className="w-full max-w-md">
        <EmptyState
          icon={Link2Off}
          title="This page isn’t shared any more"
          description="Whoever shared it has taken it down, so there’s nothing to show here right now."
          action={
            <>
              <Button asChild size="sm">
                <Link href="/">Open Juno</Link>
              </Button>
              <Button asChild size="sm" variant="ghost" className="text-muted-foreground hover:text-foreground">
                <Link href="/sign-up">Create your own account</Link>
              </Button>
            </>
          }
        />
      </div>
    </main>
  );
}

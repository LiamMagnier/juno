import Link from "next/link";

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { PullsList } from "@/components/code/pulls-list";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { Button } from "@/components/ui/button";
import { AppIcons } from "@/lib/app-icons";

export const dynamic = "force-dynamic";

/**
 * `/code/pulls` — the second view of the Code surface, no longer an orphan.
 *
 * What changed here is IA, not capability: `PullsList` still owns every one of
 * its states (loading, disconnected, unauthorized, error, empty, and the two
 * grouped sections). What it lost is being a dead end. The page used to be
 * reachable only from the sidebar rail and the command palette, both of which
 * pointed here because `/code` had no page to point at — so a list of OUTCOMES
 * was standing in as the front door of the feature that produces them.
 *
 * It is a destination of its own now, reached from More in the Code sidebar.
 * The view switcher it used to share with the run list went with that list: a
 * tab row says "these two things are one surface seen twice", and with one of
 * the two deleted it was a row of tabs containing a single tab. The
 * `AppPage measure="wide"` column stays — it is what the rest of the product is
 * read at, and the landing's full-height composer is the exception, not this.
 */
export default async function CodePullsPage() {
  const user = await requireUser();
  const github = await prisma.connection.findFirst({
    where: { userId: user.id, provider: "github" },
    select: { accountLabel: true },
  });

  return (
    <AppPage measure="wide">
      <AppPageHeader
        eyebrow="Code"
        heading="Pull requests"
        lede="What your runs opened on GitHub, plus anything else waiting on your review."
        // The way back to the thing that produces this list. It matters most
        // when the list is empty, which is exactly when it is least obvious
        // that pull requests come from runs — and with the tab row gone it is
        // the only route back on this page. It points at `/code`, which is now
        // the composer itself rather than a page with a composer on it.
        actions={
          <Button asChild className="gap-1.5">
            <Link href="/code">
              <AppIcons.new className="size-4" aria-hidden="true" /> New task
            </Link>
          </Button>
        }
      />

      {/* The disconnected state is PullsList's own `disconnected` phase — it
          was written out a second time on this page once, byte-for-byte, and a
          sentence with two homes drifts. This hands the fact down instead. */}
      <PullsList account={github?.accountLabel ?? null} connected={!!github} />
    </AppPage>
  );
}

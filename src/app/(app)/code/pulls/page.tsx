import Link from "next/link";

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { PullsList } from "@/components/code/pulls-list";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { CodeSurfaceNav } from "@/components/code/code-surface-nav";
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
 * It now sits under the same header and the same view switcher as the run list,
 * in the same `AppPage measure="wide"` column, so the two read as one surface
 * and the shell does not resize when a reader changes tabs.
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
        icon={AppIcons.code}
        lede="What your runs opened on GitHub, plus anything else waiting on your review."
        // The way back to the thing that produces this list. It matters most
        // when the list is empty, which is exactly when it is least obvious
        // that pull requests come from runs. Same primary action as `/code`,
        // byte for byte, so the two tabs of one surface agree about what the
        // primary thing to do here is.
        actions={
          <Button asChild className="gap-1.5">
            <Link href="/code/new">
              <AppIcons.new className="size-4" aria-hidden="true" /> New task
            </Link>
          </Button>
        }
      />
      <CodeSurfaceNav active="pulls" />

      {/* The disconnected state is PullsList's own `disconnected` phase — it
          was written out a second time on this page once, byte-for-byte, and a
          sentence with two homes drifts. This hands the fact down instead. */}
      <PullsList account={github?.accountLabel ?? null} connected={!!github} />
    </AppPage>
  );
}

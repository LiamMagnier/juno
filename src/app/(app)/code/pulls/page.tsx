import Link from "next/link";

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { PullsList } from "@/components/code/pulls-list";
import { AppPageHeader } from "@/components/app/app-page-header";
import { CodeSurfaceNav } from "@/components/code/code-surface-nav";
import { Button } from "@/components/ui/button";
import { AppIcons } from "@/lib/app-icons";

export const dynamic = "force-dynamic";

/**
 * `/code/pulls` — the second view of the Code surface, no longer an orphan.
 *
 * What changed here is IA, not capability: `PullsList` is untouched and still
 * owns every one of its states (loading, disconnected, unauthorized, error,
 * empty, and the two grouped sections). What it lost is being a dead end. The
 * page used to be reachable only from the sidebar rail and the command palette,
 * both of which pointed here because `/code` had no page to point at — so a
 * list of OUTCOMES was standing in as the front door of the feature that
 * produces them.
 *
 * It now sits under the same header and the same view switcher as the run list,
 * at the same column width, so the two read as one surface. The width is
 * `max-w-6xl` to match `/code` exactly — the shell must not resize when a
 * reader changes tabs — while the list itself stays narrow inside it, because a
 * one-line-per-pull-request list set to 72rem is a line the eye cannot track
 * back from.
 */
export default async function CodePullsPage() {
  const user = await requireUser();
  const github = await prisma.connection.findFirst({
    where: { userId: user.id, provider: "github" },
    select: { accountLabel: true },
  });

  return (
    <div className="app-page-scroll">
      <div className="app-page-content max-w-6xl">
        <AppPageHeader
          eyebrow="Code"
          heading="Pull requests"
          icon={AppIcons.pulls}
          lede="What your runs opened on GitHub, plus anything else waiting on your review."
          // The way back to the thing that produces this list. It matters most
          // when the list is empty, which is exactly when it is least obvious
          // that pull requests come from runs.
          actions={
            <Button asChild variant="outline" className="gap-1.5">
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
        <div className="max-w-3xl">
          <PullsList account={github?.accountLabel ?? null} connected={!!github} />
        </div>
      </div>
    </div>
  );
}

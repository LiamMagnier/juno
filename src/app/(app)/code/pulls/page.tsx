import Link from "next/link";

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { PullsList } from "@/components/code/pulls-list";
import { AppPageHeader } from "@/components/app/app-page-header";
import { Button } from "@/components/ui/button";
import { AppIcons } from "@/lib/app-icons";

export const dynamic = "force-dynamic";

export default async function CodePullsPage() {
  const user = await requireUser();
  const github = await prisma.connection.findFirst({
    where: { userId: user.id, provider: "github" },
    select: { accountLabel: true },
  });

  return (
    <div className="app-page-scroll">
      <div className="app-page-content max-w-2xl">
        <AppPageHeader
          eyebrow="Code"
          heading="Pull requests"
          icon={AppIcons.pulls}
          lede="Review the pull requests Juno Code opens from your sessions."
          // The page is a list of outcomes with no way back to the thing that
          // produces them — and the list is empty until a cloud session has
          // opened one, which is exactly when the way in matters most.
          actions={
            <Button asChild variant="outline" className="gap-1.5">
              <Link href="/code/new">
                <AppIcons.new className="size-4" aria-hidden="true" /> New session
              </Link>
            </Button>
          }
        />

        {/* The disconnected state is PullsList's own `disconnected` phase — it
            was written out a second time here, byte-for-byte, and a sentence
            with two homes drifts. This hands the fact down instead. */}
        <PullsList account={github?.accountLabel ?? null} connected={!!github} />
      </div>
    </div>
  );
}

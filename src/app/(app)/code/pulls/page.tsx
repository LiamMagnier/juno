import Link from "next/link";
import { GitPullRequest, Plug } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { PullsList } from "@/components/code/pulls-list";
import { AppPageHeader } from "@/components/app/app-page-header";

export const dynamic = "force-dynamic";

export default async function CodePullsPage() {
  const user = await requireUser();
  const github = await prisma.connection.findFirst({
    where: { userId: user.id, provider: "github" },
    select: { accountLabel: true },
  });

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-4 py-8">
        <AppPageHeader
          eyebrow="Code"
          heading="Pull requests"
          lede="Review the pull requests Juno Code opens from your sessions."
        />

        {github ? (
          <PullsList account={github.accountLabel} />
        ) : (
          <div className="mt-10 flex flex-col items-center gap-4 text-center">
            <GitPullRequest className="h-8 w-8 text-muted-foreground/50" aria-hidden="true" />
            <div className="max-w-sm">
              <p className="font-serif text-heading">Connect GitHub</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Link your GitHub account so Juno can list and track the pull requests your code sessions open.
              </p>
            </div>
            <Button asChild className="gap-1.5">
              <Link href="/connections">
                <Plug className="h-4 w-4" /> Connect GitHub
              </Link>
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

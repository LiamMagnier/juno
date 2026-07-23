import Link from "next/link";
import { ArrowLeft, GitPullRequest, Plug } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { PullsList } from "@/components/code/pulls-list";

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
        <div className="mb-1 flex items-center gap-2">
          <Button asChild variant="ghost" size="icon-sm" aria-label="Back to chat">
            <Link href="/chat">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <span className="font-mono text-label text-muted-foreground">Code</span>
        </div>
        <h1 className="font-serif text-display font-medium tracking-tight">Pull requests</h1>
        <p className="mb-6 mt-1 text-sm text-muted-foreground">
          Review the pull requests Juno Code opens from your sessions.
        </p>

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

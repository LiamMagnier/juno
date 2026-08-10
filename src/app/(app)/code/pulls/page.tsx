import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
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

        {/* The disconnected state is PullsList's own `disconnected` phase — it
            was written out a second time here, byte-for-byte, and a sentence
            with two homes drifts. This hands the fact down instead. */}
        <PullsList account={github?.accountLabel ?? null} connected={!!github} />
      </div>
    </div>
  );
}

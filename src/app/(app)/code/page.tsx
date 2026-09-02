import Link from "next/link";

import { requireUser } from "@/lib/session";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { Button } from "@/components/ui/button";
import { CodeSurfaceNav } from "@/components/code/code-surface-nav";
import { RunList } from "@/components/code/run-list";
import { AppIcons } from "@/lib/app-icons";

export const dynamic = "force-dynamic";

/**
 * `/code` — THE ROUTE THIS PRODUCT DID NOT HAVE.
 *
 * Juno Code shipped as two orphans. `/code/new` composed a task and `/code/pulls`
 * listed pull requests, and there was no page at the root tying them together —
 * a gap the codebase had already noticed twice in its own comments, in
 * `app-sidebar.tsx` ("`/work` is a real page, unlike `/code`, which has no index
 * and is why Code has to land on `/code/new`") and in `command-palette.tsx`
 * ("Work lands on its own index, unlike Code, whose `/code` route has no page").
 * Both of those workarounds are now unnecessary and both have been removed.
 *
 * WHY THE LIST IS THE ROOT AND NOT THE COMPOSER. Landing on the composer says
 * the product is "start a thing"; landing on the list says it is "watch the
 * things you started". For a surface whose entire premise is that several
 * agents are working in parallel somewhere you cannot see, the second is the
 * true one — and the first actively hides the run that stopped to ask you a
 * question ten minutes ago behind a text field.
 *
 * The list is a client island because it polls, streams and takes answers. The
 * page around it stays a server component: it only needs to prove there is a
 * signed-in user and draw the frame.
 *
 * The frame is `AppPage measure="wide"` — the same 64rem column every other
 * list page in the product uses, so moving between Projects, Work and Code
 * never resizes the page. The review pane opens beside the list inside that
 * column (see run-list.tsx), which is why the list keeps its rows short.
 */
export default async function CodePage() {
  await requireUser();

  return (
    <AppPage measure="wide">
      <AppPageHeader
        eyebrow="Code"
        heading="Runs"
        icon={AppIcons.code}
        lede="Every Juno Code run, wherever you started it — this Mac, the cloud, or the app on your phone."
        actions={
          <Button asChild className="gap-1.5">
            <Link href="/code/new">
              <AppIcons.new className="size-4" aria-hidden="true" />
              New task
            </Link>
          </Button>
        }
      />
      <CodeSurfaceNav active="runs" />
      <RunList />
    </AppPage>
  );
}

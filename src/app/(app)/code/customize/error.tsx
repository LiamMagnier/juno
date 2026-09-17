"use client";

/**
 * `/code/customize` when the segment throws.
 *
 * Next requires an error boundary to be a client component taking { error,
 * reset }. `error.message` is deliberately NOT rendered: it can carry a query,
 * a file path, a provider's raw response or an internal identifier, and none of
 * that is something the reader can act on. It goes to the console — and, for a
 * server error, it is already in the server log under `digest`, which is the
 * one identifier worth showing.
 *
 * WHY THIS PAGE NEEDS ITS OWN, when its two lists already report their own
 * failures in place. Without it the boundary that catches a Customize failure
 * is `/code/error.tsx`, which is written for the landing: it says a composer
 * failed to draw and reassures the reader that "any run already going is still
 * going, on the machine it started on". Neither half is about a settings page —
 * nothing here starts a run, so nothing here could have stopped one — and a
 * reader who came to check which repositories a cloud run can clone would be
 * answered about something they were not doing. `/code/pulls` carries its own
 * boundary for the same reason; this is the third leaf under `/code`.
 *
 * The second action is Pull requests rather than the landing: the landing is
 * one press away in the sidebar on every page, and the useful offer to somebody
 * whose settings page just failed is the work that is already going.
 */

import * as React from "react";
import Link from "next/link";

import { AppPage } from "@/components/app/app-page";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";

export default function CodeCustomizeError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    console.error("[route] /code/customize failed to render", error);
  }, [error]);

  return (
    // Same measure as page.tsx so the column does not resize on failure.
    <AppPage measure="wide">
      <EmptyState
        tone="error"
        icon={StatusIcons.error}
        title="Couldn’t open your Juno Code settings"
        description="This screen failed to draw. Nothing here was changed — this page states what your runs use, and it sets none of it."
        action={
          <>
            <Button size="sm" onClick={reset} className="gap-1.5">
              <ActionIcons.refresh className="size-3.5" aria-hidden="true" />
              Try again
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link href="/code/pulls">Pull requests</Link>
            </Button>
          </>
        }
      />
      {error.digest && (
        // The digest is the only thing tying this screen to a line in the server
        // log, so it is the one part of the failure worth putting on the page.
        <p className="mt-4 text-center font-mono text-caption text-muted-foreground">
          Reference {error.digest}
        </p>
      )}
    </AppPage>
  );
}

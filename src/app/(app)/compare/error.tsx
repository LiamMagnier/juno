"use client";

/**
 * /compare when the segment throws.
 *
 * Next requires an error boundary to be a client component taking { error,
 * reset }. `error.message` is deliberately NOT rendered: it can carry a query,
 * a file path, a provider's raw response or an internal identifier, and none of
 * that is something the reader can act on. It goes to the console — and, for a
 * server error, it is already in the server log under `digest`, which is the
 * one identifier worth showing.
 */

import * as React from "react";
import Link from "next/link";

import { AppPage } from "@/components/app/app-page";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";

export default function CompareError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    console.error("[route] /compare failed to render", error);
  }, [error]);

  return (
    // The same full-measure frame the page uses, so the fallback sits where the
    // panes would have been.
    <AppPage
      measure="full"
      scroll={false}
      className="flex h-full min-h-0 flex-col"
      contentClassName="flex min-h-0 flex-1 flex-col items-center justify-center"
    >
      <div className="w-full max-w-md">
        <EmptyState
          tone="error"
          icon={StatusIcons.error}
          title="Compare couldn’t start"
          description="The panes didn’t come up. Comparisons are never saved, so nothing has been lost by the failure."
          action={
            <>
              <Button size="sm" onClick={reset} className="gap-1.5">
                <ActionIcons.refresh className="size-3.5" aria-hidden="true" />
                Try again
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link href="/chat">Back to chat</Link>
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
      </div>
    </AppPage>
  );
}

"use client";

/**
 * /chat when the segment throws.
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

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";

export default function NewChatError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    console.error("[route] /chat failed to render", error);
  }, [error]);

  return (
    // This route owns a full-height shell rather than the scrolling page
    // column, so the fallback centres in the same box instead of opening with a
    // page gutter the surface behind it does not have.
    <div className="flex h-full min-h-0 flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <EmptyState
          tone="error"
          icon={StatusIcons.error}
          title="Chat couldn’t start"
          description="The composer didn’t come up. Nothing you have written elsewhere is affected, and your conversations are all still there."
          action={
            <>
              <Button size="sm" onClick={reset} className="gap-1.5">
                <ActionIcons.refresh className="size-3.5" aria-hidden="true" />
                Try again
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link href="/chat">Reload chat</Link>
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
    </div>
  );
}

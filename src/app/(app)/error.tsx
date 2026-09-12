"use client";

/**
 * Segment boundary for everything under the app shell. Catches a page that
 * throws *after* the layout rendered — a failed conversation load, a bad
 * bootstrap read — so the sidebar and chrome stay up and only the pane is
 * replaced. (Errors thrown by `(app)/layout.tsx` itself bubble past this to
 * `app/global-error.tsx`, which is why that fallback exists too.)
 *
 * This is the boundary an *unguarded* page falls into, so it is the one a user
 * is most likely to meet — and it was the only one of the thirty-four that did
 * not use `EmptyState`. It hand-rolled a `bg-foreground` button, a bordered
 * `<Link>` and a `text-sm` paragraph, which meant the catch-all failure looked
 * like a different product from the thirty-three route boundaries beside it.
 * It now draws the same shape as `library/error.tsx`, the model for all of them.
 *
 * `error.message` is deliberately NOT rendered: it can carry a query, a file
 * path, a provider's raw response or an internal identifier, and none of that
 * is something the reader can act on. It goes to the console — and, for a
 * server error, it is already in the server log under `digest`, which is the
 * one identifier worth showing.
 */

import * as React from "react";
import Link from "next/link";

import { AppPage } from "@/components/app/app-page";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    console.error("[route] app segment failed to render", error);
  }, [error]);

  return (
    <AppPage measure="wide">
      <EmptyState
        tone="error"
        icon={StatusIcons.error}
        title="This view couldn’t load"
        description="Nothing was lost. Retry the view, or head back to your chats if it keeps failing."
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
    </AppPage>
  );
}

"use client";

/**
 * `/code` when the segment throws.
 *
 * Next requires an error boundary to be a client component taking { error,
 * reset }. `error.message` is deliberately NOT rendered: it can carry a query,
 * a file path, a provider's raw response or an internal identifier, and none of
 * that is something the reader can act on. It goes to the console — and, for a
 * server error, it is already in the server log under `digest`, which is the
 * one identifier worth showing.
 *
 * The description says what did NOT happen, because on this screen that is the
 * reader's actual question. A composer failing to draw looks exactly like a
 * product that has stopped, and a reader whose agents are working somewhere
 * they cannot see has no way to tell the two apart from here.
 *
 * The second action used to point at `/code/new`, which is this route's own
 * redirect now that the composer IS the landing — a "Start a task" button that
 * bounced straight back into the screen that just failed. What is left is the
 * retry and a way into the work that is already going.
 */

import * as React from "react";
import Link from "next/link";

import { AppPage } from "@/components/app/app-page";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";

export default function CodeRunsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    console.error("[route] /code failed to render", error);
  }, [error]);

  return (
    // The landing itself is a full-height composer surface with no page frame,
    // which is not a shape an error state can borrow: there is nothing to pin
    // to the bottom. So the failure takes the frame every other page in the
    // product uses, at the measure the rest of Code (`/code/pulls`) is read at.
    <AppPage measure="wide">
      <EmptyState
        tone="error"
        icon={StatusIcons.error}
        title="Couldn’t open Juno Code"
        description="This screen failed to draw. Nothing was cancelled — any run already going is still going, on the machine it started on."
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
        // The digest is the only thing tying this screen to a line in the
        // server log, so it is the one part of the failure worth showing.
        <p className="mt-4 text-center font-mono text-caption text-muted-foreground">
          Reference {error.digest}
        </p>
      )}
    </AppPage>
  );
}

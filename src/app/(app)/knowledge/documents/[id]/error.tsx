"use client";

/**
 * /knowledge/documents/[id] when the segment throws.
 *
 * Next requires an error boundary to be a client component taking { error,
 * reset }. `error.message` is deliberately NOT rendered: it can carry a query,
 * a file path, a provider's raw response or an internal identifier, and none of
 * that is something the reader can act on. It goes to the console — and, for a
 * server error, it is already in the server log under `digest`, which is the
 * one identifier worth showing.
 */

import { AppPage } from "@/components/app/app-page";
import * as React from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";

export default function KnowledgeDocumentError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    console.error("[route] /knowledge/documents/[id] failed to render", error);
  }, [error]);

  return (
    <AppPage measure="reading">
        <EmptyState
          tone="error"
          icon={StatusIcons.error}
          title="This document couldn’t be read"
          description="The extractor couldn’t open it, or the request didn’t come back. The file itself is still in your library."
          action={
            <>
              <Button size="sm" onClick={reset} className="gap-1.5">
                <ActionIcons.refresh className="size-3.5" aria-hidden="true" />
                Try again
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link href="/library">Back to library</Link>
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

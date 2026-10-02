"use client";

/**
 * /a/[id] when the segment throws.
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
import { AlevrLockup } from "@/components/brand/alevr-lockup";
import { ActionIcons } from "@/lib/app-icons";
import { ARTIFACTS_HOME } from "@/lib/artifact-links";

export default function ArtifactError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    console.error("[route] /a/[id] failed to render", error);
  }, [error]);

  return (
    // This route owns a full-height window rather than the scrolling page
    // column, so the fallback centres in the same box instead of opening with a
    // page gutter the window behind it does not have.
    <div className="alevr-public flex h-full min-h-0 flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="alevr-public-state text-center">
          <AlevrLockup height={24} className="mb-8" />
          <h1 className="font-serif text-display font-medium">This artifact couldn’t open</h1>
          <p className="mt-5 text-body leading-relaxed text-muted-foreground">It didn’t come back, or this build can’t read the version it is stored at. The artifact itself is unchanged.</p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <>
              <Button size="lg" onClick={reset} className="gap-1.5">
                <ActionIcons.refresh className="size-3.5" aria-hidden="true" />
                Try again
              </Button>
              <Button asChild size="lg" variant="outline">
                <Link href={ARTIFACTS_HOME}>All artifacts</Link>
              </Button>
            </>
          </div>
        </div>
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

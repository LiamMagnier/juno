"use client";

/**
 * /activity when the segment throws. The same shape as `library/error.tsx`;
 * `error.message` is never rendered, only the digest.
 */

import * as React from "react";
import Link from "next/link";

import { AppPage } from "@/components/app/app-page";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";

export default function ActivityError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    console.error("[route] /activity failed to render", error);
  }, [error]);

  return (
    <AppPage measure="wide">
      <EmptyState
        tone="error"
        icon={StatusIcons.error}
        title="Couldn’t load your activity"
        description="Nothing was stopped. The page failed to read the list, and trying again usually works."
        action={
          <>
            <Button size="sm" onClick={reset}>
              <ActionIcons.refresh className="size-4" aria-hidden="true" />
              Try again
            </Button>
            <Button asChild size="sm" variant="ghost" className="text-muted-foreground hover:text-foreground">
              <Link href="/chat">Back to chat</Link>
            </Button>
          </>
        }
      />
      {error.digest && (
        <p className="mt-4 text-center font-mono text-caption text-muted-foreground">Reference {error.digest}</p>
      )}
    </AppPage>
  );
}

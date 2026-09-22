"use client";

/**
 * /skills/import when the segment throws.
 *
 * `error.message` is deliberately not rendered — it can carry a repository URL,
 * a token fragment or a provider's raw response, none of which the reader can
 * act on. The digest is, because it is the one identifier tying this screen to
 * a line in the server log.
 */

import * as React from "react";
import Link from "next/link";

import { AppPage } from "@/components/app/app-page";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";

export default function ImportSkillsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    console.error("[route] /skills/import failed to render", error);
  }, [error]);

  return (
    <AppPage measure="reading">
      <EmptyState
        tone="error"
        icon={StatusIcons.error}
        title="The importer couldn’t open"
        description="Nothing has been imported. Your existing skills are untouched."
        action={
          <>
            <Button size="sm" onClick={reset} className="gap-1.5">
              <ActionIcons.refresh className="size-3.5" aria-hidden="true" />
              Try again
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link href="/skills">Back to skills</Link>
            </Button>
          </>
        }
      />
      {error.digest && (
        <p className="mt-4 text-center font-mono text-caption text-muted-foreground">
          Reference {error.digest}
        </p>
      )}
    </AppPage>
  );
}

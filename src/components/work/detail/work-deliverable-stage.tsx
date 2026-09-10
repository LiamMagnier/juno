"use client";

import * as React from "react";
import { ActionIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { ARTIFACT_EXTENSION } from "@/lib/work/domain";
import type { ClientWorkArtifact } from "@/lib/work/serializers";
import type { WorkArtifactList } from "@/components/work/work-documents";
import { workArtifactDownloadUrl } from "@/components/work/work-transport";
import { canPreviewArtifact, WorkDeliverableInlinePreview } from "@/components/work/work-site-preview";
import { workTimeAgo } from "@/components/work/work-vocabulary";

/*
 * The deliverable, where a reader looks first.
 *
 * A task page used to be a transcript with a right-hand rail, and the thing
 * the task was started FOR — the report, the site — was a 58px row inside a
 * collapsible section of that rail, with a Preview button that opened a
 * dialog. Four clicks from the inbox to see the output. Cowork puts the
 * document front and centre with the chat beside it; this is that arrangement:
 * the newest previewable document rendered inline at the top of the main
 * column, in the same sandboxed frame or the same markdown renderer the dialog
 * uses, with the title and a Download above it.
 *
 * Only the kinds with a previewer are staged (`canPreviewArtifact`); the
 * Office kinds have a card in the rail's Outputs section that leads with their
 * facts instead. Nothing here fetches the list — the page reads it once
 * (`useWorkArtifactList`) and hands it to the rail and to this — so the stage
 * and the Outputs count cannot disagree about which documents exist.
 */

/** The newest document the page can show inline, if any. */
export function stagedArtifact(list: WorkArtifactList): ClientWorkArtifact | null {
  const candidates = (list.artifacts ?? []).filter((artifact) => canPreviewArtifact(artifact.kind));
  if (candidates.length === 0) return null;
  return candidates.reduce((newest, artifact) =>
    Date.parse(artifact.updatedAt) > Date.parse(newest.updatedAt) ? artifact : newest
  );
}

export function WorkDeliverableStage({ list }: { list: WorkArtifactList }) {
  const artifact = stagedArtifact(list);
  if (artifact === null) return null;
  const others = (list.artifacts ?? []).length - 1;

  return (
    <section aria-label="What it produced" className="mb-6">
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <h2 className="min-w-0 flex-1 truncate text-heading text-foreground">{artifact.title}</h2>
        <span className="font-mono text-micro text-muted-foreground">
          {ARTIFACT_EXTENSION[artifact.kind]} · v{artifact.currentVersion} ·{" "}
          {workTimeAgo(artifact.updatedAt)}
        </span>
        <Button variant="secondary" size="sm" asChild className="h-7 gap-1.5">
          <a
            href={workArtifactDownloadUrl(artifact.id)}
            // No `download` attribute: the route sets Content-Disposition
            // itself, and a filename asserted here would be this bundle's
            // guess rather than the one the file was written under.
            aria-label={`Download ${artifact.title}`}
          >
            <ActionIcons.download className="size-3.5" aria-hidden="true" /> Download
          </a>
        </Button>
      </div>
      <WorkDeliverableInlinePreview
        kind={artifact.kind}
        artifactId={artifact.id}
        version={artifact.currentVersion}
        title={artifact.title}
      />
      {others > 0 && (
        <p className="mt-2 font-mono text-micro text-muted-foreground">
          {others === 1 ? "1 more file" : `${others} more files`} under Outputs.
        </p>
      )}
    </section>
  );
}

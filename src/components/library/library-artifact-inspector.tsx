"use client";

import * as React from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import type { ClientArtifact } from "@/types/chat";
import { Button } from "@/components/ui/button";
import { CloseButton, Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { EntryPreview, libraryWhen, type LibraryEntry } from "./library-items";

const Markdown = dynamic(() => import("@/components/chat/markdown").then((module) => module.Markdown));
const NO_REMOTE_IMAGES: ReadonlySet<string> = new Set();

type ReadableArtifact = Pick<ClientArtifact, "id" | "content" | "type" | "currentVersion">;

export function LibraryArtifactInspector({ entry, inline, onClose }: {
  entry: LibraryEntry;
  inline: boolean;
  onClose: () => void;
}) {
  const heading = React.useRef<HTMLHeadingElement>(null);
  const headingId = React.useId();
  React.useEffect(() => {
    if (inline) heading.current?.focus({ preventScroll: true });
  }, [entry.key, inline]);

  const [loadedArtifact, setLoadedArtifact] = React.useState<ReadableArtifact | null>(null);
  const artifactId = entry.made?.id;
  const kind = entry.made?.type;
  const version = entry.made?.version;
  React.useEffect(() => {
    if (!artifactId || (kind !== "MARKDOWN" && kind !== "CODE")) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/artifacts/${encodeURIComponent(artifactId)}`, { signal: controller.signal });
        if (!response.ok) return;
        const { artifact } = (await response.json()) as { artifact?: ReadableArtifact };
        if (!controller.signal.aborted && artifact?.id === artifactId && artifact.type === kind && typeof artifact.content === "string") {
          setLoadedArtifact(artifact);
        }
      } catch {
        // Keep the Library thumbnail and the editor link if the full preview is unavailable.
      }
    })();
    return () => controller.abort();
  }, [artifactId, kind, version]);
  const currentArtifact = loadedArtifact && loadedArtifact.id === artifactId
    && loadedArtifact.currentVersion === version ? loadedArtifact : null;
  const excerpt = currentArtifact?.content.slice(0, 48_000) ?? null;

  const title = inline
    ? <h2 id={headingId} ref={heading} tabIndex={-1} className="break-words text-heading outline-none">{entry.title}</h2>
    : <DialogTitle className="break-words">{entry.title}</DialogTitle>;
  const content = (
    <div className="flex flex-col gap-4 p-4">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          {title}
          <p className="text-caption text-muted-foreground">{entry.type} · Version {version} · {libraryWhen(entry.at)}</p>
        </div>
        <CloseButton label="Close preview" onClick={onClose} />
      </header>
      {excerpt !== null ? (
        <div className="max-h-[min(50dvh,26rem)] overflow-auto overscroll-contain border-y border-border/60 py-3">
          {kind === "MARKDOWN" ? <Markdown content={excerpt} allowedImageUrls={NO_REMOTE_IMAGES} /> : (
            <pre className="whitespace-pre-wrap break-words font-mono text-caption">{excerpt}</pre>
          )}
        </div>
      ) : (
        <figure className="nest-card nest-p-1 bg-muted/45 p-1">
          <div className="relative aspect-[4/3] overflow-hidden rounded-inner bg-background"><EntryPreview entry={entry} /></div>
        </figure>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild><Link href={entry.href}>Open artifact</Link></Button>
        {entry.conversationId && (
          <Button asChild variant="ghost"><Link href={`/chat/${encodeURIComponent(entry.conversationId)}`}>Source chat</Link></Button>
        )}
      </div>
    </div>
  );
  if (inline) {
    return <aside aria-labelledby={headingId} className="sticky top-4 min-w-0 rounded-card border border-border/70 bg-card">{content}</aside>;
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent bare hideClose aria-describedby={undefined} onCloseAutoFocus={(event) => event.preventDefault()} className="max-w-lg overflow-y-auto">
        {content}
      </DialogContent>
    </Dialog>
  );
}

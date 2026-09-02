import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { AppPage } from "@/components/ui/app-page";
import { JunoMark } from "@/components/brand/logo";
import { SharedChatTranscript } from "@/components/share/shared-chat-transcript";
import { SharedArtifactViewer } from "@/components/share/shared-artifact-viewer";
import { getPublicShare, getSharedArtifactSnapshot, getSharedChatSnapshot, peekPublicShare } from "@/lib/share";
import { cn } from "@/lib/utils";

/*
 * Public share page — no auth, works signed out. Renders the frozen snapshot
 * behind an unguessable token; revoked or unknown tokens 404. Every share
 * page is noindex/nofollow: sharing is link-visibility, never search-visibility.
 */

// Never cache a share render: revocation must kill the link on the next request.
export const dynamic = "force-dynamic";

const SHARE_DESCRIPTION = "Shared from Juno — a thoughtful AI assistant for chat, code, and creativity.";

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const { token } = await params;
  const share = await peekPublicShare(token);
  const title = share?.title.trim() || "Shared from Juno";
  return {
    title,
    description: SHARE_DESCRIPTION,
    robots: { index: false, follow: false },
    openGraph: { title, description: SHARE_DESCRIPTION, type: "article", siteName: "Juno" },
  };
}

// Fixed locale: the page is server-rendered for anonymous visitors, so the
// date must not depend on the server's runtime locale.
function formatSharedDate(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const share = await getPublicShare(token);
  if (!share) notFound();

  const chat = share.kind === "CHAT" ? await getSharedChatSnapshot(share) : null;
  const artifact = share.kind === "ARTIFACT" ? await getSharedArtifactSnapshot(share) : null;
  if (!chat && !artifact) notFound();

  const title = share.title.trim() || "Shared from Juno";
  const sharedOn = formatSharedDate(share.snapshotAt);

  return (
    // Chat scrolls as a document; the artifact sandbox fills a fixed viewport.
    <div className={cn("flex flex-col bg-background text-foreground", artifact ? "h-dvh overflow-hidden" : "min-h-dvh")}>
      {/* A slim bar on the card rung with a hairline — no glass, because what
          scrolls under it is a reading surface (SOFT_UI.md §1.4). The one
          primary action on the page lives here, where it is always reachable. */}
      <header className="sticky top-0 z-toolbar shrink-0 border-b border-border/60 bg-card">
        <AppPage scroll={false} measure="reading" contentClassName="flex h-12 items-center gap-3 py-0">
          <Link
            href="/"
            aria-label="Juno"
            className="shrink-0 rounded-control transition-transform duration-press ease-out-soft active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100"
          >
            <JunoMark className="size-6" />
          </Link>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-medium">{title}</h1>
            <p className="truncate font-mono text-caption text-muted-foreground">Shared {sharedOn}</p>
          </div>
          <Button size="sm" asChild>
            <Link href="/">Open in Juno</Link>
          </Button>
        </AppPage>
      </header>

      {chat ? (
        // The transcript stays flat prose on the page ground, at the reading measure.
        <AppPage scroll={false} measure="reading" className="flex-1" contentClassName="py-8">
          <SharedChatTranscript messages={chat.messages} artifacts={chat.artifacts} />
        </AppPage>
      ) : artifact ? (
        <AppPage
          scroll={false}
          measure="reading"
          className="flex min-h-0 flex-1 flex-col"
          contentClassName="flex min-h-0 flex-1 flex-col py-4 sm:py-6"
        >
          <SharedArtifactViewer
            type={artifact.type}
            language={artifact.language}
            content={artifact.content}
            version={artifact.version}
          />
        </AppPage>
      ) : null}

      <footer className="shrink-0 border-t border-border/60">
        <AppPage scroll={false} measure="reading" contentClassName="flex h-12 items-center justify-between gap-3 py-0">
          <span className="inline-flex items-center gap-2 font-mono text-caption text-muted-foreground">
            <JunoMark className="size-4" />
            Made with Juno
          </span>
          <Link
            href="/sign-up"
            className="rounded-xs text-caption text-muted-foreground transition-colors duration-fast ease-out-soft hover:text-foreground focus-visible:text-foreground"
          >
            Create your own account
          </Link>
        </AppPage>
      </footer>
    </div>
  );
}

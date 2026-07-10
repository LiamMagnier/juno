import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
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
      <header className="sticky top-0 z-20 shrink-0 border-b border-border/60 bg-background/85 backdrop-blur-md">
        <div className="mx-auto flex h-14 w-full max-w-3xl items-center gap-3 px-4 sm:px-6">
          <Link href="/" aria-label="Juno" className="shrink-0 rounded-md">
            <JunoMark className="h-6 w-6" />
          </Link>
          <h1 className="min-w-0 flex-1 truncate font-serif text-base font-medium tracking-tight">{title}</h1>
          <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            Shared {sharedOn}
          </span>
        </div>
      </header>

      {chat ? (
        <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6">
          <SharedChatTranscript messages={chat.messages} artifacts={chat.artifacts} />
        </main>
      ) : artifact ? (
        <main className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col px-4 py-4 sm:px-6 sm:py-6">
          <SharedArtifactViewer
            type={artifact.type}
            language={artifact.language}
            content={artifact.content}
            version={artifact.version}
          />
        </main>
      ) : null}

      <footer className="sticky bottom-0 z-20 shrink-0 border-t border-border/60 bg-background/85 backdrop-blur-md">
        <div className="mx-auto flex h-14 w-full max-w-3xl items-center justify-between gap-3 px-4 sm:px-6">
          <span className="inline-flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            <JunoMark className="h-4 w-4" />
            Made with Juno
          </span>
          <Button size="sm" asChild>
            <Link href="/">Try Juno</Link>
          </Button>
        </div>
      </footer>
    </div>
  );
}

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
      {/* `bg-card/85`, not `bg-background/85`. On the true-black theme the
          background rung IS the transcript's ground, so the sticky chrome was
          chromatically identical to the content scrolling under it and only a
          damped hairline said the bar existed. --card is the first rung above
          the ground (6.5%), which is exactly what a floating bar wants. */}
      <header className="sticky top-0 z-20 shrink-0 border-b border-border/60 bg-card/85 backdrop-blur-md">
        <div className="mx-auto flex h-14 w-full max-w-3xl items-center gap-3 px-4 sm:px-6">
          <Link
            href="/"
            aria-label="Juno"
            className="shrink-0 rounded-control transition-transform duration-press ease-out-soft active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100"
          >
            <JunoMark className="h-6 w-6" />
          </Link>
          {/* text-heading — this was `text-base` (16px), a Tailwind default that
              sits between body (15px) and heading (18px) and is on no Juno rung. */}
          <h1 className="min-w-0 flex-1 truncate font-serif text-heading">{title}</h1>
          {/* text-caption (11px), not an arbitrary text-[10px] below the bottom of
              the scale — on the one page a prospect sees before the marketing
              site. */}
          <span className="shrink-0 whitespace-nowrap font-mono text-caption text-muted-foreground">
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

      {/* Same rung as the header above — the two bars are one piece of chrome. */}
      <footer className="sticky bottom-0 z-20 shrink-0 border-t border-border/60 bg-card/85 backdrop-blur-md">
        <div className="mx-auto flex h-14 w-full max-w-3xl items-center justify-between gap-3 px-4 sm:px-6">
          <span className="inline-flex items-center gap-2 font-mono text-caption text-muted-foreground">
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

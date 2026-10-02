import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { AppPage } from "@/components/ui/app-page";
import { AlevrLockup } from "@/components/brand/alevr-lockup";
import { SharedChatTranscript } from "@/components/share/shared-chat-transcript";
import { SharedArtifactViewer } from "@/components/share/shared-artifact-viewer";
import { ReportShareButton } from "@/components/share/report-share-dialog";
import { ShareGone } from "@/components/share/share-gone";
import { SandboxProfileProvider } from "@/components/canvas/sandbox-document-frame";
import { publicShareProfile } from "@/lib/sandbox-policy";
import { sharedDesignPosterUrl } from "@/lib/design/poster-url";
import {
  getPublicShare,
  getSharedArtifactSnapshot,
  getSharedChatSnapshot,
  peekPublicShare,
  sharedArtifactIsTrashed,
} from "@/lib/share";
import { countPublicationView, findPublicPublication } from "@/lib/artifact-publication";
import { cn } from "@/lib/utils";
import type { ArtifactType } from "@/lib/message-content";
import { PRODUCT_NAME } from "@/lib/brand/names";

/*
 * Public share page — no auth, works signed out. Serves two kinds of token:
 *
 *   - a legacy SHARE: the frozen snapshot of a chat or an artifact;
 *   - an artifact PUBLICATION (src/lib/artifact-publication.ts): the version
 *     the owner pinned, or the latest sealed version when it follows latest.
 *
 * Revoked, taken-down, banned-owner or unknown tokens 404. A real token that
 * no longer serves — its artifact is in Recently deleted, the owner
 * unpublished it, or the owner reset the link — renders `<ShareGone />` (the
 * poster beside it answers a true 410). Every share page is noindex/nofollow:
 * sharing is link-visibility, never search-visibility.
 *
 * What is on it was written by someone the visitor does not know. So previews
 * below run no scripts at all (the `static` sandbox profile) until publish-time
 * screening and a screening pass over existing shares exist; then
 * JUNO_PREVIEW_ORIGIN_PUBLIC=1 switches them to the `public` profile: no
 * downloads or dialogs, and images and requests only to allowlisted hosts.
 * See publicShareProfile in src/lib/sandbox-policy.ts.
 */

// Never cache a share render: revocation must kill the link on the next request.
export const dynamic = "force-dynamic";

const SHARE_DESCRIPTION = `Shared from ${PRODUCT_NAME}. Conversation. Agents. Code.`;

const GONE_METADATA: Metadata = { title: "Not shared any more", robots: { index: false, follow: false } };

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const { token } = await params;
  const share = await peekPublicShare(token);
  // A dark link keeps its title to itself, in the tab and in any unfurl: the
  // owner took the thing down, and its name is part of it.
  if (share && (await sharedArtifactIsTrashed(share))) return GONE_METADATA;
  const publication = share ? null : await findPublicPublication(token);
  if (publication?.state === "gone") return GONE_METADATA;
  const title = (share?.title ?? (publication?.state === "live" ? publication.snapshot.title : "")).trim() || `Shared from ${PRODUCT_NAME}`;
  return {
    title,
    description: SHARE_DESCRIPTION,
    robots: { index: false, follow: false },
    openGraph: { title, description: SHARE_DESCRIPTION, type: "article", siteName: PRODUCT_NAME },
  };
}

// Fixed locale: the page is server-rendered for anonymous visitors, so the
// date must not depend on the server's runtime locale.
function formatSharedDate(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** What the page draws, from either kind of token. */
interface PageSubject {
  title: string;
  /** "Shared Sep 30, 2026" or "Published Sep 30, 2026". */
  dateLine: string;
  chat: Awaited<ReturnType<typeof getSharedChatSnapshot>>;
  artifact: { type: ArtifactType; language: string | null; content: string; version: number } | null;
}

async function resolveSubject(token: string): Promise<PageSubject | "gone" | null> {
  // The gone check runs on the peek, before the lookup that counts a view: a
  // visitor to a dark link has viewed nothing. The lookup is request-cached,
  // so the peek and the counting call share one query.
  const peeked = await peekPublicShare(token);
  if (peeked) {
    if (await sharedArtifactIsTrashed(peeked)) return "gone";
    const share = await getPublicShare(token);
    if (!share) return null;
    const chat = share.kind === "CHAT" ? await getSharedChatSnapshot(share) : null;
    const artifact = share.kind === "ARTIFACT" ? await getSharedArtifactSnapshot(share) : null;
    if (!chat && !artifact) return null;
    return {
      title: share.title.trim() || `Shared from ${PRODUCT_NAME}`,
      dateLine: `Shared ${formatSharedDate(share.snapshotAt)}`,
      chat,
      artifact,
    };
  }
  const publication = await findPublicPublication(token);
  if (!publication) return null;
  if (publication.state === "gone") return "gone";
  countPublicationView(publication.publication.id);
  return {
    title: publication.snapshot.title.trim() || `Shared from ${PRODUCT_NAME}`,
    dateLine: `Published ${formatSharedDate(new Date(publication.snapshot.publishedAt))}`,
    chat: null,
    artifact: publication.snapshot,
  };
}

export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const subject = await resolveSubject(token);
  if (subject === "gone") return <ShareGone />;
  if (!subject) notFound();
  const { chat, artifact, title } = subject;

  return (
    // Chat scrolls as a document; the artifact sandbox fills a fixed viewport.
    <div className={cn("alevr-public flex flex-col bg-background text-foreground", artifact ? "h-dvh overflow-hidden" : "min-h-dvh")}>
      {/* A slim bar on the card rung with a hairline — no glass, because what
          scrolls under it is a reading surface (SOFT_UI.md §1.4). The one
          primary action on the page lives here, where it is always reachable. */}
      <header className="sticky top-0 z-toolbar shrink-0 border-b border-border/60 bg-card">
        <AppPage scroll={false} measure="reading" contentClassName="flex min-h-16 flex-wrap items-center gap-3 py-3">
          <Link
            href="/"
            aria-label={PRODUCT_NAME}
            className="shrink-0 rounded-control transition-transform duration-press ease-out-soft active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100"
          >
            <AlevrLockup height={24} decorative />
          </Link>
          <div className="min-w-0 flex-1 basis-32">
            <h1 className="truncate font-serif text-title font-medium">{title}</h1>
            <p className="truncate text-caption text-muted-foreground">{subject.dateLine}</p>
          </div>
          <Button size="sm" asChild>
            <Link href="/">{`Open in ${PRODUCT_NAME}`}</Link>
          </Button>
        </AppPage>
      </header>

      <SandboxProfileProvider profile={publicShareProfile()}>
        {chat ? (
          // The transcript stays flat prose on the page ground, at the reading measure.
          <AppPage scroll={false} measure="reading" className="flex-1" contentClassName="py-8">
            <SharedChatTranscript messages={chat.messages} artifacts={chat.artifacts} />
            {/* The end of a shared conversation is where a reader decides what
                Juno is: one quiet invitation on the front door's own art. */}
            <aside className="mt-14 flex flex-col gap-6 border-t border-border py-8 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="font-serif text-title font-medium">Go further.</p>
                <p className="mt-2 max-w-sm text-body text-muted-foreground">A calm place to think, make something, and carry your work forward.</p>
              </div>
              <Button asChild className="shrink-0"><Link href="/sign-up">{`Start with ${PRODUCT_NAME}`}</Link></Button>
            </aside>
          </AppPage>
        ) : artifact ? (
          <AppPage
            scroll={false}
            measure="reading"
            className="flex min-h-0 flex-1 flex-col"
            contentClassName="flex min-h-0 flex-1 flex-col py-4 sm:py-6"
          >
            {/* A shared design is its poster, drawn by `/share/{token}/poster`
                for exactly this version. Its document stays on the server: the
                viewer never shows it, and sending it anyway would put the whole
                JSON, inline images and all, in the page data of every anonymous
                visitor (X-20). */}
            <SharedArtifactViewer
              type={artifact.type}
              language={artifact.language}
              content={artifact.type === "DESIGN" ? "" : artifact.content}
              version={artifact.version}
              posterUrl={artifact.type === "DESIGN" ? sharedDesignPosterUrl(token) : undefined}
            />
          </AppPage>
        ) : null}
      </SandboxProfileProvider>

      <footer className="shrink-0 border-t border-border/60">
        {/* min-h and wrap rather than a fixed h-12: with Report in the row,
            three items no longer fit one line on a 320px phone, and a wrapped
            row inside a fixed height would spill out of the bar. From ~360px
            up it is the same single 48px row it always was. */}
        <AppPage
          scroll={false}
          measure="reading"
          contentClassName="flex min-h-12 flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2"
        >
          <span className="inline-flex items-center gap-2 text-caption text-muted-foreground">
            <AlevrLockup height={20} decorative />
            <span className="sr-only">{`Made with ${PRODUCT_NAME}`}</span>
          </span>
          {/* The visitor's two ways out, grouped so justify-between keeps them
              together at the end rather than spacing Report into the middle. */}
          <div className="flex items-center gap-4">
            <ReportShareButton token={token} />
            <Link
              href="/sign-up"
              className="rounded-xs text-caption text-muted-foreground transition-colors duration-fast ease-out-soft hover:text-foreground focus-visible:text-foreground"
            >
              Create your own account
            </Link>
          </div>
        </AppPage>
      </footer>
    </div>
  );
}

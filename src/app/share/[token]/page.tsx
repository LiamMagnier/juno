import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { AppPage } from "@/components/ui/app-page";
import { AlevrLockup } from "@/components/brand/alevr-lockup";
import { SharedChatTranscript } from "@/components/share/shared-chat-transcript";
import { SharedArtifactViewer } from "@/components/share/shared-artifact-viewer";
import { ReportShareButton } from "@/components/share/report-share-dialog";
import { ShareCopyButton } from "@/components/share/share-copy-button";
import { sharedTypeCopyable } from "@/lib/share-copy";
import { getCurrentUser } from "@/lib/session";
import { ShareGone } from "@/components/share/share-gone";
import { ShareRestricted, type ShareRestrictedState } from "@/components/share/share-restricted";
import { AlevrBridgeProvider, SandboxProfileProvider } from "@/components/canvas/sandbox-document-frame";
import { publicShareProfile } from "@/lib/sandbox-policy";
import { isArtifactAiEnabled } from "@/lib/env";
import { sharedDesignPosterUrl } from "@/lib/design/poster-url";
import {
  countShareView,
  getPublicShare,
  getSharedArtifactSnapshot,
  getSharedChatSnapshot,
  peekPeopleShare,
  peekPublicShare,
  sharedArtifactIsTrashed,
} from "@/lib/share";
import { resolvePeopleShare } from "@/lib/share-people";
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
 *   - a share with SPECIFIC PEOPLE (src/lib/share-people-core.ts): the same
 *     frozen snapshot, shown only to its owner and to a signed-in account
 *     whose verified email it was shared with. Anyone else gets
 *     `<ShareRestricted />` — sign in, confirm your address, or "you don't
 *     have access" — and nothing from the share, not even its title.
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
// A Code session that ran on its owner's Mac: the server never held its
// transcript, so the page says where the words came from.
const FROM_DEVICE_NOTE = "This session ran on its owner’s Mac. Their app sent this transcript when the link was made.";

const GONE_METADATA: Metadata = { title: "Not shared any more", robots: { index: false, follow: false } };
// A people share names itself only to someone who may read it: a link pasted
// into a chat app unfurls as this, whoever's preview bot fetches it.
const RESTRICTED_METADATA: Metadata = { title: "Shared with specific people", robots: { index: false, follow: false } };

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const { token } = await params;
  if (await peekPeopleShare(token)) {
    const people = await resolvePeopleShare(token);
    if (people?.access.state !== "granted") return RESTRICTED_METADATA;
    if (await sharedArtifactIsTrashed(people.share)) return GONE_METADATA;
    return { title: people.share.title.trim() || `Shared from ${PRODUCT_NAME}`, robots: { index: false, follow: false } };
  }
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

/** What the page draws, from any kind of token. */
interface PageSubject {
  title: string;
  /** "Shared Sep 30, 2026" or "Published Sep 30, 2026". */
  dateLine: string;
  chat: Awaited<ReturnType<typeof getSharedChatSnapshot>>;
  artifact: { type: ArtifactType; language: string | null; content: string; version: number } | null;
  /** Shared with specific people: view-only for them, so no "Make a copy". */
  restricted?: boolean;
}

/** A people share this viewer may not read: which wall to show, and their own address. */
interface Restricted {
  wall: ShareRestrictedState;
  email: string | null;
}

async function resolveSubject(token: string): Promise<PageSubject | Restricted | "gone" | null> {
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
  // A share with specific people: who is asking decides what they see, and
  // that is settled before anything of the share is read. The access check
  // runs before the trash check, so a stranger cannot tell a share that went
  // dark from one that is live.
  if (await peekPeopleShare(token)) {
    const people = await resolvePeopleShare(token);
    if (!people) return null;
    const { share, access } = people;
    if (access.state !== "granted") {
      return { wall: access.state, email: access.state === "sign-in" ? null : access.email };
    }
    if (await sharedArtifactIsTrashed(share)) return "gone";
    const chat = share.kind === "CHAT" ? await getSharedChatSnapshot(share) : null;
    const artifact = share.kind === "ARTIFACT" ? await getSharedArtifactSnapshot(share) : null;
    if (!chat && !artifact) return null;
    countShareView(share.id);
    return {
      title: share.title.trim() || `Shared from ${PRODUCT_NAME}`,
      dateLine: `Shared ${formatSharedDate(share.snapshotAt)}`,
      chat,
      artifact,
      restricted: true,
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

export default async function SharePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams?: Promise<{ copy?: string }>;
}) {
  const { token } = await params;
  const subject = await resolveSubject(token);
  if (subject === "gone") return <ShareGone />;
  if (!subject) notFound();
  if ("wall" in subject) return <ShareRestricted state={subject.wall} token={token} email={subject.email} />;
  const { chat, artifact, title } = subject;
  // A visitor can make their own copy of a shared artifact (not a design,
  // whose document the page never shows): src/lib/share-copy.ts. Not from a
  // share with specific people, which is view-only for them.
  const copyable = !!artifact && !subject.restricted && sharedTypeCopyable(artifact.type);
  // Also read when the page runs the artifact's scripts: an app's AI and saved
  // data run on the visitor's own account, so who is looking decides whether
  // the viewer asks or points to sign-in (SharedArtifactViewer).
  // Only while the server has AI-powered artifacts on (ARTIFACT_AI_ENABLED).
  const alevrOn = isArtifactAiEnabled();
  const scripted = alevrOn && !!artifact && publicShareProfile() === "public";
  const signedIn = copyable || scripted ? !!(await getCurrentUser().catch(() => null)) : false;
  const askCopy = copyable && (await searchParams)?.copy === "1";

  return (
    // Chat scrolls as a document; the artifact sandbox fills a fixed viewport.
    <div className={cn("alevr-public alevr-share flex flex-col bg-background text-foreground", artifact ? "alevr-share-artifact h-dvh overflow-hidden" : "alevr-share-chat min-h-dvh")}>
      {/* A slim bar on the card rung with a hairline — no glass, because what
          scrolls under it is a reading surface (SOFT_UI.md §1.4). The one
          primary action on the page lives here, where it is always reachable. */}
      <header className="alevr-reading-header sticky top-0 z-toolbar shrink-0 bg-background">
        <AppPage scroll={false} measure="wide" contentClassName="flex min-h-16 flex-wrap items-center gap-4 py-3">
          <Link
            href="/"
            aria-label={PRODUCT_NAME}
            className="shrink-0 rounded-control transition-transform duration-press ease-out-soft active:scale-[0.97] motion-reduce:transition-[color,background-color,border-color,opacity,box-shadow,filter] motion-reduce:active:scale-100"
          >
            <AlevrLockup height={24} decorative />
          </Link>
          <div className="min-w-0 flex-1 basis-32">
            {artifact && <><h1 className="truncate font-serif text-title font-medium">{title}</h1><p className="truncate text-caption text-muted-foreground">{subject.dateLine}</p></>}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {copyable && <ShareCopyButton token={token} signedIn={signedIn} askOnArrival={askCopy} />}
            <Button size="sm" asChild>
              <Link href="/">{`Open in ${PRODUCT_NAME}`}</Link>
            </Button>
          </div>
        </AppPage>
      </header>

      <main className={cn("alevr-share-main min-h-0 flex-1", artifact && "flex flex-col")}>
        <SandboxProfileProvider profile={publicShareProfile()}>
        <AlevrBridgeProvider enabled={alevrOn}>
        {chat ? (
          // The transcript stays flat prose on the page ground, at the reading measure.
          <AppPage scroll={false} measure="reading" className="flex-1" contentClassName="alevr-shared-prose">
            <header className="alevr-shared-title"><p className="text-ui text-muted-foreground">{subject.dateLine}</p><h1 className="mt-4 font-serif">{title}</h1>{chat.fromDevice && <p className="mt-3 text-caption text-muted-foreground">{FROM_DEVICE_NOTE}</p>}</header>
            <SharedChatTranscript messages={chat.messages} artifacts={chat.artifacts} />
            {/* The end of a shared conversation is where a reader decides what
                Juno is: one quiet invitation on the front door's own art. */}
            <aside className="mt-14 flex flex-col gap-6 border-t border-border py-8 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="font-serif text-title font-medium">Go further.</p>
                <p className="mt-2 max-w-sm text-body text-muted-foreground">A calm place to think, make something, and carry your work forward.</p>
              </div>
              <Button asChild className="shrink-0"><Link href="/sign-up">Create account</Link></Button>
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
              signedIn={signedIn}
            />
          </AppPage>
        ) : null}
        </AlevrBridgeProvider>
        </SandboxProfileProvider>
      </main>

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
              className="inline-flex min-h-11 items-center rounded-xs text-ui text-muted-foreground transition-colors duration-fast ease-out-soft hover:text-foreground focus-visible:text-foreground"
            >
              Create account
            </Link>
          </div>
        </AppPage>
      </footer>
    </div>
  );
}

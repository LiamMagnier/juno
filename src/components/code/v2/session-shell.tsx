"use client";

/**
 * The Code session's first paint (G58), before the live workspace hydrates.
 *
 * `/code/[id]` renders the workspace on the client only (it reads this
 * browser's storage and opens live transports), and its dynamic import had no
 * fallback: the first paint was blank, and while the route loaded, the parent
 * `/code` skeleton drew a greeting and a centred composer, which then jumped.
 * This shell draws the workspace's own frame with the same classes, so
 * nothing moves when the live one replaces it:
 *
 * - the 48px header with the breadcrumb;
 * - the thread: the server-loaded turns as plain text (the latest few), or
 *   the landing's first prompt as the first turn with "Starting…" under it,
 *   or skeleton lines while nothing is known yet;
 * - the docked composer at its resting height, with the context strip.
 *
 * It is also where the landing's composer arrives (composer-travel.ts) when it
 * is the first docked composer on screen.
 */
import * as React from "react";
import { useParams } from "next/navigation";
import { peekPendingCodePrompt } from "@/lib/code-session-handoff";
import type { ClientMessage } from "@/types/chat";
import { useComposerArrival } from "./composer-travel";
import { Glyph } from "./primitives";
import { ComposerPrimaryAction, ComposerShell, composerFieldClass, composerIconButtonClass } from "@/components/ui/composer-shell";
import { cn } from "@/lib/utils";

/** The newest turns the static thread draws: enough to fill a screen, few enough to stay light. */
const STATIC_MESSAGES = 8;
/** An answer longer than this is cut in the static paint; the live thread draws it whole. */
const STATIC_ANSWER_CHARS = 1600;

const LOADING_LABEL = "Loading session";
const STARTING_LABEL = "Starting…";
const PLACEHOLDER_LABEL = "Ask for a change. @ for files, / for commands";
const UNTITLED_LABEL = "Code session";

export interface StaticTurn {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Name and type, so the glyph is the live thread's (a picture or a document). */
  files?: { name: string; mediaType?: string }[];
}

/** The server-loaded messages as the static thread draws them: the newest few, answers cut. */
export function staticTurns(messages: readonly Pick<ClientMessage, "id" | "role" | "content" | "attachments">[], limit = STATIC_MESSAGES): StaticTurn[] {
  return messages
    .filter((m) => (m.role === "USER" || m.role === "ASSISTANT") && (m.content.trim() || m.attachments?.length))
    .slice(-limit)
    .map((m) => ({
      id: m.id,
      role: m.role === "USER" ? "user" : "assistant",
      text: m.role === "ASSISTANT" && m.content.length > STATIC_ANSWER_CHARS ? `${m.content.slice(0, STATIC_ANSWER_CHARS).trimEnd()}…` : m.content,
      files: m.attachments?.filter((a) => a.fileName).map((a) => ({ name: a.fileName, mediaType: a.mimeType })),
    }));
}

const subscribeNever = () => () => undefined;

/** The landing's pending first prompt for this thread, read on the client only. */
function usePendingPrompt(conversationId: string | null): StaticTurn | null {
  const raw = React.useSyncExternalStore(
    subscribeNever,
    () => {
      if (!conversationId) return null;
      const pending = peekPendingCodePrompt(conversationId);
      return pending ? JSON.stringify(pending) : null;
    },
    () => null,
  );
  return React.useMemo(() => {
    if (!raw) return null;
    const pending = JSON.parse(raw) as { text: string; attachments: { fileName: string; mimeType?: string }[] };
    // Word for word what the live route's first bubble shows (live-route.tsx
    // firstItems), so hydrating changes nothing. Stripping a leading `/word`
    // here also ate commands sent to the agent ("/review the cart").
    return { id: "first-prompt", role: "user", text: pending.text, files: pending.attachments.map((a) => ({ name: a.fileName, mediaType: a.mimeType })) };
  }, [raw]);
}

/** The composer at rest, drawn with its own classes so the live one lands on the same pixels. */
function StaticComposer({ repo, tall = false }: { repo: string; tall?: boolean }) {
  const box = React.useRef<HTMLDivElement>(null);
  // Only a docked composer is where the landing's travels to.
  useComposerArrival(box, !tall);
  return (
    <div className="cv2-cstack" aria-hidden>
      <ComposerShell
        ref={box}
        frame={tall ? "home" : "dock"}
        className="cv2-composer"
        field={<p className={cn(composerFieldClass, "text-muted-foreground", tall && "min-h-[3.5rem] max-[760px]:min-h-[3.25rem]")}>{PLACEHOLDER_LABEL}</p>}
        leading={<><span className={cn(composerIconButtonClass, "grid place-items-center")}><Glyph name="plus" size={16} /></span><span className="cv2-skel-chip" /></>}
        action={<ComposerPrimaryAction face="send" disabled tabIndex={-1} />}
      />
      <div className="composer-tray composer-tray--dock">
        <div className="composer-tray__row"><div className="composer-tray__capsule"><span className="composer-tray__item"><span className="cv2-skel-chip" /></span></div></div>
      </div>
      <div className="cv2-strip">
        <span className="s">
          <Glyph name="folder" size={12} />
          {repo}
        </span>
      </div>
    </div>
  );
}

export function CodeSessionStatic({
  title,
  repo,
  turns,
  starting,
}: {
  title: string;
  repo: string;
  /** Null while nothing is known: skeleton lines. */
  turns: StaticTurn[] | null;
  starting?: boolean;
}) {
  return (
    <div className="cv2 cv2-app no-side cv2-session-surface" role="status" aria-busy="true" aria-label={LOADING_LABEL} style={{ height: "100%" }}>
      <main className="cv2-main">
        <div className="cv2-left">
          <header className="cv2-top">
            <div className="cv2-crumb">
              <span className="proj">{repo}</span>
              <span className="slash" aria-hidden>
                /
              </span>
              <span className="title">
                <span className="cv2-trunc">{title}</span>
              </span>
            </div>
          </header>
          <div className="cv2-body">
            <div className="cv2-thread-col">
              {turns !== null && turns.length === 0 ? (
                // A thread with nothing in it yet: the workspace's empty state, composer centred.
                <div className="cv2-empty">
                  <div className="spacer-top" />
                  <h1>{repo ? <>What will you build in <span className="proj">{repo}</span>?</> : "What will you build?"}</h1>
                  <div className="cv2-col">
                    <StaticComposer repo={repo} tall />
                  </div>
                  <div className="spacer-bottom" />
                </div>
              ) : turns === null ? (
                <div className="cv2-scroll">
                  <div className="cv2-col cv2-skel">
                    <i style={{ width: "46%", alignSelf: "flex-end", height: 36, borderRadius: 18 }} />
                    <i style={{ width: "88%" }} />
                    <i style={{ width: "72%" }} />
                  </div>
                </div>
              ) : (
                <div className="cv2-scroll cv2-static-thread">
                  <div className="cv2-col">
                    {turns.map((t) =>
                      t.role === "user" ? (
                        <div key={t.id} className="cv2-you-wrap" style={{ marginTop: 16 }}>
                          <div className="cv2-you">
                            {t.files?.length ? (
                              <div className="files">
                                {t.files.map((f, i) => (
                                  <span key={i} className="file">
                                    <Glyph name={f.mediaType?.startsWith("image/") ? "image" : "document"} size={12} />
                                    {f.name}
                                  </span>
                                ))}
                              </div>
                            ) : null}
                            {t.text}
                          </div>
                        </div>
                      ) : (
                        <div key={t.id} className="cv2-prose" style={{ marginTop: 16, whiteSpace: "pre-wrap" }}>
                          {t.text}
                        </div>
                      ),
                    )}
                    {starting && (
                      <div className="cv2-wl">
                        <span className="verb cv2-mute">{STARTING_LABEL}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}
              {!(turns !== null && turns.length === 0) && (
                <div className="cv2-cwrap">
                  <div className="cv2-col">
                    <StaticComposer repo={repo} />
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

/**
 * `/code/[id]` while the route loads: the session's frame, not the landing's.
 * Knows the thread only by its id, so it shows the landing's first prompt when
 * one is waiting for this thread, and skeleton lines otherwise.
 */
export function CodeSessionLoading() {
  const params = useParams<{ id?: string }>();
  const id = typeof params?.id === "string" ? params.id : null;
  const pending = usePendingPrompt(id);
  return <CodeSessionStatic title="" repo="" turns={pending ? [pending] : null} starting={!!pending} />;
}

/**
 * The live workspace's own first paint, server-rendered from the page's
 * props: the thread's latest turns as text, or the landing's first prompt.
 */
export function CodeSessionFirstPaint({ conversation, initialMessages }: { conversation: { id: string; title: string; codeWorkspaceName?: string | null }; initialMessages: ClientMessage[] }) {
  const pending = usePendingPrompt(conversation.id);
  const turns = staticTurns(initialMessages);
  const shown = turns.length ? turns : pending ? [pending] : [];
  return <CodeSessionStatic title={conversation.title || UNTITLED_LABEL} repo={conversation.codeWorkspaceName ?? ""} turns={shown} starting={!turns.length && !!pending} />;
}

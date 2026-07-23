"use client";

import * as React from "react";
import { ArrowDown } from "lucide-react";
import { MessageItem } from "@/components/chat/message-item";
import { cn } from "@/lib/utils";
import type { ChatMessage, ImageEditInput, SendResult } from "@/hooks/use-chat";
import type { ClientArtifact, GenerationStatus } from "@/types/chat";

interface MessageListProps {
  messages: ChatMessage[];
  busy: boolean;
  status?: GenerationStatus;
  artifacts: ClientArtifact[];
  onOpenArtifact: (identifier: string, opts?: { fullscreen?: boolean }) => void;
  /** Chat-only turn actions — optional so non-chat surfaces (code sessions)
   *  reuse the rendering without dead buttons. See MessageItemProps. */
  onRegenerate?: () => void;
  onContinue?: () => void;
  onEdit?: (id: string, content: string) => void;
  onFeedback: (id: string, value: "UP" | "DOWN" | null) => void;
  /** Per-message feedback eligibility — see MessageItemProps.canFeedback.
   *  Omit when every rendered message is backed by a persisted row. */
  canFeedback?: (message: ChatMessage) => boolean;
  onFork?: (id: string) => void;
  onSpeak?: (id: string, text: string) => void;
  speakingId?: string | null;
  privateMode?: boolean;
  onImageEdit?: (input: ImageEditInput) => SendResult;
  currentModelId?: string;
}

const SCROLL_FADE_STYLE: React.CSSProperties = {
  maskImage: "linear-gradient(to bottom, black 0%, black calc(100% - 72px), transparent 100%)",
  WebkitMaskImage: "linear-gradient(to bottom, black 0%, black calc(100% - 72px), transparent 100%)",
};

/*
 * A NOTE ON WHY THE FOLLOW IS NOT ANIMATED.
 *
 * An earlier version eased the follow: one rAF loop chasing the bottom, closing
 * a fraction of the remaining distance per frame. It looked better and it was
 * wrong, because it put the code and the reader in a tug of war over the same
 * scrollTop. Every fix bred another bug — the loop had to know which movements
 * were its own, that flag had to survive a hidden tab (where rAF never fires and
 * the loop parks forever on a frame that never comes), and any state that can
 * get stuck eventually does, at which point the transcript stops following for
 * the rest of the session with no way back.
 *
 * A reply grows a few pixels at a time, so pinning to the bottom on each update
 * is already smooth; there was never much to fix. The one place motion is safe
 * is "jump to latest", which is discrete, user-initiated, and cannot be racing
 * anything — that keeps `behavior: "smooth"`.
 *
 * The rule is one line: when new content arrives, follow it only if the reader
 * was already at the bottom before it arrived. Scroll away and the transcript
 * holds still; come back to the bottom and it picks you up again. No modes, no
 * flags, nothing that can end up stuck in the wrong state.
 */

/** How close to the bottom counts as "at the bottom" and resumes the follow.
 *  Small on purpose: it has to be tighter than a single wheel notch, or the
 *  scroll a reader's own gesture produces re-attaches the follow they were
 *  trying to escape. Wide enough to absorb sub-pixel and rounding drift. */
const ATTACH_SLOP_PX = 24;

export function MessageList(props: MessageListProps) {
  const { messages, artifacts } = props;
  const bottomRef = React.useRef<HTMLDivElement>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = React.useState(true);

  // Only animate messages that arrive after the initial mount, so opening an
  // existing conversation doesn't replay every entrance. Seed with the initial
  // count → those render instantly; later sends/streams rise in.
  const seenRef = React.useRef(messages.length);
  const animateFrom = seenRef.current;
  React.useEffect(() => {
    seenRef.current = messages.length;
  }, [messages.length]);

  const artifactsByIdentifier = React.useMemo(() => {
    const map = new Map<string, ClientArtifact>();
    for (const a of artifacts) map.set(a.identifier, a);
    return map;
  }, [artifacts]);

  /* Whether the reader was at the bottom BEFORE this content arrived.
   *
   * Deliberately not read from a `stickRef` that a scroll handler maintains.
   * That made following depend on the scroll event having fired before the
   * render, and when it hadn't — the content landing in the same tick as the
   * reader's scroll — the view yanked back down on someone who had just
   * scrolled away. Measuring the previous layout instead needs no event to
   * have run: the geometry is already there, whatever order things happened in.
   */
  const prevRef = React.useRef({ scrollHeight: 0, scrollTop: 0, clientHeight: 0 });

  const remember = React.useCallback((el: HTMLDivElement) => {
    prevRef.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop, clientHeight: el.clientHeight };
  }, []);

  // A scroll ending within reach of the bottom means the reader is back, and
  // the follow resumes. This window used to be 120px — about one wheel notch,
  // so the scroll a reader's own scroll-up produced landed inside it and
  // re-attached the follow they were trying to escape. That was the "can't
  // scroll up": every nudge snapped straight back.
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    remember(el);
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < ATTACH_SLOP_PX);
  };

  // Follow the bottom while the reader is at it.
  //
  // There used to be a second behaviour here: once a streaming reply outgrew
  // the viewport it would jump to that reply's TOP and detach itself, on the
  // reasoning that a long answer should be read from the start. In practice it
  // reads as the scroll breaking — the page stops following mid-reply for no
  // reason the reader can see, and "why did it stop" costs more than "I have to
  // scroll up myself" saves. Follow the bottom; let the reader decide when to
  // leave.
  //
  // Layout effect, not effect: this runs before paint, so the transcript is
  // never shown at the old position for a frame first.
  const last = messages[messages.length - 1];
  const lastContent = last?.content;
  React.useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const prev = prevRef.current;
    const wasAtBottom = prev.scrollHeight - prev.scrollTop - prev.clientHeight < ATTACH_SLOP_PX;
    if (wasAtBottom) el.scrollTop = el.scrollHeight - el.clientHeight;
    remember(el);
  }, [messages.length, lastContent, remember]);

  const jumpToLatest = () => {
    const el = scrollRef.current;
    setAtBottom(true);
    // Pretend we were already at the bottom, so a chunk landing mid-animation
    // is followed rather than treated as "the reader is away".
    if (el) prevRef.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollHeight, clientHeight: el.clientHeight };
    // Discrete and user-initiated, so it is the one scroll safe to animate:
    // nothing else is writing scrollTop at the same time.
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        // overflow-anchor:none — the browser's own scroll anchoring shifts
        // scrollTop when content resizes, which while streaming is constantly.
        // Left on, it moves the view out from under a reader who has scrolled
        // up, and nothing in here asked it to.
        className="h-full overflow-y-auto [overflow-anchor:none]"
        style={SCROLL_FADE_STYLE}
      >
        <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6">
          {messages.map((m, i) => (
            <MessageItem
              key={m.id}
              message={m}
              isLast={i === messages.length - 1}
              busy={props.busy}
              status={i === messages.length - 1 ? props.status : undefined}
              animateIn={i >= animateFrom}
              artifactsByIdentifier={artifactsByIdentifier}
              onOpenArtifact={props.onOpenArtifact}
              onRegenerate={props.onRegenerate}
              onContinue={props.onContinue}
              onEdit={props.onEdit}
              onFeedback={props.onFeedback}
              canFeedback={props.canFeedback ? props.canFeedback(m) : undefined}
              onFork={props.onFork}
              onSpeak={props.onSpeak}
              speaking={props.speakingId === m.id}
              privateMode={props.privateMode}
              onImageEdit={props.onImageEdit}
              currentModelId={props.currentModelId}
            />
          ))}
          <div ref={bottomRef} />
        </div>
      </div>

      <button
        type="button"
        onClick={jumpToLatest}
        aria-label="Scroll to latest"
        className={cn(
          "absolute bottom-4 left-1/2 z-10 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border bg-card/80 text-muted-foreground shadow-float backdrop-blur transition-all duration-base ease-out-soft hover:text-foreground active:scale-95 coarse:h-11 coarse:w-11",
          atBottom
            ? "pointer-events-none translate-y-2 opacity-0"
            : "opacity-100 motion-safe:animate-rise-in hover:-translate-y-0.5"
        )}
      >
        <ArrowDown className="h-4 w-4" />
      </button>
    </div>
  );
}

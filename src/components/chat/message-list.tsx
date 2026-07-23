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

/**
 * Eased scroll follow for a target that keeps moving.
 *
 * Writing `scrollTop` straight to the bottom on every token is what made the
 * transcript twitch — each chunk was a hard jump of whatever height it added.
 * `behavior: "smooth"` is worse: every token restarts the browser's own
 * animation from a standstill, so it stutters and never arrives. Instead one
 * rAF loop chases a target that callers keep updating, easing a fixed fraction
 * of the remaining distance per frame. That reads as a continuous glide at any
 * token rate, and it costs one loop rather than one animation per chunk.
 */
function useGlideScroll(scrollRef: React.RefObject<HTMLDivElement | null>) {
  const rafRef = React.useRef<number | null>(null);
  const targetRef = React.useRef(0);
  // True while the loop owns scrollTop, so the scroll handler can tell our own
  // movement from the user's — the read-from-top hold below glides *upward*,
  // which would otherwise look exactly like a user scrolling away.
  const glidingRef = React.useRef(false);
  // The last value the loop actually wrote. Anything else appearing in
  // scrollTop came from outside (wheel, scrollbar drag, keyboard, a jump), and
  // the loop has to let go rather than drag the view back to a stale target.
  const lastWriteRef = React.useRef(0);
  const reduceRef = React.useRef(false);

  React.useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => {
      reduceRef.current = mq.matches;
    };
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  const cancel = React.useCallback(() => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    glidingRef.current = false;
  }, []);

  React.useEffect(() => cancel, [cancel]);

  const glideTo = React.useCallback(
    (target: number) => {
      const el = scrollRef.current;
      if (!el) return;
      targetRef.current = target;
      if (reduceRef.current) {
        el.scrollTop = target;
        return;
      }
      // A loop is already running — it reads targetRef every frame, so the new
      // destination is picked up without restarting the easing.
      if (rafRef.current != null) return;
      glidingRef.current = true;
      lastWriteRef.current = el.scrollTop;
      const step = () => {
        const node = scrollRef.current;
        if (!node) return cancel();
        // Someone else moved the view since our last frame — yield to them.
        if (Math.abs(node.scrollTop - lastWriteRef.current) > 2) return cancel();
        const delta = targetRef.current - node.scrollTop;
        if (Math.abs(delta) < 0.5) {
          node.scrollTop = targetRef.current;
          return cancel();
        }
        node.scrollTop += delta * 0.22;
        // Read back: the browser clamps and snaps to device pixels, so the
        // value we wrote is not necessarily the value that landed.
        lastWriteRef.current = node.scrollTop;
        rafRef.current = requestAnimationFrame(step);
      };
      rafRef.current = requestAnimationFrame(step);
    },
    [cancel, scrollRef]
  );

  return { glideTo, cancel, glidingRef, lastWriteRef };
}

export function MessageList(props: MessageListProps) {
  const { messages, artifacts } = props;
  const bottomRef = React.useRef<HTMLDivElement>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const stickRef = React.useRef(true);
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

  const { glideTo, cancel, glidingRef, lastWriteRef } = useGlideScroll(scrollRef);
  const lastTopRef = React.useRef(0);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    // Our own easing fires this too. Movement that matches what the loop last
    // wrote is ours, so it carries no intent; anything else is the user and
    // takes the view back immediately (a scrollbar drag fires neither wheel
    // nor touch, so it can only be caught here).
    if (glidingRef.current) {
      if (Math.abs(el.scrollTop - lastWriteRef.current) <= 2) {
        lastTopRef.current = el.scrollTop;
        return;
      }
      cancel();
    }
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const scrolledUp = el.scrollTop < lastTopRef.current - 1;
    lastTopRef.current = el.scrollTop;
    // Direction, not distance alone, decides detachment. Measuring distance on
    // its own detached the follow whenever tokens arrived faster than the glide
    // could close the gap — the view would stop following mid-reply.
    if (scrolledUp && distance > 24) stickRef.current = false;
    else if (distance < 120) stickRef.current = true;
    setAtBottom(stickRef.current);
  };

  // A glide is ours to cancel the moment the user reaches for the transcript;
  // `onScroll` alone can't tell, since the loop is writing scrollTop too.
  const onUserScrollIntent = () => {
    if (glidingRef.current) cancel();
  };

  // Keep pinned to the bottom while streaming new content (instant — smooth on
  // every token janks). Honors the user scrolling up via the stick heuristic.
  // One exception (NN/g): once a streaming reply outgrows the viewport, hold the
  // view at the reply's top so it can be read from the start instead of chasing
  // the tail. The hold fires once per reply — re-sticking afterwards (scrolling
  // back down, or "jump to latest") resumes a plain bottom-follow.
  const last = messages[messages.length - 1];
  const lastContent = last?.content;
  const heldIdRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!stickRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    // The bottom sentinel's previous sibling is the last message's root node.
    const node = bottomRef.current?.previousElementSibling as HTMLElement | null;
    const bottom = el.scrollHeight - el.clientHeight;
    if (node && last?.role === "ASSISTANT" && last.streaming && heldIdRef.current !== last.id) {
      // Reply top in scroll coordinates, offset to mirror the container's py-6.
      const top = node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 24;
      if (top < bottom) {
        // Bottom-following would push the reply's first line off-screen — hold
        // here and release the stick so later tokens don't yank the view.
        heldIdRef.current = last.id;
        stickRef.current = false;
        setAtBottom(false);
        glideTo(Math.max(top, 0));
        return;
      }
    }
    glideTo(bottom);
  }, [messages.length, lastContent, last, glideTo]);

  const jumpToLatest = () => {
    const el = scrollRef.current;
    stickRef.current = true;
    setAtBottom(true);
    if (el) glideTo(el.scrollHeight - el.clientHeight);
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        onWheel={onUserScrollIntent}
        onTouchStart={onUserScrollIntent}
        onKeyDown={onUserScrollIntent}
        className="h-full overflow-y-auto"
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

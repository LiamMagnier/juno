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

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const stuck = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    stickRef.current = stuck;
    setAtBottom(stuck);
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
    // The bottom sentinel's previous sibling is the last message's root node.
    const node = bottomRef.current?.previousElementSibling as HTMLElement | null;
    if (el && node && last?.role === "ASSISTANT" && last.streaming && heldIdRef.current !== last.id) {
      const bottom = el.scrollHeight - el.clientHeight;
      // Reply top in scroll coordinates, offset to mirror the container's py-6.
      const top = node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 24;
      if (top < bottom) {
        // Bottom-following would push the reply's first line off-screen — hold
        // here and release the stick so later tokens don't yank the view.
        heldIdRef.current = last.id;
        stickRef.current = false;
        setAtBottom(false);
        el.scrollTop = Math.max(top, 0);
        return;
      }
    }
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, lastContent, last]);

  const jumpToLatest = () => {
    stickRef.current = true;
    setAtBottom(true);
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto" style={SCROLL_FADE_STYLE}>
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

"use client";

import * as React from "react";
import { ArrowDown } from "lucide-react";
import { MessageItem } from "@/components/chat/message-item";
import { cn } from "@/lib/utils";
import type { ChatMessage, ImageEditInput } from "@/hooks/use-chat";
import type { ClientArtifact, GenerationStatus } from "@/types/chat";

interface MessageListProps {
  messages: ChatMessage[];
  busy: boolean;
  status?: GenerationStatus;
  artifacts: ClientArtifact[];
  onOpenArtifact: (identifier: string, opts?: { fullscreen?: boolean }) => void;
  onRegenerate: () => void;
  onContinue: () => void;
  onEdit: (id: string, content: string) => void;
  onFeedback: (id: string, value: "UP" | "DOWN" | null) => void;
  onFork?: (id: string) => void;
  onSpeak?: (id: string, text: string) => void;
  speakingId?: string | null;
  privateMode?: boolean;
  onImageEdit?: (input: ImageEditInput) => void;
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
  const lastContent = messages[messages.length - 1]?.content;
  React.useEffect(() => {
    if (stickRef.current) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, lastContent]);

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

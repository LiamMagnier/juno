"use client";

import * as React from "react";
import { contextReceiptFromActivity } from "@/lib/chat/context-tokens";
import { ArrowDown } from "@/components/ui/icons";
import { MessageItem } from "@/components/chat/message-item";
import { useTranscriptWindow, VIRTUALIZE_AFTER } from "@/hooks/use-transcript-window";
import { useLatestHandler } from "@/hooks/use-latest-handler";
import { countTranscriptRender, placeInlineRuns } from "@/lib/chat/transcript-window";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { ChatMessage, ImageEditInput, RegenerateOptions, SendResult } from "@/hooks/use-chat";
import type { ClientArtifact, ClientAttachment, GenerationStatus } from "@/types/chat";

interface MessageListProps {
  messages: ChatMessage[];
  /**
   * Durable runs drawn inside the transcript, each placed after the turn that
   * started it.
   *
   * Called `researchContents` while a deep-research run was the only thing that
   * could live in a conversation. A delegated task is the second
   * (`work-run-panel.tsx`), and a slot named after one of its two occupants is
   * how the next reader concludes the other one does not belong here.
   */
  inlineRuns?: Array<{ id: string; createdAt: string; node: React.ReactNode }>;
  busy: boolean;
  status?: GenerationStatus;
  artifacts: ClientArtifact[];
  onOpenArtifact: (identifier: string, opts?: { fullscreen?: boolean }) => void;
  /** A card changed its artifact (restore, suggestion applied or dismissed) —
   *  see MessageItemProps.onArtifactChanged. Must be stable. */
  onArtifactChanged?: (artifact: ClientArtifact) => void;
  /** Chat-only turn actions — optional so non-chat surfaces (code sessions)
   *  reuse the rendering without dead buttons. See MessageItemProps. */
  onRegenerate?: (options?: RegenerateOptions) => void;
  onContinue?: () => void;
  onEdit?: (id: string, content: string) => void;
  /** Re-send a turn the server never received — see MessageItemProps.onResend. */
  onResend?: (id: string, content?: string) => void;
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
  /** Open a file in the side viewer — see MessageItemProps.onOpenAttachment. */
  onOpenAttachment?: (attachment: ClientAttachment) => void;
  /** Names the transcript for assistive tech. Rendered as a visually-hidden
   *  <h1>: /chat/[id] had no heading at all once a conversation had messages,
   *  so there was nothing for a screen reader to navigate to. */
  conversationTitle?: string;
  /** The parent draws a VISIBLE <h1> for this conversation from `md` up (the
   *  chat column's header band). When set, this list's own heading stays for
   *  narrow viewports only, so the page never carries two h1s at once. */
  titleShownInHeader?: boolean;
  /** Merged onto the root. Exists for the first-message handoff (chat-view),
   *  which fades the transcript region in under the travelling composer. */
  className?: string;
  /**
   * Settle the transcript in on mount instead of cutting to it.
   *
   * Set by the surfaces that KEY this component on the conversation, so a new
   * mount means a different thread — moving from one chat to another. The
   * transcript rises 6px and fades on the product's workhorse entrance while
   * the header, the sidebar and the composer around it stay exactly where they
   * are, which is what makes the switch read as one column changing rather
   * than as the window repainting.
   *
   * Off during the first-message handoff: that choreography measures the empty
   * composer's position and travels it down the page (chat-view), and a second
   * entrance underneath it is two animations describing one event.
   */
  entrance?: boolean;
  /**
   * Which product is drawing the transcript. A Code session renders its
   * tool calls as its own cards (see components/code/code-activity.tsx), so
   * its turns skip the chat's thought-process strip and word their live
   * status from the running command rather than "Thinking about your
   * request". Chat is the default.
   */
  surface?: "chat" | "code";
}

const SCROLL_FADE_STYLE: React.CSSProperties = {
  maskImage: "linear-gradient(to bottom, black 0%, black calc(100% - 72px), transparent 100%)",
  WebkitMaskImage: "linear-gradient(to bottom, black 0%, black calc(100% - 72px), transparent 100%)",
};

/** Follow is instant: streaming, measurement corrections and virtual jumps
 *  cannot race a smooth-scroll animation. The window hook preserves the
 *  reader's measured anchor whenever they leave the newest turn. */

type ItemProps = React.ComponentProps<typeof MessageItem>;
const TranscriptMessage = React.memo(function TranscriptMessage({ receiptActivity, ...props }: Omit<ItemProps, "contextReceipt"> & { receiptActivity?: ChatMessage["activity"] }) {
  if (process.env.NODE_ENV !== "production") countTranscriptRender(props.message.renderKey ?? props.message.id);
  const receipt = React.useMemo(() => contextReceiptFromActivity(receiptActivity), [receiptActivity]);
  return <MessageItem {...props} contextReceipt={receipt} />;
});

function MeasuredTurn({ message, observe, children }: {
  message: ChatMessage;
  observe: (element: HTMLDivElement, key: string) => () => void;
  children: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const key = message.renderKey ?? message.id;
  React.useLayoutEffect(() => ref.current ? observe(ref.current, key) : undefined, [observe, key]);
  return <div ref={ref} data-message-id={message.id} data-transcript-key={key} className="pb-6">{children}</div>;
}

// The chat's turn actions arrive as new functions on every streamed token
// (use-chat's callbacks close over its options and messages). Stable wrappers
// keep each settled row's memo intact, so a token re-renders the streaming row
// alone — measured on /chat/[id] before this: every mounted settled row
// rendered once per token. See hooks/use-latest-handler.ts.
export function MessageList(props: MessageListProps) {
  const { messages, artifacts } = props;
  const onOpenArtifact = useLatestHandler(props.onOpenArtifact);
  const onArtifactChanged = useLatestHandler(props.onArtifactChanged);
  const onRegenerate = useLatestHandler(props.onRegenerate);
  const onContinue = useLatestHandler(props.onContinue);
  const onEdit = useLatestHandler(props.onEdit);
  const onResend = useLatestHandler(props.onResend);
  const onFeedback = useLatestHandler(props.onFeedback);
  const onFork = useLatestHandler(props.onFork);
  const onSpeak = useLatestHandler(props.onSpeak);
  const onImageEdit = useLatestHandler(props.onImageEdit);
  const onOpenAttachment = useLatestHandler(props.onOpenAttachment);
  const runsByMessage = new Map<number, React.ReactNode[]>();
  const runNodes = new Map((props.inlineRuns ?? []).map((item) => [item.id, item.node]));
  for (const [index, ids] of placeInlineRuns(messages, props.inlineRuns ?? [])) {
    runsByMessage.set(index, ids.map((id) => <React.Fragment key={id}>{runNodes.get(id)}</React.Fragment>));
  }
  const transcript = useTranscriptWindow(messages);
  const { scrollRef, contentRef, atBottom, onScroll, jumpToLatest } = transcript;
  // Seeded true when no entrance was asked for, so the class never goes on and
  // nothing is left waiting for an animationend that will not fire.
  const [entered, setEntered] = React.useState(!props.entrance);

  // Only animate messages that arrive after the initial mount, so opening an
  // existing conversation doesn't replay every entrance. Seed with the initial
  // count → those render instantly; later sends/streams rise in.
  const seenRef = React.useRef(messages.length);
  const animateFrom = seenRef.current;
  React.useEffect(() => {
    seenRef.current = messages.length;
  }, [messages.length]);

  // The newest user turn is the one ↑ edits from an empty composer.
  const lastUserId = React.useMemo(() => [...messages].reverse().find((m) => m.role === "USER" && !m.pending)?.id ?? null, [messages]);

  const artifactsByIdentifier = React.useMemo(() => {
    const map = new Map<string, ClientArtifact>();
    for (const a of artifacts) map.set(a.identifier, a);
    return map;
  }, [artifacts]);

  // Announce that a reply finished, once, instead of streaming every token to
  // the screen reader as it arrives. `content` is deliberately NOT a dependency:
  // the announcement fires on the streaming edge, not on each delta.
  const [completionAnnouncement, setCompletionAnnouncement] = React.useState("");
  const wasStreamingRef = React.useRef(false);
  const last = messages[messages.length - 1];
  const lastStreaming = Boolean(last?.streaming);
  React.useEffect(() => {
    const finished = wasStreamingRef.current && !lastStreaming;
    wasStreamingRef.current = lastStreaming;
    if (!finished || !last || last.role !== "ASSISTANT") return;
    if (last.error) {
      setCompletionAnnouncement("Response failed.");
      return;
    }
    const words = (last.content ?? "").trim().split(/\s+/).filter(Boolean).length;
    setCompletionAnnouncement(`Response complete, ${words} ${words === 1 ? "word" : "words"}.`);
    // `last` is read only on the edge; re-running per delta is exactly what this
    // effect exists to avoid.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastStreaming]);

  return (
    <div className={cn("relative min-h-0 flex-1", props.className)}>
      {/*
        The single speaking element for stream completion. Outside the transcript
        so it is not also inside role="log", and data-no-auto-translate so the
        AutoTranslate MutationObserver does not rewrite the text and trigger a
        second announcement in the translated locale.
      */}
      <span className="sr-only" role="status" aria-live="polite" data-no-auto-translate>
        {completionAnnouncement}
      </span>
      {messages.length > VIRTUALIZE_AFTER && (
        <button type="button" onClick={() => transcript.setShowAll(!transcript.showAll)} className="sr-only focus:not-sr-only focus:absolute focus:top-0 focus:z-20 focus:rounded-field focus:bg-popover focus:p-2">
          {transcript.showAll ? "Use compact conversation view" : "Read full conversation"}
        </button>
      )}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        onKeyDown={transcript.onKeyDown}
        onFocusCapture={transcript.onFocusCapture}
        onBlurCapture={transcript.onBlurCapture}
        tabIndex={0}
        aria-label="Conversation messages"
        data-transcript-windowed={transcript.windowed || undefined}
        // overflow-anchor:none — the browser's own scroll anchoring shifts
        // scrollTop when content resizes, which while streaming is constantly.
        // Left on, it moves the view out from under a reader who has scrolled
        // up, and nothing in here asked it to.
        // `scrollbar-gutter: stable both-edges`: a classic (non-overlay)
        // scrollbar would otherwise eat ~15px from the right of this scroller
        // and slide the transcript column ~7px left of the composer, which
        // sits outside it. Reserving the gutter on both sides keeps the two
        // columns on one centre line whatever the platform's scrollbars do.
        className="h-full overflow-y-auto [overflow-anchor:none] [scrollbar-gutter:stable_both-edges]"
        style={SCROLL_FADE_STYLE}
      >
        {/*
        role="log" gives screen-reader users a named region to navigate to —
        the transcript had no role, no label and no landmark of any kind.

        aria-live="off" is deliberate and load-bearing. role="log" carries an
        implicit aria-live="polite", and each assistant turn's answer body is
        ALREADY its own polite region (message-item.tsx). Leaving both on makes
        every reply announce twice. Speech comes from three narrower places
        instead: StreamStatus ("Thinking" / "Writing"), the per-turn region
        once the turn is complete, and the completion announcer below.
      */}
      {/* The page's <h1> once the empty state is gone, for heading
          navigation — how screen-reader users orient. Visually hidden here:
          from `md` up the chat column's header band shows the title (and is
          the h1 there, so this one leaves the tree with `md:hidden`); below
          `md` the shell's mobile bar shows it as plain text, and this stays
          the one heading. */}
      <h1 className={cn("sr-only", props.titleShownInHeader && "md:hidden")}>{props.conversationTitle || "Conversation"}</h1>
      <div
        ref={contentRef}
        role="log"
        aria-label="Conversation transcript"
        aria-live="off"
        /*
         * The entrance runs on the CONTENT, not on the scroller around it, and
         * that is the whole reason it is safe.
         *
         * A transform on the scroller would make it a containing block for
         * anything `fixed` inside it for as long as the class is on — the trap
         * page-transition.tsx documents and drops its class to escape. This box
         * is inside the scroller and holds nothing but message wrappers, and a
         * transform on it changes no layout at all, so the layout effect above
         * can still pin `scrollTop` to the true bottom while the thread slides
         * the last six pixels into place over it.
         *
         * Dropped the moment it has run, for the same reason: one entrance per
         * mount, no transform left standing.
         */
        onAnimationEnd={(e) => {
          // Only this box's own entrance. Every message wrapper inside runs
          // `rise-in` too, and each of those bubbles an animationend up here.
          if (e.target === e.currentTarget) setEntered(true);
        }}
        // The same column as the composer, and now literally the same gutter
        // as every other surface in the product (`.page-gutter`, globals.css):
        // bubbles' outer edges and the composer's edges are one line.
        className={cn(
          "page-gutter mx-auto w-full transcript-column pt-6",
          !entered && "motion-safe:animate-rise-in",
        )}
      >
          {transcript.indices.map((i, position) => {
            const m = messages[i];
            const previousEnd = position === 0 ? 0 : transcript.layout.offsets[transcript.indices[position - 1] + 1];
            const gap = transcript.layout.offsets[i] - previousEnd;
            return <React.Fragment key={m.renderKey ?? m.id}>
            {gap > 0 && <div aria-hidden style={{ height: gap }} />}
            <MeasuredTurn message={m} observe={transcript.observeRow}>
            <TranscriptMessage
              message={m}
              receiptActivity={m.role === "USER" ? messages[i + 1]?.activity : undefined}
              isLast={i === messages.length - 1}
              busy={props.busy}
              status={i === messages.length - 1 ? props.status : undefined}
              animateIn={i >= animateFrom}
              artifactsByIdentifier={artifactsByIdentifier}
              onOpenArtifact={onOpenArtifact}
              onArtifactChanged={onArtifactChanged}
              onRegenerate={onRegenerate}
              onContinue={onContinue}
              onEdit={onEdit}
              onResend={onResend}
              surface={props.surface}
              editOnRequest={m.id === lastUserId}
              onFeedback={onFeedback}
              canFeedback={props.canFeedback ? props.canFeedback(m) : undefined}
              onFork={onFork}
              onSpeak={onSpeak}
              speaking={props.speakingId === m.id}
              privateMode={props.privateMode}
              onImageEdit={onImageEdit}
              onOpenAttachment={onOpenAttachment}
              currentModelId={props.currentModelId}
            />
            {runsByMessage.get(i)}
            </MeasuredTurn>
            </React.Fragment>;
          })}
          {transcript.indices.length > 0 && transcript.indices[transcript.indices.length - 1] < messages.length - 1 && (
            <div aria-hidden style={{ height: transcript.layout.total - transcript.layout.offsets[transcript.indices[transcript.indices.length - 1] + 1] }} />
          )}
          {runsByMessage.get(-1)}
          <div />
        </div>
      </div>

      {/* `pointer-events-none` hides this from the mouse and from nobody else:
          the button stayed in the tab order at opacity 0, so a keyboard user
          walking the transcript landed on an invisible control that scrolled the
          view when activated. Hidden means hidden — out of the a11y tree and out
          of the tab order. (message-item's action cluster solves the same problem
          the other way, with focus-within:opacity-100; that is right for controls
          that should be REACHABLE while invisible. This one is redundant when the
          reader is already at the bottom.) */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={jumpToLatest}
            aria-label="Jump to latest"
            aria-hidden={atBottom || undefined}
            tabIndex={atBottom ? -1 : undefined}
            className={cn(
              // `transition-all` animated the backdrop-blur, the border and
              // shadow-float alongside the intended transform/opacity, and the
              // control had no reduced-motion escape — the visually identical
              // button in message-item.tsx does guard itself.
              // Opaque `bg-popover`, not `bg-card/80` behind a blur. This button
              // floats over the live transcript, and on the black ground card at 80%
              // resolves to ~5% lightness while the blur has no colour to smear —
              // so the message text scrolling underneath showed straight through the
              // glyph. A floating layer takes the floating rung.
              // `active:duration-press`: transform is in the transition list, so
              // without it the dip ran at --dur-base — 220ms to reach 0.97, three
              // times the rung `.pressable` splits transform onto because a press
              // that slow is felt as lag.
              // Hover is tonal, not a lift: the fill cross-fades to --accent and
              // the arrow nudges down on its own (icons.tsx), which is the gesture
              // that says where the press goes. The button rising toward the
              // pointer said the opposite.
              // Centred with `inset-x-0 mx-auto`, not `left-1/2 -translate-x-1/2`:
              // `animate-rise-in` writes `transform` for its whole run, which
              // replaced the centring translate, so the button arrived 18px
              // right of centre and jumped back when the entrance ended.
              "absolute inset-x-0 bottom-4 z-10 mx-auto flex size-9 items-center justify-center rounded-full border bg-popover text-muted-foreground shadow-float transition-[transform,opacity,color,background-color] duration-base ease-out-soft hover:bg-accent hover:text-foreground active:scale-[0.97] active:duration-press coarse:size-11",
              "motion-reduce:transition-none motion-reduce:active:scale-100",
              atBottom
                ? "pointer-events-none translate-y-2 opacity-0"
                : "opacity-100 motion-safe:animate-rise-in"
            )}
          >
            <ArrowDown className="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">Jump to latest</TooltipContent>
      </Tooltip>
    </div>
  );
}

"use client";

import { AgentThreadContext } from "@/components/agents/agent-thread-context";
import type { RoomSpeaker } from "@/lib/agents/room-client";
import * as React from "react";
import { contextReceiptFromActivity } from "@/lib/chat/context-tokens";
import { ArrowDown } from "@/components/ui/icons";
import { MessageItem } from "@/components/chat/message-item";
import { TranscriptRail } from "@/components/chat/transcript-rail";
import { useTranscriptWindow, VIRTUALIZE_AFTER } from "@/hooks/use-transcript-window";
import { useLatestHandler } from "@/hooks/use-latest-handler";
import { shouldLoadOlder } from "@/lib/chat/history-client";
import { countTranscriptRender, firstArrivalAfterHeld, placeInlineRuns } from "@/lib/chat/transcript-window";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { FeedbackDetail } from "@/lib/feedback-reasons";
import type { ChatMessage, ImageEditInput, LoadOlderRequest, RegenerateOptions, SendResult } from "@/hooks/use-chat";
import type { ClientArtifact, ClientAttachment, ConversationHistory, GenerationStatus } from "@/types/chat";

interface MessageListProps {
  messages: ChatMessage[];
  /**
   * A paged transcript (lib/chat/history-page.ts): `messages` is the newest
   * part of the conversation and `onLoadOlder` reads further back. Scrolling
   * near the top asks for the next page, and the reader's line holds still as
   * it lands above them. Absent: `messages` is the whole conversation.
   */
  history?: ConversationHistory;
  loadingOlder?: boolean;
  onLoadOlder?: (request?: LoadOlderRequest) => Promise<unknown>;
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
  /** Regenerate an earlier answer as a new branch — see MessageItemProps.onRegenerateAt. */
  onRegenerateAt?: (id: string, options?: RegenerateOptions) => void;
  /** Show another branch — see MessageItemProps.onSelectBranch. */
  onSelectBranch?: (id: string) => Promise<unknown> | void;
  onContinue?: () => void;
  onEdit?: (id: string, content: string) => void;
  /** Re-send a turn the server never received — see MessageItemProps.onResend. */
  onResend?: (id: string, content?: string) => void;
  onFeedback: (id: string, value: "UP" | "DOWN" | null, detail?: FeedbackDetail) => void;
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
  /**
   * In a room (src/lib/agents/rooms.ts): who wrote this reply, drawn as that
   * agent's byline, with the handoff line ("Mira asked Scout to check the
   * pricing") above an asked member's reply. Null for every other message.
   */
  speakerFor?: (message: ChatMessage, isLast: boolean) => RoomSpeaker | null;
}

/** "Mira asked Scout to check the pricing": an annotation, not a card. */
function RoomHandoffLine({ text }: { text: string }) {
  return (
    <p className="mb-2 font-mono text-label font-normal text-muted-foreground motion-safe:animate-fade-in">
      {text}
    </p>
  );
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
  // Space pairs a question with its reply: a short step from a question down
  // to its answer, a longer one from an answer to the next question, so a
  // long thread scans as turns rather than as evenly spaced blocks. On a
  // coarse pointer the question's own 44px actions sit under it at rest, so
  // the answer's step grows to keep the pair reading as one. Heights are
  // measured (observeRow), so windowing, the rail and the answer bed follow
  // without knowing the rule.
  return <div ref={ref} data-message-id={message.id} data-transcript-key={key} className={message.role === "USER" ? "pb-1" : "pb-8 coarse:pb-12"}>{children}</div>;
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
  const onRegenerateAt = useLatestHandler(props.onRegenerateAt);
  const onSelectBranch = useLatestHandler(props.onSelectBranch);
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
  const hasOlder = Boolean(props.history?.hasOlder);
  for (const [index, ids] of placeInlineRuns(messages, props.inlineRuns ?? [])) {
    // A run placed before every loaded question started in history that has
    // not loaded yet; it takes its place under its turn when that arrives,
    // rather than at the foot of the transcript, which is where -1 draws.
    if (index === -1 && hasOlder) continue;
    runsByMessage.set(index, ids.map((id) => <React.Fragment key={id}>{runNodes.get(id)}</React.Fragment>));
  }
  const onLoadOlder = useLatestHandler(props.onLoadOlder);
  const pagedTranscript = Boolean(props.onLoadOlder);
  const transcript = useTranscriptWindow(messages, {
    onMissingMessage: pagedTranscript ? (messageId) => void onLoadOlder?.({ throughMessageId: messageId }) : undefined,
  });
  const { scrollRef, contentRef, atBottom, onScroll, jumpToLatest } = transcript;
  // Paged history: read the next older page while the reader still has about
  // two screens of transcript above them, so scrolling up rarely meets the top.
  const viewportTop = transcript.viewport.top;
  const viewportHeight = transcript.viewport.height;
  const failedAtRef = React.useRef(0);
  React.useEffect(() => {
    if (!hasOlder || props.loadingOlder || !pagedTranscript || !Number.isFinite(viewportTop)) return;
    // The live position, not the state: in the commit where a page lands, the
    // window hook has already moved the scroller down by the page's height but
    // its viewport state still says "near the top", which read as a second
    // request for the next page nobody scrolled to.
    const top = scrollRef.current?.scrollTop ?? viewportTop;
    if (!shouldLoadOlder(top, viewportHeight, failedAtRef.current)) return;
    void onLoadOlder?.().then((result) => {
      if (result === null) failedAtRef.current = Date.now();
    });
  }, [hasOlder, props.loadingOlder, pagedTranscript, viewportTop, viewportHeight, onLoadOlder, scrollRef]);

  // From two turns up the rail stands in for the scrollbar (sm and wider; a
  // phone keeps its own scroll indicator and the full width for the text).
  const hasRail = React.useMemo(() => messages.filter((m) => m.role === "USER").length > 1, [messages]);
  // Seeded true when no entrance was asked for, so the class never goes on and
  // nothing is left waiting for an animationend that will not fire.
  const [entered, setEntered] = React.useState(!props.entrance);

  // Only animate messages that arrive after the initial mount, so opening an
  // existing conversation doesn't replay every entrance. Seed with the initial
  // count → those render instantly; later sends/streams rise in.
  // Older pages prepended above (paged history) shift every index by their
  // length, so the count is offset by where the previous first row now sits:
  // history arriving above must not replay its entrance either.
  //
  // A branch switch (the "‹ 2/3 ›" pager) replaces the rows after a turn with
  // another branch's. Those rows are new to this list though their indices
  // may be old ones, so they rise in too: whatever follows a row that was
  // already here and was not here itself is arriving now. The switched turn
  // keeps its key (use-chat hands it over), so it holds still.
  const seenRef = React.useRef({
    count: messages.length,
    firstKey: messages[0] ? (messages[0].renderKey ?? messages[0].id) : undefined,
    keys: new Set(messages.map((m) => m.renderKey ?? m.id)),
  });
  const animateFrom = seenRef.current.count + (seenRef.current.firstKey ? (transcript.layout.indexByKey.get(seenRef.current.firstKey) ?? 0) : 0);
  const arrivedFrom = React.useMemo(
    () => firstArrivalAfterHeld(messages.map((m) => m.renderKey ?? m.id), seenRef.current.keys),
    // Recomputed per message list only; the ref holds the previous list's keys.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [messages],
  );
  React.useEffect(() => {
    seenRef.current = {
      count: messages.length,
      firstKey: messages[0] ? (messages[0].renderKey ?? messages[0].id) : undefined,
      keys: new Set(messages.map((m) => m.renderKey ?? m.id)),
    };
  }, [messages]);

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
        <button
          type="button"
          onClick={() => {
            // "Read full conversation" means all of it, not the part loaded so far.
            if (!transcript.showAll && hasOlder) void onLoadOlder?.({ all: true });
            transcript.setShowAll(!transcript.showAll);
          }}
          className="sr-only focus:not-sr-only focus:absolute focus:top-0 focus:z-20 focus:rounded-field focus:bg-popover focus:p-2">
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
        className={cn(
          "h-full overflow-y-auto [overflow-anchor:none] [scrollbar-gutter:stable_both-edges]",
          hasRail && "sm:[scrollbar-width:none] sm:[&::-webkit-scrollbar]:hidden",
        )}
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
        // How much of a paged conversation is here; read by the benchmark and
        // e2e/transcript-history.spec.ts. Absent on a transcript that does not page.
        data-history-loaded={props.history ? messages.length : undefined}
        data-history-older={props.history ? String(props.history.hasOlder) : undefined}
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
        // `pb-12`: at the end of the scroll range the newest answer's toolbar
        // clears the 72px bottom fade (its row's own pb-8 plus these 48px);
        // text still fades under the composer while the reader is scrolled up.
        // The answer bed measures from this same box, so the pin holds.
        className={cn(
          "page-gutter mx-auto w-full transcript-column pt-6 pb-12",
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
            {(() => {
            const speaker = m.role === "ASSISTANT" && props.speakerFor ? props.speakerFor(m, i === messages.length - 1) : null;
            const item = <TranscriptMessage
              message={m}
              receiptActivity={m.role === "USER" ? messages[i + 1]?.activity : undefined}
              isLast={i === messages.length - 1}
              busy={props.busy}
              status={i === messages.length - 1 ? props.status : undefined}
              animateIn={i >= animateFrom || (i >= arrivedFrom && !seenRef.current.keys.has(m.renderKey ?? m.id))}
              artifactsByIdentifier={artifactsByIdentifier}
              onOpenArtifact={onOpenArtifact}
              onArtifactChanged={onArtifactChanged}
              onRegenerate={onRegenerate}
              // A room plans who answers from its newest message, so only that
              // answer can be redone there.
              onRegenerateAt={props.onRegenerateAt && !props.speakerFor ? onRegenerateAt : undefined}
              onSelectBranch={props.onSelectBranch ? onSelectBranch : undefined}
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
            />;
            return speaker ? (
              <>
                {speaker.handoff && <RoomHandoffLine text={speaker.handoff} />}
                <AgentThreadContext.Provider value={{ name: speaker.name, avatar: speaker.avatar, state: speaker.state }}>
                  {item}
                </AgentThreadContext.Provider>
              </>
            ) : item;
            })()}
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
        {/*
          The answer bed (reading-first follow, use-transcript-window.ts):
          reserved space under a just-sent question, sized so the end of the
          scroll range is the question pinned near the top. The hook writes
          its height before paint; React never sets it, so a re-render cannot
          snap it back. Outside the log, so it is never content.
        */}
        <div ref={transcript.bedRef} aria-hidden data-answer-bed="" className="pointer-events-none" />
      </div>

      {hasRail && (
        <TranscriptRail
          messages={messages}
          layout={transcript.layout}
          viewport={transcript.viewport}
          atBottom={atBottom}
          onFocusMessage={transcript.focusMessage}
          onJumpToLatest={jumpToLatest}
          className="z-10 hidden sm:block"
        />
      )}

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

"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { ChevronRight } from "lucide-react";
import { ThoughtProcessPanel, buildRun, domainOf, formatSpan, useRunClock } from "@/components/chat/thought-process-panel";
import { useThoughtPanel } from "@/components/chat/thought-panel-context";
import { cn, truncate } from "@/lib/utils";
import type { ClientActivityEvent } from "@/types/chat";

/** One-line preview of the current activity. Both layers are absolutely
 *  positioned inside a fixed-height row, so text swaps never reflow the answer
 *  below.
 *
 *  Crossfade without state: `prevRef` lands after paint, so during the render
 *  that introduces a new `id` it still holds the outgoing one — keying the
 *  bottom layer on it remounts and plays the exit exactly once. Re-renders that
 *  only change `text` (the reasoning tail, which grows token by token) keep the
 *  same key and update in place, so the line never strobes.
 *
 *  PROPS STAY PRIMITIVE. The 100ms tick re-renders this component ten times a
 *  second with identical content; primitive comparison means the refinement
 *  branch below sees no change and never setStates. Passing composed ReactNode
 *  children instead would compare by reference, fire on every tick, and double
 *  the render count for nothing. */
function PreviewLine({
  id,
  lead,
  text,
  note,
}: {
  id: string;
  /** Mono phase word. Present only while live — it IS the state signal. */
  lead?: string;
  text: string;
  /** Warning clause, appended in text-warning. */
  note?: string;
}) {
  /*
   * Both layers are keyed by the INCOMING event's id, so a new event remounts the
   * pair together and their fade-out/fade-in run as one crossfade.
   *
   * This previously tracked `prev` in a ref committed by a post-paint effect, and
   * keyed the outgoing layer `out-${prev.id}`. That key therefore lagged a render
   * behind: on the A→B render it was still `out-A` — the same key as the previous
   * render — so React never remounted the layer, its fade-out never re-ran, and
   * `fill-mode-forwards` had already parked it at opacity 0. The outgoing text was
   * invisible and the new one popped. Deriving during render fixes the timing;
   * keying both layers off the same id fixes the pairing.
   */
  const [shown, setShown] = React.useState({ id, lead, text, note });
  const [outgoing, setOutgoing] = React.useState<{ lead?: string; text: string; note?: string } | null>(null);
  if (id !== shown.id) {
    // A different event: hand the old text to the outgoing layer and crossfade.
    setOutgoing({ lead: shown.lead, text: shown.text, note: shown.note });
    setShown({ id, lead, text, note });
  } else if (lead !== shown.lead || text !== shown.text || note !== shown.note) {
    // Same event, refined text (detail arriving late). Update in place — no
    // crossfade — but still track it, or the NEXT crossfade would fade out text
    // that has not been on screen since.
    setShown({ id, lead, text, note });
  }

  const body = (layer: { lead?: string; text: string; note?: string }) => (
    // flex + gap sets the gutter. The lead is shrink-0 so the coral phase word
    // can never be clipped by the object's truncation, and items-baseline sits
    // 11px mono and 15px sans on one line properly rather than by eye.
    <span className="flex min-w-0 items-baseline gap-2">
      {layer.lead && (
        <span className="shrink-0 font-mono text-caption uppercase tracking-[0.1em] text-primary">{layer.lead}</span>
      )}
      <span
        className={cn(
          "min-w-0 truncate text-body transition-colors duration-base ease-out-soft group-hover/thought:text-foreground/85 motion-reduce:transition-none",
          layer.note ? "text-warning" : "text-muted-foreground/70"
        )}
      >
        {layer.text}
        {layer.note && <span className="text-warning"> · {layer.note}</span>}
      </span>
    </span>
  );

  return (
    /* aria-hidden: this text is rewritten per reasoning token inside an
       aria-live region. The button's aria-label carries the state instead. */
    <span aria-hidden="true" className="relative min-w-0 flex-1 self-stretch">
      {outgoing && (
        <span
          key={`out-${shown.id}`}
          aria-hidden="true"
          /* RULE-4 EXCEPTION, DELIBERATE AND LOAD-BEARING: `duration-base` sits on
             an `animate-*` element. tailwindcss-animate makes duration-* set
             animation-duration too, which normally CLOBBERS the animation — here
             that is exactly the intent, and duration-base IS the crossfade's
             duration. Do not "clean this up". */
          className="absolute inset-0 flex items-center duration-base ease-out-soft motion-safe:animate-out motion-safe:fade-out-0 motion-safe:fill-mode-forwards motion-reduce:hidden"
        >
          {body(outgoing)}
        </span>
      )}

      <span
        key={`in-${shown.id}`}
        className="absolute inset-0 flex items-center duration-base ease-out-soft motion-safe:animate-in motion-safe:fade-in-0"
      >
        {body(shown)}
      </span>
    </span>
  );
}

/**
 * The collapsed line in the message list. It is a SENTENCE, not a component —
 * no border, no card, no chip, no icon badge, and nothing that took zero time
 * wearing a shape that implies it took some.
 *
 *   live    THINKING  reading nytimes.com          4.2s  ›
 *   rest    Thought · 4 searches · 9 sources       8.4s  ›
 *
 * The duration occupies the SAME node, slot and typeface in both states, so the
 * eye tracks one continuous object from meter to receipt. Completion is four
 * discrete signals — the tick freezes, the number demotes, nouns appear, coral
 * leaves — and motion stopping is the least of them.
 */
export function ActivityTimeline({
  messageId,
  events,
  reasoning,
  streaming,
}: {
  /** Identifies THIS run's panel in the chat-scoped open state, so only one
   *  dock is open at a time across the whole thread. */
  messageId: string;
  events?: ClientActivityEvent[];
  reasoning?: string | null;
  streaming?: boolean;
}) {
  // Open/close lives in chat-view (see thought-panel-context): the panel is a
  // docked column and cannot be painted from inside this scrolling row. The RUN
  // and its clock stay here, and the panel rides a portal to reach the dock.
  const panel = useThoughtPanel();
  const open = !!panel && panel.openId === messageId;
  const panelDomId = `thought-panel-${messageId}`;
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const list = React.useMemo(() => events ?? [], [events]);

  // Focus comes back on close — the panel took it on open and nothing else
  // claimed it (Esc, or the close button, which unmounts under the caret and
  // drops focus to <body>). If the user closed this dock by opening ANOTHER
  // row's, focus is already on that row's trigger, so we leave it alone rather
  // than yanking it backwards.
  const wasOpen = React.useRef(false);
  React.useEffect(() => {
    if (wasOpen.current && !open) {
      const active = document.activeElement;
      if (!active || active === document.body) triggerRef.current?.focus();
    }
    wasOpen.current = open;
  }, [open]);

  const hasEvents = list.length > 0;
  const hasReasoning = !!reasoning?.trim();

  // WITHDRAW THE CLAIM when there is nothing left to show. The dock is keyed on
  // `messageId`, but this row can stop rendering while that id stays perfectly
  // valid: paging the VersionPager back to an older version hands us
  // `activity: undefined` and `reasoning: null` under the SAME message, and the
  // early return below takes the panel AND the trigger with it — leaving an
  // empty dock with nothing left to toggle it shut. chat-view reconciles against
  // the message list and cannot see this; only we can.
  const renders = hasEvents || hasReasoning;
  const setPanelOpenId = panel?.setOpenId;
  React.useEffect(() => {
    if (open && !renders) setPanelOpenId?.(null);
  }, [open, renders, setPanelOpenId]);

  // THE run's clock and THE run's model — singular, and passed down to the panel
  // rather than rebuilt there. Calibration happens on the render that first sees
  // an event, which is this component's, because it mounts with the run. A second
  // instance inside the panel would calibrate whenever the sheet was opened and
  // read 0.0s next to this row's 8.4s.
  const { nowServer, anchorT0 } = useRunClock(list, streaming);
  const run = React.useMemo(() => buildRun(list, nowServer, anchorT0), [list, nowServer, anchorT0]);

  // Reasoning-only runs, and the whole pre-first-token window, still deserve a
  // live line: fall back to the sentence currently being written.
  const reasoningTail = React.useMemo(() => {
    const text = reasoning?.trim();
    if (!text) return undefined;
    const line = text.split("\n").reduce<string | undefined>((last, l) => (l.trim() ? l : last), undefined);
    return line ? truncate(line, 90) : undefined;
  }, [reasoning]);

  if (!hasEvents && !hasReasoning) return null;

  const latest = hasEvents ? list[list.length - 1] : undefined;
  const wroteYet = list.some((e) => e.kind === "write");
  const eventObject = latest ? (latest.detail ?? (latest.url ? domainOf(latest.url) : undefined)) : undefined;

  // OBJECT PRECEDENCE. Before first token every event in the log is a preflight
  // send that landed in one millisecond; the reasoning tail is the only text
  // that is actually moving, so it wins. After `write`, the log is live again
  // (visits, tool calls) and the newest event wins. Getting this backwards
  // freezes the line on a stale "Preparing web search" for the entire wait.
  const useTail = streaming && !wroteYet && !!reasoningTail;
  const object = useTail ? reasoningTail : (eventObject ?? reasoningTail);

  // The phase word IS the state signal, and it changes as the run advances.
  // Coral is legitimate here and only here: it is the ACTIVE phase, which is
  // exactly what --primary is reserved for.
  const active = run.phases.find((p) => p.active);
  const lead = streaming ? (active ? active.label.toUpperCase() : "THINKING") : undefined;

  // Keyed on what should crossfade. While the tail drives the line the id is
  // stable, so growing reasoning text updates in place instead of strobing.
  const id = useTail || !latest ? "reasoning" : latest.id;

  const restingLabel = hasEvents ? run.restingLabel : "Thought";

  // THE ACCESSIBLE NAME IS THE WHOLE CONTROL. message-item mounts this inside an
  // `aria-live="polite"` region, so every mutating text node underneath is
  // announced — and this row mutates more than anything else on the page: the
  // elapsed number rewrites 10x a second, and the preview text rewrites per
  // reasoning token. Left visible to the a11y tree, a screen reader would read
  // "4.2s, 4.3s, 4.4s…" for the whole pre-first-token wait, which route.ts
  // documents as lasting MINUTES on hidden-reasoning models, with no way to
  // reach the answer. A stable aria-label on the button does not help while the
  // live region can still see the text nodes inside it — so the visual content
  // is hidden from the tree outright and the label carries the full state
  // instead. It changes exactly once per run, on settle, which is the one
  // announcement actually worth making.
  const label = streaming
    ? "Open thought process — in progress"
    : [`Open thought process — ${restingLabel}`, run.elapsedMs === null ? null : formatSpan(run.elapsedMs)]
        .filter(Boolean)
        .join(", ");

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => panel?.setOpenId(open ? null : messageId)}
        aria-expanded={open}
        /* No aria-haspopup: this is no longer a dialog, it is a disclosure that
           docks a region. aria-controls is set only while the panel is mounted,
           so it never points at an id that is not in the document. */
        aria-controls={open ? panelDomId : undefined}
        aria-label={label}
        /* Deliberate deviation from hover=LIFT. Lift applies to SURFACES; this is
           a text link with no surface, and inventing a card to lift is precisely
           the "still looks like a widget at rest" failure. Hover = colour only. */
        className="group/thought relative -mx-1 mb-3 flex h-7 w-full items-center gap-2.5 rounded-md px-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background coarse:h-11"
      >
        {/* aria-hidden: see `label`. The button is named by aria-label, so
            hiding its contents from the a11y tree costs nothing and is what
            stops the surrounding live region announcing the tick. */}
        <PreviewLine
          id={id}
          lead={lead}
          text={streaming ? (object ?? "") : restingLabel}
          note={streaming ? undefined : (run.note ?? undefined)}
        />

        {run.elapsedMs !== null && (
          <span
            aria-hidden="true"
            className={cn(
              "shrink-0 font-mono text-caption tabular-nums transition-colors duration-slow ease-out-soft motion-reduce:transition-none",
              // Same node across the lifecycle. It freezes rather than being
              // replaced, and visibly demotes from meter to artifact.
              streaming ? "text-foreground" : "text-muted-foreground/55"
            )}
          >
            {formatSpan(run.elapsedMs)}
          </span>
        )}

        {/* The only icon on this surface, and it is an affordance, not a status
            mark: it says "this opens something" in the register of punctuation.
            It does not rotate — this opens a side panel, not an accordion. */}
        <ChevronRight
          className="size-3 shrink-0 text-muted-foreground/40 transition-colors duration-base ease-out-soft group-hover/thought:text-foreground/70 motion-reduce:transition-none"
          aria-hidden="true"
        />
      </button>

      {/* The portal is the whole trick: the panel stays in THIS React subtree —
          so it keeps receiving the run built from the one clock above — while
          its DOM lands in the dock beside the chat column. */}
      {open && panel.container
        ? createPortal(
            <ThoughtProcessPanel
              id={panelDomId}
              onClose={() => panel.setOpenId(null)}
              run={run}
              reasoning={reasoning}
              streaming={streaming}
            />,
            panel.container
          )
        : null}
    </>
  );
}

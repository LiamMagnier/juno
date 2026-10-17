"use client";

import * as React from "react";

import { ActivityTimeline } from "@/components/chat/activity-timeline";
import { AnswerSelectionBar } from "@/components/chat/answer-selection-bar";
import { MessageFeedback } from "@/components/chat/message-feedback";
import { ThoughtPanelProvider } from "@/components/chat/thought-panel-context";
import { splitEngaged } from "@/components/chat/split-layout";
import type { FeedbackDetail, FeedbackValue } from "@/lib/feedback-reasons";
import { serializeQuote, type AnswerQuote, type ComposerQuote } from "@/lib/quote-context";
import type { ClientActivityEvent } from "@/types/chat";

const REASONING_PARTS = [
  "**Reading the question**\n\nThe reader wants to know whether a heat pump pays for itself in a mild climate, not whether it is greener. That is a payback question: install cost against the yearly running saving.",
  "**Checking the numbers**\n\nA typical air-source install is quoted between 8,000 and 14,000. Against gas at current prices the saving is a few hundred a year, so the grant decides most of the answer.\n\nI should give the range, then the grant, then the honest caveat about insulation.",
];

// Built on the client only (see AnswerActionsGallery): the live run's clock
// reads the time, and a server render a few seconds older would not hydrate.
const buildEvents = (now: number): ClientActivityEvent[] => {
  const at = (s: number) => new Date(now - 60_000 + s * 1000).toISOString();
  return [
    { id: "e1", kind: "search", title: "Searching the web", detail: "heat pump payback mild climate", createdAt: at(0) } as ClientActivityEvent,
    { id: "e2", kind: "visit", title: "Read source", detail: "Heat pump running costs explained", url: "https://www.energysavingtrust.org.uk/heat-pumps", createdAt: at(2) } as ClientActivityEvent,
    { id: "e3", kind: "visit", title: "Read source", detail: "Boiler Upgrade Scheme", url: "https://www.gov.uk/apply-boiler-upgrade-scheme", createdAt: at(3) } as ClientActivityEvent,
    { id: "e4", kind: "write", title: "Writing", createdAt: at(9) } as ClientActivityEvent,
    { id: "e5", kind: "done", title: "Done", detail: "1,204 input · 512 output", createdAt: at(14) } as ClientActivityEvent,
  ];
};

const noSubscribe = () => () => {};

export function AnswerActionsGallery() {
  // False during the server render and hydration, true after: nothing timed
  // is drawn until the client owns the clock.
  const client = React.useSyncExternalStore(noSubscribe, () => true, () => false);
  return client ? <Gallery /> : null;
}

function Gallery() {
  const [events] = React.useState(() => buildEvents(Date.now()));
  const rootRef = React.useRef<HTMLDivElement>(null);
  const [quote, setQuote] = React.useState<ComposerQuote | null>(null);
  const [log, setLog] = React.useState<string[]>([]);
  const [feedback, setFeedback] = React.useState<FeedbackValue>(null);
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [container, setContainer] = React.useState<HTMLElement | null>(null);
  const say = (line: string) => setLog((prev) => [line, ...prev].slice(0, 6));
  const panel = React.useMemo(
    () => ({
      openId,
      setOpenId,
      container,
      seedDraft: (text: string) => say(`Seeded: ${text}`),
      coversChat: () => !splitEngaged(rootRef.current),
    }),
    [openId, container],
  );
  const selection = React.useMemo(
    () => ({
      onAsk: (q: AnswerQuote) => {
        setQuote(q);
        say(`Ask chip: ${q.text.slice(0, 80)}`);
      },
      onQuote: (markdown: string) => say(`Quote into draft: ${markdown.replace(/\n/g, "⏎").slice(0, 80)}`),
      onExplain: (q: AnswerQuote) => say(`Explain sent: ${serializeQuote(q, "Explain this passage in plain terms.").split("\n")[0]}`),
    }),
    [],
  );

  return (
    <ThoughtPanelProvider value={panel}>
      <div ref={rootRef} className="@container/split flex min-h-dvh w-full bg-background text-foreground">
        <main className="mx-auto w-full max-w-[48rem] min-w-0 flex-1 px-4 py-10">
          <h1 className="mb-6 font-serif text-title">Answer actions</h1>
          <section data-gallery="answer" data-juno-message="answer-1" className="group">
            <ActivityTimeline messageId="answer-1" events={events} reasoning={REASONING_PARTS.join("\n\n")} reasoningParts={REASONING_PARTS} />
            <div data-answer-text="answer-1" className="prose-juno space-y-3 text-reading">
              <p>
                In a mild climate a heat pump usually pays for itself in eight to twelve years. The install is the big number:
                most quotes for an air-source unit fall between 8,000 and 14,000, and the grant takes 7,500 off that.
              </p>
              <p>
                The running saving against gas is smaller than people expect, a few hundred a year, because gas is still cheaper
                per unit of heat. What closes the gap is efficiency: a well-insulated house runs the pump at lower flow
                temperatures, where it is three to four times as efficient as a boiler.
              </p>
            </div>
            <div className="mt-2 flex items-center">
              <MessageFeedback
                messageId="answer-1"
                feedback={feedback}
                onFeedback={(_, value: FeedbackValue, detail?: FeedbackDetail) => {
                  setFeedback(value);
                  say(`Feedback: ${value ?? "cleared"}${detail ? ` · ${detail.reason ?? "no reason"}${detail.note ? ` · “${detail.note}”` : ""}` : ""}`);
                }}
              />
            </div>
          </section>

          <section data-gallery="live" className="mt-10">
            <p className="mb-1 font-mono text-caption text-muted-foreground">Live run</p>
            <ActivityTimeline messageId="answer-live" events={events.slice(0, 3)} reasoningParts={REASONING_PARTS.slice(0, 1)} reasoning={REASONING_PARTS[0]} streaming />
          </section>

          <section data-gallery="state" className="mt-10 rounded-card border border-border/70 p-4">
            <p className="font-mono text-caption text-muted-foreground">Composer quote</p>
            <p data-composer-quote className="mt-1 text-ui">{quote ? `${quote.title}: ${quote.text.slice(0, 120)}` : "None"}</p>
            {quote ? (
              <button type="button" className="mt-2 text-caption underline" onClick={() => setQuote(null)}>
                Remove quote
              </button>
            ) : null}
            <ul data-log className="mt-3 space-y-1 font-mono text-caption text-muted-foreground">
              {log.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          </section>
          <AnswerSelectionBar scopeRef={rootRef} activeQuote={quote} canSend {...selection} />
        </main>
        <div ref={setContainer} className="hidden w-[26rem] shrink-0 border-l border-border/70 @[50rem]/split:block" aria-label="Thought process dock" />
      </div>
    </ThoughtPanelProvider>
  );
}

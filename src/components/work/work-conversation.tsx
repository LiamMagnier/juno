"use client";

import * as React from "react";
import type { Prisma } from "@prisma/client";
import { ArrowUp, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/chat/markdown";
import type { ClientWorkEvent, ClientWorkSession } from "@/lib/work/serializers";
import { cn } from "@/lib/utils";

/*
 * The conversation half of a Work thread: what you asked for, what Juno has
 * said back, and the box for saying more.
 *
 * It obeys the flat-transcript law — one column, user turns as right-aligned
 * `bg-secondary` bubbles, Juno's turns as full-width prose with no card, no
 * shadow and no glass. The depth in this page belongs to the composer and the
 * approval controls, which are chrome.
 */

type Payload = Record<string, unknown>;

function payloadOf(value: Prisma.JsonValue): Payload {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Payload)
    : {};
}

function str(payload: Payload, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}

interface Turn {
  id: string;
  role: "you" | "juno";
  text: string;
  /** True for a turn the user volunteered rather than one that answered a question. */
  unprompted: boolean;
}

/**
 * The readable conversation, pulled out of the event stream.
 *
 * Only three kinds carry prose a person addressed to another: what Juno said,
 * what it asked, and what the user typed. Everything else in the stream is
 * machinery and belongs in the timeline, where it can be skimmed rather than
 * read.
 *
 * The last of those three carries two different things. `question_answered`
 * with a `questionId` is an answer; the same kind with `steering: true` and no
 * id is an instruction the user offered unprompted, which
 * `/api/work/sessions/[id]/answer` records under that kind because
 * `WORK_EVENT_KINDS` has none of its own and the vocabulary is shared with the
 * Mac and the phone. Both are the user's words and both belong in this column;
 * only the label differs.
 */
export function deriveTurns(events: readonly ClientWorkEvent[]): Turn[] {
  const turns: Turn[] = [];
  for (const event of events) {
    if (event.visibility !== "user") continue;
    const payload = payloadOf(event.payload);
    if (event.kind === "assistant_message") {
      const text = str(payload, "text", "message");
      if (text) turns.push({ id: event.id, role: "juno", text, unprompted: false });
    }
    if (event.kind === "question_asked") {
      const text = str(payload, "question", "text");
      if (text) turns.push({ id: event.id, role: "juno", text, unprompted: false });
    }
    if (event.kind === "question_answered") {
      const text = str(payload, "text", "answer");
      if (text) {
        turns.push({ id: event.id, role: "you", text, unprompted: payload.steering === true });
      }
    }
  }
  return turns;
}

/**
 * What the box at the bottom is for right now.
 *
 * Three states rather than a boolean and a reason, because the three do
 * genuinely different things: one answers a specific question and is checked
 * against its id, one records an instruction nobody asked for, and one is not a
 * box at all. Collapsing them left the composer permanently disabled whenever
 * Juno had not asked anything, which was every ordinary minute of every run.
 */
export type WorkComposerMode =
  | { kind: "answer"; question: string }
  | { kind: "steer" }
  /** No box, and the sentence that says why — never a greyed-out field. */
  | { kind: "closed"; reason: string };

export function WorkConversation({
  session,
  turns,
  sending,
  mode,
  onSend,
}: {
  session: ClientWorkSession;
  turns: readonly Turn[];
  sending: boolean;
  /** What the box does right now, and whether there is one at all. */
  mode: WorkComposerMode;
  onSend: (text: string) => void;
}) {
  const [draft, setDraft] = React.useState("");
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  const autoresize = React.useCallback(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 180)}px`;
  }, []);
  React.useEffect(() => {
    autoresize();
  }, [draft, autoresize]);

  const send = () => {
    const text = draft.trim();
    if (!text || sending || mode.kind === "closed") return;
    setDraft("");
    onSend(text);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-5">
        <div>
          <p className="mb-1.5 font-mono text-label text-muted-foreground">What you asked for</p>
          <div className="flex justify-end">
            <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-secondary px-3.5 py-2.5 text-[14px] leading-relaxed text-secondary-foreground">
              {session.goal}
            </p>
          </div>
        </div>

        {turns.map((turn) =>
          turn.role === "you" ? (
            <div key={turn.id} className="flex flex-col items-end">
              {turn.unprompted && (
                <p className="mb-1 pr-1 font-mono text-[10px] text-muted-foreground/70">
                  You added this
                </p>
              )}
              <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-secondary px-3.5 py-2.5 text-[14px] leading-relaxed text-secondary-foreground">
                {turn.text}
              </p>
            </div>
          ) : (
            <Markdown key={turn.id} content={turn.text} className="text-[14px]" />
          )
        )}

      </div>

      <div className="sticky bottom-0 mt-6 pt-2">
        {mode.kind === "closed" ? (
          <p className="rounded-xl border border-dashed border-border/70 bg-background/80 px-3.5 py-3 text-[13px] leading-relaxed text-muted-foreground backdrop-blur">
            {mode.reason}
          </p>
        ) : (
          <div className="composer-surface flex flex-col gap-1 rounded-[20px] border border-border/65 bg-card/95 p-1.5 backdrop-blur transition-[border-color] duration-base ease-spring focus-within:border-foreground/15">
            <p className="truncate px-2.5 pt-1 font-mono text-[10px] text-muted-foreground">
              {mode.kind === "answer"
                ? `Answering: ${mode.question}`
                : // Said before the box rather than after the send, because the
                  // difference matters: this goes on the task's record, and the
                  // attempt already running was handed its instructions when it
                  // started.
                  "Not an answer to anything — this is kept on the task"}
            </p>
            <div className="flex items-end gap-1.5">
              <textarea
                ref={textareaRef}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    send();
                  }
                }}
                rows={1}
                disabled={sending}
                placeholder={
                  mode.kind === "answer" ? "Answer in your own words" : "Add context or an instruction"
                }
                aria-label={mode.kind === "answer" ? `Answer: ${mode.question}` : "Add an instruction"}
                className="max-h-[180px] min-h-[38px] w-full resize-none bg-transparent px-2.5 py-2 text-[14px] leading-relaxed outline-none placeholder:text-muted-foreground/70 disabled:opacity-70"
              />
              <Button
                type="button"
                size="icon-sm"
                onClick={send}
                disabled={sending || draft.trim().length === 0}
                aria-label={mode.kind === "answer" ? "Send answer" : "Add this to the task"}
                className={cn("composer-primary-action h-8 w-8 shrink-0 rounded-[11px]")}
              >
                {sending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
                )}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

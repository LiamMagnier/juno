import type { ClientWorkEvent } from "@/lib/work/serializers";
import { readEvent, str } from "@/components/work/work-payload";

/*
 * The readable conversation of a Work thread, as data: no React, no voice.
 *
 * It lived in work-conversation.tsx, beside the component that draws it. The
 * chat's run panel (src/components/chat/work-run-panel.tsx) needs only these
 * turns, and importing them from there pulled the thread's composer and its
 * realtime voice into every conversation's bundle (tests/shell-weight.test.ts).
 */

export interface Turn {
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
 * The last of those three arrives under two kinds. `question_answered` is an
 * answer to something Juno asked; `user_message` is an instruction the user
 * offered unprompted, which the executor folds into the run before its next
 * step. Both are the user's words and both belong in this column; only the label
 * differs.
 *
 * A `question_answered` row carrying `steering: true` and no id is the same
 * instruction written before the vocabulary had a kind for it. Those rows are in
 * the log and an older Mac or phone still writes them, so they are read as what
 * they are rather than shown as answers to a question nobody asked.
 */
export function deriveTurns(events: readonly ClientWorkEvent[]): Turn[] {
  const turns: Turn[] = [];
  for (const event of events) {
    if (event.visibility !== "user") continue;
    const payload = readEvent(event);
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
    if (event.kind === "user_message") {
      const text = str(payload, "text");
      if (text) turns.push({ id: event.id, role: "you", text, unprompted: true });
    }
  }
  return turns;
}

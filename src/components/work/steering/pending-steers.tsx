"use client";

import { CornerDownRight } from "lucide-react";
import type { ClientWorkEvent } from "@/lib/work/serializers";
import { readEvent, str } from "@/components/work/work-payload";
import { workTimeAgo } from "@/components/work/work-vocabulary";

/*
 * Instructions you have given a running task that it has not visibly acted on
 * yet.
 *
 * THE PROBLEM THIS SOLVES. Steering a run mid-flight is the feature that makes
 * an agent feel steerable rather than fired-and-forgotten, and the moment after
 * you press send is the moment it feels least so: the message lands in the
 * transcript, the run carries on doing whatever it was doing, and there is
 * nothing on the screen that says whether the redirect was heard. People
 * respond by sending it again. Then a third time.
 *
 * WHAT IS ACTUALLY TRUE. A steer is written as a `user_message` event and the
 * cloud executor drains unconsumed instructions BETWEEN TURNS — it does not
 * interrupt the step in flight. So there genuinely is a queue, it genuinely is
 * processed in order, and the honest thing to show is which instructions are
 * still in it. An instruction is treated as picked up once the run has said
 * anything after it: a new assistant message or a new step starting is the run
 * demonstrably having taken a turn, which is the point at which the drain
 * happened.
 *
 * WHAT THIS DELIBERATELY DOES NOT OFFER. No edit and no reorder. Both would be
 * lies: the instruction is a committed row in the event log the moment it is
 * sent, there is no endpoint that rewrites or reorders one, and a control that
 * appeared to move something in a queue the server owns would be the UI
 * inventing a promise. If the reader wants to correct a steer they send another
 * one — which is what the queue is for, and which arrives after it, in order.
 *
 * A MAC RUN IS DIFFERENT AND SAYS SO. `steerWorkRun` returns `delivered: false`
 * for a run on a Mac, because the host app is handed its instructions when a run
 * starts and has no reader for later ones. The page shows the server's own
 * sentence at send time; this strip renders regardless, because the instruction
 * IS recorded on the task and will be read by the next attempt even where the
 * current one cannot hear it.
 */

export interface PendingSteer {
  id: string;
  text: string;
  at: string;
}

/**
 * The steers the run has not yet taken a turn on.
 *
 * Walked backwards from the end, which is what makes it a single pass: the
 * first `assistant_message` or `step_started` encountered going back is the run
 * having spoken, and everything after that point is still queued. Walking
 * forwards would mean tracking "have I seen a reply since each of these", which
 * is the same answer computed n times.
 *
 * `question_answered` is NOT a boundary. Answering a question is the run being
 * unblocked, not the run taking a turn, and treating it as one would clear the
 * strip on the press that has nothing to do with the steers sitting in it.
 */
export function derivePendingSteers(events: readonly ClientWorkEvent[]): PendingSteer[] {
  const pending: PendingSteer[] = [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.visibility !== "user") continue;
    if (event.kind === "assistant_message" || event.kind === "step_started") break;
    if (event.kind !== "user_message") continue;
    const payload = readEvent(event);
    const text = str(payload, "text", "instruction", "message");
    if (text === null) continue;
    pending.push({ id: event.id, text, at: event.createdAt });
  }
  // Reversed at the end rather than unshifted in the loop: the strip reads in
  // the order the run will, which is oldest first, and `unshift` in a loop is
  // quadratic for no reason.
  return pending.reverse();
}

export function PendingSteers({ steers }: { steers: readonly PendingSteer[] }) {
  if (steers.length === 0) return null;
  return (
    <div
      className="mb-2 rounded-field border border-border/60 bg-secondary px-3 py-2.5"
      // A live region, because this strip appears as a direct result of the
      // reader's own send and then empties on its own when the run picks the
      // instruction up. Both transitions are worth announcing and neither has a
      // control attached to notice them by.
      role="status"
    >
      <p className="font-mono text-micro text-muted-foreground">
        {steers.length === 1
          ? "Queued — Juno reads this before its next step"
          : `Queued — Juno reads these ${steers.length} before its next step, in order`}
      </p>
      <ul className="mt-1.5 space-y-1">
        {steers.map((steer) => (
          <li key={steer.id} className="flex items-start gap-2">
            <CornerDownRight
              className="mt-[0.2rem] size-3 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1 text-ui leading-relaxed text-foreground">
              {steer.text}
            </span>
            <span className="shrink-0 font-mono text-micro tabular-nums text-muted-foreground">
              {workTimeAgo(steer.at)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

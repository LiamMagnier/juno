"use client";

import * as React from "react";

import { ComputerTimeline } from "@/components/code/computer-timeline";
import { readEvent, str } from "@/components/work/work-payload";
import type { ComputerActionKind } from "@/lib/code-v2/contracts";
import { actionVerb, type TimelineFrame } from "@/lib/code-v2/computer-timeline";
import { readWorkToolFrame, readWorkToolPoint, workFramePath } from "@/lib/work/domain";
import type { ClientWorkEvent } from "@/lib/work/serializers";

/*
 * A cloud computer run's steps, as a filmstrip.
 *
 * Every computer call a Work run makes is a `tool_started` / `tool_finished`
 * pair; the start carries the sentence and where a click lands (`point`), the
 * finish names the screenshot the step left (`frame`). This folds them into
 * the `TimelineFrame`s `ComputerTimeline` already draws for the Mac's Code
 * sessions, so the same stage, ring, scrubber and strip follow a live run and
 * replay it afterwards as proof of what was done.
 *
 * Only the steps that show the screen are drawn. The shell and file tools are
 * rows in the feed, not frames, and an approval that was declined never ran,
 * so it has no step here either. The frames come from the owner-only route
 * (`workFramePath`), which is why nothing renders without the run's id.
 */

const ACTIONS: Record<string, ComputerActionKind> = {
  computer_screenshot: "screenshot",
  computer_click: "click",
  computer_type: "type",
  computer_key: "key",
  computer_scroll: "scroll",
  computer_drag: "drag",
  computer_wait: "wait",
  computer_zoom: "zoom",
};

/** The cloud computer's screen, for a step whose frame did not say. */
const DEFAULT_SIZE = { width: 1280, height: 800 };

interface Step {
  id: string;
  callId: string;
  action: ComputerActionKind;
  summary: string;
  point: { x: number; y: number } | null;
  frame: { ref: string; width: number; height: number } | null;
  status: "running" | "completed" | "failed" | "interrupted";
  createdAt: string;
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

function caption(step: Step): string {
  // The same words the Code timeline uses for the same states (actionCaption).
  if (step.status === "failed") return `Failed — ${lowerFirst(step.summary)}`;
  if (step.status === "interrupted") return `Stopped — ${lowerFirst(step.summary)}`;
  return step.summary;
}

/**
 * The run's computer steps as timeline frames, in the order they started.
 * Pure, so it is tested without a DOM (tests/computer-frames.test.ts).
 */
export function deriveComputerSteps(
  events: readonly ClientWorkEvent[],
  runId: string | null,
): { frames: TimelineFrame[]; size: { width: number; height: number } } {
  const steps: Step[] = [];
  const byCall = new Map<string, Step>();
  let size = DEFAULT_SIZE;

  for (const event of events) {
    if (event.visibility !== "user") continue;
    // `readEvent` lifts the runner's `provenance` envelope; `point` and
    // `frame` sit beside it on the raw payload and are read from there.
    const payload = readEvent(event);
    const callId = str(payload, "callId", "toolCallId");

    if (event.kind === "tool_started") {
      const action = ACTIONS[str(payload, "tool", "name") ?? ""];
      if (!action || callId === null || byCall.has(callId)) continue;
      const step: Step = {
        id: event.id,
        callId,
        action,
        summary: str(payload, "summary", "title") ?? `${actionVerb(action)} the screen`,
        point: readWorkToolPoint(event.payload),
        frame: null,
        status: "running",
        createdAt: event.createdAt,
      };
      steps.push(step);
      byCall.set(callId, step);
      continue;
    }

    if ((event.kind === "tool_finished" || event.kind === "tool_denied") && callId !== null) {
      const step = byCall.get(callId);
      if (!step) continue;
      const failed = event.kind === "tool_denied" || payload.isError === true;
      step.status = failed ? "failed" : "completed";
      const frame = event.kind === "tool_finished" && !failed ? readWorkToolFrame(event.payload) : null;
      if (frame) {
        step.frame = frame;
        size = { width: frame.width, height: frame.height };
      }
      continue;
    }

    // The run stopped with a step still open: it never reported back.
    if (event.kind === "run_finished" || event.kind === "error" || event.kind === "paused") {
      for (const step of steps) if (step.status === "running") step.status = "interrupted";
    }
  }

  const frames = steps.map((step, index): TimelineFrame => {
    const width = step.frame?.width ?? size.width;
    const height = step.frame?.height ?? size.height;
    return {
      id: step.id,
      callId: step.callId,
      index,
      action: step.action,
      caption: caption(step),
      verb: actionVerb(step.action),
      src: step.frame && runId ? workFramePath(runId, step.frame.ref) : null,
      point: step.point
        ? { x: Math.min(1, Math.max(0, step.point.x / width)), y: Math.min(1, Math.max(0, step.point.y / height)) }
        : null,
      status:
        step.status === "running"
          ? "running"
          : step.status === "failed"
            ? "failed"
            : step.status === "interrupted"
              ? "interrupted"
              : "completed",
      failed: step.status === "failed" || step.status === "interrupted",
      live: step.status === "running",
      createdAt: step.createdAt,
    };
  });

  return { frames, size };
}

/**
 * The filmstrip, or nothing when the run used no screen. Live while the run
 * is, and the same component afterwards, so a step the reader was looking at
 * stays where it was when the run ends.
 */
export function WorkComputerSteps({
  runId,
  events,
  className,
  unavailableLabel,
}: {
  runId: string | null;
  events: readonly ClientWorkEvent[];
  className?: string;
  unavailableLabel?: string;
}) {
  const { frames, size } = React.useMemo(() => deriveComputerSteps(events, runId), [events, runId]);
  if (frames.length === 0 || runId === null) return null;
  return (
    <div className={className}>
      <ComputerTimeline
        frames={frames}
        frameSize={size}
        defaultCollapsed={false}
        {...(unavailableLabel ? { unavailableLabel } : {})}
      />
    </div>
  );
}

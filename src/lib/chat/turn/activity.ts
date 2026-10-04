import type { RoutingReceipt } from "@/lib/router/receipt";
import "server-only";
import {
  artifactRefusalNotice,
  artifactVerificationDetail,
  artifactVerificationTitle,
  verifyAndRepairChatArtifacts,
} from "@/lib/chat-artifact-verification";
import { planHeldReemits } from "@/lib/artifacts-store";
import { parseArtifacts, rewriteArtifactMarkup, type ParsedArtifact } from "@/lib/message-content";
import type { SseSender } from "@/lib/chat-stream";
import { closeToolDetail, createToolDetailBudget, openToolDetail } from "@/lib/chat/tool-detail";
import { GenerationAccumulator } from "@/lib/chat/stream-accumulator";
import { START_TASK_TOOL_ID, taskActivityTitle, taskTitleFromArgs } from "@/lib/chat/task-tool";
import { HAND_OFF_TOOL_ID, handoffActivityTitle, handoffDetailFromArgs } from "@/lib/chat/handoff-tool";
import { clientToolProgress, clientToolRun } from "@/lib/tools/wire";
import type { ToolOutcomeStatus, ToolRunRecord } from "@/lib/tools/types";
import type { ChatFinishReason, ClientActivityEvent, ClientToolDetail, ClientToolProgress } from "@/types/chat";

/*
 * Turn pipeline — activity and output shaping shared by the private and the
 * saved turn (docs/rework/program/ORCHESTRATION.md). Moved verbatim out of
 * src/app/api/chat/route.ts; behaviour is pinned by
 * tests/chat-turn-pipeline.integration.test.ts.
 */

/**
 * The assistant message a private turn reports.
 *
 * There is no row to serialise — nothing is stored — so the shape is built
 * here. It was built twice inside the branch, once for the completed turn and
 * once for a stopped one, and the two had to be kept identical by hand.
 */
export function privateAssistantMessage(
  acc: GenerationAccumulator,
  model: string,
  usage: { totalInput: number; output: number; cost: number },
  finishReason: ChatFinishReason,
  activity: ClientActivityEvent[],
  routing: RoutingReceipt | null = null
) {
  return {
    id: `private-${Date.now()}`,
    role: "ASSISTANT" as const,
    content: acc.text,
    reasoning: acc.reasoning || undefined,
    reasoningParts: acc.reasoningParts.length ? acc.reasoningParts : undefined,
    model,
    feedback: null,
    createdAt: new Date().toISOString(),
    attachments: [],
    sources: acc.sources.length ? acc.sources : undefined,
    activity,
    finishReason,
    promptTokens: usage.totalInput || undefined,
    completionTokens: usage.output || undefined,
    costUsd: usage.cost || undefined,
    ...cacheTokenFields(acc),
    ...(routing ? { routing } : {}),
  };
}

/**
 * The prompt-cache split for a PRIVATE turn's `done` frame.
 *
 * Private mode stores nothing, so the accumulator is the only place these
 * counters ever exist and the frame is the only chance to report them. The
 * saved path deliberately does NOT use this any more: `Message` now has both
 * columns, so its frame is built from the persisted row via `serializeMessage`.
 * Spreading the accumulator over that would make the live frame right even when
 * the write went wrong — the failure would then surface only on reload, which
 * is precisely the bug this column set was added to fix.
 *
 * Absent when the provider reported nothing, so a client can tell "no cache"
 * apart from "this build/provider does not report it"; emitting 0 asserts a
 * miss that was never measured.
 */
export function cacheTokenFields(acc: GenerationAccumulator): {
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
} {
  return {
    cacheReadTokens: acc.tokens.cacheReadTokens,
    cacheWriteTokens: acc.tokens.cacheWriteTokens,
  };
}

/**
 * One generation's connector transparency: which rows exist, what they may
 * carry, and how much of it in total.
 *
 * Built once per stream and used identically by BOTH streaming paths. The
 * private path currently passes `connectors: []` so no tool event can reach it
 * — it gets this code anyway rather than a comment saying it cannot happen,
 * because these two paths have drifted before and `stream-accumulator.ts`
 * exists because of it.
 *
 * ONE ROW PER CALL. The adapters emit two acts; this collapses them into a
 * single activity entry that is created when the model reaches for the tool and
 * COMPLETED IN PLACE when the connector answers. The entry object handed back
 * by `sendActivity` is the same object sitting in `activityLog`, which is what
 * gets persisted onto `Message.activity`, so mutating it and re-sending keeps
 * both the log's order and the completed payload. Pushing a second entry would
 * look right live and show every tool twice on reload.
 *
 * `createdAt` is deliberately not refreshed on completion: it is the instant
 * the call STARTED, and that is the only instant about this row that anything
 * measures from.
 *
 * `start_task` and `hand_off_to_teammate` are the tools that say what they did
 * rather than "Using Juno": the row opens as "Starting a task" (or "Handing off
 * to a teammate"), is retitled on completion to whether it happened, and names
 * the task, because that row is the only place in the reply that says a task
 * exists.
 *
 * A `result` whose `callId` has no open row is DROPPED, not turned into an
 * orphan row. An unpaired result is a bug in an adapter, and inventing a row
 * for it would hide that bug behind a plausible-looking panel entry.
 */
export function createToolActivity(
  sender: Pick<SseSender, "send" | "sendActivity">,
  enabled: boolean
): {
  open(effect: { server: string; name: string; callId: string; args?: string }): void;
  /** The dispatcher's queued / awaiting_approval / running act: the live row's phase. */
  status(effect: { callId: string; status: "queued" | "awaiting_approval" | "running"; timeoutMs?: number }): void;
  /** A running call's latest output on its live row. */
  progress(effect: { callId: string; progress: ClientToolProgress }): void;
  close(effect: {
    server: string;
    name: string;
    callId: string;
    args?: string;
    result: string;
    ok: boolean;
    durationMs?: number;
    status?: ToolOutcomeStatus;
    errorCode?: string;
    run?: ToolRunRecord;
    cached?: boolean;
  }): void;
} {
  const budget = createToolDetailBudget();
  const rows = new Map<string, { entry: ClientActivityEvent; opened?: ClientToolDetail; timeoutMs?: number }>();

  return {
    open(effect) {
      const opened = enabled ? { ...openToolDetail(effect, budget), callId: effect.callId } : undefined;
      const task = effect.name === START_TASK_TOOL_ID;
      const handoff = effect.name === HAND_OFF_TOOL_ID;
      const entry = sender.sendActivity({
        kind: "tool",
        title: task ? taskActivityTitle("call") : handoff ? handoffActivityTitle("call") : `Using ${effect.server}`,
        detail:
          (task && taskTitleFromArgs(effect.args)) || (handoff && handoffDetailFromArgs(effect.args)) || effect.name,
        ...(opened ? { tool: opened } : {}),
      });
      // Tracked even when detail is disabled, so a later `result` is still
      // recognised as paired and silently dropped rather than half-handled.
      rows.set(effect.callId, { entry, opened });
    },
    status(effect) {
      const row = rows.get(effect.callId);
      if (!row || !enabled || !row.entry.tool) return;
      if (effect.timeoutMs !== undefined) row.timeoutMs = effect.timeoutMs;
      // `queued` is the row's state from the moment it opened; only a change is news.
      if (effect.status === "queued" && !row.entry.tool.phase) return;
      row.entry.tool = {
        ...row.entry.tool,
        phase: effect.status,
        ...(row.timeoutMs === undefined ? {} : { timeoutMs: row.timeoutMs }),
      };
      sender.send({ type: "activity", event: row.entry });
    },
    progress(effect) {
      const row = rows.get(effect.callId);
      if (!row || !enabled || !row.entry.tool) return;
      // The dispatcher already holds this to one frame a second per call.
      row.entry.tool = { ...row.entry.tool, progress: clientToolProgress(effect.progress) };
      sender.send({ type: "activity", event: row.entry });
    },
    close(effect) {
      const row = rows.get(effect.callId);
      if (!row) return;
      rows.delete(effect.callId);
      // The task row's wording is not tool detail, so it is updated whether or
      // not detail is enabled. Anthropic reports the arguments only here, which
      // is why the title is read again.
      const task = effect.name === START_TASK_TOOL_ID;
      const handoff = effect.name === HAND_OFF_TOOL_ID;
      if (task) {
        row.entry.title = taskActivityTitle("result", effect.ok);
        row.entry.detail = taskTitleFromArgs(effect.args) ?? row.entry.detail;
      } else if (handoff) {
        row.entry.title = handoffActivityTitle("result", effect.ok);
        row.entry.detail = handoffDetailFromArgs(effect.args) ?? row.entry.detail;
      }
      if (!enabled) {
        if (task || handoff) sender.send({ type: "activity", event: row.entry });
        return;
      }
      // The completed detail replaces the live one wholesale, so `phase` and
      // `progress` (claims about a running call) leave with it.
      row.entry.tool = {
        ...closeToolDetail(row.opened, effect, budget),
        callId: effect.callId,
        ...(row.timeoutMs === undefined ? {} : { timeoutMs: row.timeoutMs }),
        ...(effect.status ? { outcome: effect.status } : {}),
        ...(effect.errorCode ? { errorCode: effect.errorCode } : {}),
        ...(effect.run ? { run: clientToolRun(effect.run) } : {}),
        ...(effect.cached ? { cached: true } : {}),
      };
      sender.send({ type: "activity", event: row.entry });
    },
  };
}

/**
 * The canvas is a presentation boundary, not a side effect of parsing. Verify
 * the exact bodies the client is about to receive, rewrite safe repairs into
 * the message, and replace refused blocks with an honest explanation. The
 * structured receipt is emitted into the activity log, which is persisted with
 * the message so a later reload can see what was checked and why anything was
 * withheld.
 */
export function prepareChatArtifactOutput(
  text: string,
  sendActivity: SseSender["sendActivity"]
): { text: string; result: ReturnType<typeof verifyAndRepairChatArtifacts> } | null {
  const parsed = parseArtifacts(text);
  if (parsed.length === 0) return null;
  const result = verifyAndRepairChatArtifacts(parsed);
  // A block that stopped before its closing tag says so in its own words
  // ("stopped before it was finished"), not "verification failed": the reader
  // pressed Stop or the reply hit its limit, and nothing the model made was
  // wrong (X-07). Both lines, and the row's title, come from the verifier so
  // the message and the activity receipt cannot disagree.
  const updates = [
    ...result.artifacts.map((artifact) => ({ identifier: artifact.identifier, content: artifact.content })),
    ...result.report.refused.map((identifier) => ({
      identifier,
      refusal: artifactRefusalNotice(result.report, identifier),
    })),
  ];
  const rewritten = rewriteArtifactMarkup(text, updates);
  sendActivity({
    kind: "artifact",
    title: artifactVerificationTitle(result.report),
    detail: artifactVerificationDetail(result.report),
    artifactVerification: result.report,
  });
  return { text: rewritten, result };
}

/**
 * The re-emit guard's plan for a turn: which re-emits will be held as a
 * suggestion rather than appended (src/lib/artifact-proposals.ts), decided
 * before the message is saved so the message is saved in its held form.
 *
 * A failure costs only that form, never the turn: `persistArtifacts` decides
 * again inside its own write and still holds what it must, so the message
 * keeps its full bodies and the store logs `held_unplanned`.
 */
export async function planTurnHolds(conversationId: string, artifacts: ParsedArtifact[], userId: string): Promise<Map<string, string>> {
  try {
    return await planHeldReemits(conversationId, artifacts, userId);
  } catch (err) {
    console.error("[chat] could not plan held re-emits", {
      conversationId,
      message: err instanceof Error ? err.message : String(err),
    });
    return new Map();
  }
}

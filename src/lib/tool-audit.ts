import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { ToolAccess } from "@/lib/tool-access";

/**
 * The audit trail for connector tool calls.
 *
 * Two writes per call, not one: the intent is recorded BEFORE dispatch and the
 * outcome patched in afterwards. One write after the fact would be cheaper and
 * would also lose exactly the calls worth auditing — the one that hung, the one
 * whose stream was torn down mid-flight, the one that took the process with it.
 * A row left `pending` is itself the finding.
 *
 * Failures here are swallowed. That is a deliberate trade and worth naming: an
 * audit log that can take a user's chat down converts a logging outage into an
 * outage, and connector tools are already best-effort everywhere else in this
 * file's neighbourhood. The cost is that a database blip loses records
 * silently, so the write failure is logged to the operator console — the one
 * place that does not depend on the database being up.
 */

/** Cap on the serialized arguments we store. Beyond this the row records the
 *  head plus a truncation flag: an audit trail should not be a vector for
 *  writing megabytes into the primary database on someone else's behalf. */
const MAX_ARGS_CHARS = 8_000;

export interface ToolInvocationStart {
  userId: string;
  conversationId?: string | null;
  connectorId: string;
  /** Name as the MCP server declares it. */
  toolName: string;
  /** Namespaced `<connector>__<tool>` name the model actually called. */
  functionName: string;
  access: ToolAccess;
  args: Record<string, unknown>;
  derivedFromUntrusted: boolean;
  /** `pending` for a call awaiting confirmation; `executed` once it is running. */
  status: "pending" | "executed";
}

/** Serialize arguments for storage, bounding the size. */
function boundArgs(args: Record<string, unknown>): { args: Prisma.InputJsonValue; truncated: boolean } {
  let serialized: string;
  try {
    serialized = JSON.stringify(args ?? {});
  } catch {
    // Circular or otherwise unserializable — record that a call happened rather
    // than dropping the row entirely.
    return { args: { _unserializable: true } as Prisma.InputJsonValue, truncated: true };
  }
  if (serialized.length <= MAX_ARGS_CHARS) return { args: (args ?? {}) as Prisma.InputJsonValue, truncated: false };
  return { args: { _truncated: serialized.slice(0, MAX_ARGS_CHARS) } as Prisma.InputJsonValue, truncated: true };
}

/**
 * Record a tool call about to be dispatched (or blocked pending confirmation).
 * Returns the row id to settle against, or null when the write failed — callers
 * must treat a null id as "unauditable, carry on", never as a reason to abort.
 */
export async function recordToolInvocation(start: ToolInvocationStart): Promise<string | null> {
  const { args, truncated } = boundArgs(start.args);
  try {
    const row = await prisma.toolInvocation.create({
      data: {
        userId: start.userId,
        conversationId: start.conversationId ?? null,
        connectorId: start.connectorId,
        toolName: start.toolName,
        functionName: start.functionName,
        access: start.access,
        args,
        argsTruncated: truncated,
        derivedFromUntrusted: start.derivedFromUntrusted,
        status: start.status,
      },
      select: { id: true },
    });
    return row.id;
  } catch (err) {
    console.error("[tool-audit] failed to record invocation", {
      connectorId: start.connectorId,
      toolName: start.toolName,
      detail: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Patch in the outcome of a call previously recorded by recordToolInvocation. */
export async function settleToolInvocation(
  id: string | null,
  outcome: { status: "executed" | "failed" | "denied"; error?: string; durationMs?: number }
): Promise<void> {
  if (!id) return;
  try {
    await prisma.toolInvocation.update({
      where: { id },
      data: {
        status: outcome.status,
        // Provider and connector error text can be long; the column is TEXT but
        // there is no value in storing a stack trace's worth of it.
        error: outcome.error ? outcome.error.slice(0, 2_000) : null,
        durationMs: outcome.durationMs,
        completedAt: new Date(),
      },
    });
  } catch (err) {
    console.error("[tool-audit] failed to settle invocation", {
      id,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

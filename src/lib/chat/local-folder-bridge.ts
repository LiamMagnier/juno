/** Durable local-tool lifecycle. The store uses the same CAS/polling pattern as
 * action-approval receipts. Process memory is never authoritative and no call
 * is automatically re-dispatched after a restart or ambiguous failure. */
export type LocalToolOutcome = "succeeded" | "failed" | "denied";
export interface LocalToolResult { outcome: LocalToolOutcome; output: string }
export const MAX_LOCAL_TOOL_OUTPUT_CHARS = 60_000;
export const LOCAL_TOOL_TIMEOUT_OUTPUT =
  "The Mac did not answer in time, so this call's outcome is unknown. Check the folder before trying again.";
export const LOCAL_TOOL_CANCELLED_OUTPUT =
  "The reply was stopped before the Mac answered. Its outcome is unknown; check the folder before trying again.";
export const LOCAL_TOOL_STORE_FAILURE_OUTPUT =
  "Alevr could not verify this folder call. Its outcome is unknown; check the folder before trying again.";
export type LocalToolDelivery = "accepted" | "unknown";
export interface LocalToolIdentity { callId: string; userId: string; generationId: string }
export const localToolResultContext = (row: LocalToolIdentity) =>
  JSON.stringify(["alevr.local-tool.v1", row.userId, row.generationId, row.callId]);
export interface LocalToolRecord extends LocalToolIdentity {
  status: "pending" | "completed" | "cancelled" | "expired";
  expiresAt: number;
  result?: LocalToolResult;
}
export interface LocalToolStore {
  /** Insert only; a duplicate id must never replace a pending or terminal row. */
  create(row: LocalToolRecord): Promise<boolean>;
  read(identity: LocalToolIdentity): Promise<LocalToolRecord | null>;
  /** Compare-and-set pending -> completed; identical retries are accepted. */
  deliver(input: Omit<LocalToolIdentity, "generationId"> & { generationId?: string; result: LocalToolResult }): Promise<LocalToolDelivery>;
  /** Compare-and-set pending -> cancelled/expired; terminal results cannot change. */
  end(identity: LocalToolIdentity, status: "cancelled" | "expired"): Promise<void>;
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

export async function waitLocalToolResult(input: LocalToolIdentity & {
  store: LocalToolStore; signal?: AbortSignal; pollMs?: number;
}): Promise<LocalToolResult> {
  try {
    while (true) {
      if (input.signal?.aborted) {
        await input.store.end(input, "cancelled");
        return { outcome: "failed", output: LOCAL_TOOL_CANCELLED_OUTPUT };
      }
      const row = await input.store.read(input);
      if (!row) return { outcome: "failed", output: LOCAL_TOOL_STORE_FAILURE_OUTPUT };
      if (row.status === "completed" && row.result) return row.result;
      if (row.status === "cancelled") return { outcome: "failed", output: LOCAL_TOOL_CANCELLED_OUTPUT };
      if (row.status === "expired" || row.expiresAt <= Date.now()) {
        await input.store.end(input, "expired");
        // Re-read because a concurrent completion may have won the CAS.
        const terminal = await input.store.read(input);
        if (terminal?.status === "completed" && terminal.result) return terminal.result;
        return { outcome: "failed", output: LOCAL_TOOL_TIMEOUT_OUTPUT };
      }
      await pause(Math.min(input.pollMs ?? 400, Math.max(1, row.expiresAt - Date.now())), input.signal);
    }
  } catch {
    // Never turn a database outage into a fresh execution of an uncertain call.
    return { outcome: "failed", output: LOCAL_TOOL_STORE_FAILURE_OUTPUT };
  }
}

/** Persist BEFORE emitting a local_tool frame. This is deliberately a separate
 * step from waiting so a failed insertion or duplicate can never dispatch. */
export async function registerLocalToolCall(input: LocalToolIdentity & {
  store: LocalToolStore; timeoutMs: number; signal?: AbortSignal;
}): Promise<void> {
  if (input.signal?.aborted) throw new Error("Folder call cancelled before dispatch");
  const created = await input.store.create({
    callId: input.callId, userId: input.userId, generationId: input.generationId,
    status: "pending", expiresAt: Date.now() + input.timeoutMs,
  });
  if (!created) throw new Error("Folder call id already exists; refusing duplicate dispatch");
  if (input.signal?.aborted) {
    await input.store.end(input, "cancelled");
    throw new Error("Folder call cancelled before dispatch");
  }
}

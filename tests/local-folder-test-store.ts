import type { LocalToolStore, LocalToolRecord, LocalToolIdentity, LocalToolResult } from "@/lib/chat/local-folder-bridge";
/** Isolated fixture only; production always injects the Prisma store. */
export class LocalToolTestStore implements LocalToolStore {
  readonly rows = new Map<string, LocalToolRecord>();
  async create(row: LocalToolRecord) {
    if (this.rows.has(row.callId)) return false;
    this.rows.set(row.callId, structuredClone(row));
    return true;
  }
  async read(identity: LocalToolIdentity) {
    const row = this.rows.get(identity.callId);
    return row?.userId === identity.userId && row.generationId === identity.generationId ? structuredClone(row) : null;
  }
  async deliver(input: Omit<LocalToolIdentity, "generationId"> & { generationId?: string; result: LocalToolResult }) {
    const row = this.rows.get(input.callId);
    if (!row || row.userId !== input.userId || (input.generationId && row.generationId !== input.generationId)) return "unknown" as const;
    const result = { outcome: input.result.outcome, output: input.result.output.slice(0, 60_000) };
    if (row.status === "completed") return JSON.stringify(row.result) === JSON.stringify(result) ? "accepted" as const : "unknown" as const;
    if (row.status !== "pending" || row.expiresAt <= Date.now()) return "unknown" as const;
    row.status = "completed";
    row.result = result;
    return "accepted" as const;
  }
  async end(identity: LocalToolIdentity, status: "cancelled" | "expired") {
    const row = this.rows.get(identity.callId);
    if (row?.userId === identity.userId && row.generationId === identity.generationId && row.status === "pending"
      && (status === "cancelled" || row.expiresAt <= Date.now())) row.status = status;
  }
}

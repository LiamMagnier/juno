/**
 * The agent's shell output as it happens, for the person's read-only terminal
 * pane (docs/design/agents-v2/COMPUTERS_2026-10.md S5.1, D8).
 *
 * The Work runner opens one log per run and one call per `computer_shell`:
 * a `command` row first, the output in batches (every 250 ms, in the order it
 * was written, each row at most 16 KB of text), and an `exit` row last. Every
 * row's text is encrypted at rest (`encryptSecret`), and `seq` is numbered per
 * run, in write order, so the pane reads "everything after seq N". Past
 * `AGENT_COMPUTER_SHELL_LOG_KB_PER_CALL` a call stores one last line saying
 * the rest is in the result, and nothing more until its exit row.
 *
 * This is only what the person watches. The model's result is built from the
 * provider's `ExecResult` exactly as before, and a failed write here never
 * fails the command: it is logged (ids only) and dropped.
 */

import "server-only";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { env } from "@/lib/env";

export type ShellOutputStream = "command" | "stdout" | "stderr" | "exit";

/** Said once, as the call's last output row, when its log reached the cap. */
export const SHELL_OUTPUT_CAPPED_TEXT = "[output continues; the rest is in the result]";

/** Batches are written this often while a command runs. */
export const SHELL_OUTPUT_FLUSH_MS = 250;

/** The most plaintext one row holds (the schema's limit). */
export const SHELL_OUTPUT_ROW_BYTES = 16 * 1024;

/** How much of the command the `command` row keeps (the tool's own limit is 4000 characters). */
const COMMAND_MAX_CHARS = 4000;

export interface ShellOutputRowInput {
  userId: string;
  agentId: string;
  runId: string;
  callId: string;
  seq: number;
  stream: ShellOutputStream;
  /** Encrypted. */
  text: string;
  createdAt: Date;
}

export interface ShellOutputStoredRow extends ShellOutputRowInput {
  id: string;
}

/** Where rows go, swappable for tests. */
export interface ShellOutputPersistence {
  /** The highest seq the run already has, or 0. */
  maxSeq(input: { userId: string; runId: string }): Promise<number>;
  insert(rows: ShellOutputRowInput[]): Promise<void>;
  /** The owner's rows of one run after a seq, in seq order. */
  list(input: { userId: string; agentId: string; runId: string; afterSeq: number; limit: number }): Promise<ShellOutputStoredRow[]>;
}

const prismaPersistence: ShellOutputPersistence = {
  async maxSeq({ userId, runId }) {
    const { prisma } = await import("@/lib/db");
    const result = await prisma.computerShellOutput.aggregate({ where: { userId, runId }, _max: { seq: true } });
    return result._max.seq ?? 0;
  },
  async insert(rows) {
    if (rows.length === 0) return;
    const { prisma } = await import("@/lib/db");
    await prisma.computerShellOutput.createMany({ data: rows, skipDuplicates: true });
  },
  async list({ userId, agentId, runId, afterSeq, limit }) {
    const { prisma } = await import("@/lib/db");
    return prisma.computerShellOutput.findMany({
      where: { userId, agentId, runId, seq: { gt: afterSeq } },
      orderBy: { seq: "asc" },
      take: limit,
    }) as Promise<ShellOutputStoredRow[]>;
  },
};

let activePersistence: ShellOutputPersistence = prismaPersistence;

export function setShellOutputPersistenceForTest(persistence: ShellOutputPersistence | null): void {
  activePersistence = persistence ?? prismaPersistence;
}

/** An in-memory store, for tests. */
export function createInMemoryShellOutputPersistence(): ShellOutputPersistence & { rows: ShellOutputStoredRow[] } {
  const rows: ShellOutputStoredRow[] = [];
  let id = 0;
  return {
    rows,
    async maxSeq({ userId, runId }) {
      return rows.filter((row) => row.userId === userId && row.runId === runId).reduce((max, row) => Math.max(max, row.seq), 0);
    },
    async insert(input) {
      for (const row of input) {
        if (rows.some((existing) => existing.runId === row.runId && existing.callId === row.callId && existing.seq === row.seq)) continue;
        rows.push({ ...row, id: `shell_${++id}` });
      }
    },
    async list({ userId, agentId, runId, afterSeq, limit }) {
      return rows
        .filter((row) => row.userId === userId && row.agentId === agentId && row.runId === runId && row.seq > afterSeq)
        .sort((a, b) => a.seq - b.seq)
        .slice(0, limit);
    },
  };
}

/** Text cut into pieces of at most `maxBytes` UTF-8 bytes, never inside a character. */
export function splitUtf8(text: string, maxBytes: number): string[] {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text ? [text] : [];
  const pieces: string[] = [];
  let current = "";
  let size = 0;
  for (const char of text) {
    const bytes = Buffer.byteLength(char, "utf8");
    if (size + bytes > maxBytes && current) {
      pieces.push(current);
      current = "";
      size = 0;
    }
    current += char;
    size += bytes;
  }
  if (current) pieces.push(current);
  return pieces;
}

/** At most `maxBytes` UTF-8 bytes of `text`, never cutting a character. */
function takeUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let out = "";
  let size = 0;
  for (const char of text) {
    const bytes = Buffer.byteLength(char, "utf8");
    if (size + bytes > maxBytes) break;
    out += char;
    size += bytes;
  }
  return out;
}

export interface ShellOutputCall {
  /** One piece of output as the command wrote it. Never throws; never blocks the command. */
  append(chunk: { stream: "stdout" | "stderr"; text: string }): void;
  /** Writes what is pending, then the exit row. Never throws. */
  end(result: { exitCode: number; timedOut: boolean }): Promise<void>;
}

export interface ShellOutputLog {
  /** Starts a call: its `command` row is the first thing written for it. */
  call(callId: string, command: string): ShellOutputCall;
  /** Waits until everything appended so far is written (tests, and the runner at the end of a run). */
  drain(): Promise<void>;
}

/**
 * A run's shell log. One per run in the Work runner; every write goes through
 * one queue, so rows commit in `seq` order and a reader polling "after N"
 * never skips a row that commits late.
 */
export function createShellOutputLog(input: {
  userId: string;
  agentId: string;
  runId: string;
  /** Defaults to AGENT_COMPUTER_SHELL_LOG_KB_PER_CALL. */
  maxBytesPerCall?: number;
  flushMs?: number;
  persistence?: ShellOutputPersistence;
  now?: () => Date;
}): ShellOutputLog {
  const persistence = input.persistence ?? activePersistence;
  const maxBytesPerCall = input.maxBytesPerCall ?? env.agentComputer.shellLogKbPerCall * 1024;
  const flushMs = input.flushMs ?? SHELL_OUTPUT_FLUSH_MS;
  const now = input.now ?? (() => new Date());
  let nextSeq: number | null = null;
  let queue: Promise<void> = Promise.resolve();

  const write = (callId: string, pieces: Array<{ stream: ShellOutputStream; text: string }>) => {
    if (pieces.length === 0) return queue;
    queue = queue
      .then(async () => {
        if (nextSeq === null) nextSeq = (await persistence.maxSeq({ userId: input.userId, runId: input.runId })) + 1;
        const at = now();
        const rows: ShellOutputRowInput[] = pieces.map((piece) => ({
          userId: input.userId,
          agentId: input.agentId,
          runId: input.runId,
          callId,
          seq: nextSeq!++,
          stream: piece.stream,
          text: encryptSecret(piece.text),
          createdAt: at,
        }));
        await persistence.insert(rows);
      })
      .catch((error: unknown) => {
        // Ids only: the text is the person's command output.
        console.warn("[agent-computer] shell output not stored", {
          runId: input.runId,
          callId,
          error: error instanceof Error ? error.name : "unknown",
        });
      });
    return queue;
  };

  return {
    call(callId, command) {
      let pending: Array<{ stream: "stdout" | "stderr"; text: string }> = [];
      let stored = 0;
      let capped = false;
      let ended = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      void write(callId, [{ stream: "command", text: command.slice(0, COMMAND_MAX_CHARS) }]);

      const flush = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        if (pending.length === 0) return queue;
        // Neighbouring pieces of one stream become one row (then split at 16 KB).
        const merged: Array<{ stream: "stdout" | "stderr"; text: string }> = [];
        for (const piece of pending) {
          const previous = merged[merged.length - 1];
          if (previous && previous.stream === piece.stream) previous.text += piece.text;
          else merged.push({ ...piece });
        }
        pending = [];
        return write(
          callId,
          merged.flatMap((piece) => splitUtf8(piece.text, SHELL_OUTPUT_ROW_BYTES).map((text) => ({ stream: piece.stream, text })))
        );
      };

      return {
        append(chunk) {
          if (ended || capped || !chunk.text) return;
          const size = Buffer.byteLength(chunk.text, "utf8");
          if (stored + size > maxBytesPerCall) {
            const kept = takeUtf8(chunk.text, Math.max(0, maxBytesPerCall - stored));
            if (kept) pending.push({ stream: chunk.stream, text: kept });
            stored = maxBytesPerCall;
            capped = true;
            void flush();
            void write(callId, [{ stream: "stdout", text: `\n${SHELL_OUTPUT_CAPPED_TEXT}\n` }]);
            return;
          }
          stored += size;
          pending.push({ stream: chunk.stream, text: chunk.text });
          if (!timer) timer = setTimeout(() => void flush(), flushMs);
        },
        async end(result) {
          if (ended) return;
          ended = true;
          await flush();
          await write(callId, [
            { stream: "exit", text: JSON.stringify({ exitCode: result.exitCode, timedOut: result.timedOut, capped }) },
          ]);
        },
      };
    },
    drain() {
      return queue;
    },
  };
}

// ---------------------------------------------------------------------------
// Reading, for the pane
// ---------------------------------------------------------------------------

export interface ClientShellOutputRow {
  seq: number;
  callId: string;
  stream: ShellOutputStream;
  text: string;
  createdAt: string;
}

/** Rows one read returns at most; the pane asks again from the last seq. */
export const SHELL_OUTPUT_PAGE = 200;

/**
 * The owner's rows of one run after a seq, decrypted. `running` is whether
 * the newest call in what was read has no exit row yet, so the pane knows to
 * keep polling quickly. A row that no longer decrypts (a rotated key) reads as
 * a short note, never as an error.
 */
export async function readShellOutput(input: {
  userId: string;
  agentId: string;
  runId: string;
  afterSeq: number;
  limit?: number;
}): Promise<{ rows: ClientShellOutputRow[]; next: number; running: boolean; more: boolean }> {
  const limit = Math.max(1, Math.min(SHELL_OUTPUT_PAGE, input.limit ?? SHELL_OUTPUT_PAGE));
  const stored = await activePersistence.list({
    userId: input.userId,
    agentId: input.agentId,
    runId: input.runId,
    afterSeq: Math.max(0, Math.floor(input.afterSeq)),
    limit,
  });
  const rows = stored.map((row) => {
    let text: string;
    try {
      text = decryptSecret(row.text);
    } catch {
      text = row.stream === "exit" ? "{}" : "[this output can no longer be read]";
    }
    return {
      seq: row.seq,
      callId: row.callId,
      stream: row.stream as ShellOutputStream,
      text,
      createdAt: row.createdAt.toISOString(),
    };
  });
  const last = rows[rows.length - 1];
  let running = false;
  if (last) {
    const lastCall = last.callId;
    running = !rows.some((row) => row.callId === lastCall && row.stream === "exit");
  }
  return { rows, next: last ? last.seq : Math.max(0, Math.floor(input.afterSeq)), running, more: rows.length === limit };
}

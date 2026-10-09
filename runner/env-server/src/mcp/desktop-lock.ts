/**
 * The cross-process desktop lock (SPEC §3.12): one pointer, one driver.
 *
 * A JSON `DesktopLockRecord` in `~/Library/Application Support/Alevr/
 * computer-use/desktop.lock`, shared by the Mac app (its Code sessions and
 * Work tasks, `DesktopLockFile.swift`) and the env server (subscription agents
 * driving the Mac through the Alevr MCP server). The Swift side implements the
 * same algorithm; keep the two in step.
 *
 *   acquire: create the file exclusively (O_EXCL). If it exists, read it:
 *     - same holderId → re-entrant: rewrite with our pid and a fresh heartbeat;
 *     - a dead pid, a heartbeat older than DESKTOP_LOCK_STALE_MS, or an
 *       unreadable record → stale: remove it and try once more;
 *     - otherwise refuse, naming the holder.
 *   heartbeat: rewrite heartbeatAt (atomically, tmp + rename) while we hold it.
 *   release: remove the file iff the record is still ours.
 */
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { DESKTOP_LOCK_STALE_MS, type DesktopLockRecord } from "../contracts/code-v2.js";

export const DEFAULT_COMPUTER_USE_DIR = join(homedir(), "Library", "Application Support", "Alevr", "computer-use");
export const DEFAULT_DESKTOP_LOCK_PATH = join(DEFAULT_COMPUTER_USE_DIR, "desktop.lock");

export interface DesktopLockClaimant {
  holderId: string;
  kind: DesktopLockRecord["kind"];
  title: string;
  app?: string;
}

export type DesktopLockResult = { ok: true; record: DesktopLockRecord } | { ok: false; holder?: DesktopLockRecord; reason: string };

export interface DesktopLockOptions {
  path?: string;
  pid?: number;
  now?: () => number;
  staleMs?: number;
  /** Whether a pid is a live process. Injected in tests. */
  isAlive?: (pid: number) => boolean;
}

export function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, it is just not ours.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** "Alevr is using TextEdit for ‘Fix the export sheet’" — the refusal and the overlay share it. */
export function holderSentence(record: DesktopLockRecord): string {
  const what = record.app ? `Alevr is using ${record.app}` : "Alevr is already using apps";
  const title = record.title.trim();
  if (title) return `${what} for ‘${title}’`;
  switch (record.kind) {
    case "work_task":
      return `${what} for a Work task`;
    case "env_server":
      return `${what} for a connected agent`;
    default:
      return `${what} in another session`;
  }
}

function parseRecord(text: string): DesktopLockRecord | null {
  try {
    const value = JSON.parse(text) as Partial<DesktopLockRecord>;
    if (
      typeof value.holderId === "string" &&
      typeof value.kind === "string" &&
      typeof value.title === "string" &&
      typeof value.pid === "number" &&
      typeof value.acquiredAt === "string" &&
      typeof value.heartbeatAt === "string"
    ) {
      return value as DesktopLockRecord;
    }
  } catch {
    // fall through
  }
  return null;
}

export class DesktopLock {
  readonly path: string;
  private readonly pid: number;
  private readonly now: () => number;
  private readonly staleMs: number;
  private readonly isAlive: (pid: number) => boolean;

  constructor(options: DesktopLockOptions = {}) {
    this.path = options.path ?? DEFAULT_DESKTOP_LOCK_PATH;
    this.pid = options.pid ?? process.pid;
    this.now = options.now ?? Date.now;
    this.staleMs = options.staleMs ?? DESKTOP_LOCK_STALE_MS;
    this.isAlive = options.isAlive ?? processIsAlive;
  }

  /** The current record, or null when free (or the file is unreadable). */
  read(): DesktopLockRecord | null {
    try {
      return parseRecord(readFileSync(this.path, "utf8"));
    } catch {
      return null;
    }
  }

  /** Whether a record no longer holds the desktop. */
  isStale(record: DesktopLockRecord): boolean {
    if (!this.isAlive(record.pid)) return true;
    const beat = Date.parse(record.heartbeatAt);
    return !Number.isFinite(beat) || this.now() - beat > this.staleMs;
  }

  /** The live holder, or null. */
  holder(): DesktopLockRecord | null {
    const record = this.read();
    return record && !this.isStale(record) ? record : null;
  }

  acquire(claimant: DesktopLockClaimant): DesktopLockResult {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt++) {
      const stamp = new Date(this.now()).toISOString();
      const fresh: DesktopLockRecord = {
        holderId: claimant.holderId,
        kind: claimant.kind,
        title: claimant.title,
        pid: this.pid,
        ...(claimant.app ? { app: claimant.app } : {}),
        acquiredAt: stamp,
        heartbeatAt: stamp,
      };
      let fd: number | null = null;
      try {
        fd = openSync(this.path, "wx", 0o600);
        writeSync(fd, JSON.stringify(fresh));
        return { ok: true, record: fresh };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      } finally {
        if (fd !== null) closeSync(fd);
      }
      const existing = this.read();
      if (existing && existing.holderId === claimant.holderId) {
        const renewed: DesktopLockRecord = {
          ...existing,
          pid: this.pid,
          title: claimant.title || existing.title,
          ...(claimant.app ? { app: claimant.app } : {}),
          heartbeatAt: stamp,
        };
        this.writeAtomically(renewed);
        return { ok: true, record: renewed };
      }
      if (!existing || this.isStale(existing)) {
        try {
          unlinkSync(this.path);
        } catch {
          // Someone else cleaned it up first; try again.
        }
        continue;
      }
      return { ok: false, holder: existing, reason: `${holderSentence(existing)}. Try again when it finishes.` };
    }
    // Lost two races in a row: someone is taking it right now.
    const holder = this.read() ?? undefined;
    return { ok: false, holder, reason: holder ? `${holderSentence(holder)}. Try again when it finishes.` : "The desktop is being claimed by another session. Try again." };
  }

  /** Refreshes the heartbeat (and the app shown to others) while we hold it. */
  heartbeat(holderId: string, app?: string): boolean {
    const record = this.read();
    if (!record || record.holderId !== holderId) return false;
    this.writeAtomically({ ...record, ...(app ? { app } : {}), heartbeatAt: new Date(this.now()).toISOString() });
    return true;
  }

  /** Lets go iff the record is ours. */
  release(holderId: string): boolean {
    const record = this.read();
    if (!record || record.holderId !== holderId) return false;
    try {
      unlinkSync(this.path);
      return true;
    } catch {
      return false;
    }
  }

  private writeAtomically(record: DesktopLockRecord) {
    const tmp = `${this.path}.${this.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, JSON.stringify(record));
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.path);
  }
}

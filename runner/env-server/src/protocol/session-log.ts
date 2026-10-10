/**
 * Append-only, event-sourced session log (SPEC §3.1).
 *
 * Every session event gets a gap-free, durable `sequence`. Events are written
 * one JSON object per line to `<dataDir>/sessions/<id>/events.jsonl` before
 * they reach any subscriber, so a reconnecting client can always be served
 * from its cursor. The snapshot is the fold of the log (reducer.ts) and is
 * rebuilt on load; nothing else is authoritative.
 *
 * JSONL rather than SQLite: it needs no native module on any Node the Mac app
 * may bundle, appends are atomic per line on APFS/ext4 for our sizes, and a
 * torn last line after a crash is detected and dropped on load.
 *
 * Text deltas are coalesced into ≤ 50 ms batches per (item, field): a
 * streaming token storm becomes ~20 events a second, and any non-delta event
 * flushes the pending deltas first so ordering is preserved.
 */
import fs from "node:fs";
import path from "node:path";
import type {
  ModelSelection,
  RuntimeMode,
  InteractionMode,
  RoleRouting,
  ServerEvent,
  ServerEventEnvelope,
  SessionSnapshot,
  SkillActivation,
  WorktreeInfo,
} from "../contracts/code-v2.js";
import { applySessionEvent } from "./reducer.js";
import { nowIso } from "../util.js";

export const DELTA_COALESCE_MS = 50;

/** Persisted, non-event session facts (provider resume handles, lineage). */
export interface SessionMeta {
  id: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  title?: string;
  selection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: InteractionMode;
  routing?: RoleRouting;
  parentSessionId?: string;
  worktree?: WorktreeInfo;
  /** Opaque per-adapter state needed to resume the vendor's own session (claude session id, codex thread id…). */
  providerState?: Record<string, unknown>;
  /** Completed turns; the next turn's ordinal is turnCount + 1. */
  turnCount: number;
  /** skills lane: the thread's selected skills (never `once` ones). */
  skills?: SkillActivation[];
}

interface StoredEvent {
  sequence: number;
  at: string;
  event: ServerEvent;
}

type Listener = (envelope: ServerEventEnvelope) => void;

interface PendingDelta {
  itemId: string;
  field: "text" | "output";
  append: string;
}

export class SessionLog {
  readonly id: string;
  readonly dir: string;
  meta: SessionMeta;
  #events: StoredEvent[] = [];
  #snapshot: SessionSnapshot;
  #sequence = 0;
  #listeners = new Set<Listener>();
  #pending: PendingDelta[] = [];
  #timer: NodeJS.Timeout | undefined;
  #fd: number | undefined;
  readonly coalesceMs: number;

  private constructor(dir: string, meta: SessionMeta, coalesceMs: number) {
    this.id = meta.id;
    this.dir = dir;
    this.meta = meta;
    this.coalesceMs = coalesceMs;
    this.#snapshot = emptySnapshot(meta);
  }

  static create(root: string, meta: SessionMeta, coalesceMs = DELTA_COALESCE_MS): SessionLog {
    const dir = path.join(root, safeSegment(meta.id));
    fs.mkdirSync(dir, { recursive: true });
    const log = new SessionLog(dir, meta, coalesceMs);
    log.saveMeta();
    return log;
  }

  /** Loads a session from disk, or returns null when it does not exist. */
  static load(root: string, id: string, coalesceMs = DELTA_COALESCE_MS): SessionLog | null {
    let dir: string;
    try {
      dir = path.join(root, safeSegment(id));
    } catch {
      return null;
    }
    let meta: SessionMeta;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")) as SessionMeta;
    } catch {
      return null;
    }
    const log = new SessionLog(dir, meta, coalesceMs);
    let raw = "";
    try {
      raw = fs.readFileSync(path.join(dir, "events.jsonl"), "utf8");
    } catch {
      raw = "";
    }
    const lines = raw.split("\n");
    let validBytes = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const isLast = i === lines.length - 1;
      if (!line) {
        if (!isLast) validBytes += 1;
        continue;
      }
      let stored: StoredEvent;
      try {
        stored = JSON.parse(line) as StoredEvent;
      } catch {
        // A torn final line from a crash mid-append: drop it and everything after.
        break;
      }
      if (stored.sequence !== log.#sequence + 1) break;
      log.#events.push(stored);
      log.#sequence = stored.sequence;
      log.#snapshot = applySessionEvent(log.#snapshot, stored.event);
      validBytes += Buffer.byteLength(line, "utf8") + (isLast ? 0 : 1);
    }
    if (validBytes < Buffer.byteLength(raw, "utf8")) {
      fs.truncateSync(path.join(dir, "events.jsonl"), validBytes);
    }
    log.#syncSnapshotFromMeta();
    // A process that died mid-turn leaves the snapshot "running"; nothing is
    // running now, so the fold must not claim otherwise.
    if (log.#snapshot.state === "running" || log.#snapshot.state === "waiting") {
      log.#snapshot = { ...log.#snapshot, state: "idle" };
      delete log.#snapshot.activeTurnId;
    }
    return log;
  }

  /** Ids of every session stored under `root`. */
  static list(root: string): string[] {
    try {
      return fs
        .readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && fs.existsSync(path.join(root, d.name, "meta.json")))
        .map((d) => d.name);
    } catch {
      return [];
    }
  }

  get sequence(): number {
    this.flush();
    return this.#sequence;
  }

  get snapshot(): SessionSnapshot {
    this.flush();
    return this.#snapshot;
  }

  /** Snapshot plus the sequence it is current at, read atomically. */
  snapshotAt(): { snapshotSequence: number; session: SessionSnapshot } {
    this.flush();
    return { snapshotSequence: this.#sequence, session: structuredClone(this.#snapshot) };
  }

  /** Events with sequence > after, or null when the log no longer holds them. */
  eventsAfter(after: number): ServerEventEnvelope[] | null {
    this.flush();
    if (after > this.#sequence) return null;
    const first = this.#events[0]?.sequence ?? this.#sequence + 1;
    if (after + 1 < first) return null;
    return this.#events.filter((e) => e.sequence > after).map((e) => this.#envelope(e));
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Emits one event. Deltas are coalesced; everything else is written immediately (after pending deltas). */
  emit(event: ServerEvent): void {
    if (event.type === "item.delta") {
      if (!event.append) return;
      const last = this.#pending[this.#pending.length - 1];
      if (last && last.itemId === event.itemId && last.field === event.field) last.append += event.append;
      else this.#pending.push({ itemId: event.itemId, field: event.field, append: event.append });
      if (this.coalesceMs <= 0) this.flush();
      else if (!this.#timer) {
        this.#timer = setTimeout(() => this.flush(), this.coalesceMs);
        this.#timer.unref?.();
      }
      return;
    }
    this.flush();
    this.#append(event);
  }

  /** Writes any coalesced deltas now. */
  flush(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    if (this.#pending.length === 0) return;
    const pending = this.#pending;
    this.#pending = [];
    for (const delta of pending) {
      this.#append({ type: "item.delta", itemId: delta.itemId, field: delta.field, append: delta.append });
    }
  }

  updateMeta(patch: Partial<SessionMeta>): void {
    this.meta = { ...this.meta, ...patch, updatedAt: nowIso() };
    this.saveMeta();
    this.#syncSnapshotFromMeta();
  }

  saveMeta(): void {
    const file = path.join(this.dir, "meta.json");
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.meta, null, 2));
    fs.renameSync(tmp, file);
  }

  close(): void {
    this.flush();
    if (this.#fd !== undefined) {
      try {
        fs.closeSync(this.#fd);
      } catch {
        /* already closed */
      }
      this.#fd = undefined;
    }
    this.#listeners.clear();
  }

  #append(event: ServerEvent): void {
    const stored: StoredEvent = { sequence: this.#sequence + 1, at: nowIso(), event };
    if (this.#fd === undefined) this.#fd = fs.openSync(path.join(this.dir, "events.jsonl"), "a");
    fs.writeSync(this.#fd, `${JSON.stringify(stored)}\n`);
    this.#sequence = stored.sequence;
    this.#events.push(stored);
    this.#snapshot = applySessionEvent(this.#snapshot, event);
    if (this.meta.updatedAt !== stored.at) {
      this.meta.updatedAt = stored.at;
    }
    const envelope = this.#envelope(stored);
    for (const listener of [...this.#listeners]) {
      try {
        listener(envelope);
      } catch {
        /* a broken subscriber never breaks the log */
      }
    }
  }

  #envelope(stored: StoredEvent): ServerEventEnvelope {
    return { type: "event", stream: "session", sessionId: this.id, sequence: stored.sequence, at: stored.at, event: stored.event };
  }

  #syncSnapshotFromMeta(): void {
    const s = this.#snapshot;
    const next: SessionSnapshot = {
      ...s,
      cwd: this.meta.cwd,
      selection: s.activeTurnId ? s.selection : this.meta.selection,
      runtimeMode: this.meta.runtimeMode,
      interactionMode: this.meta.interactionMode,
    };
    if (this.meta.title) next.title = this.meta.title;
    if (this.meta.routing) next.routing = this.meta.routing;
    if (this.meta.worktree) next.worktree = this.meta.worktree;
    if (this.meta.skills?.length) next.skills = this.meta.skills;
    else delete next.skills;
    this.#snapshot = next;
  }
}

function emptySnapshot(meta: SessionMeta): SessionSnapshot {
  const snapshot: SessionSnapshot = {
    id: meta.id,
    cwd: meta.cwd,
    selection: meta.selection,
    runtimeMode: meta.runtimeMode,
    interactionMode: meta.interactionMode,
    state: "idle",
    items: [],
    queue: [],
  };
  if (meta.title) snapshot.title = meta.title;
  if (meta.routing) snapshot.routing = meta.routing;
  if (meta.worktree) snapshot.worktree = meta.worktree;
  if (meta.skills?.length) snapshot.skills = meta.skills;
  return snapshot;
}

/** Session ids become directory names; anything outside [A-Za-z0-9_.-] is refused rather than escaped. */
export function safeSegment(id: string): string {
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(id) || id === "." || id === "..") {
    throw new Error(`invalid session id: ${JSON.stringify(id)}`);
  }
  return id;
}

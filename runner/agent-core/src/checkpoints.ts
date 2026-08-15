import fs from 'node:fs';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';

interface CheckpointIndexEntry {
  turnIndex: number;
  createdAt: string;
  /** Map of absolute file path -> snapshot filename, or null if the file did not exist. */
  files: Record<string, string | null>;
}

/**
 * What a single-file rollback actually did to the working tree.
 *
 * Three outcomes, not a boolean, because "the file is gone now" and "the file
 * holds its old bytes now" are different things to report and the caller has to
 * be able to say which happened. `deleted` is the `null`-snapshot case — the
 * file did not exist before the turn that created it, so undoing that turn
 * means REMOVING it. Writing an empty file instead (the obvious shortcut when
 * `null` is read as "empty content") leaves a zero-byte stub behind that the
 * build then trips over, and the reader is told the change was undone.
 *
 * `unknown` means no snapshot was ever taken for this path: either nothing
 * wrote it, or it was written by bash, which is outside the snapshot net (see
 * the class docstring). Callers MUST surface that as "cannot undo this" rather
 * than as success — the whole point of the third outcome.
 */
export type FileRollback = 'restored' | 'deleted' | 'unknown';

/**
 * Per-turn file snapshots. Before the agent mutates a file through write/edit
 * tools, the original content is saved; this powers undo-last-turn, rewind to
 * any earlier turn, and diff-since-turn. Bash-driven mutations are outside the
 * snapshot net (documented limitation until sandboxed exec lands in M5).
 */
export class CheckpointStore {
  private dir: string;
  private index: CheckpointIndexEntry[] = [];

  constructor(sessionDir: string) {
    this.dir = path.join(sessionDir, 'checkpoints');
    fs.mkdirSync(this.dir, { recursive: true });
    const indexPath = path.join(this.dir, 'index.json');
    if (fs.existsSync(indexPath)) {
      this.index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as CheckpointIndexEntry[];
    }
  }

  private save(): void {
    fs.writeFileSync(path.join(this.dir, 'index.json'), JSON.stringify(this.index, null, 2));
  }

  private entryFor(turnIndex: number): CheckpointIndexEntry {
    let entry = this.index.find((e) => e.turnIndex === turnIndex);
    if (!entry) {
      entry = { turnIndex, createdAt: new Date().toISOString(), files: {} };
      this.index.push(entry);
      this.save();
    }
    return entry;
  }

  /** Snapshot a file's pre-mutation state for the given turn (first write wins). */
  snapshot(turnIndex: number, absPath: string): void {
    const entry = this.entryFor(turnIndex);
    if (absPath in entry.files) return;
    if (fs.existsSync(absPath)) {
      const name = `${turnIndex}-${Object.keys(entry.files).length}-${path.basename(absPath)}`;
      fs.copyFileSync(absPath, path.join(this.dir, name));
      entry.files[absPath] = name;
    } else {
      entry.files[absPath] = null; // file will be created; undo means delete
    }
    this.save();
  }

  turnsWithChanges(): number[] {
    return this.index
      .filter((e) => Object.keys(e.files).length > 0)
      .map((e) => e.turnIndex)
      .sort((a, b) => a - b);
  }

  changedPaths(turnIndex: number): string[] {
    return Object.keys(this.index.find((e) => e.turnIndex === turnIndex)?.files ?? {});
  }

  /**
   * Restore the workspace to its state before `turnIndex`. For each file touched
   * at or after that turn, the earliest snapshot wins.
   */
  restoreToBefore(turnIndex: number): string[] {
    const affected = this.index
      .filter((e) => e.turnIndex >= turnIndex)
      .sort((a, b) => a.turnIndex - b.turnIndex);
    const earliest = new Map<string, string | null>();
    for (const entry of affected) {
      for (const [abs, snap] of Object.entries(entry.files)) {
        if (!earliest.has(abs)) earliest.set(abs, snap);
      }
    }
    const restored: string[] = [];
    for (const [abs, snap] of earliest) {
      if (snap === null) {
        if (fs.existsSync(abs)) fs.rmSync(abs);
      } else {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.copyFileSync(path.join(this.dir, snap), abs);
      }
      restored.push(abs);
    }
    this.index = this.index.filter((e) => e.turnIndex < turnIndex);
    this.save();
    return restored;
  }

  /**
   * Every path this store could still roll back, cheapest possible answer to
   * "which of the files on screen have an undo behind them".
   *
   * A caller that instead asked `changedPaths(lastTurn)` would get the paths of
   * ONE turn and quietly offer nothing for a file written two turns ago, which
   * is the bug this exists to prevent: the rollback surface has to agree with
   * what `revertFile` will accept, and that is the union across turns.
   */
  snapshottedPaths(): string[] {
    const seen = new Set<string>();
    for (const entry of this.index) {
      for (const abs of Object.keys(entry.files)) seen.add(abs);
    }
    return [...seen];
  }

  /**
   * Restore ONE file to the state it had before the earliest turn that touched
   * it, leaving every other file this session wrote exactly as it is.
   *
   * The EARLIEST snapshot, not the latest, and that choice is the whole
   * semantics: a file written in turn 1 and rewritten in turn 3 has two
   * snapshots, and reverting to the turn-3 one would hand back the turn-1
   * agent's output as though it were the reader's own file. "Undo what the
   * agent did to this file" can only mean the state before the agent first
   * touched it — the same rule `restoreToBefore` already applies per path.
   *
   * Feasible at all only because the index is a per-file map rather than a
   * per-turn blob: the entry that holds the whole turn also holds each path's
   * own snapshot, so one path can be lifted out of it without disturbing the
   * others.
   */
  revertFile(absPath: string): FileRollback {
    const snapshot = this.earliestSnapshot(absPath);
    if (snapshot === undefined) return 'unknown';
    let outcome: FileRollback;
    if (snapshot === null) {
      if (fs.existsSync(absPath)) fs.rmSync(absPath);
      outcome = 'deleted';
    } else {
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.copyFileSync(path.join(this.dir, snapshot), absPath);
      outcome = 'restored';
    }
    // The file now holds its pre-agent bytes, so it has nothing left to undo.
    // Leaving the snapshots in place would be harmless on disk (a later
    // `restoreToBefore` would copy identical bytes over identical bytes) and
    // wrong on screen: `snapshottedPaths` would keep offering an undo for a
    // file already undone, and pressing it a second time would report success
    // for a no-op.
    this.forget(absPath);
    return outcome;
  }

  /**
   * Keep this file's changes for good: drop its snapshots so no later rollback
   * — including a whole-turn `restoreToBefore` — will touch it.
   *
   * The counterpart to `revertFile`, and it is a real state change rather than
   * a UI flag, which is why it lives here. "Undo the turn but keep this one
   * file" has no other implementation: the turn rewind walks the index, so the
   * only way to exempt a path from it is to take the path out of the index.
   * Returns false when there was nothing to keep, so a caller never reports
   * having pinned a file the store never held.
   */
  keepFile(absPath: string): boolean {
    if (this.earliestSnapshot(absPath) === undefined) return false;
    this.forget(absPath);
    return true;
  }

  /** The snapshot name recorded by the earliest turn that touched `absPath`
   *  (`null` = did not exist), or `undefined` when no turn ever touched it.
   *  Three-valued on purpose: `null` is a real recorded state, not an absence. */
  private earliestSnapshot(absPath: string): string | null | undefined {
    let best: { turnIndex: number; snapshot: string | null } | undefined;
    for (const entry of this.index) {
      if (!(absPath in entry.files)) continue;
      if (!best || entry.turnIndex < best.turnIndex) {
        best = { turnIndex: entry.turnIndex, snapshot: entry.files[absPath] };
      }
    }
    return best ? best.snapshot : undefined;
  }

  /** Remove a path from every turn's map and persist. The snapshot FILES are
   *  deliberately left on disk: they are small, they are cleaned up with the
   *  session directory, and unlinking them here would make a half-failed
   *  rollback unrecoverable rather than merely repeatable. */
  private forget(absPath: string): void {
    for (const entry of this.index) delete entry.files[absPath];
    this.save();
  }

  /** Unified diff of everything changed since (and including) `turnIndex`. */
  diffSince(turnIndex: number, cwd: string): string {
    const affected = this.index
      .filter((e) => e.turnIndex >= turnIndex)
      .sort((a, b) => a.turnIndex - b.turnIndex);
    const earliest = new Map<string, string | null>();
    for (const entry of affected) {
      for (const [abs, snap] of Object.entries(entry.files)) {
        if (!earliest.has(abs)) earliest.set(abs, snap);
      }
    }
    const patches: string[] = [];
    for (const [abs, snap] of earliest) {
      const before = snap === null ? '' : fs.readFileSync(path.join(this.dir, snap), 'utf8');
      const after = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
      if (before === after) continue;
      const rel = path.relative(cwd, abs);
      patches.push(createTwoFilesPatch(`a/${rel}`, `b/${rel}`, before, after, '', ''));
    }
    return patches.join('\n') || 'No file changes.';
  }
}

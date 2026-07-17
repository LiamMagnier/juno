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

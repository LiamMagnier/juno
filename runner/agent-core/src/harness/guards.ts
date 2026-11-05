/**
 * Tool-call guards (SPEC §3.10), applied by every executor — root and child.
 *
 * - FileStateGuard: an existing file may only be edited or overwritten after
 *   this agent read it, and only while it is unchanged since that read (or
 *   since this agent's own last write). A stale edit is rejected with the
 *   reason, so the model re-reads instead of clobbering a change made by a
 *   person, a formatter or another agent.
 * - RepeatCallGuard: the same call with the same arguments three, five and
 *   eight times in a row earns a reminder appended to its result.
 * - Justification: every mutating tool takes a one-line `justification`
 *   argument, listed first, which approval cards and the auto reviewer show.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ToolSpec } from '../types.js';
import type { ToolDefinition } from '../tools/types.js';

// MARK: - Read-before-edit

interface FileFingerprint {
  mtimeMs: number;
  size: number;
  hash: string;
  /** The agent saw only part of it (a line window, or read_file's character cap). */
  partial?: boolean;
}

/** read_file's own cap and window (tools/fs.ts), mirrored to tell a whole read from a partial one. */
const READ_CAP_CHARS = 50_000;
function readWasPartial(abs: string, input: Record<string, unknown>): boolean {
  let text: string;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch {
    return false;
  }
  if (input.offset !== undefined || input.limit !== undefined) {
    const lines = text.split('\n');
    const start = Math.max(0, Number(input.offset ?? 1) - 1);
    const count = Number(input.limit ?? 2000);
    if (start > 0 || start + count < lines.length) return true;
    text = lines.slice(start, start + count).join('\n');
  }
  return text.length > READ_CAP_CHARS;
}

function fingerprint(abs: string): FileFingerprint | null {
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile()) return null;
    const hash = crypto.createHash('sha1').update(fs.readFileSync(abs)).digest('hex');
    return { mtimeMs: stat.mtimeMs, size: stat.size, hash };
  } catch {
    return null;
  }
}

const READ_TOOLS = new Set(['read_file']);
const WRITE_TOOLS = new Set(['edit_file', 'write_file']);
/** The multi-file batch tool (tools/edit-files.ts), checked operation by operation. */
const BATCH_TOOL = 'edit_files';

/** The `{ op, path }` pairs of an edit_files call, skipping malformed entries (the tool refuses those). */
function batchOperations(input: Record<string, unknown>): Array<{ op: string; path: string }> {
  if (!Array.isArray(input.operations)) return [];
  const ops: Array<{ op: string; path: string }> = [];
  for (const entry of input.operations) {
    if (!entry || typeof entry !== 'object') continue;
    const { op, path: p } = entry as { op?: unknown; path?: unknown };
    if (typeof op === 'string' && typeof p === 'string') ops.push({ op, path: p });
  }
  return ops;
}

export class FileStateGuard {
  private readonly known = new Map<string, FileFingerprint>();

  constructor(private readonly cwd: string) {}

  /** A copy for a fork: the child starts knowing what its parent read. */
  clone(cwd = this.cwd): FileStateGuard {
    const copy = new FileStateGuard(cwd);
    if (cwd === this.cwd) for (const [key, value] of this.known) copy.known.set(key, value);
    return copy;
  }

  private key(candidate: string): string {
    const abs = path.isAbsolute(candidate) ? candidate : path.resolve(this.cwd, candidate);
    try {
      return fs.realpathSync(abs);
    } catch {
      // Not on disk yet: realpath the parent so a later read of the created
      // file meets the same key.
      try {
        return path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs));
      } catch {
        return path.normalize(abs);
      }
    }
  }

  /**
   * Null when the call may run, or the refusal the model reads. Only edit
   * tools on files that already exist are checked; a new file needs no read.
   */
  check(toolName: string, input: Record<string, unknown>): string | null {
    if (toolName === BATCH_TOOL) return this.checkBatch(input);
    if (!WRITE_TOOLS.has(toolName) || typeof input.path !== 'string') return null;
    return this.checkOne(toolName === 'write_file' ? 'overwrite' : 'edit', input.path);
  }

  /**
   * One existing file, about to be edited (only text the model saw is
   * replaced) or overwritten/deleted (everything goes, so a partial read is
   * not enough).
   */
  private checkOne(action: 'edit' | 'overwrite' | 'delete', displayPath: string, toolName = action === 'edit' ? 'edit_file' : 'write_file'): string | null {
    const key = this.key(displayPath);
    const current = fingerprint(key);
    if (current === null) return null;
    const seen = this.known.get(key);
    if (!seen) {
      const verb = action === 'edit' ? 'editing' : action === 'delete' ? 'deleting' : 'overwriting';
      return `Refused: read ${displayPath} with read_file before ${verb} it, so the change is made against its current contents.`;
    }
    // Overwriting a file seen only in part would drop what was never shown;
    // edit_file replaces only text the model saw, so it stays allowed.
    if (action !== 'edit' && seen.partial && seen.hash === current.hash) {
      return action === 'delete'
        ? `Refused: you read only part of ${displayPath}, so deleting it would drop what you have not seen. Read the whole file first.`
        : `Refused: you read only part of ${displayPath}, so overwriting it with ${toolName} would drop the rest. Use edit_file for the change, or read the whole file first.`;
    }
    if (seen.hash !== current.hash) {
      return `Refused: ${displayPath} changed on disk since you last read it (someone or something else edited it). Read it again, then redo the edit against the new contents.`;
    }
    return null;
  }

  /**
   * Every file an edit_files batch edits or deletes, as it is on disk now.
   * Creating a file needs no read (the tool refuses a create over an existing
   * file). The first refusal refuses the whole batch, naming the operation.
   */
  private checkBatch(input: Record<string, unknown>): string | null {
    const ops = batchOperations(input);
    const checked = new Set<string>();
    for (let i = 0; i < ops.length; i++) {
      const { op, path: p } = ops[i]!;
      if (op !== 'edit' && op !== 'delete') continue;
      const key = `${op === 'delete' ? 'd' : 'e'}:${this.key(p)}`;
      if (checked.has(key)) continue;
      checked.add(key);
      const refusal = this.checkOne(op, p, BATCH_TOOL);
      if (refusal) return `${refusal} (edit_files operation ${i + 1}; nothing in the batch was written.)`;
    }
    return null;
  }

  /** Record what the agent now knows after a successful call. */
  record(toolName: string, input: Record<string, unknown>, isError: boolean): void {
    if (toolName === BATCH_TOOL) {
      // All or nothing: a refused batch wrote nothing, so there is nothing new to know.
      if (isError) return;
      for (const p of new Set(batchOperations(input).map((op) => op.path))) {
        const key = this.key(p);
        const current = fingerprint(key);
        if (current) this.known.set(key, current);
        else this.known.delete(key);
      }
      return;
    }
    if (isError || typeof input.path !== 'string') return;
    if (!READ_TOOLS.has(toolName) && !WRITE_TOOLS.has(toolName)) return;
    const key = this.key(input.path);
    const current = fingerprint(key);
    if (!current) return;
    // A write leaves the agent knowing the whole file; a read only what it returned.
    if (READ_TOOLS.has(toolName) && readWasPartial(key, input)) current.partial = true;
    this.known.set(key, current);
  }
}

// MARK: - Repeat-call reminder

export const REPEAT_THRESHOLDS = [3, 5, 8] as const;

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortJson((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

export function canonicalArguments(input: unknown): string {
  return JSON.stringify(sortJson(input ?? {}));
}

/**
 * Counts consecutive identical calls (tool name + canonical arguments, the
 * justification ignored). Advisory: the call still runs; at a threshold the
 * reminder rides back on its result.
 */
export class RepeatCallGuard {
  private lastKey: string | null = null;
  private count = 0;

  constructor(private readonly thresholds: readonly number[] = REPEAT_THRESHOLDS) {}

  /** Returns the reminder to append, or null. */
  observe(toolName: string, input: Record<string, unknown>): string | null {
    const { justification: _ignored, ...rest } = input;
    const args = canonicalArguments(rest);
    const key = `${toolName}\u0000${args}`;
    if (key === this.lastKey) this.count += 1;
    else {
      this.lastKey = key;
      this.count = 1;
    }
    if (!this.thresholds.includes(this.count)) return null;
    if (this.count === this.thresholds[0]) {
      return 'Reminder: you are repeating the exact same tool call with identical arguments. Read the previous result carefully; if the task is not done, try a different approach or different arguments instead of repeating the call.';
    }
    const preview = args.length > 500 ? `${args.slice(0, 500)}…` : args;
    return [
      'Repeated tool call detected:',
      `- tool: ${toolName}`,
      `- consecutive_calls: ${this.count}`,
      `- arguments: ${preview}`,
      'These calls are not making progress. Do not call this tool with these exact arguments again. Inspect the latest result and choose a different action or different arguments, or finish if you have enough evidence.',
    ].join('\n');
  }
}

// MARK: - Justification (description-first tool arguments)

export const JUSTIFICATION_PARAM = 'justification';

/**
 * The spec with a leading `justification` property for tools that change
 * something. Listed first so a streaming model writes the reason before the
 * payload; optional so a model that leaves it out is not refused.
 */
export function withJustification(tool: ToolDefinition): ToolSpec {
  if (tool.kind === 'read') return tool.spec;
  const schema = tool.spec.inputSchema as { properties?: Record<string, unknown> };
  const properties = schema.properties ?? {};
  if (JUSTIFICATION_PARAM in properties) return tool.spec;
  return {
    ...tool.spec,
    inputSchema: {
      ...tool.spec.inputSchema,
      properties: {
        [JUSTIFICATION_PARAM]: {
          type: 'string',
          description: 'One short sentence: why this call is needed now. Shown to the person approving it.',
        },
        ...properties,
      },
    },
  };
}

/** Splits the justification off before the tool sees its arguments. */
export function takeJustification(input: Record<string, unknown>): {
  input: Record<string, unknown>;
  justification?: string;
} {
  if (!(JUSTIFICATION_PARAM in input)) return { input };
  const { [JUSTIFICATION_PARAM]: raw, ...rest } = input;
  const justification = typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 400) : undefined;
  return { input: rest, ...(justification ? { justification } : {}) };
}

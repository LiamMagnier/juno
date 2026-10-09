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
    if (!WRITE_TOOLS.has(toolName) || typeof input.path !== 'string') return null;
    const key = this.key(input.path);
    const current = fingerprint(key);
    if (current === null) return null;
    const seen = this.known.get(key);
    if (!seen) {
      return `Refused: read ${input.path} with read_file before ${toolName === 'write_file' ? 'overwriting' : 'editing'} it, so the change is made against its current contents.`;
    }
    if (seen.hash !== current.hash) {
      return `Refused: ${input.path} changed on disk since you last read it (someone or something else edited it). Read it again, then redo the edit against the new contents.`;
    }
    return null;
  }

  /** Record what the agent now knows after a successful call. */
  record(toolName: string, input: Record<string, unknown>, isError: boolean): void {
    if (isError || typeof input.path !== 'string') return;
    if (!READ_TOOLS.has(toolName) && !WRITE_TOOLS.has(toolName)) return;
    const key = this.key(input.path);
    const current = fingerprint(key);
    if (current) this.known.set(key, current);
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

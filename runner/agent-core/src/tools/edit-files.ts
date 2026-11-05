import fs from 'node:fs';
import path from 'node:path';
import { diffLines } from 'diff';
import { assertContainedPath, writeFileAtomic } from './fs.js';
import type { ToolContext, ToolDefinition, ToolResult } from './types.js';

/**
 * `edit_files`: one call, many files, all or nothing.
 *
 * The model sends a list of operations (edit, create, delete) that may touch
 * several files, and may touch the same file more than once. The tool works in
 * three phases, and nothing reaches the disk until the first two have passed:
 *
 * 1. Validate and stage. Every path is contained in the workspace, every edit
 *    anchor matches exactly (uniquely unless `replace_all`), every edited file
 *    is UTF-8. The operations are applied, in order, to an in-memory copy of
 *    each file, so a later operation sees what an earlier one left.
 * 2. Compare. A file whose staged result equals what is on disk is skipped.
 * 3. Commit. Each file is written atomically (temp file and rename) or removed.
 *    Right before each write the file is checked again against the bytes that
 *    were staged from; if it changed in between, or any write fails, every file
 *    already written in this call is put back as it was.
 *
 * Read-before-edit freshness is checked by the executor's FileStateGuard
 * before the tool runs (it knows `edit_files` operations), and the executor
 * snapshots every path from `mutatedPaths` into the turn's checkpoint, so one
 * rewind undoes the whole batch.
 */

export const EDIT_FILES_MAX_OPERATIONS = 200;

export type EditFilesOperation =
  | { op: 'edit'; path: string; old_string: string; new_string: string; replace_all?: boolean }
  | { op: 'create'; path: string; content: string }
  | { op: 'delete'; path: string };

/** One file's staged state across the batch. */
interface StagedFile {
  abs: string;
  /** The path as the model first spelled it, for messages. */
  display: string;
  /** Bytes on disk when staged (null: did not exist). */
  original: Buffer | null;
  /** Permission bits on disk when staged, so a rolled-back delete keeps them. */
  originalMode: number | undefined;
  /** Staged content (null: absent after the batch so far). */
  current: string | null;
  /** Operations in this call that have touched the file so far. */
  touches: number;
}

export interface EditFilesFileSummary {
  path: string;
  change: 'modified' | 'created' | 'deleted';
  added: number;
  removed: number;
}

class OperationError extends Error {}

function describeOp(index: number, op: { op?: unknown; path?: unknown }): string {
  const kind = typeof op.op === 'string' ? op.op : 'operation';
  const target = typeof op.path === 'string' ? ` ${op.path}` : '';
  return `operation ${index + 1} (${kind}${target})`;
}

function resolveInput(ctx: ToolContext, p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(ctx.cwd, p);
}

/** The operations array as the model sent it, or an error message. */
function readOperations(input: Record<string, unknown>): Array<Record<string, unknown>> | string {
  const raw = input.operations;
  if (!Array.isArray(raw) || raw.length === 0) return 'operations must be a non-empty array.';
  if (raw.length > EDIT_FILES_MAX_OPERATIONS) {
    return `operations has ${raw.length} entries; the limit is ${EDIT_FILES_MAX_OPERATIONS}. Split the change into several calls.`;
  }
  for (let i = 0; i < raw.length; i++) {
    const op = raw[i];
    if (!op || typeof op !== 'object' || Array.isArray(op)) return `operation ${i + 1} must be an object.`;
  }
  return raw as Array<Record<string, unknown>>;
}

function lineCounts(before: string, after: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const part of diffLines(before, after)) {
    const lines = part.count ?? part.value.split('\n').length - (part.value.endsWith('\n') ? 1 : 0);
    if (part.added) added += lines;
    else if (part.removed) removed += lines;
  }
  return { added, removed };
}

function loadStaged(abs: string, display: string, where: string): StagedFile {
  let stat: fs.Stats | null = null;
  try {
    stat = fs.statSync(abs);
  } catch {
    stat = null;
  }
  if (stat && !stat.isFile()) throw new OperationError(`${where}: ${display} is not a regular file.`);
  if (!stat) return { abs, display, original: null, originalMode: undefined, current: null, touches: 0 };
  const bytes = fs.readFileSync(abs);
  return { abs, display, original: bytes, originalMode: stat.mode & 0o7777, current: null, touches: 0 };
}

/** The staged text of an existing file, decoded once; refuses bytes that are not UTF-8. */
function stagedText(file: StagedFile, where: string, decoded: Set<string>): string {
  if (file.current !== null || decoded.has(file.abs)) {
    if (file.current === null) throw new OperationError(`${where}: ${file.display} does not exist at this point in the batch (an earlier operation deleted it).`);
    return file.current;
  }
  if (file.original === null) throw new OperationError(`${where}: file not found: ${file.display}. Use a create operation for a new file.`);
  const text = file.original.toString('utf8');
  // Editing as UTF-8 rewrites every byte that is not valid UTF-8 as U+FFFD: a
  // Latin-1 or binary file would be silently damaged.
  if (!Buffer.from(text, 'utf8').equals(file.original)) {
    throw new OperationError(`${where}: ${file.display} is not UTF-8 text, so edit_files will not change it (that would corrupt it). Use bash for this file.`);
  }
  decoded.add(file.abs);
  file.current = text;
  return text;
}

/**
 * Phase 1: validate every operation and stage the results in memory. Throws an
 * OperationError naming the first operation that cannot apply; nothing on disk
 * is touched.
 */
function stage(ops: Array<Record<string, unknown>>, ctx: ToolContext): StagedFile[] {
  const files = new Map<string, StagedFile>();
  /** Files whose on-disk text has been decoded into `current` (or deleted since). */
  const decoded = new Set<string>();
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const where = describeOp(i, op);
    if (typeof op.path !== 'string' || op.path.trim() === '') throw new OperationError(`${where}: path must be a non-empty string.`);
    let abs: string;
    try {
      abs = assertContainedPath(ctx, resolveInput(ctx, op.path));
    } catch (error) {
      throw new OperationError(`${where}: ${error instanceof Error ? error.message : String(error)}`);
    }
    let file = files.get(abs);
    if (!file) {
      file = loadStaged(abs, op.path, where);
      files.set(abs, file);
    }
    const after = file.touches > 0 ? ' (after the earlier operations in this call on the same file)' : '';
    file.touches++;
    switch (op.op) {
      case 'edit': {
        if (typeof op.old_string !== 'string') throw new OperationError(`${where}: old_string must be a string.`);
        if (typeof op.new_string !== 'string') throw new OperationError(`${where}: new_string must be a string.`);
        if (op.replace_all !== undefined && typeof op.replace_all !== 'boolean') throw new OperationError(`${where}: replace_all must be a boolean.`);
        const oldStr = op.old_string;
        const newStr = op.new_string;
        // An empty old_string "matches" between every character.
        if (oldStr === '') throw new OperationError(`${where}: old_string must not be empty; use a create operation for a new file.`);
        const text = stagedText(file, where, decoded);
        const count = text.split(oldStr).length - 1;
        if (count === 0) throw new OperationError(`${where}: old_string not found in ${file.display}${after}. Re-read the file and anchor on its current text.`);
        if (count > 1 && op.replace_all !== true) {
          throw new OperationError(`${where}: old_string matches ${count} times in ${file.display}${after}; add surrounding context to make it unique, or set replace_all.`);
        }
        // Spliced, not String.replace: a string replacement reads `$&` and
        // friends in new_string as patterns.
        const at = text.indexOf(oldStr);
        file.current = op.replace_all === true ? text.split(oldStr).join(newStr) : text.slice(0, at) + newStr + text.slice(at + oldStr.length);
        break;
      }
      case 'create': {
        if (typeof op.content !== 'string') throw new OperationError(`${where}: content must be a string.`);
        const existsNow = decoded.has(file.abs) ? file.current !== null : file.original !== null;
        if (existsNow) throw new OperationError(`${where}: ${file.display} already exists. Use edit operations to change it, or delete it first.`);
        file.current = op.content;
        decoded.add(file.abs);
        break;
      }
      case 'delete': {
        const existsNow = decoded.has(file.abs) ? file.current !== null : file.original !== null;
        if (!existsNow) throw new OperationError(`${where}: file not found: ${file.display}.`);
        file.current = null;
        decoded.add(file.abs);
        break;
      }
      default:
        throw new OperationError(`${where}: op must be "edit", "create" or "delete".`);
    }
  }
  // Every operation decodes or replaces its file, so `current` is final for
  // every staged file.
  return [...files.values()];
}

function finalBytes(file: StagedFile): Buffer | null {
  return file.current === null ? null : Buffer.from(file.current, 'utf8');
}

function sameBytes(a: Buffer | null, b: Buffer | null): boolean {
  return a === null || b === null ? a === b : a.equals(b);
}

function readNow(abs: string): Buffer | null {
  try {
    return fs.readFileSync(abs);
  } catch {
    return null;
  }
}

/** Directories `mkdir -p` would create for `abs`, deepest last. */
function missingParents(abs: string): string[] {
  const missing: string[] = [];
  let dir = path.dirname(abs);
  while (!fs.existsSync(dir)) {
    missing.unshift(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return missing;
}

/** Puts one file back the way it was staged from. Returns an error message or null. */
function restore(file: StagedFile): string | null {
  try {
    if (file.original === null) {
      fs.rmSync(file.abs, { force: true });
    } else {
      fs.mkdirSync(path.dirname(file.abs), { recursive: true });
      writeFileAtomic(file.abs, file.original);
      if (file.originalMode !== undefined) fs.chmodSync(file.abs, file.originalMode);
    }
    return null;
  } catch (error) {
    return `${file.display}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Test seam: lets a test fail one write to prove the rollback. Not part of the tool's contract. */
export const editFilesTestHooks: { beforeWrite?: (abs: string) => void } = {};

/**
 * Phase 3: write every changed file, rolling back the ones already written if
 * any write fails or a file changed under the call.
 */
function commit(changed: StagedFile[], ctx: ToolContext): { ok: true } | { ok: false; message: string } {
  const applied: StagedFile[] = [];
  const createdDirs: string[] = [];
  let failure: string | null = null;
  for (const file of changed) {
    // Contained again right before the write: a parent directory swapped for a
    // symlink after staging must not carry the write out of the workspace.
    let still: string | null = null;
    try {
      still = assertContainedPath(ctx, file.abs);
    } catch {
      still = null;
    }
    if (still !== file.abs) {
      failure = `${file.display} no longer resolves inside the workspace (a directory on its path changed).`;
      break;
    }
    if (!sameBytes(readNow(file.abs), file.original)) {
      failure = `${file.display} changed on disk while edit_files was applying the batch. Read it again, then redo the change.`;
      break;
    }
    const next = finalBytes(file);
    try {
      editFilesTestHooks.beforeWrite?.(file.abs);
      if (next === null) {
        fs.rmSync(file.abs);
      } else {
        const parents = missingParents(file.abs);
        fs.mkdirSync(path.dirname(file.abs), { recursive: true });
        createdDirs.push(...parents);
        writeFileAtomic(file.abs, next);
      }
      applied.push(file);
    } catch (error) {
      failure = `writing ${file.display} failed: ${error instanceof Error ? error.message : String(error)}`;
      break;
    }
  }
  if (failure === null) return { ok: true };
  const unrestored: string[] = [];
  for (const file of applied.reverse()) {
    const problem = restore(file);
    if (problem) unrestored.push(problem);
  }
  for (const dir of createdDirs.reverse()) {
    try {
      fs.rmdirSync(dir);
    } catch {
      // Not empty (something else lives there now) or already gone: leave it.
    }
  }
  const tail = unrestored.length
    ? ` Rolling back also failed for: ${unrestored.join('; ')}. Those files may hold this call's version; check them before continuing.`
    : applied.length
      ? ` The ${applied.length} file${applied.length === 1 ? '' : 's'} already written ${applied.length === 1 ? 'was' : 'were'} restored; no file was changed.`
      : ' No file was changed.';
  return { ok: false, message: `edit_files aborted: ${failure}${tail}` };
}

function summarizeFiles(files: StagedFile[], ctx: ToolContext): EditFilesFileSummary[] {
  let root = ctx.cwd;
  try {
    root = fs.realpathSync(ctx.cwd);
  } catch {
    // Keep the spelling we were given.
  }
  return files.map((file) => {
    const before = file.original === null ? '' : file.original.toString('utf8');
    const after = file.current ?? '';
    const change: EditFilesFileSummary['change'] = file.original === null ? 'created' : file.current === null ? 'deleted' : 'modified';
    const rel = path.relative(root, file.abs).split(path.sep).join('/');
    return { path: rel || file.display, change, ...lineCounts(before, after) };
  });
}

/** Applies a batch of operations all-or-nothing. Exported for tests and other executors. */
export function applyEditFiles(input: Record<string, unknown>, ctx: ToolContext): ToolResult & { files?: EditFilesFileSummary[] } {
  const ops = readOperations(input);
  if (typeof ops === 'string') return { output: `edit_files refused: ${ops}`, isError: true };
  let staged: StagedFile[];
  try {
    staged = stage(ops, ctx);
  } catch (error) {
    if (error instanceof OperationError) return { output: `edit_files refused, nothing was written: ${error.message}`, isError: true };
    throw error;
  }
  const changed = staged.filter((file) => !sameBytes(finalBytes(file), file.original));
  if (changed.length === 0) return { output: 'edit_files: the operations leave every file as it was; nothing was written.', files: [] };
  const result = commit(changed, ctx);
  if (!result.ok) return { output: result.message, isError: true };
  const files = summarizeFiles(changed, ctx);
  const mark = { modified: 'M', created: 'A', deleted: 'D' } as const;
  const lines = files.map((f) => `${mark[f.change]} ${f.path} (+${f.added} -${f.removed})`);
  const totals = files.reduce((acc, f) => ({ added: acc.added + f.added, removed: acc.removed + f.removed }), { added: 0, removed: 0 });
  return {
    output: `Applied ${ops.length} operation${ops.length === 1 ? '' : 's'} to ${files.length} file${files.length === 1 ? '' : 's'} (+${totals.added} -${totals.removed}):\n${lines.join('\n')}`,
    files,
  };
}

/** The distinct paths an `edit_files` call names, relative ones resolved against cwd. */
export function editFilesPaths(input: Record<string, unknown>, cwd: string): string[] {
  if (!Array.isArray(input.operations)) return [];
  const seen = new Set<string>();
  for (const op of input.operations) {
    if (op && typeof op === 'object' && typeof (op as { path?: unknown }).path === 'string') {
      const p = (op as { path: string }).path;
      seen.add(path.isAbsolute(p) ? p : path.resolve(cwd, p));
    }
  }
  return [...seen];
}

export const editFilesTool: ToolDefinition = {
  kind: 'edit',
  spec: {
    name: 'edit_files',
    description:
      'Apply several file changes in one all-or-nothing batch: exact-string edits, new files and deletions, across one or more files. ' +
      'Every operation is checked first; if any anchor is missing or ambiguous, any path is outside the workspace, or any write fails, no file is changed and the error names the operation. ' +
      'Operations run in order, so later edits to the same file see earlier ones. Read each existing file before editing or deleting it. Prefer edit_file for a single edit.',
    inputSchema: {
      type: 'object',
      properties: {
        operations: {
          type: 'array',
          description: `The changes, applied in order (at most ${EDIT_FILES_MAX_OPERATIONS}).`,
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['edit', 'create', 'delete'], description: 'edit: replace old_string with new_string. create: a new file with content. delete: remove the file.' },
              path: { type: 'string', description: 'Absolute or cwd-relative file path' },
              old_string: { type: 'string', description: 'edit: exact text to replace; must be unique unless replace_all' },
              new_string: { type: 'string', description: 'edit: replacement text' },
              replace_all: { type: 'boolean', description: 'edit: replace every occurrence' },
              content: { type: 'string', description: 'create: the whole file content' },
            },
            required: ['op', 'path'],
          },
        },
      },
      required: ['operations'],
    },
  },
  summarize: (i) => {
    const ops = Array.isArray(i.operations) ? (i.operations as Array<{ path?: unknown }>) : [];
    const paths = [...new Set(ops.map((op) => (op && typeof op.path === 'string' ? op.path : '')).filter(Boolean))];
    if (paths.length === 0) return 'Edit files';
    const shown = paths.slice(0, 3).join(', ');
    return `Edit ${paths.length} file${paths.length === 1 ? '' : 's'}: ${shown}${paths.length > 3 ? `, +${paths.length - 3} more` : ''}`;
  },
  mutatedPaths: (input, ctx) => editFilesPaths(input, ctx.cwd),
  async execute(input, ctx): Promise<ToolResult> {
    const { files: _files, ...result } = applyEditFiles(input, ctx);
    return result;
  },
};

import fs from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import type { ToolContext, ToolDefinition, ToolResult } from './types.js';

const MAX_READ_CHARS = 50_000;
const MAX_GLOB_RESULTS = 200;
const MAX_GREP_MATCHES = 100;
const IGNORE = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/.next/**'];

function resolve(ctx: ToolContext, p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(ctx.cwd, p);
}

/**
 * Resolve a path through the real filesystem and require it to remain inside
 * the agent's workspace. The cloud runner's Bash tool is containerized, but
 * these Node filesystem tools execute in the driver process, so lexical
 * `../` checks alone are not enough: an in-worktree symlink can escape too.
 *
 * For a new file, realpath the deepest existing ancestor and append the
 * not-yet-created suffix. This protects write_file before it creates parent
 * directories, including when an existing parent is a symlink.
 */
export function assertContainedPath(ctx: ToolContext, candidate: string): string {
  const root = fs.realpathSync(ctx.cwd);
  const resolved = path.normalize(path.isAbsolute(candidate) ? candidate : path.resolve(ctx.cwd, candidate));
  let probe = resolved;
  const suffix: string[] = [];
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    suffix.unshift(path.basename(probe));
    probe = parent;
  }
  const canonical = path.resolve(fs.realpathSync(probe), ...suffix);
  const relative = path.relative(root, canonical);
  const outside =
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative);
  if (outside) {
    throw new Error(`Denied: ${candidate} is outside the agent workspace.`);
  }
  return canonical;
}

function safePattern(pattern: string): boolean {
  return !path.isAbsolute(pattern) && !pattern.split(/[\\/]+/).includes('..');
}

export const readFileTool: ToolDefinition = {
  kind: 'read',
  spec: {
    name: 'read_file',
    description:
      'Read a file from the filesystem. Returns up to 50k characters; use offset/limit (line numbers) for large files.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or cwd-relative file path' },
        offset: { type: 'number', description: '1-based line to start from' },
        limit: { type: 'number', description: 'Max number of lines to return' },
      },
      required: ['path'],
    },
  },
  summarize: (i) => `Read ${i.path}`,
  async execute(input, ctx): Promise<ToolResult> {
    let abs: string;
    try {
      abs = assertContainedPath(ctx, resolve(ctx, String(input.path)));
    } catch (error) {
      return { output: error instanceof Error ? error.message : String(error), isError: true };
    }
    if (!fs.existsSync(abs)) return { output: `File not found: ${abs}`, isError: true };
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(abs).slice(0, 200);
      return { output: `Directory listing of ${abs}:\n${entries.join('\n')}` };
    }
    let text = fs.readFileSync(abs, 'utf8');
    if (input.offset !== undefined || input.limit !== undefined) {
      const lines = text.split('\n');
      const start = Math.max(0, Number(input.offset ?? 1) - 1);
      const count = Number(input.limit ?? 2000);
      text = lines.slice(start, start + count).join('\n');
    }
    if (text.length > MAX_READ_CHARS) {
      text = text.slice(0, MAX_READ_CHARS) + `\n…[truncated at ${MAX_READ_CHARS} chars]`;
    }
    return { output: text };
  },
};

export const writeFileTool: ToolDefinition = {
  kind: 'edit',
  spec: {
    name: 'write_file',
    description: 'Create or overwrite a file with the given content. Creates parent directories.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
  },
  summarize: (i) => `Write ${i.path}`,
  mutatedPaths: (input, ctx) => [resolve(ctx, String(input.path))],
  async execute(input, ctx): Promise<ToolResult> {
    let abs: string;
    try {
      abs = assertContainedPath(ctx, resolve(ctx, String(input.path)));
    } catch (error) {
      return { output: error instanceof Error ? error.message : String(error), isError: true };
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, String(input.content), 'utf8');
    return { output: `Wrote ${String(input.content).length} chars to ${abs}` };
  },
};

export const editFileTool: ToolDefinition = {
  kind: 'edit',
  spec: {
    name: 'edit_file',
    description:
      'Replace an exact string in a file. old_string must match exactly and be unique unless replace_all is true.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  summarize: (i) => `Edit ${i.path}`,
  mutatedPaths: (input, ctx) => [resolve(ctx, String(input.path))],
  async execute(input, ctx): Promise<ToolResult> {
    let abs: string;
    try {
      abs = assertContainedPath(ctx, resolve(ctx, String(input.path)));
    } catch (error) {
      return { output: error instanceof Error ? error.message : String(error), isError: true };
    }
    if (!fs.existsSync(abs)) return { output: `File not found: ${abs}`, isError: true };
    const text = fs.readFileSync(abs, 'utf8');
    const oldStr = String(input.old_string);
    const newStr = String(input.new_string);
    const count = text.split(oldStr).length - 1;
    if (count === 0) return { output: `old_string not found in ${abs}`, isError: true };
    if (count > 1 && !input.replace_all) {
      return {
        output: `old_string matches ${count} times in ${abs}; make it unique or set replace_all`,
        isError: true,
      };
    }
    const updated = input.replace_all
      ? text.split(oldStr).join(newStr)
      : text.replace(oldStr, newStr);
    fs.writeFileSync(abs, updated, 'utf8');
    return { output: `Edited ${abs} (${count} replacement${count === 1 ? '' : 's'})` };
  },
};

export const globTool: ToolDefinition = {
  kind: 'read',
  spec: {
    name: 'glob',
    description: 'Find files matching a glob pattern (e.g. "src/**/*.ts"), relative to cwd.',
    inputSchema: {
      type: 'object',
      properties: { pattern: { type: 'string' } },
      required: ['pattern'],
    },
  },
  summarize: (i) => `Glob ${i.pattern}`,
  async execute(input, ctx): Promise<ToolResult> {
    const pattern = String(input.pattern);
    if (!safePattern(pattern)) {
      return { output: 'Denied: glob patterns must stay inside the agent workspace.', isError: true };
    }
    const matches = await fg(pattern, {
      cwd: ctx.cwd,
      ignore: IGNORE,
      onlyFiles: true,
      dot: false,
    });
    const contained = matches.filter((match) => {
      try {
        assertContainedPath(ctx, path.resolve(ctx.cwd, match));
        return true;
      } catch {
        return false;
      }
    });
    const shown = contained.slice(0, MAX_GLOB_RESULTS);
    let out = shown.join('\n') || 'No matches.';
    if (contained.length > MAX_GLOB_RESULTS) out += `\n…[${contained.length - MAX_GLOB_RESULTS} more]`;
    return { output: out };
  },
};

export const grepTool: ToolDefinition = {
  kind: 'read',
  spec: {
    name: 'grep',
    description:
      'Search file contents with a JavaScript regex. Optionally restrict to a glob of files. Returns file:line: matches.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JavaScript regular expression' },
        glob: { type: 'string', description: 'Restrict search to files matching this glob' },
      },
      required: ['pattern'],
    },
  },
  summarize: (i) => `Grep /${i.pattern}/${i.glob ? ` in ${i.glob}` : ''}`,
  async execute(input, ctx): Promise<ToolResult> {
    let re: RegExp;
    try {
      re = new RegExp(String(input.pattern));
    } catch (e) {
      return { output: `Invalid regex: ${String(e)}`, isError: true };
    }
    const pattern = String(input.glob ?? '**/*');
    if (!safePattern(pattern)) {
      return { output: 'Denied: grep patterns must stay inside the agent workspace.', isError: true };
    }
    const files = await fg(pattern, {
      cwd: ctx.cwd,
      ignore: IGNORE,
      onlyFiles: true,
      dot: false,
    });
    const results: string[] = [];
    for (const file of files) {
      if (results.length >= MAX_GREP_MATCHES) break;
      let text: string;
      try {
        const abs = assertContainedPath(ctx, path.resolve(ctx.cwd, file));
        const stat = fs.statSync(abs);
        if (stat.size > 2_000_000) continue;
        text = fs.readFileSync(abs, 'utf8');
        if (text.includes('\0')) continue; // binary
      } catch {
        continue;
      }
      const lines = text.split('\n');
      for (let n = 0; n < lines.length && results.length < MAX_GREP_MATCHES; n++) {
        if (re.test(lines[n])) {
          // `file` already comes back relative to `ctx.cwd`, so it is the path to
          // show. Re-running `path.relative` here would resolve it against the
          // driver's own cwd, which is not the session workspace.
          results.push(`${file}:${n + 1}: ${lines[n].slice(0, 300)}`);
        }
      }
    }
    return { output: results.join('\n') || 'No matches.' };
  },
};

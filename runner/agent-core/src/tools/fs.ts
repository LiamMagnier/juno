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
    const abs = resolve(ctx, String(input.path));
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
    const abs = resolve(ctx, String(input.path));
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
    const abs = resolve(ctx, String(input.path));
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
    const matches = await fg(String(input.pattern), {
      cwd: ctx.cwd,
      ignore: IGNORE,
      onlyFiles: true,
      dot: false,
    });
    const shown = matches.slice(0, MAX_GLOB_RESULTS);
    let out = shown.join('\n') || 'No matches.';
    if (matches.length > MAX_GLOB_RESULTS) out += `\n…[${matches.length - MAX_GLOB_RESULTS} more]`;
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
    const files = await fg(String(input.glob ?? '**/*'), {
      cwd: ctx.cwd,
      ignore: IGNORE,
      onlyFiles: true,
      dot: false,
      absolute: true,
    });
    const results: string[] = [];
    for (const file of files) {
      if (results.length >= MAX_GREP_MATCHES) break;
      let text: string;
      try {
        const stat = fs.statSync(file);
        if (stat.size > 2_000_000) continue;
        text = fs.readFileSync(file, 'utf8');
        if (text.includes('\0')) continue; // binary
      } catch {
        continue;
      }
      const lines = text.split('\n');
      for (let n = 0; n < lines.length && results.length < MAX_GREP_MATCHES; n++) {
        if (re.test(lines[n])) {
          const rel = path.relative(ctx.cwd, file);
          results.push(`${rel}:${n + 1}: ${lines[n].slice(0, 300)}`);
        }
      }
    }
    return { output: results.join('\n') || 'No matches.' };
  },
};

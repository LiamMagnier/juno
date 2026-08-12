/**
 * Diff model: parsing, reconstruction, and bounded rendering.
 *
 * Two sources feed the reviewer, and they are not equally good — the UI says
 * which one it is looking at rather than pretending they are the same thing:
 *
 *  1. `origin: 'patch'` — a real unified diff. Complete, with true line
 *     numbers. Produced by the agent host's `diffSince()`, which reaches the
 *     renderer only if a `code:diff` channel exists. It does not exist in
 *     `src/shared/ipc.ts` today, so this path is dormant and the reviewer says
 *     so instead of showing an empty pane that looks like "no changes".
 *
 *  2. `origin: 'reconstructed'` — built from the *input* of an `edit_file` or
 *     `write_file` call, which the renderer already receives on `tool_started`.
 *     The content is exact (it is the literal text the agent wrote), but the
 *     surrounding file is not available, so line numbers are unknown and are
 *     rendered as such. This is real, useful review material; it is just not a
 *     whole-file diff, and labelling it honestly costs nothing.
 *
 * Changes made by shell commands are in neither bucket — `files_changed` gives
 * paths only. Those files are listed with an explicit "content unavailable"
 * state.
 */

import { inputBoolean, inputString } from './tools.js';

export type DiffLineKind = 'context' | 'add' | 'del';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** Null when the origin is `reconstructed`, or for an added line. */
  oldNumber: number | null;
  newNumber: number | null;
}

export interface DiffHunk {
  id: string;
  /** The `@@ … @@` header, or a synthetic label for reconstructed hunks. */
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
  added: number;
  removed: number;
  /** A hunk overlapping a conflict marker in the working tree. */
  conflicted: boolean;
}

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface DiffFile {
  id: string;
  path: string;
  previousPath: string | null;
  status: FileStatus;
  hunks: DiffHunk[];
  added: number;
  removed: number;
  origin: 'patch' | 'reconstructed' | 'unavailable';
  /** True when the file exceeded the render budget and was cut. */
  truncated: boolean;
  /** Lines the parser saw before truncating, for the "show the rest" affordance. */
  totalLines: number;
  binary: boolean;
  conflicted: boolean;
  /** Language hint for the tokenizer, from the extension. */
  language: string;
}

/**
 * Hard render budget per file. A 50,000-line diff is not review material, it is
 * a denial of service against the main thread: parsing it is cheap, laying it
 * out is not. Files past the budget are cut here and the viewer offers an
 * explicit control to raise it, so nothing is silently hidden.
 */
export const DEFAULT_LINE_BUDGET = 1200;

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const CONFLICT_RE = /^(<{7}|={7}|>{7})/;

function languageFor(path: string): string {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return 'text';
  const ext = path.slice(dot + 1).toLowerCase();
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'mts':
    case 'cts':
      return 'typescript';
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'json':
    case 'jsonc':
      return 'json';
    case 'css':
    case 'scss':
      return 'css';
    case 'py':
      return 'python';
    case 'rs':
      return 'rust';
    case 'go':
      return 'go';
    case 'swift':
      return 'swift';
    case 'sh':
    case 'bash':
    case 'zsh':
      return 'shell';
    case 'md':
    case 'mdx':
      return 'markdown';
    case 'yml':
    case 'yaml':
      return 'yaml';
    case 'html':
      return 'html';
    default:
      return 'text';
  }
}

function stripPrefix(path: string): string {
  if (path.startsWith('a/') || path.startsWith('b/')) return path.slice(2);
  return path;
}

/**
 * Parse a unified diff. Tolerant by design: a malformed hunk header must not
 * lose the rest of the patch, because the alternative is showing the user
 * nothing when the interesting file was the fourth one.
 */
export function parseUnifiedDiff(patch: string, lineBudget = DEFAULT_LINE_BUDGET): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = patch.split('\n');

  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldCursor = 0;
  let newCursor = 0;

  const closeHunk = (): void => {
    if (file && hunk) file.hunks.push(hunk);
    hunk = null;
  };
  const closeFile = (): void => {
    closeHunk();
    if (file) files.push(file);
    file = null;
  };

  const startFile = (path: string, previousPath: string | null): DiffFile => ({
    id: `${files.length}:${path}`,
    path,
    previousPath,
    status: 'modified',
    hunks: [],
    added: 0,
    removed: 0,
    origin: 'patch',
    truncated: false,
    totalLines: 0,
    binary: false,
    conflicted: false,
    language: languageFor(path),
  });

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (raw === undefined) continue;

    if (raw.startsWith('diff --git ')) {
      closeFile();
      const parts = raw.slice('diff --git '.length).split(' ');
      const left = parts[0] ?? '';
      const right = parts[1] ?? left;
      file = startFile(stripPrefix(right), null);
      const previous = stripPrefix(left);
      if (previous !== stripPrefix(right)) file.previousPath = previous;
      continue;
    }

    if (raw.startsWith('--- ')) {
      const path = stripPrefix(raw.slice(4).trim());
      if (!file) file = startFile(path === '/dev/null' ? path : path, null);
      if (path === '/dev/null') file.status = 'added';
      continue;
    }

    if (raw.startsWith('+++ ')) {
      const path = stripPrefix(raw.slice(4).trim());
      if (!file) file = startFile(path, null);
      if (path === '/dev/null') file.status = 'deleted';
      else if (file.path === '' || file.path === '/dev/null') {
        file.path = path;
        file.language = languageFor(path);
      }
      continue;
    }

    if (!file) continue;

    if (raw.startsWith('new file mode')) {
      file.status = 'added';
      continue;
    }
    if (raw.startsWith('deleted file mode')) {
      file.status = 'deleted';
      continue;
    }
    if (raw.startsWith('rename from ')) {
      file.previousPath = raw.slice('rename from '.length).trim();
      file.status = 'renamed';
      continue;
    }
    if (raw.startsWith('Binary files ')) {
      file.binary = true;
      continue;
    }

    const hunkMatch = HUNK_RE.exec(raw);
    if (hunkMatch) {
      closeHunk();
      oldCursor = Number(hunkMatch[1] ?? '1');
      newCursor = Number(hunkMatch[3] ?? '1');
      hunk = {
        id: `${file.id}#${file.hunks.length}`,
        header: raw,
        oldStart: oldCursor,
        newStart: newCursor,
        lines: [],
        added: 0,
        removed: 0,
        conflicted: false,
      };
      continue;
    }

    if (!hunk) continue;

    file.totalLines += 1;
    if (file.totalLines > lineBudget) {
      file.truncated = true;
      continue;
    }

    const marker = raw.charAt(0);
    const text = raw.slice(1);
    if (CONFLICT_RE.test(text) || CONFLICT_RE.test(raw)) {
      hunk.conflicted = true;
      file.conflicted = true;
    }

    if (marker === '+') {
      hunk.lines.push({ kind: 'add', text, oldNumber: null, newNumber: newCursor });
      newCursor += 1;
      hunk.added += 1;
      file.added += 1;
    } else if (marker === '-') {
      hunk.lines.push({ kind: 'del', text, oldNumber: oldCursor, newNumber: null });
      oldCursor += 1;
      hunk.removed += 1;
      file.removed += 1;
    } else if (marker === '\\') {
      /* "\ No newline at end of file" — metadata, not a line. */
      file.totalLines -= 1;
    } else {
      hunk.lines.push({ kind: 'context', text, oldNumber: oldCursor, newNumber: newCursor });
      oldCursor += 1;
      newCursor += 1;
    }
  }

  closeFile();
  return files;
}

/**
 * Build a reviewable file from an `edit_file` / `write_file` tool input.
 *
 * `edit_file` carries `old_string` and `new_string`; that is a genuine, exact
 * replacement pair, so the hunk content is truthful even though its position in
 * the file is not known. Line numbers are left null and the gutter renders a
 * dot, rather than inventing numbers that would be wrong.
 */
export function reconstructEditFile(
  toolName: string,
  input: unknown,
  index: number,
  lineBudget = DEFAULT_LINE_BUDGET,
): DiffFile | null {
  const path = inputString(input, 'path');
  if (path === null) return null;

  const base: DiffFile = {
    id: `reconstructed:${index}:${path}`,
    path,
    previousPath: null,
    status: 'modified',
    hunks: [],
    added: 0,
    removed: 0,
    origin: 'reconstructed',
    truncated: false,
    totalLines: 0,
    binary: false,
    conflicted: false,
    language: languageFor(path),
  };

  if (toolName === 'write_file') {
    const content = inputString(input, 'content');
    if (content === null) return null;
    const all = content.split('\n');
    base.status = 'added';
    base.totalLines = all.length;
    const shown = all.length > lineBudget ? all.slice(0, lineBudget) : all;
    base.truncated = shown.length < all.length;
    base.added = all.length;
    base.hunks = [
      {
        id: `${base.id}#0`,
        header: 'Whole file',
        oldStart: 0,
        newStart: 1,
        lines: shown.map((text, offset) => ({
          kind: 'add' as const,
          text,
          oldNumber: null,
          newNumber: offset + 1,
        })),
        added: shown.length,
        removed: 0,
        conflicted: false,
      },
    ];
    return base;
  }

  if (toolName !== 'edit_file') return null;

  const oldText = inputString(input, 'old_string');
  const newText = inputString(input, 'new_string');
  if (oldText === null || newText === null) return null;

  const removed = oldText.split('\n');
  const added = newText.split('\n');
  base.totalLines = removed.length + added.length;
  const budgetPerSide = Math.max(1, Math.floor(lineBudget / 2));
  const removedShown = removed.slice(0, budgetPerSide);
  const addedShown = added.slice(0, budgetPerSide);
  base.truncated = removedShown.length < removed.length || addedShown.length < added.length;
  base.removed = removed.length;
  base.added = added.length;

  const lines: DiffLine[] = [
    ...removedShown.map((text) => ({ kind: 'del' as const, text, oldNumber: null, newNumber: null })),
    ...addedShown.map((text) => ({ kind: 'add' as const, text, oldNumber: null, newNumber: null })),
  ];

  base.hunks = [
    {
      id: `${base.id}#0`,
      header: inputBoolean(input, 'replace_all') ? 'Replacement · every occurrence' : 'Replacement',
      oldStart: 0,
      newStart: 0,
      lines,
      added: addedShown.length,
      removed: removedShown.length,
      conflicted: false,
    },
  ];
  return base;
}

/** A placeholder entry for a path we know changed but cannot show. */
export function unavailableFile(path: string, index: number): DiffFile {
  return {
    id: `unavailable:${index}:${path}`,
    path,
    previousPath: null,
    status: 'modified',
    hunks: [],
    added: 0,
    removed: 0,
    origin: 'unavailable',
    truncated: false,
    totalLines: 0,
    binary: false,
    conflicted: false,
    language: languageFor(path),
  };
}

export interface DiffTotals {
  files: number;
  added: number;
  removed: number;
  conflicted: number;
}

export function totalsFor(files: readonly DiffFile[]): DiffTotals {
  let added = 0;
  let removed = 0;
  let conflicted = 0;
  for (const file of files) {
    added += file.added;
    removed += file.removed;
    if (file.conflicted) conflicted += 1;
  }
  return { files: files.length, added, removed, conflicted };
}

/**
 * Collapse long runs of unchanged context into skip markers. Reviewers care
 * about the change and about three lines either side of it; the other forty are
 * scroll distance.
 */
export type HunkRow =
  | { kind: 'line'; line: DiffLine; key: string }
  | { kind: 'skip'; count: number; key: string; from: number };

export function foldContext(hunk: DiffHunk, contextLines = 3): HunkRow[] {
  const rows: HunkRow[] = [];
  const lines = hunk.lines;
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) break;
    if (line.kind !== 'context') {
      rows.push({ kind: 'line', line, key: `${hunk.id}:${index}` });
      index += 1;
      continue;
    }

    let end = index;
    while (end < lines.length && lines[end]?.kind === 'context') end += 1;
    const run = end - index;
    const leading = index === 0;
    const trailing = end === lines.length;
    const keepHead = leading ? 0 : contextLines;
    const keepTail = trailing ? 0 : contextLines;

    if (run <= keepHead + keepTail + 2) {
      for (let offset = index; offset < end; offset += 1) {
        const contextLine = lines[offset];
        if (contextLine) rows.push({ kind: 'line', line: contextLine, key: `${hunk.id}:${offset}` });
      }
    } else {
      for (let offset = index; offset < index + keepHead; offset += 1) {
        const contextLine = lines[offset];
        if (contextLine) rows.push({ kind: 'line', line: contextLine, key: `${hunk.id}:${offset}` });
      }
      rows.push({
        kind: 'skip',
        count: run - keepHead - keepTail,
        key: `${hunk.id}:skip:${index}`,
        from: index + keepHead,
      });
      for (let offset = end - keepTail; offset < end; offset += 1) {
        const contextLine = lines[offset];
        if (contextLine) rows.push({ kind: 'line', line: contextLine, key: `${hunk.id}:${offset}` });
      }
    }
    index = end;
  }

  return rows;
}

/** Expand a previously folded skip marker back into its lines. */
export function expandSkip(hunk: DiffHunk, from: number, count: number): HunkRow[] {
  const rows: HunkRow[] = [];
  for (let offset = from; offset < from + count; offset += 1) {
    const line = hunk.lines[offset];
    if (line) rows.push({ kind: 'line', line, key: `${hunk.id}:${offset}` });
  }
  return rows;
}

/* -------------------------------------------------------------------------- */
/* Syntax highlighting                                                         */
/* -------------------------------------------------------------------------- */

export type TokenKind = 'plain' | 'keyword' | 'string' | 'number' | 'comment';

export interface Token {
  kind: TokenKind;
  text: string;
}

const KEYWORDS: Record<string, ReadonlySet<string>> = {
  typescript: new Set([
    'import', 'export', 'from', 'const', 'let', 'var', 'function', 'return', 'if', 'else',
    'for', 'while', 'switch', 'case', 'break', 'continue', 'class', 'extends', 'implements',
    'interface', 'type', 'enum', 'new', 'await', 'async', 'try', 'catch', 'finally', 'throw',
    'typeof', 'instanceof', 'in', 'of', 'as', 'satisfies', 'readonly', 'public', 'private',
    'protected', 'static', 'default', 'null', 'undefined', 'true', 'false', 'this', 'super',
    'void', 'never', 'unknown', 'any', 'declare', 'keyof', 'yield',
  ]),
  python: new Set([
    'def', 'class', 'import', 'from', 'return', 'if', 'elif', 'else', 'for', 'while', 'try',
    'except', 'finally', 'with', 'as', 'lambda', 'yield', 'raise', 'pass', 'None', 'True',
    'False', 'and', 'or', 'not', 'in', 'is', 'async', 'await', 'global', 'nonlocal',
  ]),
  rust: new Set([
    'fn', 'let', 'mut', 'const', 'struct', 'enum', 'impl', 'trait', 'pub', 'use', 'mod',
    'match', 'if', 'else', 'for', 'while', 'loop', 'return', 'self', 'Self', 'crate', 'where',
    'async', 'await', 'move', 'ref', 'dyn', 'true', 'false',
  ]),
  go: new Set([
    'func', 'package', 'import', 'var', 'const', 'type', 'struct', 'interface', 'map', 'chan',
    'go', 'defer', 'return', 'if', 'else', 'for', 'range', 'switch', 'case', 'default',
    'select', 'nil', 'true', 'false',
  ]),
  swift: new Set([
    'func', 'let', 'var', 'struct', 'class', 'enum', 'protocol', 'extension', 'import',
    'return', 'if', 'else', 'guard', 'for', 'in', 'while', 'switch', 'case', 'default',
    'throws', 'try', 'catch', 'async', 'await', 'self', 'nil', 'true', 'false', 'public',
    'private', 'internal', 'static', 'some', 'any',
  ]),
  shell: new Set([
    'if', 'then', 'else', 'fi', 'for', 'do', 'done', 'while', 'case', 'esac', 'function',
    'export', 'local', 'return', 'echo', 'set', 'source',
  ]),
};

KEYWORDS['javascript'] = KEYWORDS['typescript'] ?? new Set<string>();

const LINE_COMMENT: Record<string, string> = {
  typescript: '//',
  javascript: '//',
  rust: '//',
  go: '//',
  swift: '//',
  css: '/*',
  python: '#',
  shell: '#',
  yaml: '#',
};

const IDENT_RE = /[A-Za-z_$][A-Za-z0-9_$]*/y;
const NUMBER_RE = /(?:0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)/y;

/**
 * A deliberately small tokenizer. It exists to make a diff readable, not to be
 * a language server: strings, numbers, line comments and a keyword set per
 * language. It is O(n) over the line, allocation-light, and cannot throw on
 * malformed input — all three matter because it runs on every visible diff row.
 */
export function tokenize(text: string, language: string): Token[] {
  if (text.length === 0) return [];
  if (language === 'text' || language === 'markdown') return [{ kind: 'plain', text }];

  const keywords = KEYWORDS[language];
  const comment = LINE_COMMENT[language];
  const tokens: Token[] = [];
  let plainStart = 0;
  let index = 0;

  const flushPlain = (end: number): void => {
    if (end > plainStart) tokens.push({ kind: 'plain', text: text.slice(plainStart, end) });
  };

  while (index < text.length) {
    const char = text.charAt(index);

    if (comment !== undefined && text.startsWith(comment, index)) {
      flushPlain(index);
      tokens.push({ kind: 'comment', text: text.slice(index) });
      return tokens;
    }

    if (char === '"' || char === "'" || char === '`') {
      const start = index;
      index += 1;
      while (index < text.length) {
        const inner = text.charAt(index);
        if (inner === '\\') {
          index += 2;
          continue;
        }
        index += 1;
        if (inner === char) break;
      }
      flushPlain(start);
      tokens.push({ kind: 'string', text: text.slice(start, index) });
      plainStart = index;
      continue;
    }

    if (char >= '0' && char <= '9') {
      NUMBER_RE.lastIndex = index;
      const match = NUMBER_RE.exec(text);
      if (match && match[0].length > 0) {
        flushPlain(index);
        tokens.push({ kind: 'number', text: match[0] });
        index += match[0].length;
        plainStart = index;
        continue;
      }
    }

    if (keywords && /[A-Za-z_$]/.test(char)) {
      IDENT_RE.lastIndex = index;
      const match = IDENT_RE.exec(text);
      const word = match?.[0] ?? '';
      if (word.length > 0) {
        if (keywords.has(word)) {
          flushPlain(index);
          tokens.push({ kind: 'keyword', text: word });
          index += word.length;
          plainStart = index;
        } else {
          index += word.length;
        }
        continue;
      }
    }

    index += 1;
  }

  flushPlain(text.length);
  return tokens;
}

/**
 * Project instructions as a chain (global → project → nested), not first-only.
 *
 * The engine used to read the first of JUNO.md / AGENTS.md / CLAUDE.md in the
 * working directory and stop. A repository commonly has AGENTS.md at its root,
 * a CLAUDE.md beside it and another AGENTS.md in the package being worked on,
 * and a person keeps their own standing preferences in their Alevr home. All
 * of them apply; the more specific one is read last so it can refine the more
 * general one.
 *
 * Order: the global files (`$JUNO_HOME`), then each directory from the
 * repository root down to the working directory, and in each directory
 * JUNO.md, AGENTS.md, CLAUDE.md. Identical files (a CLAUDE.md that is a
 * symlink to AGENTS.md) are included once. Deterministic, so the system prompt
 * stays byte-stable while nobody edits the files.
 */

import fs from 'node:fs';
import path from 'node:path';

export const INSTRUCTION_FILE_NAMES = ['JUNO.md', 'AGENTS.md', 'CLAUDE.md'] as const;
const PER_FILE_CHARS = 20_000;
const TOTAL_CHARS = 48_000;

export interface InstructionFile {
  scope: 'global' | 'project' | 'nested';
  path: string;
  text: string;
}

/** The repository root containing `cwd` (a `.git` file or folder), or `cwd`. */
export function projectRootOf(cwd: string): string {
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(cwd);
    dir = parent;
  }
}

function readIfFile(file: string): string | null {
  try {
    if (!fs.statSync(file).isFile()) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export function loadInstructionChain(cwd: string, globalDir?: string | null): InstructionFile[] {
  const files: InstructionFile[] = [];
  const seen = new Set<string>();
  const add = (scope: InstructionFile['scope'], file: string) => {
    const text = readIfFile(file);
    if (text === null || !text.trim()) return;
    let identity: string;
    try {
      identity = fs.realpathSync(file);
    } catch {
      identity = file;
    }
    const contentKey = `content:${text.trim()}`;
    if (seen.has(identity) || seen.has(contentKey)) return;
    seen.add(identity);
    seen.add(contentKey);
    files.push({ scope, path: file, text: text.slice(0, PER_FILE_CHARS) });
  };

  if (globalDir) {
    for (const name of INSTRUCTION_FILE_NAMES) add('global', path.join(globalDir, name));
  }
  const root = projectRootOf(cwd);
  const target = path.resolve(cwd);
  const chain: string[] = [root];
  const relative = path.relative(root, target);
  if (relative && !relative.startsWith('..')) {
    let dir = root;
    for (const segment of relative.split(path.sep)) {
      dir = path.join(dir, segment);
      chain.push(dir);
    }
  }
  chain.forEach((dir, index) => {
    for (const name of INSTRUCTION_FILE_NAMES) add(index === 0 ? 'project' : 'nested', path.join(dir, name));
  });
  return files;
}

/** The prompt section for the chain; empty when there are no files. */
export function renderInstructionChain(files: readonly InstructionFile[], cwd: string): string {
  if (files.length === 0) return '';
  let budget = TOTAL_CHARS;
  const sections: string[] = [];
  for (const file of files) {
    if (budget <= 0) break;
    const label =
      file.scope === 'global' ? `your global instructions (${path.basename(file.path)})` : path.relative(cwd, file.path) || path.basename(file.path);
    const text = file.text.slice(0, budget);
    budget -= text.length;
    sections.push(`## ${label}\n${text}`);
  }
  return `\n\n# Project memory\nInstructions from these files apply in order; a later, more specific file refines an earlier one.\n\n${sections.join('\n\n')}`;
}

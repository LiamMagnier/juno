/**
 * Tool taxonomy — the thing that lets the timeline group instead of list.
 *
 * The names are the real ones registered in `runner/agent-core/src/tools`:
 * `read_file`, `write_file`, `edit_file`, `glob`, `grep`, `bash`, plus the
 * delegation tools from `subagents.ts`. Unknown names degrade to `other` and
 * still render with their raw name — a new tool must never vanish from the
 * transcript because this table has not caught up.
 *
 * `bash` is sub-classified from the command string, because "ran 4 commands"
 * is a far worse answer to "what did this agent do?" than "ran the test suite,
 * then committed". That classification is presentation only; it never feeds a
 * permission decision.
 */

export type ToolCategory =
  | 'read'
  | 'search'
  | 'edit'
  | 'shell'
  | 'test'
  | 'git'
  | 'build'
  | 'delegate'
  | 'other';

export interface ToolDescriptor {
  category: ToolCategory;
  /** Verb for a single call, e.g. "Read". */
  verb: string;
  /** Plural headline builder for a collapsed group, e.g. "Read 12 files". */
  groupLabel: (count: number) => string;
  /**
   * Groups of this category collapse once they exceed this many calls.
   * Low-value noise (reads, searches) collapses early; edits and commands are
   * the answer to "what did it do", so they stay open far longer.
   */
  collapseAfter: number;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

const DESCRIPTORS: Record<ToolCategory, ToolDescriptor> = {
  read: {
    category: 'read',
    verb: 'Read',
    groupLabel: (n) => `Read ${plural(n, 'file', 'files')}`,
    collapseAfter: 2,
  },
  search: {
    category: 'search',
    verb: 'Searched',
    groupLabel: (n) => `Searched ${plural(n, 'pattern', 'patterns')}`,
    collapseAfter: 2,
  },
  edit: {
    category: 'edit',
    verb: 'Edited',
    groupLabel: (n) => `Edited ${plural(n, 'file', 'files')}`,
    collapseAfter: 8,
  },
  shell: {
    category: 'shell',
    verb: 'Ran',
    groupLabel: (n) => `Ran ${plural(n, 'command', 'commands')}`,
    collapseAfter: 5,
  },
  test: {
    category: 'test',
    verb: 'Tested',
    groupLabel: (n) => (n === 1 ? 'Ran tests' : `Ran tests ${n}×`),
    collapseAfter: 4,
  },
  git: {
    category: 'git',
    verb: 'Git',
    groupLabel: (n) => `${plural(n, 'git operation', 'git operations')}`,
    collapseAfter: 4,
  },
  build: {
    category: 'build',
    verb: 'Built',
    groupLabel: (n) => `Build ${plural(n, 'step', 'steps')}`,
    collapseAfter: 4,
  },
  delegate: {
    category: 'delegate',
    verb: 'Delegated',
    groupLabel: (n) => `Delegation ${plural(n, 'call', 'calls')}`,
    collapseAfter: 3,
  },
  other: {
    category: 'other',
    verb: 'Called',
    groupLabel: (n) => `${plural(n, 'tool call', 'tool calls')}`,
    collapseAfter: 4,
  },
};

export function describeCategory(category: ToolCategory): ToolDescriptor {
  return DESCRIPTORS[category];
}

const TEST_RE = /\b(vitest|jest|pytest|mocha|ava|phpunit|rspec|(npm|pnpm|yarn|bun)\s+(run\s+)?test|cargo\s+test|go\s+test|swift\s+test|dotnet\s+test|tsc\s+--noEmit|typecheck)\b/;
const BUILD_RE = /\b((npm|pnpm|yarn|bun)\s+(run\s+)?(build|lint|format)|make\b|cargo\s+build|go\s+build|xcodebuild|webpack|vite\s+build|tsc\s+-b)\b/;
const GIT_RE = /^\s*git\b|\bgit\s+(status|diff|add|commit|log|checkout|switch|branch|stash|worktree|push|pull|rebase|merge|show)\b/;

function classifyCommand(command: string): ToolCategory {
  if (GIT_RE.test(command)) return 'git';
  if (TEST_RE.test(command)) return 'test';
  if (BUILD_RE.test(command)) return 'build';
  return 'shell';
}

/** Read a string field out of an unvalidated tool input. */
export function inputString(input: unknown, key: string): string | null {
  if (typeof input !== 'object' || input === null) return null;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

export function inputNumber(input: unknown, key: string): number | null {
  if (typeof input !== 'object' || input === null) return null;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function inputBoolean(input: unknown, key: string): boolean {
  if (typeof input !== 'object' || input === null) return false;
  return (input as Record<string, unknown>)[key] === true;
}

export function categorize(toolName: string, input: unknown): ToolCategory {
  switch (toolName) {
    case 'read_file':
      return 'read';
    case 'glob':
    case 'grep':
      return 'search';
    case 'edit_file':
    case 'write_file':
      return 'edit';
    case 'bash':
      return classifyCommand(inputString(input, 'command') ?? '');
    case 'delegate_tasks':
    case 'await_subagents':
    case 'inspect_subagent':
    case 'cancel_subagent':
      return 'delegate';
    default:
      return 'other';
  }
}

/**
 * The one line that identifies a call in a dense timeline row. Mirrors the
 * `summarize` functions in agent-core's tool definitions, so the transcript
 * reads the same way the host logs it.
 */
export function summarizeCall(toolName: string, input: unknown): string {
  switch (toolName) {
    case 'read_file': {
      const path = inputString(input, 'path') ?? 'file';
      const offset = inputNumber(input, 'offset');
      const limit = inputNumber(input, 'limit');
      if (offset !== null && limit !== null) return `${path}:${offset}–${offset + limit}`;
      return path;
    }
    case 'write_file':
      return inputString(input, 'path') ?? 'file';
    case 'edit_file':
      return inputString(input, 'path') ?? 'file';
    case 'glob':
      return inputString(input, 'pattern') ?? 'pattern';
    case 'grep': {
      const pattern = inputString(input, 'pattern') ?? 'pattern';
      const glob = inputString(input, 'glob');
      return glob ? `${pattern}  in ${glob}` : pattern;
    }
    case 'bash':
      return inputString(input, 'command') ?? 'command';
    case 'delegate_tasks':
      return 'Delegate tasks to subagents';
    case 'await_subagents':
      return 'Wait for subagents';
    case 'inspect_subagent':
      return `Inspect ${inputString(input, 'id') ?? 'subagent'}`;
    case 'cancel_subagent':
      return `Cancel ${inputString(input, 'id') ?? 'subagent'}`;
    default:
      return toolName;
  }
}

/**
 * The concrete thing being touched — a path, a pattern, a command. Rendered in
 * mono next to the verb, and used by the approval card as "the target".
 */
export function targetOf(toolName: string, input: unknown): string | null {
  switch (toolName) {
    case 'read_file':
    case 'write_file':
    case 'edit_file':
      return inputString(input, 'path');
    case 'glob':
      return inputString(input, 'pattern');
    case 'grep':
      return inputString(input, 'glob') ?? inputString(input, 'pattern');
    case 'bash':
      return inputString(input, 'command');
    default:
      return null;
  }
}

/**
 * What granting this specific call actually lets happen, in plain language.
 * Deliberately concrete: "Allow command?" tells a user nothing, and a user who
 * cannot tell what they are agreeing to will start agreeing to everything.
 */
export function impactOf(toolName: string, input: unknown): string[] {
  switch (toolName) {
    case 'write_file': {
      const path = inputString(input, 'path') ?? 'the target file';
      const content = inputString(input, 'content');
      const size = content === null ? null : content.length;
      return [
        `Creates or overwrites ${path}.`,
        size === null
          ? 'Existing contents are replaced.'
          : `Existing contents are replaced with ${size.toLocaleString()} characters.`,
      ];
    }
    case 'edit_file': {
      const path = inputString(input, 'path') ?? 'the target file';
      const all = inputBoolean(input, 'replace_all');
      return [
        `Replaces text in ${path}${all ? ', at every occurrence' : ', at one occurrence'}.`,
        'The file is written in place; there is no staging step.',
      ];
    }
    case 'bash': {
      const command = inputString(input, 'command') ?? '';
      const impacts = ['Runs in the workspace directory as your user, with your environment.'];
      if (/\|\s*(ba)?sh\b/.test(command)) impacts.push('Pipes fetched content into a shell.');
      if (/\bgit\s+push\b/.test(command)) impacts.push('Publishes commits to a remote.');
      if (/\brm\b/.test(command)) impacts.push('Deletes files.');
      if (/>\s*[^\s|]/.test(command)) impacts.push('Redirects output over a file.');
      return impacts;
    }
    case 'delegate_tasks':
      return ['Starts one or more subagents, each with its own tool budget.'];
    default:
      return [];
  }
}

/** Split an absolute path into a dimmed directory and an emphasised basename. */
export function splitPath(path: string): { dir: string; base: string } {
  const index = path.lastIndexOf('/');
  if (index < 0) return { dir: '', base: path };
  return { dir: path.slice(0, index + 1), base: path.slice(index + 1) };
}

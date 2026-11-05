/**
 * todo_write: the agent's live plan for a multi-step task (Claude Code's
 * TodoWrite, Codex's update_plan). Each call replaces the whole list; the
 * latest call in the conversation is the plan. Surfaces render it as a
 * `todo_list` turn item, and the web pins the newest one above the composer.
 *
 * It reads and writes nothing in the workspace, so it is a `read` tool: it is
 * offered in every mode, Plan included, and never asks.
 */
import type { ToolDefinition } from './types.js';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';
export interface TodoEntry {
  content: string;
  status: TodoStatus;
}

export const TODO_MAX = 30;
const STATUSES = new Set<TodoStatus>(['pending', 'in_progress', 'completed']);

/** The list a call carries, or a reason it is not one. */
export function parseTodos(input: Record<string, unknown>): TodoEntry[] | string {
  const raw = input.todos;
  if (!Array.isArray(raw)) return "todo_write needs a 'todos' array.";
  if (raw.length > TODO_MAX) return `At most ${TODO_MAX} items; group smaller steps.`;
  const todos: TodoEntry[] = [];
  for (const [index, item] of raw.entries()) {
    const entry = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const content = String(entry.content ?? entry.text ?? '').trim().replace(/\s+/g, ' ').slice(0, 300);
    const status = String(entry.status ?? 'pending') as TodoStatus;
    if (!content) return `Item ${index + 1} has no content.`;
    if (!STATUSES.has(status)) return `Item ${index + 1} has an unknown status '${status}' (pending, in_progress, completed).`;
    todos.push({ content, status });
  }
  if (todos.filter((t) => t.status === 'in_progress').length > 1) {
    return 'Keep exactly one item in_progress at a time.';
  }
  return todos;
}

const MARK: Record<TodoStatus, string> = { pending: '[ ]', in_progress: '[~]', completed: '[x]' };

export const todoWriteTool: ToolDefinition = {
  kind: 'read',
  spec: {
    name: 'todo_write',
    description:
      'Keep a short live plan for a task with three or more steps, and show the user your progress. Send the WHOLE list each time (it replaces the previous one). Mark one item in_progress before you start it and completed as soon as it is done; add items you discover. Skip it for one-step tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'The step, as an imperative ("Add the migration").' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
  },
  summarize(input) {
    const todos = parseTodos(input);
    if (typeof todos === 'string') return 'Update the plan';
    return `Update the plan (${todos.filter((t) => t.status === 'completed').length}/${todos.length} done)`;
  },
  async execute(input) {
    const todos = parseTodos(input);
    if (typeof todos === 'string') return { output: todos, isError: true };
    const done = todos.filter((t) => t.status === 'completed').length;
    const lines = todos.map((t) => `${MARK[t.status]} ${t.content}`);
    return { output: `Plan updated: ${done} of ${todos.length} done.\n${lines.join('\n')}` };
  },
};

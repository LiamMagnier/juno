/** todo_write: the live plan, its validation, and the todo_list turn item it projects to. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTodos, todoWriteTool } from '../tools/todo.js';
import { TurnItemProjector } from '../harness/turn-items.js';

test('parseTodos validates content, status and a single in_progress', () => {
  assert.deepEqual(parseTodos({ todos: [{ content: ' Add  the route ', status: 'in_progress' }, { content: 'Test it', status: 'pending' }] }), [
    { content: 'Add the route', status: 'in_progress' },
    { content: 'Test it', status: 'pending' },
  ]);
  assert.match(String(parseTodos({})), /needs a 'todos' array/);
  assert.match(String(parseTodos({ todos: [{ content: '', status: 'pending' }] })), /no content/);
  assert.match(String(parseTodos({ todos: [{ content: 'a', status: 'done' }] })), /unknown status/);
  assert.match(String(parseTodos({ todos: [{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'in_progress' }] })), /exactly one/);
});

test('todo_write echoes the plan and is a read tool that never asks', async () => {
  assert.equal(todoWriteTool.kind, 'read');
  const result = await todoWriteTool.execute(
    { todos: [{ content: 'Read the code', status: 'completed' }, { content: 'Fix it', status: 'in_progress' }, { content: 'Run tests', status: 'pending' }] },
    { cwd: '/' },
  );
  assert.equal(result.output, 'Plan updated: 1 of 3 done.\n[x] Read the code\n[~] Fix it\n[ ] Run tests');
  assert.equal((await todoWriteTool.execute({ todos: 'x' }, { cwd: '/' })).isError, true);
});

test('the projector turns todo_write into a todo_list item', () => {
  const projector = new TurnItemProjector(() => '2026-11-05T00:00:00.000Z');
  projector.project({ type: 'turn_started', turnIndex: 0 } as never);
  const ops = projector.project({
    type: 'tool_started',
    callId: 'c1',
    name: 'todo_write',
    input: { todos: [{ content: 'Fix it', status: 'in_progress' }] },
    risk: 'safe',
  } as never);
  assert.equal(ops.length, 1);
  const item = ops[0]!.op === 'added' ? ops[0]!.item : null;
  assert.ok(item && item.kind === 'todo_list');
  assert.deepEqual(item.todos, [{ text: 'Fix it', status: 'in_progress' }]);
});

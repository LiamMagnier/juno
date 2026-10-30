import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_NOTE_TOOL_NAME, agentNoteTool } from '../work/tools.js';

/*
 * `remember`: a Work run saving one fact for its agent. Everything that
 * matters (review, secrets, the per-run cap) is decided by the executor's
 * `save`; these pin the shape the model sees and that the result is said back
 * honestly, pending or kept.
 */

const ctx = { cwd: '/tmp', signal: new AbortController().signal } as never;

test('remember is a safe, structured, trusted write of the agent own notes', () => {
  const tool = agentNoteTool({ agentName: 'Mira', save: async () => ({ ok: true, pending: true, detail: 'x' }) });
  assert.equal(tool.spec.name, AGENT_NOTE_TOOL_NAME);
  assert.equal(tool.spec.name, 'remember');
  assert.equal(tool.tier, 'structured_file');
  assert.equal(tool.riskFor({ note: 'anything' }), 'safe');
  assert.equal(tool.actionFor({}), 'work.agent_note.write');
  assert.ok(tool.intents.includes(tool.intentFor({})));
  assert.deepEqual(tool.provenanceFor({}), {
    source: "Mira's notes",
    sourceKind: 'model',
    action: 'work.agent_note.write',
    trust: 'trusted',
  });
  assert.deepEqual((tool.spec.inputSchema as { required: string[] }).required, ['note']);
  assert.match(tool.spec.description, /Never a password, code, key, token or login/);
  assert.match(tool.spec.description, /The person reviews it, and later tasks and chats see it only once they keep it/);
  const note = (tool.spec.inputSchema as { properties: { note: { description: string } } }).properties.note;
  assert.match(note.description, /at most 500 characters/, 'the default bound');
  const bounded = agentNoteTool({ agentName: 'Mira', maxChars: 300, save: async () => ({ ok: true, pending: true, detail: 'x' }) });
  const boundedNote = (bounded.spec.inputSchema as { properties: { note: { description: string } } }).properties.note;
  assert.match(boundedNote.description, /at most 300 characters/, 'the executor’s bound, from env');
});

test('remember passes the note to save and says the result back', async () => {
  const saved: string[] = [];
  const tool = agentNoteTool({
    agentName: 'Mira',
    save: async (text) => {
      saved.push(text);
      return { ok: true, pending: true, detail: 'Saved for review.' };
    },
  });
  const result = await tool.execute({ note: 'Invoices go out on the 3rd.' }, ctx);
  assert.deepEqual(saved, ['Invoices go out on the 3rd.']);
  assert.equal(result.output, 'Saved for review.');
  assert.ok(!result.isError);
});

test('remember refuses an empty note without calling save, and reports a refusal as an error', async () => {
  let calls = 0;
  const tool = agentNoteTool({
    agentName: 'Mira',
    save: async () => {
      calls += 1;
      return { ok: false, message: 'Notes never keep secrets.' };
    },
  });
  const empty = await tool.execute({ note: '   ' }, ctx);
  assert.equal(empty.isError, true);
  assert.equal(calls, 0);
  const refused = await tool.execute({ note: 'password: hunter2' }, ctx);
  assert.equal(refused.isError, true);
  assert.equal(refused.output, 'Notes never keep secrets.');
});

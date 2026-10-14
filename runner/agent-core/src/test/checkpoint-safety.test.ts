import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CheckpointStore } from '../checkpoints.js';

function setup() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'alevr-cp-')));
  const work = path.join(root, 'work');
  fs.mkdirSync(work);
  return { store: new CheckpointStore(path.join(root, 'session')), work, root };
}

/** What executeToolCall does around a write: snapshot, write, record. */
function agentWrites(store: CheckpointStore, turn: number, file: string, content: string) {
  store.snapshot(turn, file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  store.recordWritten(file);
}

test('undo and revert leave a file alone that changed after the agent wrote it', () => {
  const { store, work } = setup();
  const a = path.join(work, 'a.ts');
  const b = path.join(work, 'b.ts');
  fs.writeFileSync(a, 'original a\n');
  fs.writeFileSync(b, 'original b\n');
  agentWrites(store, 3, a, 'agent a\n');
  agentWrites(store, 3, b, 'agent b\n');
  // The person (or a formatter, or a later bash) edits a.ts after the agent.
  fs.writeFileSync(a, 'agent a\nperson added this\n');

  assert.equal(store.revertFile(a), 'changed');
  assert.equal(fs.readFileSync(a, 'utf8'), 'agent a\nperson added this\n', 'their change survives');

  const result = store.rollbackToBefore(3);
  assert.deepEqual(result.skipped, [a]);
  assert.deepEqual(result.restored, [b]);
  assert.equal(fs.readFileSync(a, 'utf8'), 'agent a\nperson added this\n');
  assert.equal(fs.readFileSync(b, 'utf8'), 'original b\n', 'an untouched file is still undone');
});

test('a file the agent created is removed by undo only while it still holds what the agent wrote', () => {
  const { store, work } = setup();
  const created = path.join(work, 'new.ts');
  agentWrites(store, 1, created, 'agent file\n');
  assert.equal(store.revertFile(created), 'deleted');
  assert.equal(fs.existsSync(created), false);

  agentWrites(store, 2, created, 'agent file\n');
  fs.appendFileSync(created, 'person kept working here\n');
  assert.deepEqual(store.rollbackToBefore(2), { restored: [], skipped: [created] });
  assert.equal(fs.existsSync(created), true, 'not deleted with their work in it');
});

test('snapshots of same-named files never overwrite each other after a keep', () => {
  const { store, work } = setup();
  const first = path.join(work, 'a', 'x.ts');
  const second = path.join(work, 'b', 'y.ts');
  const third = path.join(work, 'c', 'y.ts');
  for (const [file, text] of [[first, 'x0'], [second, 'b-y0'], [third, 'c-y0']] as const) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  agentWrites(store, 1, first, 'x1');
  agentWrites(store, 1, second, 'b-y1');
  assert.equal(store.keepFile(first), true);
  agentWrites(store, 1, third, 'c-y1');
  assert.equal(store.revertFile(second), 'restored');
  assert.equal(fs.readFileSync(second, 'utf8'), 'b-y0', "b/y.ts gets its own snapshot back, not c/y.ts's");
  assert.equal(store.revertFile(third), 'restored');
  assert.equal(fs.readFileSync(third, 'utf8'), 'c-y0');
});

test('a damaged checkpoint index does not stop the session from opening', () => {
  const { root } = setup();
  const dir = path.join(root, 'damaged', 'checkpoints');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.json'), '[{"turnIndex": 1, "files": {');
  const store = new CheckpointStore(path.join(root, 'damaged'));
  assert.deepEqual(store.turnsWithChanges(), []);
});

/**
 * `computer_files` at the definition level (work/computer-tools.ts;
 * docs/design/agents-v2/COMPUTERS_2026-10.md S5.2 and S5.3): bytes in and
 * out (base64), a utf8 read of a binary file described rather than decoded,
 * and `publish`, which is a deliverable (the risk and action of
 * `create_deliverable`) and not a read.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { computerTools, decodeTextFile, formatFileBytes, type ComputerShotData, type ComputerToolsDeps } from '../work/index.js';
import type { WorkToolDefinition } from '../work/types.js';

const SHOT: ComputerShotData = { mediaType: 'image/jpeg', data: '', width: 1, height: 1 };

function filesTool(extra: Partial<ComputerToolsDeps>, disk = new Map<string, Uint8Array>()): WorkToolDefinition {
  const deps: ComputerToolsDeps = {
    isHealthy: () => true,
    pageTakesPayment: () => false,
    currentUrl: () => '',
    screenEpoch: () => 0,
    screenshot: async () => SHOT,
    click: async () => SHOT,
    type: async () => SHOT,
    key: async () => SHOT,
    scroll: async () => SHOT,
    exec: async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false }),
    listFiles: async () => [],
    readFile: async (path, maxBytes) => (disk.get(path) ?? new Uint8Array()).subarray(0, maxBytes),
    writeFile: async (path, bytes) => void disk.set(path, bytes),
    settle: false,
    ...extra,
  };
  return computerTools(deps).find((tool) => tool.spec.name === 'computer_files')!;
}

test('decodeTextFile: text is text, binary is null, and a cut character is not held against a cut read', () => {
  assert.equal(decodeTextFile(new TextEncoder().encode('héllo'), false), 'héllo');
  assert.equal(decodeTextFile(Uint8Array.from([0x68, 0x00, 0x69]), false), null, 'a NUL');
  assert.equal(decodeTextFile(Uint8Array.from([0xff, 0xfe, 0x41]), false), null, 'invalid UTF-8');
  const euro = new TextEncoder().encode('ab€');
  assert.equal(decodeTextFile(euro.subarray(0, 4), true), 'ab', 'cut inside the euro sign: the whole part is text');
  assert.equal(decodeTextFile(euro.subarray(0, 4), false), null, 'the same bytes, not cut, are not valid');
  assert.equal(formatFileBytes(512), '512 bytes');
  assert.equal(formatFileBytes(88 * 1024), '88 KB');
  assert.equal(formatFileBytes(1.4 * 1024 * 1024), '1.4 MB');
});

test('base64 writes and reads carry every byte value unchanged', async () => {
  const disk = new Map<string, Uint8Array>();
  const tool = filesTool({}, disk);
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);
  const wrote = await tool.execute({ action: 'write', path: '/home/agent/work/all.bin', encoding: 'base64', content: Buffer.from(all).toString('base64') }, { cwd: '/' });
  assert.equal(wrote.output, 'Wrote 256 bytes to /home/agent/work/all.bin.');
  assert.deepEqual(Buffer.from(disk.get('/home/agent/work/all.bin')!), Buffer.from(all));
  const read = await tool.execute({ action: 'read', path: '/home/agent/work/all.bin', encoding: 'base64' }, { cwd: '/' });
  assert.deepEqual(Buffer.from(read.output, 'base64'), Buffer.from(all));
  const asText = await tool.execute({ action: 'read', path: '/home/agent/work/all.bin' }, { cwd: '/' });
  const digest = createHash('sha256').update(all).digest('hex').slice(0, 12);
  assert.equal(asText.output, `/home/agent/work/all.bin is a binary file (256 bytes, sha256 ${digest}). Read it with encoding base64, or publish it.`);
});

test('publish is a deliverable: its own intent, the action and risk of create_deliverable, and only with a publisher', async () => {
  const requests: Array<{ path: string; title?: string }> = [];
  const tool = filesTool({
    publish: async (request) => {
      requests.push(request);
      return { ok: true, detail: 'Published /home/agent/work/primes.csv as "Primes".' };
    },
  });
  const input = { action: 'publish', path: '/home/agent/work/primes.csv', title: 'Primes' };
  assert.equal(tool.intentFor!(input), 'files.publish');
  assert.ok(tool.intents.includes('files.publish'));
  assert.equal(tool.actionFor!(input), 'work.deliverable.create');
  assert.equal(tool.riskFor!(input), 'edit');
  assert.equal(tool.actionFor!({ action: 'read', path: 'x' }), 'work.computer.files');
  assert.equal(tool.riskFor!({ action: 'read', path: 'x' }), 'safe');
  assert.equal(tool.summarize(input), 'Publish /home/agent/work/primes.csv to the person as a deliverable');
  const result = await tool.execute(input, { cwd: '/' });
  assert.equal(result.output, 'Published /home/agent/work/primes.csv as "Primes".');
  assert.deepEqual(requests, [{ path: '/home/agent/work/primes.csv', title: 'Primes' }]);

  const refused = await filesTool({ publish: async () => ({ ok: false, message: 'Too large. Nothing was published.' }) }).execute(input, { cwd: '/' });
  assert.deepEqual(refused, { output: 'Too large. Nothing was published.', isError: true });

  const without = await filesTool({}).execute(input, { cwd: '/' });
  assert.equal(without.isError, true);
  assert.match(without.output, /not available/);
});

test('an unknown action is refused, never read as a list', async () => {
  const result = await filesTool({}).execute({ action: 'delete', path: '/home/agent/work/a' }, { cwd: '/' });
  assert.deepEqual(result, { output: 'Unknown action: delete', isError: true });
});

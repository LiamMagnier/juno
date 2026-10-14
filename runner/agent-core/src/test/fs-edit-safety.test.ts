import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { editFileTool, writeFileAtomic } from '../tools/fs.js';

function workspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'alevr-edit-'));
}

test('edit_file writes new_string literally, $ sequences included', async () => {
  const cwd = workspace();
  fs.writeFileSync(path.join(cwd, 'a.js'), 'const pick = TODO;\n');
  for (const literal of ["$$('a')", '$&', '$`', "$'", '$1']) {
    fs.writeFileSync(path.join(cwd, 'a.js'), 'const pick = TODO;\n');
    const result = await editFileTool.execute({ path: 'a.js', old_string: 'TODO', new_string: literal }, { cwd });
    assert.ok(!result.isError, result.output);
    assert.equal(fs.readFileSync(path.join(cwd, 'a.js'), 'utf8'), `const pick = ${literal};\n`, literal);
  }
});

test('edit_file refuses an empty old_string instead of interleaving the file', async () => {
  const cwd = workspace();
  fs.writeFileSync(path.join(cwd, 'b.txt'), 'abc');
  const result = await editFileTool.execute({ path: 'b.txt', old_string: '', new_string: 'X', replace_all: true }, { cwd });
  assert.equal(result.isError, true);
  assert.equal(fs.readFileSync(path.join(cwd, 'b.txt'), 'utf8'), 'abc');
});

test('edit_file refuses a file that is not UTF-8 rather than corrupting its bytes', async () => {
  const cwd = workspace();
  const latin1 = Buffer.from('caf\xe9 = 1\n', 'latin1');
  fs.writeFileSync(path.join(cwd, 'c.txt'), latin1);
  const result = await editFileTool.execute({ path: 'c.txt', old_string: '1', new_string: '2' }, { cwd });
  assert.equal(result.isError, true);
  assert.match(result.output, /not UTF-8/);
  assert.ok(fs.readFileSync(path.join(cwd, 'c.txt')).equals(latin1), 'bytes untouched');
  // UTF-8 with a BOM and CRLF line endings is edited and kept as it was.
  const crlf = '﻿one\r\ntwo\r\n';
  fs.writeFileSync(path.join(cwd, 'd.txt'), crlf, 'utf8');
  assert.ok(!(await editFileTool.execute({ path: 'd.txt', old_string: 'two', new_string: 'three' }, { cwd })).isError);
  assert.equal(fs.readFileSync(path.join(cwd, 'd.txt'), 'utf8'), '﻿one\r\nthree\r\n');
});

test('atomic writes keep the file mode and leave no temp files behind', () => {
  const cwd = workspace();
  const file = path.join(cwd, 'run.sh');
  fs.writeFileSync(file, '#!/bin/sh\necho old\n', { mode: 0o755 });
  writeFileAtomic(file, '#!/bin/sh\necho new\n');
  assert.equal(fs.statSync(file).mode & 0o777, 0o755);
  assert.equal(fs.readFileSync(file, 'utf8'), '#!/bin/sh\necho new\n');
  assert.deepEqual(fs.readdirSync(cwd), ['run.sh']);
  // A write that fails (the target is a directory) leaves nothing behind either.
  fs.mkdirSync(path.join(cwd, 'dir'));
  assert.throws(() => writeFileAtomic(path.join(cwd, 'dir'), 'x'));
  assert.deepEqual(fs.readdirSync(cwd).sort(), ['dir', 'run.sh']);
});

test('bash keeps the end of long output, where the error is', async () => {
  const { bashTool } = await import('../tools/bash.js');
  const cwd = workspace();
  const result = await bashTool.execute(
    { command: "seq -f 'line %g' 0 19999; echo 'FATAL: the real error' >&2; exit 3" },
    { cwd },
  );
  assert.equal(result.isError, true);
  assert.match(result.output, /line 0\n/, 'the start is kept');
  assert.match(result.output, /FATAL: the real error/, 'and so is the end');
  assert.match(result.output, /chars of output omitted/);
  assert.match(result.output, /\[exit code 3\]$/);
  assert.ok(result.output.length < 31_000);
});

test('a partial read lets edit_file through but not a write_file that would drop the unseen rest', async () => {
  const { FileStateGuard } = await import('../harness/guards.js');
  const cwd = workspace();
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
  fs.writeFileSync(path.join(cwd, 'big.txt'), lines);
  const guard = new FileStateGuard(cwd);
  guard.record('read_file', { path: 'big.txt', offset: 1, limit: 10 }, false);
  assert.match(guard.check('write_file', { path: 'big.txt' }) ?? '', /read only part/);
  assert.equal(guard.check('edit_file', { path: 'big.txt' }), null);
  // A whole read clears it.
  guard.record('read_file', { path: 'big.txt' }, false);
  assert.equal(guard.check('write_file', { path: 'big.txt' }), null);
  // A window that covers the whole file is a whole read.
  const fresh = new FileStateGuard(cwd);
  fresh.record('read_file', { path: 'big.txt', offset: 1, limit: 500 }, false);
  assert.equal(fresh.check('write_file', { path: 'big.txt' }), null);
  // Past read_file's 50k-character cap the read is partial too.
  fs.writeFileSync(path.join(cwd, 'huge.txt'), 'x'.repeat(60_000));
  fresh.record('read_file', { path: 'huge.txt' }, false);
  assert.match(fresh.check('write_file', { path: 'huge.txt' }) ?? '', /read only part/);
});

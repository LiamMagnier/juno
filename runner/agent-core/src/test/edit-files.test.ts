import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentSession } from '../agent.js';
import { applyEditFiles, editFilesTestHooks, editFilesTool } from '../tools/edit-files.js';
import { defaultTools } from '../tools/registry.js';
import { FileStateGuard } from '../harness/guards.js';
import { PermissionRuleSet, ruleSubjectFor } from '../permissions.js';
import { PermissionRule } from '../permission-rules.js';
import type { ProviderAdapter, ProviderStreamEvent } from '../providers/types.js';
import type { AgentEvent, ApprovalDecision, ApprovalRequest, PermissionMode } from '../types.js';

function workspace(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'alevr-edit-files-')));
}

function seed(cwd: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
    fs.writeFileSync(path.join(cwd, rel), text);
  }
}

function read(cwd: string, rel: string): string | null {
  try {
    return fs.readFileSync(path.join(cwd, rel), 'utf8');
  } catch {
    return null;
  }
}

/** Every file under `cwd`, with contents: what "nothing changed" is checked against. */
function tree(cwd: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else out[path.relative(cwd, abs)] = fs.readFileSync(abs, 'utf8');
    }
  };
  walk(cwd);
  return out;
}

test('edit_files is registered with the default tools as an edit-class tool', () => {
  const tool = defaultTools().find((t) => t.spec.name === 'edit_files');
  assert.ok(tool, 'registered');
  assert.equal(tool.kind, 'edit');
  assert.deepEqual((tool.spec.inputSchema as { required: string[] }).required, ['operations']);
});

test('a batch edits, creates and deletes across files, in order', async () => {
  const cwd = workspace();
  seed(cwd, { 'a.ts': 'export const a = 1;\n', 'b.ts': 'import { a } from "./a";\nconsole.log(a);\n', 'old.ts': 'gone\n' });
  const result = await editFilesTool.execute(
    {
      operations: [
        { op: 'edit', path: 'a.ts', old_string: 'const a', new_string: 'const alpha' },
        { op: 'edit', path: 'b.ts', old_string: '{ a }', new_string: '{ alpha }' },
        // A later edit to the same file sees the earlier one.
        { op: 'edit', path: 'b.ts', old_string: 'log(a)', new_string: 'log(alpha)' },
        { op: 'create', path: 'lib/new.ts', content: 'export {};\n' },
        { op: 'delete', path: 'old.ts' },
      ],
    },
    { cwd },
  );
  assert.ok(!result.isError, result.output);
  assert.equal(read(cwd, 'a.ts'), 'export const alpha = 1;\n');
  assert.equal(read(cwd, 'b.ts'), 'import { alpha } from "./a";\nconsole.log(alpha);\n');
  assert.equal(read(cwd, 'lib/new.ts'), 'export {};\n');
  assert.equal(read(cwd, 'old.ts'), null);
  assert.match(result.output, /Applied 5 operations to 4 files/);
  assert.match(result.output, /^D old\.ts/m);
  assert.match(result.output, /^A lib\/new\.ts/m);
  // Temp files from the atomic writes are all gone.
  assert.deepEqual(Object.keys(tree(cwd)).sort(), ['a.ts', 'b.ts', 'lib/new.ts']);
});

test('a stale anchor in file 3 of 3 changes no file and names operation 3', async () => {
  const cwd = workspace();
  seed(cwd, { 'one.ts': 'one\n', 'two.ts': 'two\n', 'three.ts': 'three, as it is now\n' });
  const before = tree(cwd);
  const result = await editFilesTool.execute(
    {
      operations: [
        { op: 'edit', path: 'one.ts', old_string: 'one', new_string: 'ONE' },
        { op: 'edit', path: 'two.ts', old_string: 'two', new_string: 'TWO' },
        { op: 'edit', path: 'three.ts', old_string: 'three, as it was', new_string: 'THREE' },
      ],
    },
    { cwd },
  );
  assert.equal(result.isError, true);
  assert.match(result.output, /operation 3 \(edit three\.ts\): old_string not found/);
  assert.match(result.output, /nothing was written/);
  assert.deepEqual(tree(cwd), before);
});

test('an ambiguous anchor, a missing file and a create over a file are refused up front', async () => {
  const cwd = workspace();
  seed(cwd, { 'dup.ts': 'x\nx\n', 'ok.ts': 'ok\n' });
  const before = tree(cwd);
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ op: 'edit', path: 'dup.ts', old_string: 'x', new_string: 'y' }, /matches 2 times/],
    [{ op: 'edit', path: 'missing.ts', old_string: 'x', new_string: 'y' }, /file not found/],
    [{ op: 'create', path: 'ok.ts', content: 'clobber' }, /already exists/],
    [{ op: 'delete', path: 'missing.ts' }, /file not found/],
    [{ op: 'rename', path: 'ok.ts' }, /op must be/],
  ];
  for (const [bad, why] of cases) {
    const result = applyEditFiles({ operations: [{ op: 'edit', path: 'ok.ts', old_string: 'ok', new_string: 'OK' }, bad] }, { cwd });
    assert.equal(result.isError, true, JSON.stringify(bad));
    assert.match(result.output, why);
    assert.match(result.output, /operation 2/);
    assert.deepEqual(tree(cwd), before, 'nothing written for ' + JSON.stringify(bad));
  }
  // replace_all makes the duplicate anchor legal.
  const all = applyEditFiles({ operations: [{ op: 'edit', path: 'dup.ts', old_string: 'x', new_string: 'y', replace_all: true }] }, { cwd });
  assert.ok(!all.isError, all.output);
  assert.equal(read(cwd, 'dup.ts'), 'y\ny\n');
});

test('a write that fails mid-commit rolls back every file already written', async () => {
  const cwd = workspace();
  seed(cwd, { 'a.ts': 'a0\n', 'b.ts': 'b0\n', 'c.ts': 'c0\n' });
  fs.chmodSync(path.join(cwd, 'a.ts'), 0o755);
  const before = tree(cwd);
  editFilesTestHooks.beforeWrite = (abs) => {
    if (abs.endsWith('c.ts')) throw new Error('disk full');
  };
  try {
    const result = await editFilesTool.execute(
      {
        operations: [
          { op: 'edit', path: 'a.ts', old_string: 'a0', new_string: 'a1' },
          { op: 'create', path: 'deep/nested/new.ts', content: 'new\n' },
          { op: 'delete', path: 'b.ts' },
          { op: 'edit', path: 'c.ts', old_string: 'c0', new_string: 'c1' },
        ],
      },
      { cwd },
    );
    assert.equal(result.isError, true);
    assert.match(result.output, /writing c\.ts failed: disk full/);
    assert.match(result.output, /3 files already written were restored; no file was changed/);
  } finally {
    delete editFilesTestHooks.beforeWrite;
  }
  assert.deepEqual(tree(cwd), before, 'every file is back, the deleted one included');
  assert.equal(fs.existsSync(path.join(cwd, 'deep')), false, 'directories the batch created are removed');
  assert.equal(fs.statSync(path.join(cwd, 'a.ts')).mode & 0o777, 0o755, 'mode kept');
});

test('a file changed between staging and its write aborts and rolls back', async () => {
  const cwd = workspace();
  seed(cwd, { 'a.ts': 'a0\n', 'b.ts': 'b0\n' });
  editFilesTestHooks.beforeWrite = (abs) => {
    // Something else edits b.ts while a.ts is being written.
    if (abs.endsWith('a.ts')) fs.writeFileSync(path.join(cwd, 'b.ts'), 'someone else\n');
  };
  try {
    const result = applyEditFiles(
      {
        operations: [
          { op: 'edit', path: 'a.ts', old_string: 'a0', new_string: 'a1' },
          { op: 'edit', path: 'b.ts', old_string: 'b0', new_string: 'b1' },
        ],
      },
      { cwd },
    );
    assert.equal(result.isError, true);
    assert.match(result.output, /b\.ts changed on disk/);
  } finally {
    delete editFilesTestHooks.beforeWrite;
  }
  assert.equal(read(cwd, 'a.ts'), 'a0\n', 'a.ts rolled back');
  assert.equal(read(cwd, 'b.ts'), 'someone else\n', 'their change is kept');
});

test('paths outside the workspace are refused, through ../, absolute paths and symlinks', async () => {
  const cwd = workspace();
  const outside = workspace();
  seed(cwd, { 'in.ts': 'in\n' });
  seed(outside, { 'secret.txt': 'secret\n' });
  fs.symlinkSync(outside, path.join(cwd, 'link'));
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(cwd, 'file-link.txt'));
  const escapes = [
    { op: 'edit', path: '../' + path.basename(outside) + '/secret.txt', old_string: 'secret', new_string: 'pwned' },
    { op: 'edit', path: path.join(outside, 'secret.txt'), old_string: 'secret', new_string: 'pwned' },
    { op: 'edit', path: 'link/secret.txt', old_string: 'secret', new_string: 'pwned' },
    { op: 'edit', path: 'file-link.txt', old_string: 'secret', new_string: 'pwned' },
    { op: 'create', path: 'link/new.txt', content: 'planted' },
    { op: 'delete', path: 'link/secret.txt' },
  ];
  for (const escape of escapes) {
    const result = await editFilesTool.execute(
      { operations: [{ op: 'edit', path: 'in.ts', old_string: 'in', new_string: 'IN' }, escape] },
      { cwd },
    );
    assert.equal(result.isError, true, JSON.stringify(escape));
    assert.match(result.output, /operation 2 .*outside the agent workspace/);
    assert.equal(read(cwd, 'in.ts'), 'in\n', 'the in-workspace edit did not happen either');
  }
  assert.deepEqual(tree(outside), { 'secret.txt': 'secret\n' });
});

test('the read-before-edit guard checks every file the batch edits or deletes', () => {
  const cwd = workspace();
  seed(cwd, { 'a.ts': 'a\n', 'b.ts': 'b\n' });
  const guard = new FileStateGuard(cwd);
  const input = {
    operations: [
      { op: 'edit', path: 'a.ts', old_string: 'a', new_string: 'A' },
      { op: 'delete', path: 'b.ts' },
      { op: 'create', path: 'c.ts', content: 'c' },
    ],
  };
  guard.record('read_file', { path: 'a.ts' }, false);
  const refused = guard.check('edit_files', input);
  assert.match(refused ?? '', /read b\.ts with read_file before deleting it.*operation 2/);
  guard.record('read_file', { path: 'b.ts' }, false);
  assert.equal(guard.check('edit_files', input), null);
  // A file changed since it was read refuses the batch.
  fs.writeFileSync(path.join(cwd, 'a.ts'), 'a changed\n');
  assert.match(guard.check('edit_files', input) ?? '', /a\.ts changed on disk.*operation 1/);
});

test('permission rules see every path of a batch: one denied path refuses it all', () => {
  const cwd = workspace();
  seed(cwd, { 'src/a.ts': '', 'secrets/key.pem': '' });
  const subject = ruleSubjectFor(
    'edit_files',
    { operations: [{ op: 'edit', path: 'src/a.ts' }, { op: 'delete', path: path.join(cwd, 'secrets/key.pem') }] },
    cwd,
  );
  assert.deepEqual(subject, { paths: ['src/a.ts', 'secrets/key.pem'] });
  const rules = new PermissionRuleSet({
    allow: [PermissionRule.parse('Edit(src/**)')!],
    deny: [PermissionRule.parse('Edit(secrets/**)')!],
  });
  assert.equal(rules.evaluate('edit_files', subject)?.decision, 'deny');
  assert.equal(rules.evaluate('edit_files', { paths: ['src/a.ts', 'src/b.ts'] })?.decision, 'allow');
  // An allow rule that covers only some of the files does not speak for the batch.
  assert.equal(rules.evaluate('edit_files', { paths: ['src/a.ts', 'docs/x.md'] }), null);
});

/** Scripted provider: one edit_files call, then a closing message. */
function provider(input: Record<string, unknown>): ProviderAdapter {
  const turns: ProviderStreamEvent[][] = [
    [
      { type: 'tool_call', id: 'ef-1', name: 'edit_files', input },
      { type: 'done', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } },
    ],
  ];
  let call = 0;
  return {
    id: 'mock',
    name: 'Mock',
    defaultModel: 'mock-1',
    models: () => ['mock-1'],
    capabilities: () => ({ tools: true, vision: false, computerUse: false, reasoningLevels: [], maxContext: 100_000, streaming: true, mcp: false }),
    async *stream(): AsyncGenerator<ProviderStreamEvent> {
      const script = turns[call++] ?? [
        { type: 'text_delta', text: 'done' },
        { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
      ];
      for (const ev of script) yield ev;
    },
  };
}

async function runBatch(cwd: string, mode: PermissionMode, input: Record<string, unknown>, answer: ApprovalDecision) {
  const approvals: ApprovalRequest[] = [];
  const events: AgentEvent[] = [];
  const session = AgentSession.create({
    provider: provider(input),
    cwd,
    mode,
    guards: { readBeforeEdit: false },
    callbacks: {
      onEvent: (e) => events.push(e),
      requestApproval: async (req) => {
        approvals.push(req);
        return answer;
      },
    },
  });
  await session.prompt('apply the batch');
  return { session, approvals, events };
}

const BATCH = {
  operations: [
    { op: 'edit', path: 'a.ts', old_string: 'a0', new_string: 'a1' },
    { op: 'edit', path: 'b.ts', old_string: 'b0', new_string: 'b1' },
    { op: 'create', path: 'c.ts', content: 'c1\n' },
    { op: 'delete', path: 'd.ts' },
  ],
};

test('in ask mode the batch waits for approval, and a declined batch writes nothing', async () => {
  process.env.JUNO_HOME = workspace();
  try {
    const cwd = workspace();
    seed(cwd, { 'a.ts': 'a0\n', 'b.ts': 'b0\n', 'd.ts': 'd0\n' });
    const before = tree(cwd);
    const { approvals, events } = await runBatch(cwd, 'ask', BATCH, 'deny');
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0]!.toolName, 'edit_files');
    assert.equal(approvals[0]!.risk, 'edit');
    assert.match(approvals[0]!.summary, /Edit 4 files/);
    assert.ok(events.some((e) => e.type === 'tool_denied' && e.name === 'edit_files'));
    assert.deepEqual(tree(cwd), before);

    // Approved, it applies; auto-edit applies it without asking, as for edit_file.
    const approved = await runBatch(cwd, 'ask', BATCH, 'allow');
    assert.equal(approved.approvals.length, 1);
    assert.equal(read(cwd, 'a.ts'), 'a1\n');
    const cwd2 = workspace();
    seed(cwd2, { 'a.ts': 'a0\n', 'b.ts': 'b0\n', 'd.ts': 'd0\n' });
    const auto = await runBatch(cwd2, 'auto-edit', BATCH, 'deny');
    assert.equal(auto.approvals.length, 0);
    assert.equal(read(cwd2, 'b.ts'), 'b1\n');
    // Plan mode refuses it outright.
    const cwd3 = workspace();
    seed(cwd3, { 'a.ts': 'a0\n', 'b.ts': 'b0\n', 'd.ts': 'd0\n' });
    const planned = await runBatch(cwd3, 'plan', BATCH, 'allow');
    assert.equal(planned.approvals.length, 0);
    assert.equal(read(cwd3, 'a.ts'), 'a0\n');
  } finally {
    delete process.env.JUNO_HOME;
  }
});

test('a project deny rule on one file refuses the whole batch, even in full access', async () => {
  process.env.JUNO_HOME = workspace();
  try {
    const cwd = workspace();
    seed(cwd, {
      'src/a.ts': 'a0\n',
      'secrets/key.pem': 'k0\n',
      '.juno/settings.json': JSON.stringify({ permissions: { deny: ['Edit(secrets/**)'] } }),
    });
    const before = tree(cwd);
    const { events } = await runBatch(
      cwd,
      'full',
      {
        operations: [
          { op: 'edit', path: 'src/a.ts', old_string: 'a0', new_string: 'a1' },
          { op: 'edit', path: 'secrets/key.pem', old_string: 'k0', new_string: 'k1' },
        ],
      },
      'allow',
    );
    const denied = events.find((e) => e.type === 'tool_denied');
    assert.ok(denied && denied.type === 'tool_denied');
    assert.match(denied.reason, /Edit\(secrets\/\*\*\)/);
    assert.deepEqual(tree(cwd), before);
  } finally {
    delete process.env.JUNO_HOME;
  }
});

test('one undo restores every file the batch touched', async () => {
  process.env.JUNO_HOME = workspace();
  try {
    const cwd = workspace();
    seed(cwd, { 'a.ts': 'a0\n', 'b.ts': 'b0\n', 'd.ts': 'd0\n' });
    const before = tree(cwd);
    const { session, events } = await runBatch(cwd, 'auto-edit', BATCH, 'allow');
    assert.equal(read(cwd, 'c.ts'), 'c1\n');
    assert.equal(read(cwd, 'd.ts'), null);
    assert.ok(events.some((e) => e.type === 'files_changed'));
    const restored = session.undoLastTurn();
    assert.equal(restored.length, 4);
    assert.deepEqual(tree(cwd), before, 'edits reverted, the created file removed, the deleted file back');
  } finally {
    delete process.env.JUNO_HOME;
  }
});

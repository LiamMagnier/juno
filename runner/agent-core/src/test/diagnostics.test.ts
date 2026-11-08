/**
 * After-edit type errors (harness/diagnostics.ts): a warm TypeScript language
 * service in a worker reports what an edit broke in the file it wrote.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AgentSession } from '../agent.js';
import { EditDiagnostics, diagnosticsEnabled, nearestTsconfig } from '../harness/diagnostics.js';
import type { ProviderRequest } from '../providers/types.js';
import type { ApprovalDecision } from '../types.js';
import { call, gitRepo, say, scriptedProvider, tmpdir, userText } from './fake-provider.js';

const TSCONFIG = JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', types: [] }, include: ['src'] });

function project(): string {
  return gitRepo({
    'tsconfig.json': TSCONFIG,
    'src/math.ts': 'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
    'src/use.ts': "import { add } from './math';\nexport const total: number = add(1, 2);\n",
    'notes.md': 'not code\n',
  });
}

test('nearestTsconfig stops at the root and the flag turns it off', () => {
  const root = project();
  assert.equal(nearestTsconfig(path.join(root, 'src/math.ts'), root), path.join(root, 'tsconfig.json'));
  assert.equal(nearestTsconfig(path.join(root, 'src/math.ts'), path.join(root, 'src')), null);
  assert.equal(diagnosticsEnabled({ ALEVR_DIAGNOSTICS: '0' }), false);
  assert.equal(diagnosticsEnabled({}), true);
});

test('EditDiagnostics reports new errors, then the same set in one line, then the fix', async () => {
  const root = project();
  const checker = new EditDiagnostics(root, { budgetMs: 60_000 });
  try {
    const file = path.join(root, 'src/use.ts');
    assert.equal(await checker.afterEdit([file]), null, 'a clean file says nothing');
    assert.equal(await checker.afterEdit([path.join(root, 'notes.md')]), null, 'not TypeScript');

    fs.writeFileSync(file, "import { add } from './math';\nexport const total: string = add(1, 2);\n");
    const broken = await checker.afterEdit([file]);
    assert.ok(broken);
    assert.match(broken, /<diagnostics source="typescript">/);
    assert.match(broken, /src\/use\.ts:2:14 - error TS2322: Type 'number' is not assignable to type 'string'\./);

    fs.writeFileSync(file, "import { add } from './math';\nexport const total: string = add(1, 2);\n// touched\n");
    assert.match((await checker.afterEdit([file])) ?? '', /the same 1 type error\(s\) as before remain/);

    fs.writeFileSync(file, "import { add } from './math';\nexport const total: number = add(1, 2);\n");
    assert.match((await checker.afterEdit([file])) ?? '', /src\/use\.ts: no type errors now\./);
    assert.equal(await checker.afterEdit([file]), null, 'nothing new to say');
  } finally {
    checker.dispose();
  }
});

test('a check past its budget is skipped, not waited for', async () => {
  const root = project();
  const checker = new EditDiagnostics(root, { budgetMs: 1 });
  try {
    fs.writeFileSync(path.join(root, 'src/use.ts'), 'export const x: string = 1;\n');
    assert.equal(await checker.afterEdit([path.join(root, 'src/use.ts')]), null);
  } finally {
    checker.dispose();
  }
});

test('diagnostics match canonical edit paths to a workspace opened through a symlink', async () => {
  const root = project();
  const alias = path.join(tmpdir('alevr-diag-alias-'), 'workspace');
  fs.symlinkSync(root, alias);
  const file = path.join(root, 'src/use.ts');
  fs.writeFileSync(file, 'export const total: string = 3;\n');
  for (const [workspace, edited] of [[alias, fs.realpathSync(file)], [fs.realpathSync(root), path.join(alias, 'src/use.ts')]]) {
    const checker = new EditDiagnostics(workspace!, { budgetMs: 60_000 });
    try {
      assert.match((await checker.afterEdit([edited!])) ?? '', /src\/use\.ts:1:14 - error TS2322/);
    } finally {
      checker.dispose();
    }
  }
});

function run(diagnostics?: false) {
  process.env.JUNO_HOME = tmpdir('alevr-diag-home-');
  const cwd = project();
  let step = 0;
  const provider = scriptedProvider('mock', (_req: ProviderRequest) => {
    step += 1;
    if (step === 1) return call('e1', 'write_file', { path: 'src/use.ts', content: 'export const total: string = 3;\n' });
    return say('done');
  });
  const session = AgentSession.create({
    provider,
    cwd,
    mode: 'full',
    subagents: false,
    guards: { readBeforeEdit: false },
    diagnostics: diagnostics === false ? false : { budgetMs: 60_000 },
    callbacks: { onEvent: () => {}, requestApproval: async (): Promise<ApprovalDecision> => 'allow' },
  });
  return { session, provider };
}

test('the session appends type errors to the edit result the model sees', async () => {
  const { session, provider } = run();
  try {
    await session.prompt('break it');
    const after = provider.requests[1];
    assert.ok(after);
    assert.match(userText(after), /src\/use\.ts:1:14 - error TS2322/);
  } finally {
    session.dispose();
  }
});

test('diagnostics: false leaves the edit result alone', async () => {
  const { session, provider } = run(false);
  try {
    await session.prompt('break it');
    assert.doesNotMatch(userText(provider.requests[1]!), /<diagnostics/);
  } finally {
    session.dispose();
  }
});

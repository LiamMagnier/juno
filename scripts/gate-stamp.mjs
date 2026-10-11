import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const hash = value => createHash('sha256').update(value).digest('hex');
export function stampIdentity(ref = 'HEAD') {
  if (git('status', '--porcelain', '--untracked-files=all')) throw new Error('dirty tree');
  const tree = git('rev-parse', `${ref}^{tree}`);
  if (tree !== git('rev-parse', 'HEAD^{tree}')) throw new Error('source tree differs from checkout');
  const gatePaths = ['scripts/gate-stamp.mjs', 'scripts/local-gates.sh', 'scripts/release-gates.sh'];
  const lockPaths = ['package-lock.json', 'runner/agent-core/package-lock.json', 'runner/env-server/package-lock.json', 'relay/package-lock.json'];
  const digestPaths = paths => hash(paths.map(path => `${path}:${hash(execFileSync('git', ['show', `${ref}:${path}`]))}`).join('\n'));
  const identity = { version: 1, tree, gates: digestPaths(gatePaths), locks: digestPaths(lockPaths) };
  const directory = resolve(git('rev-parse', '--git-common-dir'), 'alevr-gate-stamps');
  return { identity, directory, path: join(directory, `${hash(JSON.stringify(identity))}.json`) };
}
export function checkStamp(ref = 'HEAD') {
  const { identity, path } = stampIdentity(ref);
  if (!existsSync(path)) return false;
  const recorded = JSON.parse(readFileSync(path, 'utf8'));
  return JSON.stringify(recorded.identity) === JSON.stringify(identity) && recorded.fullWebGates === true;
}
export function recordStamp(ref = 'HEAD') {
  const { identity, directory, path } = stampIdentity(ref);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify({ identity, fullWebGates: true, passedAt: new Date().toISOString() }) + '\n', { mode: 0o600 });
  renameSync(temporary, path);
  return identity.tree;
}
if (process.argv[1] && resolve(process.argv[1]) === resolve('scripts/gate-stamp.mjs')) {
  try {
    const mode = process.argv[2];
    const ref = process.argv[3] || 'HEAD';
    if (mode === 'record') console.log(`Recorded full web gates for tree ${recordStamp(ref)}`);
    else if (mode === 'check' && checkStamp(ref)) console.log(`web gates already passed for tree ${stampIdentity(ref).identity.tree}`);
    else process.exitCode = 1;
  } catch (error) {
    if (process.argv[2] === 'record') console.error(`Web gate stamp not recorded: ${error.message}`);
    process.exitCode = 1;
  }
}

/**
 * Drift gate for the parts of the agent-core contract the compiler cannot see.
 *
 * `src/shared/agent-protocol.ts` already proves, at compile time, that its Zod
 * validators are *exactly* agent-core's exported types. That covers `AgentEvent`
 * and friends completely, and nothing here duplicates it.
 *
 * What it does not cover, and what this script exists for:
 *
 *   1. **The sidecar command protocol has no exported type.** It is documented
 *      only as a comment on `startSidecarServer` in
 *      `runner/agent-core/src/server.ts`. `SidecarCommandSchema` mirrors that
 *      comment, so a change to it is invisible to `tsc` — the mirror simply
 *      becomes wrong. This compares the two.
 *   2. **The compile-time assertions pass vacuously if agent-core resolves to
 *      `any`.** That already happened once during development: the package was
 *      not built, every import was implicitly `any`, and every `assertExactly`
 *      reported success. So this verifies the built declarations exist and
 *      carry real content before anyone trusts a green typecheck.
 *
 * Exits non-zero with an explanation of what to change. Run by `npm run gates`.
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, '..');
const AGENT_CORE = path.resolve(WORKSPACE, '..', '..', 'runner', 'agent-core');

const problems: string[] = [];
const notes: string[] = [];

function fail(message: string): void {
  problems.push(message);
}

/* -------------------------------------------------------------------------- */
/* 1. agent-core is built, and its declarations are real                       */
/* -------------------------------------------------------------------------- */

const dist = path.join(AGENT_CORE, 'dist');
const indexDts = path.join(dist, 'index.d.ts');
const typesDts = path.join(dist, 'types.d.ts');

if (!existsSync(indexDts) || !existsSync(typesDts)) {
  fail(
    `agent-core is not built — ${path.relative(WORKSPACE, dist)} is missing declarations.\n` +
      `  Every compile-time assertion in src/shared/agent-protocol.ts passes VACUOUSLY when the\n` +
      `  import resolves to \`any\`, so a green typecheck here would mean nothing.\n` +
      `  Fix: (cd ${path.relative(WORKSPACE, AGENT_CORE)} && npm install && npx tsc -p tsconfig.json)`,
  );
} else {
  const declaration = readFileSync(typesDts, 'utf8');
  if (!declaration.includes('AgentEvent')) {
    fail(`${path.relative(WORKSPACE, typesDts)} does not declare AgentEvent — the build looks broken.`);
  }

  /* Stale declarations are as bad as missing ones: the assertions would compare
     against yesterday's contract and pass. */
  const newestSource = readdirSync(path.join(AGENT_CORE, 'src'))
    .filter((entry) => entry.endsWith('.ts'))
    .map((entry) => statSync(path.join(AGENT_CORE, 'src', entry)).mtimeMs)
    .reduce((a, b) => Math.max(a, b), 0);
  if (newestSource > statSync(typesDts).mtimeMs) {
    fail(
      'agent-core sources are newer than its built declarations, so the contract assertions are\n' +
        '  checking a stale contract. Rebuild agent-core.',
    );
  } else {
    notes.push('agent-core declarations are present and newer than its sources');
  }
}

/* -------------------------------------------------------------------------- */
/* 2. The sidecar command protocol matches its documentation                   */
/* -------------------------------------------------------------------------- */

const serverPath = path.join(AGENT_CORE, 'src', 'server.ts');
const protocolPath = path.join(WORKSPACE, 'src', 'shared', 'agent-protocol.ts');

if (!existsSync(serverPath)) {
  fail(`${path.relative(WORKSPACE, serverPath)} is missing — the sidecar protocol cannot be checked.`);
} else {
  const server = readFileSync(serverPath, 'utf8');

  /* The documented commands live in the block comment as `{type:'name', …}`.
     Read only the client->server half: the server->client half uses the same
     syntax and would otherwise be counted as commands. */
  const clientHalf = server.slice(
    server.indexOf('client -> server:'),
    server.indexOf('server -> client:'),
  );
  const documented = new Set(
    [...clientHalf.matchAll(/\{\s*type\s*:\s*'([a-z_]+)'/g)].map((m) => m[1] as string),
  );

  const protocol = readFileSync(protocolPath, 'utf8');
  const mirrorBlock = protocol.slice(
    protocol.indexOf('export const SidecarCommandSchema'),
    protocol.indexOf('export const SidecarMessageSchema'),
  );
  const mirrored = new Set(
    [...mirrorBlock.matchAll(/z\.literal\('([a-z_]+)'\)/g)].map((m) => m[1] as string),
  );

  if (documented.size === 0) {
    fail(
      'Could not find any documented sidecar commands in agent-core/src/server.ts.\n' +
        '  The protocol comment has probably been restructured; this gate needs updating with it.',
    );
  }

  const missing = [...documented].filter((name) => !mirrored.has(name)).sort();
  const extra = [...mirrored].filter((name) => !documented.has(name)).sort();

  if (missing.length > 0) {
    fail(
      `SidecarCommandSchema is missing ${missing.length} command(s) that agent-core documents: ${missing.join(', ')}.\n` +
        '  Add them to src/shared/agent-protocol.ts.',
    );
  }
  if (extra.length > 0) {
    fail(
      `SidecarCommandSchema declares ${extra.length} command(s) agent-core no longer documents: ${extra.join(', ')}.\n` +
        '  Remove them, or update this gate if the comment moved.',
    );
  }
  if (missing.length === 0 && extra.length === 0) {
    notes.push(`sidecar command protocol matches (${documented.size} commands)`);
  }
}

/* -------------------------------------------------------------------------- */
/* Report                                                                      */
/* -------------------------------------------------------------------------- */

if (problems.length > 0) {
  console.error('[agent-contract] FAILED\n');
  for (const problem of problems) console.error(`  • ${problem}\n`);
  process.exit(1);
}

console.log(`[agent-contract] ok — ${notes.join('; ')}`);

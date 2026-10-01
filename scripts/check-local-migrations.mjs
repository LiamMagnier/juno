/** Replay committed migrations against disposable local Postgres. Never reads .env. */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';

const root = process.cwd();
const checkout = mkdtempSync(path.join(tmpdir(), 'juno-migration-gate-'));
const sourceRef = process.argv[2];
const name = `juno-migration-gate-${process.pid}-${randomBytes(4).toString('hex')}`;
let created = false;
let postgresBin;
let pgStarted = false;
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} ${args[0] ?? ''} failed: ${result.stderr ?? result.error?.message ?? ''}`);
  return result.stdout?.trim() ?? '';
}
try {
  let source = root;
  if (sourceRef) {
    const archive = spawnSync('git', ['archive', '--format=tar', sourceRef, 'prisma'], { maxBuffer: 64 * 1024 * 1024 });
    if (archive.status !== 0) throw new Error('Cannot archive migration source');
    run('tar', ['-xf', '-', '-C', checkout], { input: archive.stdout });
    source = checkout;
  }
  let url;
  const dockerReady = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { stdio: 'ignore' }).status === 0;
  if (dockerReady) {
    const password = randomBytes(24).toString('hex');
    run('docker', ['run', '--detach', '--rm', '--name', name, '--publish', '127.0.0.1::5432', '--env', 'POSTGRES_PASSWORD', '--env', 'POSTGRES_DB=shadow', 'postgres:16-alpine'], { env: { ...process.env, POSTGRES_PASSWORD: password } });
    created = true;
    const published = run('docker', ['port', name, '5432/tcp']).split('\n')[0];
    const port = published.split(':').at(-1);
    url = `postgresql://postgres:${password}@127.0.0.1:${port}/shadow`;
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      const result = spawnSync('docker', ['exec', name, 'pg_isready', '-U', 'postgres', '-d', 'shadow'], { stdio: 'ignore' });
      if (result.status === 0) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!ready) throw new Error('Disposable Postgres did not become ready');
  } else {
    // Hosted macOS runners have no Docker. A fresh unprivileged pg_ctl cluster
    // gives them the same isolated replay, without touching a running database.
    postgresBin = '';
    if (spawnSync('initdb', ['--version'], { stdio: 'ignore' }).status !== 0) {
      const prefix = run('brew', ['--prefix', 'postgresql@16']);
      postgresBin = path.join(prefix, 'bin');
    }
    const pg = command => postgresBin ? path.join(postgresBin, command) : command;
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const assigned = server.address().port;
        server.close(() => resolve(assigned));
      });
    });
    const data = path.join(checkout, 'pgdata');
    run(pg('initdb'), ['-U', 'postgres', '--auth=trust', '--no-locale', '-D', data]);
    run(pg('pg_ctl'), ['start', '-D', data, '-l', path.join(checkout, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -F`, '-w']);
    pgStarted = true;
    run(pg('createdb'), ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', 'shadow']);
    url = `postgresql://postgres@127.0.0.1:${port}/shadow`;
  }
  const prisma = path.join(root, 'node_modules', 'prisma', 'build', 'index.js');
  const environment = { ...process.env, DATABASE_URL: url, DIRECT_URL: url };
  run(process.execPath, [prisma, 'validate', '--schema', path.join(source, 'prisma/schema.prisma')], { env: environment, stdio: 'inherit' });
  run(process.execPath, [prisma, 'migrate', 'diff', '--from-migrations', path.join(source, 'prisma/migrations'), '--to-schema-datamodel', path.join(source, 'prisma/schema.prisma'), '--shadow-database-url', url, '--exit-code'], { env: environment, stdio: 'inherit' });
  console.log('Disposable migration replay reproduces schema.prisma exactly.');
} finally {
  if (pgStarted) spawnSync(postgresBin ? path.join(postgresBin, 'pg_ctl') : 'pg_ctl', ['stop', '-D', path.join(checkout, 'pgdata'), '-m', 'immediate', '-w'], { stdio: 'ignore' });
  if (created) spawnSync('docker', ['rm', '--force', name], { stdio: 'ignore' });
  rmSync(checkout, { recursive: true, force: true });
}

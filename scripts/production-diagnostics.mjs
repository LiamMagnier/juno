// Read-only production evidence. Never print environment values, raw logs,
// connection URLs, SQL text, user records, or PM2's environment payload.
import { execFileSync } from 'node:child_process';
import { openSync, readSync, closeSync, fstatSync, readFileSync, statfsSync, constants } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

export function classifyDatabaseFailure(value) {
  const text = String(value ?? '');
  if (/Unable to start a transaction in the given time/i.test(text)) return 'transaction_acquisition_timeout';
  if (/P2024|connection pool.*timed out|fetching a new connection from the connection pool/i.test(text)) return 'pool_timeout';
  if (/P1001|can.t reach database server|ECONNREFUSED|ENOTFOUND/i.test(text)) return 'unreachable';
  if (/P1000|authentication failed|password authentication/i.test(text)) return 'authentication';
  if (/too many connections|remaining connection slots/i.test(text)) return 'connection_limit';
  if (/P1017|server has closed|connection.*closed/i.test(text)) return 'connection_closed';
  if (/P2028|transaction.*expired|transaction already closed/i.test(text)) return 'transaction_expired';
  if (/P1002|timed out|timeout/i.test(text)) return 'timeout';
  return 'other';
}

export function summarizeHealthFailures(log) {
  const counts = {};
  const entries = String(log).split('[health] database check failed').slice(1);
  for (const entry of entries) {
    const category = classifyDatabaseFailure(entry.slice(0, 4000));
    counts[category] = (counts[category] ?? 0) + 1;
  }
  return { count: entries.length, categories: counts };
}

export function processSummary(processes) {
  return processes.filter(item => /^juno(?:-|$)/.test(item.name ?? '')).map(item => ({
    name: item.name,
    status: item.pm2_env?.status ?? 'unknown',
    restarts: item.pm2_env?.restart_time ?? 0,
    memoryBytes: item.monit?.memory ?? null,
    cpuPercent: item.monit?.cpu ?? null,
  }));
}

export function healthLogPath(processID, home = homedir()) {
  if (processID !== null && (!Number.isSafeInteger(processID) || processID < 0 || processID > 1_000_000)) throw new Error('Invalid process ID');
  return resolve(home, '.pm2', 'logs', processID === null ? 'juno-error.log' : `juno-error-${processID}.log`);
}

function tailHealthLog(processID, maximum = 512 * 1024) {
  // Derive an allowlisted name from a numeric PM2 id. Never open the path
  // supplied in a process payload, and never follow a planted symlink.
  const fd = openSync(healthLogPath(processID), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new Error('Not a regular log');
    const bytes = Buffer.alloc(Math.min(info.size, maximum));
    readSync(fd, bytes, 0, bytes.length, Math.max(0, info.size - bytes.length));
    return bytes.toString('utf8');
  } finally { closeSync(fd); }
}

async function health(url) {
  const started = performance.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
    const body = await response.json();
    return { status: response.status, ok: body.ok === true, db: body.db === 'ok' ? 'ok' : 'fail', version: /^[a-f0-9]{40}$/.test(body.version) ? body.version : null, durationMs: Math.round(performance.now() - started) };
  } catch { return { status: null, ok: false, durationMs: Math.round(performance.now() - started) }; }
}

async function dedicatedDatabase() {
  const started = performance.now();
  let client;
  try {
    const connection = new URL(process.env.DATABASE_URL);
    if (!['postgres:', 'postgresql:'].includes(connection.protocol)) return { ok: false, category: 'unsupported_database' };
    connection.searchParams.set('connection_limit', '1');
    connection.searchParams.set('connect_timeout', '3');
    connection.searchParams.set('pool_timeout', '3');
    const require = createRequire(resolve(process.cwd(), 'package.json'));
    const { PrismaClient } = require('@prisma/client');
    client = new PrismaClient({ datasources: { db: { url: connection.href } }, log: [] });
    const states = await client.$transaction(async tx => {
      await tx.$queryRaw`SELECT set_config('statement_timeout', '1000ms', true)`;
      await tx.$queryRaw`SELECT 1`;
      return tx.$queryRaw`SELECT state, count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() GROUP BY state`;
    }, { maxWait: 3500, timeout: 1500 });
    return { ok: true, durationMs: Math.round(performance.now() - started), connectionStates: states.map(row => ({ state: ['active', 'idle', 'idle in transaction', 'idle in transaction (aborted)', 'disabled'].includes(row.state) ? row.state : 'other', count: Number(row.count) })) };
  } catch (error) {
    return { ok: false, category: classifyDatabaseFailure(error?.message), code: /^P\d{4}$/.test(error?.code) ? error.code : null, durationMs: Math.round(performance.now() - started) };
  } finally { if (client) await client.$disconnect().catch(() => {}); }
}

async function main() {
  const report = { observedAt: new Date().toISOString() };
  try {
    const processes = JSON.parse(execFileSync('pm2', ['jlist'], { encoding: 'utf8', timeout: 10_000, maxBuffer: 10 * 1024 * 1024 }));
    report.processes = processSummary(processes);
    const ids = [null, ...processes.filter(item => item.name === 'juno' && Number.isSafeInteger(item.pm_id)).map(item => item.pm_id)];
    report.healthFailures = [...new Set(ids)].map(id => {
      try { return summarizeHealthFailures(tailHealthLog(id)); }
      catch { return { unavailable: true }; }
    });
  } catch { report.processesUnavailable = true; }
  try {
    const memory = readFileSync('/proc/meminfo', 'utf8');
    report.memoryKb = Object.fromEntries([...memory.matchAll(/^(MemTotal|MemAvailable|SwapTotal|SwapFree):\s+(\d+)/gm)].map(match => [match[1], Number(match[2])]));
    const disk = statfsSync(process.cwd());
    report.diskAvailableBytes = disk.bavail * disk.bsize;
  } catch { report.hostMetricsUnavailable = true; }
  report.localHealth = [];
  report.publicHealth = [];
  for (let index = 0; index < 3; index++) {
    report.localHealth.push(await health('http://127.0.0.1:3000/api/health'));
    report.publicHealth.push(await health('https://chat.liams.dev/api/health'));
  }
  report.dedicatedDatabase = await dedicatedDatabase();
  console.log(JSON.stringify(report, null, 2));
  if (!report.dedicatedDatabase.ok || !report.publicHealth.some(item => item.ok)) process.exitCode = 1;
}

if (process.argv.includes('--run')) {
  main().catch(() => {
    console.log(JSON.stringify({ ok: false, category: 'diagnostic_failed' }));
    process.exitCode = 1;
  });
}

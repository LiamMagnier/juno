/**
 * Which agents are actually on this Mac.
 *
 * A provider picker that lists nine agents and fails on eight is worse than one
 * that lists the two that work, so the UI gates on this rather than on a static
 * catalogue. Discovery answers one question per provider — can Juno launch it
 * right now, and with exactly which argv — and nothing else.
 *
 * Two rules constrain how it answers:
 *
 *   1. **Look, don't run.** Resolution is filesystem-only: read `PATH`, stat the
 *      candidate, read a package's `bin` map. The single execution this module
 *      ever performs is an optional `--version` probe of a binary that a
 *      *curated* descriptor pointed at, with a hard timeout, a bounded output
 *      buffer and a scrubbed environment. Nothing discovered on disk is
 *      executed on the strength of having been discovered.
 *   2. **Never fetch.** Several ACP agents are distributed as npm packages, and
 *      the obvious implementation — `npx -y @vendor/agent-acp` — downloads and
 *      executes an unpinned package from the network every launch. That is
 *      remote code execution wearing a package manager's clothes. Juno resolves
 *      packages that are *already installed* and otherwise reports the provider
 *      missing so the UI can show an install instruction the user chooses to
 *      follow.
 *
 * The legal posture is enforced here too: a provider whose descriptor says Juno
 * may not drive the local CLI is reported unavailable without being looked for.
 */

import { spawn } from 'node:child_process';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import { delimiter, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { scrubEnvironment } from './acp/client.js';
import type { LaunchCommand, ProviderAvailability, ProviderDescriptor } from './types.js';

export interface DiscoveryOptions {
  /** Run a `--version` probe on anything found. Default true. */
  readonly probeVersions?: boolean;
  /** Probe deadline. Default 3000ms — an agent that cannot print its own
   *  version in three seconds is not going to answer a handshake either. */
  readonly probeTimeoutMs?: number;
  /** Override `process.env` (tests). */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * User-configured absolute paths, keyed by provider id. Lets someone point
   * Juno at a build that is not on `PATH` without Juno guessing locations.
   */
  readonly overrides?: Readonly<Record<string, string>>;
}

const DEFAULT_PROBE_TIMEOUT_MS = 3_000;
const MAX_PROBE_OUTPUT_BYTES = 4 * 1024;

/* -------------------------------------------------------------------------- */
/* PATH lookup                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Resolve an executable name against `PATH`.
 *
 * Deliberately not `which`/`command -v`: both mean spawning a shell, and this
 * module's whole posture is that no shell is involved in deciding what to run.
 * Entries that are not absolute are skipped — a relative `PATH` entry resolves
 * against the current directory, which for a desktop app is attacker-influenced.
 */
export async function findOnPath(
  names: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const raw = env['PATH'] ?? '';
  const directories = raw.split(delimiter).filter((entry) => entry.length > 0 && isAbsolute(entry));

  for (const name of names) {
    // A name containing a separator is a path, not a PATH lookup.
    if (name.includes('/') || name.includes('\\')) continue;
    for (const directory of directories) {
      const candidate = join(directory, name);
      if (await isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    await access(path, FS.X_OK);
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Global npm packages                                                         */
/* -------------------------------------------------------------------------- */

/** Every place a globally installed npm package plausibly lives on macOS. */
async function globalNodeModulesRoots(env: NodeJS.ProcessEnv): Promise<string[]> {
  const home = homedir();
  const roots: string[] = [];
  const prefix = env['npm_config_prefix'];
  if (prefix && isAbsolute(prefix)) roots.push(join(prefix, 'lib', 'node_modules'));
  roots.push(
    '/opt/homebrew/lib/node_modules',
    '/usr/local/lib/node_modules',
    join(home, '.npm-global', 'lib', 'node_modules'),
    join(home, '.bun', 'install', 'global', 'node_modules'),
    join(home, '.local', 'share', 'pnpm', 'global', '5', 'node_modules'),
    join(home, 'Library', 'pnpm', 'global', '5', 'node_modules'),
  );

  // nvm installs one tree per Node version; enumerate rather than guess.
  const nvm = join(home, '.nvm', 'versions', 'node');
  try {
    for (const entry of await readdir(nvm)) {
      roots.push(join(nvm, entry, 'lib', 'node_modules'));
    }
  } catch {
    /* no nvm on this machine */
  }
  return roots;
}

interface PackageBin {
  readonly command: string;
}

/**
 * Resolve an installed npm package's executable by reading its `bin` map.
 *
 * The resolved path is confined to the package directory. A package whose
 * `bin` points outside itself (`"bin": "../../../usr/bin/curl"`) is rejected:
 * Juno is deciding what to execute from a file that a third party controls, and
 * a containment check is cheap.
 */
export async function findGlobalNpmBinary(
  packageName: string,
  binName: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PackageBin | null> {
  for (const root of await globalNodeModulesRoots(env)) {
    const packageDir = join(root, ...packageName.split('/'));
    let manifest: unknown;
    try {
      manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    const relative = binEntry(manifest, binName, packageName);
    if (!relative) continue;

    const resolved = resolve(packageDir, relative);
    const containedIn = normalize(packageDir) + sep;
    if (!resolved.startsWith(containedIn)) continue;
    if (await isExecutableFile(resolved)) return { command: resolved };
    // Some packages ship the entry without the executable bit; the file still
    // works when handed to `node`, but Juno will not silently invent an
    // interpreter for it, so it is treated as not installed.
  }
  return null;
}

function binEntry(manifest: unknown, binName: string | undefined, packageName: string): string | null {
  if (typeof manifest !== 'object' || manifest === null) return null;
  const bin = (manifest as { bin?: unknown }).bin;
  if (typeof bin === 'string') return bin;
  if (typeof bin !== 'object' || bin === null) return null;

  const map = bin as Record<string, unknown>;
  const preferred = binName ?? packageName.split('/').pop() ?? packageName;
  const chosen = map[preferred] ?? Object.values(map)[0];
  return typeof chosen === 'string' ? chosen : null;
}

/* -------------------------------------------------------------------------- */
/* Version probe                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Run `<command> --version`, bounded in time and output.
 *
 * The only execution this module performs, and only against a path a curated
 * descriptor produced. Output is capped so an agent that streams megabytes in
 * response to `--version` cannot be used to exhaust memory, and the child is
 * SIGKILLed on the deadline rather than left running.
 */
export async function probeVersion(
  command: string,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  return new Promise<string | null>((resolvePromise) => {
    let child;
    try {
      child = spawn(command, ['--version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
        detached: false,
        env: scrubEnvironment(env),
      });
    } catch {
      resolvePromise(null);
      return;
    }

    let output = '';
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    };

    const collect = (chunk: Buffer): void => {
      if (output.length >= MAX_PROBE_OUTPUT_BYTES) return;
      output += chunk.toString('utf8').slice(0, MAX_PROBE_OUTPUT_BYTES - output.length);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, timeoutMs);
    timer.unref?.();

    child.once('error', () => finish(null));
    child.once('close', () => {
      const line = output.split('\n').find((entry) => entry.trim().length > 0);
      finish(line ? line.trim().slice(0, 120) : null);
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Per-provider discovery                                                      */
/* -------------------------------------------------------------------------- */

export async function discoverProvider(
  descriptor: ProviderDescriptor,
  options: DiscoveryOptions = {},
): Promise<ProviderAvailability> {
  const env = options.env ?? process.env;

  // The legal posture gates discovery, not just the UI. A provider Juno may not
  // drive is never even looked for.
  if (descriptor.legal.localCli === 'prohibited') {
    return {
      id: descriptor.id,
      available: false,
      reason: 'legally-blocked',
      detail: `${descriptor.displayName} cannot be driven from Juno under its current terms.`,
    };
  }

  if (descriptor.discovery.some((strategy) => strategy.kind === 'builtin')) {
    return {
      id: descriptor.id,
      available: true,
      launch: { command: '', args: [], env: {} },
    };
  }

  const override = options.overrides?.[descriptor.id];
  if (override !== undefined) {
    if (!isAbsolute(override)) {
      return {
        id: descriptor.id,
        available: false,
        reason: 'not-executable',
        detail: `The configured path for ${descriptor.displayName} is not absolute.`,
      };
    }
    if (!(await isExecutableFile(override))) {
      return {
        id: descriptor.id,
        available: false,
        reason: 'not-executable',
        detail: `The configured path for ${descriptor.displayName} is not an executable file.`,
      };
    }
    return finish(descriptor, override, options, env);
  }

  // Strategies are tried in order; the first hit wins.
  const attempted: string[] = [];
  for (const strategy of descriptor.discovery) {
    if (strategy.kind === 'path-binary') {
      attempted.push(`${strategy.names.join(' or ')} on PATH`);
      const found = await findOnPath(strategy.names, env);
      if (found) return finish(descriptor, found, options, env);
    } else if (strategy.kind === 'npm-global') {
      attempted.push(`the global npm package ${strategy.packageName}`);
      const binary = await findGlobalNpmBinary(strategy.packageName, strategy.binName, env);
      if (binary) return finish(descriptor, binary.command, options, env);
    }
  }

  return {
    id: descriptor.id,
    available: false,
    reason: 'not-installed',
    detail: `Could not find ${descriptor.displayName}. Looked for ${attempted.join(', ')}.${installHint(descriptor)}`,
  };
}

/** The install line the UI offers. Never run automatically — the user decides. */
function installHint(descriptor: ProviderDescriptor): string {
  const pkg = descriptor.discovery.find((strategy) => strategy.kind === 'npm-global');
  return pkg && pkg.kind === 'npm-global' ? ` Install with: npm install -g ${pkg.packageName}` : '';
}

async function finish(
  descriptor: ProviderDescriptor,
  command: string,
  options: DiscoveryOptions,
  env: NodeJS.ProcessEnv,
): Promise<ProviderAvailability> {
  const launch: LaunchCommand = {
    command,
    args: [...descriptor.acpArgs],
    env: { ...descriptor.acpEnv },
  };
  if (options.probeVersions === false) {
    return { id: descriptor.id, available: true, launch };
  }
  const version = await probeVersion(
    command,
    options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    env,
  );
  // A failed probe is not a failed provider: plenty of CLIs answer `--version`
  // with a non-zero exit or nothing at all. Availability is decided by the
  // executable existing; the probe only enriches the label.
  return version === null
    ? { id: descriptor.id, available: true, launch }
    : { id: descriptor.id, available: true, launch, version };
}

/** Discover every descriptor concurrently. Order of the result matches the input. */
export async function discoverProviders(
  descriptors: readonly ProviderDescriptor[],
  options: DiscoveryOptions = {},
): Promise<ProviderAvailability[]> {
  return Promise.all(descriptors.map((descriptor) => discoverProvider(descriptor, options)));
}

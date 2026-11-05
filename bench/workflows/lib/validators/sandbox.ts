/**
 * The sandbox for untrusted work: code delivered by a product (code_tests)
 * and documents produced by a product (office_reopen). It is built from
 * util-linux alone, so a Linux machine needs nothing new installed:
 *
 *   unshare   new user, mount, network, PID, IPC and UTS namespaces; the
 *             child is SIGKILLed if the launcher dies (--kill-child)
 *   mount     a fresh tmpfs root that holds only what the child needs
 *   chroot    into that root
 *   setpriv   drop every capability and set no_new_privs before the target
 *
 * What the child can see, and nothing else:
 *
 *   /usr /lib* /bin /sbin   read-only (system binaries and libraries)
 *   /etc/ld.so.cache        read-only, so the loader finds libraries; no
 *                           other /etc unless a caller lists it
 *   /dev/null zero random urandom
 *   the caller's paths      at the same path, read-only or writable
 *   optionally              a private /tmp (tmpfs, 64 MB, gone afterwards)
 *                           and /proc for its own PID namespace
 *
 * So the host's $HOME, the repo, /run, /var/run and /tmp are absent. A Unix
 * socket reached by path (Docker, the D-Bus session bus, local Postgres) does
 * not exist inside, a SQLite or cookie file outside the listed paths cannot
 * be opened by any API, and nothing outside the writable paths and the
 * private /tmp can be changed. The network namespace has only a loopback
 * interface, which is down: no TCP or UDP to anywhere (the host's loopback
 * included), and abstract Unix sockets are per network namespace, so they
 * are cut too. The PID namespace hides host processes, so none can be
 * signalled.
 *
 * Where this cannot be built (macOS; Linux without unprivileged user
 * namespaces; a node binary whose libraries live outside the system
 * directories) detectSandbox() says why, and callers refuse to run untrusted
 * work unless the operator explicitly opts out on a disposable machine.
 */

import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export interface SandboxMounts {
  /** Host paths visible inside at the same path, read-only. */
  readOnly?: string[];
  /** Host paths visible inside at the same path, writable. */
  writable?: string[];
  /** A private, size-capped tmpfs at /tmp. */
  tmp?: boolean;
  /** /proc for the sandbox's own PID namespace (LibreOffice needs it). */
  proc?: boolean;
  /** Working directory inside the sandbox (must be one of the listed paths or under one). */
  cwd: string;
}

export type SandboxStatus = { available: true } | { available: false; reason: string };

export const SYSTEM_DIRS = ["/usr", "/lib", "/lib32", "/lib64", "/libx32", "/bin", "/sbin"];

/**
 * Runs inside the new namespaces as their root (which maps to the invoking
 * user, never to real root). Arguments: the empty directory to build the
 * root on, then `tmp`, `proc`, `ro:<path>` and `rw:<path>` entries, then
 * `--`, the working directory, and the command with its arguments. `set -e`
 * makes any failed step abort, so the target never runs half-contained.
 */
const SANDBOX_SCRIPT = String.raw`set -eu
P0=${"$"}{PATH:-}
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin${"$"}{PATH:+:${"$"}PATH}
CHROOT=$(command -v chroot)
SETPRIV=$(command -v setpriv)
R=$1
shift
mount -t tmpfs -o mode=0755,size=8m,nosuid,nodev wb-sandbox-root "$R"
robind() {
  mount --bind "$1" "$2"
  mount -o remount,bind,ro,nosuid,nodev "$2"
}
for d in ${SYSTEM_DIRS.join(" ")}; do
  if [ -L "$d" ]; then
    ln -s "$(readlink "$d")" "$R$d"
  elif [ -d "$d" ]; then
    mkdir -p "$R$d"
    robind "$d" "$R$d"
    findmnt -rn -o TARGET | while read -r m; do
      case $m in "$d"/*) robind "$m" "$R$m" ;; esac
    done
  fi
done
mkdir -p "$R/dev" "$R/etc" "$R/tmp"
for x in null zero random urandom; do
  : > "$R/dev/$x"
  mount --bind "/dev/$x" "$R/dev/$x"
done
if [ -e /etc/ld.so.cache ]; then
  : > "$R/etc/ld.so.cache"
  robind /etc/ld.so.cache "$R/etc/ld.so.cache"
fi
while [ "$1" != "--" ]; do
  entry=$1
  shift
  case $entry in
    tmp) mount -t tmpfs -o mode=1777,size=64m,nosuid,nodev wb-sandbox-tmp "$R/tmp" ;;
    proc) mkdir -p "$R/proc"; mount -t proc -o nosuid,nodev,noexec proc "$R/proc" ;;
    ro:/* | rw:/*)
      p=${"$"}{entry#*:}
      if [ -d "$p" ]; then
        mkdir -p "$R$p"
      else
        mkdir -p "$R${"$"}{p%/*}"
        [ -e "$R$p" ] || : > "$R$p"
      fi
      case $entry in
        ro:*) robind "$p" "$R$p" ;;
        *) mount --bind "$p" "$R$p" ;;
      esac
      ;;
    *) echo "wb-sandbox: bad entry $entry" >&2; exit 64 ;;
  esac
done
shift
CWD=$1
shift
mount -o remount,ro,nosuid,nodev "$R"
PATH=$P0 exec "$CHROOT" "$R" /bin/sh -c 'cd "$1" || exit 125; shift; exec "$@"' wb-sandbox "$CWD" "$SETPRIV" --no-new-privs --bounding-set=-all --inh-caps=-all -- "$@"
`;

function assertAbsolute(paths: string[]) {
  for (const p of paths) {
    if (!path.isAbsolute(p) || p.includes("\n")) throw new Error(`sandbox paths must be absolute single-line paths: ${JSON.stringify(p)}`);
  }
}

/** The `unshare` argument list that runs `command args` inside the sandbox built on the empty directory `root`. */
export function sandboxArgs(root: string, mounts: SandboxMounts, command: string, args: string[]): string[] {
  const readOnly = mounts.readOnly ?? [];
  const writable = mounts.writable ?? [];
  assertAbsolute([root, mounts.cwd, ...readOnly, ...writable]);
  const entries = [
    // A private /tmp first, so listed paths under the host's /tmp land on top of it.
    ...(mounts.tmp ? ["tmp"] : []),
    ...(mounts.proc ? ["proc"] : []),
    ...readOnly.map((p) => `ro:${p}`),
    ...writable.map((p) => `rw:${p}`),
  ];
  return [
    "--user",
    "--map-root-user",
    "--net",
    "--mount",
    "--pid",
    "--fork",
    "--kill-child=SIGKILL",
    "--ipc",
    "--uts",
    "--propagation",
    "private",
    "--",
    "/bin/sh",
    "-c",
    SANDBOX_SCRIPT,
    "wb-sandbox",
    root,
    ...entries,
    "--",
    mounts.cwd,
    command,
    ...args,
  ];
}

/**
 * spawnSync, inside the sandbox. A timeout or kill hits `unshare`, and
 * --kill-child takes the whole sandbox with it. The caller decides the
 * environment: pass a minimal one, never process.env.
 */
export function runSandboxed(command: string, args: string[], mounts: SandboxMounts, options: SpawnSyncOptionsWithStringEncoding): SpawnSyncReturns<string> {
  // Under the OS temp directory, never inside a listed path: the tmpfs is
  // mounted on it in the private namespace only, so on the host it stays an
  // empty directory, removed (never recursively) afterwards.
  const root = mkdtempSync(path.join(tmpdir(), "wb-sandbox-root-"));
  try {
    return spawnSync("unshare", sandboxArgs(root, mounts, command, args), { ...options, cwd: mounts.cwd });
  } finally {
    try {
      rmdirSync(root);
    } catch {
      /* left empty; harmless */
    }
  }
}

/** The node binary's real path (bound read-only into the sandbox when it lives outside the system dirs). */
export function nodeBinary(): string {
  return realpathSync(process.execPath);
}

/** True when `p` is already visible inside through a system directory. */
export function underSystemDir(p: string): boolean {
  return SYSTEM_DIRS.some((d) => p === d || p.startsWith(`${d}/`));
}

/** The probe: what a child inside the sandbox can see and do. */
const PROBE = `
const fs = require("node:fs");
const os = require("node:os");
let write = "written";
try { fs.writeFileSync("wb-sandbox-probe-write", "x"); } catch (e) { write = e.code; }
let tmp = "written";
try { fs.writeFileSync("/tmp/wb-sandbox-probe-tmp", "x"); fs.rmSync("/tmp/wb-sandbox-probe-tmp"); } catch (e) { tmp = e.code; }
process.stdout.write(JSON.stringify({ cwd: process.cwd(), root: fs.readdirSync("/"), write, tmp, ifaces: Object.keys(os.networkInterfaces()), pid: process.pid }));
`;

function probe(): SandboxStatus {
  if (process.platform !== "linux") return { available: false, reason: `${process.platform} has no Linux namespaces` };
  const dir = mkdtempSync(path.join(tmpdir(), "wb-sandbox-probe-"));
  try {
    const node = nodeBinary();
    const run = runSandboxed(node, ["-e", PROBE], { readOnly: [dir, node], tmp: true, proc: true, cwd: dir }, {
      encoding: "utf8",
      timeout: 20_000,
      killSignal: "SIGKILL",
      env: { PATH: process.env.PATH ?? "" } as unknown as NodeJS.ProcessEnv,
    });
    if (run.error) return { available: false, reason: `could not start unshare: ${run.error.message}` };
    if (run.status !== 0) {
      const said = `${run.stderr ?? ""}\n${run.stdout ?? ""}`.trim().split("\n").filter(Boolean).slice(-2).join(" / ");
      return { available: false, reason: `the sandbox could not be built (needs unprivileged user namespaces and util-linux unshare, mount, chroot, setpriv): ${said.slice(0, 240) || `exit ${run.status}`}` };
    }
    let seen: { cwd: string; root: string[]; write: string; tmp: string; ifaces: string[]; pid: number };
    try {
      seen = JSON.parse(run.stdout);
    } catch {
      return { available: false, reason: `sandbox probe printed something unexpected: ${run.stdout.slice(0, 120)}` };
    }
    const allowed = new Set([...SYSTEM_DIRS, "/dev", "/etc", "/tmp", "/proc", `/${dir.split("/")[1]}`, `/${node.split("/")[1]}`].map((d) => d.slice(1)));
    const extra = seen.root.filter((name) => !allowed.has(name));
    const problems = [
      seen.cwd !== dir && `cwd is ${seen.cwd}`,
      extra.length > 0 && `host entries visible at /: ${extra.join(", ")}`,
      seen.write !== "EROFS" && `a read-only path was writable (${seen.write})`,
      seen.tmp !== "written" && `the private /tmp was not writable (${seen.tmp})`,
      seen.ifaces.some((i) => i !== "lo") && `network interfaces visible: ${seen.ifaces.join(", ")}`,
      seen.pid !== 1 && `not in its own PID namespace (pid ${seen.pid})`,
    ].filter(Boolean);
    if (problems.length) return { available: false, reason: `the sandbox did not contain the probe: ${problems.join("; ")}` };
    if (existsSync(path.join(dir, "wb-sandbox-probe-write"))) return { available: false, reason: "the probe wrote to the host" };
    return { available: true };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let cached: SandboxStatus | undefined;

/** Whether this machine can build the sandbox. Probed once per process, by running node inside it. */
export function detectSandbox(): SandboxStatus {
  cached ??= probe();
  return cached;
}

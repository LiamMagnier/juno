import "server-only";
import { createHash } from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { runDockerBuffer, spawnDockerStreaming, spawnDockerWithStdin } from "@/lib/docker-cli";
import { env } from "@/lib/env";
import {
  COMPUTER_NOT_RESPONDING,
  COMPUTER_PATH_REFUSED,
  COMPUTER_UNREACHABLE,
  ComputerError,
  isSafeAgentPath,
  scrubComputerText,
} from "./errors";
import type {
  ComputerFileEntry,
  ComputerHandle,
  ComputerProvider,
  Endpoints,
  ExecOptions,
  ExecResult,
  Shot,
} from "./types";

let loggedMissingImage = false;

/**
 * The `juno.security` label the image must carry (deploy/agent-computers/Dockerfile).
 * pipe-v4: every agent command starts through the exec launcher, no DNS, the
 * take-over primitives. `available()` refuses any other label, so a server that
 * still has an older image keeps computers off.
 */
export const COMPUTER_IMAGE_SECURITY_LABEL = "pipe-v4";

/**
 * Every agent (uid 1000) command starts through this launcher in the read-only
 * image (deploy/agent-computers/agent-exec.py); the broker refuses any other.
 * `run` is model-driven work and is refused while a person has control;
 * `helper` is the provider's own reads and the person's uploads.
 */
export const AGENT_LAUNCHER = "/opt/juno/agent-exec";
export type AgentLauncherMode = "run" | "helper";
/** What `agent-exec run` exits with while the agent is frozen for a take over. */
export const AGENT_FROZEN_EXIT = 75;

/** RFC 5737 (documentation, no resolver serves it): Docker's resolver forwards there and the firewall rejects port 53 to any address. */
export const COMPUTER_DNS_SENTINEL = "192.0.2.53";
/** The bridge gateway of the computers network as setup-vm.sh creates it: the only VNC client address. */
export const COMPUTER_NETWORK_GATEWAY = "172.30.0.1";
/** The browser uid's tmpfs the agent may read: the frozen marker and the sandbox state. */
export const COMPUTER_STATE_TMPFS = "/run/juno-state:rw,nosuid,nodev,noexec,size=64k,uid=1001,gid=1001,mode=0755";
const BROKER_POLICY_FILE = "/etc/juno/computer-broker.json";
/** Written by the browser uid at take over; `agent-exec run` refuses while it exists. */
export const FROZEN_MARKER = "/run/juno-state/frozen";
/** What cdp-gate.py recorded at start: on | off:kernel | off:chromium. */
export const BROWSER_SANDBOX_STATE = "/run/juno-state/browser-sandbox";
export const IMAGE_INFO_FORMAT = '{{.Id}}\t{{index .Config.Labels "juno.security"}}\t{{.Created}}';
/** COMPUTERS_2026-10.md 4.3: the wake refused because the namespace check failed. */
export const COMPUTER_SAFETY_CHECK_FAILED = "This computer failed a safety check, so it was not started.";

/** x-clients.py as the browser uid (it reads the X server's client list). */
function xClientsArgv(container: string, ...args: string[]): string[] {
  return ["exec", "--user", "1001", "-e", "DISPLAY=:0", container, "python3", "-I", "/opt/juno/x-clients.py", ...args];
}

/**
 * The seccomp profile the broker's policy requires, from the same policy file
 * the broker reads, so the argv built here and the broker's check can never
 * disagree: an absolute path when setup-vm.sh proved the launcher's namespace
 * ban on this host (`browserSandbox: true`), else null (Docker's default
 * profile, exactly as pipe-v3).
 */
export function seccompProfileFromPolicy(policy: unknown): string | null {
  if (!policy || typeof policy !== "object") return null;
  const { browserSandbox, seccompProfile } = policy as { browserSandbox?: unknown; seccompProfile?: unknown };
  if (browserSandbox !== true) return null;
  return typeof seccompProfile === "string" && seccompProfile.startsWith("/") && !seccompProfile.includes("\n")
    ? seccompProfile
    : null;
}

/**
 * Production: the broker's policy file. Elsewhere (no policy file), the
 * test-only JUNO_COMPUTER_SECCOMP_PROFILE (an absolute path, such as the repo's
 * deploy/agent-computers/seccomp-chromium.json); unset means Docker's default.
 */
export function computerSeccompProfile(
  nodeEnv: string | undefined = process.env.NODE_ENV,
  readPolicy: () => string = () => readFileSync(BROKER_POLICY_FILE, "utf8"),
): string | null {
  if (nodeEnv === "production") {
    try {
      return seccompProfileFromPolicy(JSON.parse(readPolicy()));
    } catch {
      return null;
    }
  }
  const local = (process.env.JUNO_COMPUTER_SECCOMP_PROFILE ?? "").trim();
  return local.startsWith("/") ? local : null;
}

/** `docker exec` argv for the agent's uid, through the launcher. */
export function agentExecArgv(
  container: string,
  mode: AgentLauncherMode,
  command: string[],
  opts?: { interactive?: boolean; workdir?: string },
): string[] {
  return [
    "exec",
    ...(opts?.interactive ? ["-i"] : []),
    "--user",
    "1000",
    ...(opts?.workdir ? ["--workdir", opts.workdir] : []),
    container,
    AGENT_LAUNCHER,
    mode,
    "--",
    ...command,
  ];
}

export interface DockerCreateArgvOptions {
  agentId: string;
  userId: string;
  platform?: NodeJS.Platform;
  nodeEnv?: string;
  memoryMb?: number;
  cpus?: number;
  image?: string;
  network?: string;
  /** Absolute path of the seccomp profile, or null for Docker's default (see computerSeccompProfile). */
  seccompProfile?: string | null;
  /**
   * A separate computer host's environment namespace (COMPUTERS_2026-10.md
   * D17): a fourth label, `juno.ns=<namespace>`, after the owner label. The
   * host builds this argv itself (deploy/computer-host/juno-computer-host.py);
   * the single-box provider never passes it.
   */
  namespace?: string;
}

/**
 * Builds the exact `docker create` argv mandated by INFRA.md.
 * Pure function so tests can verify both Linux production and macOS dev flags.
 */
export function buildDockerCreateArgv(opts: DockerCreateArgvOptions): string[] {
  const platform = opts.platform ?? process.platform;
  const nodeEnv = opts.nodeEnv ?? process.env.NODE_ENV ?? "development";
  const memoryMb = opts.memoryMb ?? env.agentComputer.memoryMb;
  const cpus = opts.cpus ?? env.agentComputer.cpus;
  const image = opts.image ?? env.agentComputer.image;
  const network = opts.network ?? env.agentComputer.network;
  const seccompProfile = opts.seccompProfile === undefined ? computerSeccompProfile(nodeEnv) : opts.seccompProfile;
  const name = `juno-agent-${opts.agentId}`;

  const argv: string[] = [
    "create",
    "--name",
    name,
    "--hostname",
    "computer",
    "--network",
    network,
    // No DNS from a computer (pipe-v4): every tool that honours HTTP(S)_PROXY
    // resolves names at the proxy; a lookup in the computer fails at once.
    "--dns",
    COMPUTER_DNS_SENTINEL,
    "--memory",
    `${memoryMb}m`,
    "--memory-swap",
    `${memoryMb}m`,
    "--cpus",
    String(cpus),
    "--pids-limit",
    "2048",
    "--shm-size",
    "1g",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    // Only where setup-vm.sh proved the launcher's namespace ban on this host:
    // Docker's profile plus what Chromium's own sandbox needs (D13).
    ...(seccompProfile ? ["--security-opt", `seccomp=${seccompProfile}`] : []),
    "--read-only",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=1g,mode=1777",
    "--tmpfs",
    "/run:rw,nosuid,nodev,size=64m",
    // The CDP token and VNC password handover: a tmpfs the daemon mounts
    // owned by the browser uid and 0700, so the agent (1000) can neither read
    // it nor plant anything in it, from the first instant of the container.
    "--tmpfs",
    "/run/juno:rw,nosuid,nodev,noexec,size=1m,uid=1001,gid=1001,mode=0700",
    // The frozen marker and the browser-sandbox state: readable by the agent,
    // writable only by the browser uid.
    "--tmpfs",
    COMPUTER_STATE_TMPFS,
    "--tmpfs",
    "/var/tmp:rw,nosuid,nodev,size=256m",
    "--mount",
    `type=volume,source=${name},target=/home/agent`,
    "--mount",
    `type=volume,source=${name}-browser,target=/home/browser`,
    "--label",
    "app=juno",
    "--label",
    `juno.agent=${opts.agentId}`,
    "--label",
    `juno.user=${opts.userId}`,
    ...(opts.namespace ? ["--label", `juno.ns=${opts.namespace}`] : []),
    // No `-e JUNO_CDP_TOKEN`: `docker exec` inherits a container's configured
    // env, so the agent's shell (and so the model) could print it with `env`.
    // The token reaches the gate through stdin into tmpfs after every start
    // (`provisionCdpToken`), and the gate deletes the file once it has it.
    "--restart",
    "no",
    "--stop-timeout",
    "20",
  ];

  if (platform === "darwin" && nodeEnv !== "production") {
    argv.push("-p", "127.0.0.1::9222", "-p", "127.0.0.1::5900");
  }

  argv.push(image);
  return argv;
}

async function runDockerText(
  argv: string[],
  options?: {
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
    maxBuffer?: number;
    allowNonZero?: boolean;
  }
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
  const res = await runDockerBuffer(argv, options);
  const out = {
    stdout: res.stdout.toString("utf8"),
    stderr: res.stderr.toString("utf8"),
    exitCode: res.exitCode,
    timedOut: res.timedOut,
  };
  if (res.exitCode !== 0 && !options?.allowNonZero) {
    throw dockerFailure(argv, res.exitCode, out.stderr || out.stdout);
  }
  return out;
}

/**
 * The whole capture in one `docker exec`: scrot writes the frame, cat hands it
 * back on stdout. A fixed string, so there is nothing to quote or inject.
 */
export const SCREENSHOT_SCRIPT = "scrot -o -z /tmp/juno-shot.png && cat /tmp/juno-shot.png";

export function screenshotArgv(container: string): string[] {
  // A helper, not model-driven work: the poster keeps working while a person
  // has control. The launcher sets DISPLAY.
  return agentExecArgv(container, "helper", ["sh", "-c", SCREENSHOT_SCRIPT]);
}

/** Whether docker (or the broker, exit 3) said the container does not exist. */
export function isMissingContainer(exitCode: number, stderr: string): boolean {
  return exitCode === 3 || /no such (container|object)|refused request: missing/i.test(stderr);
}

/** The most presses one `computer_key` call may send. */
const MAX_KEY_PRESSES = 32;

/**
 * "ctrl+l Return" → ["ctrl+l", "Return"]: xdotool presses each argument in
 * turn, but reads one argument holding a space as a single unknown key name,
 * so the space-separated sequences the tool accepts never reached it whole.
 */
export function keySequence(keys: string): string[] {
  return keys
    .split(/\s+/)
    .map((key) => key.trim())
    // After xdotool's `--`, so a name that starts with a dash is still a key.
    .filter((key) => key.length > 0 && key.length <= 64)
    .slice(0, MAX_KEY_PRESSES);
}

/**
 * Whether a resolved path inside the container is one the agent may write:
 * under /home/agent/work, with no dot-directory or dotfile on the way. Writing
 * `~/.bashrc`, `~/.profile` or `~/.config/autostart/*.desktop` would run what
 * the model wrote the next time a shell or the desktop starts, unasked.
 */
export function isAgentWorkAreaPath(resolved: string): boolean {
  const root = "/home/agent/work/";
  if (!resolved.startsWith(root)) return false;
  const rest = resolved.slice(root.length).split("/");
  return rest.length > 0 && rest.every((part) => part.length > 0 && !part.startsWith("."));
}

const PS_FORMAT = '{{.Names}}\t{{.Label "juno.agent"}}\t{{.Label "juno.user"}}\t{{.State}}';
const PROVISION_TOKEN_SCRIPT =
  "umask 077 && rm -f /run/juno/cdp-token.part && set -C && cat > /run/juno/cdp-token.part && mv -f /run/juno/cdp-token.part /run/juno/cdp-token";
const VNC_PASSWORD_SCRIPT = "umask 077 && rm -f /run/juno/vncpass && set -C && cat > /run/juno/vncpass";

/**
 * Every docker argv a computer is driven with, by operation. The DockerProvider
 * below sends exactly these through the broker; a separate computer host
 * (deploy/computer-host/juno-computer-host.py, `--print-argv`) builds the same
 * argv for the same inputs, with its namespace label and filters where noted,
 * and tests/computer-host-argv.test.ts holds the two together.
 */
export const computerArgv = {
  volumeCreate(agentId: string, volume: string, namespace?: string): string[] {
    return [
      "volume", "create", "--label", "app=juno", "--label", `juno.agent=${agentId}`,
      ...(namespace ? ["--label", `juno.ns=${namespace}`] : []),
      volume,
    ];
  },
  create: buildDockerCreateArgv,
  lifecycle(operation: "start" | "stop" | "pause" | "unpause", name: string): string[] {
    return [operation, name];
  },
  remove(name: string): string[] {
    return ["rm", "-f", name];
  },
  volumeRemove(volume: string): string[] {
    return ["volume", "rm", "-f", volume];
  },
  state(name: string): string[] {
    return ["inspect", "-f", "{{.State.Status}}", name];
  },
  address(name: string, network: string): string[] {
    return ["inspect", "-f", `{{(index .NetworkSettings.Networks ${JSON.stringify(network)}).IPAddress}}`, name];
  },
  containerImage(name: string): string[] {
    return ["inspect", "-f", "{{.Image}}", name];
  },
  imageLabel(image: string): string[] {
    return ["image", "inspect", "--format", '{{index .Config.Labels "juno.security"}}', image];
  },
  imageId(image: string): string[] {
    return ["image", "inspect", "--format", "{{.Id}}", image];
  },
  imageInfo(image: string): string[] {
    return ["image", "inspect", "--format", IMAGE_INFO_FORMAT, image];
  },
  provisionToken(name: string): string[] {
    return ["exec", "-i", "--user", "1001", name, "sh", "-c", PROVISION_TOKEN_SCRIPT];
  },
  tokenPending(name: string): string[] {
    return ["exec", "--user", "1001", name, "test", "-e", "/run/juno/cdp-token"];
  },
  screenshot(name: string): string[] {
    return screenshotArgv(name);
  },
  click(name: string, opts: { x: number; y: number; button?: "left" | "right" | "double" }): string[] {
    const command = ["xdotool", "mousemove", "--sync", String(Math.round(opts.x)), String(Math.round(opts.y)), "click"];
    if (opts.button === "double") command.push("--repeat", "2", "1");
    else if (opts.button === "right") command.push("3");
    else command.push("1");
    return agentExecArgv(name, "run", command);
  },
  type(name: string, text: string): string[] {
    return agentExecArgv(name, "run", ["xdotool", "type", "--delay", "12", "--", text]);
  },
  key(name: string, keys: string): string[] {
    return agentExecArgv(name, "run", ["xdotool", "key", "--", ...keySequence(keys)]);
  },
  scroll(name: string, opts: { x: number; y: number; dx?: number; dy?: number }): string[] {
    const dy = opts.dy ?? 0;
    const repeat = String(Math.max(1, Math.min(20, Math.round(Math.abs(dy || opts.dx || 3)))));
    const button = dy < 0 ? "4" : "5";
    return agentExecArgv(name, "run", [
      "xdotool", "mousemove", String(Math.round(opts.x)), String(Math.round(opts.y)), "click", "--repeat", repeat, button,
    ]);
  },
  drag(name: string, opts: { x1: number; y1: number; x2: number; y2: number }): string[] {
    return agentExecArgv(name, "run", [
      "xdotool", "mousemove", String(Math.round(opts.x1)), String(Math.round(opts.y1)), "mousedown", "1",
      "mousemove", String(Math.round(opts.x2)), String(Math.round(opts.y2)), "mouseup", "1",
    ]);
  },
  /** `seconds` is already clamped (1 to 300); `workdir` is already resolved under /home/agent. */
  exec(name: string, command: string, seconds: number, workdir: string): string[] {
    return agentExecArgv(
      name,
      "run",
      ["timeout", "--signal=TERM", "--kill-after=5", String(seconds), "bash", "--noprofile", "--norc", "-c", command],
      { workdir }
    );
  },
  realpath(name: string, candidate: string): string[] {
    return agentExecArgv(name, "helper", ["realpath", "-m", "--", candidate]);
  },
  list(name: string, dir: string): string[] {
    return agentExecArgv(name, "helper", ["find", dir, "-maxdepth", "1", "-mindepth", "1", "-printf", "%y\\t%s\\t%T@\\t%p\\n"]);
  },
  read(name: string, resolved: string, maxBytes: number): string[] {
    return agentExecArgv(name, "helper", ["head", "-c", String(maxBytes), "--", resolved]);
  },
  mkdir(name: string, dir: string, mode: AgentLauncherMode): string[] {
    return agentExecArgv(name, mode, ["mkdir", "-p", "--", dir]);
  },
  write(name: string, resolved: string, mode: AgentLauncherMode): string[] {
    return agentExecArgv(name, mode, ["sh", "-c", 'cat > "$1"', "sh", resolved], { interactive: true });
  },
  du(name: string): string[] {
    return agentExecArgv(name, "helper", ["du", "-sm", "/home/agent"]);
  },
  stat(name: string, resolved: string): string[] {
    return agentExecArgv(name, "helper", ["stat", "-c", "%s:%F", "--", resolved]);
  },
  vncKill(name: string): string[] {
    return ["exec", "--user", "1001", name, "pkill", "-x", "x11vnc"];
  },
  vncPassword(name: string): string[] {
    return ["exec", "-i", "--user", "1001", name, "sh", "-c", VNC_PASSWORD_SCRIPT];
  },
  /**
   * `allow` is the only VNC client address (the host side of the computers
   * network, where the relay or the host's tunnel dials from); null keeps the
   * macOS development arguments, where Docker's proxy publishes the port.
   */
  vncStart(name: string, allow: string | null): string[] {
    return [
      "exec", "--user", "1001", "-e", "DISPLAY=:0", name, "x11vnc", "-display", ":0", "-forever", "-shared",
      "-rfbport", "5900", "-noipv6", ...(allow ? ["-allow", allow] : []), "-passwdfile", "rm:/run/juno/vncpass",
      "-bg", "-o", "/tmp/x11vnc.log",
    ];
  },
  vncRunning(name: string): string[] {
    return ["exec", "--user", "1001", name, "pgrep", "-x", "x11vnc"];
  },
  listContainers(namespace?: string): string[] {
    return ["ps", "-a", "--filter", "label=app=juno", ...(namespace ? ["--filter", `label=juno.ns=${namespace}`] : []), "--format", PS_FORMAT];
  },
  listVolumes(namespace?: string): string[] {
    return [
      "volume", "ls", "--filter", "name=juno-agent-", ...(namespace ? ["--filter", `label=juno.ns=${namespace}`] : []),
      "--format", "{{.Name}}",
    ];
  },
  freeze(name: string): string[][] {
    return [
      ["exec", "--user", "1001", name, "touch", FROZEN_MARKER],
      ["exec", "--user", "1000", name, AGENT_LAUNCHER, "freeze"],
      xClientsArgv(name, "close-uid", "1000"),
      xClientsArgv(name, "release-all"),
    ];
  },
  thaw(name: string): string[][] {
    return [
      ["exec", "--user", "1001", name, "rm", "-f", FROZEN_MARKER],
      ["exec", "--user", "1000", name, AGENT_LAUNCHER, "thaw"],
    ];
  },
  sandboxState(name: string): string[] {
    return ["exec", "--user", "1001", name, "cat", BROWSER_SANDBOX_STATE];
  },
  sandboxProbe(name: string): string[] {
    return agentExecArgv(name, "helper", ["unshare", "-Ur", "true"]);
  },
};

/**
 * A failed `docker` call, as the rest of Juno may see it. The daemon's words
 * name the container and sometimes an address, so they are scrubbed and kept
 * for one log line; the error's message is a sentence with neither.
 */
function dockerFailure(argv: string[], exitCode: number, raw: string): ComputerError {
  const detail = `docker ${argv[0]} exited ${exitCode}: ${scrubComputerText(raw.trim())}`;
  console.warn("[agent-computer] docker call failed", { detail });
  return new ComputerError(COMPUTER_NOT_RESPONDING, detail);
}

function spawnWithStdin(argv: string[], input: Buffer, timeoutMs?: number): Promise<void> {
  return spawnDockerWithStdin(argv, input, timeoutMs).catch((err: unknown) => {
    throw dockerFailure(argv, 1, err instanceof Error ? err.message : String(err));
  });
}

export async function resolveContainerPath(
  handle: ComputerHandle,
  rawPath: string
): Promise<string> {
  assertRawAgentPath(rawPath);
  const candidate = rawPath.startsWith("/")
    ? rawPath
    : path.posix.join("/home/agent/work", rawPath);
  const { stdout } = await runDockerText(computerArgv.realpath(handle.name, candidate));
  // realpath runs as an argv (no shell, so no profile the agent could have
  // edited), and its answer is still checked as untrusted text: normalized,
  // no `..`, no newline, under /home/agent.
  const resolved = stdout.replace(/\n$/, "");
  if (!isSafeAgentPath(resolved) || path.posix.normalize(resolved) !== resolved) {
    throw new ComputerError(COMPUTER_PATH_REFUSED);
  }
  return resolved;
}

/** Validates a raw path before it is handed to the container at all. */
function assertRawAgentPath(rawPath: string): void {
  if (typeof rawPath !== "string" || rawPath.length === 0 || rawPath.length > 4096 || /[\0\r\n]/.test(rawPath)) {
    throw new ComputerError(COMPUTER_PATH_REFUSED);
  }
}

export class DockerProvider implements ComputerProvider {
  readonly name = "docker" as const;

  async available(): Promise<{ ok: boolean; reason?: string }> {
    const image = env.agentComputer.image;
    const res = await runDockerText(computerArgv.imageLabel(image), {
      allowNonZero: true,
      timeoutMs: 8_000,
    });
    // pipe-v4 (pipe-v3's split, plus the exec launcher, no DNS and the
    // take-over primitives). An older image fails closed here.
    if (res.exitCode !== 0 || res.stdout.trim() !== COMPUTER_IMAGE_SECURITY_LABEL) {
      if (!loggedMissingImage) {
        loggedMissingImage = true;
        console.warn(
          `[agent-computer] Docker image "${image}" not found; agent computers remain disabled.`
        );
      }
      return { ok: false, reason: "The protected browser image or Docker broker is not set up on this server." };
    }
    return { ok: true };
  }

  async preflight(): Promise<{ ok: boolean; reason?: string }> {
    const avail = await this.available();
    if (!avail.ok) return avail;

    if (process.platform === "linux") {
      try {
        const meminfo = await fs.readFile("/proc/meminfo", "utf8");
        const match = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB/m);
        if (match) {
          const availMb = Math.floor(Number(match[1]) / 1024);
          if (availMb < env.agentComputer.minFreeMemMb) {
            return {
              ok: false,
              reason:
                "The server doesn't have enough free memory to start another computer right now.",
            };
          }
        }
      } catch {
        // Ignore if /proc/meminfo is unreadable
      }
    }

    try {
      const stat = await fs.statfs("/");
      const freeBytes = Number(stat.bavail) * Number(stat.bsize);
      const freeMb = Math.floor(freeBytes / (1024 * 1024));
      if (freeMb < env.agentComputer.minFreeDiskMb) {
        return {
          ok: false,
          reason:
            "The server doesn't have enough free disk space to start another computer right now.",
        };
      }
    } catch {
      // Ignore if statfs is unsupported
    }

    return { ok: true };
  }

  async create(opts: {
    agentId: string;
    userId: string;
    cdpToken: string;
  }): Promise<ComputerHandle> {
    const pre = await this.preflight();
    if (!pre.ok) {
      throw new ComputerError(pre.reason ?? "The server cannot start another computer right now.");
    }

    const name = `juno-agent-${opts.agentId}`;
    const volume = `juno-agent-${opts.agentId}`;

    if (process.platform === "darwin" && process.env.NODE_ENV !== "production") {
      const network = env.agentComputer.network;
      const netCheck = await runDockerText(
        ["network", "inspect", network],
        { allowNonZero: true }
      );
      if (netCheck.exitCode !== 0) {
        // Same shape as setup-vm.sh: no container-to-container traffic.
        await runDockerText(
          [
            "network",
            "create",
            "--driver",
            "bridge",
            "-o",
            "com.docker.network.bridge.enable_icc=false",
            "--label",
            "app=juno",
            network,
          ],
          { allowNonZero: true }
        );
      }
    }

    await runDockerText(computerArgv.volumeCreate(opts.agentId, volume));
    await runDockerText(computerArgv.volumeCreate(opts.agentId, `${volume}-browser`));

    const createArgv = computerArgv.create({
      agentId: opts.agentId,
      userId: opts.userId,
    });

    const created = await runDockerText(createArgv, { allowNonZero: true });
    // Docker's unique name is the last fence if an expired creator wakes up.
    // It must never remove a container another worker has already created.
    if (created.exitCode !== 0 && await this.state({ name, volume }) === "missing") {
      throw dockerFailure(createArgv, created.exitCode, created.stderr || created.stdout);
    }

    return { name, volume };
  }

  /**
   * Hands the CDP gate its token after a start. Written through stdin (never
   * argv, never env) into /run/juno, a tmpfs Docker mounts 0700 for uid 1001
   * (the entrypoint refuses to start if it is anything else), created exclusively
   * (`set -C`), renamed into place so the gate never reads half a token, and
   * waited on until the gate has taken and deleted it, so the first browser
   * connection after a wake is not refused. Nothing the agent can write is on
   * that path, on a start or on an unpause while its processes are alive.
   */
  async provisionCdpToken(handle: ComputerHandle, token: string): Promise<void> {
    await spawnDockerWithStdin(computerArgv.provisionToken(handle.name), Buffer.from(token, "utf8"));
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const left = await runDockerText(
        computerArgv.tokenPending(handle.name),
        { allowNonZero: true, timeoutMs: 5_000 }
      );
      if (left.exitCode !== 0) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  async start(handle: ComputerHandle): Promise<void> {
    const pre = await this.preflight();
    if (!pre.ok) {
      throw new ComputerError(pre.reason ?? "The server cannot start another computer right now.");
    }
    await runDockerText(computerArgv.lifecycle("start", handle.name));
  }

  async pause(handle: ComputerHandle): Promise<void> {
    await runDockerText(computerArgv.lifecycle("pause", handle.name));
  }

  async unpause(handle: ComputerHandle): Promise<void> {
    await runDockerText(computerArgv.lifecycle("unpause", handle.name));
  }

  async stop(handle: ComputerHandle): Promise<void> {
    await runDockerText(computerArgv.lifecycle("stop", handle.name), {
      allowNonZero: true,
      timeoutMs: 30_000,
    });
  }

  async destroy(handle: ComputerHandle, opts?: { removeVolume?: boolean }): Promise<void> {
    // Already gone is done; anything else (daemon down, broker refusing, volume
    // in use) throws, so a teardown that left the person's files or site
    // sign-ins behind is never reported as finished.
    const remove = async (argv: string[]) => {
      const res = await runDockerText(argv, { allowNonZero: true });
      if (res.exitCode !== 0 && !/no such (container|volume)/i.test(res.stderr) && !isMissingContainer(res.exitCode, res.stderr)) {
        throw dockerFailure(argv, res.exitCode, res.stderr || res.stdout);
      }
    };
    await remove(computerArgv.remove(handle.name));
    if (opts?.removeVolume) {
      await remove(computerArgv.volumeRemove(`${handle.volume}-browser`));
      await remove(computerArgv.volumeRemove(handle.volume));
    }
  }

  async state(
    handle: ComputerHandle
  ): Promise<"running" | "paused" | "exited" | "missing"> {
    const argv = computerArgv.state(handle.name);
    const res = await runDockerText(argv, { allowNonZero: true });
    if (res.exitCode !== 0) {
      // Missing only when Docker says so (the broker's exit 3, or the daemon's
      // own words). A daemon or broker failure is not a missing computer:
      // reporting it as one made the store recreate the container (new CDP
      // token, "sign-ins may be gone") on any hiccup.
      if (isMissingContainer(res.exitCode, res.stderr)) return "missing";
      const failure = dockerFailure(argv, res.exitCode, res.stderr || res.stdout);
      throw new ComputerError(COMPUTER_UNREACHABLE, failure.detail);
    }
    const s = res.stdout.trim().toLowerCase();
    if (s === "running") return "running";
    if (s === "paused") return "paused";
    if (s === "created" || s === "exited" || s === "dead" || s === "Stopping") {
      return "exited";
    }
    return "exited";
  }

  async endpoints(handle: ComputerHandle): Promise<Endpoints> {
    if (process.platform === "darwin" && process.env.NODE_ENV !== "production") {
      const cdpPortOut = await runDockerText(["port", handle.name, "9222"]);
      const vncPortOut = await runDockerText(["port", handle.name, "5900"]);
      const parsePort = (raw: string): number => {
        const line = raw.trim().split("\n")[0] ?? "";
        const idx = line.lastIndexOf(":");
        const p = Number(idx >= 0 ? line.slice(idx + 1) : line);
        if (!Number.isFinite(p) || p <= 0) {
          throw new ComputerError(COMPUTER_UNREACHABLE, `unparseable published port: ${raw}`);
        }
        return p;
      };
      const cdpPort = parsePort(cdpPortOut.stdout);
      const vncPort = parsePort(vncPortOut.stdout);
      return {
        cdpUrl: `ws://127.0.0.1:${cdpPort}`,
        vncHost: "127.0.0.1",
        vncPort,
      };
    }

    const inspectOut = await runDockerText(computerArgv.address(handle.name, env.agentComputer.network));
    const ip = inspectOut.stdout.trim();
    if (!ip) {
      throw new ComputerError(COMPUTER_UNREACHABLE, "container has no address on the computers network");
    }
    return {
      cdpUrl: `ws://${ip}:9222`,
      vncHost: ip,
      vncPort: 5900,
    };
  }

  async screenshot(handle: ComputerHandle): Promise<Shot> {
    // One exec, not two: a `docker exec` costs tens of milliseconds before it
    // runs anything, and every step now captures at least twice while the
    // screen settles. The script is a constant — nothing is interpolated.
    const raw = await runDockerBuffer(computerArgv.screenshot(handle.name));
    if (raw.exitCode !== 0 || raw.stdout.byteLength === 0) {
      throw new ComputerError(COMPUTER_NOT_RESPONDING, "screenshot was empty");
    }
    const jpeg = await sharp(raw.stdout).jpeg({ quality: 70 }).toBuffer();
    const sha256 = createHash("sha256").update(jpeg).digest("hex");
    return {
      jpeg,
      width: 1280,
      height: 800,
      sha256,
    };
  }

  async click(
    handle: ComputerHandle,
    opts: { x: number; y: number; button?: "left" | "right" | "double" }
  ): Promise<void> {
    await runDockerText(computerArgv.click(handle.name, opts));
  }

  async type(handle: ComputerHandle, text: string): Promise<void> {
    await runDockerText(computerArgv.type(handle.name, text));
  }

  async key(handle: ComputerHandle, keys: string): Promise<void> {
    const sequence = keySequence(keys);
    if (sequence.length === 0) throw new ComputerError("Say which key to press.");
    await runDockerText(computerArgv.key(handle.name, keys));
  }

  async scroll(
    handle: ComputerHandle,
    opts: { x: number; y: number; dx?: number; dy?: number }
  ): Promise<void> {
    await runDockerText(computerArgv.scroll(handle.name, opts));
  }

  async drag(
    handle: ComputerHandle,
    opts: { x1: number; y1: number; x2: number; y2: number }
  ): Promise<void> {
    await runDockerText(computerArgv.drag(handle.name, opts));
  }

  async exec(
    handle: ComputerHandle,
    command: string,
    opts?: ExecOptions
  ): Promise<ExecResult> {
    const secs = Math.max(1, Math.min(300, Math.round(opts?.timeoutSeconds ?? 30)));
    // The working directory is an argv element to docker, validated under
    // /home/agent first; it is never interpolated into the command string.
    const workdir = opts?.cwd ? await resolveContainerPath(handle, opts.cwd) : "/home/agent/work";
    const started = Date.now();
    // Through the launcher (namespace ban, fixed environment with
    // HOME=/home/agent, refused while frozen), and `bash --noprofile --norc`:
    // no login or rc file the agent can write runs before an approved command.
    // Watched (S5.1): the same argv through `spawn`, output handed over as it
    // arrives; the result is decoded exactly as the buffered call decodes it.
    const argv = computerArgv.exec(handle.name, command, secs, workdir);
    const res = opts?.onOutput
      ? await spawnDockerStreaming(argv, opts.onOutput, { timeoutMs: (secs + 10) * 1000 }).then((streamed) => ({
          stdout: streamed.stdout.toString("utf8"),
          stderr: streamed.stderr.toString("utf8"),
          exitCode: streamed.exitCode,
          timedOut: streamed.timedOut,
        }))
      : await runDockerText(argv, {
          allowNonZero: true,
          timeoutMs: (secs + 10) * 1000,
        });
    return {
      stdout: res.stdout,
      stderr: res.stderr,
      exitCode: res.exitCode,
      timedOut: res.timedOut || res.exitCode === 124 || res.exitCode === 137,
      durationMs: Date.now() - started,
    };
  }

  async listFiles(
    handle: ComputerHandle,
    dir = "/home/agent/work"
  ): Promise<ComputerFileEntry[]> {
    const resolvedDir = await resolveContainerPath(handle, dir);
    const res = await runDockerText(computerArgv.list(handle.name, resolvedDir), { allowNonZero: true });
    if (res.exitCode !== 0) return [];
    const entries: ComputerFileEntry[] = [];
    for (const line of res.stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [typeCode, sizeStr, mtime, ...rest] = trimmed.split("\t");
      const fullPath = rest.join("\t");
      if (!fullPath) continue;
      const seconds = Number(mtime);
      entries.push({
        name: path.posix.basename(fullPath),
        path: fullPath,
        type: typeCode === "d" ? "dir" : typeCode === "f" ? "file" : "other",
        size: Number(sizeStr) || 0,
        ...(Number.isFinite(seconds) && seconds > 0 ? { modifiedAt: new Date(seconds * 1000).toISOString() } : {}),
      });
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  async readFile(
    handle: ComputerHandle,
    filePath: string,
    opts?: { maxBytes?: number }
  ): Promise<Buffer> {
    const resolved = await resolveContainerPath(handle, filePath);
    const maxBytes = opts?.maxBytes ?? 5 * 1024 * 1024;
    // `head -c` rather than `cat`: a file larger than the cap is cut, not
    // turned into a maxBuffer failure.
    const res = await runDockerBuffer(
      computerArgv.read(handle.name, resolved, maxBytes),
      { maxBuffer: maxBytes + 64 * 1024, timeoutMs: 60_000 }
    );
    if (res.exitCode !== 0) {
      throw new ComputerError("That file could not be read.", res.stderr.toString("utf8"));
    }
    return res.stdout.byteLength > maxBytes
      ? res.stdout.subarray(0, maxBytes)
      : res.stdout;
  }

  async writeFile(
    handle: ComputerHandle,
    filePath: string,
    content: Buffer | string,
    opts?: { by?: "agent" | "person" }
  ): Promise<void> {
    // The agent's writes are model-driven work (`run`: refused while a person
    // has control); the person's upload is a `helper` (it works while they do).
    const mode: AgentLauncherMode = opts?.by === "person" ? "helper" : "run";
    const resolved = await resolveContainerPath(handle, filePath);
    // The agent's only file write (`computer_files`). The runner refuses a
    // dotfile or anything outside /home/agent/work before it gets here; the
    // rule is applied again to the RESOLVED path, so a symlink under work/
    // pointing at ~/.bashrc or ~/.config/autostart cannot carry the write out.
    if (!isAgentWorkAreaPath(resolved)) {
      throw new Error("Files can only be written under /home/agent/work, and never into a dotfile or dot-folder.");
    }
    const parentDir = path.posix.dirname(resolved);
    await runDockerText(computerArgv.mkdir(handle.name, parentDir, mode));
    const buf =
      typeof content === "string"
        ? Buffer.from(content, "utf8")
        : Buffer.from(content);
    await spawnWithStdin(computerArgv.write(handle.name, resolved, mode), buf);
  }

  async diskUsageMb(handle: ComputerHandle): Promise<number> {
    const res = await runDockerText(
      computerArgv.du(handle.name),
      { allowNonZero: true }
    );
    if (res.exitCode !== 0) return 0;
    const firstToken = res.stdout.trim().split(/\s+/)[0] ?? "0";
    return Number(firstToken) || 0;
  }

  async startVnc(
    handle: ComputerHandle,
    opts: { controlPassword: string; viewPassword: string }
  ): Promise<void> {
    // The password file goes to /run/juno (tmpfs, 0700 uid 1001), never the
    // agent's volume or the shared /tmp, and x11vnc deletes it the moment it
    // has read it (`rm:`). A file left in /home/agent/.juno was readable by the
    // agent's shell, which runs as the same uid, so the model could have read
    // the control password.
    const passFileContent = Buffer.from(
      `${opts.controlPassword}\n__BEGIN_VIEWONLY__\n${opts.viewPassword}\n`,
      "utf8"
    );
    await runDockerText(computerArgv.vncKill(handle.name), { allowNonZero: true });
    // pkill only sends SIGTERM: the old server (the person's session) is
    // gone only once it has exited, and until then it holds port 5900, so a
    // new one started at once failed ("Address already in use") on a loaded
    // host and the rotation at hand back failed with it.
    await this.waitForVncExit(handle);
    await spawnWithStdin(computerArgv.vncPassword(handle.name), passFileContent);
    // Only the host side of the computers network (the relay dials from
    // there). The agent's own loopback and address are refused, so its shell
    // cannot reach the person's session. macOS development publishes the
    // port through Docker's proxy and keeps the old arguments.
    await runDockerText(computerArgv.vncStart(handle.name, process.platform === "linux" ? COMPUTER_NETWORK_GATEWAY : null));
  }

  async isVncRunning(handle: ComputerHandle): Promise<boolean> {
    const res = await runDockerText(
      // As the browser uid, which runs x11vnc: the agent's uid no longer gets
      // any exec that does not start through the launcher.
      computerArgv.vncRunning(handle.name),
      { allowNonZero: true, timeoutMs: 10_000 }
    );
    return res.exitCode === 0 && res.stdout.trim().length > 0;
  }

  async fileInfo(
    handle: ComputerHandle,
    rawPath: string
  ): Promise<{ type: "file" | "dir" | "other"; size: number; path: string } | null> {
    const resolved = await resolveContainerPath(handle, rawPath);
    const res = await runDockerText(
      computerArgv.stat(handle.name, resolved),
      { allowNonZero: true }
    );
    if (res.exitCode !== 0) return null;
    const [sizeStr, kind] = res.stdout.trim().split(":");
    return {
      path: resolved,
      size: Number(sizeStr) || 0,
      type: kind === "regular file" || kind === "regular empty file" ? "file" : kind === "directory" ? "dir" : "other",
    };
  }

  async listOwned(): Promise<{
    containers: Array<{ name: string; agentId: string | null; userId: string | null; state: "running" | "paused" | "exited" }>;
    volumes: string[];
  }> {
    const ps = await runDockerText(computerArgv.listContainers());
    const containers = ps.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        const [name, agentId, userId, state] = line.split("\t");
        // Only the names this provider creates, whatever else carries the label.
        if (!name || !name.startsWith("juno-agent-")) return [];
        return [
          {
            name,
            agentId: agentId || null,
            userId: userId || null,
            state: state === "running" ? ("running" as const) : state === "paused" ? ("paused" as const) : ("exited" as const),
          },
        ];
      });
    const vols = await runDockerText(computerArgv.listVolumes());
    const volumes = vols.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((name) => name.startsWith("juno-agent-"));
    return { containers, volumes };
  }

  async stopVnc(handle: ComputerHandle): Promise<void> {
    await runDockerText(computerArgv.vncKill(handle.name), { allowNonZero: true });
    // A take over that could not rotate the passwords ends the person's
    // session by stopping the stream, and thaws the agent after: stopped
    // means exited, not signalled (tests/computer-real-e2e.test.ts).
    await this.waitForVncExit(handle);
  }

  /**
   * Waits until no x11vnc runs (the same `pgrep` as isVncRunning), up to 10 s;
   * throws if one still does, so nothing is started beside it and no caller
   * takes a session that is still open for ended.
   */
  private async waitForVncExit(handle: ComputerHandle): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (await this.isVncRunning(handle)) {
      if (Date.now() >= deadline) {
        throw new ComputerError(COMPUTER_NOT_RESPONDING, "x11vnc did not exit after pkill");
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * Take over (COMPUTERS_2026-10.md D3, S2.4), in this order, every step through
   * the broker: (1) the frozen marker, written by the browser uid where the
   * agent can read but not remove it, so no new `agent-exec run` starts;
   * (2) `agent-exec freeze`: SIGSTOP every uid-1000 process until a /proc scan
   * finds none running (a fork loop or a command that slipped past the fence
   * is stopped with the rest); (3) every X client whose process belongs to the
   * agent is disconnected through the X server (by PID from the socket's
   * credentials, never by name), so a stopped typer resumed at hand back cannot
   * type; (4) every key and pointer button the X server reports down is
   * released (a typer stopped between a key's press and release would leave
   * it down, and autorepeat would go on typing it for the person; a cut chord
   * or drag would leave a modifier or button held). Every step runs even if
   * an earlier one failed (each makes the person safer), then the first
   * failure is thrown, and the store tells the person.
   */
  async freezeAgent(handle: ComputerHandle): Promise<void> {
    const what = ["frozen marker", "stop", "display connections", "held keys and buttons"];
    const steps = computerArgv.freeze(handle.name).map((argv, index) => ({ argv, what: what[index] }));
    let failure: ComputerError | null = null;
    for (const step of steps) {
      const res = await runDockerText(step.argv, { allowNonZero: true, timeoutMs: 20_000 });
      if (res.exitCode !== 0 && !failure) {
        failure = new ComputerError(
          COMPUTER_NOT_RESPONDING,
          `freeze step "${step.what}" exited ${res.exitCode}: ${res.stderr.trim()}`
        );
      }
    }
    if (failure) throw failure;
  }

  /** Hand back: the marker goes first, then every uid-1000 process gets SIGCONT. */
  async thawAgent(handle: ComputerHandle): Promise<void> {
    for (const argv of computerArgv.thaw(handle.name)) await runDockerText(argv, { timeoutMs: 20_000 });
  }

  /**
   * "on" only when the gate started Chromium with its own sandbox AND, checked
   * here from the agent's side, the agent still cannot create a user namespace
   * (D13). If it can, this throws and the store refuses the wake. "unknown"
   * when the gate has not recorded anything (Chromium is not running).
   */
  async browserSandbox(handle: ComputerHandle): Promise<"on" | "off" | "unknown"> {
    const recorded = await runDockerText(computerArgv.sandboxState(handle.name), {
      allowNonZero: true,
      timeoutMs: 10_000,
    });
    const probe = await runDockerText(computerArgv.sandboxProbe(handle.name), {
      allowNonZero: true,
      timeoutMs: 15_000,
    });
    if (probe.exitCode === 0) {
      throw new ComputerError(COMPUTER_SAFETY_CHECK_FAILED, "the agent's uid created a user namespace");
    }
    const banHolds = /operation not permitted/i.test(probe.stderr);
    if (recorded.exitCode !== 0) return "unknown";
    return recorded.stdout.trim() === "on" && banHolds ? "on" : "off";
  }

  /** Whether the container was made from another image than the current tag's (D16). */
  async isOutdated(handle: ComputerHandle): Promise<boolean> {
    const container = await runDockerText(computerArgv.containerImage(handle.name), { timeoutMs: 10_000 });
    const image = await runDockerText(computerArgv.imageId(env.agentComputer.image), {
      timeoutMs: 10_000,
    });
    const current = image.stdout.trim();
    return Boolean(current) && container.stdout.trim() !== current;
  }

  /** The current image's id, security label and build time (health, audit, the age check). */
  async imageInfo(): Promise<{ id: string; label: string; createdAt: string }> {
    const res = await runDockerText(
      computerArgv.imageInfo(env.agentComputer.image),
      { timeoutMs: 10_000 }
    );
    const [id = "", label = "", createdAt = ""] = res.stdout.trim().split("\t");
    return { id, label, createdAt };
  }
}


export const dockerComputerProvider = new DockerProvider();

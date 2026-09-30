import "server-only";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { runDockerBuffer, spawnDockerWithStdin } from "@/lib/docker-cli";
import { env } from "@/lib/env";
import type {
  ComputerFileEntry,
  ComputerHandle,
  ComputerProvider,
  Endpoints,
  ExecResult,
  Shot,
} from "./types";

let loggedMissingImage = false;

export interface DockerCreateArgvOptions {
  agentId: string;
  userId: string;
  platform?: NodeJS.Platform;
  nodeEnv?: string;
  memoryMb?: number;
  cpus?: number;
  image?: string;
  network?: string;
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
  const name = `juno-agent-${opts.agentId}`;

  const argv: string[] = [
    "create",
    "--name",
    name,
    "--hostname",
    "computer",
    "--network",
    network,
    "--dns",
    "1.1.1.1",
    "--dns",
    "9.9.9.9",
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
    "--read-only",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=1g,mode=1777",
    "--tmpfs",
    "/run:rw,nosuid,nodev,size=64m",
    "--tmpfs",
    "/var/tmp:rw,nosuid,nodev,size=256m",
    "--mount",
    `type=volume,source=${name},target=/home/agent`,
    "--label",
    "app=juno",
    "--label",
    `juno.agent=${opts.agentId}`,
    "--label",
    `juno.user=${opts.userId}`,
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
    throw new Error(
      `docker ${argv[0]} failed (exit ${res.exitCode}): ${out.stderr.trim() || out.stdout.trim()}`
    );
  }
  return out;
}

async function resolveContainerPath(
  handle: ComputerHandle,
  rawPath: string
): Promise<string> {
  const candidate = rawPath.startsWith("/")
    ? rawPath
    : path.posix.join("/home/agent/work", rawPath);
  const { stdout } = await runDockerText([
    "exec",
    "--user",
    "1000",
    handle.name,
    "realpath",
    "-m",
    "--",
    candidate,
  ]);
  const resolved = stdout.trim();
  if (resolved !== "/home/agent" && !resolved.startsWith("/home/agent/")) {
    throw new Error("Path must stay inside /home/agent");
  }
  return resolved;
}

export class DockerProvider implements ComputerProvider {
  readonly name = "docker" as const;

  async available(): Promise<{ ok: boolean; reason?: string }> {
    const image = env.agentComputer.image;
    const res = await runDockerText(["image", "inspect", image], {
      allowNonZero: true,
      timeoutMs: 8_000,
    });
    if (res.exitCode !== 0) {
      if (!loggedMissingImage) {
        loggedMissingImage = true;
        console.warn(
          `[agent-computer] Docker image "${image}" not found; agent computers remain disabled.`
        );
      }
      return { ok: false, reason: "Agent computer image is not set up on this server." };
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
      throw new Error(pre.reason ?? "The server cannot start another computer right now.");
    }

    const name = `juno-agent-${opts.agentId}`;
    const volume = `juno-agent-${opts.agentId}`;

    if (process.platform === "darwin" && process.env.NODE_ENV !== "production") {
      const network = env.agentComputer.network;
      const netCheck = await runDockerText(["network", "inspect", network], { allowNonZero: true });
      if (netCheck.exitCode !== 0) {
        // Same shape as setup-vm.sh: no container-to-container traffic.
        await runDockerText(
          ["network", "create", "--driver", "bridge", "-o", "com.docker.network.bridge.enable_icc=false", network],
          { allowNonZero: true }
        );
      }
    }

    await runDockerText(["volume", "create", volume]);

    // Remove any leftover container with the same name before creating
    await runDockerText(["rm", "-f", name], { allowNonZero: true });

    const createArgv = buildDockerCreateArgv({
      agentId: opts.agentId,
      userId: opts.userId,
    });

    await runDockerText(createArgv);

    return { name, volume };
  }

  /**
   * Hands the CDP gate its token after a start. Written to tmpfs through
   * stdin (never argv, never env), renamed into place so the gate never reads
   * half a token, and waited on until the gate has taken and deleted it, so
   * the first browser connection after a wake is not refused.
   */
  async provisionCdpToken(handle: ComputerHandle, token: string): Promise<void> {
    await spawnDockerWithStdin(
      [
        "exec",
        "-i",
        "--user",
        "1000",
        handle.name,
        "sh",
        "-c",
        "umask 077 && cat > /tmp/.juno-cdp-token.part && mv -f /tmp/.juno-cdp-token.part /tmp/.juno-cdp-token",
      ],
      Buffer.from(token, "utf8")
    );
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const left = await runDockerText(
        ["exec", "--user", "1000", handle.name, "test", "-e", "/tmp/.juno-cdp-token"],
        { allowNonZero: true, timeoutMs: 5_000 }
      );
      if (left.exitCode !== 0) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  async start(handle: ComputerHandle): Promise<void> {
    const pre = await this.preflight();
    if (!pre.ok) {
      throw new Error(pre.reason ?? "The server cannot start another computer right now.");
    }
    await runDockerText(["start", handle.name]);
  }

  async pause(handle: ComputerHandle): Promise<void> {
    await runDockerText(["pause", handle.name]);
  }

  async unpause(handle: ComputerHandle): Promise<void> {
    await runDockerText(["unpause", handle.name]);
  }

  async stop(handle: ComputerHandle): Promise<void> {
    await runDockerText(["stop", handle.name], {
      allowNonZero: true,
      timeoutMs: 30_000,
    });
  }

  async destroy(handle: ComputerHandle, opts?: { removeVolume?: boolean }): Promise<void> {
    await runDockerText(["rm", "-f", handle.name], { allowNonZero: true });
    if (opts?.removeVolume) {
      await runDockerText(["volume", "rm", "-f", handle.volume], {
        allowNonZero: true,
      });
    }
  }

  async state(
    handle: ComputerHandle
  ): Promise<"running" | "paused" | "exited" | "missing"> {
    const res = await runDockerText(
      ["inspect", "-f", "{{.State.Status}}", handle.name],
      { allowNonZero: true }
    );
    if (res.exitCode !== 0) return "missing";
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
          throw new Error(`Unable to parse published port from: ${raw}`);
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

    const inspectOut = await runDockerText([
      "inspect",
      "-f",
      `{{(index .NetworkSettings.Networks ${JSON.stringify(env.agentComputer.network)}).IPAddress}}`,
      handle.name,
    ]);
    const ip = inspectOut.stdout.trim();
    if (!ip) {
      throw new Error(`Container ${handle.name} has no IP on ${env.agentComputer.network}`);
    }
    return {
      cdpUrl: `ws://${ip}:9222`,
      vncHost: ip,
      vncPort: 5900,
    };
  }

  async screenshot(handle: ComputerHandle): Promise<Shot> {
    await runDockerText([
      "exec",
      "--user",
      "1000",
      "-e",
      "DISPLAY=:0",
      handle.name,
      "scrot",
      "-o",
      "-z",
      "/tmp/juno-shot.png",
    ]);
    const raw = await runDockerBuffer([
      "exec",
      "--user",
      "1000",
      handle.name,
      "cat",
      "/tmp/juno-shot.png",
    ]);
    if (raw.exitCode !== 0 || raw.stdout.byteLength === 0) {
      throw new Error("Failed to read screenshot from container");
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
    const x = String(Math.round(opts.x));
    const y = String(Math.round(opts.y));
    const argv = [
      "exec",
      "--user",
      "1000",
      "-e",
      "DISPLAY=:0",
      handle.name,
      "xdotool",
      "mousemove",
      "--sync",
      x,
      y,
      "click",
    ];
    if (opts.button === "double") {
      argv.push("--repeat", "2", "1");
    } else if (opts.button === "right") {
      argv.push("3");
    } else {
      argv.push("1");
    }
    await runDockerText(argv);
  }

  async type(handle: ComputerHandle, text: string): Promise<void> {
    await runDockerText([
      "exec",
      "--user",
      "1000",
      "-e",
      "DISPLAY=:0",
      handle.name,
      "xdotool",
      "type",
      "--delay",
      "12",
      "--",
      text,
    ]);
  }

  async key(handle: ComputerHandle, keys: string): Promise<void> {
    await runDockerText([
      "exec",
      "--user",
      "1000",
      "-e",
      "DISPLAY=:0",
      handle.name,
      "xdotool",
      "key",
      "--",
      keys,
    ]);
  }

  async scroll(
    handle: ComputerHandle,
    opts: { x: number; y: number; dx?: number; dy?: number }
  ): Promise<void> {
    const x = String(Math.round(opts.x));
    const y = String(Math.round(opts.y));
    const dy = opts.dy ?? 0;
    const repeat = String(
      Math.max(1, Math.min(20, Math.round(Math.abs(dy || opts.dx || 3))))
    );
    const button = dy < 0 ? "4" : "5";
    await runDockerText([
      "exec",
      "--user",
      "1000",
      "-e",
      "DISPLAY=:0",
      handle.name,
      "xdotool",
      "mousemove",
      x,
      y,
      "click",
      "--repeat",
      repeat,
      button,
    ]);
  }

  async drag(
    handle: ComputerHandle,
    opts: { x1: number; y1: number; x2: number; y2: number }
  ): Promise<void> {
    await runDockerText([
      "exec",
      "--user",
      "1000",
      "-e",
      "DISPLAY=:0",
      handle.name,
      "xdotool",
      "mousemove",
      String(Math.round(opts.x1)),
      String(Math.round(opts.y1)),
      "mousedown",
      "1",
      "mousemove",
      String(Math.round(opts.x2)),
      String(Math.round(opts.y2)),
      "mouseup",
      "1",
    ]);
  }

  async exec(
    handle: ComputerHandle,
    command: string,
    opts?: { timeoutSeconds?: number }
  ): Promise<ExecResult> {
    const secs = Math.max(1, Math.min(300, Math.round(opts?.timeoutSeconds ?? 30)));
    const started = Date.now();
    const res = await runDockerText(
      [
        "exec",
        "--user",
        "1000",
        "--workdir",
        "/home/agent/work",
        handle.name,
        "timeout",
        "--signal=TERM",
        "--kill-after=5",
        String(secs),
        "bash",
        "-lc",
        command,
      ],
      {
        allowNonZero: true,
        timeoutMs: (secs + 10) * 1000,
      }
    );
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
    const res = await runDockerText(
      [
        "exec",
        "--user",
        "1000",
        handle.name,
        "find",
        resolvedDir,
        "-maxdepth",
        "1",
        "-mindepth",
        "1",
        "-printf",
        "%y\\t%s\\t%p\\n",
      ],
      { allowNonZero: true }
    );
    if (res.exitCode !== 0) return [];
    const entries: ComputerFileEntry[] = [];
    for (const line of res.stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [typeCode, sizeStr, fullPath] = trimmed.split("\t");
      if (!fullPath) continue;
      entries.push({
        name: path.posix.basename(fullPath),
        path: fullPath,
        type: typeCode === "d" ? "dir" : typeCode === "f" ? "file" : "other",
        size: Number(sizeStr) || 0,
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
    const res = await runDockerBuffer(
      ["exec", "--user", "1000", handle.name, "cat", "--", resolved],
      { maxBuffer: maxBytes + 1024 }
    );
    if (res.exitCode !== 0) {
      throw new Error(
        `Failed to read ${resolved}: ${res.stderr.toString("utf8").trim()}`
      );
    }
    return res.stdout.byteLength > maxBytes
      ? res.stdout.subarray(0, maxBytes)
      : res.stdout;
  }

  async writeFile(
    handle: ComputerHandle,
    filePath: string,
    content: Buffer | string
  ): Promise<void> {
    const resolved = await resolveContainerPath(handle, filePath);
    const parentDir = path.posix.dirname(resolved);
    await runDockerText([
      "exec",
      "--user",
      "1000",
      handle.name,
      "mkdir",
      "-p",
      "--",
      parentDir,
    ]);
    const buf =
      typeof content === "string"
        ? Buffer.from(content, "utf8")
        : Buffer.from(content);
    await spawnDockerWithStdin(
      [
        "exec",
        "-i",
        "--user",
        "1000",
        handle.name,
        "sh",
        "-c",
        'cat > "$1"',
        "sh",
        resolved,
      ],
      buf
    );
  }

  async diskUsageMb(handle: ComputerHandle): Promise<number> {
    const res = await runDockerText(
      ["exec", "--user", "1000", handle.name, "du", "-sm", "/home/agent"],
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
    // The password file goes to tmpfs, never the agent's volume, and x11vnc
    // deletes it the moment it has read it (`rm:`). A file left in
    // /home/agent/.juno was readable by the agent's shell, which runs as the
    // same uid, so the model could have read the control password.
    const passFileContent = Buffer.from(
      `${opts.controlPassword}\n__BEGIN_VIEWONLY__\n${opts.viewPassword}\n`,
      "utf8"
    );
    await runDockerText(
      ["exec", "--user", "1000", handle.name, "pkill", "-x", "x11vnc"],
      { allowNonZero: true }
    );
    await spawnDockerWithStdin(
      [
        "exec",
        "-i",
        "--user",
        "1000",
        handle.name,
        "sh",
        "-c",
        "umask 077 && rm -f /tmp/.juno-vncpass /home/agent/.juno/vncpass && cat > /tmp/.juno-vncpass",
      ],
      passFileContent
    );
    await runDockerText([
      "exec",
      "--user",
      "1000",
      "-e",
      "DISPLAY=:0",
      handle.name,
      "x11vnc",
      "-display",
      ":0",
      "-forever",
      "-shared",
      "-rfbport",
      "5900",
      "-noipv6",
      "-passwdfile",
      "rm:/tmp/.juno-vncpass",
      "-bg",
      "-o",
      "/tmp/x11vnc.log",
    ]);
  }

  async stopVnc(handle: ComputerHandle): Promise<void> {
    await runDockerText(
      ["exec", "--user", "1000", handle.name, "pkill", "-x", "x11vnc"],
      { allowNonZero: true }
    );
  }
}

export const dockerComputerProvider = new DockerProvider();

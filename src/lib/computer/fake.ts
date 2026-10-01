import "server-only";
import { createHash } from "node:crypto";
import path from "node:path";
import sharp from "sharp";
import type {
  ComputerFileEntry,
  ComputerHandle,
  ComputerProvider,
  Endpoints,
  ExecResult,
  Shot,
} from "./types";

interface FakeContainerState {
  handle: ComputerHandle;
  agentId: string;
  userId: string;
  cdpToken: string;
  state: "running" | "paused" | "exited";
  vncRunning: boolean;
  vncControlPassword?: string;
  vncViewPassword?: string;
  /** The token the fake gate holds, set only by provisionCdpToken. */
  gateToken?: string;
}

let cachedGreyShotPromise: Promise<Shot> | null = null;

async function getGreyShot(): Promise<Shot> {
  if (!cachedGreyShotPromise) {
    cachedGreyShotPromise = (async () => {
      const jpeg = await sharp({
        create: {
          width: 1280,
          height: 800,
          channels: 3,
          background: { r: 224, g: 224, b: 224 },
        },
      })
        .jpeg({ quality: 70 })
        .toBuffer();
      const sha256 = createHash("sha256").update(jpeg).digest("hex");
      return { jpeg, width: 1280, height: 800, sha256 };
    })();
  }
  return cachedGreyShotPromise;
}

function normalizeAgentPath(rawPath: string): string {
  const base = rawPath.startsWith("/") ? rawPath : path.posix.join("/home/agent/work", rawPath);
  const resolved = path.posix.normalize(base);
  if (resolved !== "/home/agent" && !resolved.startsWith("/home/agent/")) {
    throw new Error("Path must stay inside /home/agent");
  }
  return resolved;
}

export class FakeProvider implements ComputerProvider {
  readonly name = "fake" as const;

  public calls: Array<{ method: string; args: unknown[] }> = [];
  public containers = new Map<string, FakeContainerState>();
  public volumes = new Map<string, Map<string, Buffer>>();
  public availableResult: { ok: boolean; reason?: string } = { ok: true };
  public preflightResult: { ok: boolean; reason?: string } = { ok: true };
  public diskUsageByVolume = new Map<string, number>();
  public defaultDiskUsageMb = 42;
  public execHandler?: (
    handle: ComputerHandle,
    command: string,
    opts?: { timeoutSeconds?: number }
  ) => Promise<ExecResult> | ExecResult;

  private record(method: string, ...args: unknown[]) {
    this.calls.push({ method, args });
  }

  reset(): void {
    this.calls = [];
    this.containers.clear();
    this.volumes.clear();
    this.diskUsageByVolume.clear();
    this.availableResult = { ok: true };
    this.preflightResult = { ok: true };
    this.defaultDiskUsageMb = 42;
    this.execHandler = undefined;
  }

  async available(): Promise<{ ok: boolean; reason?: string }> {
    this.record("available");
    return this.availableResult;
  }

  async preflight(): Promise<{ ok: boolean; reason?: string }> {
    this.record("preflight");
    return this.preflightResult;
  }

  async create(opts: {
    agentId: string;
    userId: string;
    cdpToken: string;
  }): Promise<ComputerHandle> {
    this.record("create", { agentId: opts.agentId, userId: opts.userId });
    const pre = await this.preflight();
    if (!pre.ok) {
      throw new Error(pre.reason ?? "Computer host preflight failed");
    }
    const handle: ComputerHandle = {
      name: `juno-agent-${opts.agentId}`,
      volume: `juno-agent-${opts.agentId}`,
    };
    if (!this.volumes.has(handle.volume)) {
      this.volumes.set(handle.volume, new Map());
    }
    this.containers.set(handle.name, {
      handle,
      agentId: opts.agentId,
      userId: opts.userId,
      cdpToken: opts.cdpToken,
      state: "exited",
      vncRunning: false,
    });
    return handle;
  }

  async start(handle: ComputerHandle): Promise<void> {
    this.record("start", handle);
    const pre = await this.preflight();
    if (!pre.ok) {
      throw new Error(pre.reason ?? "Computer host preflight failed");
    }
    const c = this.containers.get(handle.name);
    if (!c) {
      throw new Error(`Fake container missing: ${handle.name}`);
    }
    c.state = "running";
  }

  async pause(handle: ComputerHandle): Promise<void> {
    this.record("pause", handle);
    const c = this.containers.get(handle.name);
    if (!c) {
      throw new Error(`Fake container missing: ${handle.name}`);
    }
    c.state = "paused";
  }

  async unpause(handle: ComputerHandle): Promise<void> {
    this.record("unpause", handle);
    const c = this.containers.get(handle.name);
    if (!c) {
      throw new Error(`Fake container missing: ${handle.name}`);
    }
    c.state = "running";
  }

  async stop(handle: ComputerHandle): Promise<void> {
    this.record("stop", handle);
    const c = this.containers.get(handle.name);
    if (!c) {
      return;
    }
    c.state = "exited";
    c.vncRunning = false;
  }

  async destroy(handle: ComputerHandle, opts?: { removeVolume?: boolean }): Promise<void> {
    this.record("destroy", handle, opts);
    this.containers.delete(handle.name);
    if (opts?.removeVolume) {
      this.volumes.delete(handle.volume);
      this.diskUsageByVolume.delete(handle.volume);
    }
  }

  async state(handle: ComputerHandle): Promise<"running" | "paused" | "exited" | "missing"> {
    this.record("state", handle);
    const c = this.containers.get(handle.name);
    if (!c) return "missing";
    return c.state;
  }

  async endpoints(handle: ComputerHandle): Promise<Endpoints> {
    this.record("endpoints", handle);
    return {
      cdpUrl: "ws://127.0.0.1:9222",
      vncHost: "127.0.0.1",
      vncPort: 5900,
    };
  }

  async screenshot(handle: ComputerHandle): Promise<Shot> {
    this.record("screenshot", handle);
    const c = this.containers.get(handle.name);
    if (!c || c.state !== "running") {
      throw new Error(`Cannot screenshot non-running fake container: ${handle.name}`);
    }
    return getGreyShot();
  }

  async click(
    handle: ComputerHandle,
    opts: { x: number; y: number; button?: "left" | "right" | "double" }
  ): Promise<void> {
    this.record("click", handle, opts);
  }

  async type(handle: ComputerHandle, text: string): Promise<void> {
    this.record("type", handle, text);
  }

  async key(handle: ComputerHandle, keys: string): Promise<void> {
    this.record("key", handle, keys);
  }

  async scroll(
    handle: ComputerHandle,
    opts: { x: number; y: number; dx?: number; dy?: number }
  ): Promise<void> {
    this.record("scroll", handle, opts);
  }

  async drag(
    handle: ComputerHandle,
    opts: { x1: number; y1: number; x2: number; y2: number }
  ): Promise<void> {
    this.record("drag", handle, opts);
  }

  async exec(
    handle: ComputerHandle,
    command: string,
    opts?: { timeoutSeconds?: number; cwd?: string }
  ): Promise<ExecResult> {
    if (opts?.cwd) normalizeAgentPath(opts.cwd);
    this.record("exec", handle, command, opts);
    if (this.execHandler) {
      return await this.execHandler(handle, command, opts);
    }
    return {
      stdout: `${command}\n`,
      stderr: "",
      exitCode: 0,
      timedOut: false,
      durationMs: 5,
    };
  }

  async listFiles(handle: ComputerHandle, dir = "/home/agent/work"): Promise<ComputerFileEntry[]> {
    this.record("listFiles", handle, dir);
    const targetDir = normalizeAgentPath(dir);
    const fsMap = this.volumes.get(handle.volume) ?? new Map<string, Buffer>();
    const prefix = targetDir.endsWith("/") ? targetDir : `${targetDir}/`;
    const entries = new Map<string, ComputerFileEntry>();
    for (const [filePath, buf] of fsMap.entries()) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      if (!rest) continue;
      const slashIdx = rest.indexOf("/");
      if (slashIdx === -1) {
        entries.set(rest, {
          name: rest,
          path: `${prefix}${rest}`,
          type: "file",
          size: buf.byteLength,
        });
      } else {
        const subName = rest.slice(0, slashIdx);
        if (!entries.has(subName)) {
          entries.set(subName, {
            name: subName,
            path: `${prefix}${subName}`,
            type: "dir",
            size: 0,
          });
        }
      }
    }
    return Array.from(entries.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  async readFile(
    handle: ComputerHandle,
    filePath: string,
    opts?: { maxBytes?: number }
  ): Promise<Buffer> {
    this.record("readFile", handle, filePath, opts);
    const resolved = normalizeAgentPath(filePath);
    const fsMap = this.volumes.get(handle.volume);
    const buf = fsMap?.get(resolved);
    if (!buf) {
      throw new Error(`File not found: ${resolved}`);
    }
    const maxBytes = opts?.maxBytes ?? 5 * 1024 * 1024;
    if (buf.byteLength > maxBytes) {
      return buf.subarray(0, maxBytes);
    }
    return Buffer.from(buf);
  }

  async writeFile(
    handle: ComputerHandle,
    filePath: string,
    content: Buffer | string
  ): Promise<void> {
    this.record("writeFile", handle, filePath);
    const resolved = normalizeAgentPath(filePath);
    let fsMap = this.volumes.get(handle.volume);
    if (!fsMap) {
      fsMap = new Map<string, Buffer>();
      this.volumes.set(handle.volume, fsMap);
    }
    const buf = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
    fsMap.set(resolved, buf);
  }

  async diskUsageMb(handle: ComputerHandle): Promise<number> {
    this.record("diskUsageMb", handle);
    return this.diskUsageByVolume.get(handle.volume) ?? this.defaultDiskUsageMb;
  }

  async startVnc(
    handle: ComputerHandle,
    opts: { controlPassword: string; viewPassword: string }
  ): Promise<void> {
    this.record("startVnc", handle);
    const c = this.containers.get(handle.name);
    if (!c) {
      throw new Error(`Fake container missing: ${handle.name}`);
    }
    c.vncRunning = true;
    c.vncControlPassword = opts.controlPassword;
    c.vncViewPassword = opts.viewPassword;
  }

  async isVncRunning(handle: ComputerHandle): Promise<boolean> {
    this.record("isVncRunning", handle);
    const c = this.containers.get(handle.name);
    return Boolean(c && c.state === "running" && c.vncRunning);
  }

  async provisionCdpToken(handle: ComputerHandle, token: string): Promise<void> {
    // Recorded without the token: the fake's call log is read by tests that
    // assert no secret is ever recorded anywhere.
    this.record("provisionCdpToken", handle);
    const c = this.containers.get(handle.name);
    if (c) c.gateToken = token;
  }

  async fileInfo(
    handle: ComputerHandle,
    rawPath: string
  ): Promise<{ type: "file" | "dir" | "other"; size: number; path: string } | null> {
    this.record("fileInfo", handle, rawPath);
    const resolved = normalizeAgentPath(rawPath);
    const fsMap = this.volumes.get(handle.volume) ?? new Map<string, Buffer>();
    const buf = fsMap.get(resolved);
    if (buf) return { type: "file", size: buf.byteLength, path: resolved };
    const prefix = resolved.endsWith("/") ? resolved : `${resolved}/`;
    for (const key of fsMap.keys()) {
      if (key.startsWith(prefix)) return { type: "dir", size: 0, path: resolved };
    }
    return resolved === "/home/agent" || resolved === "/home/agent/work"
      ? { type: "dir", size: 0, path: resolved }
      : null;
  }

  async listOwned(): Promise<{
    containers: Array<{ name: string; agentId: string | null; userId: string | null; state: "running" | "paused" | "exited" }>;
    volumes: string[];
  }> {
    this.record("listOwned");
    return {
      containers: Array.from(this.containers.values()).map((c) => ({
        name: c.handle.name,
        agentId: c.agentId,
        userId: c.userId,
        state: c.state,
      })),
      volumes: Array.from(this.volumes.keys()),
    };
  }

  async stopVnc(handle: ComputerHandle): Promise<void> {
    this.record("stopVnc", handle);
    const c = this.containers.get(handle.name);
    if (c) {
      c.vncRunning = false;
    }
  }

  /** The gate's token, as the Docker provider hands it over: never as env. */
  async provisionCdpToken(handle: ComputerHandle, token: string): Promise<void> {
    // Recorded without the token itself: the call log is read by tests.
    this.record("provisionCdpToken", handle);
    const c = this.containers.get(handle.name);
    if (c) c.cdpToken = token;
  }
}

export const fakeComputerProvider = new FakeProvider();

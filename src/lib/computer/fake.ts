import "server-only";
import { createHash } from "node:crypto";
import path from "node:path";
import sharp from "sharp";
import { COMPUTER_PATH_REFUSED, ComputerError } from "./errors";
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
  /** Set by freezeAgent, cleared by thawAgent. */
  frozen?: boolean;
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
    // As the Docker provider: a refused path is a sentence for the person.
    throw new ComputerError(COMPUTER_PATH_REFUSED);
  }
  return resolved;
}

/** The fake's calls a test can hold mid-flight (`holdNext`). */
type HeldMethod = "freezeAgent" | "thawAgent" | "startVnc" | "provisionCdpToken";

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
  /**
   * Frames a test wants the screen to show, by capture number (0-based), in
   * place of the plain grey one: a page that is still loading, then settles.
   */
  public screenshotHandler?: (handle: ComputerHandle, capture: number) => Promise<Shot> | Shot;
  private captures = 0;

  private record(method: string, ...args: unknown[]) {
    this.calls.push({ method, args });
  }

  /** Calls a test is holding (see `holdNext`), by method. */
  private holds = new Map<HeldMethod, { gate: Promise<void>; started: () => void }>();

  /**
   * Holds the next call of `method` before it acts, until `release` is called:
   * a slow `docker exec`, so a test can run something else meanwhile. The call
   * is recorded when it acts. `started` resolves once the held call is waiting.
   */
  holdNext(method: HeldMethod): { started: Promise<void>; release: () => void } {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const waiting = new Promise<void>((resolve) => (started = resolve));
    this.holds.set(method, { gate, started });
    return { started: waiting, release };
  }

  private async waitIfHeld(method: HeldMethod): Promise<void> {
    const hold = this.holds.get(method);
    if (!hold) return;
    this.holds.delete(method);
    hold.started();
    await hold.gate;
  }

  reset(): void {
    this.calls = [];
    this.holds.clear();
    this.containers.clear();
    this.volumes.clear();
    this.diskUsageByVolume.clear();
    this.availableResult = { ok: true };
    this.preflightResult = { ok: true };
    this.defaultDiskUsageMb = 42;
    this.execHandler = undefined;
    this.screenshotHandler = undefined;
    this.captures = 0;
    this.destroyError = undefined;
    this.freezeError = undefined;
    this.thawError = undefined;
    this.startVncError = undefined;
    this.stopVncError = undefined;
    this.stopError = undefined;
    this.sandboxAnswer = "off";
    this.sandboxError = undefined;
    this.outdated = false;
    this.image = { id: "sha256:fake-image", label: "pipe-v4", createdAt: new Date().toISOString() };
    for (const method of FakeProvider.OPTIONAL_METHODS) this.disabled.delete(method);
  }

  /*
   * The take-over and image primitives (types.ts). Each records its call so a
   * test can read the order (freeze, rotate, thaw), and each can be made to
   * fail. `withoutMethods` removes them, to stand in for a provider that has
   * none (the store then audits `freeze_unavailable`).
   */
  static readonly OPTIONAL_METHODS = ["freezeAgent", "thawAgent", "browserSandbox", "isOutdated", "imageInfo"] as const;
  private disabled = new Set<string>();
  public freezeError?: Error;
  public thawError?: Error;
  public startVncError?: Error;
  public stopVncError?: Error;
  public stopError?: Error;
  public sandboxAnswer: "on" | "off" | "unknown" = "off";
  public sandboxError?: Error;
  public outdated = false;
  public image: { id: string; label: string; createdAt: string } = {
    id: "sha256:fake-image",
    label: "pipe-v4",
    createdAt: new Date().toISOString(),
  };

  /** Hides the named optional methods (as `undefined`), as an older provider would. */
  withoutMethods(...names: Array<(typeof FakeProvider.OPTIONAL_METHODS)[number]>): void {
    for (const name of names) this.disabled.add(name);
  }

  get freezeAgent(): ((handle: ComputerHandle) => Promise<void>) | undefined {
    if (this.disabled.has("freezeAgent")) return undefined;
    return async (handle: ComputerHandle) => {
      await this.waitIfHeld("freezeAgent");
      this.record("freezeAgent", handle);
      if (this.freezeError) throw this.freezeError;
      const c = this.containers.get(handle.name);
      if (c) c.frozen = true;
    };
  }

  get thawAgent(): ((handle: ComputerHandle) => Promise<void>) | undefined {
    if (this.disabled.has("thawAgent")) return undefined;
    return async (handle: ComputerHandle) => {
      await this.waitIfHeld("thawAgent");
      this.record("thawAgent", handle);
      if (this.thawError) throw this.thawError;
      const c = this.containers.get(handle.name);
      if (c) c.frozen = false;
    };
  }

  get browserSandbox(): ((handle: ComputerHandle) => Promise<"on" | "off" | "unknown">) | undefined {
    if (this.disabled.has("browserSandbox")) return undefined;
    return async (handle: ComputerHandle) => {
      this.record("browserSandbox", handle);
      if (this.sandboxError) throw this.sandboxError;
      return this.sandboxAnswer;
    };
  }

  get isOutdated(): ((handle: ComputerHandle) => Promise<boolean>) | undefined {
    if (this.disabled.has("isOutdated")) return undefined;
    return async (handle: ComputerHandle) => {
      this.record("isOutdated", handle);
      return this.outdated;
    };
  }

  get imageInfo(): (() => Promise<{ id: string; label: string; createdAt: string }>) | undefined {
    if (this.disabled.has("imageInfo")) return undefined;
    return async () => {
      this.record("imageInfo");
      return { ...this.image };
    };
  }

  /** Whether the fake's agent processes are frozen (a take over is holding them). */
  isFrozen(handle: ComputerHandle): boolean {
    return this.containers.get(handle.name)?.frozen === true;
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
      // As the Docker provider: a preflight refusal is already a sentence for
      // the person, so it is a ComputerError and survives sanitising.
      throw new ComputerError(pre.reason ?? "The server cannot start another computer right now.");
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
      // As the Docker provider: a preflight refusal is already a sentence for
      // the person, so it is a ComputerError and survives sanitising.
      throw new ComputerError(pre.reason ?? "The server cannot start another computer right now.");
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
    if (this.stopError) throw this.stopError;
    const c = this.containers.get(handle.name);
    if (!c) {
      return;
    }
    c.state = "exited";
    c.vncRunning = false;
  }

  /** Set to make `destroy` fail, as a Docker daemon or broker outage does. */
  public destroyError?: Error;

  async destroy(handle: ComputerHandle, opts?: { removeVolume?: boolean }): Promise<void> {
    this.record("destroy", handle, opts);
    if (this.destroyError) throw this.destroyError;
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
    const capture = this.captures++;
    if (this.screenshotHandler) return await this.screenshotHandler(handle, capture);
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
    content: Buffer | string,
    opts?: { by?: "agent" | "person" }
  ): Promise<void> {
    this.record("writeFile", handle, filePath, { by: opts?.by ?? "agent" });
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
    await this.waitIfHeld("startVnc");
    this.record("startVnc", handle);
    if (this.startVncError) throw this.startVncError;
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
    if (this.stopVncError) throw this.stopVncError;
    const c = this.containers.get(handle.name);
    if (c) {
      c.vncRunning = false;
    }
  }

  /** The gate's token, as the Docker provider hands it over: never as env. */
  async provisionCdpToken(handle: ComputerHandle, token: string): Promise<void> {
    await this.waitIfHeld("provisionCdpToken");
    // Recorded without the token itself: the call log is read by tests.
    this.record("provisionCdpToken", handle);
    const c = this.containers.get(handle.name);
    if (c) {
      c.cdpToken = token;
      c.gateToken = token;
    }
  }
}

export const fakeComputerProvider = new FakeProvider();

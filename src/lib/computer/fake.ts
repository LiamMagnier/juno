import "server-only";
import { createHash } from "node:crypto";
import path from "node:path";
import sharp from "sharp";
import { ComputerError } from "./errors";
import { DESKTOP_HEIGHT, DESKTOP_WIDTH, splitKeySequence, zoomFrame } from "./capture";
import type {
  ComputerFileEntry,
  ComputerHandle,
  ComputerProvider,
  Endpoints,
  ExecResult,
  ScreenRegion,
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
  /** Where the pointer is, once anything moved it. */
  pointer?: { x: number; y: number };
  /** How many input actions have landed: each one changes the next frame. */
  inputs: number;
  /** The last frame `screenshot` returned, for `zoom`. */
  lastFrame?: Shot;
}

/**
 * A frame that shows what the fake was told to do: a pointer ring where the
 * last action landed and a bar that grows with every input. Enough for the
 * step record to have a different picture per step, which is what a filmstrip
 * and a crossfade are checked against by hand.
 */
async function renderSceneShot(pointer: { x: number; y: number }, inputs: number): Promise<Shot> {
  const x = Math.max(0, Math.min(DESKTOP_WIDTH, Math.round(pointer.x)));
  const y = Math.max(0, Math.min(DESKTOP_HEIGHT, Math.round(pointer.y)));
  const bar = Math.min(DESKTOP_WIDTH - 80, 40 + inputs * 48);
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${DESKTOP_WIDTH}" height="${DESKTOP_HEIGHT}">` +
      `<rect width="100%" height="100%" fill="rgb(224,224,224)"/>` +
      `<rect x="40" y="40" width="${DESKTOP_WIDTH - 80}" height="56" rx="10" fill="rgb(245,245,245)"/>` +
      `<rect x="40" y="120" width="${bar}" height="12" rx="6" fill="rgb(120,120,120)"/>` +
      `<circle cx="${x}" cy="${y}" r="18" fill="none" stroke="rgb(40,40,40)" stroke-width="4"/>` +
      `<circle cx="${x}" cy="${y}" r="3" fill="rgb(40,40,40)"/>` +
      `</svg>`
  );
  const jpeg = await sharp(svg).jpeg({ quality: 70 }).toBuffer();
  const sha256 = createHash("sha256").update(jpeg).digest("hex");
  return { jpeg, width: DESKTOP_WIDTH, height: DESKTOP_HEIGHT, sha256, captureMs: 0, settleMs: 0 };
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
    this.destroyError = undefined;
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
      inputs: 0,
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
    const shot = c.pointer ? await renderSceneShot(c.pointer, c.inputs) : { ...(await getGreyShot()), captureMs: 0, settleMs: 0 };
    c.lastFrame = shot;
    return shot;
  }

  /** As the Docker provider: here the screen never moves, so it has always settled. */
  async settledScreenshot(handle: ComputerHandle, opts?: { timeoutMs?: number }): Promise<Shot> {
    this.record("settledScreenshot", handle, opts);
    const shot = await this.screenshot(handle);
    return { ...shot, captureMs: 0, settleMs: 0 };
  }

  async zoom(handle: ComputerHandle, region: ScreenRegion): Promise<Shot> {
    this.record("zoom", handle, region);
    const c = this.containers.get(handle.name);
    const frame = c?.lastFrame ?? (await this.screenshot(handle));
    const zoomed = await zoomFrame(frame.jpeg, region, { frameWidth: frame.width, frameHeight: frame.height });
    const sha256 = createHash("sha256").update(zoomed.jpeg).digest("hex");
    return { jpeg: zoomed.jpeg, width: zoomed.width, height: zoomed.height, sha256, captureMs: 0, settleMs: 0 };
  }

  private landed(handle: ComputerHandle, point?: { x: number; y: number }): void {
    const c = this.containers.get(handle.name);
    if (!c) return;
    if (point) c.pointer = { x: point.x, y: point.y };
    else c.pointer ??= { x: DESKTOP_WIDTH / 2, y: DESKTOP_HEIGHT / 2 };
    c.inputs += 1;
  }

  async click(
    handle: ComputerHandle,
    opts: { x: number; y: number; button?: "left" | "right" | "double" }
  ): Promise<void> {
    this.record("click", handle, opts);
    this.landed(handle, opts);
  }

  async move(handle: ComputerHandle, opts: { x: number; y: number }): Promise<void> {
    this.record("move", handle, opts);
    this.landed(handle, opts);
  }

  async hover(handle: ComputerHandle, opts: { x: number; y: number; dwellMs?: number }): Promise<void> {
    this.record("hover", handle, opts);
    this.landed(handle, opts);
  }

  async type(handle: ComputerHandle, text: string): Promise<void> {
    this.record("type", handle, text);
    this.landed(handle);
  }

  /** Records the keys exactly as the Docker provider hands them to xdotool. */
  async key(handle: ComputerHandle, keys: string): Promise<void> {
    this.record("key", handle, keys, splitKeySequence(keys));
    this.landed(handle);
  }

  async scroll(
    handle: ComputerHandle,
    opts: { x: number; y: number; dx?: number; dy?: number }
  ): Promise<void> {
    this.record("scroll", handle, opts);
    this.landed(handle, opts);
  }

  async drag(
    handle: ComputerHandle,
    opts: { x1: number; y1: number; x2: number; y2: number }
  ): Promise<void> {
    this.record("drag", handle, opts);
    this.landed(handle, { x: opts.x2, y: opts.y2 });
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
    if (c) {
      c.cdpToken = token;
      c.gateToken = token;
    }
  }
}

export const fakeComputerProvider = new FakeProvider();

import "server-only";

export type ComputerStatus =
  | "asleep"
  | "starting"
  | "awake"
  | "resting"
  | "stopping"
  | "error";

export interface Shot {
  jpeg: Buffer;
  width: number;
  height: number;
  sha256: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
}

export interface Endpoints {
  cdpUrl: string;
  vncHost: string;
  vncPort: number;
}

export interface ComputerHandle {
  name: string;
  volume: string;
}

export interface ComputerSecrets {
  cdpToken: string;
  vncControlPassword?: string;
  vncViewPassword?: string;
}

export interface ComputerFileEntry {
  name: string;
  path: string;
  type: "file" | "dir" | "other";
  size: number;
  /** ISO time of the last change, when the provider knows it. */
  modifiedAt?: string;
}

export interface ComputerProvider {
  readonly name: "docker" | "fake";
  available(): Promise<{ ok: boolean; reason?: string }>;
  preflight(): Promise<{ ok: boolean; reason?: string }>;
  create(opts: { agentId: string; userId: string; cdpToken: string }): Promise<ComputerHandle>;
  start(handle: ComputerHandle): Promise<void>;
  pause(handle: ComputerHandle): Promise<void>;
  unpause(handle: ComputerHandle): Promise<void>;
  stop(handle: ComputerHandle): Promise<void>;
  destroy(handle: ComputerHandle, opts?: { removeVolume?: boolean }): Promise<void>;
  state(handle: ComputerHandle): Promise<"running" | "paused" | "exited" | "missing">;
  endpoints(handle: ComputerHandle): Promise<Endpoints>;
  screenshot(handle: ComputerHandle): Promise<Shot>;
  click(
    handle: ComputerHandle,
    opts: { x: number; y: number; button?: "left" | "right" | "double" }
  ): Promise<void>;
  type(handle: ComputerHandle, text: string): Promise<void>;
  key(handle: ComputerHandle, keys: string): Promise<void>;
  scroll(
    handle: ComputerHandle,
    opts: { x: number; y: number; dx?: number; dy?: number }
  ): Promise<void>;
  drag(
    handle: ComputerHandle,
    opts: { x1: number; y1: number; x2: number; y2: number }
  ): Promise<void>;
  exec(
    handle: ComputerHandle,
    command: string,
    opts?: { timeoutSeconds?: number; cwd?: string }
  ): Promise<ExecResult>;
  listFiles(handle: ComputerHandle, dir?: string): Promise<ComputerFileEntry[]>;
  readFile(handle: ComputerHandle, path: string, opts?: { maxBytes?: number }): Promise<Buffer>;
  writeFile(handle: ComputerHandle, path: string, content: Buffer | string): Promise<void>;
  diskUsageMb(handle: ComputerHandle): Promise<number>;
  /** `{ type, size }` of one path under /home/agent, or null when it does not exist. */
  fileInfo(handle: ComputerHandle, path: string): Promise<{ type: "file" | "dir" | "other"; size: number; path: string } | null>;
  /**
   * Hands the CDP gate its token after every start. Through stdin into tmpfs,
   * never through `-e`: `docker exec` inherits a container's configured env, so a
   * token passed that way is one `env` away from the agent's shell and the model.
   */
  provisionCdpToken(handle: ComputerHandle, token: string): Promise<void>;
  /** Whether x11vnc is running, so a stream the database thinks is on can be restarted. */
  isVncRunning(handle: ComputerHandle): Promise<boolean>;
  /** Every container this server created for agents (label `app=juno`), and every agent volume. */
  listOwned(): Promise<{
    containers: Array<{ name: string; agentId: string | null; userId: string | null; state: "running" | "paused" | "exited" }>;
    volumes: string[];
  }>;
  startVnc(
    handle: ComputerHandle,
    opts: { controlPassword: string; viewPassword: string }
  ): Promise<void>;
  stopVnc(handle: ComputerHandle): Promise<void>;
  /**
   * Hands the CDP gate its token after every start. Through stdin into tmpfs,
   * never through `-e`: `docker exec` inherits a container's configured env,
   * so a token passed that way is one `env` away from the agent's shell.
   */
  provisionCdpToken(handle: ComputerHandle, token: string): Promise<void>;
}

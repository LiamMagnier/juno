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
  /** The CDP gate: `ws://<computer>:9222` for Docker, the host's `/v1/tunnel` URL for a remote host. */
  cdpUrl: string;
  /**
   * Headers the CDP connection must carry besides `X-Juno-Cdp-Token` (a remote
   * host's single-use tunnel ticket, `X-Juno-Tunnel-Ticket`). When set, the URL
   * is used exactly as given (no path rewrite) and no subprotocol is offered.
   */
  cdpHeaders?: Record<string, string>;
  vncHost: string;
  vncPort: number;
  /**
   * A remote host's VNC tunnel: its origin and a single-use 60 s ticket for
   * port 5900, which the app seals into a version 2 relay token
   * (src/lib/computer/live-view.ts). Docker leaves it unset (version 1 tokens).
   */
  vncTunnel?: { origin: string; ticket: string };
}

/** What a caller of `endpoints()` needs, so a remote host mints only that one ticket. */
export type EndpointPurpose = "cdp" | "vnc";

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
  readonly name: "docker" | "fake" | "remote";
  available(): Promise<{ ok: boolean; reason?: string }>;
  preflight(): Promise<{ ok: boolean; reason?: string }>;
  create(opts: { agentId: string; userId: string; cdpToken: string }): Promise<ComputerHandle>;
  start(handle: ComputerHandle): Promise<void>;
  pause(handle: ComputerHandle): Promise<void>;
  unpause(handle: ComputerHandle): Promise<void>;
  stop(handle: ComputerHandle): Promise<void>;
  /** Throws if the container or a volume could not be removed (already gone is fine). */
  destroy(handle: ComputerHandle, opts?: { removeVolume?: boolean }): Promise<void>;
  state(handle: ComputerHandle): Promise<"running" | "paused" | "exited" | "missing">;
  /**
   * Where the CDP gate and the VNC server are reached. A remote host mints a
   * single-use tunnel ticket per call (only the one asked for, when `purpose`
   * is given), so callers ask again for every new connection.
   */
  endpoints(handle: ComputerHandle, opts?: { purpose?: EndpointPurpose }): Promise<Endpoints>;
  /** One capture of the whole desktop, in a single exec (capture and read together). */
  screenshot(handle: ComputerHandle): Promise<Shot>;
  click(
    handle: ComputerHandle,
    opts: { x: number; y: number; button?: "left" | "right" | "double" }
  ): Promise<void>;
  type(handle: ComputerHandle, text: string): Promise<void>;
  /** One key or chord, or several separated by spaces ("ctrl+l Return"), pressed in order. */
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
  /**
   * `by` says whose write it is: the agent's (the default; refused while the
   * agent is frozen for a take over) or the person's (an upload into the inbox,
   * which works while they have control). S2 maps them to the exec launcher's
   * `run` and `helper` modes.
   */
  writeFile(
    handle: ComputerHandle,
    path: string,
    content: Buffer | string,
    opts?: { by?: "agent" | "person" }
  ): Promise<void>;
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

  /*
   * The take-over and image primitives (docs/design/agents-v2/COMPUTERS_2026-10.md
   * §3.2). Required since S3: every provider (Docker, the remote host, the
   * fake) implements them, so none can silently skip a freeze. The store still
   * checks for them at run time and audits `freeze_unavailable` if one is
   * missing (a test's fake can hide them to stand in for an older provider).
   */

  /** D3: frozen marker, SIGSTOP every uid-1000 task until none runs, cut uid-1000 X clients,
   *  release modifiers and buttons. Throws ComputerError if a task still runs. Idempotent. */
  freezeAgent(handle: ComputerHandle): Promise<void>;
  /** Remove the frozen marker, then SIGCONT every uid-1000 task. Idempotent. */
  thawAgent(handle: ComputerHandle): Promise<void>;
  /** "on" only when Chromium runs with its own sandbox AND the agent cannot create a user
   *  namespace (D13); "unknown" when Chromium is not running. Throws ComputerError when the
   *  agent CAN create one; the store then refuses the wake. */
  browserSandbox(handle: ComputerHandle): Promise<"on" | "off" | "unknown">;
  /** Whether the container was created from another image than the current tag's (D16). */
  isOutdated(handle: ComputerHandle): Promise<boolean>;
  /** The current image: its id, security label and build time (health, audit, age check). */
  imageInfo(): Promise<{ id: string; label: string; createdAt: string }>;
}

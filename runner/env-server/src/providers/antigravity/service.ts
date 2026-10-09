/**
 * Antigravity as a normal Alevr provider (owner decision, 2026-10-09): Google's
 * official ACP runtime, installed by Alevr from Google's CDN (install.ts),
 * signed in with Google through the runtime's own 127.0.0.1 callback
 * (auth-support.ts), one private profile per instance.
 *
 * This service is what the ACP adapter and the registry ask about anything
 * Antigravity-specific: where the runtime is, how to launch it, what a probe
 * says (initialize only, plus whether the profile holds a saved sign-in), and
 * the install / sign-in / sign-out flows. Alevr never reads, copies or sends
 * the Google token; it lives in the runtime's own file inside the profile.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderAuthState, ProviderCapabilities, ProviderInstallState, ProviderInstance, ProviderModel } from "../../contracts/code-v2.js";
import { AcpClient, AcpError, type LaunchCommand } from "../acp/client.js";
import { EmptyResponseSchema, type InitializeResponse } from "../acp/schema.js";
import type { ProbeResult } from "../types.js";
import { describeError, newId, type Logger } from "../../util.js";
import {
  CallbackError,
  SIGN_IN_REQUIRED,
  authorizationUrlFromLine,
  cleanRuntimeTemp,
  forwardCallback,
  hasSavedSignIn,
  parseAuthorizationUrl,
  prepareProfile,
  runtimeEnv,
  validateCallbackUrl,
  verifyBrowserHelper,
  type AuthorizationRequest,
} from "./auth-support.js";
import { AntigravityInstaller, InstallError, type AntigravityExecutable } from "./install.js";
import type { AntigravityReleaseAsset } from "./release.js";

export const ANTIGRAVITY_PRESET = "antigravity";
const AUTH_TIMEOUT_MS = 5 * 60_000;
const START_TIMEOUT_MS = 120_000;
const METHOD = "oauth-personal";
const METHOD_LABEL = "Google account";

export class AntigravityError extends Error {
  constructor(
    readonly wireCode: "bad_request" | "not_found" | "not_ready" | "conflict" | "unsupported",
    message: string,
  ) {
    super(message);
  }
}

export interface AntigravityServiceOptions {
  dataDir: string;
  logger: Logger;
  /** Pushes install / auth / status changes to the registry (provider.updated). */
  publish?: (instanceId: string | "*", patch: Partial<ProviderInstance>) => void;
  /** Test seams. */
  release?: AntigravityReleaseAsset | null;
  fetchImpl?: typeof fetch;
  searchDirs?: () => string[];
  nodePath?: string;
  authTimeoutMs?: number;
}

interface Flow {
  id: string;
  instanceId: string;
  expiresAt: number;
  state: ProviderAuthState;
  client?: AcpClient;
  pending?: AuthorizationRequest;
  callbackSent: boolean;
  timer?: NodeJS.Timeout;
  done: Promise<void>;
  stopped: boolean;
}

/** What Antigravity honestly does through Alevr's ACP client. */
export function antigravityCapabilities(): ProviderCapabilities {
  return {
    steering: false,
    queue: true,
    interrupt: true,
    // session/load (resume) is declared by the runtime.
    resume: true,
    fork: false,
    // Files are restored by Alevr's checkpoints, but the runtime cannot rewind its conversation.
    rollback: false,
    // Antigravity plans with its own /plan command; Alevr's plan mode is not offered.
    planMode: false,
    approvals: ["ask", "auto-edit", "full"],
    // Alevr's own subagents through the injected MCP server (the runtime takes HTTP MCP).
    subagents: true,
    computerUse: false,
    contextTiers: false,
    effortLevels: [],
    // The runtime takes images, but Alevr's ACP client sends text and file paths only.
    images: false,
    mcpInjection: true,
  };
}

export function isAntigravity(instance: Pick<ProviderInstance, "id" | "kind">): boolean {
  return instance.kind === "acp" && instance.id.startsWith("acp:") && instance.id.slice(4).split(":")[0] === ANTIGRAVITY_PRESET;
}

export class AntigravityService {
  readonly installer: AntigravityInstaller;
  #flows = new Map<string, Flow>();
  #helperChecked = false;
  readonly #o: AntigravityServiceOptions;

  constructor(options: AntigravityServiceOptions) {
    this.#o = options;
    this.installer = new AntigravityInstaller({
      dataDir: options.dataDir,
      ...(options.release !== undefined ? { release: options.release } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.searchDirs ? { searchDirs: options.searchDirs } : {}),
      validate: (executable, version) => this.#validate(executable, version),
      onChange: (install) => {
        options.publish?.("*", { install });
        if (install.phase === "succeeded") options.publish?.("*", { status: "unknown", statusMessage: undefined });
      },
    });
  }

  get #node(): string {
    return this.#o.nodePath ?? process.execPath;
  }

  // ── Registry hooks ───────────────────────────────────────────────────

  /**
   * Filesystem-only detection for the registry: whether a runtime is there, or
   * why not. The registry never writes the resolved path back onto the
   * instance, so `binaryPath` stays what the user configured (an override).
   */
  detect(instance: ProviderInstance): { found: boolean; statusMessage?: string } {
    try {
      this.installer.resolve(this.#override(instance));
      return { found: true };
    } catch (error) {
      return { found: false, statusMessage: describeError(error) };
    }
  }

  /** Fields every Antigravity instance carries in provider.list / provider.updated. */
  decorate(instance: ProviderInstance): ProviderInstance {
    const flow = this.#flows.get(instance.id);
    return {
      ...instance,
      install: this.installer.state,
      auth: flow?.state ?? { phase: "idle", method: METHOD_LABEL },
    };
  }

  /** initialize only, plus a stat of the profile's token file. Never opens a session or a sign-in. */
  async probe(instance: ProviderInstance, timeoutMs = START_TIMEOUT_MS): Promise<ProbeResult> {
    let lease;
    try {
      lease = this.installer.acquire(this.#override(instance));
    } catch (error) {
      return { status: "not-installed", statusMessage: describeError(error) };
    }
    const profile = prepareProfile(this.#o.dataDir, instance.id, this.#node);
    const client = this.#client(instance, lease.executable, profile, { timeoutMs });
    try {
      const init = await client.start();
      const identity = identityProblem(init);
      if (identity) return { status: "error", statusMessage: identity };
      const signedIn = hasSavedSignIn(this.#o.dataDir, instance.id);
      const version = runtimeVersion(init);
      return {
        status: signedIn ? "ready" : "signed-out",
        statusMessage: signedIn ? undefined : "Sign in with Google to use Antigravity.",
        ...(version ? { version } : {}),
        ...(signedIn ? { account: { tokenSource: "google" } } : {}),
      } as ProbeResult;
    } catch (error) {
      return { status: "error", statusMessage: `Antigravity did not start: ${describeError(error)}` };
    } finally {
      await client.stop().catch(() => undefined);
      lease.release();
      cleanRuntimeTemp(this.#o.dataDir, instance.id);
    }
  }

  /** How a session launches the runtime. Throws a plain sentence when it cannot. */
  launch(instance: ProviderInstance): { launch: LaunchCommand; release: () => void; cleanup: () => void } {
    let lease;
    try {
      lease = this.installer.acquire(this.#override(instance));
    } catch (error) {
      throw new AntigravityError("not_ready", describeError(error));
    }
    if (!hasSavedSignIn(this.#o.dataDir, instance.id)) {
      lease.release();
      throw new AntigravityError("not_ready", SIGN_IN_REQUIRED);
    }
    const profile = prepareProfile(this.#o.dataDir, instance.id, this.#node);
    return {
      launch: this.#launchCommand(instance, lease.executable, profile),
      release: lease.release,
      cleanup: () => cleanRuntimeTemp(this.#o.dataDir, instance.id),
    };
  }

  /** The authenticate method every launch uses before session/new; a saved sign-in makes it instant. */
  get authMethod(): string {
    return METHOD;
  }

  // ── Install ───────────────────────────────────────────────────────────

  install(action: "start" | "cancel" | "remove", operationId?: string): ProviderInstallState {
    try {
      if (action === "start") return this.installer.start();
      if (action === "cancel") return this.installer.cancel(operationId);
      if ([...this.#flows.values()].some((f) => !f.stopped)) throw new InstallError("Finish or cancel the Google sign-in first.");
      return this.installer.remove();
    } catch (error) {
      if (error instanceof InstallError) throw new AntigravityError("conflict", error.message);
      throw error;
    }
  }

  // ── Sign-in ───────────────────────────────────────────────────────────

  /** Starts Google sign-in for one instance (or returns the one in progress). */
  async authStart(instance: ProviderInstance): Promise<ProviderAuthState> {
    const current = this.#flows.get(instance.id);
    if (current && !current.stopped) return current.state;
    let lease;
    try {
      lease = this.installer.acquire(this.#override(instance));
    } catch (error) {
      throw new AntigravityError("not_ready", describeError(error));
    }
    let profile;
    try {
      profile = prepareProfile(this.#o.dataDir, instance.id, this.#node);
      if (!this.#helperChecked) {
        await verifyBrowserHelper(profile, this.#node);
        this.#helperChecked = true;
      }
    } catch (error) {
      lease.release();
      throw new AntigravityError("not_ready", describeError(error));
    }
    const timeout = this.#o.authTimeoutMs ?? AUTH_TIMEOUT_MS;
    const flow: Flow = {
      id: newId("flow"),
      instanceId: instance.id,
      expiresAt: Date.now() + timeout,
      state: { phase: "starting", method: METHOD_LABEL, message: "Starting Google sign-in." },
      callbackSent: false,
      stopped: false,
      done: Promise.resolve(),
    };
    flow.state = { ...flow.state, flowId: flow.id, expiresAt: new Date(flow.expiresAt).toISOString() };
    this.#flows.set(instance.id, flow);
    this.#publish(flow);
    const client = this.#client(instance, lease.executable, profile, {
      timeoutMs: timeout,
      onAuthorizationUrl: (url) => this.#receiveUrl(flow, url),
    });
    flow.client = client;
    flow.timer = setTimeout(() => void this.#stop(flow, "failed", "Google sign-in expired. Start sign-in again."), timeout);
    flow.timer.unref?.();
    flow.done = (async () => {
      try {
        const init = await client.start();
        const identity = identityProblem(init);
        if (identity) throw new AntigravityError("not_ready", identity);
        await client.authenticate(METHOD);
        if (flow.stopped) return;
        this.#set(flow, { phase: "verifying", message: "Checking Antigravity access and models.", authorizationUrl: undefined });
        const created = await client.newSession({ cwd: profile.geminiHome, mcpServers: [] });
        const models = modelsFrom(created.configOptions);
        if (flow.stopped) return;
        this.#finish(flow, "succeeded", "Signed in with Google.");
        this.#o.publish?.(instance.id, { status: "ready", statusMessage: undefined, account: { tokenSource: "google" }, ...(models.length ? { models } : {}) });
      } catch (error) {
        if (!flow.stopped) this.#finish(flow, "failed", authFailure(error));
      } finally {
        await client.stop().catch(() => undefined);
        lease.release();
        cleanRuntimeTemp(this.#o.dataDir, instance.id);
      }
    })();
    return flow.state;
  }

  /** The redirect URL pasted from another device. Validated against this flow, then forwarded once. */
  async authComplete(instance: ProviderInstance, flowId: string | undefined, callbackUrl: string | undefined): Promise<ProviderAuthState> {
    const flow = this.#requireFlow(instance.id, flowId);
    if (!callbackUrl) throw new AntigravityError("bad_request", "Paste the address of the page Google sent you to.");
    if (flow.callbackSent) throw new AntigravityError("conflict", "The sign-in response was already sent. Wait for Google to finish.");
    if (!flow.pending) throw new AntigravityError("conflict", "Wait for the Google sign-in link before you paste an address.");
    let callback: URL;
    try {
      callback = validateCallbackUrl(flow.pending, callbackUrl);
    } catch (error) {
      throw new AntigravityError("bad_request", error instanceof CallbackError ? error.message : "That address is not a Google sign-in response.");
    }
    flow.callbackSent = true;
    this.#set(flow, { phase: "verifying", message: "Waiting for Google to finish sign-in.", authorizationUrl: undefined });
    try {
      await forwardCallback(callback);
    } catch (error) {
      await this.#stop(flow, "failed", error instanceof CallbackError ? error.message : "Could not deliver the sign-in response. Start sign-in again.");
      throw new AntigravityError("conflict", flow.state.message ?? "Sign-in failed.");
    }
    return flow.state;
  }

  async authCancel(instance: ProviderInstance, flowId: string | undefined): Promise<ProviderAuthState> {
    const flow = this.#requireFlow(instance.id, flowId);
    await this.#stop(flow, "cancelled", "Google sign-in was cancelled.");
    return flow.state;
  }

  /** Signs the instance out through the runtime's own `logout`. The caller stops the instance's sessions first. */
  async logout(instance: ProviderInstance): Promise<ProviderAuthState> {
    const flow = this.#flows.get(instance.id);
    if (flow && !flow.stopped) await this.#stop(flow, "cancelled", "Google sign-in was cancelled by sign-out.");
    let lease;
    try {
      lease = this.installer.acquire(this.#override(instance));
    } catch (error) {
      throw new AntigravityError("not_ready", describeError(error));
    }
    const profile = prepareProfile(this.#o.dataDir, instance.id, this.#node);
    const client = this.#client(instance, lease.executable, profile, { timeoutMs: 90_000 });
    try {
      const init = await client.start();
      if (!init.agentCapabilities?.auth?.logout) throw new AntigravityError("unsupported", "This Antigravity version cannot sign out. Install the current release.");
      await client.request("logout", {}, EmptyResponseSchema);
    } catch (error) {
      if (error instanceof AntigravityError) throw error;
      throw new AntigravityError("conflict", `Antigravity sign-out failed: ${describeError(error)}`);
    } finally {
      await client.stop().catch(() => undefined);
      lease.release();
      cleanRuntimeTemp(this.#o.dataDir, instance.id);
    }
    const state: ProviderAuthState = { phase: "idle", method: METHOD_LABEL, message: "Signed out of Google." };
    this.#flows.delete(instance.id);
    this.#o.publish?.(instance.id, { status: "signed-out", statusMessage: "Sign in with Google to use Antigravity.", account: undefined, auth: state });
    return state;
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.#flows.values()].map((f) => this.#stop(f, "cancelled", "Alevr's local environment stopped.")));
    const running = this.installer.state;
    if (running.phase === "downloading" || running.phase === "extracting" || running.phase === "verifying") {
      this.installer.cancel();
      await this.installer.settled().catch(() => undefined);
    }
  }

  /** Waits for a flow's runtime to exit (tests). */
  async settled(instanceId: string): Promise<ProviderAuthState | undefined> {
    const flow = this.#flows.get(instanceId);
    await flow?.done;
    return flow?.state;
  }

  // ── Internals ─────────────────────────────────────────────────────────

  /** A binaryPath on an Antigravity instance is always the user's own override (instances.json). */
  #override(instance: ProviderInstance): string | undefined {
    return instance.binaryPath?.trim() || undefined;
  }

  #launchCommand(instance: ProviderInstance, executable: AntigravityExecutable, profile: ReturnType<typeof prepareProfile>): LaunchCommand {
    return {
      command: executable.executablePath,
      args: [...(process.platform === "linux" ? ["--uid="] : []), ...(instance.launchArgs ?? [])],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...runtimeEnv(profile, executable.harnessPath, instance.env ?? {}) },
    };
  }

  #client(
    instance: ProviderInstance,
    executable: AntigravityExecutable,
    profile: ReturnType<typeof prepareProfile>,
    options: { timeoutMs: number; onAuthorizationUrl?: (url: string) => void },
  ): AcpClient {
    const onLine = (line: string) => {
      const url = authorizationUrlFromLine(line);
      if (url) options.onAuthorizationUrl?.(url);
    };
    return new AcpClient({
      launch: this.#launchCommand(instance, executable, profile),
      cwd: profile.geminiHome,
      // Nothing from the user's shell beyond the base allowlist: no ambient Google credentials.
      envPassthrough: [],
      clientInfo: { name: "alevr-env", version: "0.1.0" },
      requestTimeoutMs: options.timeoutMs,
      shutdownGraceMs: 1500,
      handlers: {
        onSessionUpdate: () => {},
        onRequestPermission: async () => ({ outcome: "cancelled" }),
        onTextLine: onLine,
        onStderrLine: onLine,
      },
      logger: { debug: (m) => this.#o.logger.debug(m), warn: (m) => this.#o.logger.debug(m), error: (m) => this.#o.logger.warn(m) },
    });
  }

  async #validate(executable: AntigravityExecutable, expectedVersion: string): Promise<void> {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alevr-agy-check-"));
    const probeId = `acp:antigravity:validate-${process.pid}`;
    const profile = prepareProfile(tmp, probeId, this.#node);
    const client = this.#client({ id: probeId, kind: "acp", label: "Antigravity", status: "unknown" }, executable, profile, { timeoutMs: 90_000 });
    try {
      const init = await client.start();
      const version = runtimeVersion(init) ?? "";
      if (
        identityProblem(init) ||
        !(version === expectedVersion || version.endsWith(`_${expectedVersion}`)) ||
        !init.authMethods?.some((m) => m.id === METHOD) ||
        !init.agentCapabilities?.auth?.logout
      ) {
        throw new InstallError("The downloaded runtime did not identify as the expected Google Antigravity release.");
      }
    } catch (error) {
      if (error instanceof InstallError) throw error;
      throw new InstallError(`The downloaded Antigravity runtime could not start on this Mac: ${describeError(error)}`);
    } finally {
      await client.stop().catch(() => undefined);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  #receiveUrl(flow: Flow, raw: string): void {
    if (flow.stopped) return;
    const request = parseAuthorizationUrl(raw);
    if (!request) return;
    if (flow.pending) {
      if (flow.pending.authorizationUrl !== request.authorizationUrl) void this.#stop(flow, "failed", "Antigravity started more than one Google sign-in. Start again.");
      return;
    }
    flow.pending = request;
    this.#set(flow, {
      phase: "waiting",
      authorizationUrl: request.authorizationUrl,
      message: "Open the Google sign-in page. On another device, paste the address it ends on here.",
    });
  }

  #requireFlow(instanceId: string, flowId: string | undefined): Flow {
    const flow = this.#flows.get(instanceId);
    if (!flow || flow.stopped || (flowId && flow.id !== flowId)) throw new AntigravityError("not_found", "This sign-in is no longer active. Start it again.");
    if (Date.now() >= flow.expiresAt) throw new AntigravityError("conflict", "Google sign-in expired. Start sign-in again.");
    return flow;
  }

  #set(flow: Flow, patch: Partial<ProviderAuthState>): void {
    const next: ProviderAuthState = { ...flow.state, ...patch };
    for (const key of Object.keys(patch) as (keyof ProviderAuthState)[]) if (patch[key] === undefined) delete next[key];
    flow.state = next;
    this.#publish(flow);
  }

  #finish(flow: Flow, phase: "succeeded" | "failed" | "cancelled", message: string): void {
    if (flow.stopped) return;
    flow.stopped = true;
    if (flow.timer) clearTimeout(flow.timer);
    flow.pending = undefined;
    this.#set(flow, { phase, message, authorizationUrl: undefined, expiresAt: undefined });
  }

  async #stop(flow: Flow, phase: "failed" | "cancelled", message: string): Promise<void> {
    this.#finish(flow, phase, message);
    await flow.client?.stop().catch(() => undefined);
    await flow.done.catch(() => undefined);
  }

  #publish(flow: Flow): void {
    this.#o.publish?.(flow.instanceId, { auth: { ...flow.state } });
  }
}

function runtimeVersion(init: InitializeResponse): string | undefined {
  return typeof init.agentInfo?.version === "string" ? init.agentInfo.version : undefined;
}

function identityProblem(init: InitializeResponse): string | undefined {
  return init.agentInfo?.name === "antigravity-acp" ? undefined : "This runtime did not identify as Google's Antigravity.";
}

function modelsFrom(configOptions: unknown): ProviderModel[] {
  if (!Array.isArray(configOptions)) return [];
  const model = configOptions.find((o) => o && typeof o === "object" && (o as { id?: unknown }).id === "model") as
    | { currentValue?: unknown; options?: unknown[] }
    | undefined;
  if (!model || !Array.isArray(model.options)) return [];
  const flat: { value: string; name?: string }[] = [];
  for (const entry of model.options) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as { value?: unknown; name?: unknown; options?: unknown[] };
    if (typeof e.value === "string") flat.push({ value: e.value, ...(typeof e.name === "string" ? { name: e.name } : {}) });
    else if (Array.isArray(e.options)) {
      for (const inner of e.options) {
        const i = inner as { value?: unknown; name?: unknown };
        if (typeof i?.value === "string") flat.push({ value: i.value, ...(typeof i.name === "string" ? { name: i.name } : {}) });
      }
    }
  }
  return flat.slice(0, 50).map((o) => ({ id: o.value, label: o.name ?? o.value, ...(o.value === model.currentValue ? { isDefault: true } : {}) }));
}

function authFailure(error: unknown): string {
  if (error instanceof AntigravityError) return error.message;
  const text = describeError(error);
  if (/SUBSCRIPTION_REQUIRED/.test(text)) return "Google requires an eligible Antigravity plan for this account.";
  if (/access_denied|denied access|cancelled/i.test(text)) return "Google sign-in was not approved. Start sign-in again.";
  if (error instanceof AcpError && /session\/new/.test(text)) return "Antigravity signed in, but could not start a session or load models.";
  return "Google sign-in failed. Start sign-in again.";
}

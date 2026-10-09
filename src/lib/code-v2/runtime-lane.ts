/**
 * The env-server commands the runtime lane (branch code-v3/runtime) adds to
 * the alevr-code-v2 wire, mirrored here so the web can call them before that
 * branch merges: rejecting a hunk on the Mac (`checkpoint.applyPatch` with
 * `reverse`), resume at reset (`turn.schedule` / `turn.unschedule`, the
 * `session.scheduled` event), and runtimes Alevr installs and signs in itself
 * (`provider.install`, `provider.auth`: Antigravity).
 *
 * TYPED STUB: once code-v3/runtime is merged, these types live in
 * ./contracts.ts. Delete the mirrored declarations below, import them from
 * there, and `runtimeRequest` becomes a plain `client.request`. The shapes are
 * copied field for field from that branch's contract, so nothing else changes.
 */
import type { EnvClient } from "./env-client";
import type { ClientCommandType, ProviderInstance, UserInput } from "./contracts";

// ── Mirrored from code-v3/runtime src/lib/code-v2/contracts.ts ─────────────

export interface ScheduledResume {
  id: string;
  /** ISO-8601. */
  at: string;
  /** ISO-8601. */
  createdAt: string;
  /** What is sent when it fires; absent means "continue where the limit stopped you". */
  input?: UserInput;
}

export type ProviderInstallPhase = "idle" | "downloading" | "extracting" | "verifying" | "succeeded" | "failed" | "cancelled";
export interface ProviderInstallState {
  phase: ProviderInstallPhase;
  operationId?: string;
  downloadedBytes?: number;
  totalBytes?: number;
  version?: string;
  installedVersion?: string;
  message?: string;
}

export type ProviderAuthPhase = "idle" | "starting" | "waiting" | "verifying" | "succeeded" | "failed" | "cancelled";
/**
 * A browser sign-in the vendor runtime runs on 127.0.0.1 of the Mac. `waiting`
 * carries the vendor's own authorization URL; a browser on that Mac finishes
 * on its own, another device pastes the redirect URL back (`complete`).
 */
export interface ProviderAuthState {
  phase: ProviderAuthPhase;
  flowId?: string;
  authorizationUrl?: string;
  /** ISO-8601; the flow is abandoned after this. */
  expiresAt?: string;
  message?: string;
  /** How the instance signs in ("Google account"). */
  method?: string;
}

export type ProviderInstallAction = "start" | "cancel" | "remove";
export type ProviderAuthAction = "start" | "complete" | "cancel" | "logout";

export interface RuntimeLaneParams {
  "checkpoint.applyPatch": { sessionId: string; patch: string; reverse?: boolean; checkOnly?: boolean };
  "turn.schedule": { sessionId: string; at?: string; input?: UserInput };
  "turn.unschedule": { sessionId: string; scheduleId?: string };
  "provider.install": { instanceId: string; action: ProviderInstallAction; operationId?: string };
  "provider.auth": { instanceId: string; action: ProviderAuthAction; flowId?: string; callbackUrl?: string };
}

export interface RuntimeLaneResults {
  "checkpoint.applyPatch": { applied: boolean; files: string[] };
  "turn.schedule": { schedule: ScheduledResume };
  "turn.unschedule": { cancelled: boolean };
  "provider.install": { install: ProviderInstallState };
  "provider.auth": { auth: ProviderAuthState };
}

export type RuntimeLaneCommand = keyof RuntimeLaneParams;

export const RUNTIME_LANE_COMMANDS: readonly RuntimeLaneCommand[] = ["checkpoint.applyPatch", "turn.schedule", "turn.unschedule", "provider.install", "provider.auth"];

/** A provider instance with the runtime lane's optional install / sign-in state. */
export type RuntimeLaneInstance = ProviderInstance & { install?: ProviderInstallState; auth?: ProviderAuthState };

// ── Calls ───────────────────────────────────────────────────────────────────

type LooseRequest = (type: string, params: unknown) => Promise<unknown>;

/** `client.request` for a runtime-lane command (see the note at the top). */
export function runtimeRequest<T extends RuntimeLaneCommand>(client: Pick<EnvClient, "request">, type: T, params: RuntimeLaneParams[T]): Promise<RuntimeLaneResults[T]> {
  return (client.request as unknown as LooseRequest).call(client, type, params) as Promise<RuntimeLaneResults[T]>;
}

/** The command types as the wire's own union, for allow-lists typed on it. */
export const RUNTIME_LANE_COMMAND_TYPES = RUNTIME_LANE_COMMANDS as unknown as readonly ClientCommandType[];


/** Connections' managed install / sign-in, as one call on the Mac's env server. */
export async function managedCall(
  client: Pick<EnvClient, "request">,
  instanceId: string,
  op: { type: "install"; action: ProviderInstallAction; operationId?: string } | { type: "auth"; action: ProviderAuthAction; flowId?: string; callbackUrl?: string },
): Promise<{ install?: ProviderInstallState; auth?: ProviderAuthState }> {
  if (op.type === "install") {
    const { install } = await runtimeRequest(client, "provider.install", { instanceId, action: op.action, ...(op.operationId ? { operationId: op.operationId } : {}) });
    return { install };
  }
  const { auth } = await runtimeRequest(client, "provider.auth", {
    instanceId,
    action: op.action,
    ...(op.flowId ? { flowId: op.flowId } : {}),
    ...(op.callbackUrl ? { callbackUrl: op.callbackUrl } : {}),
  });
  return { auth };
}

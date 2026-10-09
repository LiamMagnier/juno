/**
 * The env-server commands the runtime lane added to the alevr-code-v2 wire:
 * rejecting a hunk on the Mac (`checkpoint.applyPatch` with `reverse`), resume
 * at reset (`turn.schedule` / `turn.unschedule`, the `session.scheduled`
 * event), and runtimes Alevr installs and signs in itself (`provider.install`,
 * `provider.auth`: Antigravity). The types live in ./contracts.ts; this module
 * keeps the names the web callers use.
 */
import type { EnvClient } from "./env-client";
import type {
  ClientCommandParams,
  ClientCommandResults,
  ClientCommandType,
  ProviderAuthAction,
  ProviderAuthState,
  ProviderInstallAction,
  ProviderInstallState,
  ProviderInstance,
} from "./contracts";

export type {
  ProviderAuthAction,
  ProviderAuthPhase,
  ProviderAuthState,
  ProviderInstallAction,
  ProviderInstallPhase,
  ProviderInstallState,
  ScheduledResume,
} from "./contracts";

export type RuntimeLaneCommand = "checkpoint.applyPatch" | "turn.schedule" | "turn.unschedule" | "provider.install" | "provider.auth";
export type RuntimeLaneParams = Pick<ClientCommandParams, RuntimeLaneCommand>;
export type RuntimeLaneResults = Pick<ClientCommandResults, RuntimeLaneCommand>;

export const RUNTIME_LANE_COMMANDS: readonly RuntimeLaneCommand[] = ["checkpoint.applyPatch", "turn.schedule", "turn.unschedule", "provider.install", "provider.auth"];

/** The contract's ProviderInstance already carries `install` and `auth`. */
export type RuntimeLaneInstance = ProviderInstance;

/** `client.request` for a runtime-lane command. */
export function runtimeRequest<T extends RuntimeLaneCommand>(client: Pick<EnvClient, "request">, type: T, params: ClientCommandParams[T]): Promise<ClientCommandResults[T]> {
  return client.request(type, params);
}

/** The command types as the wire's own union, for allow-lists typed on it. */
export const RUNTIME_LANE_COMMAND_TYPES: readonly ClientCommandType[] = RUNTIME_LANE_COMMANDS;

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

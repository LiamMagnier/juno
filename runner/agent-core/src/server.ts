import crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type { ApprovalDecision, ApprovalRequest, PermissionMode } from './types.js';
import type { ProviderAdapter } from './providers/types.js';
import { createProvider, defaultProviderId, listProviders, type ProviderListing } from './providers/registry.js';
import {
  BACKEND_PROVIDER_PREFIX,
  createProxyProvider,
  proxyProviderListings,
  type BackendConfig,
} from './providers/proxy.js';
import { BackendUsageReporter, type UsageReporter } from './usage.js';
import { AgentSession } from './agent.js';
import { SessionStore } from './session.js';

/**
 * Model catalog for the picker: backend-proxied providers first (the website's
 * server-key models), then any locally-keyed providers. When the backend is
 * configured the proxy catalog is authoritative, so BYOK duplicates are hidden.
 */
function mergedListings(backendConfig: BackendConfig | null): ProviderListing[] {
  if (!backendConfig || backendConfig.models.length === 0) return listProviders();
  return proxyProviderListings(backendConfig);
}

/**
 * Local sidecar for native shells (macOS/iOS apps connect here; the session
 * relay for remote phones proxies the same protocol). NDJSON over WebSocket:
 *
 * client -> server:
 *   {type:'start', cwd, model?, mode?}          begin a new session
 *   {type:'resume', sessionId, mode?}           reattach to an existing session
 *   {type:'prompt', text}                       send a user message
 *   {type:'approval', callId, decision}         answer an approval_requested event
 *   {type:'set_mode', mode}                     switch permission mode
 *   {type:'undo'}                               roll back last turn's file changes
 *   {type:'diff', sinceTurn?}                   request unified diff
 *   {type:'list_sessions'}                      list stored sessions
 *   {type:'abort'}                              cancel the in-flight turn
 *
 * server -> client:
 *   {type:'event', event: AgentEvent}
 *   {type:'diff', patch}
 *   {type:'undo_result', restored}
 *   {type:'sessions', sessions}
 *   {type:'protocol_error', message}
 */
export interface SidecarOptions {
  /** Fallback adapter when a client doesn't name one (legacy callers). */
  provider?: ProviderAdapter;
  port: number;
  host?: string;
  /** Shared secret; when set, clients must send it as `?token=` on connect. */
  token?: string;
}

export function startSidecarServer(opts: SidecarOptions): WebSocketServer {
  const host = opts.host ?? '127.0.0.1';
  const wss = new WebSocketServer({ host, port: opts.port });

  wss.on('connection', (ws, req) => {
    if (opts.token) {
      const url = new URL(req.url ?? '/', `http://${host}`);
      const supplied = url.searchParams.get('token') ?? '';
      const ok =
        supplied.length === opts.token.length &&
        crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(opts.token));
      if (!ok) {
        ws.close(4001, 'invalid token');
        return;
      }
    }
    handleConnection(ws, opts.provider);
  });

  return wss;
}

function handleConnection(ws: WebSocket, fallback?: ProviderAdapter): void {
  let session: AgentSession | null = null;
  let running = false;
  /** Set by `configure_backend`: routes `backend/<id>` providers through the
   *  Juno backend proxy (server keys) and reports usage to the account plan. */
  let backendConfig: BackendConfig | null = null;

  /** Adapter for a client-chosen provider; falls back to the serve-time default. */
  const resolveAdapter = (id?: string): ProviderAdapter => {
    if (id && id.startsWith(BACKEND_PROVIDER_PREFIX)) {
      if (!backendConfig) throw new Error('Backend not configured; send configure_backend first.');
      return createProxyProvider(backendConfig, id);
    }
    if (id) return createProvider(id);
    if (fallback) return fallback;
    const auto = defaultProviderId();
    if (!auto) throw new Error('No provider has a configured API key.');
    return createProvider(auto);
  };

  /** Usage flows to the account plan only for backend-proxied providers. */
  const usageReporterFor = (providerId: string): UsageReporter | undefined => {
    if (backendConfig && providerId.startsWith(BACKEND_PROVIDER_PREFIX)) {
      return new BackendUsageReporter({ baseUrl: backendConfig.baseUrl, cookie: backendConfig.cookie });
    }
    return undefined;
  };
  const pendingApprovals = new Map<string, (d: ApprovalDecision) => void>();

  const send = (msg: unknown) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  const callbacks = {
    onEvent: (event: unknown) => send({ type: 'event', event }),
    requestApproval: (request: ApprovalRequest): Promise<ApprovalDecision> =>
      new Promise((resolve) => {
        pendingApprovals.set(request.callId, resolve);
      }),
  };

  ws.on('message', (raw) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(raw)) as Record<string, unknown>;
    } catch {
      send({ type: 'protocol_error', message: 'invalid JSON' });
      return;
    }
    void (async () => {
      try {
        switch (msg.type) {
          case 'configure_backend':
            backendConfig = {
              baseUrl: String(msg.baseUrl ?? ''),
              cookie: String(msg.cookie ?? ''),
              models: Array.isArray(msg.models) ? (msg.models as BackendConfig['models']) : [],
            };
            // Refresh the picker now that proxy models are available.
            send({ type: 'models', providers: mergedListings(backendConfig) });
            break;
          case 'start': {
            const providerId = msg.provider ? String(msg.provider) : undefined;
            session = AgentSession.create({
              provider: resolveAdapter(providerId),
              cwd: String(msg.cwd ?? process.cwd()),
              model: msg.model ? String(msg.model) : undefined,
              mode: (msg.mode as PermissionMode) ?? 'ask',
              callbacks,
              usageReporter: providerId ? usageReporterFor(providerId) : undefined,
            });
            break;
          }
          case 'resume': {
            // Reattach with the provider the session was created with.
            const meta = SessionStore.open(String(msg.sessionId)).meta;
            session = AgentSession.resume(String(msg.sessionId), {
              provider: resolveAdapter(meta.provider),
              cwd: '',
              mode: msg.mode as PermissionMode | undefined,
              callbacks,
              usageReporter: usageReporterFor(meta.provider),
            });
            break;
          }
          case 'list_models':
            send({ type: 'models', providers: mergedListings(backendConfig) });
            break;
          case 'prompt':
            if (!session) return send({ type: 'protocol_error', message: 'no session; send start/resume first' });
            if (running) return send({ type: 'protocol_error', message: 'a turn is already running' });
            running = true;
            try {
              await session.prompt(String(msg.text ?? ''));
            } finally {
              running = false;
            }
            break;
          case 'approval': {
            const resolve = pendingApprovals.get(String(msg.callId));
            if (resolve) {
              pendingApprovals.delete(String(msg.callId));
              resolve((msg.decision as ApprovalDecision) ?? 'deny');
            }
            break;
          }
          case 'set_mode':
            session?.setMode(msg.mode as PermissionMode);
            break;
          case 'undo':
            send({ type: 'undo_result', restored: session?.undoLastTurn() ?? [] });
            break;
          case 'diff':
            send({ type: 'diff', patch: session?.diffSinceTurn(Number(msg.sinceTurn ?? 0)) ?? '' });
            break;
          case 'list_sessions':
            send({ type: 'sessions', sessions: SessionStore.list() });
            break;
          case 'delete_session': {
            const id = String(msg.sessionId);
            // Don't delete a session mid-run.
            if (running && session?.sessionId === id) {
              return send({ type: 'protocol_error', message: 'cannot delete a running session' });
            }
            SessionStore.delete(id);
            if (session?.sessionId === id) session = null;
            send({ type: 'sessions', sessions: SessionStore.list() });
            break;
          }
          case 'rename_session': {
            const id = String(msg.sessionId);
            const title = String(msg.title ?? '');
            SessionStore.rename(id, title);
            // Keep the in-memory session in sync so its next saveMeta (on the
            // following turn) doesn't overwrite the file with the old title.
            if (session?.sessionId === id) {
              const trimmed = title.trim().slice(0, 200);
              if (trimmed) session.store.meta.title = trimmed;
            }
            send({ type: 'sessions', sessions: SessionStore.list() });
            break;
          }
          case 'abort':
            session?.abort();
            break;
          default:
            send({ type: 'protocol_error', message: `unknown message type: ${String(msg.type)}` });
        }
      } catch (err) {
        send({ type: 'protocol_error', message: err instanceof Error ? err.message : String(err) });
      }
    })();
  });

  ws.on('close', () => {
    // Deny anything still waiting so the loop can finish and persist.
    for (const [, resolve] of pendingApprovals) resolve('deny');
    pendingApprovals.clear();
    session?.abort();
  });
}

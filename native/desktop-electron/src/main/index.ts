/**
 * Composition root.
 *
 * The only place process-lifetime dependencies are constructed and wired. Every
 * other module in `src/main` is a leaf that takes what it needs as an argument,
 * which is what keeps them unit-testable without an Electron runtime.
 *
 * Ordering matters more than usual here, and the two hard constraints are:
 *
 *   - `registerAppProtocolScheme()` and `installDeepLinkListeners()` must run
 *     **before** `app.whenReady()`. Scheme registration is a no-op afterwards,
 *     and a `juno://` link that arrives during a cold launch is delivered before
 *     ready — it is queued by the deep-link module and replayed once a handler
 *     exists.
 *   - `applyProcessSecurityPolicy()` runs first of all, because it takes the
 *     single-instance lock and may quit the app outright.
 */

import { app, BrowserWindow, session } from 'electron';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyProcessSecurityPolicy,
  hardenSession,
  openExternal,
  APP_SCHEME,
} from './security.js';
import {
  disposeInvokeHandlers,
  emitTo,
  PublicError,
  registerInvokeHandlers,
  type InvokeHandlers,
} from './ipc-router.js';
import {
  createMainWindow,
  getAppWindows,
  getMainWindow,
  showOrCreateMainWindow,
} from './window.js';
import { installApplicationMenu } from './menu.js';
import {
  applyThemeAppearance,
  readSystemAppearance,
  startAppearanceBroadcast,
} from './appearance.js';
import { registerAppProtocolHandler, registerAppProtocolScheme } from './protocol.js';
import { installDeepLinkListeners, startDeepLinkDelivery } from './deep-links.js';
import { checkForUpdatesInteractive, disposeUpdater, initializeUpdater } from './updater.js';
import { configureLogging, createLogger } from './logger.js';
import { AuthSessionController } from './auth/session.js';
import { WorkspaceRegistry } from './workspaces.js';
import { PtyManager } from './terminal/pty-manager.js';
import { AgentHostSupervisor } from './agent-host-supervisor.js';
import { AccountSession } from './account-session.js';
import { ChatService } from './chat/index.js';
import { WorkService } from './work/index.js';
import { createCredentialStore } from './auth/keychain.js';
import { JunoTransport } from './auth/transport.js';
import type { AuthState, DiagnosticsSnapshot } from '../shared/ipc.js';

const log = createLogger('app');

/**
 * The backend this build talks to.
 *
 * An environment override exists for development against a local server. It is
 * read once, here, rather than consulted at each call site — a value that can
 * change under a running app is a value that will eventually differ between two
 * requests in the same flow.
 */
const BACKEND_ORIGIN = process.env['JUNO_BACKEND_ORIGIN'] ?? 'https://chat.liams.dev';

/** Read from the built package manifest rather than hardcoded, so it cannot drift. */
function readPackageVersion(): string {
  try {
    const here = fileURLToPath(new URL('.', import.meta.url));
    const manifest = readFileSync(join(here, '..', '..', 'package.json'), 'utf8');
    const parsed: unknown = JSON.parse(manifest);
    if (typeof parsed === 'object' && parsed !== null && 'version' in parsed) {
      const version = (parsed as { version: unknown }).version;
      if (typeof version === 'string') return version;
    }
  } catch {
    /* Falls through to the app's own idea of its version. */
  }
  return app.getVersion();
}

/* -------------------------------------------------------------------------- */
/* Composition                                                                 */
/* -------------------------------------------------------------------------- */

interface Services {
  readonly auth: AuthSessionController | null;
  /** Why auth is unavailable, when it is. Surfaced to the user, not swallowed. */
  readonly authUnavailableReason: string | null;
  readonly transport: JunoTransport;
  /* Swapped when the account changes: the registry file is account-scoped, so
     a sign-in must switch to that account's list rather than keep the
     signed-out one. Everything reads it through `services`, so the PTY
     manager's `resolveWorkspace` closure follows automatically. */
  workspaces: WorkspaceRegistry;
  readonly terminals: PtyManager;
  readonly agentHost: AgentHostSupervisor;
  /* Chat and Work exist only while an account does: both need a bearer, and a
     service holding a stale token source across a sign-out is how a signed-out
     app keeps polling. They are created in `startAccountSession`. */
  chat: ChatService | null;
  work: WorkService | null;
  readonly appVersion: string;
  readonly contractVersion: string;
}

let services: Services | null = null;
const disposers: Array<() => void> = [];

/**
 * The signed-in account's database and sync client, or null.
 *
 * Separate from `services` because its lifetime is an account, not the process.
 * `#startAccountSession` is serialised through this promise so a rapid
 * sign-out/sign-in cannot leave two sessions open on one database file.
 */
let accountSession: AccountSession | null = null;
let accountTransition: Promise<void> = Promise.resolve();

function queueAccountTransition(work: () => Promise<void>): void {
  accountTransition = accountTransition.then(work, work).catch((error: unknown) => {
    log.error('account transition failed', {
      reason: error instanceof Error ? error.message : String(error),
    });
  });
}

/** Push an event to every open window. */
function broadcast<C extends Parameters<typeof emitTo>[1]>(
  channel: C,
  payload: Parameters<typeof emitTo<C>>[2],
): void {
  for (const window of getAppWindows()) emitTo(window, channel, payload);
}

/**
 * Tear down everything scoped to the signed-in account.
 *
 * Order matters: Chat and Work stop first so no in-flight request can be issued
 * against a token source that is about to go away, and only then does the sync
 * client stop and the database close.
 */
async function stopAccountSession(): Promise<void> {
  const current = services;
  if (current) {
    current.chat?.dispose();
    current.work?.dispose();
    current.chat = null;
    current.work = null;

    /* Back to the signed-out registry. The account's own file stays on disk —
       signing back in should not lose the list — but nothing in the signed-out
       registry is trusted, so no execution path survives the transition. */
    try {
      const signedOut = new WorkspaceRegistry();
      await signedOut.load();
      current.workspaces = signedOut;
    } catch {
      /* Leaving the previous registry in place would be worse than an empty
         one, so fall back to a registry that has loaded nothing. */
      current.workspaces = new WorkspaceRegistry();
    }
  }

  const session = accountSession;
  accountSession = null;
  if (session) await session.stop();
}

async function startAccountSession(accountId: string, deviceId: string): Promise<void> {
  const current = services;
  if (!current?.auth) return;
  if (accountSession?.accountId === accountId) return;

  await stopAccountSession();

  /* Switch to this account's workspace registry before anything can resolve a
     workspace id. Doing it after would leave a window in which a Code session
     or a terminal resolved against the previous account's list. */
  try {
    const scoped = new WorkspaceRegistry(undefined, accountId);
    await scoped.load();
    current.workspaces = scoped;
  } catch (error) {
    log.error('could not open the account workspace registry', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  /* Chat and Work start first: they only need a token source, and having them
     ready before sync begins means the UI is usable during a long bootstrap. */
  current.chat = new ChatService({
    transport: current.transport,
    tokens: current.auth.tokens,
    emit: (channel, payload) => {
      broadcast(channel as never, payload as never);
    },
  });
  current.work = new WorkService({
    transport: current.transport,
    tokens: current.auth.tokens,
    appVersion: current.appVersion,
    emit: (channel, payload) => {
      broadcast(channel as never, payload as never);
    },
    /* Now that Chat exists, `work:open-conversation` can actually go somewhere.
       Without this the service throws rather than returning a false `{ok:true}`,
       which was the right behaviour while Chat was absent — but it is a worse
       answer than switching the surface, which is what the user asked for. The
       renderer owns navigation, so this is an intent, not a mutation. */
    openConversation: (conversationId) => {
      broadcast('app:command', { command: `chat:open:${conversationId}` });
    },
  });
  current.work.start();

  try {
    accountSession = await AccountSession.start({
      accountId,
      deviceSessionId: deviceId,
      baseUrl: BACKEND_ORIGIN,
      tokens: current.auth.tokens,
    });
  } catch (error) {
    /* A failed account session must not present as signed-out — the user IS
       signed in; it is sync that is down. Diagnostics reports it. */
    log.error('could not start the account session', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Build the account-independent services.
 *
 * Credential storage is the one thing that can legitimately be unavailable:
 * `safeStorage` fails closed when the OS keychain cannot be reached, and the
 * correct response is to run with sign-in disabled and *say so*, not to fall
 * back to storing a bearer token in plaintext.
 */
async function composeServices(): Promise<Services> {
  const appVersion = readPackageVersion();
  const transport = new JunoTransport({
    origin: BACKEND_ORIGIN,
    appVersion,
    logger: createLogger('sync'),
  });

  /* The signed-out registry. Recents and the folder picker work before sign-in;
     nothing in this file is ever trusted. */
  const workspaces = new WorkspaceRegistry();
  await workspaces.load();

  /* The PTY manager owns no workspace state; trust is resolved through the
     registry on every spawn, so revoking trust takes effect on the next
     terminal rather than at the next restart. */
  const terminals = new PtyManager({
    appVersion,
    resolveWorkspace: (workspaceId) => {
      const workspace = workspaces.get(workspaceId);
      if (!workspace) return null;
      return { id: workspace.id, path: workspace.path, trusted: workspace.trusted };
    },
    emit: (event) => {
      for (const window of getAppWindows()) emitTo(window, event.channel, event.payload);
    },
  });

  const agentHost = new AgentHostSupervisor({
    onAgentEvent: (sessionId, event) => {
      for (const window of getAppWindows()) {
        emitTo(window, 'code:event', { sessionId, event: event as never });
      }
    },
    onStatusChange: (status, detail) => {
      for (const window of getAppWindows()) {
        emitTo(window, 'code:host-status', { status, detail });
      }
    },
  });

  try {
    const store = await createCredentialStore();
    const auth = new AuthSessionController({
      transport,
      store,
      deviceName: `${app.getName()} on macOS`,
      platform: `macOS ${process.getSystemVersion()} (${process.arch})`,
      appVersion,
      openExternal,
      logger: createLogger('app'),
    });
    return {
      auth,
      authUnavailableReason: null,
      transport,
      workspaces,
      terminals,
      agentHost,
      chat: null,
      work: null,
      appVersion,
      contractVersion: transport.contractVersion,
    };
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : 'Secure credential storage is unavailable.';
    log.error('credential storage unavailable; sign-in disabled', { reason });
    return {
      auth: null,
      authUnavailableReason: reason,
      transport,
      workspaces,
      terminals,
      agentHost,
      chat: null,
      work: null,
      appVersion,
      contractVersion: transport.contractVersion,
    };
  }
}

function requireServices(): Services {
  if (services === null) throw new PublicError('The application is still starting up.');
  return services;
}

/**
 * Auth is the only service allowed to be absent at runtime, so it gets an
 * accessor that converts absence into a message the user can act on.
 */
function requireAuth(): AuthSessionController {
  const current = requireServices();
  if (current.auth === null) {
    throw new PublicError(
      current.authUnavailableReason ??
        'Secure credential storage is unavailable, so signing in is disabled.',
    );
  }
  return current.auth;
}

/**
 * Not-yet-built capability.
 *
 * Deliberately an error rather than an empty success. A channel that returns
 * `{ok: true}` without doing anything produces a UI that looks like it worked,
 * which is the specific failure mode this project is written against.
 */
/**
 * Chat and Work exist only while signed in.
 *
 * Returning a clear sentence rather than letting a null dereference surface as
 * "Something went wrong" is the difference between a UI that explains itself and
 * one that looks broken.
 */
function requireChat(): ChatService {
  const chat = requireServices().chat;
  if (!chat) throw new PublicError('Sign in to use Chat.');
  return chat;
}

function requireWork(): WorkService {
  const work = requireServices().work;
  if (!work) throw new PublicError('Sign in to use Work.');
  return work;
}

function notImplemented(capability: string): never {
  throw new PublicError(`${capability} is not available in this build yet.`);
}

/**
 * Turn a terminal failure into something the user can act on.
 *
 * The PTY manager's errors are already user-facing sentences ("that workspace
 * is not trusted"), and losing them to the router's generic "Something went
 * wrong" would turn an actionable refusal into a mystery.
 */
async function mapAgentHostError<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new PublicError(
      error instanceof Error ? error.message : 'The agent host could not handle that.',
    );
  }
}

async function mapTerminalError<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new PublicError(
      error instanceof Error ? error.message : 'The terminal could not be started.',
    );
  }
}

function buildInvokeHandlers(): InvokeHandlers {
  return {
    'app:info': () => {
      const current = requireServices();
      return {
        version: current.appVersion,
        electronVersion: process.versions.electron ?? 'unknown',
        chromeVersion: process.versions.chrome ?? 'unknown',
        nodeVersion: process.versions.node,
        platform: process.platform,
        arch: process.arch,
        isPackaged: app.isPackaged,
        contractVersion: current.contractVersion,
      };
    },

    'app:appearance': () => readSystemAppearance(),

    'app:set-appearance': ({ appearance }) => {
      applyThemeAppearance(appearance);
      return { ok: true } as const;
    },

    'window:minimize': (_request, { sender }) => {
      BrowserWindow.fromWebContents(sender)?.minimize();
      return { ok: true } as const;
    },

    'window:toggle-maximize': (_request, { sender }) => {
      const window = BrowserWindow.fromWebContents(sender);
      if (window) {
        if (window.isMaximized()) window.unmaximize();
        else window.maximize();
      }
      return { ok: true } as const;
    },

    'window:toggle-fullscreen': (_request, { sender }) => {
      const window = BrowserWindow.fromWebContents(sender);
      window?.setFullScreen(!window.isFullScreen());
      return { ok: true } as const;
    },

    'auth:state': () => {
      const current = requireServices();
      if (current.auth === null) {
        return {
          status: 'unauthorized',
          reason:
            current.authUnavailableReason ?? 'Secure credential storage is unavailable.',
        } satisfies AuthState;
      }
      return current.auth.snapshot();
    },

    'auth:begin-sign-in': async () => {
      await requireAuth().beginSignIn();
      return { ok: true } as const;
    },

    'auth:sign-out': async () => {
      await requireAuth().signOut();
      return { ok: true } as const;
    },

    'workspace:list': () => requireServices().workspaces.list(),

    'workspace:choose': async (_request, { sender }) =>
      requireServices().workspaces.choose(BrowserWindow.fromWebContents(sender)),

    'workspace:set-trust': async ({ workspaceId, trusted }) => {
      try {
        return await requireServices().workspaces.setTrust(workspaceId, trusted);
      } catch (error) {
        throw new PublicError(
          error instanceof Error ? error.message : 'That workspace could not be updated.',
        );
      }
    },

    /* ---- Code. The agent host starts lazily on first use, so a user who
       never opens Code never pays for a second process. ------------------- */
    'code:start-session': async ({ workspaceId, model, mode }) => {
      const current = requireServices();
      const workspace = current.workspaces.get(workspaceId);
      if (!workspace) throw new PublicError('That workspace is not registered.');
      /* Trust is checked here, in main, and not merely in the UI. The renderer
         cannot reach this by naming a path, and an untrusted root never becomes
         an agent's cwd. */
      if (!workspace.trusted) {
        throw new PublicError(
          `${workspace.name} is not trusted yet. Trust it before starting a Code session.`,
        );
      }

      const reply = await mapAgentHostError(() =>
        requireServices().agentHost.send(
          {
            type: 'start',
            cwd: workspace.path,
            ...(model === undefined ? {} : { model }),
            ...(mode === undefined ? {} : { mode }),
          },
          'session_started',
        ),
      );
      return { sessionId: reply.sessionId };
    },

    'code:prompt': async ({ sessionId, text }) => {
      await mapAgentHostError(() =>
        requireServices().agentHost.send({ type: 'prompt', sessionId, text }, 'ack'),
      );
      return { ok: true } as const;
    },

    'code:resolve-approval': async ({ sessionId, callId, decision }) => {
      await mapAgentHostError(() =>
        requireServices().agentHost.send(
          { type: 'approval', sessionId, callId, decision },
          'approval_settled',
        ),
      );
      return { ok: true } as const;
    },

    'code:set-mode': async ({ sessionId, mode }) => {
      await mapAgentHostError(() =>
        requireServices().agentHost.send({ type: 'set_mode', sessionId, mode }, 'ack'),
      );
      return { ok: true } as const;
    },

    'code:abort': async ({ sessionId }) => {
      await mapAgentHostError(() =>
        requireServices().agentHost.send({ type: 'abort', sessionId }, 'ack'),
      );
      return { ok: true } as const;
    },

    /* ---- Terminal. Real: the PTY manager exists and is exercised. -------- */
    'terminal:create': async (request) => {
      const terminal = await mapTerminalError(() =>
        requireServices().terminals.create({ ...request, origin: 'user' }),
      );
      return { terminal };
    },
    'terminal:write': async (request) => {
      /* `origin` is supplied here, never accepted from the renderer. A renderer
         able to claim `'agent'` would launder its own writes past the activity
         log; able to claim `'user'`, it would launder agent commands past a
         permission gate. */
      await mapTerminalError(async () =>
        requireServices().terminals.write({ ...request, origin: 'user' }),
      );
      return { ok: true } as const;
    },
    'terminal:resize': async (request) => {
      await mapTerminalError(async () => requireServices().terminals.resize(request));
      return { ok: true } as const;
    },
    'terminal:kill': async (request) => {
      await mapTerminalError(() => requireServices().terminals.kill(request));
      return { ok: true } as const;
    },
    'terminal:restart': async (request) => {
      const terminal = await mapTerminalError(() =>
        requireServices().terminals.restart(request),
      );
      return { terminal };
    },
    'terminal:list': async (request) =>
      mapTerminalError(async () => requireServices().terminals.list(request)),

    /* ---- Chat and Work. No backing service yet; see STATUS.md. ----------- */
    'chat:list-conversations': (request) => requireChat().listConversations(request),
    'chat:get-conversation': (request) => requireChat().getConversation(request),
    'chat:create-conversation': (request) => requireChat().createConversation(request),
    'chat:update-conversation': (request) => requireChat().updateConversation(request),
    'chat:delete-conversation': (request) => requireChat().deleteConversation(request),
    'chat:send': (request) => requireChat().send(request),
    'chat:stop': (request) => requireChat().stop(request),
    'chat:retry': (request) => requireChat().retry(request),
    'chat:edit-message': (request) => requireChat().editMessage(request),
    'chat:fork': (request) => requireChat().fork(request),
    'chat:models': () => requireChat().models(),
    'chat:pick-attachments': (request) => requireChat().pickAttachments(request),
    'chat:receive-dropped-files': (request) => requireChat().receiveDroppedFiles(request),
    'chat:open-external': async ({ url }) => {
      /* `openExternal` returns false when it refuses — a non-https scheme, or a
         host outside the allowlist. The channel's response type is `{ok: true}`,
         so a refusal has to be an error rather than a cheerful `ok`: a link in
         model output that silently does nothing is indistinguishable from a
         broken app. */
      const opened = await openExternal(url);
      if (!opened) {
        throw new PublicError('That link could not be opened. Only trusted https links are allowed.');
      }
      return { ok: true } as const;
    },

    'work:list-tasks': (request) => requireWork().listTasks(request),
    'work:task-snapshot': (request) => requireWork().taskSnapshot(request),
    'work:watch-task': (request) => requireWork().watchTask(request),
    'work:poll-now': (request) => requireWork().pollNow(request),
    'work:create-task': (request) => requireWork().createTask(request),
    'work:dispatch-run': (request) => requireWork().dispatchRun(request),
    'work:control-run': (request) => requireWork().controlRun(request),
    'work:answer': (request) => requireWork().answer(request),
    'work:resolve-approval': (request) => requireWork().resolveApproval(request),
    'work:audit-trail': (request) => requireWork().auditTrail(request),
    'work:capabilities': () => requireWork().capabilities(),
    'work:choose-grant': (request) => requireWork().chooseGrant(request),
    'work:open-artifact': (request) => requireWork().openArtifact(request),
    'work:open-conversation': (request) => requireWork().openConversation(request),

    'diagnostics:snapshot': (): DiagnosticsSnapshot => {
      const current = requireServices();
      const auth = current.auth?.snapshot();
      const syncStatus = accountSession?.status();
      return {
        appVersion: current.appVersion,
        contractVersion: current.contractVersion,
        /* Honest: reachability is only known after a request has been made.
           Until the sync client runs, this is what we can truthfully report. */
        /* Only the phases that require a *completed* round trip count as
           reachable. `error` and `signed-out` are not reachability, and
           `!== 'offline'` would have reported both as reachable — a diagnostics
           panel that lies about the network is worse than one that says
           nothing. */
        backendReachable:
          syncStatus?.phase === 'live' ||
          syncStatus?.phase === 'catching-up' ||
          syncStatus?.phase === 'bootstrapping',
        backendOrigin: current.transport.origin,
        authStatus: auth?.status ?? 'unavailable',
        syncCursor: syncStatus?.cursor ?? null,
        /* Pending plus dead-lettered: a dead letter is still un-delivered work
           the user owns, and hiding it would make the outbox look empty while a
           mutation sits stuck. */
        outboxDepth: (syncStatus?.pendingMutations ?? 0) + (syncStatus?.deadLetters ?? 0),
        agentHostStatus: current.agentHost.status,
        agentHostRestarts: current.agentHost.restarts,
        databaseHealthy: accountSession?.databaseHealthy() ?? false,
      };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                   */
/* -------------------------------------------------------------------------- */

applyProcessSecurityPolicy();
registerAppProtocolScheme();
installDeepLinkListeners();

app.whenReady().then(async () => {
  configureLogging({
    directory: app.getPath('logs'),
    console: !app.isPackaged,
  });
  log.info('starting', {
    version: app.getVersion(),
    electron: process.versions.electron,
    packaged: app.isPackaged,
  });

  /* The default session carries anything created without an explicit partition,
     so it is hardened even though every window we create is hardened too. */
  hardenSession(session.defaultSession);

  registerAppProtocolHandler();

  services = await composeServices();
  registerInvokeHandlers(buildInvokeHandlers());

  installApplicationMenu({
    resolveTargetWindow: () => getMainWindow(),
    onCheckForUpdates: checkForUpdatesInteractive,
  });

  disposers.push(startAppearanceBroadcast({ targets: () => getAppWindows() }));

  /* Auth state is pushed, not polled, so the renderer never has to guess. */
  const auth = services.auth;
  if (auth) {
    disposers.push(
      auth.onStateChange((state) => {
        for (const window of getAppWindows()) emitTo(window, 'auth:changed', state);

        /* Account-scoped resources follow the account, not the UI. */
        if (state.status === 'signed-in') {
          queueAccountTransition(() => startAccountSession(state.accountId, state.deviceId));
        } else {
          queueAccountTransition(stopAccountSession);
        }
      }),
    );

    /* Teardown fires before `unauthorized` is broadcast, so nothing can still be
       running when the UI learns the account is gone. Workspace trust is
       account-scoped: leaving grants in place across a sign-out is the exact
       defect found in the Swift client's Work grants, and it is cheap to avoid
       here. */
    disposers.push(
      auth.onTeardown((teardown) => {
        log.info('tearing down account state', { reason: teardown.reason });
        void services?.terminals.shutdown().catch(() => undefined);
        void services?.agentHost.shutdown().catch(() => undefined);
        queueAccountTransition(stopAccountSession);
        void services?.workspaces.revokeAllTrust().catch(() => undefined);
      }),
    );
  }

  disposers.push(
    startDeepLinkDelivery({
      handle: async (link) => {
        if (link.kind !== 'auth-callback') return;
        const controller = services?.auth;
        if (!controller) {
          log.warn('auth callback arrived with no credential store; ignoring');
          return;
        }
        /* `link.url` is canonical — `deep-links.ts` rebuilds it from the two
           validated fields rather than passing the string that arrived, so
           nothing else from the inbound URL reaches the auth controller. */
        try {
          await controller.completeSignIn(link.url);
        } catch (error) {
          log.error('sign-in callback failed', {
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      },
      foreground: () => {
        void showOrCreateMainWindow();
      },
    }),
  );

  await createMainWindow();

  /* Restoring after the window exists means a revocation discovered during
     restore has somewhere to render itself. */
  if (auth) {
    void auth.restore().catch((error: unknown) => {
      log.warn('session restore failed', {
        reason: error instanceof Error ? error.message : String(error),
      });
    });
  }

  initializeUpdater({});

  app.on('activate', () => {
    void showOrCreateMainWindow();
  });
});

/**
 * macOS keeps the app running with no windows; that is the platform convention
 * and also what makes the Dock icon and `activate` meaningful.
 */
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/**
 * Shutdown.
 *
 * `before-quit` is synchronous, so the PTY shutdown is kicked off here and the
 * quit is deferred exactly once until it settles. Without that, macOS tears the
 * process down mid-SIGHUP and the shells become orphans — which is precisely
 * the "no untracked orphan shells" requirement.
 */
let shuttingDown = false;

app.on('before-quit', (event) => {
  if (!shuttingDown) {
    shuttingDown = true;
    const terminals = services?.terminals;
    if (terminals) {
      event.preventDefault();
      void Promise.allSettled([
        terminals.shutdown(),
        services?.agentHost.shutdown(),
        stopAccountSession(),
      ])
        .finally(() => {
          app.quit();
        });
      return;
    }
  }

  log.info('shutting down');
  for (const dispose of disposers.splice(0)) {
    try {
      dispose();
    } catch (error) {
      log.warn('a disposer threw during shutdown', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  disposeInvokeHandlers();
  disposeUpdater();
  services?.auth?.dispose();
});

export { APP_SCHEME };

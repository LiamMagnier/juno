/**
 * Update checking.
 *
 * ## The policy, and why
 *
 * Juno **never** downloads or installs an update without the user saying so.
 * `autoDownload` and `autoInstallOnAppQuit` are both switched off, explicitly,
 * on the first line of configuration. electron-updater's defaults are the
 * opposite — it will fetch the whole package in the background and swap the
 * binary at the next quit — and for this app those defaults are wrong twice
 * over:
 *
 *   - It is a *developer tool*. It holds live terminal sessions, running agent
 *     turns, and uncommitted state. An app that decides on its own to become a
 *     different version at quit is an app that can lose someone's work.
 *   - It is a program that executes code on the user's machine with the user's
 *     credentials. Replacing that binary is the single highest-consequence
 *     action the app can take, and it belongs to the user.
 *
 * So: check, tell, ask. "Install on Quit" is offered as an option, because a
 * user choosing deferred installation is a completely different thing from the
 * app choosing it for them.
 *
 * ## Degrading cleanly
 *
 * `npm run dev` must not produce update errors, and neither must a build that
 * has not had a publish target configured yet. Both cases are detected up
 * front, logged once with a message that says exactly why nothing will happen,
 * and then every entry point becomes a no-op. Nothing throws, and no dialog
 * appears.
 */

import { app, dialog, type BrowserWindow } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';
/*
 * electron-updater exports `autoUpdater` through `Object.defineProperty`, which
 * `cjs-module-lexer` cannot see. Under Node ESM a named import therefore fails
 * at load with "does not provide an export named 'autoUpdater'". The default
 * import is the CommonJS `module.exports` object, and destructuring it hits the
 * getter normally. This is the workaround electron-updater documents for ESM.
 */
import electronUpdater from 'electron-updater';
import type { ProgressInfo, UpdateInfo } from 'electron-updater';
import { createLogger } from './logger.js';

const { autoUpdater } = electronUpdater;
const log = createLogger('updater');

/** electron-builder writes this next to the app's resources when publishing is configured. */
const FEED_CONFIG_FILE = 'app-update.yml';

/** Background re-check cadence. Long enough to be invisible, short enough to matter. */
const BACKGROUND_INTERVAL_MS = 6 * 60 * 60 * 1_000;
/** Delay before the first background check, so it never competes with startup. */
const FIRST_CHECK_DELAY_MS = 30 * 1_000;

export interface UpdaterOptions {
  /** Parent for the modal sheets. Without one the dialog is a free-floating window. */
  readonly parentWindow?: () => BrowserWindow | null;
  /**
   * Overrides `app-update.yml`. Intended for a staging channel; when absent the
   * packaged feed configuration is used and nothing is overridden.
   */
  readonly feedUrl?: string;
  /** Skip the periodic background check. The menu item still works. */
  readonly disableBackgroundChecks?: boolean;
}

type UpdaterState =
  | { readonly kind: 'inactive'; readonly why: string }
  | { readonly kind: 'active'; readonly options: UpdaterOptions };

let state: UpdaterState = { kind: 'inactive', why: 'not initialised' };
let checkInFlight = false;
let interactiveCheck = false;
let backgroundTimer: NodeJS.Timeout | null = null;
let firstCheckTimer: NodeJS.Timeout | null = null;

/* -------------------------------------------------------------------------- */
/* Setup                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Decide whether updating is possible at all.
 *
 * Both branches return a reason string rather than a bare boolean, because the
 * whole point is that the log says *which* of the two situations this is —
 * "you are running from source" and "this build was never given a publish
 * target" look identical from the outside and need completely different fixes.
 */
function determineAvailability(options: UpdaterOptions): UpdaterState {
  if (!app.isPackaged) {
    return {
      kind: 'inactive',
      why: 'the app is running unpackaged; updates only apply to a built, signed bundle',
    };
  }

  if (options.feedUrl === undefined) {
    const configPath = path.join(process.resourcesPath, FEED_CONFIG_FILE);
    if (!existsSync(configPath)) {
      return {
        kind: 'inactive',
        why: `no ${FEED_CONFIG_FILE} in the bundle; this build has no publish target configured`,
      };
    }
  }

  return { kind: 'active', options };
}

/**
 * Wire the updater. Safe to call unconditionally at startup.
 *
 * Returns whether update checking is live, so the caller can decide whether to
 * show a "Check for Updates…" menu item at all.
 */
export function initializeUpdater(options: UpdaterOptions = {}): boolean {
  state = determineAvailability(options);

  if (state.kind === 'inactive') {
    log.info(`update checking is disabled: ${state.why}`);
    return false;
  }

  /* The two lines this module exists for. Set before anything can fire. */
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  /* electron-updater logs a lot, and some of it contains the feed URL with its
     query string. Routing it through our logger means it is redacted and lands
     in the same rotating file as everything else. */
  autoUpdater.logger = {
    info: (message?: unknown) => {
      log.info(String(message));
    },
    warn: (message?: unknown) => {
      log.warn(String(message));
    },
    error: (message?: unknown) => {
      log.error(String(message));
    },
    debug: (message: string) => {
      log.debug(message);
    },
  };

  if (options.feedUrl !== undefined) {
    autoUpdater.setFeedURL({ provider: 'generic', url: options.feedUrl });
    log.info('using an overridden update feed');
  }

  attachEventHandlers();

  if (options.disableBackgroundChecks !== true) {
    firstCheckTimer = setTimeout(() => {
      void runCheck(false);
    }, FIRST_CHECK_DELAY_MS);
    firstCheckTimer.unref();

    backgroundTimer = setInterval(() => {
      void runCheck(false);
    }, BACKGROUND_INTERVAL_MS);
    /* Never the reason the process stays alive. */
    backgroundTimer.unref();
  }

  log.info('updater initialised', { currentVersion: app.getVersion() });
  return true;
}

export function disposeUpdater(): void {
  if (backgroundTimer !== null) {
    clearInterval(backgroundTimer);
    backgroundTimer = null;
  }
  if (firstCheckTimer !== null) {
    clearTimeout(firstCheckTimer);
    firstCheckTimer = null;
  }
  autoUpdater.removeAllListeners();
  state = { kind: 'inactive', why: 'disposed' };
}

/* -------------------------------------------------------------------------- */
/* Checking                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The "Check for Updates…" menu action.
 *
 * Differs from the background check in exactly one way: it reports *every*
 * outcome, including "you are up to date" and "the check failed". A background
 * check that pops a dialog to say nothing happened is a background check that
 * users learn to resent.
 */
export function checkForUpdatesInteractive(): void {
  if (state.kind === 'inactive') {
    void message({
      type: 'info',
      message: 'Updates are not available for this build.',
      detail: capitalise(state.why),
    });
    return;
  }
  void runCheck(true);
}

async function runCheck(interactive: boolean): Promise<void> {
  if (state.kind !== 'active') return;
  if (checkInFlight) {
    log.debug('update check already in flight; ignoring');
    return;
  }

  checkInFlight = true;
  interactiveCheck = interactive;
  try {
    /* `checkForUpdates`, never `checkForUpdatesAndNotify` — the latter
       downloads (because it assumes `autoDownload`) and raises a system
       notification we did not author. */
    await autoUpdater.checkForUpdates();
  } catch (error) {
    log.error('update check failed', { error, interactive });
    if (interactive) {
      await message({
        type: 'warning',
        message: 'Could not check for updates.',
        detail: 'Check your network connection and try again.',
      });
    }
  } finally {
    checkInFlight = false;
  }
}

/* -------------------------------------------------------------------------- */
/* Events                                                                      */
/* -------------------------------------------------------------------------- */

function attachEventHandlers(): void {
  autoUpdater.removeAllListeners();

  autoUpdater.on('checking-for-update', () => {
    log.debug('checking for updates');
  });

  autoUpdater.on('update-not-available', (info: UpdateInfo) => {
    log.info('no update available', { latest: info.version });
    if (!interactiveCheck) return;
    void message({
      type: 'info',
      message: 'Juno is up to date.',
      detail: `You are running version ${app.getVersion()}.`,
    });
  });

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    log.info('update available', { version: info.version, releaseDate: info.releaseDate });
    void offerDownload(info);
  });

  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    log.debug('update download progress', {
      percent: Math.round(progress.percent),
      bytesPerSecond: progress.bytesPerSecond,
    });
  });

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    log.info('update downloaded', { version: info.version });
    void offerInstall(info);
  });

  autoUpdater.on('error', (error: Error) => {
    /* Reported here as well as in `runCheck`'s catch: a download failure
       arrives on this channel with no promise to reject. */
    log.error('updater error', { error });
  });
}

async function offerDownload(info: UpdateInfo): Promise<void> {
  const choice = await message({
    type: 'info',
    message: `Juno ${info.version} is available.`,
    detail: buildDetail(info),
    buttons: ['Download', 'Not Now'],
    defaultId: 0,
    cancelId: 1,
  });

  if (choice !== 0) {
    log.info('user declined the download', { version: info.version });
    return;
  }

  try {
    await autoUpdater.downloadUpdate();
  } catch (error) {
    log.error('update download failed', { error, version: info.version });
    await message({
      type: 'warning',
      message: 'The update could not be downloaded.',
      detail: 'You can try again from the Juno menu.',
    });
  }
}

async function offerInstall(info: UpdateInfo): Promise<void> {
  const choice = await message({
    type: 'info',
    message: `Juno ${info.version} is ready to install.`,
    detail:
      'Restarting will end any running agent turns and terminal sessions. Installing on quit applies the update the next time you close Juno.',
    buttons: ['Restart Now', 'Install on Quit', 'Later'],
    defaultId: 1,
    cancelId: 2,
  });

  if (choice === 0) {
    log.info('installing update now', { version: info.version });
    /* Deferred a tick so the dialog is dismissed and this handler has returned
       before the app starts tearing itself down. */
    setImmediate(() => {
      autoUpdater.quitAndInstall();
    });
    return;
  }

  if (choice === 1) {
    /* The user opting in — which is a different thing entirely from the
       library's default of doing this without being asked. */
    autoUpdater.autoInstallOnAppQuit = true;
    log.info('update will install on quit', { version: info.version });
    return;
  }

  log.info('user deferred the update', { version: info.version });
}

/* -------------------------------------------------------------------------- */
/* Dialog helpers                                                              */
/* -------------------------------------------------------------------------- */

interface MessageOptions {
  readonly type: 'info' | 'warning' | 'error';
  readonly message: string;
  readonly detail: string;
  readonly buttons?: string[];
  readonly defaultId?: number;
  readonly cancelId?: number;
}

/** Returns the index of the pressed button. */
async function message(options: MessageOptions): Promise<number> {
  const parent = state.kind === 'active' ? (state.options.parentWindow?.() ?? null) : null;

  const boxOptions: Electron.MessageBoxOptions = {
    type: options.type,
    message: options.message,
    detail: options.detail,
    buttons: options.buttons ?? ['OK'],
    defaultId: options.defaultId ?? 0,
    cancelId: options.cancelId ?? 0,
    noLink: true,
  };

  /* Two call shapes rather than a `parent ?? undefined`: under
     `exactOptionalPropertyTypes` an explicit `undefined` is not the same as an
     absent argument, and `showMessageBox` overloads on arity. */
  const result =
    parent === null || parent.isDestroyed()
      ? await dialog.showMessageBox(boxOptions)
      : await dialog.showMessageBox(parent, boxOptions);

  return result.response;
}

/**
 * Version, date, and a conservatively-trimmed excerpt of the release notes.
 *
 * The notes come from the update feed, which is remote content. `detail` is
 * rendered as plain text, so markup cannot execute — but it can still be used
 * to fake dialog chrome or to run to thousands of lines, so tags are stripped,
 * control characters removed, and the whole thing capped. Anything longer
 * belongs on the release page, not in a modal.
 */
function buildDetail(info: UpdateInfo): string {
  const lines = [`You are running ${app.getVersion()}.`];

  if (typeof info.releaseDate === 'string' && info.releaseDate.length > 0) {
    const released = new Date(info.releaseDate);
    if (!Number.isNaN(released.getTime())) {
      lines.push(`Released ${released.toLocaleDateString()}.`);
    }
  }

  const notes = summariseReleaseNotes(info.releaseNotes);
  if (notes !== null) lines.push('', notes);

  return lines.join('\n');
}

const MAX_NOTE_LENGTH = 600;

function summariseReleaseNotes(notes: UpdateInfo['releaseNotes']): string | null {
  if (notes === null || notes === undefined) return null;

  const raw = typeof notes === 'string' ? notes : notes.map((entry) => entry.note ?? '').join('\n');

  const plain = raw
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\p{Cc}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (plain.length === 0) return null;
  return plain.length > MAX_NOTE_LENGTH ? `${plain.slice(0, MAX_NOTE_LENGTH)}…` : plain;
}

function capitalise(text: string): string {
  const first = text.charAt(0);
  return first === '' ? text : `${first.toUpperCase()}${text.slice(1)}.`;
}

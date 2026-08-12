/**
 * The native application menu.
 *
 * Two rules govern everything here.
 *
 * **Use `role` wherever a role exists.** A hand-rolled `Copy` item that sends
 * an IPC message is not a copy command — it does not participate in the
 * responder chain, so it will not work in a `<select>`, will not appear in the
 * Services menu, will not respect a user's remapped key equivalent, and will be
 * silently wrong in a native context menu. Roles delegate to AppKit, which is
 * the only implementation of "copy" that is actually correct. The entire Edit
 * menu is therefore roles, and the Speech and Services submenus exist because
 * macOS users reasonably expect every text field in a native app to have them.
 *
 * **Anything the renderer owns is a `app:command` event, not a new channel.**
 * `emitTo(window, 'app:command', { command })` is the one path. Adding
 * `menu:new-chat` and friends to the IPC contract would put a dozen
 * fire-and-forget channels in a surface whose whole design is "small and
 * enumerable", for no gain — the renderer already has to switch on something.
 *
 * ## Accelerators, and the conflicts that were resolved
 *
 * | Item                | Key   | Note |
 * | ------------------- | ----- | ---- |
 * | Settings…           | ⌘,    | macOS standard. |
 * | New Chat            | ⌘N    | |
 * | New Work Task       | ⇧⌘N   | |
 * | New Code Session    | ⌃⌘N   | |
 * | Open Workspace…     | ⌘O    | |
 * | Quick Open          | ⌘P    | **Overrides Print.** Deliberate, and the reason no Print item exists — this is a developer tool, and ⌘P is muscle-memory for the file switcher. |
 * | Find…               | ⌘F    | Inside Edit → Find, where macOS puts it. |
 * | Command Palette     | ⌘K    | |
 * | Switch to Chat      | ⌘1    | |
 * | Switch to Code      | ⌘2    | |
 * | Switch to Work      | ⌘3    | Not in the original spec, added because the app has three products and a menu that can reach two of them is a menu with a hole in it. ⌘1/⌘2 are exactly as specified. |
 * | Toggle Sidebar      | ⌘B    | |
 * | Toggle Inspector    | ⌥⌘I   | **Conflicts with Electron's `toggleDevTools` role default.** Resolved in favour of the inspector, which users touch constantly; DevTools moves to ⌥⌘J — the same key Chrome uses for its console — and only exists in unpackaged builds. |
 * | Toggle Terminal     | ⌃`    | Free on macOS. ⌘` is the system's window-cycle key and is untouched. |
 * | Stop Agent          | ⌘.    | ⌘. is the macOS "cancel the current operation" key. Exactly right for aborting a turn. |
 * | Zoom / Full Screen  | ⌘0 ⌘± ⌃⌘F | Roles, system defaults. |
 * | Window / Quit / Hide| ⌘M ⌘W ⌘Q ⌘H ⌥⌘H | Roles, system defaults. |
 *
 * Nothing here shadows a system-reserved combination (⌘Space, ⌃↑, ⌘⇥, ⌘`,
 * ⇧⌘/), and no two items share an accelerator.
 */

import { BrowserWindow, Menu, app, shell, type MenuItemConstructorOptions } from 'electron';
import { emitTo } from './ipc-router.js';
import { createLogger, getLogFilePath } from './logger.js';
import { openExternal } from './security.js';

const log = createLogger('app');

/* -------------------------------------------------------------------------- */
/* Commands                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Every command a menu item can send.
 *
 * Declared here rather than in `shared/ipc.ts` because the contract types the
 * payload as `{ command: string }` and the *set* of commands is a main-process
 * concern — the renderer switches on these strings and ignores what it does not
 * recognise, which is what lets a menu item ship before the surface that
 * handles it without breaking the older renderer in a partially-updated build.
 */
export const MENU_COMMANDS = {
  newChat: 'chat.new',
  newWorkTask: 'work.new',
  newCodeSession: 'code.new',
  openWorkspace: 'workspace.open',
  openSettings: 'settings.open',
  switchToChat: 'product.chat',
  switchToCode: 'product.code',
  switchToWork: 'product.work',
  commandPalette: 'palette.open',
  quickOpen: 'quick-open.open',
  find: 'find.open',
  toggleSidebar: 'sidebar.toggle',
  toggleInspector: 'inspector.toggle',
  toggleTerminal: 'terminal.toggle',
  stopAgent: 'agent.stop',
} as const;

export type MenuCommand = (typeof MENU_COMMANDS)[keyof typeof MENU_COMMANDS];

/* -------------------------------------------------------------------------- */
/* External links                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Help destinations. Both hosts are on `security.ts`'s external allowlist; if
 * one is ever removed from it, `openExternal` refuses and logs rather than
 * opening, which is the correct failure.
 */
const HELP_URL = 'https://liams.dev/juno/docs';
const ISSUE_URL = 'https://github.com/liam/juno/issues/new';

/* -------------------------------------------------------------------------- */
/* Installation                                                                */
/* -------------------------------------------------------------------------- */

export interface MenuOptions {
  /**
   * Which window a command is for. Defaults to the focused window, falling back
   * to the first open one — the menu bar stays active on macOS when a window is
   * merely unfocused, and a command issued then should still land somewhere.
   */
  readonly resolveTargetWindow?: () => BrowserWindow | null;
  /** Wired to `checkForUpdatesInteractive` from `updater.ts`. Omitted → no item. */
  readonly onCheckForUpdates?: () => void;
}

/**
 * Build and install the application menu. Call once, after `whenReady`.
 *
 * Returns the built `Menu` so a caller can reuse items for a Dock or tray menu.
 */
export function installApplicationMenu(options: MenuOptions = {}): Menu {
  configureAboutPanel();

  const menu = Menu.buildFromTemplate(buildTemplate(options));
  Menu.setApplicationMenu(menu);
  log.info('application menu installed');
  return menu;
}

function configureAboutPanel(): void {
  /* The native About panel, rather than a custom window. It is free, it is
     what macOS users expect from ⌘-clicking the app name, and it picks up the
     bundle icon automatically. */
  app.setAboutPanelOptions({
    applicationName: 'Juno',
    applicationVersion: app.getVersion(),
    version: process.versions['electron'] ?? '',
    copyright: `© ${new Date().getFullYear()} Juno`,
  });
}

/**
 * The default target: the focused window, else the first one still open.
 *
 * Resolved through `BrowserWindow` rather than by importing `window.ts`, which
 * would be an import cycle waiting to happen (`window.ts` has every reason to
 * want to rebuild the menu) and would also be wrong for any future secondary
 * window — the menu bar acts on whatever the user is looking at, not on
 * whichever window the app happens to call "main".
 */
function defaultTargetWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
}

function dispatch(options: MenuOptions, command: MenuCommand): void {
  const target = (options.resolveTargetWindow ?? defaultTargetWindow)();
  if (target === null || target.isDestroyed()) {
    log.warn('menu command had no target window', { command });
    return;
  }
  emitTo(target, 'app:command', { command });
}

/** A menu item that forwards a command to the renderer. */
function command(
  options: MenuOptions,
  label: string,
  accelerator: string,
  value: MenuCommand,
): MenuItemConstructorOptions {
  return {
    label,
    accelerator,
    click: () => {
      dispatch(options, value);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Template                                                                    */
/* -------------------------------------------------------------------------- */

function buildTemplate(options: MenuOptions): MenuItemConstructorOptions[] {
  const isDevelopment = !app.isPackaged;

  return [
    appMenu(options),
    fileMenu(options),
    editMenu(options),
    viewMenu(options, isDevelopment),
    agentMenu(options),
    windowMenu(),
    helpMenu(),
  ];
}

function appMenu(options: MenuOptions): MenuItemConstructorOptions {
  const updates: MenuItemConstructorOptions[] =
    options.onCheckForUpdates === undefined
      ? []
      : [
          {
            label: 'Check for Updates…',
            click: () => {
              options.onCheckForUpdates?.();
            },
          },
          { type: 'separator' },
        ];

  return {
    /* `role: 'appMenu'` would give the standard items but no way to insert
       Settings and Check for Updates in the conventional places, so the
       submenu is written out. Each item is still a role. */
    label: app.name,
    submenu: [
      { role: 'about', label: 'About Juno' },
      { type: 'separator' },
      ...updates,
      command(options, 'Settings…', 'CmdOrCtrl+,', MENU_COMMANDS.openSettings),
      { type: 'separator' },
      /* Services must be a role: macOS populates it, and a hand-built version
         is an empty menu. */
      { role: 'services', submenu: [] },
      { type: 'separator' },
      { role: 'hide', label: 'Hide Juno' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit', label: 'Quit Juno' },
    ],
  };
}

function fileMenu(options: MenuOptions): MenuItemConstructorOptions {
  return {
    label: 'File',
    submenu: [
      command(options, 'New Chat', 'CmdOrCtrl+N', MENU_COMMANDS.newChat),
      command(options, 'New Work Task', 'Shift+CmdOrCtrl+N', MENU_COMMANDS.newWorkTask),
      /* ⌃⌘N — `Ctrl` is the literal Control key here, not `CmdOrCtrl`. */
      command(options, 'New Code Session', 'Ctrl+Cmd+N', MENU_COMMANDS.newCodeSession),
      { type: 'separator' },
      command(options, 'Open Workspace…', 'CmdOrCtrl+O', MENU_COMMANDS.openWorkspace),
      command(options, 'Quick Open…', 'CmdOrCtrl+P', MENU_COMMANDS.quickOpen),
      { type: 'separator' },
      { role: 'close', label: 'Close Window' },
    ],
  };
}

function editMenu(options: MenuOptions): MenuItemConstructorOptions {
  return {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      /* The macOS-only paste variant. Without it, pasting into the composer
         drags along the source's font and colour. */
      { role: 'pasteAndMatchStyle' },
      { role: 'delete' },
      { role: 'selectAll' },
      { type: 'separator' },
      {
        /* macOS puts Find in a submenu of Edit; a top-level "Find" item in the
           menu bar is a Windows habit. */
        label: 'Find',
        submenu: [command(options, 'Find…', 'CmdOrCtrl+F', MENU_COMMANDS.find)],
      },
      { type: 'separator' },
      {
        label: 'Speech',
        submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }],
      },
    ],
  };
}

function viewMenu(options: MenuOptions, isDevelopment: boolean): MenuItemConstructorOptions {
  /*
   * Reload and DevTools exist only in unpackaged builds.
   *
   * In a shipped build ⌘R is a foot-gun: it discards renderer state mid-agent-
   * turn while the turn keeps running in the agent host, and the user reads
   * that as a crash. DevTools is omitted for the same reason it is omitted from
   * every shipped Electron app that takes its threat model seriously — it is a
   * console with the preload bridge in scope.
   */
  const developerItems: MenuItemConstructorOptions[] = isDevelopment
    ? [
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        {
          /* ⌥⌘I belongs to the inspector; DevTools takes Chrome's ⌥⌘J. */
          role: 'toggleDevTools',
          accelerator: 'Alt+Cmd+J',
        },
      ]
    : [];

  return {
    label: 'View',
    submenu: [
      command(options, 'Command Palette…', 'CmdOrCtrl+K', MENU_COMMANDS.commandPalette),
      { type: 'separator' },
      command(options, 'Chat', 'CmdOrCtrl+1', MENU_COMMANDS.switchToChat),
      command(options, 'Code', 'CmdOrCtrl+2', MENU_COMMANDS.switchToCode),
      command(options, 'Work', 'CmdOrCtrl+3', MENU_COMMANDS.switchToWork),
      { type: 'separator' },
      command(options, 'Toggle Sidebar', 'CmdOrCtrl+B', MENU_COMMANDS.toggleSidebar),
      command(options, 'Toggle Inspector', 'Alt+Cmd+I', MENU_COMMANDS.toggleInspector),
      command(options, 'Toggle Terminal', 'Control+`', MENU_COMMANDS.toggleTerminal),
      { type: 'separator' },
      { role: 'resetZoom', label: 'Actual Size' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
      ...developerItems,
    ],
  };
}

function agentMenu(options: MenuOptions): MenuItemConstructorOptions {
  return {
    label: 'Agent',
    submenu: [
      /* ⌘. is the system cancel gesture. Enabled unconditionally rather than
         tracked against agent state: the menu would need a live subscription to
         every session's status to disable it correctly, and a Stop that is a
         no-op is far better than a Stop that is greyed out at the moment the
         user needs it. */
      command(options, 'Stop Agent', 'CmdOrCtrl+.', MENU_COMMANDS.stopAgent),
    ],
  };
}

function windowMenu(): MenuItemConstructorOptions {
  return {
    label: 'Window',
    submenu: [
      { role: 'minimize' },
      { role: 'zoom' },
      { type: 'separator' },
      /* "Bring All to Front" is the macOS convention and has no cross-platform
         equivalent; `front` is the role that implements it. */
      { role: 'front' },
      { type: 'separator' },
      /* The `window` *item* role is what tells AppKit this is the Windows menu,
         so macOS appends the live window list and the ⌘` cycling behaviour
         below the separator. Without it this is an ordinary menu that happens
         to be called Window. */
      { role: 'window' },
    ],
  };
}

function helpMenu(): MenuItemConstructorOptions {
  return {
    /* `role: 'help'` is what makes macOS attach its Help search field. */
    role: 'help',
    submenu: [
      {
        label: 'Juno Help',
        click: () => {
          void openExternal(HELP_URL);
        },
      },
      {
        label: 'Report an Issue…',
        click: () => {
          void openExternal(ISSUE_URL);
        },
      },
      { type: 'separator' },
      {
        label: 'Reveal Log File',
        click: () => {
          const file = getLogFilePath();
          if (file === null) {
            log.warn('no log file to reveal; logging has not been configured');
            return;
          }
          /* `shell.showItemInFolder`, not `openExternal`. `openExternal` exists
             to police URLs handed to the OS from untrusted content; this is a
             local path this process just wrote, with no scheme involved and no
             attacker input anywhere in it. Routing it through the URL allowlist
             would be a category error, not extra safety. */
          shell.showItemInFolder(file);
        },
      },
    ],
  };
}

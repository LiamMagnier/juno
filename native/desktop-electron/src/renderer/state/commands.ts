/**
 * The command registry.
 *
 * One list, derived from live state, consumed by the palette. Building it here
 * rather than inside the palette component is what lets every command carry a
 * *reason* when it is unavailable: the palette has no idea why starting a
 * session is impossible, but this module can see that the workspace is
 * untrusted, or that the agent host crashed, and say so.
 *
 * That is the rule the whole file exists for. A command is never silently
 * absent because it would not work — absence is indistinguishable from a bug,
 * and the user is left searching for something that is right there and greyed
 * out in the app they used yesterday. It appears, disabled, with an
 * explanation.
 *
 * Ordering is by group in the order declared here, and by declaration within a
 * group. The palette does not re-sort, so this list is the reading order.
 */

import { useMemo } from 'react';
import { windowActions } from '../lib/window-actions.js';
import { useCodeSession, type PermissionMode } from './code-session.js';
import { useShell } from './shell-state.js';
import { useSystem } from './system-state.js';
import { useWorkspaces } from './workspaces.js';

export type CommandGroup = 'Go to' | 'View' | 'Workspace' | 'Session' | 'Window' | 'Account';

export const COMMAND_GROUP_ORDER: readonly CommandGroup[] = [
  'Go to',
  'View',
  'Workspace',
  'Session',
  'Window',
  'Account',
];

export interface Command {
  readonly id: string;
  readonly title: string;
  readonly group: CommandGroup;
  /** Secondary line: current value, target, or context. */
  readonly hint?: string | undefined;
  /** Rendered as keycaps. */
  readonly shortcut?: readonly string[] | undefined;
  /** Extra search terms that are not in the title. */
  readonly keywords?: string | undefined;
  /** Present ⇒ selectable and announced, but refuses to run, and says why. */
  readonly disabledReason?: string | undefined;
  readonly run: () => void;
}

export function useCommands(): readonly Command[] {
  const shell = useShell();
  const system = useSystem();
  const workspaces = useWorkspaces();
  const session = useCodeSession();

  return useMemo(() => {
    const signedIn = system.auth.status === 'signed-in';
    const active = workspaces.active;
    const hostRunning = system.host.status === 'running';
    const offline = !system.connected ? 'Not connected to the main process.' : undefined;

    const hostReason = offline ?? (hostRunning ? undefined : `The agent host is ${system.host.status}.`);
    const workspaceReason = offline ?? (active ? undefined : 'No workspace is selected.');
    const sessionReason = offline ?? (session.sessionId ? undefined : 'No session is running.');

    const modeCommands = (['plan', 'ask', 'auto-edit', 'full'] as const).map<Command>((mode) => ({
      id: `session.mode.${mode}`,
      title: `Set permission mode: ${MODE_TITLES[mode]}`,
      group: 'Session',
      hint: MODE_HINTS[mode],
      keywords: 'permission approval sandbox',
      disabledReason: sessionReason,
      run: () => session.setMode(mode),
    }));

    const list: Command[] = [
      {
        id: 'go.chat',
        title: 'Go to Chat',
        group: 'Go to',
        shortcut: ['⌘', '1'],
        keywords: 'conversation message',
        run: () => {
          shell.setProductMode('chat');
          shell.setChatSurface('chat');
        },
      },
      {
        id: 'go.work',
        title: 'Go to Work',
        group: 'Go to',
        keywords: 'runs tasks jobs',
        run: () => {
          shell.setProductMode('chat');
          shell.setChatSurface('work');
        },
      },
      {
        id: 'go.code',
        title: 'Go to Code',
        group: 'Go to',
        shortcut: ['⌘', '2'],
        keywords: 'agent session repository',
        run: () => shell.setProductMode('code'),
      },

      {
        id: 'view.sidebar',
        title: shell.sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar',
        group: 'View',
        shortcut: ['⌘', 'B'],
        run: shell.toggleSidebar,
      },
      {
        id: 'view.inspector',
        title: shell.inspectorOpen ? 'Hide inspector' : 'Show inspector',
        group: 'View',
        shortcut: ['⌘', '⌥', 'I'],
        run: shell.toggleInspector,
      },
      {
        id: 'view.appearance.light',
        title: 'Appearance: Light',
        group: 'View',
        hint: system.themePreference === 'light' ? 'Current' : undefined,
        keywords: 'theme colour color',
        disabledReason: offline,
        run: () => system.setThemePreference('light'),
      },
      {
        id: 'view.appearance.dark',
        title: 'Appearance: Dark',
        group: 'View',
        hint: system.themePreference === 'dark' ? 'Current' : undefined,
        keywords: 'theme colour color oled',
        disabledReason: offline,
        run: () => system.setThemePreference('dark'),
      },
      {
        id: 'view.appearance.system',
        title: 'Appearance: Match system',
        group: 'View',
        hint: system.themePreference === 'system' ? 'Current' : undefined,
        keywords: 'theme auto',
        disabledReason: offline,
        run: () => system.setThemePreference('system'),
      },

      {
        id: 'workspace.open',
        title: 'Open folder as workspace…',
        group: 'Workspace',
        keywords: 'add directory repository',
        disabledReason: offline,
        run: workspaces.choose,
      },
      {
        id: 'workspace.reload',
        title: 'Reload workspace list',
        group: 'Workspace',
        disabledReason: offline,
        run: workspaces.refresh,
      },
      {
        id: 'workspace.trust',
        title: active?.trusted ? 'Revoke trust for this workspace' : 'Trust this workspace',
        group: 'Workspace',
        hint: active?.path,
        keywords: 'permission security allow',
        disabledReason: workspaceReason,
        run: () => {
          if (active) workspaces.setTrust(active.id, !active.trusted);
        },
      },

      {
        id: 'session.start',
        title: 'Start a Code session',
        group: 'Session',
        hint: active?.name,
        disabledReason:
          workspaceReason ??
          hostReason ??
          (active && !active.trusted ? 'This workspace is not trusted yet.' : undefined),
        run: () => {
          if (active) {
            shell.setProductMode('code');
            session.start(active.id);
          }
        },
      },
      {
        id: 'session.abort',
        title: 'Stop the current turn',
        group: 'Session',
        keywords: 'cancel interrupt abort',
        disabledReason: sessionReason ?? (session.phase === 'busy' ? undefined : 'Nothing is running.'),
        run: session.abort,
      },
      ...modeCommands,

      {
        id: 'window.minimize',
        title: 'Minimise window',
        group: 'Window',
        shortcut: ['⌘', 'M'],
        disabledReason: offline,
        run: windowActions.minimize,
      },
      {
        id: 'window.zoom',
        title: 'Zoom window',
        group: 'Window',
        keywords: 'maximise maximize',
        disabledReason: offline,
        run: windowActions.toggleMaximize,
      },
      {
        id: 'window.fullscreen',
        title: 'Toggle full screen',
        group: 'Window',
        shortcut: ['⌃', '⌘', 'F'],
        disabledReason: offline,
        run: windowActions.toggleFullscreen,
      },

      signedIn
        ? {
            id: 'account.sign-out',
            title: 'Sign out',
            group: 'Account',
            hint: system.auth.status === 'signed-in' ? system.auth.email : undefined,
            disabledReason: offline,
            run: system.signOut,
          }
        : {
            id: 'account.sign-in',
            title: 'Sign in to Juno',
            group: 'Account',
            keywords: 'login account authenticate',
            disabledReason: offline,
            run: system.beginSignIn,
          },
      {
        id: 'account.diagnostics',
        title: 'Refresh diagnostics',
        group: 'Account',
        keywords: 'debug support health',
        disabledReason: offline,
        run: () => {
          shell.toggleInspector();
          system.refreshDiagnostics();
        },
      },
    ];

    return list;
  }, [shell, system, workspaces, session]);
}

const MODE_TITLES: Record<PermissionMode, string> = {
  plan: 'Plan',
  ask: 'Ask',
  'auto-edit': 'Auto-edit',
  full: 'Full access',
};

const MODE_HINTS: Record<PermissionMode, string> = {
  plan: 'Reads and reasons. Changes nothing.',
  ask: 'Asks before every write or command.',
  'auto-edit': 'Edits files freely. Asks before running commands.',
  full: 'No approval prompts.',
};

/**
 * Rank a command against a query.
 *
 * Deliberately simple — substring, with a bonus for matching the title and for
 * matching at a word boundary. Fuzzy matching sounds better and behaves worse:
 * it puts "Sign out" above "Set permission mode" for the query "so" and users
 * cannot form a model of a ranking they cannot see.
 */
export function scoreCommand(command: Command, query: string): number {
  if (query.length === 0) return 1;
  const needle = query.toLowerCase();
  const title = command.title.toLowerCase();
  const haystack = `${title} ${command.group.toLowerCase()} ${command.keywords?.toLowerCase() ?? ''}`;

  const titleIndex = title.indexOf(needle);
  if (titleIndex === 0) return 100;
  if (titleIndex > 0) return title[titleIndex - 1] === ' ' ? 80 : 60;
  return haystack.includes(needle) ? 30 : 0;
}

/**
 * The three things the Work service needs from the operating system.
 *
 * Declared as an interface and implemented with **lazy** `import('electron')`,
 * for one reason that matters more than tidiness: `service.ts` must be
 * importable from a plain Vitest unit test. A top-level `import { dialog } from
 * 'electron'` makes the whole module unloadable outside an Electron process, and
 * every test of the refusal mapping would then need an Electron mock to prove
 * something that has nothing to do with Electron.
 *
 * The import happens inside the method, so a test that never opens a picker
 * never loads Electron.
 */

import type { WorkAccessMode } from '../../shared/contracts/work-vocabulary.js';

export interface ChosenPath {
  /** Absolute. Held in main, never sent to the renderer. */
  readonly path: string;
  /** The basename. This is what the UI shows. */
  readonly label: string;
}

export interface WorkNativePorts {
  /**
   * Open a native picker. Returns null when the user cancelled — which is a
   * normal outcome and not an error.
   */
  chooseGrantPath(
    kind: 'local_folder' | 'local_file',
    accessMode: WorkAccessMode,
  ): Promise<ChosenPath | null>;

  /** Show a downloaded artifact in the Finder, or open it in its default app. */
  revealPath(absolutePath: string, reveal: boolean): Promise<void>;

  /** Where downloaded artifacts land. */
  downloadsDirectory(): Promise<string>;
}

/**
 * The message on the button.
 *
 * The access mode is named on the picker itself rather than only in a later
 * confirmation, because that is the moment the user is deciding, and "Grant read
 * access" and "Grant read and write access" are different questions.
 */
function buttonLabel(accessMode: WorkAccessMode): string {
  switch (accessMode) {
    case 'read':
      return 'Grant read access';
    case 'read_write_no_delete':
      return 'Grant read and write access';
    case 'read_write':
      return 'Grant full access';
  }
}

export function createElectronNativePorts(): WorkNativePorts {
  return {
    async chooseGrantPath(kind, accessMode) {
      const { dialog, BrowserWindow } = await import('electron');
      const path = await import('node:path');
      const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
      const options = {
        title: kind === 'local_folder' ? 'Choose a folder for this task' : 'Choose a file for this task',
        buttonLabel: buttonLabel(accessMode),
        /* One at a time. A multi-select would mint N tokens from one consent,
           and the prompt the user answered named one thing. */
        properties: [
          kind === 'local_folder' ? ('openDirectory' as const) : ('openFile' as const),
        ],
      };
      const result =
        parent === null
          ? await dialog.showOpenDialog(options)
          : await dialog.showOpenDialog(parent, options);

      if (result.canceled) return null;
      const chosen = result.filePaths[0];
      if (chosen === undefined) return null;
      return { path: chosen, label: path.basename(chosen) };
    },

    async revealPath(absolutePath, reveal) {
      const { shell } = await import('electron');
      if (reveal) {
        shell.showItemInFolder(absolutePath);
        return;
      }
      const failure = await shell.openPath(absolutePath);
      if (failure.length > 0) {
        /* `openPath` reports its failure as a string rather than by throwing.
           It names a path, so it is turned into a sentence that does not. */
        throw new Error('Juno could not open that file with the app registered for it.');
      }
    },

    async downloadsDirectory() {
      const { app } = await import('electron');
      return app.getPath('downloads');
    },
  };
}

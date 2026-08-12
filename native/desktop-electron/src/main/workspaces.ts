/**
 * The workspace registry.
 *
 * A workspace is a directory the user has *chosen*, and separately one they may
 * have *trusted*. Those are two different facts and this module never conflates
 * them: `trusted` starts `false` for every workspace, including one the user
 * just picked, and only an explicit `setTrust(id, true)` changes it.
 *
 * That matters because trust is what the rest of the app gates execution on —
 * the PTY manager refuses to spawn in an untrusted root, and the agent host is
 * only ever pointed at a trusted one. A registry that trusted a directory
 * because the user opened it would quietly defeat both.
 *
 * The renderer can never name a path. `choose()` opens a native panel in main
 * and returns a registered workspace; every other call takes an opaque id. That
 * is what makes the trust prompt meaningful — a compromised renderer cannot ask
 * for `/` and then ask for it to be trusted.
 */

import { app, dialog, type BrowserWindow } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { WorkspaceSchema, type Workspace } from '../shared/ipc.js';
import { createLogger } from './logger.js';

const log = createLogger('app');

const REGISTRY_FILE = 'workspaces.json';

/**
 * Persisted shape. Validated on read rather than cast: this file is edited by
 * a crash as often as by anything else, and a truncated JSON parsed as a
 * registry yields a workspace with an undefined path that something downstream
 * will happily `spawn` in.
 */
const RegistryFileSchema = z.object({
  version: z.literal(1),
  workspaces: z.array(WorkspaceSchema),
});

export class WorkspaceRegistry {
  #workspaces = new Map<string, Workspace>();
  #loaded = false;

  readonly #file: string;

  /**
   * The registry file, scoped to an account when one is known.
   *
   * A single global `workspaces.json` was the original design, and it was wrong
   * in a specific and familiar way: revoking *trust* on sign-out is not enough
   * if the **list of paths** survives, because account B then inherits account
   * A's list of directories — their names, their locations, their existence.
   * That is the same defect this project already documented in the Swift
   * client's Work grants (`DesktopWorkGrants.swift:50`), and reproducing it here
   * after writing it down would be hard to defend.
   *
   * The account id is hashed rather than used directly: it is an opaque
   * identifier, but it is still account-identifying, and a directory name is
   * visible to anything that can list `~/Library/Application Support`.
   *
   * `accountId` is optional because the registry is also read before sign-in —
   * the picker and the recents list work signed-out. That pre-account file is a
   * separate one, and nothing in it is trusted.
   */
  constructor(userDataPath: string = app.getPath('userData'), accountId?: string) {
    const scope =
      accountId === undefined
        ? REGISTRY_FILE
        : path.join(
            'accounts',
            createHash('sha256').update(accountId).digest('hex').slice(0, 24),
            REGISTRY_FILE,
          );
    this.#file = path.join(userDataPath, scope);
  }

  async load(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    try {
      const raw = await readFile(this.#file, 'utf8');
      const parsed = RegistryFileSchema.safeParse(JSON.parse(raw) as unknown);
      if (!parsed.success) {
        log.warn('discarding malformed workspace registry');
        return;
      }
      for (const workspace of parsed.data.workspaces) {
        this.#workspaces.set(workspace.id, workspace);
      }
    } catch (error) {
      /* Absent on first run, which is not a problem worth reporting. */
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('could not read workspace registry', { error: String(error) });
      }
    }
  }

  async #persist(): Promise<void> {
    try {
      await mkdir(path.dirname(this.#file), { recursive: true });
      const body: z.infer<typeof RegistryFileSchema> = {
        version: 1,
        workspaces: [...this.#workspaces.values()],
      };
      await writeFile(this.#file, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    } catch (error) {
      log.warn('could not persist workspace registry', { error: String(error) });
    }
  }

  list(): Workspace[] {
    return [...this.#workspaces.values()].sort((a, b) =>
      b.lastOpenedAt.localeCompare(a.lastOpenedAt),
    );
  }

  get(id: string): Workspace | null {
    return this.#workspaces.get(id) ?? null;
  }

  /**
   * Open the native folder panel and register the result.
   *
   * The path is `realpath`'d before it is stored. Storing the symlink instead
   * would mean every later containment check compares against a path that can
   * be re-pointed after the fact — the check would still pass, and it would be
   * checking the wrong thing.
   */
  async choose(parent: BrowserWindow | null): Promise<Workspace | null> {
    const result = parent
      ? await dialog.showOpenDialog(parent, {
          title: 'Open a folder as a workspace',
          properties: ['openDirectory', 'createDirectory'],
          buttonLabel: 'Open',
        })
      : await dialog.showOpenDialog({
          title: 'Open a folder as a workspace',
          properties: ['openDirectory', 'createDirectory'],
          buttonLabel: 'Open',
        });

    const chosen = result.filePaths[0];
    if (result.canceled || chosen === undefined) return null;
    return this.register(chosen);
  }

  /**
   * Register a directory, or return the existing entry for it.
   *
   * The id is derived from the canonical path, so re-opening the same folder
   * cannot produce two entries with divergent trust — one trusted, one not,
   * with no way for the user to tell which the agent is using.
   */
  async register(candidate: string): Promise<Workspace> {
    const canonical = await realpath(candidate);
    const info = await stat(canonical);
    if (!info.isDirectory()) {
      throw new Error('A workspace must be a directory.');
    }

    const id = `ws_${createHash('sha256').update(canonical).digest('hex').slice(0, 24)}`;
    const now = new Date().toISOString();
    const existing = this.#workspaces.get(id);

    const workspace: Workspace = existing
      ? { ...existing, lastOpenedAt: now }
      : {
          id,
          path: canonical,
          name: path.basename(canonical) || canonical,
          /* Never `true` here. Trust is a separate, explicit act. */
          trusted: false,
          isGitRepository: await isGitRepository(canonical),
          branch: null,
          lastOpenedAt: now,
        };

    this.#workspaces.set(id, workspace);
    await this.#persist();
    return workspace;
  }

  async setTrust(id: string, trusted: boolean): Promise<Workspace> {
    const existing = this.#workspaces.get(id);
    if (!existing) throw new Error('That workspace is not registered.');

    const updated: Workspace = { ...existing, trusted };
    this.#workspaces.set(id, updated);
    await this.#persist();
    log.info(trusted ? 'workspace trusted' : 'workspace trust revoked', { id });
    return updated;
  }

  /**
   * Every workspace loses trust.
   *
   * Called on sign-out and on device revocation: a trust decision belongs to
   * the account that made it, and leaving grants in place across accounts is
   * exactly the defect found in the Swift client's Work grants.
   */
  async revokeAllTrust(): Promise<void> {
    let changed = false;
    for (const [id, workspace] of this.#workspaces) {
      if (!workspace.trusted) continue;
      this.#workspaces.set(id, { ...workspace, trusted: false });
      changed = true;
    }
    if (changed) {
      await this.#persist();
      log.info('revoked trust on every workspace');
    }
  }

  /** Fresh id for a workspace that has not been registered. Test seam. */
  static newId(): string {
    return `ws_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
  }
}

async function isGitRepository(root: string): Promise<boolean> {
  try {
    const info = await stat(path.join(root, '.git'));
    /* A worktree's `.git` is a file pointing at the real directory, so both
       shapes count. */
    return info.isDirectory() || info.isFile();
  } catch {
    return false;
  }
}

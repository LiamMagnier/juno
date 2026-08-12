/**
 * The workspace registry, against a real filesystem.
 *
 * Integration rather than unit, because the two properties worth testing are
 * both filesystem facts: that the id is derived from the *canonical* path, and
 * that a symlink therefore cannot produce a second entry with its own trust.
 *
 * `electron` is mocked because the registry imports `app` for a default path
 * and `dialog` for `choose()`. Neither is exercised here — every test passes an
 * explicit directory — but the import has to resolve.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  dialog: { showOpenDialog: vi.fn() },
}));

const { WorkspaceRegistry } = await import('../../src/main/workspaces.js');

let root: string;
let store: string;
let repo: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'juno-registry-'));
  store = path.join(root, 'userdata');
  repo = path.join(root, 'repo');
  await mkdir(store, { recursive: true });
  await mkdir(path.join(repo, '.git'), { recursive: true });
  await writeFile(path.join(repo, 'README.md'), '# fixture\n');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('registering a workspace', () => {
  test('a newly registered workspace is NOT trusted', async () => {
    const registry = new WorkspaceRegistry(store);
    await registry.load();

    const workspace = await registry.register(repo);

    /* The single most important assertion in this file. Choosing a folder is
       not trusting it, and every execution path gates on `trusted`. */
    expect(workspace.trusted).toBe(false);
  });

  test('detects a git repository', async () => {
    const registry = new WorkspaceRegistry(store);
    await registry.load();
    expect((await registry.register(repo)).isGitRepository).toBe(true);

    const plain = path.join(root, 'plain');
    await mkdir(plain);
    expect((await registry.register(plain)).isGitRepository).toBe(false);
  });

  test('refuses a file', async () => {
    const registry = new WorkspaceRegistry(store);
    await registry.load();
    await expect(registry.register(path.join(repo, 'README.md'))).rejects.toThrow(/directory/i);
  });

  test('a symlink to the same directory yields the SAME workspace, not a second one', async () => {
    const registry = new WorkspaceRegistry(store);
    await registry.load();

    const direct = await registry.register(repo);
    await registry.setTrust(direct.id, true);

    const link = path.join(root, 'link-to-repo');
    await symlink(repo, link, 'dir');
    const viaLink = await registry.register(link);

    /* If the id were derived from the supplied path rather than the canonical
       one, this would be a second entry — and it would be untrusted while the
       first was trusted, giving two answers to "may an agent run here?" for one
       directory on disk. */
    expect(viaLink.id).toBe(direct.id);
    expect(viaLink.path).toBe(direct.path);
    expect(viaLink.trusted).toBe(true);
    expect(registry.list()).toHaveLength(1);
  });

  test('re-registering does not silently re-trust or un-trust', async () => {
    const registry = new WorkspaceRegistry(store);
    await registry.load();

    const first = await registry.register(repo);
    await registry.setTrust(first.id, true);

    const again = await registry.register(repo);
    expect(again.trusted).toBe(true);
    expect(again.lastOpenedAt >= first.lastOpenedAt).toBe(true);
  });
});

describe('trust', () => {
  test('setTrust round-trips and persists', async () => {
    const registry = new WorkspaceRegistry(store);
    await registry.load();
    const workspace = await registry.register(repo);

    await registry.setTrust(workspace.id, true);

    const reloaded = new WorkspaceRegistry(store);
    await reloaded.load();
    expect(reloaded.get(workspace.id)?.trusted).toBe(true);
  });

  test('setTrust on an unknown id throws rather than creating one', async () => {
    const registry = new WorkspaceRegistry(store);
    await registry.load();
    await expect(registry.setTrust('ws_nope', true)).rejects.toThrow(/not registered/i);
    expect(registry.list()).toHaveLength(0);
  });

  test('revokeAllTrust clears every grant and survives a reload', async () => {
    const registry = new WorkspaceRegistry(store);
    await registry.load();

    const other = path.join(root, 'other');
    await mkdir(other);
    const a = await registry.register(repo);
    const b = await registry.register(other);
    await registry.setTrust(a.id, true);
    await registry.setTrust(b.id, true);

    await registry.revokeAllTrust();

    /* Sign-out and device revocation both call this. A grant that outlives the
       account that made it is the defect found in the Swift client's Work
       grants — this is the test that stops it recurring here. */
    const reloaded = new WorkspaceRegistry(store);
    await reloaded.load();
    expect(reloaded.list().every((w) => !w.trusted)).toBe(true);
  });
});

describe('the persisted file', () => {
  test('a malformed registry is discarded rather than half-loaded', async () => {
    await writeFile(path.join(store, 'workspaces.json'), '{"version":1,"workspaces":[{"id"', 'utf8');

    const registry = new WorkspaceRegistry(store);
    await registry.load();

    /* A truncated write is the common case — the alternative to discarding is a
       workspace whose `path` is undefined, which something downstream will
       cheerfully spawn a shell in. */
    expect(registry.list()).toEqual([]);
  });

  test('a registry with the wrong shape is discarded', async () => {
    await writeFile(
      path.join(store, 'workspaces.json'),
      JSON.stringify({ version: 1, workspaces: [{ id: 'ws_x', trusted: 'yes' }] }),
      'utf8',
    );
    const registry = new WorkspaceRegistry(store);
    await registry.load();
    expect(registry.list()).toEqual([]);
  });

  test('an absent registry is a normal first run, not an error', async () => {
    const registry = new WorkspaceRegistry(path.join(root, 'does-not-exist'));
    await expect(registry.load()).resolves.toBeUndefined();
    expect(registry.list()).toEqual([]);
  });

  test('what is written back is what a fresh registry reads', async () => {
    const registry = new WorkspaceRegistry(store);
    await registry.load();
    const workspace = await registry.register(repo);

    const raw: unknown = JSON.parse(await readFile(path.join(store, 'workspaces.json'), 'utf8'));
    expect(raw).toMatchObject({ version: 1 });

    const reloaded = new WorkspaceRegistry(store);
    await reloaded.load();
    expect(reloaded.get(workspace.id)).toEqual(workspace);
  });
});

describe('account scoping', () => {
  test('two accounts do not see each other’s workspaces', async () => {
    const a = new WorkspaceRegistry(store, 'account-a');
    const b = new WorkspaceRegistry(store, 'account-b');
    await a.load();
    await b.load();

    const workspace = await a.register(repo);
    await a.setTrust(workspace.id, true);

    /* Account B must not learn that this directory exists, let alone that
       somebody trusted it. Revoking trust on sign-out is not sufficient on its
       own: the *path list* is itself account-identifying information. */
    expect(b.list()).toEqual([]);
    expect(b.get(workspace.id)).toBeNull();

    const reloadedB = new WorkspaceRegistry(store, 'account-b');
    await reloadedB.load();
    expect(reloadedB.list()).toEqual([]);
  });

  test('the same account sees its own workspaces across a reload', async () => {
    const first = new WorkspaceRegistry(store, 'account-a');
    await first.load();
    const workspace = await first.register(repo);

    const again = new WorkspaceRegistry(store, 'account-a');
    await again.load();
    expect(again.get(workspace.id)?.path).toBe(workspace.path);
  });

  test('the signed-out registry is separate from every account registry', async () => {
    const signedOut = new WorkspaceRegistry(store);
    await signedOut.load();
    await signedOut.register(repo);

    const account = new WorkspaceRegistry(store, 'account-a');
    await account.load();
    expect(account.list()).toEqual([]);
  });
});

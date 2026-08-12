/**
 * End-to-end: the privileged capabilities, driven over the real IPC bridge.
 *
 * `globalThis` rather than `window` inside every `page.evaluate` callback: this
 * file compiles in the Node project graph, which deliberately has no DOM lib
 * (see tsconfig.web.json — denying the renderer Node types is a security
 * boundary, and the inverse keeps the two graphs honest). `globalThis` is the
 * same object at runtime in the page.
 *
 * This is the test that would have caught every wiring mistake made while the
 * channel tables were merged. It does not mock the bridge, the router, the
 * registry or the PTY — it launches the built app and calls `window.juno`
 * exactly as the renderer does.
 *
 * The assertions worth protecting, in order of importance:
 *
 *   1. **The trust gate is enforced in main.** An untrusted workspace must
 *      refuse a terminal and refuse a Code session. If this ever passes by
 *      accident, arbitrary directories become executable.
 *   2. **A trusted workspace really runs a shell.** Not "returns an id" — a
 *      command goes in and its output comes back.
 *   3. **The agent host actually forks.** `code:host-status` must reach
 *      `running`, so a failure to start is never mistaken for a provider error.
 */

import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAIN = 'out/main/index.js';

/** A workspace id whose shape matches the registry's, seeded straight to disk. */
const WORKSPACE_ID = 'ws_e2efixture0000000000000';

let app: ElectronApplication;
let page: Page;
let repo: string;

/**
 * Call a channel and normalise the outcome.
 *
 * Rejections are captured rather than thrown so a *refusal* — which several of
 * these tests are asserting — reads as data instead of a failure.
 */
async function call(
  channel: string,
  payload?: unknown,
): Promise<{ ok: boolean; value?: unknown; error?: string }> {
  return page.evaluate(
    ([c, p]) =>
      (globalThis as unknown as { juno: { invoke: (c: string, p?: unknown) => Promise<unknown> } }).juno
        .invoke(c as never, p)
        .then(
          (value) => ({ ok: true, value }),
          (error: unknown) => ({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
    [channel, payload] as const,
  );
}

test.beforeAll(async () => {
  test.skip(!existsSync(MAIN), `${MAIN} not built — run \`npm run build\` first.`);

  /* Seed a workspace registry before the app starts, so the test does not need
     the native folder picker (which cannot be driven from here). It is written
     UNTRUSTED, which is the state the first two assertions depend on. */
  const probe = await electron.launch({ args: [MAIN], cwd: process.cwd() });
  const userData: string = await probe.evaluate(({ app: electronApp }) =>
    electronApp.getPath('userData'),
  );
  await probe.close();

  repo = mkdtempSync(join(tmpdir(), 'juno-e2e-ws-'));
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(userData, { recursive: true });
  writeFileSync(
    join(userData, 'workspaces.json'),
    JSON.stringify({
      version: 1,
      workspaces: [
        {
          id: WORKSPACE_ID,
          path: repo,
          name: 'e2e-fixture',
          trusted: false,
          isGitRepository: true,
          branch: null,
          lastOpenedAt: new Date(0).toISOString(),
        },
      ],
    }),
  );

  app = await electron.launch({ args: [MAIN], cwd: process.cwd() });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');

  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __out: unknown[];
      __host: unknown[];
      juno: { on: (c: string, cb: (p: unknown) => void) => void };
    };
    w.__out = [];
    w.__host = [];
    w.juno.on('terminal:output', (p) => w.__out.push(p));
    w.juno.on('code:host-status', (p) => w.__host.push(p));
  });
});

test.afterAll(async () => {
  await app?.close();
});

test.describe('the workspace trust gate', () => {
  test('the seeded workspace is visible and starts untrusted', async () => {
    const result = await call('workspace:list');
    expect(result.ok).toBe(true);
    const list = result.value as Array<{ id: string; trusted: boolean }>;
    const found = list.find((w) => w.id === WORKSPACE_ID);
    expect(found).toBeDefined();
    expect(found?.trusted).toBe(false);
  });

  test('an untrusted workspace refuses a terminal', async () => {
    const result = await call('terminal:create', { workspaceId: WORKSPACE_ID, cols: 80, rows: 24 });
    expect(result.ok).toBe(false);
    /* The message matters as much as the refusal: it has to tell the user what
       to do, not merely that something failed. */
    expect(result.error).toMatch(/trust/i);
  });

  test('an untrusted workspace refuses a Code session', async () => {
    const result = await call('code:start-session', { workspaceId: WORKSPACE_ID });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/trust/i);
  });

  test('an unregistered workspace id is refused rather than invented', async () => {
    const result = await call('terminal:create', {
      workspaceId: 'ws_definitelynotregistered',
      cols: 80,
      rows: 24,
    });
    expect(result.ok).toBe(false);
  });
});

test.describe('a trusted workspace', () => {
  test('can be trusted, and then really runs a shell', async () => {
    const trusted = await call('workspace:set-trust', {
      workspaceId: WORKSPACE_ID,
      trusted: true,
    });
    expect(trusted.ok).toBe(true);
    expect((trusted.value as { trusted: boolean }).trusted).toBe(true);

    const created = await call('terminal:create', {
      workspaceId: WORKSPACE_ID,
      cols: 80,
      rows: 24,
    });
    expect(created.ok).toBe(true);

    const terminalId = (created.value as { terminal: { id: string } }).terminal.id;
    expect(terminalId).toMatch(/^term_[0-9a-f-]{36}$/);

    /* Arithmetic the shell must actually perform — a literal echoed back would
       pass a weaker assertion, so the expected string never appears in what is
       sent. */
    await call('terminal:write', { terminalId, data: 'echo JUNO_E2E_$((6*7))\n' });

    await expect
      .poll(
        async () =>
          page.evaluate(() =>
            (globalThis as unknown as { __out: Array<{ chunk: string }> }).__out
              .map((o) => o.chunk)
              .join(''),
          ),
        { timeout: 15_000, message: 'the PTY never echoed the computed marker' },
      )
      .toContain('JUNO_E2E_42');

    const listed = await call('terminal:list', {});
    expect(listed.ok).toBe(true);
    expect((listed.value as Array<{ id: string }>).some((t) => t.id === terminalId)).toBe(true);

    expect((await call('terminal:kill', { terminalId })).ok).toBe(true);
  });
});

test.describe('the agent host', () => {
  test('forks and reaches running, then reports a provider problem as its own', async () => {
    const started = await call('code:start-session', { workspaceId: WORKSPACE_ID });

    await expect
      .poll(
        async () =>
          page.evaluate(() =>
            (globalThis as unknown as { __host: Array<{ status: string }> }).__host.map(
              (h) => h.status,
            ),
          ),
        { timeout: 30_000, message: 'the agent host never reported running' },
      )
      .toContain('running');

    /* Without a configured provider the session cannot start — and that is the
       correct outcome. What must NOT happen is a fabricated session id, and
       what must not happen either is the provider error being reported as a
       host crash. Both are asserted: the host reached `running` above, and the
       failure below is specific. */
    if (!started.ok) {
      expect(started.error).toMatch(/provider|api key/i);
    } else {
      expect((started.value as { sessionId: string }).sessionId).toBeTruthy();
    }
  });
});

test.describe('diagnostics', () => {
  test('reports honestly rather than optimistically', async () => {
    const result = await call('diagnostics:snapshot');
    expect(result.ok).toBe(true);
    const snapshot = result.value as {
      appVersion: string;
      contractVersion: string;
      backendReachable: boolean;
      authStatus: string;
    };
    expect(snapshot.appVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(snapshot.contractVersion).toBeTruthy();
    /* Signed out and never having completed a round trip, "reachable" must be
       false. A diagnostics panel that guesses is worse than none. */
    expect(snapshot.backendReachable).toBe(false);
  });
});

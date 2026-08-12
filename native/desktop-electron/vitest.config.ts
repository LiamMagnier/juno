/**
 * Vitest configuration for the Electron workspace.
 *
 * Two projects, both Node: `unit` and `integration`. They are separated by
 * cost, not by environment — a unit test may not touch the filesystem, a
 * socket, a database or a child process, and gets a short timeout that makes
 * violating that rule show up as a failure rather than as a slow suite.
 * Integration tests may do all of those and get a timeout that a real SQLite
 * open or a sidecar handshake can actually fit inside.
 *
 * `projects` rather than a `vitest.workspace.ts` file: the workspace file was
 * deprecated in Vitest 3.2 in favour of this field, and keeping the definition
 * inside the config means the projects inherit `resolve.alias` below via
 * `extends: true` instead of each restating it.
 *
 * On why Vitest at all when the repository root runs `tsx --test` (node:test):
 * see `docs/TESTING.md`. Short version — the code under test is resolved by
 * Vite in every other context (electron-vite builds main, preload and renderer
 * with it), and the `@juno/*` and `@shared/*` aliases below are Vite aliases in
 * production. Running the tests through a different resolver would mean the
 * suite proves something about a module graph the app never actually loads.
 */

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const workspaceRoot = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

export default defineConfig({
  resolve: {
    /**
     * The same three mappings as `tsconfig.base.json`, in the same order.
     *
     * Array form rather than object form because order is load-bearing:
     * `@juno/agent-core` is a prefix of `@juno/agent-core/types`, and a string
     * alias in Rollup/Vite matches on that prefix. The more specific entry must
     * be tried first or every `/types` import would resolve to `index`.
     *
     * The replacements point at `.ts` sources while the tsconfig `paths` point
     * at `.js`. That is deliberate and not a drift: TypeScript's `paths` are
     * written against the *emitted* specifier, whereas a bundler alias is a
     * filesystem path and should name the file that exists. Both land on the
     * same module.
     */
    alias: [
      {
        find: '@juno/agent-core/types',
        replacement: `${repoRoot}runner/agent-core/src/types.ts`,
      },
      {
        find: '@juno/agent-core',
        replacement: `${repoRoot}runner/agent-core/src/index.ts`,
      },
      { find: '@shared', replacement: `${workspaceRoot}src/shared` },
    ],
  },

  test: {
    projects: [
      {
        /* Inherit the root `resolve.alias`. Projects do not inherit by default. */
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts'],
          /* A unit test that needs longer than this is an integration test
             that has not been moved yet. */
          testTimeout: 5_000,
          hookTimeout: 5_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          environment: 'node',
          /* The directory is empty until the main process it exercises exists.
             The project is declared now anyway: `npm test` already names it, so
             the first integration test to land is run by the gate on the day it
             lands rather than on the day someone remembers to wire it up.
             `passWithNoTests` is a root-only option in Vitest 3 and so cannot be
             set per project — an empty directory is tolerated because the `unit`
             project in the same run does have files. */
          include: ['tests/integration/**/*.test.ts'],
          /* Room for a real database open, a real sidecar spawn and a real
             handshake, on a cold and contended CI machine. */
          testTimeout: 30_000,
          hookTimeout: 30_000,
          /* Integration tests will share a database file and the agent host's
             port, so they must not run concurrently. `fileParallelism` is a
             root-only option in Vitest 3 and cannot be set per project, so the
             constraint is expressed per file with `describe.sequential` /
             `test.sequential` until there is a reason to serialise the whole
             run. Recorded here because it is not obvious from the file side. */
        },
      },
    ],
  },
});

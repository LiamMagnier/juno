import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";

const projectRoot = dirname(fileURLToPath(import.meta.url));
const fromRoot = (...segments: string[]): string => resolve(projectRoot, ...segments);

/* ── Path aliases ──────────────────────────────────────────────────────────
 *
 * These mirror `paths` in tsconfig.base.json. TypeScript resolves them for
 * type-checking; Vite has no idea about tsconfig paths, so the same mapping has
 * to exist here or the build fails where `tsc` was happy.
 *
 * tsconfig writes the targets with a `.js` extension (the ESM-correct spelling
 * for a `.ts` source under `moduleResolution: "bundler"`). Vite's alias layer is
 * plain string replacement with no TypeScript extension rewriting, so the
 * aliases below point at the actual `.ts` files on disk.
 *
 * Order matters. Vite inherits `@rollup/plugin-alias` matching semantics: a
 * string `find` matches the exact id *or* anything under `find + "/"`, so a bare
 * `@juno/agent-core` entry would swallow `@juno/agent-core/types`. The more
 * specific entry has to come first, which is why this is an array and not the
 * object form.
 */
const agentCoreTypesAlias = {
  find: "@juno/agent-core/types",
  replacement: fromRoot("../../runner/agent-core/src/types.ts"),
};
const agentCoreAlias = {
  find: "@juno/agent-core",
  replacement: fromRoot("../../runner/agent-core/src/index.ts"),
};
const sharedAlias = {
  find: "@shared",
  replacement: fromRoot("src/shared"),
};

/**
 * The subset of Node builtins Electron polyfills inside a sandboxed preload.
 * Anything else the preload tries to reach is a bug that will only show up at
 * runtime, as a blank window and a console error nobody is watching.
 *
 * @see https://www.electronjs.org/docs/latest/tutorial/sandbox
 */
const SANDBOXED_PRELOAD_ALLOWED_EXTERNALS = new Set(["electron", "events", "timers", "url"]);

/**
 * Fails the build if the preload bundle is not a single self-contained file.
 *
 * Two independent constraints land on the same requirement, and both of them
 * fail at runtime rather than at build time, which is why they are asserted
 * here instead of trusted:
 *
 *   1. `sandbox: true` preloads run without a real module loader. They cannot
 *      `require()` a sibling file, so any code-split chunk is unreachable.
 *   2. The app ships packed in an ASAR. Even unsandboxed, resolving a relative
 *      import out of `app.asar` from a preload is not something to rely on.
 *
 * The config below (`externalizeDeps: false`, `inlineDynamicImports: true`,
 * `format: "cjs"`) is what produces a compliant bundle. This plugin is the
 * tripwire for the day somebody changes one of those and everything still
 * *builds*.
 */
function assertSelfContainedPreload(): Plugin {
  return {
    name: "juno:assert-self-contained-preload",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const entries = Object.values(bundle).filter(
        (item) => item.type === "chunk" && item.isEntry,
      );
      const extraChunks = Object.values(bundle).filter(
        (item) => item.type === "chunk" && !item.isEntry,
      );

      if (entries.length !== 1) {
        this.error(
          `preload must build to exactly one entry chunk, got ${entries.length}. ` +
            "A sandboxed preload cannot load a second file.",
        );
      }

      if (extraChunks.length > 0) {
        const names = extraChunks.map((chunk) => chunk.fileName).join(", ");
        this.error(
          `preload was code-split into ${extraChunks.length} extra chunk(s): ${names}. ` +
            "A sandboxed preload cannot require() them. Check build.externalizeDeps " +
            "and output.inlineDynamicImports in electron.vite.config.ts.",
        );
      }

      for (const chunk of entries) {
        if (chunk.type !== "chunk") continue;
        const disallowed = [...chunk.imports, ...chunk.dynamicImports].filter(
          (id) => !SANDBOXED_PRELOAD_ALLOWED_EXTERNALS.has(id.replace(/^node:/, "")),
        );
        if (disallowed.length > 0) {
          this.error(
            `preload has external imports a sandboxed preload cannot resolve: ` +
              `${disallowed.join(", ")}. Only ` +
              `${[...SANDBOXED_PRELOAD_ALLOWED_EXTERNALS].join(", ")} are available.`,
          );
        }
      }
    },
  };
}

export default defineConfig({
  /* ── Main process ────────────────────────────────────────────────────────
   *
   * Two entries, not one. `src/main/index.ts` is the Electron main process;
   * `src/agent-host/index.ts` is a separate program that main launches with
   * `utilityProcess.fork()`. It is built here rather than in its own pass
   * because it targets the same runtime (Electron's Node, same `build.target`,
   * same externals) and has to land beside main so a relative path from
   * `out/main/index.js` can find it at `out/main/agent-host.js`.
   *
   * Output format is ES: package.json declares `"type": "module"` and Electron
   * 43 loads an ESM main process. electron-vite picks this up on its own, but
   * it is written out below because the agent-host entry makes the emitted file
   * names load-bearing.
   */
  main: {
    resolve: {
      alias: [agentCoreTypesAlias, agentCoreAlias, sharedAlias],
    },
    build: {
      /* Externalize everything in package.json `dependencies` — which is how
       * `node-pty` stays out of the bundle. It is a native addon: its `.node`
       * binary and its `spawn-helper` executable are loaded through
       * `process.dlopen` and `posix_spawn`, neither of which a bundler can
       * follow or rewrite. Bundling it would produce a main bundle that throws
       * on first terminal.
       *
       * electron-builder always ships production `dependencies` into the app's
       * node_modules, so the externalized requires resolve at runtime. This is
       * also why the runtime deps have to stay in `dependencies` and not
       * `devDependencies` — a packaging tool drops the latter.
       *
       * `true` is electron-vite 5's default; it is spelled out because moving a
       * package between the two dependency blocks silently changes the shape of
       * this bundle. */
      externalizeDeps: true,
      rollupOptions: {
        input: {
          index: fromRoot("src/main/index.ts"),
          "agent-host": fromRoot("src/agent-host/index.ts"),
        },
        output: {
          format: "es",
          // No hash: package.json `main` points at out/main/index.js, and main
          // resolves the agent host by the literal name out/main/agent-host.js.
          entryFileNames: "[name].js",
          chunkFileNames: "chunks/[name]-[hash].js",
        },
      },
    },
  },

  /* ── Preload ─────────────────────────────────────────────────────────────
   *
   * CommonJS, deliberately, in an otherwise-ESM project.
   *
   * The renderer runs with `sandbox: true`. Electron only accepts an ESM
   * preload when the renderer is *unsandboxed* and the file is named `.mjs`;
   * a sandboxed preload must be CommonJS. electron-vite encodes the same rule —
   * it renames preload entries to `[name].mjs` only when the output format is
   * `es`, so asking for `cjs` here is what keeps the emitted file
   * `out/preload/index.js`, which is the path main will reference.
   *
   * Note the `.js` extension survives despite `"type": "module"`: Electron does
   * not consult package.json when loading a preload, it goes by extension.
   *
   * @see https://www.electronjs.org/docs/latest/tutorial/esm
   */
  preload: {
    resolve: {
      // No `@juno/agent-core` here. The preload is a message-passing shim; it
      // has no business importing the agent runtime, and agent-core reaches for
      // Node builtins that a sandboxed preload does not have.
      alias: [agentCoreTypesAlias, sharedAlias],
    },
    plugins: [assertSelfContainedPreload()],
    build: {
      // Bundle everything. The default (`true`) would leave `dependencies` as
      // bare `require()` calls that a sandboxed preload cannot resolve.
      externalizeDeps: false,
      rollupOptions: {
        input: { index: fromRoot("src/preload/index.ts") },
        output: {
          format: "cjs",
          entryFileNames: "[name].js",
          // One file, always — a dynamic import must not become a second chunk.
          inlineDynamicImports: true,
        },
      },
    },
  },

  /* ── Renderer ────────────────────────────────────────────────────────────
   *
   * A browser. It gets no Node, no Electron, and no filesystem — the only way
   * out is the typed bridge the preload exposes over `contextBridge`.
   *
   * That boundary is stated in three places so it fails at three different
   * times: tsconfig.web.json omits @types/node (fails at type-check),
   * eslint.config.mjs bans `node:*` and `electron` imports (fails at lint), and
   * the alias list here omits `@juno/agent-core` (fails at build, as an
   * unresolved import, because agent-core pulls in the Node-side world).
   * `@juno/agent-core/types` stays available — it is types only, erased before
   * anything reaches the bundle.
   */
  renderer: {
    root: fromRoot("src/renderer"),
    resolve: {
      alias: [agentCoreTypesAlias, sharedAlias],
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: { index: fromRoot("src/renderer/index.html") },
      },
    },
  },
});

/**
 * ESLint 9 flat config for the Juno desktop (Electron) workspace.
 *
 * Scoped to this directory rather than inherited from the repo root: the root
 * config extends `next/core-web-vitals`, which is the wrong rule set for a
 * three-process Electron app and would report Next-specific findings on files
 * that will never see Next. The conventions this file does keep from the root
 * config are the ones that are about this codebase rather than about Next:
 *
 *   - `_`-prefixed bindings are the repo's "intentionally unused" convention,
 *     and caught errors may be omitted.
 *   - Rules that encode an architectural boundary are `error`, not `warn`. The
 *     root config makes the same argument about the design system: a rule
 *     nothing fails CI over is a suggestion, and suggestions lose.
 *
 * The main event here is `no-restricted-imports` on `src/renderer/**`. See
 * RENDERER_FORBIDDEN below.
 */

import { builtinModules } from "node:module";

import js from "@eslint/js";
import globals from "globals";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

/**
 * The renderer's import boundary, expressed as a lint rule.
 *
 * The renderer runs untrusted-ish content — model output, rendered markdown,
 * whatever an agent decides to put on screen — with `contextIsolation: true`
 * and `sandbox: true`. Its only route to the outside is the typed surface the
 * preload publishes over `contextBridge`. A single `import { ipcRenderer } from
 * "electron"` or `import { exec } from "node:child_process"` in a renderer file
 * quietly reopens the door that architecture closed.
 *
 * This is the third of three independent guards on the same boundary, and it is
 * the one that fires earliest and reads most clearly:
 *
 *   1. tsconfig.web.json omits @types/node, so a Node import is a type error.
 *   2. electron.vite.config.ts withholds the `@juno/agent-core` alias from the
 *      renderer, so importing the agent runtime fails to build.
 *   3. This rule, which names the boundary out loud at the moment it is crossed
 *      instead of leaving a reviewer to infer it from a missing type.
 *
 * Both bare (`fs`) and prefixed (`node:fs`) spellings are listed: the prefixed
 * form is the modern one, and the bare form is what muscle memory produces.
 */
const RENDERER_FORBIDDEN = [
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
  "electron",
  "electron-updater",
  "node-pty",
  // The agent runtime is main-process code; it transitively reaches the
  // filesystem, the network and child processes.
  "@juno/agent-core",
];

const RENDERER_BOUNDARY_MESSAGE =
  "The renderer is sandboxed and context-isolated: it has no Node and no " +
  "Electron. Go through the preload bridge (window.juno) instead, adding an " +
  "IPC channel in src/shared/channels.ts if one does not exist yet. Types " +
  "from @juno/agent-core/types are fine — they are erased at build time.";

export default tseslint.config(
  {
    // Global ignores. Generated output and dependencies are not source.
    ignores: [
      "out/**",
      /* Anchored patterns only catch build output at the workspace root. A
         misconfigured `outDir` puts it somewhere else — this actually happened,
         producing `src/renderer/out/` and 1,127 lint errors in one bundled
         asset that drowned every real finding. Linting a generated file is
         never right, wherever it lands. */
      "**/out/**",
      "**/.vite/**",
      /* Agent worktrees. A background task can materialise a full checkout of
         the repository under `.claude/worktrees/`, and linting a nested copy of
         the whole project reported 2,143 errors in one vendored asset — again
         drowning the real findings. Already gitignored at the root; ignored
         here too, because ESLint does not read that file. */
      "**/.claude/**",
      "**/.worktrees/**",
      "dist/**",
      "node_modules/**",
      ".vite/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
      "resources/**",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    // Baseline for every TypeScript file in the workspace.
    files: ["**/*.{ts,tsx,mts,cts}"],
    languageOptions: {
      parserOptions: {
        // Type-aware linting is deliberately off. `tsc --build` already runs as
        // its own gate (`npm run typecheck`) over both project graphs with
        // strict plus four extra flags; re-deriving type information inside
        // ESLint would double the wall clock of `npm run gates` to catch what
        // the compiler already catches.
        project: false,
      },
    },
    rules: {
      // Matches the root config's convention exactly.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          caughtErrors: "none",
        },
      ],
      // `any` erases the process boundary this app is built around: an IPC
      // payload typed `any` is an unvalidated message from another process.
      // A warning rather than an error so it can be shipped past under time
      // pressure, but never silently.
      "@typescript-eslint/no-explicit-any": "warn",
      // tsconfig.base.json sets `verbatimModuleSyntax`, which makes the
      // type/value distinction load-bearing at emit time rather than stylistic.
      "@typescript-eslint/consistent-type-imports": [
        "warn",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      // The main process logs to stdout by design — that output is the app's
      // diagnostic channel, and the build hooks in scripts/ log deliberately.
      "no-console": "off",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-var": "error",
      "prefer-const": ["error", { destructuring: "all" }],
    },
  },

  {
    // ── Renderer: the security boundary ──────────────────────────────────
    files: ["src/renderer/**/*.{ts,tsx}"],
    languageOptions: {
      globals: globals.browser,
    },
    plugins: { "react-hooks": reactHooks, react },
    rules: {
      /* Two rules, not the plugin's whole `recommended` set.
     *
     * `rules-of-hooks` and `exhaustive-deps` are the two that catch genuine
     * defects, and `exhaustive-deps` is an *error* here for a domain-specific
     * reason: this UI subscribes to push channels and returns an unsubscribe
     * function from `useEffect`. A stale closure in that pattern does not
     * merely re-render oddly — it leaks a listener per mount and then reports
     * agent events into a dead component.
     *
     * v7's `recommended` additionally enables the React-Compiler-derived rules
     * (`set-state-in-effect`, `purity`, and friends). Turning those on reports
     * ~1,190 findings across this renderer. Most are real observations about
     * effect-driven state, and adopting them is a worthwhile refactor — but it
     * is a refactor, not a lint fix, and switching them on now would mean
     * either a wall of suppressions or a permanently red gate. Tracked in
     * STATUS.md; enable them deliberately, one rule at a time. */
      "react-hooks/rules-of-hooks": "error",
      /* Only this one rule from eslint-plugin-react, not its recommended set —
         most of which is about JSX style or duplicates what TypeScript already
         proves. An index key is a real correctness issue in a streaming
         transcript: rows are inserted and re-ordered as events arrive, and an
         index key makes React reuse the wrong DOM node. Where a list is
         genuinely positional and stable, the call site disables it explicitly. */
      "react/no-array-index-key": "warn",
      /* `warn`, not `error`, and the distinction is worth stating precisely.
       *
       * The dangerous direction is a *missing* dependency — that is the stale
       * closure that leaks a listener per mount. Every finding this rule
       * currently reports is the *opposite* direction ("unnecessary
       * dependency"), and all of them come from one deliberate pattern: the
       * streaming surfaces keep events in a mutable ref and bump a version
       * counter to force a recompute, because re-deriving a whole transcript on
       * every token is the performance failure this app is built to avoid. The
       * memo body genuinely does not read `version`; removing it from the deps
       * would freeze the view.
       *
       * The rule cannot see that, and it does not separate the two directions.
       * Failing the build over the benign one would buy a wall of suppressions.
       * The right fix is `useSyncExternalStore`, which expresses this correctly
       * and satisfies the rule — tracked in STATUS.md. Until then these stay
       * visible rather than silenced. */
      "react-hooks/exhaustive-deps": "warn",
      // ESLint's own rule, not @typescript-eslint's extension of it. As of
      // ESLint 9.37 the base rule understands `import type`, inline type
      // specifiers and `import x = require(...)`, and supports
      // `allowTypeImports` on both `paths` and `patterns` — which deprecated
      // the extension rule outright.
      "no-restricted-imports": [
        "error",
        {
          paths: RENDERER_FORBIDDEN.map((name) => ({
            name,
            /* Same reasoning as the `patterns` group below: `import type` is
               erased before a bundle exists, so it cannot pull Node code into
               the renderer. Without this, sharing the agent event *vocabulary*
               with the renderer would be impossible and every surface would
               retype the protocol by hand. */
            allowTypeImports: true,
            message: RENDERER_BOUNDARY_MESSAGE,
          })),
          patterns: [
            {
              // Deep imports into the same packages: `electron/renderer`,
              // `node:fs/promises`, `@juno/agent-core/tools/...`.
              group: ["node:*/*", "electron/*", "@juno/agent-core/*"],
              // `@juno/agent-core/types` is types only, erased before it
              // reaches the bundle, and is how the renderer speaks the same
              // vocabulary as the agent host. Type-only imports of the rest are
              // harmless for the same reason — nothing survives to runtime.
              allowTypeImports: true,
              message: RENDERER_BOUNDARY_MESSAGE,
            },
          ],
        },
      ],
    },
  },

  {
    // Main, preload and the agent host: Node and Electron are the point.
    files: ["src/main/**/*.ts", "src/preload/**/*.ts", "src/agent-host/**/*.ts"],
    languageOptions: {
      globals: globals.node,
    },
  },

  {
    // Code shared across the boundary. It is imported by BOTH the renderer and
    // the main process, so it must hold to the renderer's constraints — a
    // Node import here would be laundered into the renderer bundle.
    files: ["src/shared/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: RENDERER_FORBIDDEN.map((name) => ({
            name,
            // Type-only imports are erased before the bundle exists, so they
            // cannot launder anything into the renderer. This is load-bearing
            // rather than a convenience: `src/shared/agent-protocol.ts` imports
            // agent-core's types precisely so the compiler can prove the Zod
            // validators still match the shared contract. Forbidding that would
            // force the contract to be retyped by hand — which is the drift the
            // file exists to prevent.
            allowTypeImports: true,
            message:
              "src/shared is imported by the renderer as well as the main " +
              "process, so it must stay free of Node and Electron. Put " +
              "process-specific code in src/main or src/renderer and keep the " +
              "types and channel names here. (Type-only imports are allowed.)",
          })),
        },
      ],
    },
  },

  {
    // Build tooling and tests run in Node, outside the app's process model.
    files: [
      "*.{ts,mts,cts,mjs,cjs,js}",
      "scripts/**/*.{ts,mjs,cjs,js}",
      "tests/**/*.{ts,tsx}",
    ],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      "@typescript-eslint/no-var-requires": "off",
      "@typescript-eslint/no-require-imports": "off",
    },
  },
);

# Testing the Juno desktop app

Three layers, separated by what they are allowed to touch, plus one deliberate
deviation from the repository's house test idiom that is explained below.

| Layer | Runner | Directory | May touch | Gate |
|---|---|---|---|---|
| Unit | Vitest, `unit` project | `tests/unit` | Pure functions and schemas. No filesystem, socket, database or child process. | `npm test` |
| Integration | Vitest, `integration` project | `tests/integration` | A real SQLite file, a real agent-host process, a real socket — but not Electron. | `npm test` |
| End-to-end | Playwright, `_electron.launch` | `tests/e2e` | A real Electron app, built. | `npm run test:e2e` |

`npm run gates` runs `typecheck → lint → tokens:check → contract:check → test`.
E2E is deliberately outside it; see [Why E2E is not in `npm test`](#why-e2e-is-not-in-npm-test).

---

## The deviation: Vitest here, `tsx --test` at the repository root

The repository root runs `tsx --test tests/*.test.ts` — `node:test` with
`node:assert/strict`, flat `test()` calls whose names are full sentences. That is
the house idiom, and `tests/csp.test.ts` is a good example of it.

This workspace uses **Vitest 3** instead. Three reasons, in order of weight:

1. **The module graph under test is a Vite graph.** `electron-vite` builds main,
   preload and renderer, and `@juno/agent-core`, `@juno/agent-core/types` and
   `@shared/*` are resolved by Vite aliases in every other context. Running the
   tests through `tsx`'s resolver would mean asserting against a module graph the
   application never actually loads — the aliases could drift, or resolve to a
   different file, and the suite would not notice. `vitest.config.ts` declares the
   same three aliases as `tsconfig.base.json`, in the same order.

2. **`src/main/security.ts` imports `electron` at module scope.** Testing it
   requires substituting that module, and proving a URL was *refused* requires a
   spy on `shell.openExternal` to show it was never called. `node:test` has
   `mock.module`, but it is still experimental and does not compose with a Vite
   resolver. `vi.mock` does, and is the reason `tests/unit/security.test.ts` can
   make its central assertion at all.

3. **The renderer will need a DOM.** `src/renderer` is React. A third project
   with `environment: 'jsdom'` is a one-block addition to the `projects` array
   the moment there is a component worth testing; the same change under
   `node:test` means a second runner. The two projects that exist today are both
   `environment: 'node'`, because nothing in `src/main`, `src/preload`,
   `src/shared` or `src/agent-host` needs a DOM.

What is **kept** from the house idiom: test names are sentences that state the
property being asserted, not `describe('foo') > it('works')`; assertions are
exact rather than partial; and every non-obvious assertion carries a comment
saying why it matters. `describe` is used only to group, never to build a
sentence out of nested strings.

### Configuration choices

- **`projects`, not `vitest.workspace.ts`.** The workspace file was deprecated in
  Vitest 3.2. Declaring the projects inline also lets them inherit the root
  `resolve.alias` via `extends: true`, instead of restating it twice.
- **The alias replacements point at `.ts` files** where `tsconfig.base.json`
  points at `.js`. Not drift: TypeScript's `paths` are written against the
  *emitted* specifier, a bundler alias is a filesystem path. Both land on the
  same module.
- **Timeouts are the boundary between the two projects.** Unit gets 5 s, which a
  pure function cannot exceed; a unit test that needs longer is an integration
  test that has not been moved yet. Integration gets 30 s, which fits a cold
  SQLite open and a sidecar handshake on a contended CI machine.
- **`passWithNoTests` and `fileParallelism` are root-only options in Vitest 3**
  and cannot be set per project. Two consequences are recorded below.

---

## Running the suites

```bash
npm test               # unit + integration            → the gate
npm run test:unit      # unit only
npm run test:integration
npm run test:watch
npm run test:e2e       # Playwright; skips unless the app is built
```

### Installing dependencies

`npm install` currently fails with `ERESOLVE`: the workspace pins `vite@^7.3.6`
while `@vitejs/plugin-react@^6.0.5` declares a peer dependency on `vite@^8.0.0`.
Until one of the two is moved, install with:

```bash
npm install --legacy-peer-deps
```

This is a real dependency conflict in `package.json`, not a test-infrastructure
problem, and it will hit CI the same way it hits a laptop.

### `npm run test:integration` exits 1 while `tests/integration` is empty

Vitest treats "no test files found" as a failure, and `passWithNoTests` cannot be
scoped to one project. This is left as-is rather than papered over: setting it at
the root would also make a *broken* `unit` include-glob pass silently with zero
tests, which is the worse failure of the two. `npm test` — the gate — selects both
projects and passes, because `unit` has files. `test:integration` goes green the
moment the first integration test lands.

### Integration tests must serialise themselves

They will share a SQLite file and the agent host's port, and the single-instance
lock in `applyProcessSecurityPolicy` makes a second app instance quit. Since
`fileParallelism` is root-only, use `describe.sequential` / `test.sequential`
inside integration files rather than serialising the whole run.

---

## What each layer covers

### Unit — `tests/unit`

**`agent-protocol.test.ts`** — the agent-host wire protocol. Every one of the 14
`AgentEvent` variants round-trips through `AgentEventSchema` unchanged and
survives a real `JSON.parse(JSON.stringify(...))` hop; malformed events are
rejected (missing discriminator, made-up discriminator, near-miss discriminator,
missing required field, wrong field type, out-of-contract enum value, malformed
nested payload); `parseSidecarMessage` returns `ok: false` with a readable,
payload-free error for twelve kinds of bad frame rather than throwing, because a
throw on a long-lived stream would tear down the session.

The sample table is typed from `@juno/agent-core`, not from `z.infer`, so a
variant added upstream and mirrored into the schema but never sampled here is a
compile error. The list of variant names is *also* restated as runtime data,
because the compile-time gate has already been inert once (see below).

**`security.test.ts`** — `isInternalUrl` (accepts the app origin; rejects
subdomain lookalikes, userinfo tricks, other schemes, and unparseable input),
`openExternal` (refuses every non-https scheme and every non-allowlisted host,
proving `shell.openExternal` was never reached), `redactUrl` (a token in the
query or the fragment does not survive), `SECURE_WEB_PREFERENCES`, and the CSP.

**`ipc-contract.test.ts`** — name/schema correspondence in both directions for
both channel tables, and, for every one of the 23 channels, a valid payload that
must parse and an invalid one that must not. Also a junk sweep per channel, which
is the only thing that catches a schema written as `z.any()`.

### Integration — `tests/integration`

Empty today. It is for the things that need a real resource but not a real
window: SQLite migrations applying forward on a real file, the sync reducer over
a real cursor, the agent host spawning and completing a handshake, `node-pty`
producing output. Anything that needs `app.whenReady()` belongs in E2E.

### End-to-end — `tests/e2e`

`smoke.spec.ts` launches the built app through `_electron.launch` and asserts the
things that only a live process can show: exactly one window opens, its title is
the product name (not the Electron default of the HTML filename), the window is
visible and non-degenerate, the renderer is served from `juno://app` rather than
`file://`, and the renderer has no `require`, `process` or `module` — the runtime
half of `SECURE_WEB_PREFERENCES`, which the unit test can only check as a
declaration.

#### Why E2E is not in `npm test`

It needs `npm run build` to have produced `out/main/index.js` first. A suite that
fails on a clean checkout is a suite people learn to ignore, so the spec **skips**
when that file is absent, prints the reason on stderr (Playwright's `list`
reporter does not print skip annotations), and exits 0.

---

## What CI should run

There is **no GitHub Actions workflow for this workspace yet** —
`.github/workflows/native.yml` covers the Swift packages and the Xcode apps, and
nothing in `.github/workflows` references `native/desktop-electron`. Until one
exists, the gate is `npm run gates`, run by hand. The workflow, when written,
should be:

| Job | Runner | Steps |
|---|---|---|
| Contracts | `ubuntu-latest` | `npm ci --legacy-peer-deps`, `npm run typecheck`, `npm run lint`, `npm run tokens:check`, `npm run contract:check`, `npm test` |
| Smoke | `macos-26` | the above, plus `npm run build` and `npm run test:e2e` under `xvfb`-equivalent (macOS needs no display server, but the runner must not be headless-blocked) |
| Package | `macos-26`, release only | `npm run package:mac`, then Gatekeeper verification — see the credential wall below |

`tests/e2e/**` and `playwright.config.ts` are **not** in the `include` of either
`tsconfig.node.json` or `tsconfig.web.json`, so `npm run typecheck` does not check
them. They do typecheck cleanly under the same compiler options when checked
directly; adding `"tests/e2e/**/*.ts"` and `"playwright.config.ts"` to
`tsconfig.node.json` would close the gap. That file is not owned by this change.

---

## What genuinely cannot be tested here

Being specific, because "needs manual QA" is how a gap becomes permanent.

### Needs a signed build with a stable code identity

- **Keychain persistence** (`src/main/auth/keychain.ts`). macOS binds a Keychain
  item to the code identity that created it. An unsigned or ad-hoc-signed build
  has a different identity every time it is rebuilt, so macOS raises a modal
  password prompt that no automation can answer. The host repo already recorded
  this for the Swift apps in `docs/native/TESTING.md`; it applies identically
  here. Any test of sign-in, token storage or an authenticated screen must run
  against a build signed with a Developer ID, or it is testing the failure path.
- **`electron-updater`.** Requires a signed, notarized build and a real update
  feed. An unsigned build fails the signature check on the downloaded artifact,
  so the only thing an unsigned test proves is that the check works.

### Needs owner credentials

- **Notarization and Gatekeeper.** `@electron/notarize` needs an Apple Developer
  ID certificate in the login keychain plus notarytool credentials (Apple ID,
  app-specific password, team ID). None can be provisioned by an agent, and none
  should be.
- **A real Juno account.** The PKCE sign-in flow against `chat.liams.dev`
  (`src/main/auth/pkce.ts`, `transport.ts`) can be tested up to the point where
  the browser is opened; completing it needs a real interactive session and a
  real account. The PKCE code-verifier/challenge derivation itself is a pure
  function and *is* unit-testable — test that, and do not claim the flow works
  because the derivation does.
- **A real provider API key.** Anything that makes the agent host actually talk
  to Anthropic or OpenAI. Everything up to the wire is testable with a fake
  sidecar; the round trip is not.

### Needs a macOS TCC grant that cannot be given headlessly

TCC prompts are drawn by the system, outside the app's process, and cannot be
answered programmatically. Each of these is a genuine hole, not a formality:

- **Screen Recording** — `screencapture` returns an all-black image without it,
  so no visual regression, no screenshot diffing, no "does the Liquid Glass
  material actually render" check. Playwright's own `screenshot: 'only-on-failure'`
  captures through Chromium and is unaffected; the *window* and its native chrome
  are not capturable.
- **Accessibility** — required to drive or read the native menu bar, the traffic
  lights, and any AppKit panel. The host repo's macOS UI tests fail to load their
  bundle without it.
- **Microphone** — voice input. The permission handler in `hardenSession` denies
  every request by design, so the *denial* path is testable; the granted path is
  not.
- **Native file panels** — `workspace:choose` opens `dialog.showOpenDialog`,
  which is a system panel in a separate process. Playwright cannot see it. The
  channel's schema and the trust logic behind it are unit-tested; the picker
  itself is manual QA.
- **Full Disk Access / Files and Folders** — reading a workspace under
  `~/Documents` or `~/Desktop` prompts on first access.

### Not currently possible in this checkout

`node_modules/electron` has no `dist/` and no `path.txt`: the Electron binary was
never downloaded, because the npm allow-scripts policy blocked the package's
install script. `_electron.launch` needs that binary. Until it is present
(`npm approve-scripts electron`, or run `node node_modules/electron/install.js`),
the E2E suite cannot launch even after `npm run build` succeeds — it will skip on
the missing build first, and fail on the missing binary second.

---

## Recorded findings

Kept here rather than in a commit message, per the repository's failure-recording
policy.

### The `assertExactly` drift gate spent its first week passing vacuously

`src/shared/agent-protocol.ts` asserts at compile time that its schemas match
`runner/agent-core`. When this suite was first written, that import resolved to
`any` (TS7016, from a `rootDir`/`paths` mismatch), so all eight assertions were
trivially satisfied. It has since been fixed upstream. The variant list in
`agent-protocol.test.ts` is duplicated as runtime data specifically because of
this: a compile-time gate that can be silently disabled needs a runtime twin.

### `Exactly<>` does not distinguish `?: T` from `?: T | undefined`

`z.infer<typeof AgentEventSchema>` produces `agentId?: string | undefined`;
agent-core declares `agentId?: string`. Under `exactOptionalPropertyTypes` those
are different types — assigning the first to the second is a compile error — but
`assertExactly<Exactly<…>>` reports them as identical, because the
invariant-identity trick it uses compares against the identity relation, which
ignores the exact-optional distinction. So the drift gate does **not** enforce the
`{agentId: undefined}`-vs-absent distinction that `tsconfig.base.json` cites as
its reason for turning `exactOptionalPropertyTypes` on. The runtime assertions in
`agent-protocol.test.ts` (`agentId presence, which is what distinguishes the root
agent from a subagent`) are what actually pin that behaviour, and they record
what Zod does: an explicitly-`undefined` key is accepted and keeps its key, an
absent key stays absent, `null` is rejected, and a JSON hop erases the difference
entirely.

### `isInternalUrl` rejected the app's own origin

Observed on 2026-08-12, fixed upstream while this suite was being written. The
function compared `url.origin === 'juno://app'`, but `juno` is a non-special
scheme under the WHATWG URL standard, so Node's `URL` gives it an **opaque**
origin — `new URL('juno://app').origin` is the string `"null"`. Electron's
`registerSchemesAsPrivileged({ standard: true })` makes the scheme standard
inside Chromium, but `security.ts` imports `URL` from `node:url`, which knows
nothing about that registration. Every `juno://app/...` navigation would have
been blocked by `will-navigate`. Five tests failed on it; the fix was to compare
`url.host === APP_HOST`, which also rejects `juno://app@evil.example` and
`juno://app.evil.example`. Both cases remain asserted.

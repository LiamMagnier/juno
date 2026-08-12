# `tests/`

Strategy, CI expectations and the honest list of what cannot be covered live in
[`docs/TESTING.md`](../docs/TESTING.md). This file is the map.

```
tests/
  unit/         Vitest, `unit` project, node environment, 5 s timeout
  integration/  Vitest, `integration` project, node environment, 30 s timeout
  e2e/          Playwright, real Electron process
```

## Where does my test go?

| If it… | It goes in |
|---|---|
| calls a function and checks the return value | `unit` |
| opens a file, a socket, a database, or spawns a process | `integration` |
| needs a window, `app.whenReady()`, or the preload bridge | `e2e` |

A unit test that needs more than five seconds is an integration test that has not
been moved yet — the timeout is set where it is on purpose.

## Commands

```bash
npm test                  # unit + integration; this is the gate
npm run test:unit
npm run test:integration  # exits 1 until this directory has a file — see docs/TESTING.md
npm run test:watch
npm run test:e2e          # skips, loudly, unless `npm run build` has run
```

`npm install` needs `--legacy-peer-deps` in this workspace right now
(`vite@7` vs `@vitejs/plugin-react`'s `vite@^8` peer).

## House style

Taken from the repository root's `tests/`, which runs `node:test`:

- **Test names are sentences that state the property.** `openExternal > refuses a
  non-https URL (javascript) and never reaches the shell`, not `it('works')`.
  Read the name; know what broke.
- **`describe` groups, it does not narrate.** One level, named after the unit
  under test.
- **Assert exactly.** `toEqual` over `toMatchObject`, exact strings over
  `toContain`, unless the looseness is the point and is commented as such.
- **Comment the *why*, not the *what*.** A reader can see that a URL is rejected;
  what they cannot see is that it is the userinfo-confusion bypass.
- **Test the rejection.** For anything that validates untrusted input, the
  negative cases are the test. A validator that accepts everything passes every
  positive case ever written.

## Fixtures and mocks

There are no shared fixture files. Samples are declared next to the tests that use
them, typed against the *source of truth* (`@juno/agent-core`, not `z.infer` of
the schema under test) so that a contract change upstream is a compile error here.

Two modules are mocked in the whole suite, both for a stated reason:

- `electron`, in `unit/security.test.ts`, because `src/main/security.ts` imports
  it at module scope and because proving a URL was *refused* means proving
  `shell.openExternal` was never called.
- `node:child_process`, in `unit/agent-host.test.ts`, for one call: the agent
  host's shutdown path runs `execFileSync('/bin/ps', …)` to reap detached
  children. A unit test may not spawn a process, and an empty `ps` table makes
  "reaped nothing" a fact rather than a property of the machine. The rest of the
  module is passed through.

`unit/agent-host.test.ts` also reaches module-private state — `SessionManager`'s
`sessions` map, `awaitApproval`, `emitEvent` — because `private` is erased at
runtime. Standing up a real `AgentSession` to provoke an approval would need a
provider, a home directory and a model turn; that is an integration test, and
the approval-idempotency property would be the least reliable thing in it.

## Adding a channel, an event, or a schema

Three files will fail until you update them, by design:

1. `unit/ipc-contract.test.ts` — every channel needs a valid and an invalid
   sample. The table is a total `Record<InvokeChannel, …>`, so omitting one is a
   compile error, and a runtime totality test catches it even if the compile-time
   gate is disabled.
2. `unit/agent-protocol.test.ts` — every `AgentEvent` variant needs a sample, and
   its name must be added to `DECLARED_EVENT_TYPES`.
3. `src/shared/agent-protocol.ts` — the `assertExactly` block. Note that it does
   not catch every kind of drift; `docs/TESTING.md` records which.

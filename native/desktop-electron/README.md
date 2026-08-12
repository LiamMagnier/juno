# Juno Desktop

A macOS AI workspace — **Chat · Work · Code** — built on Electron and React,
sharing an account, a design system and an agent runtime with the Juno web app.

> **Status: early, but real.** The app builds, launches, and its privileged
> paths are exercised by tests rather than asserted: the workspace trust gate is
> enforced in main, a trusted workspace really spawns a shell and runs a command,
> and the agent host forks as a `utilityProcess` and speaks its protocol.
>
> What is *not* there is equally clear-cut — Chat and Work have complete UIs and
> contracts but their backing services are still landing, Computer Use and MCP
> do not exist, and nothing has been signed or notarized. Read
> [docs/STATUS.md](docs/STATUS.md) before assuming a capability works: it
> separates what has been exercised from what merely compiles, and lists every
> blocker that needs a human or a credential.

---

## Quick start

```bash
npm install
```

```bash
npm run dev
```

The app builds and launches today. Signed out it renders a real sign-in surface;
sign-in itself needs a live Juno backend.

### Gates

```bash
npm run gates
```

Runs typecheck → lint → token drift → agent-contract drift → tests. This is
exactly what CI runs (`.github/workflows/desktop.yml`), so the two cannot
diverge.

```bash
npm run test:e2e
```

Drives the built app over the real IPC bridge — the trust gate, a real PTY round
trip, and the agent host. Requires `npm run build` first.

---

## Layout

```text
src/
  main/        Electron main. Windows, menu, protocol, deep links, auth,
               storage, sync, PTY. All network I/O lives here.
  preload/     The capability bridge. Two functions, no Node. 2.7 kB built.
  renderer/    React 19. Presentation only — cannot reach Node or the network.
  agent-host/  utilityProcess embedding @juno/agent-core.
  providers/   ACP client + capability negotiation.
  shared/      Contracts both sides derive from.
docs/          Architecture, research, security, ADRs, status.
```

---

## Three things worth knowing before you change anything

**1. The renderer is fenced off three separate ways.**
`contextIsolation`/`sandbox` at runtime; no `@types/node` in
`tsconfig.web.json`, so importing `node:fs` is a *compile* error; and CSP
`connect-src 'self'`, so it cannot make a network request at all. That last one
is not only security — the Juno backend has no CORS and rejects mismatched
`Origin`, so main is the only place a request can succeed anyway.

**2. The agent runtime is not written here.**
`runner/agent-core` already implements sessions, tools, permissions, subagents
with git-worktree isolation and checkpoints, and its event union is the
vocabulary the cloud runner and the Swift clients already speak. This app embeds
it ([ADR-0002](docs/adr/0002-agent-host.md)). Add shared agent capability
*there*, not here, so the cloud runner gets it too.

**3. Contracts fail the build when they drift.**
`src/shared/agent-protocol.ts` asserts at compile time that its Zod validators
are exactly the agent-core types. Design tokens are generated from the web app's
`globals.css` and `npm run tokens:check` fails if the committed output is stale.
Neither is decorative — the protocol gate was verified by injecting a deliberate
drift and watching the compiler reject it. Note the one documented blind spot in
that gate, recorded in the file itself.

---

## Dependency choices that look wrong and are not

| Choice | Why |
|---|---|
| Vite **7**, not 8 | electron-vite 5's stable peer range excludes Vite 8. |
| Tailwind **3.4**, not 4 | The web app's `tailwind.config.ts` *is* the design authority. v4's CSS-first model would fork it. |
| framer-motion **12**, not 13 | Same: the web app's motion vocabulary is written against 12. |
| TypeScript **5.9**, not 7 | The host repo is on the 5.x line. |
| `node:sqlite`, not better-sqlite3 | Ships with the Node that Electron bundles. Removes the only native module from persistence, and `@electron/rebuild` with it. |
| electron-builder **26.15.7** | npm's `latest` tag is stale at 26.15.3. |
| No `keytar` | Archived since 2022. `safeStorage` instead, failing closed. |

Full reasoning in [docs/RESEARCH.md](docs/RESEARCH.md) and the ADRs.

---

## This is a self-contained sub-workspace

It has its own `package.json` and lockfile and is **not** part of a root npm
workspace — matching how `runner/agent-core` and `relay/` are already handled in
this repository ([ADR-0001](docs/adr/0001-isolated-workspace.md)). Two
`npm install`s, deliberately.

It reads two things from the repo: `runner/agent-core` (as a `file:`
dependency) and the web design system (as token generator input).

---

## Documentation

| | |
|---|---|
| [STATUS.md](docs/STATUS.md) | **Start here.** What works, what doesn't, what's blocked. |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Process model, IPC boundary, data flow. |
| [RESEARCH.md](docs/RESEARCH.md) | What was studied and what was decided, with sources. |
| [SECURITY.md](docs/SECURITY.md) · [THREAT_MODEL.md](docs/THREAT_MODEL.md) | Boundaries and the attacks they exist for. |
| [PROVIDERS.md](docs/PROVIDERS.md) | The ACP-first provider layer, and its licensing constraints. |
| [AGENTS.md](docs/AGENTS.md) | The agent host boundary, the shared event vocabulary, permission modes, subagents — and what does not exist yet. |
| [COMPUTER_USE.md](docs/COMPUTER_USE.md) | Not implemented. The constraints that must hold if it ever is, including why it is not defended by the rest of the architecture. |
| [RELEASE.md](docs/RELEASE.md) | CI, entitlements, signing, notarization, and what only a human at a Mac can verify. |
| [DESIGN.md](docs/DESIGN.md) | Tokens, typography, glass policy, motion. |
| [SYNC.md](docs/SYNC.md) | The real `/api/v1` protocol as implemented. |
| [TESTING.md](docs/TESTING.md) | Layers, and what needs a human at a Mac. |
| [adr/](docs/adr/) | Consequential decisions and their alternatives. |

---

## Licence

Part of the Juno repository — see the root [LICENSE](../../LICENSE). No
third-party source is vendored here; architectural influences are credited in
[RESEARCH.md](docs/RESEARCH.md).

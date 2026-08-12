# Juno Desktop — Status

Last updated: **2026-08-13**

This file records what actually exists in this workspace. A capability is listed
as **Built** only if the code exists *and* has been exercised. "Compiles" is not
"works", and this file is written on that assumption.

---

## Honest summary

Phases 0 and 1 are **complete and verified**. Phases 2–4 (sync engine, Chat,
Work) are **built and type-clean but unexercised against a live account** —
every one of them needs a signed-in session, which needs a live backend. Phase 5
(local Code foundation) is partly there: workspace, trust, terminal and the
agent host all work; a completed agent turn needs a configured provider.
Phases 6–12 are not started.

The distinction that matters throughout this file: **"built" means the code
exists and type-checks; "verified" means it was run and observed.** Roughly a
third of the brief is built; rather less than that is verified. The brief
describes six to twelve months of work for a team, and nothing here pretends
otherwise.

Concretely: 210 files, ~62,000 lines of TypeScript, 65 IPC channels, **zero**
handlers left stubbed, 687 unit/integration tests and 12 end-to-end tests
passing, `npm run gates` green.

---

## Verified

Things exercised, not merely written.

| Item | Evidence |
|---|---|
| Workspace installs cleanly | `npm install` succeeds. node-pty's arm64 prebuild is used as-is — no `@electron/rebuild` step, verified by inspecting `build/Release/pty.node` after removing the `postinstall`. |
| `@juno/agent-core` builds and links | 12 `.d.ts` + 12 `.js` emitted; linked as a `file:` dependency. |
| **Typecheck clean** | `tsc --build` over both project graphs: **0 errors**. Covers main, preload, agent-host, providers, shared, renderer, tests. |
| **Lint clean** | `eslint .`: **0 errors**, 3 warnings (unused bindings in surfaces still being built out). |
| **Unit + integration tests pass** | **687 tests, 7 files, all passing** — protocol validators, security helpers, the full 65-channel IPC contract, and the agent host. |
| **The app builds** | `electron-vite build`: main 447 kB, agent-host 35 kB, preload **2.7 kB**, renderer 460+ modules. |
| **The app launches** | Playwright `_electron`: **12/12 E2E passing**, including *"the renderer is served from the app scheme, not from file://"* and *"the renderer has no access to Node"* — the security boundary verified at runtime, not only at compile time. |
| **It renders correctly in both themes** | Screenshotted at 1440×920 in dark and light. True-black dark with the lightness ladder, warm paper light, coral as emphasis only, Newsreader serif heading, JetBrains Mono status bar. |
| **Navigation works** | Clicking `Code` switches product: the status bar changes to `No workspace · Code mode`, and the `Chat \| Work` segmented control correctly disappears — it belongs to Chat. |
| **The command palette works** | ⌘K opens it. Grouped `GO TO` / `VIEW` / `WORKSPACE` sections, mono shortcut chips, a coral selection rail, an `esc` affordance, and `Current` annotated on the active appearance. Glass here, because it is transient chrome; the surfaces behind it stay opaque. |
| **The signed-out gate holds across products** | Chat and Code both render the sign-in surface rather than an empty shell or a fabricated workspace. |
| **The IPC surface is merged and live** | 52 invoke + 13 event channels in one contract, every one with a handler. Driven over the real bridge from the renderer against the running app. |
| **The workspace trust gate is enforced in main** | With the workspace untrusted, `terminal:create` was refused (*"Trust this workspace before opening a terminal in it."*) and `code:start-session` was refused (*"fixture is not trusted yet."*). Not a UI affordance — main refuses. |
| **A real PTY runs real commands** | After `workspace:set-trust`, `terminal:create` returned `term_<uuid>`, `terminal:write` sent `echo JUNO_PTY_OK_$((6*7))`, and `terminal:output` carried back **`JUNO_PTY_OK_42`** — a real login shell doing real arithmetic. `terminal:list` and `terminal:kill` then behaved. |
| **Typography is real** | The four variable fonts are bundled and load with **no console errors** — the 404s are gone. `fontTools` confirms the axes: Archivo `wght` 100–900, JetBrains Mono `wght` 100–800, and **both Newsreader faces carry `opsz` 6–72**, without which `font-optical-sizing: auto` is a silent no-op. Measured in the running app: Archivo and Newsreader change width between weight 200 and 800. (Mono does not, correctly — monospace advance width is fixed; the `fvar` table is the proof there.) |
| **Account-scoped services follow the account** | `AccountSession` opens the per-account encrypted database and starts the sync client on `signed-in`, and stops both on sign-out, device revocation or account switch. Transitions are serialised so a fast sign-out/sign-in cannot open two sessions on one database file. Diagnostics now reports the real sync phase, cursor and outbox depth. |
| **The agent host forks and speaks its protocol** | `code:start-session` on a trusted workspace drove the supervisor to fork the `utilityProcess`; `code:host-status` reported `starting` → `running`, and the host replied with a `command_error` — *"No provider has a configured API key"* — surfaced verbatim. The honest failure for an unconfigured provider, not a fabricated session. |
| Preload really is dependency-free | **2.7 kB** built, holding 65 channel names and nothing else. This is the payoff from splitting the names into `src/shared/channels.ts` so the sandboxed preload never pulls in Zod — the schemas alone are far larger. |
| **`npm run gates` passes end to end** | typecheck → lint (0 errors) → token drift → agent-contract drift → 687 tests. This is the CI entry point, and it now actually runs: `scripts/check-agent-contract.ts` was referenced by the gate but had never been written. |
| **The agent-contract gate catches what the compiler cannot** | The sidecar command protocol has no exported type — it exists only as a comment on `startSidecarServer`. The gate compares that comment against `SidecarCommandSchema` (9 commands), and refuses a build where agent-core is unbuilt or its declarations are stale, because the compile-time assertions pass **vacuously** against `any`. Verified by deleting a command and watching it fail. |
| **The wiring is a regression test, not a one-off** | `tests/e2e/wiring.spec.ts` drives the real bridge: the trust gate, a real PTY round trip, the agent host reaching `running`, and diagnostics reporting `backendReachable: false` rather than guessing. |
| Contract-drift assertion genuinely works | Injected a deliberate drift (`turnIndex: z.number()` → `z.string()`); compiler rejected it; restored file compiles clean. |

### Bugs found and fixed during verification

Listed because "we wrote tests" is worth much less than "the tests caught something".

1. **`isInternalUrl` would have blocked every navigation in the app.** It compared `url.origin`, but `juno:` is not a *special* scheme to the WHATWG parser, which returns the string `"null"` as the origin for it. `registerSchemesAsPrivileged` fixes this inside Chromium's parser but not Node's, which is what runs in main. Found by the unit tests; now compares `protocol` + `host`. The protocol handler had the **identical** bug, found independently.
2. **A backtick inside `String.raw` silently truncated the markdown inline pattern.** A backtick cannot be escaped in a raw template, so it terminated the literal and corrupted every alternative after it.
3. **A stray renderer build landed in `src/renderer/out/`** and put 1,127 lint errors in one bundled asset, drowning every real finding. Removed, and the ignore is now unanchored so it cannot recur.
4. **An invisible literal U+00A0** in the screen-reader announcer — the technique was right, but an invisible character in source will not survive a future edit.
5. **Main and the renderer disagreed about the title bar height.** Main positioned the native traffic lights for a 52px bar; the renderer draws 44px, so the buttons sat 4px below centre. Both now import `src/shared/chrome.ts`, where the vertical offset is *derived* from the bar height rather than written down twice. This is the archetypal two-process constant: no test catches it and every user sees it.

> **Needs a human to confirm:** traffic-light alignment cannot be verified from
> here. They are native chrome, so a Playwright page screenshot does not contain
> them, and an OS-level screenshot needs a Screen Recording TCC grant. The
> arithmetic is now derived rather than duplicated, but someone should look at
> the real window.

### Warnings deliberately left visible (not silenced)

Three, all unused bindings in surfaces still being built out. The larger sets
that were here earlier are gone: the `react-hooks/exhaustive-deps` findings were
resolved at the source when the streaming surfaces moved to
`useSyncExternalStore` with a version counter, which is the correct expression
of that pattern rather than a suppression.

Still deferred, deliberately: **eslint-plugin-react-hooks v7's compiler-derived
rules** (`set-state-in-effect`, `purity`, …) report ~1,190 findings. Most are
real observations worth acting on, but adopting them is a refactor, not a lint
fix. Enable them one rule at a time.

---

## Built

| Area | State | Notes |
|---|---|---|
| Hardened Electron config | Built | One frozen `SECURE_WEB_PREFERENCES`; permission/device/bluetooth handlers deny by default; both sync *and* async permission handlers set; certificate errors fail closed |
| CSP | Built | `default-src 'none'`, `script-src 'self'`, `connect-src 'self'`. `style-src` allows inline — documented residual risk (React/Framer set element styles) |
| Navigation + window-open policy | Built | `will-navigate` and `setWindowOpenHandler` both covered; external links go to the OS browser through an https-only host allowlist |
| Typed IPC contract | Built | One channel table; Zod on both directions; **sender identity + frame-URL validated** |
| Preload bridge | Built | Two functions, no `ipcRenderer`, no Node; channel names in a dependency-free module so the sandboxed bundle excludes Zod |
| Agent protocol validators | Built + verified | Zod mirrors of agent-core's `AgentEvent`, with compile-time exactness assertions |
| Renderer type isolation | Built | `tsconfig.web.json` omits `@types/node` — importing `node:*` in the renderer is a compile error |
| Design token pipeline | Built | Generated from the web `globals.css` via the repository's existing generator; `tokens:check` gates drift |

---

## Partial

| Area | State | What is missing |
|---|---|---|
| Main-process platform layer | Partial | Window/menu/deep-links/appearance/updater/logger written; not yet exercised end to end |
| Agent host | **Partial (process verified)** | Supervisor forks the `utilityProcess`, negotiates `ready`, routes events, and shuts down. A full agent turn still needs a configured provider. |
| Storage + sync | Partial | Schema, migrations, outbox and reducer written; **no live sync run against the backend** |
| Auth | Partial | PKCE, Keychain, session machine, transport written; **no live sign-in performed** |
| Provider layer (ACP) | Partial | Client, schema, adapter, discovery written; **not yet driven against a real agent CLI** |
| Terminal | **Built + verified** | PTY manager wired to the IPC contract and the workspace trust gate. A real login shell spawned and executed a command end to end. |
| Renderer shell | Partial | Title bar, product switch, sidebar, panes, command palette |
| Chat | **Built, unexercised against a live account** | `src/main/chat/` backs all 14 channels: conversation CRUD, streaming over the anonymous-`data:` SSE dialect, one in-flight turn per conversation, abort, attachments through a native picker. Needs a signed-in account to exercise. |
| Work | **Built, unexercised against a live account** | `src/main/work/` backs all 14 channels over 10 real `/api/work` routes, with a poller whose scheduling is pure and unit-tested. |
| Code surface | Partial | Reaches the agent host. A completed turn needs a configured provider. |
| Packaging | Partial | electron-builder config, entitlements, notarize hook written; **never run** |

---

## Not started

Diff review wired to real git · editor + file tree · worktree UI · agent teams ·
previews · MCP · skills · hooks · Computer Use · remote control / web-surface
parity · visual regression suite · CI workflow · performance budgets.

---

## Blocked — owner action required

These cannot be closed by engineering. Each has everything that *doesn't* need
the blocker completed around it.

1. **Provider licensing.** Anthropic's terms state third parties may not offer
   claude.ai login or rate limits without prior approval, and may not use the
   name "Claude Code" (permitted: "Claude Agent"). This applies through the ACP
   adapter. OpenAI's position on ChatGPT-OAuth in third-party apps is
   unresolved. → **No provider is enabled by default; each is disabled by
   configuration until this is decided.** See [ADR-0004](adr/0004-provider-layer.md).
2. **Signing and notarization.** Needs the five Apple secrets the repo already
   documents. Blocked until they exist: signing, notarization, stapling, `spctl`
   assessment, Gatekeeper-on-DMG, publication, and **any auto-update test**
   (both updaters refuse unsigned macOS apps).
3. **macOS TCC grants.** No credential can unblock these — only a human at a
   Mac: screen capture returning real pixels, accessibility input synthesis,
   microphone, permission-denial paths, and macOS 26's monthly
   re-authorization prompt.
4. **Update feed URL** and release-channel strategy.
5. ~~**Fonts.**~~ **Done.** The four variable woff2 files are bundled at
   `src/renderer/public/fonts/` under SIL OFL 1.1, with a `NOTICE.md` recording
   the licence, the axes, and why the `opsz` axis must be re-verified if they
   are ever re-fetched.

---

## Hazards found in the wider repository

Found while auditing. Not introduced by this workspace, and **not fixed here** —
reported so they are not lost.

### Staged in the working tree, would break production if committed

1. **`prisma/schema.prisma` has a Postgres → SQLite conversion staged**
   (`provider = "sqlite"`, `directUrl` removed, 56 `@db.Text` stripped, ~29
   `Json` columns retyped). The account change feed is implemented as **PL/pgSQL
   triggers** (`prisma/migrations/20260716200000_account_change_log/`), so on
   SQLite there is no trigger, no `BIGSERIAL` cursor and **no sync at all**.
2. **`src/lib/rate-limit.ts` is staged with its body replaced by
   `return { success: true, … }`** — rate limiting disabled globally.

Both are *staged*, i.e. in the index ready to commit. They look like local
development state. They need a decision before the next commit.

### Pre-existing, in committed code

3. **`.mcp.json` is repository-controlled and MCP server spawn bypasses
   `PermissionCoordinator` entirely** — in every mode including `readOnly` —
   with the full app environment inherited (`MCPStdioTransport.swift:50-54`).
   Cloning a hostile repository and starting one turn is arbitrary code
   execution. The hooks subsystem already solves this and MCP does not use it.
4. **Work folder grants live in a global `UserDefaults` key and are never
   wiped** (`DesktopWorkGrants.swift:50`) — account A's grant is inherited by
   account B.
5. **Code Remote approvals are not digest-bound** and its commands have no TTL,
   so a stale queued approval applies whenever the Mac reconnects. The Work
   plane does this correctly and is the model to copy.

The desktop workspace reproduces none of these.

### A performance observation about the web app

Not a defect today, but it will become one.
`src/components/chat/message-list.tsx` **does not virtualize** — it renders
`messages.map(...)` in full, and `MessageItem` is not memoized. It currently
survives because `MarkdownBlock`'s own memo absorbs the re-render cost. That is
a load-bearing accident: any change that makes `MarkdownBlock` cheaper, or that
adds an unmemoized sibling, turns a long conversation into a visible stall.

The desktop transcript is therefore built differently rather than ported. The
live turn is kept *out* of the settled message list entirely; subscriptions are
keyed per message id; deltas coalesce on `requestAnimationFrame`; and markdown
is segmented at blank lines outside fences so only the trailing paragraph
re-parses. Measured: **500 deltas produce 0 notifications before the frame and
exactly 1 after, with the message index untouched.**

---

## Every channel is now backed by a real service

The 28 `notImplemented` handlers are gone. All 52 invoke channels route to a
service; the only remaining reference to `notImplemented` is the function
definition itself.

Chat and Work are **account-scoped**: they are constructed when a session
becomes `signed-in` and disposed when it stops being one. A service holding a
stale token source across a sign-out is how a signed-out app keeps polling, and
teardown order matters — Chat and Work stop *before* the sync client and the
database, so no in-flight request can be issued against a token source that is
about to disappear.

### What the Work service found in the backend, and refused to fake

Three gaps, each handled by refusing rather than inventing:

- **There is no JSON events endpoint.** `GET /api/work/sessions/[id]` returns
  session, run and approvals but **no transcript** — the event log is SSE-only.
  What rescued this: the SSE route's *first frame is always a complete
  snapshot*, so a poll opens the stream, reads one frame, and hangs up. Real
  deltas, real cursor, no long-lived socket.
- **There is no audit-trail read route.** `recordWorkAudit` writes 20 kinds of
  row; nothing reads one back. `auditTrail()` therefore **throws an honest
  sentence** rather than returning `{entries: []}` — an empty *security* log is
  a claim somebody would act on.
- **No route accepts a local path as a folder grant.** `createTask` refuses when
  grant tokens are present rather than silently creating a task missing the
  folder it was told to use.

## The integration seam, now closed

The product surfaces were built in parallel against the shared IPC contract, and
each needed channels that did not exist in it yet. Rather than have several
agents edit `src/shared/ipc.ts` concurrently — a merge conflict in the single
most safety-critical file in the app — each wrote its table locally in the
shared file's own `{request, response}` idiom.

Those tables have now been **moved into `src/shared/contracts/`** and spread into
`INVOKE_CHANNELS` / `EVENT_CHANNELS`. They had to move rather than be imported
in place, because `src/shared` cannot import upward from `products/` or `main/`
without inverting the layering. One-line re-export shims remain at the original
paths so each surface still imports its contract from beside it.

The surface went from 18 → **52 invoke channels** and 5 → **13 event channels**,
and every one has a handler. The exhaustiveness constraints did exactly their
job during the merge: `satisfies Record<InvokeChannel, …>` caught the name/schema
mismatches, and `InvokeHandlers` refused to compile until all 34 new channels
were handled.

Three details preserved through the merge:

- `work:answer` and `work:resolve-approval` return
  `z.discriminatedUnion('ok', …)` carrying **named refusals**
  (`digest_mismatch`, `policy_changed`, `expired`, `already_decided`,
  `not_standing_allowable`). A refused approval says *which* invariant refused it.
- `work:choose-grant` returns an **opaque token**, never a path.
- **`origin` is absent from every renderer-facing terminal schema.** A renderer
  able to claim `'agent'` would launder its own writes past the activity log;
  able to claim `'user'`, it would launder agent commands past a permission
  gate. Main supplies it.

## Next

1. ~~Composition root; the app launches and renders.~~ **Done.**
2. ~~Merge the three product channel tables and wire every handler.~~ **Done** —
   52 invoke + 13 event channels, exercised over the real bridge.
3. ~~Start the agent host and wire `code:*` to it.~~ **Done** — process verified;
   a full turn still needs a provider.
4. Configure a provider so a real agent turn can run end to end. The ACP layer
   and Juno's own backend-proxied provider both exist; neither is enabled by
   default, pending the licensing decision below.
5. Back Chat and Work with real services — the `/api/chat` SSE reader and the
   Work poller. Both surfaces and both contracts are ready for them.
6. Exercise auth end to end against a real account (needs a live backend), then
   the sync loop; prove Scenarios A and B from the brief's §49.
8. CI workflow, then a real packaging run.

# Juno Desktop — Research

Research date: **2026-08-12**. Every claim below was verified against a primary
source on that date — a live registry, a repository, an npm dist-tag, a vendor
doc, or the Juno repository itself. Where something could not be verified, it
says so; a research document whose confidence is uniform is a research document
nobody can act on.

Findings are organised by decision, not by product, because the point of the
exercise was to decide what to build.

---

## 1. The finding that reshaped the architecture

**Juno already contains a complete TypeScript agent core, and the Electron app
can use it directly.**

`runner/agent-core` is a 12,787-line TypeScript package (`@juno/agent-core`)
that already implements what §13–§17 of the brief asks for:

| Capability | Where |
|---|---|
| Provider adapters (Anthropic, OpenAI-compatible, backend proxy) | `src/providers/` |
| Tool registry with read/edit/command classes | `src/tools/registry.ts` |
| Permission engine + deterministic sensitive-command patterns | `src/permissions.ts` |
| Subagents with **git worktree isolation** and result import | `src/subagents.ts` |
| Checkpoints | `src/checkpoints.ts` |
| Session persistence and resume | `src/session.ts` |
| A documented NDJSON-over-WebSocket sidecar protocol | `src/server.ts` |
| Container sandboxing and egress policy | `src/tools/container-sandbox.ts`, `src/tools/egress-policy.ts` |

Its `AgentEvent` union (`src/types.ts`) is already the shared vocabulary between
the cloud runner, the session relay, and the Swift clients — the Swift
`SubagentStatus` enum copies its raw values "character for character" and says
so in a comment (`JunoCodeCore/SessionEvents.swift:270`).

The Swift macOS client could not embed it, because Swift cannot host Node. So
the Swift track **reimplemented the whole thing in Swift** (`JunoCodeCore`,
`JunoCodeLocal`, `JunoCodeRuntime`) and agent-core grew a `bundle:mac` script and
a localhost WebSocket sidecar to bridge the gap.

**Electron is Node.** The desktop app imports the real thing as a library. This
removes an entire duplicate runtime, a localhost port, and a shared-secret
token from the design. It is recorded as [ADR-0002](adr/0002-agent-host.md).

This is also the clearest instance of the brief's §2 instruction — *do not build
parallel implementations when the Juno backend already has the capability*.

---

## 2. Coding agents: the Agent Client Protocol changes the provider story

### What was verified

The **Agent Client Protocol (ACP)** is real, current, and broadly adopted.

- Live registry: `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`
  lists **~38 agents** (verified by fetching the JSON directly).
- First-party ACP modes exist for **Claude, Codex, Kimi, OpenCode, Cursor,
  Gemini CLI, GitHub Copilot**, plus Alibaba, Mistral, Tencent, Snowflake,
  Cognition, Block, xAI.
- Clients: **Zed, JetBrains (official), Visual Studio, VS Code, Neovim, Emacs,
  Qt Creator, Obsidian, Unity**.
- Spec is **Apache-2.0**, `v1.6.0` / `schema-v1.20.0` (2026-07-21). Five official
  SDKs (Rust, TypeScript, Python, Kotlin, Java) under the `agentclientprotocol`
  GitHub org.
- Transport: **JSON-RPC 2.0 over stdio**, newline-delimited UTF-8. Streamable
  HTTP is an explicit draft; WebSocket is WIP.

The Claude and Codex ACP adapters list **Anthropic and OpenAI as named
co-authors**. These are not community reverse-engineering efforts.

### Consequence

One well-built ACP client covers most of the provider matrix. The brief's §13
asks for adapters for Codex, Claude Code, Kimi and OpenCode; ACP collapses those
into **one adapter plus per-vendor capability negotiation**, which is both less
code and less to break when a vendor ships a new version.

Recorded as [ADR-0004](adr/0004-provider-layer.md).

### Caveats that must shape the implementation

- **Governance is not neutral.** ACP is jointly controlled by Zed and JetBrains
  under a two-person BDFL model, "working toward an independent foundation" with
  no published timeline.
- **ACP v2 is drafted and it removes the client-side `fs/*` and `terminal/*`
  APIs entirely** (agents use MCP instead). Implement v1, negotiate at
  `initialize`, and keep fs/terminal handlers behind an interface so v2 does not
  require a rewrite.
- **Kimi's ACP entry is being wound down** in favour of `MoonshotAI/kimi-code`.
  Capability-gate rather than assume continuity.
- **OpenCode moved repositories**: `sst/opencode` → `anomalyco/opencode`
  (verified directly). MIT. It serves a live OpenAPI 3.1 spec at `/doc`, which
  makes it the best reference implementation to test against.

### Per-vendor mechanisms (verified against vendor docs)

| Provider | Structured mechanism | Notes |
|---|---|---|
| **Codex** | `codex app-server` (JSON-RPC 2.0/stdio) powers OpenAI's own VS Code extension; `codex app-server generate-ts` emits version-pinned types | App-server is **explicitly "not supported for production workloads"**. Stable fallback: `codex exec --json` (JSONL, includes token usage). Apache-2.0. Docs moved to `learn.chatgpt.com/docs`. |
| **Claude** | Agent SDK, or `claude -p --output-format stream-json` | Subagent trees arrive via `parent_tool_use_id`; `system/init.capabilities` gives feature detection, which is more robust than version comparison. **Permission trap:** the documented 6-step evaluation order means `allowedTools: ["Read"]` silently bypasses a `canUseTool` UI — gate with a `PreToolUse` hook instead. Docs moved to `code.claude.com`. |
| **OpenCode** | HTTP + SSE **and** `opencode acp`; live OpenAPI at `/doc` | MIT, no usage restrictions. |
| **Cursor** | `agent acp` (first-party, protocolVersion 1) with six Cursor-specific extension RPCs; separately a public-beta Cloud Agents REST API at `api.cursor.com` | In-protocol `cursor_login` auth method. |
| **Kimi** | `kimi acp` | Apache-2.0 per GitHub; the registry says MIT — an unresolved discrepancy. Auth is login-gated with a specific `AUTH_REQUIRED` / `-32000` error code to handle. |

### Two capabilities nobody has

- **Computer Use: none of the six expose it.** It is entirely a host
  responsibility.
- **Worktrees are not a protocol concept anywhere.** Every agent accepts a
  `cwd`. So Juno creates the worktree and points the agent at it — which is
  portable across all six, and is exactly what `agent-core`'s `SubagentManager`
  already does.

### The licensing finding — this one is a product constraint, not a technical one

Anthropic's documentation states, verbatim, that **third-party developers may
not offer claude.ai login or claude.ai rate limits in their products**, including
agents built on the Claude Agent SDK, without prior approval. Branding rules
additionally forbid third parties from using the name "Claude Code" (the
permitted term is "Claude Agent"). The restriction applies through the ACP
adapter too.

There is a real distinction Juno must respect in its UI and its terms:

- **Restricted:** Juno offering "Sign in with Claude" as a Juno feature.
- **Not obviously restricted:** driving the user's own, already-authenticated
  local CLI on the user's own machine, under the user's own account.

OpenAI's equivalent position on ChatGPT-OAuth in third-party apps is
**unresolved** — no explicit approval was found, and an open discussion
(codex#8338) was not read in full. Kimi and Cursor both expose third-party
friendly login; Cursor even has an in-protocol auth method. OpenCode is MIT with
no restriction.

**This needs a product-owner decision before the Claude and Codex providers
ship.** It is tracked in [STATUS.md](STATUS.md) as an open blocker, and it is
the one item in this document that engineering cannot resolve on its own.

---

## 3. Desktop architecture: `pingdotgg/t3code`

### License

**MIT**, "Copyright (c) 2026 T3 Tools Inc.", unmodified. Verified by fetching
the file.

Architectural ideas are not copyrightable, so reimplementing its patterns
independently requires no attribution. Copying any non-trivial file would
require shipping that copyright line and the license text in a
`THIRD_PARTY_NOTICES` file inside the app bundle. Its name, logo and `assets/`
are trademark rather than MIT-covered, and its `.repos/` directory is vendored
third-party code under separate licenses.

**Juno copies no t3code source.** The patterns below were reimplemented.

### Its defining decision

**The Electron main process is not the agent host.** `apps/server` runs as a
separately spawned Node process; the renderer reaches it over authenticated RPC
on a localhost WebSocket, *not* Electron IPC. Electron IPC is reserved for
dialogs, menus, theme, updates and keychain.

That boundary is why the same client runtime drives web, desktop and React
Native, and why remote/SSH backends work with no client change.

**Juno deliberately diverges here.** t3code's transport is a consequence of
targeting several shells; Juno Desktop targets one, and a localhost WebSocket
means an open port and a shared secret that any local process can attempt. Juno
uses Electron IPC to main, and a `utilityProcess` with a `MessagePort` to the
agent host — no port, no token. See [ADR-0002](adr/0002-agent-host.md).

### Patterns adopted

- **Custom privileged scheme** for the renderer (`t3code://app/…`;
  Juno uses `juno://app`) registered `standard + secure + supportFetchAPI +
  corsEnabled`, with CSP injected by main. Adopted.
- **Event-sourced SQLite**: typed command → idempotency receipt → pure decider →
  events + projections **committed in one transaction**. Adopted for the outbox;
  a mutation and its local effect must not be separable by a crash.
- **Readiness by protocol, not stdout scraping** — an HTTP well-known poll
  rather than parsing a log line. Adopted in spirit for the agent host.
- **SIGTERM then force-kill after a grace period.** Adopted.
- **CI asserts the built preload exports the expected symbols.** Cheap, and it
  catches a whole class of bundling regression. Adopted.

### Pattern noted and *not* adopted

t3code's IPC does schema validation in both directions but has **no
`event.senderFrame` validation**. Juno validates the sender — see
`src/main/ipc-router.ts`. A trusted `WebContents` that has been navigated
elsewhere, or a subframe, is not the renderer speaking for us.

---

## 4. Stack decisions

All versions verified against npm on 2026-08-12.

| Choice | Version | Why |
|---|---|---|
| Electron | 43.4.0 | Current. Bundles Node 24.18.1 — which is what makes `node:sqlite` viable. |
| electron-vite | 5.0.0 | Maintained, Electron-aware. |
| Vite | **7.3.6, not 8** | electron-vite 5's stable peer range is `^5 \|\| ^6 \|\| ^7`. Vite 8.2.1 exists but is **out of range**. |
| React | 19.2.8 | Matches the host repo. |
| TypeScript | **5.9.3, not 7** | TS 7.0.2 (the native port) exists, but the host repo is on the 5.x line. An isolated workspace running a different major compiler is a source of confusing disagreement for no gain here. |
| Tailwind | **3.4.19, not 4** | The host repo's `tailwind.config.ts` **is the design authority**. Tailwind 4's CSS-first config is a different model; matching v3.4 lets the desktop consume the same semantic token structure. This is the clearest "documented reason to differ from latest" in the brief's §5. |
| framer-motion | **12.43.0, not 13** | Same reasoning: the web app's motion vocabulary is on 12. |
| Zod | 4.4.3 | Host repo is on Zod 4. |
| Persistence | **`node:sqlite`**, not better-sqlite3 | Ships with Node 24, which every supported Electron bundles. Removes the only native module from the persistence path, and with it `@electron/rebuild` and a class of ABI/arch CI failures. Stability 1.2 (RC) — mitigated by Electron pinning the Node version. t3code ported off better-sqlite3 for the same reason. |
| PTY | node-pty 1.1.0 | N-API with shipped prebuilds → no rebuild step. Needs `asarUnpack` and the executable bit preserved on `spawn-helper`. Last published 2026-08-03. |
| Terminal UI | @xterm/xterm 6.0.0 | Current. |
| Packaging | electron-builder **26.15.7** | npm's `latest` dist-tag is **stale at 26.15.3**; the real current v26 is behind the `v26` tag. |
| Fuses | @electron/fuses 2.1.3 | `RunAsNode: false`, `OnlyLoadAppFromAsar: true`, etc. |
| Notarization | @electron/notarize 3.1.1 | notarytool. `altool` is deprecated. |
| Secrets | Electron `safeStorage` | **`keytar` has been archived since 2022** — do not use it. |
| Unit/integration tests | Vitest 3.2.7 | Vite-native, multi-project. |
| E2E | Playwright 1.62.1 | `_electron.launch`. |

### Traps recorded during research

- The **`RunAsNode: false` fuse** forbids re-invoking the Electron binary as
  plain Node. Juno's agent host uses `utilityProcess`, which is an Electron API
  and should be unaffected — but this must be verified in the packaged build,
  not assumed.
- A **sandboxed preload cannot resolve imports out of an ASAR**, so the preload
  must be a fully self-contained bundle. This is why the IPC channel *names*
  live in `src/shared/channels.ts` with no dependencies, separate from the Zod
  schemas.
- `safeStorage` on Linux silently falls back to a hardcoded plaintext key. Juno
  Desktop is macOS-only, but the check must still fail closed rather than assume.

---

## 5. Backend: what the Juno server actually offers

Audited against **committed HEAD**, deliberately — see the warning in §7.

### Verified

- **Auth is PKCE-S256 through the system browser** (`GET /app-auth` →
  `POST /api/v1/auth/token`). There is **no OAuth device grant** anywhere in the
  repo. A direct password grant also exists.
- The **redirect-URI allowlist is hardcoded to two values**:
  `com.liammagnier.juno://auth/callback` and `juno://auth/callback`. No loopback
  option — so a localhost listener would be rejected, and the `juno://` deep
  link is the correct path.
- Access tokens: **HS256 JWT, 10-minute TTL**. Refresh is a **rotating family
  with reuse detection** and a 60-second replay grace. A concurrent second
  refresh returns **`503 refresh_conflict`**, not 401 — it must be retried with
  credentials kept.
- **`/api/v1/changes/stream` is a wakeup, not a data channel** — confirmed. The
  server polls max-cursor every ~2s, emits `{"cursor":"N"}`, holds ~55s, ends
  with `done`. The brief's §27 assumption is correct.
- Flow: wakeup → `GET /changes` → `GET /entities` (max **100 ids per batch**);
  fresh installs walk `/entities/index`. A cursor below the **30-day compaction
  floor returns 410** and requires re-bootstrap.
- Mutations: `POST /api/v1/mutations`, **16 operations**, `clientMutationId`
  UUID plus a full-body `requestHash`. Conflicts are strict-equality **409**
  carrying `details.currentRevision`, never merged.

### Constraints that shaped the design

1. **There is no CORS, anywhere.** `src/middleware.ts:144` returns **403** for
   any mutating `/api/` request whose `Origin` doesn't match the host. A request
   with **no** `Origin` passes — that is the intended native path. A renderer
   `fetch` from `juno://app` would fail on both counts. **All network traffic
   therefore originates in the main process**, which happily is also what keeps
   bearer tokens out of the renderer. Two requirements, one mechanism.
2. **Three incompatible SSE dialects.** `/api/v1/changes/stream` uses named
   `event:` lines; `/api/chat`, `/api/code/**` and the Work session events use
   anonymous `data:` frames with a `type` field — and three different heartbeat
   conventions. At least two readers are needed. All require the bearer in a
   header, which **rules out `EventSource`**; use `fetch` + `ReadableStream`.
3. **No domain model carries a `revision`**, and `updatedAt` is missing on 46 of
   85 models. Revisions and tombstones live entirely in the `EntityRevision`
   side table, so a watermark sync is impossible and the cursor feed is the only
   correct mechanism.
4. **Only 22 of 85 entity types are in the change feed.** Work, Knowledge,
   Research, Import and the Code *remote session* family are absent and need
   their own polling. This is a genuine parity limit and is capability-gated
   rather than faked.
5. Mutation receipts are keyed by `(account, deviceSession, mutationId)` — the
   same idempotency key from a **different device session executes again**.
   The outbox must not rely on the key alone across a re-authentication.
6. `getCurrentUser()` (`src/lib/session.ts:17`) checks `Authorization` first and
   never falls back to a cookie, so **one bearer unlocks the entire `/api/**`
   surface**. That raises the value of a stored token and is the strongest
   argument for the renderer-never-holds-a-token design.

---

## 6. Security research

Full model in [THREAT_MODEL.md](THREAT_MODEL.md). Two things belong here.

### The Swift implementation is a better security reference than a clean-sheet design

Its controls carry comments explaining *why* they have their shape, often citing
the bug that forced it. Ported rather than reinvented:

- **`WorkspaceAccess` containment** — canonicalize *then* contain, with two
  paths: an existing target is `realpath`'d directly; a new target canonicalizes
  the **deepest existing ancestor** and reattaches validated components. You
  cannot `realpath` a file that does not exist yet, and that non-obvious half is
  where naive implementations leak. It returns the canonical path so callers
  cannot re-open the unvalidated one.
- **`minimalEnvironment`** — build a *fresh* environment dictionary rather than
  filtering an inherited one. In Node this is the difference between `{...}` and
  `{...process.env}`.
- **`PermissionPolicy.ruling`** — a pure function with two rules above the mode
  ladder: read-only *refuses* rather than asks, and `destructive` always asks,
  including under Full Access. The critical/destructive line is drawn at "can
  the effect be bounded to the granted workspace", which is what makes Full
  Access mean something.
- **`PermissionCoordinator`** — approvals genuinely suspend on a continuation,
  bind a **SHA-256 digest over the canonical `{tool, input}`**, re-verify digest
  *and* expiry, and carry an authority-revision counter that closes the
  approve-then-downgrade race.

### Computer Use is not defended by the rest of the architecture

The command classifier, path containment and sandbox profile constrain the
*agent host*. None of them constrain what the user's own applications do when
the agent types into them. Computer Use's only real boundaries are macOS TCC,
session consent, and the kill switch.

The sharpest finding: **if synthesized input can click Juno's own approval
dialogs, the permission model contains a cycle.** Making approval dialogs
unspoofable by synthetic input is a prerequisite for shipping Computer Use, not
a refinement of it.

---

## 7. Three live defects found in the existing codebase

Not part of the brief, but found while auditing, and reported rather than
stepped around.

**In the working tree (staged, not yet committed):**

1. `prisma/schema.prisma` has a **Postgres → SQLite conversion** staged
   (`provider = "sqlite"`, `directUrl` removed, 56 `@db.Text` stripped, ~29
   `Json` columns retyped). The account change feed is implemented as **PL/pgSQL
   triggers**, so on SQLite there is no trigger, no `BIGSERIAL` cursor, **and no
   sync at all**.
2. `src/lib/rate-limit.ts` is staged with its body replaced by
   `return { success: true, … }` — rate limiting disabled globally.

**In committed Swift/server code** (from the threat-model audit):

3. `.mcp.json` is **repository-controlled**, and MCP server spawn bypasses
   `PermissionCoordinator` entirely — in every mode, including `readOnly` — with
   the full app environment inherited (`MCPStdioTransport.swift:50-54`). Cloning
   a hostile repository and starting one turn is arbitrary code execution. The
   hooks subsystem already solves this exact problem and MCP does not use it.
4. Work folder grants live in a global `UserDefaults` key and are never wiped
   (`DesktopWorkGrants.swift:50`) — account A's grant is inherited by account B.
5. Code Remote approvals are **not digest-bound** and its commands have no TTL,
   so a stale queued approval applies whenever the Mac reconnects. The Work
   plane does this correctly and is the model to copy.

Items 3–5 are pre-existing and outside this workspace; they are recorded here so
they are not lost, and the desktop app does not reproduce any of them.

---

## 8. Capabilities deliberately rejected

| Rejected | Why |
|---|---|
| A second agent runtime in the desktop app | `runner/agent-core` exists and is already the shared vocabulary. §2 of the brief. |
| Localhost WebSocket to the agent host | An open port plus a shared secret, when `utilityProcess` + `MessagePort` needs neither. |
| Bespoke adapters per coding provider | ACP covers most of the matrix with one adapter and real capability negotiation. |
| Screen-scraping terminal output from provider CLIs | Structured protocols exist for every provider under consideration. |
| `EventSource` for streaming | Cannot send an `Authorization` header. |
| better-sqlite3 | A native module where a built-in now suffices. |
| keytar | Archived since 2022. |
| Tailwind 4 / framer-motion 13 / TypeScript 7 | Would fork the design and motion vocabulary away from the web app, which is the design authority. |
| Codex `app-server` as the *primary* path | Vendor documents it as "not supported for production workloads". Kept as an opportunistic upgrade behind capability detection; `codex exec --json` is the stable path. |
| Recreating VS Code | The embedded editor exists to inspect and make focused changes during an agent session. §20 of the brief. |

---

## 9. Open questions requiring a product-owner decision

1. **Claude/Codex provider licensing** (§2 above). Cannot be resolved by
   engineering.
2. Whether the staged `prisma`/`rate-limit` changes are intentional local
   development state or were staged by accident.
3. Whether the desktop app should ship a bundled Node runtime for the agent
   host, or rely on `utilityProcess` under the `RunAsNode: false` fuse.
4. The update feed URL and release channel strategy.

---

## Sources

Primary sources consulted, all fetched 2026-08-12:

- `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`
- `https://agentclientprotocol.com/`
- `https://github.com/pingdotgg/t3code` (source + LICENSE)
- `https://github.com/anomalyco/opencode` (moved from `sst/opencode`)
- `https://www.electronjs.org/docs/latest/tutorial/security`
- `https://electron-vite.org/`
- `https://learn.chatgpt.com/docs` (Codex; `developers.openai.com/codex` 308-redirects here)
- `https://code.claude.com/docs/` (Claude; moved from docs.claude.com → platform.claude.com)
- npm registry dist-tags and version metadata for every pinned dependency
- The Juno repository itself: `contracts/openapi/juno-native-v1.yaml`,
  `src/app/api/v1/**`, `src/middleware.ts`, `runner/agent-core/**`,
  `native/Packages/**`, `prisma/**`

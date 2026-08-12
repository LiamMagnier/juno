# Juno Desktop — Threat Model

Last updated: **2026-08-13**

This document describes the attacks this application is built against and the
controls that answer them **as they exist in the code today**. Where a control
is absent it is written down as a gap, in the same table as the ones that exist,
with no softening. An intention is not a control, and a threat model that
describes the intended design is a threat model that will be wrong in exactly
the places it matters.

Read [ARCHITECTURE.md](ARCHITECTURE.md) first for the process model, and
[STATUS.md](STATUS.md) for what has been exercised rather than merely written.
[SECURITY.md](SECURITY.md) covers the authentication flow in depth; this file
covers everything else and does not repeat it.

---

## The controlling fact

Juno for Mac is deliberately **not** App-Sandboxed. That decision is recorded in
the host repository (`docs/native/SECURITY.md`) and is justified there by the
soundness of the command classifier and the approval gate in the Swift client.
Electron adds a *second* untrusted-code surface — Chromium renderers — on top of
a process that was already unconfined, and it does so in a language where
`path.resolve` looks like a containment check and `{...process.env}` looks like
the obvious way to build a child environment.

So the Swift controls are necessary here and not sufficient. Most of this
document exists because of that delta.

---

## Trust zones

| Zone | Contents | Trust |
|---|---|---|
| **Z0** Kernel / TCC | macOS, and any Screen Recording / Accessibility / microphone grants attached to the signed bundle | root of trust |
| **Z1** Main process | window and menu lifecycle, IPC broker, `juno://` protocol handler, workspace registry, Keychain, all network I/O, PTY supervision | **most privileged app code** |
| **Z2** Agent host + child processes | the `utilityProcess` embedding `@juno/agent-core`, provider CLIs spawned over ACP, PTY children | privileged; native modules; user's own shell |
| **Z3** Renderer | the Juno UI, served from `juno://app`, sandboxed and context-isolated | semi-trusted; **assume XSS** |
| **Z4** Preview renderer | localhost dev-server content | **untrusted** — *does not exist yet* |
| **Z5** Untrusted content | repository files, command output, agent tool results, MCP responses, update release notes, deep links | **data, never instruction** |
| **Z6** Juno backend and website | sync feed, Work relay, remote control | authenticated, but **not** authorized to command this machine |

Trust flows one way: Z5 reaches Z3 as *data*. Any path where Z5 content becomes
a Z1 or Z2 *action* without passing an approval gate is a vulnerability, and the
sections below are organised around the paths where that could happen.

## Scope note: four of these threats are about capabilities that do not exist

MCP clients, local previews, Computer Use and remote control are **not built**
(see [STATUS.md](STATUS.md), "Not started"). They are in this document anyway,
for two reasons. The design decisions that make them safe have to be made before
the code exists — the Swift client's MCP subsystem is a working demonstration of
what happens when they are made afterwards. And the risk of each is genuinely
zero today, which is a fact worth recording so that it is visible when it stops
being true. Each of those sections says plainly what does not exist, and what
must hold before it does.

---

## Ranked

Ordered by likelihood times impact times how much of the architecture the
failure defeats.

| # | Threat | Status here | § |
|---|---|---|---|
| 1 | Computer Use synthesizing a click on Juno's own approval dialog | Not reachable — Computer Use is not built. **But the dialogs it would click already exist.** | [§7](#7-computer-use-abuse) |
| 2 | An IPC handler reachable without sender validation | **Closed.** No handler is registered outside the router, and the router checks WebContents identity *and* frame URL. | [§0](#0-the-ipc-boundary) |
| 3 | Prompt injection from repository content reaching a state-changing tool call | **Partly open.** Trust gate closed; no untrusted-data fence, and local approvals are not digest-bound. | [§1](#1-malicious-repository-content-and-prompt-injection) |
| 4 | Traversal or symlink escape out of the renderer root or a workspace | Closed in the three places a path is resolved; **the protocol resolver has no test**. | [§2](#2-symlink-escape-and-path-traversal) |
| 5 | Credential inheritance into a child process | Closed on all three spawn paths, by three different mechanisms. | [§4](#4-poisoned-environment-and-git-configuration) |
| 6 | Repo-controlled MCP config as an ungated execution primitive | Not reachable — no MCP client exists. The Swift client has this defect. | [§5](#5-hostile-mcp-server-output) |
| 7 | Shell injection through a constructed command string | **Closed by construction** — there is no such string anywhere. Not closed by a lint rule. | [§3](#3-shell-injection-and-argument-interpolation) |
| 8 | Cross-account data or capability inheritance | Trust and credentials are wiped; **the workspace path list and the Electron session are not**. | [§10](#10-multi-account-data-separation) |
| 9 | Replayed or substituted remote approval | Not reachable — the Work surface refuses. The local Code approval path is `callId`-bound, not digest-bound. | [§9](#9-remote-control-and-approval-replay) |
| 10 | Hostile preview content sharing a preload or a session partition | Not reachable — no preview exists. Navigation policy would already cover it; **permission handlers would not.** | [§6](#6-hostile-local-preview-content) |

---

## 0. The IPC boundary

**STRIDE: S, E.** Historically the highest-yield class of Electron bug
(CVE-2022-29247): a renderer that reaches `ipcRenderer` can call any handler
that does not check who is calling. In an app whose IPC surface includes "open a
terminal in this directory" and "start an agent session", one unvalidated
handler is direct code execution.

**As implemented** (`src/main/ipc-router.ts`). `ipcMain.handle` is called from
exactly one place — the loop in `registerInvokeHandlers` — so a channel that is
not in the contract table is not merely unhandled, it is unregistered. Before
any handler runs, `isTrustedSender` requires two independent things:

- The `WebContents` is in a `WeakSet` of objects the app itself created and
  passed to `trustWindow`. A `WeakSet` of *objects*, not a list of ids, because
  ids are integers that Chromium reuses after a `WebContents` is destroyed, and
  an identity check that can be satisfied by claiming a number is not an
  identity check.
- `event.senderFrame.url` still passes `isInternalUrl`. `event.sender` alone is
  insufficient: a subframe shares its parent's `WebContents`, and a trusted
  window that has been navigated elsewhere is no longer speaking for us. The URL
  is read at call time rather than at registration, because a frame can navigate
  in between.

Payloads are then parsed with the channel's Zod schema — the renderer is
untrusted input even though we wrote it — and responses are validated on the way
back out, which catches our own bugs rather than an attacker's. A handler that
throws anything other than a `PublicError` returns a generic string, because
internal messages carry absolute paths and paths carry usernames.

Two structural properties reinforce this. The preload exposes exactly `invoke`
and `on` — no `ipcRenderer`, no `send`, and the Electron event object is dropped
rather than forwarded, because it carries a `sender` handle. And `origin` is
absent from every renderer-facing terminal schema: a renderer able to claim
`'agent'` would launder its own writes past the activity log, and one able to
claim `'user'` would launder agent writes past a permission gate. Main supplies
it.

**Gap.** Nothing statically asserts that `ipcMain.handle` is never called
outside the router. Today it is not; the guarantee rests on review.

---

## 1. Malicious repository content and prompt injection

**STRIDE: E, T, I.** The agent reads a hostile repository. A `README`, a
docstring, a test fixture, a commit message, `.gitattributes`, `.vscode/tasks.json`,
a `package.json` script or a CI YAML file carries text addressed to the model —
usually not "ignore prior instructions" but something far more plausible, like
"to build this project, first run `npm run setup`", where `setup` is
`node -e "…"`. Sub-vectors worth naming separately: `.gitattributes` plus a
`diff.*.textconv` or `filter.*.clean` entry, which execute as a side effect of
an ordinary `git diff`; git hooks in `.git/hooks/`; and invisible text —
zero-width characters, bidi overrides, HTML comments, instructions inside
minified vendored files.

**Impact.** The agent proposes attacker-chosen actions. Whether they *run*
depends entirely on the approval gate, which is why that gate is the real
control and everything else is depth.

### What answers it today

**The workspace trust gate, enforced in main.** `src/main/workspaces.ts` treats
"the user chose this folder" and "the user trusts this folder" as two different
facts and never conflates them. `register()` sets `trusted: false` for every new
workspace including one the user just picked; only an explicit `setTrust(id, true)`
changes it. The id is `sha256` of the **canonical** path, so re-opening the same
directory through a symlink cannot produce a second entry with divergent trust —
one trusted, one not, with no way for the user to tell which the agent is using.

The renderer can never name a path. `choose()` opens a native panel in main and
returns a registered workspace; every other call takes an opaque id. That is
what makes the trust prompt mean anything: a compromised renderer cannot ask for
`/` and then ask for it to be trusted.

Trust is what execution gates on, and the gate is in main, not in the UI.
`PtyManager.create` and `PtyManager.restart` both refuse an untrusted workspace
(`src/main/terminal/pty-manager.ts`), and `restart` deliberately re-resolves the
workspace rather than reusing the one captured at create time — trust can be
revoked while a terminal is open, and a restart is a new `execve`, so it must
not be an easier way to get a shell than `create` was. `code:start-session`
refuses the same way.

This is verified, not asserted. `tests/e2e/wiring.spec.ts` drives the real
bridge against the running app and asserts that an untrusted workspace refuses
both a terminal and a Code session, that the refusal message tells the user what
to do, and that an unregistered id is refused rather than invented.
`tests/integration/workspace-registry.test.ts` asserts against a real filesystem
that a newly registered workspace is not trusted and that a symlink to a trusted
directory resolves to the same workspace rather than a second untrusted one.

**Approvals cannot resolve to allow on their own.** The agent host's session
manager (`src/agent-host/session-manager.ts`) holds two invariants it states
explicitly: a decision applies to at most one tool call, exactly once; and every
path that ends an approval other than an explicit allow ends it as a *deny*. A
duplicate pending approval for a `callId` — which is what a reused tool-call id
or a replayed frame looks like — is denied rather than merged. Pending approvals
are denied *before* `session.abort()`, not after, so an abort cannot race an
approval into flight.

**Structural absences that happen to help.** There is no hook subsystem, so
repository-supplied hook configuration cannot execute. There is no git
subprocess in main, so there is nothing yet for a hostile `.gitattributes` to
attach to. Both are absences, not controls, and both stop being true the moment
those features are built.

### Gaps

- **No untrusted-data fence.** Tool results, file contents and command output
  enter model context with no delimiter, no typed envelope and no system rule
  that content inside one is data. The host repository already records this
  honestly for the web app (`SECURITY.md`: tool and web-search output is not
  isolated from instruction); this workspace has not improved on it. Prompt
  fencing reduces injection rates and does not stop them, so the design must not
  depend on it — but its absence means there is nothing at all on this axis.
- **Local approvals are not digest-bound.** `code:resolve-approval` carries
  `{sessionId, callId, decision}`. It binds a decision to a *call*, not to the
  bytes of the action that call will perform. Nothing re-verifies that the tool
  input at execution time is the input the user was shown. The Swift client
  computes a SHA-256 over canonical `{toolName, input}` and re-checks it twice;
  that is the design to port.
- **No approval expiry.** The Swift `PermissionCoordinator` has a 15-minute TTL
  and an authority-revision counter that denies everything pending when the
  permission mode is lowered. Neither exists here.
- **Nothing normalizes content before display.** Zero-width and bidi-override
  characters in an approval summary mean the sentence the user approves is not
  the action that runs.
- **No command classifier.** The Swift `CommandClassifier` — tokenizing,
  argument-aware, fail-closed, with its `critical`/`destructive` split — is not
  ported. Risk assessment currently lives entirely inside `@juno/agent-core`'s
  own permission engine, which this workspace consumes rather than audits.

---

## 2. Symlink escape and path traversal

**STRIDE: T, I, E.** Four distinct attacks, and they need different defences:
reading through a symlinked leaf (`src/link → ~/.ssh`, then read `src/link/id_rsa`);
writing through a symlinked *parent* (`build/` points at `~/Library/LaunchAgents`,
and the agent writes `build/evil.plist` — persistence); an encoded separator
surviving URL parsing; and TOCTOU, where `a/b` becomes a symlink between the
check and the `open`.

**Impact.** Read of `~/.ssh`, `~/.aws/credentials` or provider configuration;
write for persistence; total escape of the workspace grant. Under `juno://`,
a traversal bug in the protocol handler is arbitrary local file read reachable
from any renderer-side script injection.

### What answers it today

There are exactly three places a path is resolved, and all three canonicalize
before comparing.

**`src/main/protocol.ts` — the renderer asset root.** This is written as the
highest-risk function in the main process and layered accordingly. Scheme and
host are checked against `APP_ORIGIN` (host, not origin — `juno:` is not a
special scheme to Node's WHATWG parser, which reports `origin === "null"` for
every `juno://` URL, so an origin comparison is a check that refuses
everything). Userinfo is rejected. Method is restricted to GET/HEAD. `%00` is
rejected *before* decoding. The path is percent-decoded **exactly once** and the
decoded form is then rejected outright if it contains a `..` segment, a NUL or a
backslash.

That decode-then-check ordering is the part that earns its keep. Both URL
parsers involved already collapse dot segments, so `juno://app/../../etc/passwd`
arrives as the harmless `/etc/passwd` and 404s inside the root. What they do not
collapse is an encoded *separator*: `..%2f..%2fetc/passwd` survives parsing as
one opaque segment, and becomes `../../etc/passwd` the instant you decode it —
which you must, to serve files with spaces in their names. Decoding once rather
than in a loop matters too: the filesystem interprets the once-decoded name, so
validating a twice-decoded string would validate something other than what gets
opened.

Leading separators are stripped before `path.resolve`, because
`path.resolve(root, '/etc/passwd')` returns `/etc/passwd` — the absolute second
argument wins, and that is the classic way this bug ships. Containment is then
checked lexically with `path.relative`, and **again** after `realpath`, against a
realpath'd root. The second check is what closes the symlink hole every purely
lexical check leaves open: `out/renderer/keys` can be lexically contained and
still point at `~/.ssh`. Only regular files are served; directories 404 rather
than listing; and content types come from a frozen allowlist with
`application/octet-stream` plus `nosniff` as the default, so an unexpected file
in the bundle cannot be served as a document.

**`src/main/terminal/pty-manager.ts` — where a terminal may open.**
`resolveContainedCwd` passes **both** operands through `realpath` before
comparing, and compares as "equal to the root, or the root plus a separator".
Resolving only the candidate, or checking a lexical prefix first, is the bug the
function exists not to have: a symlink inside the workspace pointing at `/`
passes a `startsWith` on the unresolved path and lands the shell at the root of
the disk. The trailing separator matters independently — without it,
`/Users/x/work-old` is "inside" `/Users/x/work`. Both operands come from
`realpath`, which returns the canonical on-disk casing, so APFS
case-insensitivity cannot produce a prefix mismatch on a genuine descendant.

The file is explicit that this is **placement, not confinement**: once the shell
is running the user can `cd` anywhere they have permission to, because that is
what a terminal is. The point is that Juno never *puts* one somewhere the user
did not trust. Claiming otherwise would be worse than not claiming it.

**`src/main/workspaces.ts` — registration.** `realpath` before storing, and the
id derived from the canonical path. Storing the symlink instead would mean every
later containment check compares against a path that can be re-pointed after the
fact: the check would still pass, and it would be checking the wrong thing.

### Gaps

- **`resolveRendererPath` has no test.** It is pure, synchronous and exported
  with a comment saying it is exported for tests, and `tests/unit` contains no
  file that imports it. The adversarial corpus this function is written against
  — `%2e%2e`, `%252e%252e`, `..%2f`, backslash separators, embedded NUL,
  absolute paths, a symlink inside the bundle pointing outward — is described in
  its header and asserted nowhere. This is the single most valuable missing test
  in the workspace.
- **No TOCTOU closure.** Validation and the syscall are adjacent but not atomic;
  there is no `O_NOFOLLOW` on a final component and no fd-relative reopen.
- **No NFC/NFD normalization** before containment comparison.
- **No kernel backstop.** The Swift client applies an SBPL profile with
  `sandbox-exec` so that a traversal bug is contained even when the JS check is
  wrong. Nothing equivalent exists here, so every path defence is exactly as
  good as its own code.

---

## 3. Shell injection and argument interpolation

**STRIDE: E.** In Node the classic errors are `child_process.exec` — which
spawns a shell — and template-string command construction. A branch name, a
filename or an agent-supplied string containing `;`, `$(…)`, a backtick or a
newline becomes a second command, bypassing every rule that examined the
*intended* command.

**As implemented.** There is no such string anywhere in this workspace. Every
process is started from a program path plus an argv array with `shell: false`:

| Site | Call |
|---|---|
| `src/providers/acp/client.ts` | `spawn(launch.command, [...launch.args], { shell: false, detached: false })` — the comment reads "No shell, ever. The argument array is the whole interface." |
| `src/providers/discovery.ts` | `spawn(command, ['--version'], { shell: false })` |
| `src/agent-host/index.ts` | `execFileSync('/bin/ps', ['-A', '-o', 'pid=,ppid=,pgid='])` — an absolute path and a fixed argv |
| `src/main/terminal/pty-manager.ts` | `spawner(record.shell, record.args, …)` where `args` is `['-l']`; there is no code path in the module that builds a command string |

The shell candidate itself is validated rather than trusted: `SHELL` is an
environment variable, and `isPlausibleShellPath` rejects a relative path (which
would resolve against the *child's* cwd — attacker-influenced whenever the
workspace is), anything containing NUL or a newline, and anything over 4096
bytes, before `isExecutableFile` confirms it is a regular executable file.

The one legitimately free-form surface is the PTY, and the module is clear about
what that is: interactive terminal input is the *user's* authority, not the
agent's. `TerminalInputSchema` is parsed even for in-process callers, because
agent tool arguments originate in a separate OS process and are untrusted
regardless of what the type system believes at the call site — and the header
states that permission checks belong *before* that call, not in it.

### Gaps

- **No lint rule and no CI grep bans `child_process.exec`/`execSync`.**
  `no-restricted-imports` in `eslint.config.mjs` enforces the renderer/shared
  boundary and nothing else. The current cleanliness is a property of the code
  as written, not a property the build enforces.
- **No tokenizer, no classifier.** When a free-form `run_command` tool is wired
  through to the agent host, there is nothing in this workspace that tokenizes
  it under POSIX quoting rules, fails closed on an unbalanced quote, treats
  `$(…)` as unbounded, or classifies argument-injection flags. That work lives
  in the Swift client and is not ported.

---

## 4. Poisoned environment and git configuration

**STRIDE: E, I.** Two directions, and they need separate answers.

**Outbound** — main holds the Juno bearer token and the refresh token, and any
child that inherits `process.env` carries them into `env` output, crash dumps
and CLI telemetry. One line, `{...process.env}`, undoes the credential boundary,
and it is the default-looking choice in Node.

**Inbound** — a cloned repository's `.git/config` can set `core.pager`,
`core.sshCommand`, `core.fsmonitor`, `diff.*.textconv`, `filter.*.clean/smudge`,
`credential.helper` or `alias.*`, several of which execute on read-only-looking
operations. A checked-in `.npmrc`, `.yarnrc.yml` (`yarnPath` is arbitrary JS) or
`.envrc` does similar work at a different layer.

### What answers the outbound direction

Three spawn paths, three deliberately different environments, and the string
`...process.env` appears nowhere in `src/`.

**The agent host** (`src/main/agent-host-supervisor.ts`) gets a **freshly
constructed allowlist of five variables** — `PATH`, `HOME`, `SHELL`, `LANG`,
`TMPDIR`. Nothing else crosses. The comment says why: the host derives provider
credentials through its own configured path, and inheriting this process's
environment would hand it every secret Juno holds.

**Provider CLIs over ACP** (`src/providers/acp/client.ts`) get a different
allowlist — `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `TZ`, `TERM`,
`COLORTERM`, `NO_COLOR`, `TMPDIR`, the TLS and proxy variables, plus `LC_*` and
`XDG_*` — with a second pass that drops any allowlisted name still matching
`KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|SESSION`. The header
explains the shape: a denylist fails open on the variable nobody thought of, and
that failure mode is handing an unrelated vendor's credentials to a third-party
binary. `HOME` is load-bearing here — a `cli-managed` agent finds its own
credentials through it — which is a real reason and is written down as one.

**The PTY** (`src/main/terminal/pty-manager.ts`) is the deliberate exception,
and it is a **denylist**, because the user's terminal has to look like the
user's terminal. It removes: names whose `_`-separated segments match a
credential vocabulary (segment matching, not substring — substring matching on
`KEY` strips `KEYBOARD_LAYOUT` and keeps `MYKEYS`); the prefixes `JUNO_`,
`ELECTRON_`, `NPM_`, `NPM_CONFIG_`; an exact list of injection vectors
(`NODE_OPTIONS`, `DYLD_INSERT_LIBRARIES`, `DYLD_LIBRARY_PATH`, `LD_PRELOAD`, …)
which are removed because inheriting them from an Electron app into an
interactive shell is privilege laundering even when the value is benign; and any
*value* matching an anchored credential pattern — `sk-`, `sk-ant-`, `ghp_`,
`github_pat_`, `xox…`, `AKIA…`, `AIza…`, `glpat-`, `npm_`, `sk_live_`, a JWT
shape, or PEM material — which catches `MY_THING=ghp_…`, the case no naming rule
can. `SSH_AUTH_SOCK`, `SSH_AGENT_PID` and `GPG_TTY` are preserved on purpose:
they belong to the user's login session, not to Juno, and removing them breaks
`git push` in the terminal Juno just opened. The workaround users reach for when
that happens — an unencrypted key, a token pasted into the shell — is materially
worse than the thing being avoided.

**The fuses close the re-entry routes.** `runAsNode: false` stops
`ELECTRON_RUN_AS_NODE` turning the signed, TCC-blessed binary into a general
Node interpreter; `enableNodeOptionsEnvironmentVariable: false` closes
`NODE_OPTIONS` (`--require` is arbitrary code) and `NODE_EXTRA_CA_CERTS` (TLS
interception of the sync client); `enableNodeCliInspectArguments: false` closes
`--inspect`. These matter more than usual because the bundle is intended to hold
TCC grants, and TCC grants attach to the signed bundle.

### Gaps

- **No hardened git environment.** Nothing sets `GIT_CONFIG_NOSYSTEM=1`,
  `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=/usr/bin/false`,
  `GIT_ALLOW_PROTOCOL` (which is what blocks the `ext::` transport, a direct
  RCE), `core.hooksPath=/dev/null` or `protocol.file.allow=never`. Today main
  spawns no git at all, so there is nothing to harden — but the agent host and
  provider CLIs do run git, with the environment they were given and the user's
  own global config, and the diff-review feature is a planned direct consumer.
  This must land with the first git subprocess, not after it.
- **`NODE_EXTRA_CA_CERTS` is on the ACP allowlist.** Forwarding it is defensible
  alongside `HTTPS_PROXY` for corporate environments, but it means anything that
  can set a variable in the user's login environment can steer the provider
  CLI's TLS trust. The fuse protects Juno's own process and not its children.
- **The PTY scrub is subtractive.** A novel secret-shaped variable name with a
  non-matching value survives. That is the accepted cost of a terminal that
  behaves like the user's terminal, and it is stated in the module rather than
  hidden.

---

## 5. Hostile MCP server output

**No MCP client exists in this workspace.** There is no config parser, no stdio
or HTTP transport, and no tool registry. The risk today is zero. This section
records what must be true before that changes, because the Swift client's MCP
subsystem is a working demonstration of the failure mode.

The audit behind this document found the Swift `tools/call` gate to be genuinely
good — namespaced tool names, every call assessed `critical` and pinned to
`alwaysRequiresApproval`, an argv-array spawn with no shell, strict JSON-RPC
framing that rejects batches, null ids and server-to-client requests — and the
perimeter around it to be ungated. Specifically: `.mcp.json` is
**repository-controlled**, and server *spawn* plus `tools/list` bypass the
permission coordinator entirely, in every mode including read-only, with the
full application environment inherited. Cloning a hostile repository and
starting one turn is arbitrary code execution. The hooks subsystem in that same
codebase already solves exactly this problem, by storing the trust decision
outside the repository, and MCP does not use it.

**Before an MCP client ships here:**

1. Connecting a server requires an explicit, **out-of-repo** trust decision,
   keyed by `(accountId, canonical workspace root)`. Repository-controlled
   configuration alone connects nothing. A read-only session spawns nothing.
2. The spawn gets the agent host's fresh-allowlist environment, not the app's.
3. Tool names are namespaced `mcp__<server>__<tool>`, a collision with a
   built-in is a registration error rather than a silent override, and the
   registry key is the raw un-normalized identifier so two servers cannot
   collide with each other through lossy name sanitisation.
4. Responses **and tool descriptions and schemas** are size-bounded at the
   transport read loop (not downstream — a single unterminated multi-gigabyte
   line is an unbounded allocation before any limiter runs), depth-bounded,
   redacted, and labelled as untrusted data. Descriptions are a higher-privileged
   injection position than results: they enter system-level tool definitions
   before the user's first message.
5. The advertised tool manifest is hashed at first connect and a change requires
   re-approval.
6. HTTP transports are TLS-only, use a dedicated session with no shared cookie
   jar, and do not follow cross-origin redirects carrying auth headers.
7. The approval card shows the **arguments**, redacted and truncated. An
   approval that names only "server/tool" cannot inform a decision about
   exfiltration *through* the arguments.

---

## 6. Hostile local preview content

**No preview surface exists.** Nothing in this workspace loads
`http://localhost:<port>` into a window. When it does, the content is
attacker-authored exactly whenever the repository is, and it will be executing
inside the app.

Two things about the current code are worth knowing in advance.

**What would already cover it.** `hardenWebContents` is registered through
`app.on('web-contents-created')` in `applyProcessSecurityPolicy`, so *any*
`WebContents` created later — including one nobody remembered to harden —
inherits `will-navigate` blocking on anything that is not `isInternalUrl`,
`setWindowOpenHandler` returning `{action: 'deny'}`, and a `will-attach-webview`
handler that prevents attachment as a second lock behind `webviewTag: false`.
A preview's `window.open` would be routed through `openExternal`, which requires
`https:` and an allowlisted host. That is the right default and it was chosen
for this reason: a policy attached to a single window is a policy a future
second window silently does not have.

**What would not.** `hardenSession` is per-`Session`, and is currently called
for the default session and for each window's session. A preview created with
`partition: 'preview:<id>'` gets a **new** session that inherits none of it:
Electron's default permission behaviour would apply, which for non-remote
content grants several permissions outright. Any code that creates a partition
must call `hardenSession` on it, and nothing enforces that today.

The other requirements when it is built: no preload at all on the preview view,
a non-persistent per-workspace partition so nothing is shared with the app
origin, `will-navigate` pinned to the specific loopback origin rather than the
app origin, and the preview rendered in a separate `WebContentsView` so it
cannot draw chrome that impersonates Juno's own.

---

## 7. Computer Use abuse

**No Computer Use capability exists.** There is no screen capture, no input
synthesis, and no entitlement or Info.plist key that would participate in either
(see [RELEASE.md](RELEASE.md) — screen recording and accessibility are TCC-only
and have neither). This section is written now because the conclusion below
should be settled *before* anyone implements it.

### The honest finding

**Computer Use is not defended by the rest of this architecture.** Every other
control in this document constrains what the *agent host* does: the workspace
containment, the environment scrubbers, the trust gate, the classifier that is
not yet ported, the kernel sandbox that does not exist. None of them constrains
what the *user's own applications* do when the agent types into them. Typing
into Terminal.app is not a classified command. Reading a 1Password window is not
a filesystem access. The boundary is drawn around the wrong process.

Assessed one control at a time:

| Boundary | Does it stop this? |
|---|---|
| TCC (Screen Recording + Accessibility) | **Yes.** A hard OS gate, user-granted, revocable. The strongest control available, and the only one that exists today. |
| Explicit per-session consent | Yes, but it is one gesture covering a whole session. |
| A rate limit and a single in-flight action | Partly. Slows a runaway loop and makes it visible; does not prevent a determined sequence. |
| Coordinate bounds checking | **No.** It keeps clicks on screen. On screen is where the damage is. |
| An action journal | Detection and non-repudiation, not prevention. |
| A kill switch with a generation counter re-checked at every suspension point | **Yes**, for an in-flight action. |
| The command classifier, workspace containment, environment scrubbing | **No.** Completely bypassed. |

### The cycle, and why it is not hypothetical

If Juno's approval dialog is an ordinary window, synthesized input can click
"Approve", and the permission model has a cycle in it: the thing that authorizes
the agent's actions is itself an action the agent can perform. That collapses
every gate at once.

This is not a future concern that arrives with the feature. The clickable
surfaces already exist and ship today: `dialog.showMessageBox` in
`src/main/updater.ts` offers "Restart Now" for a downloaded update, and
`dialog.showOpenDialog` in `src/main/workspaces.ts` is the folder picker whose
output becomes a workspace — the one path by which a directory enters the
registry at all. Both are ordinary AppKit windows. Today nothing in the app can
synthesize a click on them, because nothing in the app can synthesize a click at
all. The moment something can, those two dialogs are the first things to reason
about, not the last.

### What must be true before it ships

1. **An approval cannot be granted by synthesized input.** At minimum, refuse to
   accept an approval while Computer Use is active in the same session; better,
   require a hardware-backed confirmation for any approval raised while it is
   active. This is the single most important requirement in this document,
   because without it the rest is decorative.
2. **Refuse to inject into a denylist of targets** — credential managers, System
   Settings, Terminal and iTerm, any window with a secure input field, and
   **Juno itself** — resolved from the frontmost application and the focused
   window's owner, and refused outright when macOS secure input mode is active.
3. **Restrict capture scope** rather than trying to redact pixels. Prefer a
   single user-chosen window or display, and exclude Juno's own window from the
   capture filter.
4. **Treat typing as more dangerous than clicking.** Typing into an unknown
   target must always require approval, in every mode.
5. **Time-box the grant.** Auto-deactivate after inactivity or a total action
   count; require re-consent.
6. **Never activate from anything in Z5 or Z6** — not from a remote instruction,
   not from model output, not from a config file.
7. **Journal every attempt**, success or failure, with before-and-after
   captures, and persist it. That is the only answer to repudiation.

---

## 8. Provider-credential exfiltration

**STRIDE: I.** A Juno bearer is not narrowly scoped — `getCurrentUser()` checks
the `Authorization` header first, so one access token authenticates the entire
`/api/**` surface — and the refresh token mints access tokens for thirty days.
Anything that can read them owns the account until the device session is
revoked.

Enumerated by path, with what exists:

| Path | Answer today |
|---|---|
| **Renderer reads a token** | Structurally impossible. No credential crosses IPC; CSP `connect-src 'self'` means the renderer cannot originate a network request at all, so all backend I/O happens in main. One mechanism satisfies two requirements. |
| **Child process environment** | Three spawn paths, three fresh environments, no `{...process.env}` anywhere ([§4](#4-poisoned-environment-and-git-configuration)). |
| **At rest** | `safeStorage`-encrypted per-account blobs, filenames hashed so a directory listing leaks no account id, mode 0600, written through a temp file with an explicit `fsync` before rename. **Fails closed**: if `isEncryptionAvailable()` is false there is no plaintext fallback, no in-memory-only mode, and `setUsePlainTextEncryption` is never called. Availability is re-checked on every write, because a locked keychain or a re-signed bundle is a runtime condition, not a startup fact. |
| **In memory** | `SecretString` returns `[redacted]` from `toString`, `toJSON` and the `util.inspect` hook, which closes the three ways a value normally reaches a log: interpolation, `JSON.stringify` of a containing object, and `console.log` of that object. Reading requires `.reveal()`, which greps as an audit point — there are four call sites in the codebase and the file names all four. Construction rejects whitespace and control characters, because the value is concatenated into an `Authorization` header where CR/LF is a header-injection primitive. |
| **Logs** | Redaction at the sink, not at the call site: every value written passes through `redactValue`/`redactString` in `src/main/logger.ts`, which handles header shapes, key-shaped names, URL query *and* fragment, and rewrites `/Users/<name>` paths. `redactUrl` in `security.ts` does the same for URLs in warnings. "Remember to redact" is not a control, so the logger does it. |
| **Agent host stderr** | Bounded to 2,000 characters, logged, and **never forwarded to the renderer** — a provider CLI can print a credential to stderr. |
| **Grant paths** | `GrantVault` mints an opaque 32-byte token with no relationship to the path; the path never crosses IPC and is never logged, because a grant is precisely the case where the rest of the path is the sensitive part. The vault is in-memory and dies with the process. |
| **Update release notes** | Remote content rendered in a modal: tags stripped, control characters removed, capped at 600 characters. It cannot execute, but it could otherwise forge dialog chrome or run to thousands of lines. |

### Gaps

- **`crashReporter` is never configured.** Electron's default is not to upload,
  so nothing leaves the machine today — but the decision is implicit. It should
  be `uploadToServer: false` explicitly, with no dynamic `extra` fields, so that
  enabling it later is a deliberate act.
- **No CI secret scan.** Nothing scans source or the built artifact for
  credentials. The host repository treats that as an invariant for the Swift
  apps; this workspace has no equivalent.
- **No canary test.** The strongest form of the assertions above is: seed a
  known value into the keychain and the environment, exercise the app, then grep
  every log, transcript and payload for it. That test does not exist.
- **No `.env`-aware read refusal.** Nothing stops a file tool reading `.env`,
  `*.pem` or `id_*` into model context.

---

## 9. Remote control and approval replay

**STRIDE: S, T, E, R.** The question is whether a compromised or spoofed remote
surface can issue local commands. The answer has to be: only within a permission
envelope this machine independently enforces, and it can never manufacture an
approval.

**Today the remote plane is not live.** `work:resolve-approval` and `work:answer`
return an explicit "not available in this build yet" refusal, and the surfaces
render their real disabled states rather than a fabricated one. Code Remote does
not exist. The Work wire mappers are written, and
`src/main/work/wire.ts` is candid about what they carry: `actionDigest` **is**
carried, `policyDigest` and `digestInput` are sent as empty strings, and the
comment explains that this is honest rather than convenient — this client holds
no digest input, and the decision route only checks `actionDigest`, so the
substitution defence the mechanism exists for is intact.

**Deep links are the one remote-origin input that is live**, and
`src/main/deep-links.ts` is the strictest parser in the workspace. It is the
only input that arrives with no prior IPC, no session and no user gesture: a
browser hands macOS a string authored by whatever page the user was on. So the
grammar is a closed allowlist of two hosts and three shapes; the query is parsed
with `z.strictObject`, meaning an unknown parameter is a parse *failure* rather
than an ignored field; `code` and `state` are constrained to a character class
rather than `z.string()`, because the value ends up in an HTTP body and in log
lines; repeated keys are refused rather than resolved (`?code=good&code=evil` is
ambiguous — `searchParams.get` takes the first, other parsers take the last);
`juno://app` is rejected outright so a link cannot address the protocol
handler's file-serving path from outside; userinfo and ports are rejected; the
whole thing is length-bounded before it reaches the URL parser or the logger;
and the callback URL handed to the auth controller is **rebuilt from the two
validated fields** rather than passed through, so every parameter `strictObject`
just rejected cannot ride along inside the string and be re-parsed downstream.

A deep link carries navigation intent only. There is no shape in the grammar
that names a path, a command or an action.

### Requirements for the remote plane, when it lands

The Work plane on the server side is close to a reference design and should be
ported wholesale rather than reinvented: derived (not random) idempotency keys
unique on `(userId, key)`; a TTL re-checked **at execute time, not only at claim
time**, with unparseable dates decoding to the distant past so they fail closed;
a lease with a conditional compare-and-swap claim so two processes cannot both
execute; a monotonic sequence with gap detection; protocol-version negotiation;
and write-once approval decisions where an identical answer replays as success
and a *different* answer is a conflict with an audit row.

Two rules matter above the mechanics. A remote instruction is a **request**, not
a command: it re-enters the same local pipeline as a model tool call, and no
remote path reaches `spawn` without the local gate. And capability derivation
stays local and asymmetric — a missing policy means *strictest*, not host
default; turning a capability off always works while turning it on requires the
Mac to have advertised it; and a remote instruction can never mint a filesystem
grant, because the local file picker does that.

### Gaps

- **Local Code approvals are not digest-bound** ([§1](#1-malicious-repository-content-and-prompt-injection)).
  The same substitution defence the Work plane has on the wire is missing on the
  path that is actually live.
- **No audit log.** Approvals, decisions and their outcomes are logged as
  application events, not as an append-only security record.
- **No device-bound credential exists to bind to yet.** The host repository's
  relay accepts either a native bearer or a browser session cookie on host-only
  surfaces; that must not be inherited when this client speaks to it.

---

## 10. Multi-account data separation

**STRIDE: I, T.** One Mac, two Juno accounts — work and personal. The failures
are: account B reads account A's cached data; a stale in-memory token from A is
used for a B request; Electron cookies and storage bleed across accounts; and a
capability A granted is silently inherited by B.

That last one is not hypothetical. In the Swift client, Juno Work folder grants
— the security-scoped bookmarks that *are* the filesystem capability — live in a
single global `UserDefaults` key and are never wiped, so account A grants
`~/Documents`, signs out, and account B inherits it.

### What answers it today

Credentials are per-account by construction: one `safeStorage` blob per account
under a filename that is a hash of the account id, plus a small non-secret
pointer naming the active one. The pointer is outside the encrypted blob on
purpose — macOS can transiently refuse a keychain read while a bundle is being
replaced or re-signed, and keeping the *locator* readable lets the next launch
distinguish "I have an account whose credentials I cannot read right now" from
"nobody is signed in". `read()` refuses a blob whose embedded `accountId` does
not match the filename it was found under, rather than adopting whatever account
it names. Sign-out `rm`s the file rather than nulling a field, because a 30-day
refresh token sitting in `userData` is precisely what a user pressing "Sign out"
is asking not to happen.

`AccountSession` opens the per-account encrypted database and starts the sync
client on `signed-in`, and stops both on sign-out, device revocation or account
switch. Transitions are serialised through a promise chain, so a fast
sign-out/sign-in cannot leave two sessions open on one database file.

**Workspace trust is revoked on sign-out and on device revocation**
(`WorkspaceRegistry.revokeAllTrust`, called from the composition root). The
method's comment names the Swift defect it exists to avoid. This is the direct
answer to the grant-inheritance failure, and it is the right shape: a trust
decision belongs to the account that made it.

The grant vault is in-memory and dies with the process, so no Work grant
survives a restart, let alone an account switch.

### Gaps

- **The workspace registry itself is global.** `workspaces.json` lives at the
  root of `userData`, not under an account-scoped directory. Trust is revoked,
  so account B inherits no *capability* — but it inherits the **list**: the
  canonical paths and folder names of every repository account A opened. That is
  a real disclosure, and it is the residue of the same defect rather than its
  absence.
- **No per-account Electron session partition.** Everything shares
  `defaultSession`, and nothing calls `clearStorageData` or `clearAuthCache` on
  sign-out. Cookies, cache and permission state are process-wide.
- **The sign-out purge is not an enumerated registry.** Each teardown path names
  the stores it knows about. Nothing walks a registry of persistent stores and
  fails when one is unregistered, which is how a new store gets added without
  being wiped.
- **Trust records are not keyed by account.** The registry key is the workspace
  id alone.

---

## 11. Completing STRIDE

**(D) Resource exhaustion.** The PTY manager is the one place this is properly
answered, and it is answered with real backpressure rather than a timer: output
is batched on a 16 ms frame, capped at 128 KiB per event with the **tail** kept
and the dropped count reported, and the pty is `pause()`d above 256 KiB pending,
which stops draining the master fd so the kernel's tty buffer fills and the
child blocks in `write(2)`. Everything short of that just moves an unbounded
buffer into a different process. Scrollback is a ring capped at 256,000 code
units that trims on a surrogate boundary. Terminals are capped at twelve.
Shutdown signals the **process group** (`kill(-pid)`) — SIGHUP *and* SIGTERM,
because a measured `/bin/zsh -l` on a pty ignores SIGTERM entirely and exits
immediately on SIGHUP — then SIGKILLs survivors after a 2 s grace, with a
synchronous `process.on('exit')` backstop. The module is explicit that a
deliberately detached process survives, and that this is correct: killing it
would override an explicit instruction from the user.

The agent host has a bounded restart count (three, then it stays down with a
visible status, because a crash loop that hides itself is worse than an outage
that admits it), a 15 s ready timeout, a 120 s per-request timeout, and a 5 s
shutdown grace before `kill()`. The ACP client bounds line length and stderr.

**(R) Repudiation.** `PtyManager.onInput` is a seam that observes every write
with its origin and correlation id, which is what an activity log would consume.
There is no append-only, redacted security log of approvals and their decisions.

**(T) Auto-update.** `autoDownload` and `autoInstallOnAppQuit` are both **off**,
explicitly, on the first line of configuration, against electron-updater's
defaults. The reasoning in `src/main/updater.ts` is worth keeping: this is a
developer tool holding live terminal sessions and running agent turns, and
replacing its binary is the single highest-consequence action the app can take.
"Install on Quit" is offered as a choice, because a user deferring installation
is a completely different thing from the app deciding for them. The feed URL is
still a placeholder and must be `https:` — electron-updater verifies the
signature of the downloaded artifact, but an `http:` feed lets an attacker
choose *which* signed version a user is offered, and downgrade attacks are real.
See [RELEASE.md](RELEASE.md).

**(E) Supply chain.** `package.json` carries an explicit `allowScripts` policy
naming the three packages whose install scripts run — `electron`, `node-pty`,
`esbuild` — with a note recording why each is required. Everything else installs
without scripts. A malicious postinstall in a transitive dependency otherwise
runs at build privilege and ships inside a notarized, TCC-blessed bundle.
`onlyLoadAppFromAsar: true` removes the `app/` directory fallback an attacker
could drop code into. **`enableEmbeddedAsarIntegrityValidation` is off**, so a
modified `app.asar` is not detected; that is a deliberate deferral pending a
signed-build test pass, recorded in `electron-builder.yml` and in the residual
risks below. There is no SBOM and no reproducible-build step.

**(I) Window-level leakage.** Nothing marks Juno's window as excluded from
capture, so it appears in screenshots, the window switcher and Stage Manager
thumbnails like any other app.

---

## Invariants

Each is written so it can be tested. **Tested** means an assertion exists in
this workspace and runs in `npm run gates` or `npm run test:e2e`.

### Electron shell

| # | Invariant | State |
|---|---|---|
| 1 | Every window is created from the frozen `SECURE_WEB_PREFERENCES`: `contextIsolation`, `sandbox`, `webSecurity` true; `nodeIntegration`, `nodeIntegrationInWorker`, `nodeIntegrationInSubFrames`, `webviewTag`, `allowRunningInsecureContent`, `experimentalFeatures` false. | **Tested** — `tests/unit/security.test.ts` asserts each flag, that the object is frozen and throws on mutation, and that every value is a boolean (`sandbox: 'true'` is truthy in review and malformed to Electron). |
| 2 | The CSP is `default-src 'none'`, `script-src 'self'` with no `'unsafe-inline'` and no `'unsafe-eval'`, `connect-src 'self'`, and `object-src`/`base-uri`/`form-action`/`frame-ancestors` all `'none'`. | **Tested** — asserted directive by directive, including that `style-src` is the *only* directive carrying `'unsafe-inline'` and that no directive names a remote origin or a wildcard. |
| 3 | Only the app's own origin is navigable; a lookalike host, a scheme change or userinfo is refused. | **Tested** — sixteen rejection cases including `juno://app.evil.example`, `juno://appx`, `juno://app@evil.example/`, `javascript:`, `data:`, `file://app/…`, and the dev-server exemption proven to apply only on an unpackaged build. |
| 4 | `shell.openExternal` accepts only `https:` on an allowlisted host, and never reaches the shell otherwise. | **Tested** — refusals assert `shell.openExternal` was *not called*, covering custom app schemes, `smb:`, `vscode:`, http downgrade on an allowlisted host, subdomain and suffix confusion, userinfo impersonation, and a Cyrillic homoglyph host written as an escape so an editor cannot silently normalise the case away. |
| 5 | Every `ipcMain.handle` callback validates the sender's `WebContents` identity **and** frame URL before the handler runs. | Implemented; **not tested**. No test drives a subframe or a navigated window. |
| 6 | The renderer is served from `juno://`, never `file://`, and the renderer has no access to Node. | **Tested** at runtime — `tests/e2e/smoke.spec.ts`. |
| 7 | `juno://app/../../etc/passwd` and its encoded variants are refused. | Implemented in layers; **not tested**. See [§2](#2-symlink-escape-and-path-traversal). |
| 8 | Fuses: `runAsNode`, `enableNodeOptionsEnvironmentVariable`, `enableNodeCliInspectArguments` off; `onlyLoadAppFromAsar`, `enableCookieEncryption` on. | Configured; **never verified on a packaged app**, because packaging has never been run. |

### Workspace containment and execution

| # | Invariant | State |
|---|---|---|
| 9 | A workspace is untrusted until an explicit decision; registering one never trusts it. | **Tested** — `tests/integration/workspace-registry.test.ts`, against a real filesystem. |
| 10 | A workspace id derives from the canonical path, so a symlink cannot produce a second entry with its own trust. | **Tested** — same file, with a real symlink. |
| 11 | An untrusted workspace refuses a terminal and refuses a Code session, in main. | **Tested** — `tests/e2e/wiring.spec.ts`, over the real bridge, including the message content and an unregistered id. |
| 12 | A terminal opens only at a path that is `realpath`-equal to, or beneath, the `realpath`'d trusted root. | Implemented; **not directly tested** against an adversarial symlink tree. |
| 13 | No `child_process.exec` or `execSync`; every spawn uses an argv array with `shell: false`. | True today; **not enforced** by lint or CI. |
| 14 | Every child receives a freshly constructed environment; `{...process.env}` appears nowhere. | True today; **not enforced**, and no canary test proves a spawned process cannot see a variable set in main. |
| 15 | Every terminal is killed by process group, with SIGHUP+SIGTERM then SIGKILL. | Implemented and reasoned from measurement; orphan behaviour **not tested** under a fork bomb. |

### Approvals

| # | Invariant | State |
|---|---|---|
| 16 | An approval resolves to `allow` only through an explicit decision; every other path denies. | Implemented in `src/agent-host/session-manager.ts`. |
| 17 | A decision applies to at most one tool call, exactly once; a duplicate pending approval for a `callId` is denied. | Implemented. |
| 18 | Pending approvals are denied before an abort, not after. | Implemented. |
| 19 | Every approval binds a SHA-256 digest over the canonical `{toolName, input}`, re-verified with its expiry immediately before execution. | **Gap.** Not implemented locally. |
| 20 | Lowering the permission mode revokes every pending approval. | **Gap.** No authority revision exists. |
| 21 | Approvals fail closed on cancellation, session stop, account switch and app termination. | Partly — the host denies on abort and on turn end; there is no account-switch or termination sweep. |

### Credentials and data

| # | Invariant | State |
|---|---|---|
| 22 | No credential is reachable from any renderer. | Structural — `connect-src 'self'` plus no credential-returning channel. Not asserted by a test. |
| 23 | Credentials are encrypted at rest and storage **fails closed** when the OS keychain is unavailable. | Implemented; the failure path is unit-testable through the injected backend and the *live* path needs a signed build. |
| 24 | A secret cannot reach a log through interpolation, `JSON.stringify` or `console.log`. | Implemented via `SecretString`; redaction at the logger sink. No canary test. |
| 25 | Sign-out removes the credential blob from disk and revokes trust on every workspace. | Implemented. |
| 26 | No capability grant is global, and no account-scoped store survives a sign-out. | **Partial gap** — trust and credentials are handled; the workspace path list and the Electron session are not. |
| 27 | No secret exists in the built bundle. | **Gap.** No scan exists. |

### Honesty

| # | Invariant | State |
|---|---|---|
| 28 | An unavailable capability is reported as unavailable, never faked. | Held throughout: the Chat and Work handlers return explicit "not available in this build yet" refusals; the updater states *which* of "unpackaged" or "no publish target" applies; diagnostics reports `backendReachable: false` rather than guessing; the agent host surfaces "No provider has a configured API key" verbatim. |
| 29 | No capability is advertised that has no implementation. | Held today — every one of the 52 invoke channels has a handler, and the ones with nothing behind them refuse rather than pretend. |

---

## Residual risks, accepted

Each of these is a known weakening with a reason. They are listed so the reason
can be re-examined, not so it can be forgotten.

**`style-src 'unsafe-inline'`.** React and Framer Motion set styles on elements
directly, and there is no practical way to run a motion system without it. This
is a much smaller concession than inline *script*: under `script-src 'self'`
with no `'unsafe-eval'`, injected style cannot execute code. The unit test
asserts that `style-src` is the **only** directive carrying it, so the exception
cannot quietly spread.

**No kernel sandbox for child processes.** The Swift client applies an SBPL
profile through `sandbox-exec`, with reads broad and writes enumerated, and
`allowsNetwork` and `allowsLocalhost` as separate capabilities. Nothing
equivalent exists here, so every containment defence is exactly as good as its
own JavaScript. This is the largest single missing layer.

**The PTY is placement, not confinement**, and the terminal environment is
scrubbed subtractively rather than rebuilt from an allowlist. Both are
deliberate: a terminal the user cannot `cd` out of is not a terminal, and one
that has lost `SSH_AUTH_SOCK` is one where the user pastes a token instead.

**`SSH_AUTH_SOCK` is preserved into terminal children.** It is the user's own
agent socket, present in their own Terminal.app. The rule the list encodes:
strip what belongs to Juno, keep what belongs to the user's login session.

**`enableEmbeddedAsarIntegrityValidation` is off.** It is a real hardening win
and the natural next step, but it hashes `app.asar` and validates at load, so it
needs a signed-build test pass against the `asarUnpack` rules first. Turning it
on untested trades a security gap for a launch failure.

**`grantFileProtocolExtraPrivileges` is left at its default (on).** The comment
in `electron-builder.yml` justifies this by saying the renderer loads from
`file://` in the packaged app. That is **stale** — `src/main/protocol.ts` serves
the renderer from `juno://` and the E2E suite asserts it. The fuse should be
turned off; the only reason not to is that it has not been tested on a packaged
build, which is the same reason as the one above.

**Both dark-mode and update dialogs are ordinary AppKit windows.** See
[§7](#7-computer-use-abuse). Accepted only for as long as nothing on this
machine can synthesize input.

**The renderer is assumed compromisable.** Every control above is written on
that assumption rather than on the assumption that our own code is safe. That is
not a residual risk so much as the axiom the boundary is built on, and it is
listed here because it is the reason several of these concessions are tolerable.

---

## Gap register

One place to look, so nothing above has to be re-read to find the open work.
Ordered by consequence.

| Gap | Where | §
|---|---|---|
| Local approvals bind a `callId`, not a digest over the action | `src/main/index.ts`, `src/agent-host/session-manager.ts` | [1](#1-malicious-repository-content-and-prompt-injection), [9](#9-remote-control-and-approval-replay) |
| No untrusted-data fence around tool output entering model context | agent host | [1](#1-malicious-repository-content-and-prompt-injection) |
| `resolveRendererPath` has no test | `tests/unit` | [2](#2-symlink-escape-and-path-traversal) |
| No kernel sandbox for child processes | absent | residual |
| No hardened git environment, and no git subprocess yet to attach it to | absent | [4](#4-poisoned-environment-and-git-configuration) |
| No lint or CI ban on `child_process.exec`/`execSync` | `eslint.config.mjs` | [3](#3-shell-injection-and-argument-interpolation) |
| No command classifier or tokenizer | absent | [3](#3-shell-injection-and-argument-interpolation) |
| `workspaces.json` is global; account B inherits account A's workspace path list | `src/main/workspaces.ts` | [10](#10-multi-account-data-separation) |
| No per-account Electron session partition; no `clearStorageData` on sign-out | `src/main/index.ts` | [10](#10-multi-account-data-separation) |
| The sign-out purge is not an enumerated, tested registry | composition root | [10](#10-multi-account-data-separation) |
| No approval expiry and no authority revision | absent | [1](#1-malicious-repository-content-and-prompt-injection) |
| `crashReporter` is never explicitly disabled | absent | [8](#8-provider-credential-exfiltration) |
| No CI secret scan of source or built artifact | absent | [8](#8-provider-credential-exfiltration) |
| No canary test for credential leakage across sinks | absent | [8](#8-provider-credential-exfiltration) |
| No append-only audit log of approvals and decisions | absent | [9](#9-remote-control-and-approval-replay), [11](#11-completing-stride) |
| Nothing statically asserts `ipcMain.handle` is only called from the router | `src/main/ipc-router.ts` | [0](#0-the-ipc-boundary) |
| Fuses configured but never verified on a packaged app | `electron-builder.yml` | [4](#4-poisoned-environment-and-git-configuration) |
| `hardenSession` must be called on any new partition; nothing enforces it | `src/main/security.ts` | [6](#6-hostile-local-preview-content) |

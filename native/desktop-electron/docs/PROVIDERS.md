# Providers

How Juno Desktop talks to coding agents — and what it is and is not allowed to do.

Verified against the live spec and vendor terms on **2026-08-12**. Everything with a
legal consequence carries a URL; re-check them before shipping.

---

## 1. Why ACP first

Juno could have written one integration per vendor: a Claude adapter, a Codex adapter, a
Gemini adapter, each with its own process model, its own streaming format and its own
bugs. That is `n` integrations to write and `n` to keep alive as vendors ship.

Instead there is one, because the **Agent Client Protocol** already exists and the
vendors already speak it.

- **Spec**: <https://agentclientprotocol.com/> · **Repo**:
  <https://github.com/agentclientprotocol/agent-client-protocol> (Apache-2.0; the older
  `zed-industries/agent-client-protocol` URL 301-redirects here).
- **Registry**: <https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json>
  (registry version `1.0.0`) lists **38 agents**, including first-party ACP entrypoints
  from Anthropic, OpenAI, Google, GitHub, Cursor, Moonshot, Alibaba, Block and Augment.
- **Official TypeScript SDK**: `@agentclientprotocol/sdk` (repo
  `agentclientprotocol/typescript-sdk`).

One well-built client covers all of them. Juno does **not** depend on the SDK — the
transport is ~400 lines and vendoring the schema keeps the Electron main bundle small and
the validation ours — but the schemas in `src/providers/acp/schema.ts` are *derived from*
the SDK's generated types and shipped `schema/schema.json`, not from prose or guesswork.

### The protocol shape, as actually verified

Source: `@agentclientprotocol/sdk@1.3.0`, `dist/schema/index.d.ts` and
`schema/schema.json`. The package also ships `schema/v2/schema.unstable.json`; **Juno
targets v1**, which is what every agent in the registry speaks today.

- **Transport**: JSON-RPC 2.0 over the child process's stdin/stdout. Newline-delimited
  UTF-8, one complete message per line, **no embedded newlines**.
- **Version**: the SDK exports `PROTOCOL_VERSION = 1`. This is the integer sent as
  `protocolVersion` in `initialize` — it is not a semver string, and the "v1.6.0 /
  schema-v1.20.0" numbers seen elsewhere are *release tags of the spec repo*, not the
  value on the wire.
- **Client → agent** (`AGENT_METHODS`): `initialize`, `authenticate`, `session/new`,
  `session/load`, `session/prompt`, `session/cancel`, `session/set_mode`,
  `session/set_config_option`, `session/list`, `session/resume`, `session/fork`,
  `session/close`, `session/delete`, `logout`, plus `providers/*`, `nes/*` (next-edit
  suggestions) and `document/did*` text-sync, which Juno does not use.
- **Agent → client** (`CLIENT_METHODS`): `session/update` (notification),
  `session/request_permission`, `fs/read_text_file`, `fs/write_text_file`,
  `terminal/create|output|release|wait_for_exit|kill`, `elicitation/create`,
  `elicitation/complete`, `mcp/connect|message|disconnect`.
- **Transport-level**: `$/cancel_request`.

Three details that are easy to get wrong and that Juno gets right:

1. `StopReason` is `end_turn | max_tokens | max_turn_requests | refusal | cancelled`.
   There is no `completed`.
2. `ToolKind` is `read | edit | delete | move | search | execute | think | fetch |
   switch_mode | other`, and `ToolCallStatus` is `pending | in_progress | completed |
   failed`. Not `function`/`command`, and not `cancelled`.
3. `SessionUpdate` is discriminated on **`sessionUpdate`**, and each variant *flattens*
   its payload — a `tool_call` update carries `toolCallId` and `title` at the top level,
   not nested under a key.

Optional session features are advertised by the **presence of an object**, not a boolean:
`sessionCapabilities: { resume: {} }` means resume is supported; `resume: null` or absent
means it is not. `src/providers/capabilities.ts` models this faithfully.

---

## 2. Capability negotiation

Vendor-keyed capability tables go stale. `src/providers/capabilities.ts` therefore derives
everything it can from the real `initialize` response, and — importantly — records **how**
it knows each fact:

| `source` | Meaning |
| --- | --- |
| `protocol` | Guaranteed by ACP v1 itself. An agent without it is not speaking ACP. |
| `negotiated` | Read from the `initialize` handshake. Authoritative. |
| `observed` | ACP has the concept but never advertises it. Learned from live traffic. |
| `host` | Not a protocol concept; Juno provides it around the agent. |
| `unavailable` | Neither expressible in ACP nor provided by Juno. A real absence. |

`observed: false` and `unavailable: false` both render as "off", and conflating them is
how a UI ends up telling a user their agent cannot reason when it simply has not thought
out loud yet. The UI must treat them differently.

| Capability | Source | Basis |
| --- | --- | --- |
| `streaming` | `protocol` | All assistant output arrives as `session/update`. |
| `tools` | `protocol` | `tool_call` / `tool_call_update` are unconditional. |
| `mcp` | `protocol` | `session/new` always accepts stdio MCP servers; `mcpCapabilities.{http,sse,acp}` add transports. |
| `sessionResume` | `negotiated` | `agentCapabilities.loadSession` or `sessionCapabilities.resume`. |
| `reasoning` | `observed` | `agent_thought_chunk` exists but is never advertised. Flips true on the first one. |
| `skills` | `observed` | `available_commands_update`, which only arrives after a session exists. |
| `usage` | `observed` | `PromptResponse.usage` is optional. |
| `worktrees` | **`host`** | Not an ACP concept. Juno creates the worktree and passes its path as the `session/new` `cwd`. The agent never knows. |
| `backgroundExecution` | **`host`** | Gated on Juno advertising `clientCapabilities.terminal`, which lets the agent use `terminal/create` instead of blocking a turn. |
| `computerUse` | **`unavailable`** | No ACP concept, and Juno gives third-party agents no screen or input channel. |
| `subagents` | **`unavailable`** | No ACP concept. Nested agents are invisible behind the agent process. |
| `agentTeams` | **`unavailable`** | First-party only. |

Plus a protocol-level block (`manifest.acp`) carrying the raw negotiated flags:
`loadSession`, `sessionList/Fork/Close/Delete`, `additionalDirectories`,
`promptImage/Audio/EmbeddedContext`, `mcpHttp/Sse`, `modes`, `plans`, `logout`.

Refinement happens in two more places: `applySessionCapabilities` folds in what
`session/new` reported (modes and config options are *not* in the handshake), and
`applyObservedUpdate` upgrades `observed` capabilities from live traffic. Upgrades are
**monotonic** — one quiet turn is not evidence of absence — and return the same object
identity when nothing changed, so a re-render can be skipped on the common case.

---

## 3. ACP → `AgentEvent`, and where it is lossy

Juno has one canonical event vocabulary: `AgentEvent` in
`runner/agent-core/src/types.ts`, already spoken by the local agent loop, the cloud
runner, the session relay and both Swift clients. A second vocabulary for ACP would mean
every consumer grows a branch, and the branches drift. So `src/providers/acp/adapter.ts`
translates once and everything downstream stays unaware a third-party CLI was involved.

### Faithful mappings

| ACP | `AgentEvent` |
| --- | --- |
| `session/new` result | `session_started` |
| `session/prompt` sent | `turn_started` |
| `agent_message_chunk` | `assistant_delta` (accumulated → `assistant_message`) |
| `tool_call` | `tool_started` |
| `tool_call_update` (status `completed`/`failed`) | `tool_finished` |
| `session/request_permission` | `approval_requested` |
| permission answered | `approval_resolved` (+ `tool_denied` on deny) |
| `current_mode_update` | `mode_changed` |
| `locations[].path`, `diff.path` | `files_changed` (aggregated per turn) |
| `PromptResponse` | `turn_finished` |
| JSON-RPC error / transport failure | `error` |

`stopReason` passes ACP's own string through unchanged, so `end_turn`, `refusal` and
`max_turn_requests` survive intact — `AgentEvent.stopReason` is a free string.

### Lossy points — read this section before debugging a "missing" event

Nothing below is silently dropped. Everything ACP carries that `AgentEvent` cannot hold
goes out on a **typed side channel**, `AcpSideEvent`, returned alongside the events from
`AcpEventAdapter.translate()`. Widening `AgentEvent` would force the cloud runner and both
Swift clients to handle events they can never receive; discarding would lose the reasoning
stream and the slash-command catalogue.

| ACP concept | Handling | Why |
| --- | --- | --- |
| `agent_thought_chunk` | side channel `reasoning_delta` | `AgentEvent` has no reasoning channel. Folding it into `assistant_delta` would corrupt the transcript. |
| `plan`, `plan_update`, `plan_removed` | side channel `plan` / `plan_changed` | No `AgentEvent` equivalent. |
| `available_commands_update` | side channel `commands` | Drives the slash-command menu. |
| `config_option_update` | side channel `config_options` | Also used to recover the model name. |
| `session_info_update` | side channel `session_info` | The agent's own title for the session. |
| `usage_update` | side channel `context_usage` | **`used`/`size` is context-window occupancy, NOT token billing.** Folding it into `turn_finished.usage` would put a context measurement in a token field. Only `PromptResponse.usage` maps to `usage`. |
| `user_message_chunk` | side channel `replayed_user_message` | Replayed history during `session/load`; Juno already has it. |
| `ToolCallContent` of type `terminal` | side channel `terminal_reference` + a `[terminal <id>]` marker in the output | Juno does not advertise `terminal/*`, so it holds no handle to read. |
| `PermissionOption[]` | side channel `permission_options` | See below. |
| `elicitation/create`, `nes/*`, `document/did*`, `mcp/*` | answered `-32601` | Juno never advertises these, so a well-behaved agent never asks. |

Four further asymmetries worth knowing:

- **Model name.** ACP reports no model anywhere in the handshake, but
  `AgentEvent.session_started.model` is required. The adapter looks for a `session/new`
  config option with `id === 'model'` and uses its current value; failing that it reports
  the literal `agent-managed`. That is truthful. Inventing a model id would not be.

- **Permission options.** ACP options are agent-defined strings ("Allow for this file",
  "Allow every edit under `src/`"); Juno's `ApprovalDecision` has three values. The adapter
  matches on `PermissionOptionKind` (`allow_once` / `allow_always` / `reject_once` /
  `reject_always`), falls back to the nearest option of the same polarity, and **returns a
  `degraded` flag** when it had to. `allow_always` against an agent that only offers
  `allow_once` means the user's "always" lasts one turn — the UI must not promise
  otherwise. If no option of the requested polarity exists at all, the outcome is
  `cancelled`; inventing an `optionId` would be rejected anyway.

- **Permission modes.** ACP mode ids are free strings; `PermissionMode` is a closed set of
  four. `permissionModeForAcpMode` is a heuristic over the ids agents actually ship, and an
  unrecognised id falls back to **`ask`** — guessing `full` from an unknown string would
  silently widen what an agent may do unconfirmed.

- **Risk levels.** `riskForToolKind` maps `ToolKind` → `RiskLevel` for *display only*, and
  deliberately does **not** re-run agent-core's `classifySensitiveCommand` over the command
  text. For an ACP provider the agent owns its permission policy and asks via
  `session/request_permission`; Juno is not the gate, and a second copy of that pattern list
  would drift while enforcing nothing.

- **Never emitted for ACP providers**: `subagent_update` (no protocol concept) and
  `turn_finished.subagentUsage`.

---

## 4. The transport, and why it looks paranoid

`src/providers/acp/client.ts` is the only place Juno spawns a third-party binary.

- **Framing.** `LineFramer` handles the three cases that actually occur: a partial line, a
  chunk holding several complete lines, and a line spanning many chunks. Chunks decode
  through `StringDecoder`, so a UTF-8 sequence split across a boundary is held back rather
  than mangled. Once the carry buffer exceeds `maxLineBytes` (8 MiB) the **connection is
  torn down** — a hostile or buggy agent emitting an unterminated stream must not OOM the
  Electron main process and take the user's unsaved work with it.
- **Spawning.** `child_process.spawn` with an **argument array** and `shell: false`. No
  prompt, path, model output or MCP config is ever interpolated into a command string.
- **Environment.** An **allowlist**, not `process.env` minus a few names: `PATH`, `HOME`,
  `USER`, `LOGNAME`, `SHELL`, `LANG`, `TZ`, `TERM`, `TMPDIR`, CA-bundle and proxy vars,
  plus `LC_*`/`XDG_*`. A denylist fails open on the variable nobody thought of, and the
  failure mode is handing an unrelated vendor's credentials to a third-party binary. Every
  shipped provider has `envPassthrough: []`, so **no API key reaches any agent process** —
  `cli-managed` agents read their own credential stores via `HOME`.
- **Shutdown.** stdin EOF (most agents exit cleanly on it, flushing as they go), then
  `SIGTERM`, then `SIGKILL` after the grace period. Every live child is registered in a
  module-level set with a `process.on('exit')` hook, so a parent crash cannot leave an
  agent running against the user's repository.
- **stderr.** Bounded ring buffer (64 KiB), and there is **no accessor that returns it
  unredacted**. Agents print credentials to stderr more often than anyone would like.
- **Correlation.** Requests are keyed by integer id with per-call timeouts;
  `session/prompt` opts out (`timeoutMs: null`) because a turn legitimately runs for
  minutes. Every pending request is rejected on process exit. Cancellation sends
  `session/cancel` and *keeps waiting* — ACP requires the agent to still answer the
  original request with `stopReason: "cancelled"`, and rejecting locally would
  desynchronise the id map.
- **Validation.** Every inbound frame is Zod-parsed before anything acts on it. Schemas are
  **loose** (unknown keys pass through) because agents ship ahead of the spec and every
  object carries an open `_meta`; stripping would discard data an agent considers
  meaningful.

### Discovery: look, don't run; and never fetch

`src/providers/discovery.ts` resolves providers **filesystem-only** — read `PATH`, stat the
candidate, read a package's `bin` map. It does not shell out to `which`. The single
execution it ever performs is an optional `--version` probe of a path a *curated* descriptor
produced, with a 3 s deadline, a 4 KiB output cap, a scrubbed environment and `SIGKILL` on
timeout.

It also never runs `npx`. Several ACP agents ship as npm packages and the obvious
implementation — `npx -y @vendor/agent-acp` — downloads and executes an unpinned package
from the network on every launch. That is remote code execution wearing a package manager's
clothes. Juno resolves packages that are **already installed** (global npm/pnpm/bun/nvm
roots), confines the resolved `bin` path to the package directory so a manifest cannot point
at `/usr/bin/curl`, and otherwise reports the provider missing with an install line the user
chooses to run.

---

## 5. Providers, status and auth

`juno` is first-party and default. Every ACP provider is `authKind: 'cli-managed'` — **the
CLI holds its own credentials, Juno never sees, brokers, stores or proxies them.**

| Provider | `displayName` | Found via | ACP args | Agent licence | Auth |
| --- | --- | --- | --- | --- | --- |
| `juno` | Juno | built in | — | proprietary (first-party) | Juno account → backend proxy, server-side keys |
| `acp/claude-agent` | **Claude Agent** | npm `@agentclientprotocol/claude-agent-acp` | — | CLI proprietary; wrapper Apache-2.0 | user's own `claude` login |
| `acp/codex` | Codex | npm `@agentclientprotocol/codex-acp` | — | Apache-2.0 | user's own ChatGPT or API auth |
| `acp/gemini` | Gemini CLI | `gemini` on PATH, or npm `@google/gemini-cli` | `--acp` | Apache-2.0 | API key / Vertex / Standard-Enterprise (**see below**) |
| `acp/kimi` | Kimi CLI | `kimi` on PATH | — | Apache-2.0 + NOTICE; successor MIT | `kimi login` |
| `acp/opencode` | OpenCode | `opencode` on PATH | — | MIT | user's own provider config |
| `acp/goose` | goose | `goose` on PATH | — | Apache-2.0 | user's own provider config |
| `acp/qwen-code` | Qwen Code | `qwen` on PATH, or npm | `--acp --experimental-skills` | Apache-2.0 | user's own auth |
| `acp/github-copilot` | GitHub Copilot | `copilot` on PATH, or npm `@github/copilot` | `--acp` | proprietary | user's own Copilot seat |
| `acp/cursor` | Cursor | `cursor-agent` on PATH | — | proprietary | user's own Cursor account |
| `acp/amp` | Amp | `amp-acp` on PATH | — | Apache-2.0 (community wrapper) | user's own Amp account |

`acpArgs` are transcribed from the ACP registry, **not guessed**. The Claude and Codex
entries take no flag because those packages are ACP servers outright; binary-distributed
agents declare no extra flags in the registry either.

---

## 6. Legal and licensing — what Juno may and may not ship

Everything here turns on one distinction, and it is worth stating precisely because it is
the distinction the vendors themselves draw:

> **(a) Juno offering a vendor login as a Juno feature** — implementing the vendor's OAuth,
> storing or pooling vendor tokens, or surfacing the vendor's subscription rate limits
> inside Juno.
>
> **(b) The user's own already-authenticated CLI, on the user's own machine, driven as a
> subprocess** — the CLI holds its own credentials; Juno never sees them.

**Juno does (b) and never (a).** That posture is encoded in the code, not just this
document: every ACP descriptor is `authKind: 'cli-managed'` with `envPassthrough: []`, so
there is no code path by which a vendor credential reaches Juno; and
`discoverProvider` refuses to even look for a provider whose `legal.localCli` is
`prohibited`.

### Anthropic — the strictest, and the only one that names scenario (a) outright

**(a) is prohibited.** From <https://code.claude.com/docs/en/legal-and-compliance>, under
"Authentication and credential use":

> "Anthropic does not permit third-party developers to offer Claude.ai login"

The clause continues that third parties may not route requests through Free/Pro/Max plan
credentials on behalf of their users, and that Anthropic may enforce without prior notice.
The Agent SDK overview (<https://code.claude.com/docs/en/agent-sdk/overview>) states the
same rule with a carve-out:

> "Unless previously approved, Anthropic does not allow third party developers to offer
> claude.ai login"

…"or rate limits for their products, including agents built on the Claude Agent SDK".
Commercial Terms **§D.4** is the backstop: no reselling the Services except as expressly
approved (<https://www.anthropic.com/legal/commercial-terms>).

**(b) is not prohibited and is affirmatively documented.** The Agent SDK tells callers in
other languages to run the CLI as a subprocess; the headless docs describe an SDK host
closing the session as a supported case; and Anthropic's help centre (updated 2026-06-16,
<https://support.claude.com/en/articles/15036540>) states that Agent SDK, `claude -p` and
third-party app usage all draw from the user's own subscription limits — an explicit
acknowledgement that third-party apps run on user subscriptions.

Residual risk, not a prohibition: Consumer Terms §3(7) bars accessing the Services through
automated means "whether through a bot, script" except via API key **or where otherwise
permitted** — and Anthropic's own subprocess documentation is that permission. The legal
page also notes advertised limits assume ordinary individual usage, so Juno should not
encourage patterns that look like pooling.

**Trademark — actionable, and already applied.** The Agent SDK's branding guidelines
permit "Claude Agent" (explicitly "preferred for dropdown menus"), "Claude" inside a menu
already labelled Agents, and "{YourAgentName} Powered by Claude". They do **not** permit
**"Claude Code"** or **"Claude Code Agent"** for third-party integrations, nor Claude
Code-branded ASCII art or mimicking visuals; the product "should maintain its own branding
and not appear to be Claude Code". The umbrella policy is stricter still —
<https://www.anthropic.com/legal/trademark-guidelines> requires marks be used only as
specifically permitted and in materials approved beforehand. (Note `/legal/trademark`
404s; the guidelines live at `/legal/trademark-guidelines`.)

Juno's `displayName` for this provider is therefore **"Claude Agent"**, matching the name
the official ACP registry itself publishes for `claude-acp`. A regression test asserts no
provider's user-facing fields contain "Claude Code".

### OpenAI / Codex

The Codex CLI is **Apache-2.0** (`Copyright 2025 OpenAI`; `NOTICE` is attribution-only).
There is no consumer-tier resale clause; the biting terms are **Business Terms §3**
(<https://openai.com/policies/business-terms/>): no reselling or leasing account access,
no buying, selling or transferring API keys with a third party, no circumventing usage
limits. All key on credential and quota brokerage — precisely scenario (a).

Scenario (b) is not merely tolerated but designed for: OpenAI documents an **app-server
protocol** (JSON-RPC over stdio) whose page subtitle is "Embed Codex into your product",
and its own Codex SDK drives that app-server as a subprocess. The app-server even
documents a `chatgptAuthTokens` mode "intended for host apps that already own the user's
ChatGPT auth lifecycle" — a *more* invasive pattern than Juno's. A counterweight, phrased
as a recommendation and scoped to CI: use API-key auth for programmatic workflows.

**Naming is the real OpenAI risk.** <https://openai.com/brand/> bars OpenAI product,
service and model names from a third-party product name; even "Built using OpenAI API" is
listed as a *Don't*. "Codex" appears in no guideline on that page, so "works with Codex" is
genuinely unresolved. `brand.openai.com` is login-gated and could not be inspected.
Clearance route: partnercomms@openai.com. Note `openai.com/policies/terms-of-use/`
geo-redirects; the non-EEA text is at `/policies/row-terms-of-use/`.

### Google / Gemini CLI — permitted, but the entitlement is mostly gone

Apache-2.0, and Google ships first-party ACP (`packages/cli/src/acp/`), documented as
designed for programmatic control by IDEs and developer tools. The repo's
`docs/resources/tos-privacy.md` prohibits "**directly** accessing the services powering
Gemini CLI" via third-party software — "directly" is load-bearing, and the target is
token-lifting, not spawning Google's own signed binary.

**But**: per
<https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals>,
from **2026-06-18** consumer accounts stopped being served, this "applies to usage of
Gemini CLI", and users can no longer use Login with Google. Standard/Enterprise
subscriptions are unchanged. **Support Gemini CLI only for API-key, Vertex and
Standard/Enterprise users.** The gemini-cli repo README still advertises the dead free
tier with no deprecation notice; the developers.google.com page is authoritative.

**Do not integrate `google-antigravity/antigravity-cli`.** It is unlicensed
(`license: NONE`), a closed binary installed by `curl | bash`, and
<https://antigravity.google/terms> drops the word "Directly", barring "using third party
software, tools, or services to access the Service" outright. Hard no absent written
permission.

### Moonshot / Kimi

`MoonshotAI/kimi-cli` is **Apache-2.0 with a NOTICE file** that must be reproduced if any
of its code is shipped. It is winding down in favour of `MoonshotAI/kimi-code`, which is
**MIT** (© 2026 Moonshot AI) and ships `packages/acp-adapter` — retarget when its ACP
entrypoint stabilises. (The ACP registry records this agent as MIT, which matches the
successor rather than kimi-cli.)

The model-use agreement (<https://platform.kimi.ai/docs/agreement/modeluse>; note
`platform.moonshot.ai` now 301s there) **affirmatively grants** the right to "integrate the
Services into your own applications, products, or Services". §3.2(6)/§3.3(9) bar
sublicensing and API-key transfer, neither of which Juno does. No clause restricting which
client software may access the API was found as of 2026-08-12. The docs list custom ACP
client development as a use case, with an `AUTH_REQUIRED` flow that tells the client to
send the user to run `kimi login` — Juno's exact model, by design. No published brand
guidelines were found; Apache-2.0 §6 grants no trademark rights, so referential use only.

### OpenCode — cleanest, with one cross-vendor trap

**MIT** (© 2025 opencode). `sst/opencode` now redirects to `anomalyco/opencode`. The
hosted ToS (<https://opencode.ai/legal/terms-of-service>) carves out software "not provided
to you on a hosted basis" as governed by the repo's open-source licence, so a locally
installed opencode driven by Juno is MIT-only. ACP is first-class:
<https://opencode.ai/docs/acp/> describes `opencode acp` as an ACP-compatible subprocess
speaking JSON-RPC over stdio. No trademark policy exists (repo-wide grep for "trademark" is
empty).

**Trap.** OpenCode's own provider docs, regarding plugins that route Claude Pro/Max through
opencode, say Anthropic "explicitly prohibits this"; those plugins were unbundled in
opencode 1.3.0. **Juno must not surface, bundle or suggest that path** — it re-imports the
Anthropic restriction through a side door.

### Not verified

`acp/qwen-code`, `acp/github-copilot`, `acp/cursor` and `acp/amp` carry
`hostedLogin: 'unverified'`: their vendor terms were not reviewed as of 2026-08-12. Their
`localCli` stance follows the general principle that driving a user's own installed,
authenticated CLI is not a licensed act by Juno — but **review before promoting any of them
out of the "experimental" tier**. `acp/amp` in particular is a *community* wrapper, not a
vendor-published one: pin the version and treat updates as untrusted input.

### Blanket naming rule

Apache-2.0 §6 — the licence grants no permission to use trade names or trademarks — covers
Codex, Gemini CLI, Kimi and ACP alike. So, everywhere in Juno:

- Juno's own mark goes in the name slot; the generic capability goes in the tagline.
- Vendor names appear **referentially only** ("works with X", "for X"), never in a product
  or feature name.
- Ship an "independently developed; not affiliated with or endorsed by …" disclaimer
  wherever third-party agents are listed.
- Render `descriptor.displayName`. Never assemble a vendor name in the UI by hand.

---

## 7. Wiring notes for whoever integrates this

- **`src/providers/**` is not yet in any tsconfig `include`.** It belongs in
  `tsconfig.node.json` (it spawns processes and must never be reachable from the renderer,
  which `tsconfig.web.json` enforces by omitting `@types/node`). It type-checks clean under
  the project's full strictness — `strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes` — but nothing runs that check until the include is added.
- `AcpClient` currently advertises `clientCapabilities.terminal: false`. Flip it, and set
  `DEFAULT_HOST_CAPABILITIES.terminal`, only once `terminal/*` handlers exist — otherwise
  an agent will call a method that answers `-32601` mid-turn.
- `requireProvider` is the allowlist boundary. A provider id arriving over IPC from the
  renderer is untrusted; resolving it to a `LaunchCommand` any other way would let a
  compromised renderer choose the binary Juno spawns.

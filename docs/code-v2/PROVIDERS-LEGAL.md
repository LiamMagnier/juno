# Alevr Code v2: provider terms to re-verify before public release

Status: **engineering record, not legal advice.** It lists what the env server (`runner/env-server`) does with each vendor runtime, the assumption each integration relies on, and what someone must check against the vendor's current terms before Alevr Code ships to the public. Re-check every item at release time. Vendor terms change often, and nothing here was confirmed with a vendor.

## The principle the code follows

Alevr never reads, stores, forwards or refreshes a vendor credential, and never calls a vendor's inference API with one. For "bring your own subscription", the env server starts the **vendor's own agent runtime** (their CLI or SDK) on the user's machine, through the programmatic interface the vendor publishes. Sign-in, billing, rate limits and model access stay inside that runtime. Alevr is a client of it, the same way an editor extension is.

Consequences that the code enforces:

- It runs only where Alevr runs locally: the Mac app's sidecar, or `alevr-env` for development. The hosted web reaches a subscription only through the user's own Mac (device link, `DEVICE-LINK.md`). No Alevr server ever runs a vendor runtime for a user.
- Sign-in happens in a terminal the user runs themselves. `provider.setup` returns the vendor's own command, such as `codex login` or `claude` (`/login` inside it), typed but not submitted. Alevr never sees the OAuth flow.
- Each account gets its own vendor config dir (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) under `~/.alevr/env/homes/<instance>` only when the user adds a second account. The default instance uses the vendor's normal location, so it is the same login the user already has.
- Health probes cost nothing: Claude gets a never-yielding prompt plus `initializationResult()` and the usage endpoint, Codex gets `account/read`, `model/list` and `account/rateLimits/read`, and ACP gets `initialize` only. No probe spends a request from the user's allowance.
- User-facing names say whose subscription it is: "Claude (your subscription)" and "Codex (your ChatGPT plan)". Nothing presents a vendor product as Alevr's. A unit test asserts that no label says "Claude Code".

## Per provider

### Claude: `claude-agent` (Claude Agent SDK + the user's `claude` CLI)

- **Mechanism.** `@anthropic-ai/claude-agent-sdk` `query()` with `pathToClaudeCodeExecutable` pointing at the user's installed `claude` binary. Auth comes from that CLI's own login (claude.ai subscription or API key).
- **Assumption to verify.** That Anthropic's terms allow a third-party desktop app to drive the user's own Claude Code CLI through the Agent SDK while the user is signed in with a consumer subscription (Pro/Max), and to show that usage in the third-party UI. Anthropic's commercial and consumer terms and the Agent SDK's license and usage policy treat subscription logins differently from API keys. Confirm which one applies to a local, user-initiated session like this.
- **Branding.** Confirm the display name "Claude (your subscription)" and the "Claude" wordmark use against Anthropic's brand guidelines. We never say "Claude Code" in our UI as if it were ours.
- **Usage windows.** The probe reads `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`. By its name it may change or go away. The adapter treats a missing or failed result as "no windows", not as an error.
- **Bundling.** The SDK is an npm dependency of the env server (`0.3.295`, pinned). Check its license allows redistribution inside the signed Mac app bundle (esbuild `bundle:mac`).

### Codex: `codex` (`codex app-server`, JSON-RPC over stdio)

- **Mechanism.** It spawns the user's `codex app-server` and is a JSON-RPC client of it: `initialize`, `account/read`, `model/list`, `thread/*`, `turn/*` and approval server-requests. Auth is whatever `codex login` stored (ChatGPT plan or API key).
- **Assumption to verify.** That OpenAI's terms for ChatGPT plans and the Codex CLI license (Apache-2.0 for the CLI source) allow a third-party client to drive `codex app-server` for the signed-in user. The app-server protocol is documented for IDE integrations. Confirm it is not restricted to first-party or approved clients.
- **Path B, ChatGPT OAuth token sharing: disabled.** `CODEX_CHATGPT_TOKEN_SHARING.available = false` in `providers/codex.ts`. Alevr does not implement "Sign in with ChatGPT" itself and does not read `auth.json`. Enable it only with written confirmation from OpenAI. Even then, keep tokens inside the Codex runtime.

### ACP agents: `acp` (Agent Client Protocol over stdio)

The client is generic. Each preset runs the vendor's own binary:

| Preset | Command | What to verify |
|---|---|---|
| Gemini CLI | `gemini --acp` | Gemini CLI license (Apache-2.0) and Google's terms for the account type. Personal Google sign-in for Gemini CLI is being withdrawn (the setup step links Google's deprecation notice), and API key, Vertex AI and Code Assist seats each have their own terms. |
| Grok | `grok agent stdio` | xAI's terms for third-party clients of the Grok CLI and for subscription vs `XAI_API_KEY` use. |
| DeepSeek Harness | `dsh --profile acp` | The harness license (MIT at the time of the audit) and DeepSeek API terms (API key only). |
| OpenCode | `opencode acp` | OpenCode license (MIT) and the terms of whichever upstream provider the user signs it into. OpenCode can itself sign into other vendors' subscriptions, and those vendors' terms apply. |
| **Antigravity** | Google's official `antigravity-acp` runtime (`agy_acp_server.par` + `localharness_external`) | **Enabled by the owner on 2026-10-09** (the legal hold is lifted; see "Antigravity" below for what Alevr now does and the terms risk that remains). |

For every ACP preset, probes call `initialize` only. Sign-in runs in the vendor's own CLI, except Antigravity, whose own runtime runs Google's sign-in (below).

### Antigravity (enabled 2026-10-09)

The owner decided on 2026-10-09 to enable Antigravity as a normal provider, accepting the open terms question below. The code (`runner/env-server/src/providers/antigravity/`) follows T3 Code's approach (MIT):

- **Install.** `provider.install` downloads Google's release archive for this Mac from `dl.google.com`, at the URL the ACP registry lists, and refuses it unless its decoded size and SHA-256 match the release pinned in `release.ts` (registry commit dc55a349, recorded 2026-10-05). The zip must hold exactly the runtime and its harness at their pinned sizes; the extracted runtime must identify itself as `antigravity-acp` with Google sign-in and logout before `active.json` commits it. It lives in `~/.alevr/env/runtimes/antigravity-acp/<platform>-<arch>/`. A runtime the user installed by hand (on PATH, with `localharness_external` next to it) is used too. Alevr does not redistribute the runtime: every Mac downloads it from Google.
- **Sign-in.** `provider.auth start` runs the runtime's own `authenticate` with `oauth-personal`. The runtime listens on `127.0.0.1:<port>`; Alevr shows Google's authorization page (it suppresses the runtime's own browser launch with a one-line `BROWSER` helper and accepts only `https://accounts.google.com/o/oauth2/v2/auth` with a `127.0.0.1` redirect). A browser on the Mac finishes on the loopback directly. From another device the user pastes the address the page ended on (`provider.auth complete`); it is checked against this flow (same origin and path, one state, one code, Google as issuer) and forwarded once, without proxies or redirects. Flows expire after 5 minutes.
- **Credentials.** Each instance has its own profile (`GEMINI_HOME=~/.alevr/env/providers/antigravity/<sha256(instance id)>`, file token storage via `AGY_ACP_FORCE_FILE_STORAGE=1`), so a second Google account is a second instance. Alevr never reads, copies or sends the token file; it only checks that one exists. `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_*`, gcloud project variables and the runtime's own control variables are stripped from the user's shell and from instance overrides. Sign-out uses the runtime's own `logout`.
- **Probes and capabilities.** A probe calls `initialize` and stats the token file; it never authenticates or opens a session. Declared honestly: resume yes; steering, fork, conversation rollback (the runtime cannot rewind) and Alevr's plan mode no; images no (Alevr's ACP client sends text and file paths); Alevr's MCP (subagents) yes.

**Terms risk that remains.** Nothing here was confirmed with Google. Re-check before public release: (1) that Google's Antigravity terms and plan rules allow a third-party desktop app to run the official ACP runtime with the user's personal Google sign-in; (2) that downloading the runtime from Google's CDN on the user's behalf (not redistributing it) is acceptable; (3) Google's trademark rules for the "Antigravity" name and the Google mark in Connections. If any answer is no, set `legalHold` on the preset again (the mechanism is still in `presets.ts` and `registry.isEnabled`).

### Alevr engine and BYOK: `alevr`, `byok`

- `alevr` sends inference through Alevr's backend (`/api/agent/<lab>`) with the user's Alevr session, which the Mac app passes over `env.configure`, held in memory only. Usage is billed on the user's Alevr plan. Only Alevr's own provider contracts apply.
- `byok` uses the user's own API keys from `env.configure` (memory only, never written by the env server and never sent back on the wire, which a test checks). Each lab's API terms apply to the user's key. Confirm that our UI copy says usage goes to the user's own account with that lab.

## The Alevr MCP server injected into vendor sessions

The env server serves an MCP endpoint on 127.0.0.1 with a per-session scoped bearer. It is injected into Claude, Codex and ACP sessions and exposes `spawn_subagent` (on any instance, including another vendor's), `list/wait/cancel_subagent` and `search_threads`. The computer lane adds computer use. Verify:

- A vendor agent spawning a subagent on **another vendor's** runtime moves the user's task text from one vendor to another. The UI must make that visible: the subagent item names the instance. Confirm no vendor's terms forbid sending model output to a competing service on the user's behalf.
- MCP tool output from Alevr counts as user-provided content under each vendor's terms.

## Release checklist

1. Re-read the current terms for each row above, record the date and URL next to it in this file, and get sign-off.
2. Keep Codex Path B disabled unless step 1 says otherwise. Antigravity is enabled by the owner's decision of 2026-10-09; put it back on legal hold if step 1 finds its terms forbid this use.
3. Check vendor trademark use in labels, icons and marketing: "Claude", "Codex", "ChatGPT", "Gemini", "Grok", "DeepSeek", "OpenCode" and "Antigravity".
4. Confirm the licenses of bundled dependencies (`@anthropic-ai/claude-agent-sdk`, `ws`, `zod`, optional `node-pty`) for the Mac bundle.
5. Re-run `runner/env-server` tests. `presets: honest names…` guards the labels and Antigravity's empty env passthrough; `test/antigravity.test.ts` guards the install checks, the sign-in flow and the stripped credentials.

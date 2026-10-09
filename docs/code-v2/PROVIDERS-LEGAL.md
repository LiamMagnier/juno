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
| **Antigravity** | `antigravity-acp` (Google's official ACP runtime from the ACP registry) | **On legal hold.** It is off by default (`legalHold` in `providers/presets.ts`) and needs `enabled: true` in `~/.alevr/env/instances.json` or `ALEVR_ENABLE_LEGAL_HOLD=1`. Alevr does not download it. The setup step opens the registry entry and asks the user to check its SHA-256. Before lifting the hold, confirm that Google's Antigravity terms allow a third-party app to run the runtime with the user's Google sign-in, and that redistribution or auto-install is not allowed (we don't do either). |

For every ACP preset, probes call `initialize` only. Sign-in runs in the vendor's own CLI.

### Alevr engine and BYOK: `alevr`, `byok`

- `alevr` sends inference through Alevr's backend (`/api/agent/<lab>`) with the user's Alevr session, which the Mac app passes over `env.configure`, held in memory only. Usage is billed on the user's Alevr plan. Only Alevr's own provider contracts apply.
- `byok` uses the user's own API keys from `env.configure` (memory only, never written by the env server and never sent back on the wire, which a test checks). Each lab's API terms apply to the user's key. Confirm that our UI copy says usage goes to the user's own account with that lab.

### OpenRouter: `byok:openrouter` (the user's own OpenRouter key)

- **Mechanism.** BYOK only: Alevr never holds an OpenRouter key of its own and never bills OpenRouter usage. Requests go through `/api/agent/openrouter/chat/completions` on the user's sealed key to `https://openrouter.ai/api/v1`, with `HTTP-Referer: https://alevr.com` and `X-Title: Alevr` (OpenRouter's app attribution). The key is tested with `GET /api/v1/key`; the picker reads OpenRouter's public model list without a key.
- **Assumption to verify.** OpenRouter's terms for third-party apps sending requests on a user's key, and each upstream lab's terms for traffic routed through OpenRouter.

### Antigravity on the web (2026-10-09)

The owner turned Antigravity on ("enable antigravity"). The web lists it like any subscription and drives the runtime lane's managed install (`provider.install`) and sign-in (`provider.auth`) on the user's Mac. The sign-in is Google's own page; on the Mac its loopback redirect finishes by itself. From another device the user pastes the `http://localhost:<port>/…?code=…` address the browser ended on, and the web sends it to the Mac through the device link, so **that one-time authorization code transits Alevr's relay** (memory only, never logged or stored, and only a loopback URL with a `code` or `error` is accepted). Confirm with Google's terms that this paste-back path is acceptable, or drop it and keep the Mac-only loopback.

## The Alevr MCP server injected into vendor sessions

The env server serves an MCP endpoint on 127.0.0.1 with a per-session scoped bearer. It is injected into Claude, Codex and ACP sessions and exposes `spawn_subagent` (on any instance, including another vendor's), `list/wait/cancel_subagent` and `search_threads`. The computer lane adds computer use. Verify:

- A vendor agent spawning a subagent on **another vendor's** runtime moves the user's task text from one vendor to another. The UI must make that visible: the subagent item names the instance. Confirm no vendor's terms forbid sending model output to a competing service on the user's behalf.
- MCP tool output from Alevr counts as user-provided content under each vendor's terms.

## Release checklist

1. Re-read the current terms for each row above, record the date and URL next to it in this file, and get sign-off.
2. Keep Antigravity on legal hold and Codex Path B disabled unless step 1 says otherwise.
3. Check vendor trademark use in labels, icons and marketing: "Claude", "Codex", "ChatGPT", "Gemini", "Grok", "DeepSeek", "OpenCode" and "Antigravity".
4. Confirm the licenses of bundled dependencies (`@anthropic-ai/claude-agent-sdk`, `ws`, `zod`, optional `node-pty`) for the Mac bundle.
5. Re-run `runner/env-server` tests. `presets: honest names…` guards the labels and the legal hold.

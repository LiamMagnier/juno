# Account MCP tools and project hooks in Code runtimes

The Alevr engine in env-server and the cloud Code driver load enabled account MCP servers through `/api/mcp/session`. Web Chat continues to use the same canonical configuration and existing dispatcher. The engine receives tool schemas and results. Provider tokens, user server URLs and Authorization headers remain on the application server.

Every call resolves the current owner, enabled rows and account blocks again, then passes through `openMcpToolset`. Its approval rules, consequential-action floor, idempotent receipts, audit and SSRF-safe transport remain in front of the remote call. Local command permissions also apply. Unattended cloud calls carry their task identity; terminal tasks and invalid task tokens are refused. An account fingerprint binds each tool catalog to the signed-in account, so a native token refresh that changes accounts cannot spend the new account's credentials using an old catalog.

Discovery is bounded, failed clients close, redirects are refused, request/response streams have size ceilings, and failures expose fixed messages. A removed server stops resolving on the next call, including within an existing engine session. Newly enabled servers appear when the session is opened again. Subscription runtimes still receive their existing local Alevr MCP endpoint; this change adds account tools to Alevr's own engine and its BYOK engine.

## Project hooks

Agent-core reads `.alevr/hooks.json` before each ordinary tool execution, including child tools, and at root turn settlement. The file must be a regular file inside the workspace, at most 32 KB. The versioned format is strict:

```json
{
  "version": 1,
  "hooks": {
    "PreToolUse": [{ "matcher": ["write_file", "edit_file"], "command": "npm run check-policy", "timeoutMs": 10000 }],
    "PostToolUse": [{ "matcher": ["write_file", "edit_file"], "command": "npm run lint", "timeoutMs": 30000 }],
    "Stop": [{ "command": "npm run verify", "timeoutMs": 60000 }]
  }
}
```

Matchers are exact tool names or `*`; omitted matchers apply to every tool. Commands run sequentially, with a default 10-second and maximum 60-second timeout. They receive bounded JSON through `ALEVR_HOOK_CONTEXT`: event, tool, call id, agent id, input, and the result when available. Large inputs use a truncated preview. Output appears in the command event, rather than becoming model instructions. Commands use the normal scrubbed environment, process-group cancellation and container confinement. They cannot change the underlying tool's arguments or permission decision. A failing PreToolUse blocks the tool; a failing PostToolUse preserves the actual tool output and reports failure; a failing Stop marks the turn failed. Stopping a run does not start another Stop command.

An exact SHA-256 of the configuration is reviewed outside the clone. A new or changed configuration always requires a person, including Full access and model auto-review mode. A file changed during review runs nothing. “Accept for session” remembers that configuration hash for the current session, but shell deny/ask rules, Plan mode and sensitive-action approvals still apply. The hash pins configuration bytes, including command text; scripts invoked by those commands remain workspace files. The host can supply account/repository-scoped reviewed hashes through `AgentOptions.hooks.trustedHashes`; repository files cannot grant themselves trust. `hooks: false` disables project hooks.

The env-server approval adapter explicitly keeps hook trust requests pending when Full access is selected. The unattended cloud callback refuses unreviewed hooks. A product UI for editing the file and storing owner-reviewed hashes for later cloud runs still needs the reserved `/code/customize` integration after Claude's Code wave 1 merge. This runtime phase does not claim that editor or persistent cloud trust storage is complete.

## Verification boundary

Focused tests exercise the real server dispatcher with a stub remote MCP server, refusal before the network sink, audit, removed/blocked/foreign servers, account switching, bounded streams and discovery cleanup. Agent-core tests run real temporary hook commands and full AgentSession turns, plus permission and sandbox regression suites. Env-server wire tests verify tool injection and a human trust prompt that Full access cannot answer automatically. These tests do not establish live third-party MCP acceptance, a released Mac bundle, or an actual hosted cloud task using the new bridge.

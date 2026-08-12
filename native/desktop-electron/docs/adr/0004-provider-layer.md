# ADR-0004 — The provider layer is ACP-first

**Status:** Accepted · 2026-08-12

## Context

The brief (§13) asks for a capability-driven adapter layer over OpenAI Codex,
Claude Code, Kimi Code, OpenCode and future providers, and explicitly says to
investigate each vendor's current officially supported integration mechanism
rather than assume one — and not to screen-scrape terminal output where a
structured protocol exists.

Research on 2026-08-12 found that the question has largely been answered by the
industry already.

## Finding

The **Agent Client Protocol (ACP)** — JSON-RPC 2.0 over stdio, newline-delimited
UTF-8, Apache-2.0, spec `v1.6.0` / `schema-v1.20.0` — has a live registry of
~38 agents, including **first-party ACP modes from Anthropic (Claude), OpenAI
(Codex), Moonshot (Kimi), OpenCode, Cursor, Google (Gemini CLI) and GitHub
Copilot**. Editor clients include Zed, JetBrains, Visual Studio, VS Code, Neovim
and Emacs. There are five official SDKs.

The Claude and Codex adapters name Anthropic and OpenAI as co-authors.

## Decision

**One ACP client is the primary adapter**, with capabilities negotiated at
`initialize` rather than hardcoded per vendor. Juno's own backend-proxied
provider (`runner/agent-core/src/providers/proxy.ts`, server-side keys, no local
CLI) remains the first-party path and needs no ACP.

Per-vendor adapters are written only where ACP genuinely cannot express
something.

## Consequences

**Good**

- Five providers for roughly the cost of one, and new ACP agents work without a
  Juno release.
- Capability-gating becomes honest: the UI reflects what `initialize` actually
  negotiated instead of a table someone maintained by hand.
- No terminal screen-scraping anywhere.

**Bad / risks**

- **Governance is not vendor-neutral.** ACP is jointly controlled by Zed and
  JetBrains under a two-person BDFL model, "working toward an independent
  foundation" with no timeline.
- **ACP v2 is drafted and removes the client-side `fs/*` and `terminal/*` APIs
  entirely** (agents use MCP instead). Mitigation: implement v1, negotiate the
  version at `initialize`, and keep fs/terminal handlers behind an interface.
- Kimi's ACP entry is being wound down in favour of `MoonshotAI/kimi-code`.
  Capability-gate; do not assume continuity.
- Codex's richer `app-server` is documented by OpenAI as **"not supported for
  production workloads"**. It is an opportunistic upgrade behind capability
  detection; `codex exec --json` is the stable path.

**Two capabilities ACP does not cover**

- **Computer Use** — no agent exposes it. Entirely a host responsibility.
- **Worktrees** — not a protocol concept anywhere. Every agent accepts a `cwd`,
  so Juno creates the worktree and points the agent at it. Portable across all
  providers, and `agent-core`'s `SubagentManager` already works this way.

Both are marked in the capability manifest as *host-provided* rather than
*unavailable*, and the type distinguishes the two.

## Blocking legal question

Anthropic's documentation states that third-party developers may not offer
claude.ai login or rate limits in their products — including agents built on the
Claude Agent SDK, and including via the ACP adapter — without prior approval,
and that third parties may not use the name "Claude Code" (the permitted term is
"Claude Agent"). OpenAI's position on ChatGPT-OAuth in third-party apps is
unresolved.

There is a real distinction to respect: **Juno offering "Sign in with Claude" as
a feature** is restricted; **driving the user's own already-authenticated local
CLI on their own machine** is a different act. Which of these Juno ships is a
product-owner decision, not an engineering one.

The provider layer is therefore built so that a provider can be **disabled by
configuration without code changes**, and no provider is enabled by default
until this is resolved. Tracked in STATUS.md.

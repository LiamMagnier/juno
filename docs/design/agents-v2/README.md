# Agents v2

Making Juno's Agents a real product: each agent gets its own computer on the owner's
server (watch it, take over), is configured by talking to it, and lives in a condensed, thread-first UI.

| File | For |
|---|---|
| [AUDIT.md](AUDIT.md) | The owner: Juno Agents vs Grok Bot, Meta Muse, OpenMuse. Where Juno is weaker and what's missing |
| [RULES.md](RULES.md) | The implementer: binding rules, security invariants, gates, traps |
| [INFRA.md](INFRA.md) | The implementer (and the owner's one-time server setup): agent computers as Docker desktops on the owner's own server, firewall, live-view relay |
| [BRIEF.md](BRIEF.md) | The implementer: decisions, architecture, phases, final report |
| [PROGRESS.md](PROGRESS.md) | Everyone: the live checklist; resume from here |
| [PROMPT.md](PROMPT.md) | The owner: the message to paste to the implementer (Gemini 3.8 Flash) |

Written 2026-09-26 by Claude (mentor). Implemented by Gemini 3.8 Flash on branch
`agents/v2` in the worktree `../juno-agents`.

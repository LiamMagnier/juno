# Skills: what Claude and ChatGPT do, and what Juno does about it

**Audited September 2026.** Sources are linked inline. This document exists because Juno
already had a skills system — a good one, with a permission model neither vendor ships — and
it was wired to exactly one surface. The audit answers two questions: what the two reference
implementations actually do, and which of it Juno should adopt rather than admire.

---

## 1. Claude

### 1.1 The artefact

A skill is a **directory** whose entry point is `SKILL.md`: YAML frontmatter, then a Markdown
body. The frontmatter is the discovery record; the body is the method.

```markdown
---
name: pdf-processing
description: Extract text and tables from PDF files, fill forms, merge documents. Use when
  working with PDF files or when the user mentions PDFs, forms, or document extraction.
---

# PDF Processing

## Quick start
…
```

The [Agent Skills specification](https://agentskills.io/specification) — published by
Anthropic and adopted by OpenAI — permits exactly six frontmatter keys, and validation
**fails** on anything else:

| Key | Required | Bound | What it is |
| --- | --- | --- | --- |
| `name` | yes | ≤ 64 chars, `[a-z0-9-]`, no XML tags, cannot contain "anthropic"/"claude" | the slash name and the directory name |
| `description` | yes | ≤ 1024 chars, non-empty, no XML tags | what it does **and when to use it** |
| `license` | no | — | a licence name or the filename holding one |
| `compatibility` | no | ≤ 500 chars | environment requirements, as prose |
| `metadata` | no | string → string map | a bag for anything the spec does not define |
| `allowed-tools` | no | — | pre-approved tools (marked experimental) |

Claude Code reads a [much wider set](https://code.claude.com/docs/en/skills) on top of that —
`disable-model-invocation`, `user-invocable`, `paths`, `context: fork`, `agent`, `model`,
`effort`, `hooks`, `argument-hint` — and its own packaging script **rejects** those keys when
you package a skill for distribution. So there are two frontmatter vocabularies: the portable
one above, and a host-specific superset. A reader that accepts the superset and ignores what
it does not know is compatible with both; a reader that rejects unknown keys is compatible
with neither in practice.

### 1.2 Progressive disclosure — the part that actually matters

Anthropic's [overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)
describes three levels, and the level structure is the whole design:

| Level | Loaded | Cost | Content |
| --- | --- | --- | --- |
| 1 — metadata | always, at startup | ~100 tokens per skill | `name` + `description` |
| 2 — instructions | when the skill is triggered | under 5k tokens | the `SKILL.md` body |
| 3+ — resources | when a file is actually read | nothing until then | bundled files; scripts contribute only their *output* |

The consequence is the reason to copy it: **you can install a hundred skills without paying
for ninety-nine of them.** Until a skill fires, it costs one line of a system prompt. A design
that loads every installed skill's instructions up front does not scale past about five, and
the failure is invisible — it shows up as cost and as dilution, not as an error.

Level 3 is filesystem-and-bash: Claude `cat`s the file it needs. That half is not portable to
a chat product with no VM, and Juno should not pretend otherwise (see §4.3).

### 1.3 Invocation

Two routes, and the distinction between them is load-bearing:

- **Automatic** — the model matches the request against the `description` and decides. This is
  why the spec insists the description say *when* to use the skill and not only what it does.
- **Explicit** — the user types `/skill-name`, optionally with arguments. Claude Code allows
  up to six stacked in one message.

`disable-model-invocation: true` makes a skill user-only; `user-invocable: false` makes it
model-only. Both exist because the two routes have genuinely different risk profiles.

### 1.4 Distribution

Four channels, only one of which is a package registry:

- **Filesystem** — `~/.claude/skills/<name>/SKILL.md` (personal), `.claude/skills/…`
  (project, discovered up to the repo root), `<plugin>/skills/…`, enterprise-managed.
- **Plugin marketplaces, which are GitHub repos.** `/plugin marketplace add anthropics/skills`
  then `/plugin install document-skills@anthropic-agent-skills`. The marketplace *is* the
  repository; there is no publishing step and no registry in between.
- **claude.ai** — a zip upload, per-user, synced down to `~/.claude/skills/synced/`.
- **API** — `/v1/skills`, workspace-scoped, run inside the code-execution container.

Two details worth stealing. First, **a GitHub repo is the unit of distribution**, which means
an importer needs to handle "a repo containing many skills", not "a URL pointing at one file".
Second, **synced skills are deliberately weakened**: shell substitution (`` !`cmd` ``) does not
run and `@` file references do not resolve for a skill that arrived from the network. The
lesson is that a skill's *origin* changes what it is allowed to do, not merely what badge it
wears.

### 1.5 The security posture, stated plainly

Anthropic's own documentation is blunt: *"Use Skills only from trusted sources… a malicious
Skill can direct Claude to invoke tools or execute code in ways that don't match the Skill's
stated purpose."* The enumerated risks are tool misuse, data exfiltration, and skills that
fetch external content which then carries instructions. The mitigations offered are **audit it
yourself**, plus content scanning for Enterprise — and the scanning explicitly does not cover
skills uploaded through the API or the Console.

That is an honest warning rather than a mechanism. It is the gap Juno's model already fills.

---

## 2. ChatGPT / OpenAI

### 2.1 The same artefact

OpenAI adopted the same open spec: a skill is a folder with a `SKILL.md`, YAML frontmatter
with `name` and `description`, and Codex discovers them from `.agents/skills` locations. The
[skills catalog](https://github.com/openai/skills) is a public GitHub repo; installation is
`$skill-installer install https://github.com/openai/skills/tree/main/skills/…` — a **tree
URL**, pointing at a directory inside a repo at a ref. Codex is then restarted to pick it up.

OpenAI's documentation names only `name` and `description` as fields Codex reads, and there is
[an open issue](https://github.com/openai/skills/issues/187) asking it to accept
`compatibility` for consistency with the spec. `allowed-tools` restricts a skill to specific
tools.

### 2.2 Where it diverges: packaging and the UI half

The [Apps SDK](https://openai.com/index/introducing-apps-in-chatgpt/) is a different thing that
lives next door. An app is an **MCP server** defining tools, plus an optional React UI rendered
in a sandboxed iframe inside the conversation. In July 2026 the App directory became the
**Plugin** directory, and a plugin now bundles *skills, apps and app templates* together —
OpenAI ships role-specific plugins (Data Analytics, Sales, Investment Banking, …) containing
both. Apps do not work inside Custom GPTs.

So OpenAI's answer to "how does a capability reach a user" is: a plugin, which may contain
instructions (skills) and executable surface (MCP apps) in one unit. Custom GPTs — the 2023
answer, a name plus instructions plus files — are the legacy branch, and the fact that the
Apps SDK never reached them tells you which way the platform is going.

### 2.3 The scorecard

Claude handles skills better, and specifically in three places:

1. **Progressive disclosure is explicit and documented with numbers.** OpenAI's skills load
   from frontmatter the same way, but the level structure is not the organising idea it is at
   Anthropic, and the token accounting is not published.
2. **Origin governs behaviour, not just presentation.** Claude Code neuters shell substitution
   in a synced skill. Nothing equivalent exists on the OpenAI side.
3. **Distribution is repo-native and multi-skill.** `/plugin marketplace add owner/repo` treats
   the repository as the unit; the OpenAI installer takes a URL to one directory.

Where OpenAI is ahead: a plugin can carry a **UI**, and skills-plus-MCP-in-one-unit is a
cleaner mental model than Claude's split between skills, MCP servers and plugins.

Where **both** fall short, and Juno already does not: neither treats a skill's declared tool
list as a *request to be intersected*. `allowed-tools` is a narrowing convenience inside a
session the user has already authorised. Neither ships an untrusted-content envelope around
third-party instructions. Anthropic tells you to audit the skill yourself; OpenAI does not
raise the question. Juno's `resolveSkillPermissions` and `skillSystemSuffix` are, as far as
this audit found, ahead of both.

---

## 3. What Juno already had

`src/lib/work/skills.ts` predates this work and is not changed by it in substance. Its
load-bearing parts:

- **Versioning.** `WorkSkill` is stable identity; every edit mints a `WorkSkillVersion`. A run
  records the exact version, so "which skill ran" survives later edits.
- **Request, never grant.** A version declares `requestedTools` and a contract of requested
  connectors/apps/domains/policy/budget. `resolveSkillPermissions` **intersects** it with the
  grant layers, and `narrowestGrant` refuses an empty layer list explicitly, because the
  intersection of no sets is everything.
- **Trust as a gate on automatic selection.** `untrusted` (where an import lands) →
  `user_authored` → `verified`. A client may never set `verified`. Untrusted blocks *automatic*
  selection only; the user can still type the name, because they typed the name.
- **The untrusted envelope.** `skillSystemSuffix` puts an unvouched-for skill's instructions
  inside `wrapUntrusted` markers with a narrowing that grants it exactly one thing — method —
  and nothing else.
- **A deterministic scanner.** `scanSkillVersion` produces `clear | warning | blocked` plus a
  `permissionFingerprint`, so a version that widens its permission surface is visible.

What it did **not** have: any presence in chat, and any way in other than typing or pasting.

---

## 4. What Juno does now, and why each choice

### 4.1 Skills reach the chat composer

The gap was that the whole apparatus served one surface. A skill is "instructions with a name",
which is at least as useful in a chat turn as in a delegated run.

`src/lib/chat/skills.ts` is the adapter, deliberately pure and deliberately thin. It reuses
`selectSkillBySlug`, `resolveSkillPermissions` and `skillSystemSuffix` rather than
re-implementing any of them — a second copy of the intersection is exactly the bug the module
header of `work/skills.ts` warns about.

Two decisions worth stating:

**The chat grant layer is what the turn actually has.** `chatSkillGrantLayer` is built from
the live turn — the connectors attached to this chat, whether web search is on for this model
and plan, whether canvas is available, whether the attachment tools are attached. A skill
asking for `web_search` on a turn with search off gets it withheld and the user is told, which
is the same failure mode the Work runtime already has and the same reason: a skill doing three
of the five things it promised is otherwise indistinguishable from one that promised three.

**A chat skill is armed explicitly, never inferred from the text.** The route reads a
`skillSlug` field; it does **not** parse a leading `/slug` out of the message. `/` in the
composer opens the palette, picking a skill strips the token and raises a pill the user can
see and dismiss. The reason is that a message which silently becomes a skill run because it
started with a slash is a surface where pasted text picks up instructions nobody chose — and
the composer is where people paste things.

The consequence that falls out for free: when an untrusted skill is applied,
`untrustedContentInTurn` becomes true, so the untrusted-content rule enters the system prompt
(without it, the envelope markers would be present and ungoverned) and the turn may not write
durable memory. Both are existing rules; neither needed a special case.

### 4.2 Skills can be imported from a GitHub repo

Claude's model — the repo *is* the marketplace — is the one worth copying, and it is what
people already have: the skill they want is in a repo, in a folder, next to twenty others.

`src/lib/skills/skill-md.ts` parses the artefact. It accepts the full Agent Skills spec
frontmatter plus the Claude Code superset, and **ignores** unknown keys rather than failing,
per §1.1: a reader that rejects the superset cannot read a skill written for Claude Code, and
those are most of the skills that exist.

`src/lib/skills/github.ts` resolves the source. It accepts the forms people actually hold —
`owner/repo`, a repo URL, a `tree` URL at a ref and a path, a `blob` URL straight to a
`SKILL.md` — walks the repository tree once, and returns every skill it found. Preview is a
separate step from import: the reader sees what is in the repo, with the description each skill
matched on, and chooses.

Imported skills land `untrusted`, which is `trustForOrigin("imported")` and not a new rule.
Their instructions go through `scanSkillVersion` like any other version, and their provenance —
repo, ref, commit SHA, path — is recorded on the contract so "where did this come from" has an
answer after the fact.

### 4.3 What was deliberately not copied

> **Update, 2026-10-02 (tool runtime, lane L3 `rf/tools-L3-skill-workflows`, not landed).** The
> first and second bullets below are reversed in code, behind the design in
> [docs/rework/TOOL_RUNTIME_DESIGN.md](rework/TOOL_RUNTIME_DESIGN.md) §6.8, on the owner's resume
> of the tool-call rework ([TOOL_CALL_REWORK.md](rework/TOOL_CALL_REWORK.md): "use skills and
> their referenced workflows"). A skill's folder is now kept as a scanned, content-addressed
> bundle (`src/lib/skills/bundle.ts`: at most 200 files and 5 MB, symlinks and `..` paths
> refused); an imported bundle with scripts waits for consent; scripts run only inside the
> no-network sandbox (`run_code`, mounted read-only at `/skills/<slug>`), never widening the
> turn. Automatic discovery in chat is the `use_skill` tool, offering only skills the person
> opted in to automatic use (design §9.3 keeps "every user-authored skill too" as the owner's
> switch). The design's §9.2 still lists the reversal as an owner decision: until the owner
> confirms it, nothing reaches production (the lane is not landed and production has no
> execution host). The text below is kept as the reasoning that held before.

- **Level 3 (bundled files, executable scripts).** Juno has no per-skill VM in chat, and a
  skill's files already have a home: `resourceAttachmentIds`, the author's own uploads, reaching
  the model inside the envelope. A `scripts/` directory imported from a stranger's repo and run
  anywhere is the exfiltration shape Anthropic's own warning describes. The importer reads
  `SKILL.md` and records what else the folder held; it does not fetch or execute it.
- **Automatic selection in chat.** The machinery exists (`selectSkillAutomatically`, threshold
  0.75) and is not wired to chat in this pass. Explicit invocation first, because the cost of
  the wrong skill in a chat turn is an answer that quietly followed somebody else's method.
- **`allowed-tools` as an allowance.** It is read and mapped onto `requestedTools`, which is
  a request. The name is why: a field called `allowedTools` on a row a user can import reads
  like an allowance and somebody eventually treats it as one.

---

## Sources

- [Agent Skills — Claude Platform Docs](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)
- [Use Skills in Claude Code](https://code.claude.com/docs/en/skills)
- [Equipping agents for the real world with Agent Skills — Anthropic Engineering](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
- [anthropics/skills](https://github.com/anthropics/skills) — the skills repository and its `spec/`
- [Agent Skills specification](https://agentskills.io/specification)
- [openai/skills](https://github.com/openai/skills) — the Codex skills catalog
- [Build skills — OpenAI Codex docs](https://developers.openai.com/codex/skills)
- [Allow "compatibility" property in frontmatter — openai/skills#187](https://github.com/openai/skills/issues/187)
- [Introducing apps in ChatGPT and the new Apps SDK — OpenAI](https://openai.com/index/introducing-apps-in-chatgpt/)
- [Developers can now submit apps to ChatGPT — OpenAI](https://openai.com/index/developers-can-now-submit-apps-to-chatgpt/)

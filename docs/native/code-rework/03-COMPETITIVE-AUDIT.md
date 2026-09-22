# Juno Code: competitive audit

Date: 2026-09-22. Sources: the five sourced research files in `research/` (Claude
Code, OpenAI Codex, Google Antigravity, Cursor, and Windsurf/Devin, Zed, Copilot,
Amp, Factory, Warp, Cline, Junie, Conductor). Every claim there carries a URL and
a date; this file is the synthesis and the decisions it drives.

## 1. Where the category is in September 2026

- **The agent is the app; the editor is optional.** Codex is now a mode of the
  ChatGPT desktop app; Claude has a Code tab; Antigravity 2.0 dropped the IDE;
  Cursor built the Agents Window "from scratch, centered around agents"; Zed,
  VS Code and JetBrains all added a threads-first surface. A native Mac agent
  workspace — what Juno Code is — is the mainstream shape, not a niche.
- **Everyone converged on the same bones.** Sidebar of sessions grouped by
  project; a centre thread; a composer with model · effort · mode · environment;
  a right-hand panel for changes/terminal/preview; one worktree per task.
  Differentiation has moved to *quality*: how quiet the thread is, how good
  review is, how few prompts a safe agent needs.
- **Permissions converged too.** `allow / ask / deny` rule lists with patterns
  (`Bash(npm run *)`, `Edit(src/**)`, `WebFetch(domain:…)`, `mcp__server__*`),
  deny wins, chained commands checked per segment, "always allow" on the prompt
  itself, and a sandbox that lets most commands run without asking.
- **Summary first, detail on demand.** Codex: "Edited 3 files, explored 2 files,
  2 searches". Claude Code: "Read 3 files" (present tense while running, past
  when done). Cursor: "Explored 1 file, 1 search", "Worked for 1m 8s", a
  `Review +34 −7` pill, and a *Tool Call Density* setting. Antigravity: "13 files
  changed +1430 −92 › Review". Nobody shows raw tool ids.

## 2. Table stakes (what Juno must have)

| Capability | Claude Code | Codex | Cursor | Antigravity | Juno before | Juno now |
|---|---|---|---|---|---|---|
| Threads grouped by project, status per row | ✓ | ✓ | ✓ | ✓ | partial | ✓ |
| Centred composer landing, project + env pickers | ✓ | ✓ | ✓ | ✓ | cluttered | ✓ |
| Collapsed activity rows, past-tense summaries | ✓ | ✓ | ✓ | ✓ | partial | ✓ |
| Streaming text + a quiet "working" state | ✓ | ✓ shimmer | ✓ | ✓ | ✓ | ✓ |
| Steer (Enter) vs queue while running | ✓ | ✓ setting | ✓ setting | ✓ | ✓ hidden | ✓ |
| Inline approval: once / always (rule) / deny + redirect | ✓ | ✓ | ✓ | ✓ | once only | ✓ |
| Persistent allow/ask/deny rules, layered files | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ |
| Review pane: per-file/per-hunk, comments to agent | ✓ | ✓ | ✓ | ✓ | ✓ buried | ✓ |
| Commit / push / PR from the thread | ✓ | ✓ | ✓ | ✓ | buried | ✓ |
| Prompt caching, thinking continuity | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ |
| Compaction that survives one long request | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ |
| Paged file read, head+tail command output | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ |
| Web fetch | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ |
| User + project instruction files | ✓ | ✓ | ✓ | ✓ | project only | ✓ |
| Notifications: done / needs you | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ |
| Dedicated settings with full customisation | ✓ | ✓ | ✓ | ✓ | scattered ×4 | ✓ |
| Worktree per task | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| MCP, hooks, skills, custom agents | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Checkpoint rewind (code + conversation) | ✓ | fork | ✓ | ✓ | per-file | per-file (next) |
| LLM-written compaction summary | ✓ | ✓ | ✓ | — | ✗ | structural (next) |

## 3. Best-in-class ideas adopted, and where they came from

- **Approval that teaches the rules** — Claude Code / Codex: *Yes · Yes, and
  don't ask again for `npm run *` · No, and tell it what to do instead*. Juno
  shows the exact rule an "Always" would save, and writes it to
  `.juno/settings.local.json` (Claude Code's pattern, personal and git-ignored).
- **Deny wins, per segment** — Zed / Junie: `npm test && rm -rf ~` is only as
  trusted as its worst part.
- **Destructive stays human** — Factory's "blocklist that can never run" and
  Claude Code's protected paths: in Juno no rule can silence an action that
  leaves the granted folder.
- **Summary rows with honest verbs** — Claude Code's tense switch, Codex's
  clause list, Cursor's density.
- **One turn footer** — Cursor's `Review +34 −7`, Antigravity's changed-files
  card, Claude's "Worked for 1m 6s": Juno ends each run with *Worked for 2m 14s ·
  3 files · +34 −7 · Review*.
- **Settings as files and as a window** — Claude Code's layered JSON plus
  Codex's and Cursor's sectioned settings screens. The window edits the same
  files a reader can open in their editor.
- **Remote is capped** — Copilot/Warp remote control, but with Juno's rule that
  anything acting while nobody is at the Mac gets at most the *remote ceiling*
  (default: ask before changes).

## 4. Deliberately not copied

- **Classifier-driven "auto" modes** (Claude Code auto, Cursor auto-review,
  Codex auto_review). They need a second model per action and a server-side
  policy we do not run. Juno's sandbox + rules give most of the prompt
  reduction; revisit with a Haiku-class reviewer later.
- **Whimsical spinner verbs** — a Claude signature, not ours, and the anti-slop
  rules ban decoration that is not information.
- **Removing the editor entirely** (Antigravity 2.0). Readers asked for inline
  editing in its forums; Juno keeps the file editor behind the review pane.
- **A separate "Agents Window"** (Cursor). One window, one sidebar.

## 5. Settings information architecture (synthesised)

Codex (General, Personalization, Git, MCP, Worktrees, Keyboard, Notifications,
Appearance), Cursor (Agents → Approvals & Execution, Git & PRs, Worktrees,
Appearance density), Claude Code (permissions, sandbox, memory, model, git
attribution, hooks, output style) and Antigravity (General/permissions,
Customizations, Models, Appearance) reduce to this, which is what Juno ships:

1. **General** — default mode, default model & effort, where new sessions run,
   follow-up behaviour (steer / queue), send key, keep Mac awake while running.
2. **Permissions** — allow / ask / deny rules per scope (all projects, project
   shared, project personal), remote ceiling, what the modes mean.
3. **Environment** — network access, environment variables, extra writable
   folders, sandbox status.
4. **Instructions** — personal `~/.juno/JUNO.md`, standing instructions per
   scope, which project files are read.
5. **Agent** — max turns per run, auto-compact and threshold, model fallback,
   sub-agents.
6. **Git** — co-author trailer, branch prefix, worktree location.
7. **Tools & MCP** — servers per project, enable/disable, hooks trust, skills,
   custom agents.
8. **Appearance** — transcript density, show reasoning, code font size, diff
   layout, wrap lines.
9. **Notifications** — when done, when it needs you, sound, only when in
   background.
10. **Keyboard** — every shortcut, read-only reference.
11. **Advanced** — open settings files, reveal session store, reset.

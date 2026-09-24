# Artifacts & Design — audit, competitive audit and merge plan

September 2026. The owner asked for three things, in order:
1. A full audit of Artifacts and Juno Design on the website and macOS.
2. An audit of how Claude and Figma handle artifacts, design, UI/UX and motion.
3. A plan to merge Artifacts and Design the way Anthropic merged Claude chat, Cowork and Artifacts on 16 Sept 2026.

This folder is the record of all three. It changes no product code.

## Read in this order

| Doc | What it is |
|---|---|
| `00-AUDIT-OVERVIEW.md` | **Start here.** The Juno audit across web, Mac and iPhone: 33 verified defects (X-01…X-33), a map of the ~10 separate systems Juno uses for "made things", the scorecard, strengths to keep, and the preconditions for a merge (§12). |
| `01-AUDIT-WEB.md`, `02-AUDIT-MAC.md` | The web and Mac audits in full, with file:line evidence and verification status. |
| `03-COMPETITIVE-AUDIT.md` | Claude (the artifact platform, Claude Design, the 16 Sept merge with Docs and Slides, UX and motion) and Figma (the editor, prototyping and motion, the AI product family, files and sharing). It has a feature matrix of Juno vs Claude vs Figma, patterns worth adopting, motion specs in Juno tokens, and what not to copy. |
| `04-MERGE-PLAN.md` | **The plan.** "The conversation is where things are made. The artifact is what you keep. Design is a type, not a place." It covers the object model, data model and migrations, IA, routes, the unified artifact view (with wireframes), the AI editing loop, sharing and governance, motion, the fate of Work deliverables, telemetry, a dated release train, risks, and owner decisions (§14). |
| `05-IMPROVEMENTS.md` | Every defect and all 101 improvements, placed in the plan's phases, with status as of 2026-09-24. |
| `HANDOFF.md` | Session state, run IDs, and how to resume. |
| `research/` | Fact-checked research notes per lens, plus `claude-primary-evidence.md` (first-hand observation of Claude's typed artifacts). |
| `wip/` | The raw record: area findings and verifier verdicts, the three competing proposals, judge scores, red-team issues, and the scrubbed backlog JSON. |

## The short version

- **Juno already did the storage half of the merge.** A design is an `Artifact` row with type DESIGN, sharing versions, share links, the library and sync with every other type. What is missing is the lifecycle and one surface.
- **Fix these before building any merged UI** (verified; see `00` §6):
  - Web script previews have been blank in production since 26 Aug, because the CSP is inherited into the sandbox (X-01).
  - Editing a message or regenerating deletes artifacts (X-03, X-04).
  - The chat Canvas design editor breaks on first edit (X-02).
  - The model overwrites the user's edits (X-05, X-06), and a cut-off revision is saved as "verified" (X-07).
  - Mac design saves lose data (X-14 to X-16), and the Mac's bundled editor is stale and unstyled (X-17 to X-19).
- **The plan's key moments:**
  - The losses stop in weeks 1–4 (R0 on 2026-09-28).
  - The owner sees the merged home, with no Design door, at "First light" (2026-12-10).
  - Day one is for everyone by 2027-02-11.
  - Docs and Decks launch on 2027-04-01.
- **How it was produced:**
  - Three workflows with about 80 agents: area audits with adversarial verifiers and a completeness critic; nine fact-checked research lenses with gap analysis; three competing merge proposals, three judges, two red-team critics and a revision.
  - Research that relied on a leaked Claude Design prompt was removed; nothing here depends on it.

## Status of fixes already in flight (2026-09-24)

| Defect | Where | State |
|---|---|---|
| X-01 dead previews | `claude/sharp-aryabhata-79fb4b` @ `b7946ff5` | Fixed with share governance. Not merged or deployed; needs a migration deploy |
| X-02 Canvas editor remount | `claude/suspicious-borg-f3e3b4` @ `499b6afd` | Fix ready to land (fast-forwards from main); waiting for a releaser and a signed-in check |
| X-03 / X-04 edit and regenerate deletes | `claude/agitated-elion-a15fe9` @ `7243613f` | Fixed. Not merged or deployed |
| X-08 design size after expansion; M11 type immutability | `artifacts/r0-size-and-type` @ `db3766ab` (stacked on `7243613f`, worktree `../juno-artifacts-r0`) | Fixed with tests. Not merged; lands together with `7243613f` in R0 |
| X-11 / X-12 Mac dock designs and stale revision | `mac/liquid-glass-chat` (Phase 2 stage 3) | In progress in the juno-glass worktree |

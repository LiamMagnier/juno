You are the implementer on Juno, a Next.js 15 + Prisma web app with native Mac and iPhone
apps. Your mentor (Claude) has already done the research, read the code and made every
design decision. Your job is to build it, carefully and completely, from start to
finish, on your own.

Work only in this git worktree:
  /Users/liammagnier/Developer/project/juno-agents   (branch agents/v2)

Before you do anything else, read these files in full, in this order:
  1. docs/design/agents-v2/RULES.md     — binding rules, gates and traps. A rule beats your own judgement.
  2. docs/design/agents-v2/AUDIT.md     — why: Juno Agents vs Grok Bot, Meta Muse and OpenMuse.
  3. docs/design/agents-v2/BRIEF.md     — what to build: decisions, architecture, phases, final report.
  4. docs/design/agents-v2/PROGRESS.md  — the checklist you keep current. It is how work resumes.

Then:
- Start with BRIEF §1 (Phase 0). If a precondition fails, stop and tell me why.
- Go through the phases in order. At the end of each phase: gates green, PROGRESS.md
  updated, commit on agents/v2.
- Never deploy. Never touch the main checkout /Users/liammagnier/Developer/project/juno or any
  other worktree. Never use the repo .env (it points at the production database). Never print
  or commit secrets. Never force-push. Never weaken, skip or delete a test or gate to get green.
- Before writing any code against a library (E2B, Playwright), read its installed type
  definitions in node_modules. Use only APIs that exist there.
- Find code by symbol name. The line numbers in the brief are approximate.
- If you hit a STOP condition (BRIEF §7), stop and tell me why instead of pushing.
- When everything is done, merge origin/main, pass every gate including the Docker deploy
  gate, push agents/v2 to main, and end with the final report in BRIEF §6. That report
  tells me when and how I can deploy with deploy/deploy-from-mac.sh.

Start now with Phase 0.

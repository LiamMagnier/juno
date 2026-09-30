# Juno Refoundation — progress

Branch `rework/refoundation`, worktree `../juno-refoundation`, started from
`main` @ `1feb392c` (Release Juno for Mac 1.9.3, build 94) on 2026-09-30.

This file is the running record: what each phase did, how it was verified, and
what it left open. `PRODUCT_REFOUNDATION.md` is the product decision;
`DECISIONS.md` is the log of individual decisions and their reasons.

## Baseline (main @ 1feb392c, before any refoundation edit)

Run with `.claude/local-tools/refoundation/gate.sh` (3 machine-wide slots) in
the fresh worktree after `npm ci`, `npm ci --prefix runner/agent-core`, the
agent-core build and `npm run i18n:extract`.

| Gate | Result | Notes |
|---|---|---|
| `npm run typecheck` | pass | |
| `npm run lint` | pass | |
| `npm test` | pass | 4,165 tests: 4,124 pass, 0 fail, the rest skipped (DB-gated) |
| `capabilities:check`, `work:contract:check`, `shell:contract:check` | pass | |
| `design:contract:check` | pass | |
| `design:tokens:check` | **FAIL (pre-existing)** | `globals.css` changed on main without regenerating `tokens.generated.ts` and `JunoGeneratedTokens.swift` |
| `native:parity:check` | **FAIL (pre-existing)** | 7 routes unclassified in `contracts/parity/features.json` (`/api/agents/[id]/starter`, `/api/agents/hire-draft`, `/api/mcp/servers*` ×4, `/api/skills/import/file`) and `/api/agents/[id]/duplicate` marked planned though Swift calls it |
| `native:sync:check` | **FAIL (pre-existing)** | fails because of the two gates above; its other 11 gates pass |
| `native:wire:check`, `native:contract:check`, `native:design:check`, `native:register:check` | pass | |
| `security:check` | **FAIL (pre-existing)** | 116/116 security tests and the secret scan pass; the dependency advisory step flags `brace-expansion`, `fast-uri`, `image-size`, `ip-address`, `nodemailer`, `pptxgenjs` |
| `models:capabilities:audit`, `work:sandbox:check` | pass | |
| `code:runtime:check`, `code:remote:check`, `code:preview:check` | pass | |
| `npm test --prefix runner/agent-core` | pass | |
| `npx prisma validate` | env-only failure | needs `DATABASE_URL` and `DIRECT_URL`; re-run with placeholder URLs |
| `npm run build` | _pending_ | |

## Phases

| # | Phase | State | Commits | Verification |
|---|---|---|---|---|
| 0 | Baseline, competitor research, current-state audit and screenshots | in progress | | |
| 1 | Product architecture and information architecture | | | |
| 2 | Design-system directions and the final decision | | | |
| 3 | Shared web primitives, shell, sidebar, composer, chat | | | |
| 4 | Native design-system adaptation and shell parity | | | |
| 5 | Connectors and Skills | | | |
| 6 | Crew | | | |
| 7 | Work, Research, Voice | | | |
| 8 | Artifacts lifecycle | | | |
| 9 | Juno Code runtime correctness and architecture | | | |
| 10 | Juno Code on Mac | | | |
| 11 | Code on web and iOS: remote and cloud parity | | | |
| 12 | Accessibility, motion, responsive polish | | | |
| 13 | Security hardening | | | |
| 14 | Production release and CI hardening | | | |
| 15 | Visual QA and acceptance | | | |

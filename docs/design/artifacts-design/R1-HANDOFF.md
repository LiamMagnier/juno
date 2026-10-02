# R1 handoff: paused 2026-09-24 (the user's usage limit reached 99%)

**Branch:** `artifacts/r1-lifecycle`, in worktree `/Users/liammagnier/Developer/project/juno-artifacts-r0`. It is based on origin/main `e5501f65`.
- It holds one WIP commit, "not for main". Nothing was pushed or deployed.
- The worktree has its own `node_modules`, so `npx prisma generate` is safe there. Never run it in the main checkout.

**Scope and design:** `R1-SPEC.md`, beside this file, is the authoritative spec. It covers:
- artifacts that survive chat deletion, through a hidden per-account anchor conversation;
- Recently deleted, with restore, and a 30-day purge that ships unarmed;
- the re-emit guard, which files `ArtifactProposal` suggestions with Compare, Apply and Dismiss;
- the `/a/{id}` tab title;
- placeholder notes in chat.

Its §4 lists the contracts and its §5 the slices.

**Workflow run:** `wf_8eb86775-a50`, stopped. In the same Claude session it can be resumed with `Workflow({scriptPath: ".../workflows/scripts/artifacts-r1-lifecycle-wf_8eb86775-a50.js", resumeFromRunId: "wf_8eb86775-a50"})`, which replays the finished slices.

## Done (in the WIP commit, not yet integrated or gated)
- **S1a:** the schema, and migration `20260925120000_artifact_lifecycle_r1` (additive; the anchor-filtered conversation triggers). Plus `conversation-visibility.ts`, `artifact-scope.ts`, `artifact-flags.ts`, and the serializer and type changes.
- **S2:** the anchor (`artifact-home.ts`), all three conversation delete paths, `GET /api/conversations/kept-artifacts`, and the sync loaders.
- **S5:** `suggestion-bar.tsx` and `suggestion-compare-dialog.tsx`, the card, list, view and canvas wiring, and `artifact-card-state.ts`.

## Interrupted, partial edits are in the WIP commit
- **S3:** the trash routes, the share gone page, and the purge script.
- **S4:** the re-emit guard, the proposals routes and the chat route hooks. This slice includes `persistArtifacts(…, { heldIds, tx })`, which the chat-rework session (web/rework-ws7) is coding against.
- **S6:** the `/a` page, the Artifacts home, the delete dialogs, and `DocumentSubject` (the tab title).

Some of these files may be half-written. Diff each one against the spec before trusting it.

## Not started
- **S1b:** the sweep that puts `visibleConversationWhere` on every conversation query, the source guard test, and the CI steps.
- **Integration:** a throwaway Postgres, `prisma migrate deploy` plus the drift check, and the database suites. Then `npm test`, lint, tsc and `next build`, with commits per slice.
- **Review:** the two adversarial reviewers, then the fixes.

## Exact next steps
1. In the worktree, run `git diff e5501f65 --stat`. Finish S3, S4 and S6 against `R1-SPEC.md` §3 and §5.
2. Do S1b.
3. Integrate and gate exactly as the workflow's integrator prompt says. The throwaway Postgres recipe is in memory note `juno-route-db-tests`.
4. Review, fix, then squash the WIP into logical commits.
5. Ask the user who releases, gate the exact tree, push, and have the user run `deploy/deploy-from-mac.sh`.

Tell the chat-rework session the SHA once `persistArtifacts` with `tx` lands.

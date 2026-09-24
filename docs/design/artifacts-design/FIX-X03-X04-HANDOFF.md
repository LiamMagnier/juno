# Handoff: X-03 / X-04 (edit and regenerate deleted artifacts)

Paused 2026-09-23 at the user's request. Status: **done and committed, not merged or deployed.**

- Branch / worktree: `claude/agitated-elion-a15fe9` at `.claude/worktrees/agitated-elion-a15fe9`
- Commit: `7243613f` "Keep artifacts when a message is edited or an answer regenerated" (on top of main `7f92324f`)
- Not pushed. No workflow runs. Nothing in progress.

## What changed

- `src/app/api/messages/[id]/route.ts`: the edit no longer runs `artifact.deleteMany`. The later messages' artifacts are detached by the `messageId` SetNull foreign key, with their versions and shares kept.
- `src/app/api/chat/route.ts`: the regenerate supersede transaction calls `detachArtifactsFromMessage(stale.id)` instead of deleting.
- `src/lib/artifacts-store.ts`: adds `detachArtifactsFromMessage`. `persistArtifacts` now also re-attaches a detached row (`messageId` null) to the message that re-emits its identifier. A row pinned to a live earlier message stays pinned.
- `src/hooks/use-chat.ts` + `src/lib/chat-client-state.ts`: `mergeArtifacts` is replaced by `applyTurnArtifacts` (done frame: update in place by identifier, detach what the answer no longer emits) and `detachArtifactsFromMessages` (edit). Drop recovery takes the thread's artifact list as the server returns it.

## Verification

- `tests/artifact-lifecycle.test.ts` drives the real PATCH /api/messages/[id] and POST /api/chat `regenerate: true` against Postgres, with a hand edit and a share on each artifact. Both scenarios fail on the old code and pass on the new. Opt-in: `ARTIFACT_TEST_DATABASE_URL` (run command in the file header; setup gotchas in memory note `juno-route-db-tests`).
- `tests/chat-client-state.test.ts` covers the client helpers.
- Full `tests/*.test.ts`: 3779 pass, 0 fail. The typecheck is clean except for generated files that are missing (i18n catalog, runner build output).
- Not verified in the browser pane (no signed-in session or real model turn there).

## Next steps

1. Review `7243613f`, then merge to main. Agree on one releaser first, since other sessions commit and deploy on main.
2. Deploy the web app. The Mac Liquid Glass branch (`mac/liquid-glass-chat`) extends regenerate to settled answers, so this server fix should ship before or with it. Tell the juno-glass session once it is on main.
3. Follow-ups, not fixed here:
   - X-05: a re-emission from stale history becomes current over a hand edit. The hand edit is kept as an earlier version.
   - Re-emitting an identifier with a different type now retypes the kept row. For DESIGN, that makes `/design/<id>` 404.
   - Detached artifacts stay in the conversation's list, and the model is not told about them.

# Chat rework: handoff (paused 2026-09-23)

Paused on the owner's request, relayed by the "macOS app installation and upgrade" session. Nothing here is on main. Nothing has been pushed.

- **Worktree:** `/Users/liammagnier/Developer/project/juno-tools`
- **Branch:** `web/tools-thinking-research`, branched from origin/main `d0997af2`. It is a local branch only; it has not been pushed.
- **node_modules:** each package is symlinked to the main checkout's copy, except `node_modules/@prisma`, `node_modules/.prisma` and `node_modules/.cache`. Those are real copies, so running `npx prisma generate` here never touches the main checkout's client. Keep it that way: the schema on this branch adds a column the main checkout's database does not have yet.

## The owner's asks

1. **Tool calling.** Rework it: it "doesn't work". Add more useful tools. Audit every tool that Claude, ChatGPT and the other assistants have, and how they implement tool calls.
2. **Thinking animation and right sidebar.** Rework both.
3. **Deep Research.** Rework it completely, based on an audit of ChatGPT Deep Research and Claude Research. Remove the named levels (Quick, Standard, Deep, Max). Improve the UI/UX and the motion design.
4. **Library bug** (added later). Deleting a file from Library also removes it from its chat. It should stay in the chat and only leave the Library.

## Status

### Library bug: implemented, unverified (WIP commit)

- **Cause:** the Library is a direct view over every `Attachment` row. `DELETE /api/attachments/[id]` sets `deletedAt` and tombstones the knowledge index, and every chat path filters on `deletedAt: null`.
- **Fix design:**
  - A new column, `Attachment.libraryRemovedAt`, with a migration in `prisma/migrations/20260923120000_attachment_library_removed_at`.
  - A new route, `DELETE /api/library/[id]`. If a message or a project still uses the file, it only sets `libraryRemovedAt`. Otherwise it tombstones the file exactly as before.
  - The helpers live in `src/lib/library-removal.ts` and `src/lib/library-removal-policy.ts`.
  - `POST /api/attachments/[id]/restore` also clears `libraryRemovedAt`.
  - `GET /api/library` treats a Library-removed row as Recently deleted and adds a `keptIn` field.
  - The client deletes through the new route, and its toast says the file stays in its chat.
  - `DELETE /api/attachments/[id]` keeps its old meaning, because the project page uses it for a real delete.
- **The implementer agent was stopped mid-run.** The edits in the WIP commit have not been typechecked, linted, tested or reviewed.

**Next:**

1. Read the diff (`git show HEAD --stat`, then the files).
2. Finish anything left incomplete.
3. Run the checks from the worktree:
   - `npx tsx --test tests/library-removal.test.ts tests/library-and-model-menu.test.ts`
   - `npm run typecheck`
   - eslint on the touched files
   - `npm run i18n:extract`
4. Run the two review lenses: data safety, and UX/tests. The script's `LENSES` array has them.
5. Verify in `/dev/library`.
6. **Open question for the owner:** backfill the files deleted from Library before this fix? Their rows are tombstoned (`deletedAt` is set) and their knowledge text was redacted. A backfill would clear `deletedAt`, set `libraryRemovedAt` and re-queue indexing for rows that still have a `messageId`. It changes production data, so ask first.

**Workflow:**

- Run ID `wf_31d45059-ab3`
- Script: `~/.claude/projects/-Users-liammagnier-Developer-project-juno/c6dc8e85-4182-4266-8be9-0fe69658b1ff/workflows/scripts/library-delete-keeps-chat-wf_31d45059-ab3.js`
- Resuming would re-run the implementer from scratch on top of these partial edits. It is better to finish the work by hand, then run the review stage.

### Audit: 11 of 12 reports done, in `docs/chat-rework/audit/`

- **Written:**
  - internal: tools-backend, tools-e2e-trace, tools-ui, thinking-and-right-panel, research-backend, research-ui, design-system-motion
  - external: claude-tools, chatgpt-tools, other-assistants-tools, deep-research-audit
- **Not done:** the external motion audit (the thinking and working animations across products), the completeness critic, and the gap-fill round.

**Workflow:**

- Run ID `wf_bf8ab8d7-57f`
- Script: `~/.claude/projects/-Users-liammagnier-Developer-project-juno/c6dc8e85-4182-4266-8be9-0fe69658b1ff/workflows/scripts/chat-rework-audit-wf_bf8ab8d7-57f.js`
- **Resume:** `Workflow({scriptPath, resumeFromRunId: "wf_bf8ab8d7-57f"})`. The 11 finished agents come back from cache. Only motion-audit, the critic and the gaps run again. This works only from the same Claude session. In a new session, run a single agent with the motion-audit prompt from the script, then the critic.

## Next steps (in order)

1. Finish and verify the Library fix, as described above.
2. Finish the audit: motion audit, critic, gaps.
3. **Design.** Synthesize the reports into `docs/chat-rework/SPEC.md`. It should cover:
   - the tool-calling root causes and fixes
   - new tools
   - the tool-call row UI
   - the thinking indicator and motion spec
   - the right-panel redesign
   - a Research journey with no named levels: depth chosen automatically (`src/lib/research/auto-effort.ts`) plus at most one "go deeper" control
   - the backend and contract changes (the `ResearchEffort` enum appears in the openapi file and in native Swift)
4. **Implement** in disjoint workstreams on this branch:
   - tool backend
   - tool UI
   - thinking and right panel
   - research backend
   - research UI
5. Adversarial review. Then verify in the `/dev/*` galleries. A second `next dev` from this worktree on another port is fine, because it has its own `.next`.
6. Ask the owner before merging to main or deploying. Other sessions release from main (see memory `concurrent-sessions-shared-worktree`).

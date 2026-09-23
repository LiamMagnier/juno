# Chat rework: handoff (live, updated 2026-09-23)

- **Worktree:** `/Users/liammagnier/Developer/project/juno-tools`
- **Branch:** `web/tools-thinking-research`. It is local and has not been pushed, except the Library
  commit described below.
- **node_modules:** each package is symlinked to the main checkout's copy, except
  `node_modules/@prisma`, `node_modules/.prisma` and `node_modules/.cache`, which are real copies.
  `prisma generate` is therefore safe to run here. Typecheck needs `runner/agent-core/dist`, which
  has been built inside this worktree.

## The owner's asks

1. **Tool calling.** Rework it (it "doesn't work"), add more tools, and audit how Claude, ChatGPT
   and others implement tool calls.
2. **Thinking and the right panel.** Rework the thinking animation and the right sidebar.
3. **Research.** Rework Deep Research completely after auditing ChatGPT and Claude Research. Remove
   the named levels (Quick, Standard, Deep, Max). Improve the UI/UX and the motion.
4. **Library bug.** Deleting a file from the Library also deletes it from its chat.

## Commits on the branch (oldest first)

| Commit | What | Where |
|---|---|---|
| `7f92324f` | **Library fix**, web, server and iOS. A Library delete keeps the file in its chat or project | **On origin/main** (pushed by the "Stop iOS Library delete" session on the owner's order). Not deployed; the next deploy runs its migration |
| `4559ae9c` | Audit docs, `DECISIONS.md` and this handoff | Branch only |
| `c899d6f7` | **Pinned-DNS fix.** On Node ≥ 20 every pinned fetch threw `ERR_INVALID_IP_ADDRESS`, which broke Research page reads, the chat page reader and Work fetches | Branch only. **It can ship on its own**: cherry-pick it onto main |

## Documents

- `audit/`: 17 reports. 12 audits plus 5 gap reports on native contract, provider capabilities,
  entitlements and cost, the web fetch backend, and i18n.
- `DECISIONS.md`: the decisions (§1 tools, §2 thinking and panel, §3 Research). §4b resolves the
  audit's contradictions. §4c sets conservative defaults for the owner's open questions, which the
  owner must confirm.
- `SPEC.md`: the implementation spec with exact contracts and workstreams. A workflow is writing it
  now: author, 3 adversarial reviews (`spec-review-*.md`), then a revision.

## Workflow runs (this Claude session, c6dc8e85)

| Run | Purpose | State |
|---|---|---|
| `wf_bf8ab8d7-57f` | Audit | Done |
| `wf_5010c171-35e` | Library fix | Done |
| `wf_526e95f0-d71` | Spec, `chat-rework-spec` | Running |

The scripts are under
`~/.claude/projects/-Users-liammagnier-Developer-project-juno/c6dc8e85-4182-4266-8be9-0fe69658b1ff/workflows/scripts/`.

## Next steps

1. Read `SPEC.md` after the revision. Message the Mac session (`juno-glass`) with the final wire
   field names; it mirrors the activity row and panel.
2. **Implement in waves**, following the workstreams in SPEC §12:
   - wave 1 in parallel on disjoint files;
   - then integration (`route.ts`, `use-chat`, `chat-view`, `message-item`, composer);
   - then Research UI.
3. **Review.** An adversarial multi-lens review, then the full tests, typecheck and lint.
4. **Visual check.** Look at it in `/dev/run` and `/dev/research`. Start a dev server from this
   worktree on port 3200; it has its own `.next`, so it won't clash with another session's port
   3100.
5. **Owner decisions before any merge or deploy:**
   - the §4c defaults;
   - backfilling Library deletions made before the fix;
   - shipping `c899d6f7` early.

## Coordination

- **Mac Chat session** (`juno-glass`): it read `DECISIONS.md` into its Phase 2 brief. Ping it when
  `SPEC.md` is final and whenever a wire name changes. Don't touch `juno-glass*` or `native/`.
- **Artifacts & Design session** (branch `wip/artifacts-design-audit`): it will rework the canvas.
  This rework leaves `CanvasPanel` and `DocumentViewer` alone and only builds the shared shell for
  the Activity and Research panels.

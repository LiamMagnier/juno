# Chat rework: handoff (PAUSED 2026-09-23, mid wave 1)

Paused on the owner's request, relayed by the "Artifacts & Design audit" session because of the
usage limit. Nothing unfinished is on main, and nothing was deployed.

- **Integration worktree:** `/Users/liammagnier/Developer/project/juno-tools`, branch
  `web/tools-thinking-research`. It is local except for the Library commit.
- **node_modules:** in every rework worktree, each package is symlinked to the main checkout's copy,
  except `@prisma`, `.prisma` and `.cache`, which are real copies. `prisma generate` is therefore
  safe. Set up a new worktree with `bash scripts/rework-worktree-setup.sh <path>`.

## The owner's asks

1. Rework tool calling (it "doesn't work") and add tools, based on an audit of Claude, ChatGPT and
   others.
2. Rework the thinking animation and the right sidebar.
3. Rework Deep Research completely, based on an audit of ChatGPT Deep Research and Claude Research.
   Remove the named levels (Quick/Standard/Deep/Max). Improve the UI/UX and the motion.
4. Library bug: a file deleted from the Library also disappeared from its chat.

## Done

| Commit | What | Where |
|---|---|---|
| `7f92324f` | **Library fix.** Web, server and iOS | **On origin/main**. Not deployed; the next deploy runs its migration |
| `4559ae9c`, `169e6bb1` | Audit (17 reports in `audit/`) and `DECISIONS.md` (§4b resolutions, §4c defaults the owner must confirm) | Branch only |
| `c899d6f7` | **Pinned-DNS fix.** On Node ≥ 20 every pinned fetch threw `ERR_INVALID_IP_ADDRESS`, breaking Research page reads, the chat page reader and Work fetches | Branch only. **Can ship on its own:** cherry-pick onto main |
| `f1badf26`, `5f89b888` | `SPEC.md`: 5,600 lines with 3 adversarial reviews applied, plus the bootstrap-advertising addendum agreed with the Mac session | Branch only |
| `8e226dba` | **WS0 contract scaffold.** All new types, stubs, CSS tokens and `rework-worktree-setup.sh`. Full gate green: 3,803 tests | Branch only |

## Frugal resume, 2026-09-24: `web/tool-call-hotfixes`

The owner resumed with under 10% of the week's usage left and asked for small slices, with no
multi-agent workflows. So first came a hotfix branch off origin/main (7f92324f), in the worktree
`/Users/liammagnier/Developer/project/juno-rework/hotfix`:

- `6de5c15d`: the pinned-DNS fix (a cherry-pick of c899d6f7).
- `00bdd27a`: **Juno's own chat tools stop hanging.**
  - `read_document` and `inspect_image` get exact `read_only` broker rules.
  - The runtime forwards `onApprovalRequest`, so `browser_agent` and `code_interpreter` show their
    approval card instead of waiting unseen for 120 s.
  - Gemini sends `exec.text`.
- `ba2b0c4d`: **"Research" with no level words.**
  - The composer chip, the + menu, the plan gate, the report, the landing page, the project settings
    and the user-facing messages now say "Research".
  - The plan gate drops the team and page counts the tier never delivered.
  - Depth is still derived internally, and the activity titles native reads are unchanged.
- Gate on this exact tree: typecheck clean, 3,781 tests passing with 0 failures, eslint clean,
  `check-approval-dispatch` OK. The copy is not visually checked, because the browser pane has no
  signed-in session.
- **Not pushed.** It fast-forwards onto main. Pushing needs one agreed releaser, and deploying
  needs the owner.

The next small slices, if usage allows:
- stop sending xAI's retired Live Search, once verified live.

## In progress: wave 1 (paused mid-implementation)

The run was `wf_a8130f4a-430` (`rework-wave1`), stopped during the implement stage. No review, fix
or merge had started. Each workstream has one **WIP commit** on its own branch, cut from 5f89b888,
with its worktree under `/Users/liammagnier/Developer/project/juno-rework/<ws>`:

| WS | Branch | WIP commit | Diff vs 5f89b888 | Note |
|---|---|---|---|---|
| ws1 tools/broker/MCP/metering | `web/rework-ws1` | `2233c7bb` | 27 files, +2308 | Committed **with `--no-verify`**. `src/lib/tools/specs/shared.ts:26` has a parse error (an unterminated regex, cut mid-write) |
| ws2 web backend/hardening | `web/rework-ws2` | `9c9980cc` | 3 files, +375 | |
| ws3a llm, Anthropic, Gemini | `web/rework-ws3a` | `35d597c8` | 15 files, +2166 | |
| ws3b Responses, xAI, compat, models | `web/rework-ws3b` | `4aca9e14` | 12 files, +1177 | |
| ws4 turn pipeline/persistence | `web/rework-ws4` | `961be81b` | 6 files, +965 | |
| ws5 run UI, motion, i18n | `web/rework-ws5` | `eeab9903` | 13 files, +2699 | |
| ws6 Activity panel and shell | `web/rework-ws6` | `990ffd16` | 5 files, +946 | |
| ws7 research backend | `web/rework-ws7` | `1f6d2373` | 8 files, +1618 | |
| ws8 research UI | `web/rework-ws8` | `872be8cd` | 9 files, +1496 | |

None of these has been reviewed or gated. They are partial implementations.

## Resume

1. Heavy commands go through `bash /Users/liammagnier/Developer/project/juno-rework/gate.sh <cmd>`,
   which allows at most 3 at once, because this Mac has 24 GB of RAM.
2. **Relaunch wave 1** with the script at
   `~/.claude/projects/-Users-liammagnier-Developer-project-juno/c6dc8e85-4182-4266-8be9-0fe69658b1ff/workflows/scripts/rework-wave1-wf_a8130f4a-430.js`.
   Change the implement prompt to say:

   > Your branch already has a WIP commit from a paused run. Read `git show HEAD`, finish the
   > workstream from there, and squash or reword the WIP commit into proper commits.

   A plain `resumeFromRunId` would re-run the implementers from scratch, because none had finished.
3. Each implementer is then followed by 2 reviews and a fix. After that, merge into
   `web/tools-thinking-research` in the order ws2 → ws1 → ws3a → ws3b → ws4 → ws7 → ws5 → ws6 → ws8,
   rerunning the full gate after every merge. The gate is typecheck, `npm test`, lint,
   `models:capabilities:audit` and `design:tokens:check`.
4. **Wave 2:** WS9a (the `route.ts` server integration) and WS9b (the client integration in
   `use-chat`, `message-item` and `chat-view`), in parallel. **Wave 3:** WS9c (research and
   composer integration). See SPEC §12.5.
5. **Final:**
   - the full gate;
   - `research-copy-guard` turned on;
   - a pass through the `/dev/run` and `/dev/research` galleries on a dev server started from this
     worktree on port 3200 (it has its own `.next`);
   - a whole-branch multi-lens review.
6. **Owner decisions before any merge to main or deploy:**
   - the `DECISIONS.md` §4c defaults and the SPEC §14 open items;
   - backfilling Library deletions made before the fix;
   - shipping `c899d6f7` early;
   - the design-token digest mask that WS0 added to `design:tokens:check` (SPEC §1.2).

## Coordination

- **Mac Chat session (`juno-glass`):** it builds its activity row and panel against SPEC @ f1badf26
  (§2, §2.13, §7, §8). It always sends `clientFeatures`, `timeZone` and `locale`, and reads
  `chat.clientFeatures` from bootstrap, which WS9a adds. Tell it before any merge or deploy, and
  whenever a wire name changes. Don't touch `juno-glass*` or `native/`.
- **Artifacts & Design session** (`wip/artifacts-design-audit`): it reworks the canvas. This rework
  leaves `CanvasPanel` and `DocumentViewer` alone. `artifact-inline-card.tsx` needs coordinating at
  merge (SPEC O-20).

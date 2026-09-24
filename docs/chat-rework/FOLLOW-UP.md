# Chat rework: follow-up (PAUSED 2026-09-24, owner at 99% usage)

The full context is in HANDOFF.md, in this folder.

**Already live on chat.liams.dev** (main 1633a4b5):
- the Library fix;
- the pinned-DNS fix;
- Juno's own tools no longer hang on an unseen approval;
- the feature is named "Research", with no level words.

**Paused:** the second wave-1 run, `wf_7dc5df4a-b96`, stopped during its "Finish" stage.
- Nothing was merged into `web/tools-thinking-research` in that run.
- Each branch `web/rework-ws1…ws8` (worktrees in `../juno-rework/<ws>`) ends with a WIP commit made
  with `--no-verify`. None is reviewed or gated.
- The integration branch already has origin/main e5501f65 merged in, with its gate green.

**Next steps:**
1. Relaunch the script
   `~/.claude/projects/-Users-liammagnier-Developer-project-juno/c6dc8e85-4182-4266-8be9-0fe69658b1ff/workflows/scripts/rework-wave1-resume-wf_7dc5df4a-b96.js`.
   It is written to continue each branch from its WIP commit; a new session can run it with
   `Workflow({scriptPath})`.
   - If usage is tight, run it one workstream at a time, in the order ws2 → ws1 → ws3a → ws3b →
     ws4 → ws7 → ws5 → ws6 → ws8.
2. Merge each branch into `web/tools-thinking-research`, rerunning the full gate after every merge.
3. Visually check `/dev/run` on a dev server started from juno-tools on port 3200.
4. Waves 2 and 3: SPEC.md §12.5. Message the Artifacts session before WS9a touches `route.ts`.
5. **Owner decisions:**
   - the `DECISIONS.md` §4c defaults;
   - the Library backfill;
   - Grok web search: xAI Live Search may return 410.

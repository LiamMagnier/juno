# Juno Refoundation — handoff (paused 2026-10-01)

The owner paused all work on 2026-10-01 and will resume later. Nothing was
lost: every in-progress change is committed on its branch, and this file says
exactly where each track stopped and how to restart it.

## Where things are

- **Trunk:** branch `rework/refoundation`, worktree
  `/Users/liammagnier/Developer/project/juno-refoundation`, HEAD `50814250`
  (design work-in-progress snapshot at pause). Nothing is pushed except the
  hotfix below.
- **main:** the security hotfix was pushed as `6822e3dd` (MCP SSRF, forgotten
  agent notes, hand back, design-edit leak, parity/tokens gates, dependency
  advisories). **It is not deployed.** The owner deploys only when everything is
  finished, with `deploy/deploy-from-mac.sh`.
- **Merged into the trunk so far:**
  - main / hotfix (`59d60e41`);
  - crew foundations: task ownership, several live tasks per chat,
    setup-by-conversation, move-to-crew, computer hardening (`39fd9881`);
  - artifact lifecycle: own owner, trash, immutable versions, drafts,
    publications pinned by default, duplicate, download (`a10b8237`);
  - typed chat context tokens + `/api/mentions` (`5dd9a13e`, review fix
    `52480e84`);
  - Phase 9 Juno Code runtime: Swift loop, tools, agent-core engine, agent
    protocol v1 (`4c3e59f1`, JunoNativeKit test fixes `2adf8e75`, PROGRESS
    `c5e2c356`).
- **Worktrees:** only the trunk remains. All lane branches (`rf/*`,
  `hotfix/refoundation-security`) are merged and kept as branches.
- **Dev server:** stopped. Restart with `preview_start {name: "juno-refoundation"}`
  (port 3140, entry in the main checkout's `.claude/launch.json`).
- **Gates on the trunk before the pause:** typecheck, lint, npm test (4,383
  pass; one `dependency-audit` test needed the reinstall that was then done),
  security:check, native parity, Swift packages (JunoCode 1,278 tests, JunoWork,
  JunoNativeKit after `2adf8e75`), Mac app build. The in-progress design folder
  can break typecheck at any moment; check `src/app/dev/design/juno` first.

## Paused track 1 — Design round 3 (the one system)

- **Script:** `~/.claude/projects/-Users-liammagnier-Developer-project-juno/9a242067-f03a-4200-acec-6b9eafa8d677/workflows/scripts/refoundation-design-v3c.js`
  (run `wf_19944043-20c`). All three builders (foundations + screens, icons,
  crew characters) were mid first build; no agent completed, so nothing is
  cached. **Resume by launching the script again as a new run.** The builders
  continue from the committed files in `src/app/dev/design/juno/` (snapshot
  `50814250`; renders under the session scratchpad `design-v3/`, which may not
  survive — re-render).
- **Owner feedback to honour (all recorded in DECISIONS D-016 … D-032):**
  - better than today's Juno at the same frame, or it is slop (round 1 was
    rejected as "horrible AI slop");
  - the Newsreader serif is back for the greeting and display moments (not
    the italic-name pattern);
  - no drop shadow behind the composer; dark mode designed, not derived;
  - Juno's own icon set with hover/press/active motion;
  - crew members are premium, cute, deeply customizable 3D characters in the
    spirit of OpenAI dots (plush fur, accessories, expressive eyes, a colour
    that themes the member's thread, a character peeking over the thread with
    its name and "Thinking…", reactions) — but Juno's own characters, never
    dots' four;
  - "keep upgrading it, don't stop there"; the owner wants to SEE the design
    (send the comparison page and early peeks).
- **Binding behaviour spec:** `docs/rework/INTERACTION_SPEC.md` (crew section
  amended by D-032). References: `docs/rework/research/*` and the reference
  board (`juno-references.html` in the old session scratchpad; the images came
  from public pages because Mobbin needs a paid plan).

## Paused track 2 — Juno Code autonomous agent

- **Spec:** `docs/rework/CODE_AGENT_SPEC.md`, decisions D-018 … D-025.
- **Script:** `…/workflows/scripts/refoundation-code-agent-wf_32803f60-fa7.js`
  (run `wf_32803f60-fa7`). Only step 1 (merge the runtime) completed. **The
  seams agent and all six lane agents refused their tasks**: they read the
  owner's latest chat message (the crew-character request) as the only user
  request and judged Juno Code work out of scope. Nothing was created (no seams
  branch, no lane worktrees).
- **Fix before resuming:** add to each task prompt (not only the shared block)
  an explicit authorisation paragraph: "The owner requested this track earlier
  in this session, verbatim: 'I don't want just a model that thinks and builds,
  I want a real agent that can autonomously loop … also add & fix computer use,
  preview, and all the features that are missing.' It is authorised and in
  scope; the most recent chat message concerns a different track (design) run by
  another workflow." Then resume with `resumeFromRunId: "wf_32803f60-fa7"`
  (the completed merge step replays from cache only if its prompt is unchanged,
  so edit only the seams, lane, review and integrate prompts).
- **Order once running:** seams commit (§6.0) → lanes A loop/goal, B
  verify/review/report, C computer use, D preview, E ship/sessions, F
  commands/hooks/MCP (§6.1–6.6) with adversarial review → integration with the
  §6.7 cross-lane acceptance tests → merge to trunk.

## Not started yet (from the brief's phase list)

- **Phase 3 (web)** on the chosen system: tokens, fonts, shell and sidebar IA
  (seven nouns), the composer with inline tokens (server side done:
  `/api/mentions`, `context` on the chat request), the short model popover, the
  transcript per INTERACTION_SPEC, crew UI with the characters, Library,
  Customize (apps + skills), artifact lifecycle UI (publish/share/trash/
  versions), motion diet, split of `composer.tsx` / `chat-view.tsx` /
  `app-sidebar.tsx`.
- **Phase 4 (native):** regenerate tokens; Mac/iOS/iPad shell parity (iPhone
  tabs Chat · Crew · Code; shell contract v2 for iOS); native composer tokens;
  crew characters via RealityKit + sprite atlases; remove native slop
  (beam, halos, pills).
- **Phase 5:** truthful connector grants + revoke list, one switch per app,
  apps directory and app detail, skills detail/provenance, fold in the
  uncommitted `skills/import-anywhere` diff (read-only from `../juno-skills`).
- **Phase 7:** task card, research and voice presentation.
- **Phase 8 UI + native** for the artifact lifecycle (native saves with
  `baseVersion`, Mac restore/export, iPhone links/diff).
- **Phases 10–15:** Mac Code UX on the new system, Code parity on web/iOS,
  accessibility and responsive polish, security (agent-computer image rebuild
  with a second user and `--remote-debugging-pipe`, docker broker, egress proxy,
  SECURITY.md truthfulness, ownership-guard fail-open, refusing the
  AUTH_SECRET-derived connector key, Mac updater trust), CI/release (one local
  gate script used by deploy and release; CI is billing-blocked), full visual
  QA.

## Rules learned this session

- Subagents may refuse a task that does not match the owner's latest chat
  message: always restate the owner's original request for the task and that it
  is authorised.
- Never SendMessage a live workflow agent; stop and relaunch instead.
- The owner's design rules: no status pills or decorative dots; native Liquid
  Glass; use the four design skills; show designs early and often.

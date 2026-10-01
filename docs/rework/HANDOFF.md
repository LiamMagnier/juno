# Juno Refoundation — active Codex continuation (2026-10-01)

## Current continuation: read this before the historical pause notes

The owner authorized completing the entire rework on 2026-10-01 and requested a detailed, continuously updated handoff for Claude. Work is active again. The historical pause notes below are preserved as evidence, but their older HEAD/deployment/worktree statements are superseded by this section.

- **Actual workspace:** `/Users/liammagnier/Developer/project/juno-refoundation`, branch `rework/refoundation`, starting HEAD `756a93dc`; clean on entry. The supplied `/Users/liammagnier/Developer/project/juno/docs/rework/HANDOFF.md` does not exist on the local `main` checkout (`1feb392c`). Use this worktree for all continuation changes. Local main is older than the deployment reported in the previous handoff; do not infer production state from it.
- **Scope:** all unfinished phases in PRODUCT_REFOUNDATION / INTERACTION_SPEC / CODE_AGENT_SPEC and this handoff. Dev galleries are design references; production components must receive the redesign. Keep existing agent faces until the new character work is accepted; preserve voice behavior while completing its presentation.
- **Execution:** parallel lanes authorized by the handoff workflow: security/release/backend maintenance; native/Code runtime and parity; secondary pages/apps/skills/artifact UI. Codex root owns web foundations, sidebar, composer, transcript, integration and this file. All lanes share this worktree with explicit file ownership; no parallel commits or dependency reinstallations.
- **Delivery status:** implementation and verification underway. Nothing from this continuation has been pushed, deployed, or released. Completion must be backed by gates and visual evidence; blocked hardware/service/release checks must be distinguished from completed implementation.

### Continuation change and evidence log

This section will be updated as each verified slice lands. Implementation details, commands, failures, screenshots and unresolved work are recorded here and in PROGRESS.md before ending the session.

---

## Historical Claude handoff (preserved)

# Juno Refoundation — handoff (paused again 2026-10-01, afternoon)

## Third pause (2026-10-01, evening) — read this first

- **The website is live on `f5925044`** (GitHub Actions run 36858943058; `/api/health`
  ok, db ok, 10 PM2 apps). `main` = trunk `rework/refoundation` = `f5925044`.
  The Mac release was NOT made (still 1.9.3 build 94); the owner deferred it for
  usage limits.
- **What shipped is the foundations, not the redesign.** The round-3 design lives
  only in the dev galleries (`src/app/dev/design/juno/**`, `page.dev.tsx`, excluded
  from production builds by `pageExtensions`). The owner saw the old design in
  production and asked to "fix everything up"; Phase 3 (port the design into the
  real web app) was launched and then **stopped by the owner before any change was
  made** (the empty `rf/p3-foundation` worktree was removed).
- **Resume Phase 3** with the script
  `~/.claude/projects/-Users-liammagnier-Developer-project-juno/9a242067-f03a-4200-acec-6b9eafa8d677/workflows/scripts/refoundation-phase3-web-wf_7c289f9f-277.js`
  as a NEW run (nothing is cached). Order: foundation lane (tokens, fonts, framed
  shell, sidebar IA, material, icon set) → composer+home, thread, pages lanes in
  parallel, each reviewed → integration with full gates and a production build →
  merge to trunk. It keeps the shipped agent faces (crew characters are still being
  chosen) and today's voice behaviour. The owner wants to resume this together with
  every other paused track (design round 3 revisions + crew loop, voice/dictation
  design, verifying `1f119cbf`, Phases 4–15).
- **Deploy learnings** (apply before the next deploy):
  - GitHub Actions "Deploy to VM" runs on every push to `main` (billing works
    again), so pushing to main deploys; the Mac script and Actions share the VM lock.
  - The Supabase session pooler has 15 client slots; each PM2 app has a Prisma
    `connection_limit` budget in `deploy/ecosystem.config.js` (total 14).
  - The VM (887 MB, 2 vCPU) is at capacity: 10 processes max; an 11th made the
    voice-relay check time out and the deploy rolled back. A larger VM is
    recommended. Artifact maintenance (idle draft sealing; purge unarmed) still has to be
    folded into an existing worker.
  - A stale VM deploy lock (dead pid) can be removed safely after checking the pid.

The owner paused all work a second time on 2026-10-01 and will resume later.
Nothing is lost: every change is committed on its branch, every render, page
and reference is copied to the git-ignored
`/Users/liammagnier/Developer/project/juno/.claude/local-tools/refoundation-artifacts/`
(618 MB: design-v3 renders and clips, design-v2, round-1 directions, the
reference board and images, the owner's reference images 1–9, the comparison
pages, the screenshot harness `shots/shots.mjs`, `mkwt.sh`).

## State at the second pause

- **Trunk** `rework/refoundation` at `406d2812`, clean. Since the first pause it
  gained: the Juno Code seams (`e1fde2fa`) and the **six autonomous-agent lanes,
  integrated and merged** (`fff21f85`, Phase 10a recorded `dfb3c105`; the §6.7
  cross-lane scenarios pass). `1f119cbf` holds the independent verifier's
  in-progress Swift fixes, **unverified**: re-run `npm run native:test JunoCode`
  and the Mac build first. Design work: framed shell, blur, sidebar, centred
  composer (`4460ff63`…`1b4fcb89`), icons (`f09ed494`, `a119c76b`), revision 1 and
  voice WIP (`b715305e`), Blender crew pipelines (`3fbb1cae` long-fur plush,
  superseded; `406d2812` flocked designer-toy pass 1).
- **Worktrees:** the trunk plus `juno-rf-code-{agent-integ,loop,verify,preview,
  screen,ship,extend}` — all clean and merged; remove them (branches kept).
- **Blender 5.2.2** is installed at /Applications/Blender.app (owner approved);
  Cycles uses the M4 Pro GPU through Metal.
- **main** still has only the hotfix `6822e3dd`, not deployed.

## Paused tracks and how to resume

1. **Design round 3** — script `refoundation-design-v3f.js` (run
   `wf_b09dd1dd-c77`). Done: critique 1 of screens and icons (scores: craft/dark
   8.0, UX 7.5, motion 7.0, icons 6.5; findings in the run journal and in
   `juno-design-critique1.html`). In progress when paused: revision 1 of screens
   and icons (WIP committed), and **crew pass 1** of the scored designer-toy loop
   (three directions A everyday shapes, B, C celestial; quick previews in
   `refoundation-artifacts/design-v3/crew/loop1/`; not yet scored). Resume by
   relaunching v3f as a new run: it starts the crew loop at pass 1 again and the
   screens/icons critique again unless the script is edited to skip the done
   critique (pass the critique-1 findings as text and start at revision 1).
   Owner feedback to honour: D-016 … D-034 (latest: crew "still creepy compared
   to OpenAI versions" → flocked designer toys, graphic eyes, saturated colours,
   iconic silhouettes, scored against the dots key art; framed shell; blur;
   sidebar; centred composer; serif greeting; no composer shadow; own icons,
   approved for now).
2. **Voice and dictation design** — script
   `refoundation-voice-design-wf_ef28fc23-1ba.js` (designer was mid-build; WIP
   in `src/app/dev/design/juno/voice/` if any, committed in `b715305e`).
   Relaunch as a new run; the owner asked to see voice mode, dictation and the
   model selector (model selector already exists in the menus scene).
3. **Juno Code** — the autonomous agent is merged. Next: verify `1f119cbf`,
   then Phase 10 (Mac Code UX on the new design system) and Phase 11.
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

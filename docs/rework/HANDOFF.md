# Juno Refoundation — owner stopped implementation; continuation saved (2026-10-01)

## Alevr brand package — current documentation entry point

The owner requested design/documentation only, with Claude implementing later. Read [the package index](brand/README.md), then [shared identity](brand/BRAND_IDENTITY.md), [Chat](brand/CHAT_SYSTEM.md), [Orbit](brand/ORBIT_SYSTEM.md), [Code](brand/CODE_SYSTEM.md), [feature names and icons](brand/NAMES_AND_ICONS.md), [source/export handoff](brand/IMPLEMENTATION_HANDOFF.md), [naming evidence](brand/NAMING_SCREEN.md), [image manifest and prompts](brand/IMAGE_PROMPTS.md), [logo revision](brand/LOGO_REVISION.md), and [completion status](brand/COMPLETION_STATUS.md). The separately requested [tool-call/script/skill rework](TOOL_CALL_REWORK.md) is recorded at the end of this handoff. All files are in this checkout; this brand pass has not committed or pushed them.

**Status: Continuum is the owner-selected logo direction; specifications and artwork are design references, not a finalized production asset library.** The previous A-shaped Open Fold is rejected and archived. Use the selected Continuum master consistently across the app icon, Chat/Orbit/Code and the new [thinking/micro-interaction specification](brand/MOTION_AND_THINKING.md). Name availability, final character/production-artwork approval, editable vector/platform exports and real-app acceptance remain open. Nothing here authorizes restarting application development or deployment.

## Current continuation: read this before the historical pause notes

The owner authorized continuing the rework on 2026-10-01, then explicitly said: “stop what you are doin', include everything you have done into the handoff and push all to main and deploy (the redesign and everything)”. Broad implementation is stopped. Do not interpret the historical completion mandate as permission to restart unfinished implementation. The historical notes below are preserved, but the current checkout and release facts in this section supersede them.

- **Current canonical workspace:** `/Users/liammagnier/Developer/project/juno`, branch `main`. Continuation originally happened in `../juno-refoundation`, branch `rework/refoundation`, from clean `756a93dc`. Another session saved the entire shared continuation as `b1295d77` (173 files, 8,258 insertions, 1,738 deletions), integrated it into main alongside the other agents/skills/MCP/voice branches, and returned `juno-refoundation` to clean `756a93dc`. This was discovered during the owner's stop/deploy request. The changes were moved, not lost. **Do not resume from the now-clean refoundation checkout; it lacks the continuation.** Main was already `133dd285` and pushed when discovered.
- **Scope:** all unfinished phases in PRODUCT_REFOUNDATION / INTERACTION_SPEC / CODE_AGENT_SPEC and this handoff. Dev galleries are design references; production components must receive the redesign. Keep existing agent faces until the new character work is accepted; preserve voice behavior while completing its presentation.
- **Execution:** parallel lanes authorized by the handoff workflow: security/release/backend maintenance; native/Code runtime and parity; secondary pages/apps/skills/artifact UI. Codex root owns web foundations, sidebar, composer, transcript, integration and this file. All lanes share this worktree with explicit file ownership; no parallel commits or dependency reinstallations.
- **Release evidence at discovery:** VM current release points to `133dd2857c78-20261001155737-59211`, matching main commit `133dd2857c787f70600b273994707263f109131c`. Another session deployed it. This session must verify health and record that evidence before claiming it live. GitHub Deploy run `36885598783` and native run `36885598776` failed; deployment and green CI are separate facts. The external main commit reintroduced `--skip-checks` / `SKIP_CHECKS=1` bypasses that the security lane had removed. Do not silently describe the integrated release as passing all gates.
- **Scope boundary:** website deployment is authorized; no request to publish a new macOS/iOS binary is implied. Native source is saved, but a signed/notarized Mac release, App Store upload and real-device acceptance remain separate work.

### Continuation change and evidence log

### Web foundation, shell and icons (root lane)

- Ported the round-3 foundation into **production** `src/app/globals.css`, `layout.tsx`, `tailwind.config.ts`, `components/app/app-shell.tsx` and `app-sidebar.tsx`; this is no longer only a dev-gallery design. Neutral light background `#fcfcfd`, dark `#18191b`, sidebar `#f3f4f5` / `#111213`, foreground `#191b1e` / `#e8e9eb`, ultramarine primary `#2d49c9` / `#97a6e6`. Added faint text, attention, dark user-bubble `#252629`, material-opacity tokens. The previously default stored coral accent resolves to ultramarine; other user-selectable accents remain.
- Added the desktop 8px framed content panel, 14px corner and hairline boundary; mobile removes the outer frame. Popovers use the shared translucent/blurred material with unsupported/reduced-transparency fallbacks. Removed composer shadows in both resting/focused states and the sidebar seam shadow.
- Kept Inter/Newsreader/JetBrains Mono from the chosen reference, added Literata Cyrillic serif fallback, made the greeting regular serif with no italic name, removed greeting entrance animation, and changed theme-color values to the new surfaces. Generated web and Swift design tokens were regenerated. Some historical comments still describe the old warm/coral design; clean them when implementation resumes.
- Chat's main navigation is Projects, Library, Customize; notifications moved to the header bell. Crew stays a section with “Add to crew”; the existing shipped faces remain. Archived chats/sessions now have their own menu. Legacy routes remain for existing links, APIs and command-palette entries. Shell contract `contracts/product/juno-shell-v1.json` is **version 2 despite its legacy filename**, adds Customize/header/mobile/tablet metadata, and preserves legacy destination enum cases; macOS projection regenerated. The mobile projection is not yet fully driven by that metadata.
- Copied approved round-3 custom geometry/rendering/CSS to `src/components/ui/juno-icons/` and mapped about 50 production glyph names in `ui/icons.tsx`. Remaining glyphs still use Phosphor. **Native icon assets were not regenerated from the new house drawing family before the stop**: `scripts/generate-native-icons.mjs` still draws its older sources. The intended next step was importing pure `nativeDrawing` and the web mapping while preserving stable native symbol names, then outlining/checking/building both catalogs. Do not claim visual icon parity yet.

### Context composer and transcript (root lane)

- Added `context-composer-field.tsx` and pure `context-editor-dom.ts`: real contenteditable editor with atomic, noneditable context tokens and a textarea-compatible facade preserving existing composer/dictation/attachment/autosize integration. Mention lookup uses the real owner-scoped `/api/mentions` endpoint, grouped results, readable app permission/connection information, existing entity/agent/app marks and an injectable loader only for dev fixtures.
- Supports caret-based word-boundary `@` lookup, Arrow/Enter/Tab/Escape selection, token range tracking in UTF-16 offsets, plain-text copy/paste, Shift+Enter newline, IME guard, and select-before-delete behavior. First Backspace at a token selects it; the next removes it. `composer.tsx` sends `context` ranges through the existing request options, excludes quoted/private-mode context where appropriate, and uses the new field in the real app.
- Added `context-receipt.tsx`; `message-item.tsx` and `message-list.tsx` project server applied/dropped context receipts into user-message token marks and a disclosure with real connection links. The server receipt remains authoritative. Work plans collapse behind disclosure; removed transcript phase orbs/streaming decorative dot and risk pills.
- Approval buttons now use the specific action verb (or Start task / Hand off / Apply setup change), quiet Deny and disclosed standing-permission choices. The card arms after 500ms and binds requests to the shown receipt/digest. “Tell Juno what to do instead” focuses/seeds the composer. Existing refusal/status/expiry logic is retained.
- Browser-tested the **actual new editor component** at `/dev/context-editor` on port 3150: lookup “Compare @Git”, keyboard insertion of GitHub with range 8–14, gap deletion then token selection/removal, and multiline send of `Check GitHub \nSummarise the repository` with GitHub range 6–12. The captured request carried text and context, then cleared. This is component-level evidence, **not authenticated production workflow acceptance**.
- Remaining composer concerns identified before the stop: slash-skill text rewriting needs range adjustment coverage; restored token metadata across a new mount, native undo for manually inserted DOM tokens, cut/paste/dictation round trips and actual production browser acceptance need checking. Old mention/mirror machinery remains disabled/dead in the large composer and should be removed carefully. The lookup initially shows empty feedback before results and lacks the planned delayed-loading polish. There are two introduced lint warnings (effect dependencies and combobox aria-multiline). Chat “Save as skill” helpers imported by the pages lane are not yet wired by this root lane.

### Secondary pages, native/Code and security lanes

Read the detailed lane logs alongside this file: `CONTINUATION_PAGES.md`, `CONTINUATION_NATIVE.md`, and `CONTINUATION_SECURITY.md`. They record actual paths, checks, limitations and any work not in the captured snapshot. They are continuation evidence, not declarations that every product phase is complete.

- Pages: real Customize tabs for Apps/Skills/Routines/Memory/Instructions, flat app rows and real blocked-connector policy, standing-grant revocation, bounded multi-source skills importer/provenance/export, unified Library, lifecycle controls for generic artifacts/files, Recently deleted, and simplified Crew presentation. Binary WorkArtifact deliverables still lack their own delete/restore/version API; generic artifact lifecycle does not prove that parity.
- Native/Code: reapplied the previously held Swift verifier fixes, question/plan task-control projection and host acknowledgment on web/macOS/iOS, run-scoped usage, honest failure/interruption endings, calmer native Chat/Crew/Code shell and context lookup, captured-base iOS artifact editing and version/read-only sharing controls. Updater trust handling and local iOS unsigned check script added. Full JunoCode suite passed; stable unsigned iOS check passed. NativeKit's complete suite stalled in an existing JunoAuth async waiter; targeted ChatKit tests passed. Mac stable SDK notifications compile drift was still being worked on at the stop; see the lane log for exact final state.
- Security: strengthened fail-closed ownership scopes, independent connector encryption-key requirements, bounded artifact maintenance inside the existing scheduler (no eleventh PM2 app), shared local gates/migration replay, documentation truth cleanup, separate browser/agent UIDs and protected browser profile, authenticated private-pipe CDP, root Docker broker and bounded DNS-pinned egress proxy. Docker acceptance tested the actual built image and fixed real fd3/Chrome-policy issues. The shared GUI/X11 remains an approved browser-control surface; it does not establish credential isolation from GUI access. Current VM computer provider is disabled; root broker deployment is unfinished. Independent connector keys are present on the current VM. No production secret values are recorded here.

### Verification and failed gates — preserve the distinction

- Prior to the external integration: root TypeScript check passed; ESLint had **0 errors, 17 warnings** (several pre-existing dev-gallery warnings and some introduced warnings). Shell contract tests **15/15 passed**. Full web test run: **4,498 total / 4,421 passed / 6 failed / 71 skipped**, 80.7s. Because the first test stage failed, subsequent auth/crypto/moderation stages of `npm test` were not reached in that run. Logs: `/tmp/juno-refoundation-typecheck.log`, `/tmp/juno-refoundation-lint.log`, `/tmp/juno-shell-tests.log`, `/tmp/juno-refoundation-tests.log`.
- Six failures were stale source-shape/design expectations: approval Deny-first/Allow-once label, Library h1 in the old route component, Chat's old four destinations, greeting `motion-safe` animation, old More items, and voice-pupil CSS source ordering. These still need meaningful assertions matching current behavior, not blanket removal.
- Integrated main `133dd285` CI also reports computer-provider symlink/cap checks, chat task/handoff gating and user-MCP safe fetcher checks. These came from the broader external merge and require separate regression review. Saved CI logs: `/tmp/juno-main-ci-failed.log`, `/tmp/juno-native-ci-failed.log`. **Do not resume the stopped feature program merely to make these notes read green.**
- Native CI at `133dd285` failed **Every chat wire field is classified** (Web parity) and **Design editor bundle is current** (API contract). Native changes detection/design-rule jobs passed; macOS/iOS/Swift jobs were skipped in that run. This is not a native app build failure or a successful signed release. Regenerate/classify deliberately when the owner resumes; do not suppress the checks.
- Security lane evidence: actual image UID/profile/bearer/raw-port/private-CDP acceptance, isolated migration replay against current source and archived HEAD, and scratch restore drill (3 DB rows + 3 objects with integrity) passed; details/commands are in its lane log. Native evidence is in its lane log. Default shell Node was 26.8.1 although the package requires 24; use `/opt/homebrew/opt/node@24/bin` for future checks. Earlier root checks used the default; final CI used Node 24.
- A complete production build, fresh independent design review and authenticated end-to-end visual acceptance were **not completed by this root lane**. The earlier shell screenshot was taken during collapse motion and is not a valid settled design baseline. No score/production-ready claim should be inferred from it. The external deploy did build the integrated source; health and source SHA must still be verified live.
- **Web baseline, 2026-10-02 (branch `rf/web-baseline`, landed on the trunk; not pushed or deployed).** On Node 24 every web gate of `scripts/local-gates.sh` and the native workflow's contract/parity jobs passes on the integrated trunk: typecheck; lint 0 errors (7 warnings, all in the old `src/app/dev/design/canvas` and `porcelain` galleries); full `npm test` chain (unit 4,501 / 4,430 pass / 0 fail / 71 skipped, then auth, message crypto, moderation, skill package, custom MCP); `security:check`; shell/tokens/wire/parity/editor/icons/contract checks; approval dispatch; computer-infrastructure unittest; runner and relay tests; release gates; migration replay against a throwaway Postgres; `npm run build`. `native:sync:check` is 14/15 locally only because its PR label gate wants `native: n/a` for the lane's dead-prop removal in `app-sidebar.tsx` (it passes with that label). Fixed for real, not only the tests: custom MCP connectors chose the SSRF-safe fetcher through an optional field the Work runner drops (now keyed on the id, saved URL re-judged, switched-off tools carried into Work runs); the fake computer provider's preflight refusals; the agent face's voice-level listening response and reduced-motion guard (lost with the removed loops); the no-Docker migration replay's SQL_ASCII cluster. The eleven stale tests now assert current behaviour. Chat wire `request.context` is native and `request.roomTurn` planned; new routes/pages are classified; the design editor bundle is rebuilt. Swift builds/tests were not run here (Juno Code workflow).

### Verified deployed state at the owner's stop

Read-only production checks confirmed `/api/health` returns `ok:true`, `db:ok`, exact source version `133dd2857c787f70600b273994707263f109131c`. The VM current symlink matches that source. All **10 PM2 apps are online**; no eleventh process was added. The older deploy-lock PID was no longer alive, but this continuation removed no lock and started no duplicate deployment. Independent connector keys are configured, the computer provider is disabled and its root broker is absent. **Authenticated production smoke passed** model catalog, real Qwen chat with terminal completion, completed receipt, idempotent replay and voice token; public UI smoke exited 0. Authentication evidence is recorded in `CONTINUATION_SECURITY.md`; an expired stored smoke token required the standard release-script refresh, captured internally. Do not include any token values in Git or this handoff. These smoke checks prove basic functioning, not full visual/workflow acceptance.

The stop-time documentation update is made on main and will be pushed. Documentation-only commits do not trigger a website rebuild under the workflow's paths-ignore rule: deployed executable source remains the same verified `133dd285` even when main gains this handoff commit. This is intentional, not a missing redesign deploy. The exact final documentation commit/push can be read from Git history.

### Remaining scope and newly requested naming/identity track

The redesign is partially implemented and deployed, **not completely accepted**. Continue from `main` only when the owner explicitly resumes. Use `PROGRESS.md`'s continuation tracker and the lane logs for the remaining work; retain the round-3 neutral/charcoal/ultramarine direction and serif/custom-icon decisions, existing faces until a character is approved, and honest platform-specific differences.

The owner requested a **complete premium rename and coherent brand identity**, followed by three distinct systems: **Alevr Chat**, **Alevr Orbit** (persistent agents, mathematics/cosmos and new characters) and **Alevr Code**. Alevr is pronounced AL-ver and remains a **working visual concept**, not a cleared name or an applied rename. The documentation and generated concept package is [brand/README.md](brand/README.md); [BRAND_IDENTITY_WORKSTREAM.md](BRAND_IDENTITY_WORKSTREAM.md) records delivered design scope and remaining implementation. V3 foundations and D-027–D-034 govern; Orbit individuals are named agents, functional actions stay clear, and third-party/stable technical identities are preserved.

**Naming caveat:** an exact hosted-chatbot character use of Alevr was found; the name cannot be called unused. Formal availability and the owner's earlier zero-existing-use requirement remain unresolved. Neral failed the existing-software-company criterion; Ensemble, Eviren and Nerivel were rejected. Historical Neral artwork must not ship. Read [the naming screen](brand/NAMING_SCREEN.md).

**Scope boundary:** this pass updated documentation and created reviewable raster concepts only. It did not modify app code/assets, restart implementation, change current release facts, push or deploy. Vector masters, platform exports, complete string application, character approval and real-app cross-platform acceptance remain future work for Claude after authorization.

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


---

## Owner-requested follow-ups at the end of this handoff: tool execution and brand motion

Recorded 2026-10-01. The owner explicitly asked that Claude **rework how tool calls are handled** so supported AI models can actually run **Python and other supported scripts**, use **skills and their referenced workflows**, receive real execution results/files/images and continue the conversation, as users expect from ChatGPT and Claude. A code block or claim of execution is not sufficient.

Read the concrete implementation brief: [TOOL_CALL_REWORK.md](TOOL_CALL_REWORK.md). Audit/reuse the existing runner and native Code tool harness; unify provider tool schemas/call-result handling, execution context, skill discovery/instructions, streaming/cancellation/recovery and artifact delivery. Preserve existing permission/runtime boundaries and verify the actual provider/capability matrix rather than promising unsupported models can execute.

**Scope:** this is a recorded task for Claude's later authorized implementation. No runtime/app code was changed here. It is separate from the brand system. Continue the identity work as well: the owner rejected the earlier A-shaped icon and asked to improve the overall design/product identity; read [the current brand completion status](brand/COMPLETION_STATUS.md) and [replacement-logo exploration](brand/LOGO_REVISION.md). The identity must not be marked final until the Continuum production artwork and unresolved naming/artwork decisions are resolved.


### Continuum thinking, micro-interactions and coherent product motion

The owner selected **Continuum** ("I really like Continuum") as the Alevr logo direction, and explicitly asked for thinking feedback that uses the product's own mark, plus premium micro-interactions and motion across every feature linked to the overall brand/design system. Product names remain Alevr Chat, Alevr Orbit and Alevr Code; Continuum is the logo concept. The rejected A-shaped Open Fold must not be used.

Read [MOTION_AND_THINKING.md](brand/MOTION_AND_THINKING.md). Prototype a restrained tonal handoff through the selected mark's existing paths beside truthful Thinking/tool-phase words; carry shared V3 timing, geometry and meaningful state changes through composer/tokens, navigation, menus, artifacts, Orbit/characters, Code and voice. Preserve silhouette, keyboard immediacy, existing approval semantics, reduced-motion/transparency forms and accessibility; stop motion when hidden. Avoid generic AI glow/orbs/particles, fake progress and unnecessary looping. This explicitly permits purposeful branded thinking feedback while retaining the ban on decorative logo animation.

**Implementation remains later work:** build reviewed vector/segmented geometry, project the chosen logo across the app icon and all three systems, implement the actual state transitions, and validate real-app behavior and performance. The current documentation/artwork task does not modify application code. Keep both this motion request and the script/tool/skill task above in the eventual implementation scope; neither is lost or replaced by the other.


### Full scope to retain from the owner's prompts

- **Identity and naming:** Alevr master name; Alevr Chat, Alevr Orbit and Alevr Code; coherent names for every feature/tool/navigation/action where helpful; clear everyday labels, preserved third-party identity and stable technical identifiers. Alevr availability remains unresolved.
- **Three V3 systems:** the actual Claude Code Juno V3 neutral/charcoal/ultramarine, Newsreader/UI/mono fonts, framed shell, composer, materials, custom icons and responsive/native differences. Orbit carries mathematics/cosmos and the latest original customizable character direction; Chat remains quiet; Code remains precise.
- **Selected artwork and all applications:** Continuum across wordmark, website/favicon/app launcher icons and product boards; semantic interface icon family and optical sizes. The rejected A-shaped artwork must not return.
- **Motion and thinking:** the product's own selected mark in premium thinking feedback, micro-interactions and meaningful motion across every feature/state, with real activity words, accessibility, reduced motion/transparency, keyboard behavior and performance.
- **Real tool use:** supported models actually execute Python/other supported scripts and skills, receive results/files/images, continue toward outcomes and recover honestly. Read TOOL_CALL_REWORK.md; preserve existing permission/execution contracts.
- **Handoff boundary:** retain discoverable documents, reproducible prompts/assets and honest completion status. The owner requested documentation/artwork here; Claude implements later when authorized. No app code, push/deploy or new chat is implied.

---

## Queued owner request (2026-10-02): the Alevr homepage — start ONLY after the product redesign is complete

The owner, verbatim: "Also add in your redesign thing to rework completely the homepage of Alevr using the new design system , logo brand identity and everything. The homepage should show all the features , the design and everything with exceptional motion design and everything to sell the product like claude did with https://claude.com/product/overview but i don't want a copy of what claude did i want a better one that show the product with best in class UI / UX , motion design and everything... It should show the brand identity and everything so the "Inspired by aleph, used in mathematics for infinite cardinalities. The brand idea: knowledge that keeps expanding." and an overall design centered with mathematical , AI and space while keeping it minimal , sleek , modern & premium i don't want any AI slop the website should be an experience not an AI slop experiment or something every motion , every pixel should be calculated and everything. /design-taste-frontend /taste-skill:high-end-visual-design But don't start now , you'll do this when the product is completely redesign first and all is completed".

- **When:** after the product redesign (web port, design round 3 with Orbit agents and voice, Alevr names, native identity) is completed and landed. Not before.
- **What:** a complete new public homepage/product overview for Alevr: every feature (Chat, Orbit agents, Code, Library, Customize/apps/skills, voice, research, tool execution), the real product UI shown with exceptional, calculated motion; the brand story ("Inspired by aleph, used in mathematics for infinite cardinalities. The brand idea: knowledge that keeps expanding."); mathematical + AI + space, minimal, sleek, modern, premium; an experience, not AI slop. Benchmark claude.com/product/overview for scope only — never copy it; it must be better.
- **How:** load the skills design-taste-frontend and taste-skill:high-end-visual-design (plus the four owner design skills); Continuum logo and brand system from docs/rework/brand; V3 tokens; real product UI, not mock slop; motion with purpose, reduced-motion forms, performance budgets; light and dark; design → critique → revise loops with renders shown to the owner before shipping.

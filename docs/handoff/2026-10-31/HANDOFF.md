# Alevr: handoff for the next engineer (2026-10-31)

This document hands the work over to another AI assistant or engineer. Read it top to bottom once, then use §8 as the work queue. Everything referenced lives in the GitHub repo `LiamMagnier/juno`. Supporting reports are in `docs/handoff/2026-10-31/` next to this file.

> **Status at handoff.** Production runs `main`.
> - PRs #119–#122 are live.
> - All work done after #122 is being merged in one integration PR (`integrate/2026-10-31`, see §5). §5 says which pieces made it in and which are behind feature flags.
> - Every work branch is pushed to GitHub, including unfinished ones. Nothing is only local.

---

## 1. What the owner wants (their words, keep these as the bar)

- **Features:** "I want them to beat or be as good as ChatGPT and Claude… deep research, live UI, projects, memory features, code and everything. Improve everything to compete with those chatbots."
- **Design:** "attention to detail in every motion step, in every icon, in every design part, like components, menus, sub-menus, pop-ups and everything, because they don't really look the same and they really look bad for now. It doesn't look premium, sleek and modern like something Claude will have done, or ChatGPT or Apple."
- **Menus and composer:** "rework all the menus design, they look ugly — same for the composer."
- **Native apps:** "make this redesign for the iOS app and the macOS app, because the macOS app doesn't look like the website at all. Keep Swift and SwiftUI and Apple native components [with] Liquid Glass, but the overall layout should be the same, and components more premium, because right now the components are used badly. It looks like AI slop."
- **Taste and consistency:** "Keep improving the components and everything until it can beat all chatbots in terms of design consistency, taste and everything."
- **Cost:** "find a way to make all API calls cheaper while keeping the same performance in models, so the usage gets better."
- **Process:** the owner asked to **see the design direction before the redesign is built.** Defect fixes that are wrong under any direction may ship without that review.
- **Do not ship the old "identity-v2" redesign as-is** (`docs/design/identity-v2/**`). It is held back. Borrow ideas only.

## 2. Product and repo map

The product is **Alevr**. The repo and code names still say Juno. It is a conversation-first AI assistant (chat, deep research, Live UI views, artifacts/canvas, projects, memory, voice, agents with Linux computers, "Orbit" agents, Code). See `PRODUCT.md`.

| Area | Where |
|---|---|
| Web app | Next.js 15 + Tailwind, `src/app/**`, `src/components/**`, `src/lib/**` |
| Data | Prisma + Postgres with RLS, `prisma/schema.prisma`, `prisma/migrations/**`. Per-table owner columns are in `OWNER_COLUMN` (`src/lib/db.ts`) |
| Design tokens | `src/app/globals.css` (source of truth) and `tailwind.config.ts`. `npm run design:tokens` projects them to TS and Swift |
| Shared UI recipes | `src/components/ui/{control,field,menu}-recipe.ts`, primitives in `src/components/ui/*` |
| Icons | Custom family: `src/components/ui/icons.tsx` plus `juno-icons/` (drawings.ts, extra.ts). Exported to native with `npm run native:icons` |
| Design lint | `eslint-rules/wave2.mjs`, `design-system.mjs`, `enforce.mjs` (+ `eslint-rules/enforce/p1.json`) |
| Native | SwiftUI. `native/macOS/JunoDesktop` (the live Mac app, macOS 26 floor), `native/iOS/JunoMobile` (iOS 26 floor), shared `native/Packages/JunoNativeKit` (JunoChatKit, generated tokens), `native/Packages/JunoCode` |
| Contracts | `contracts/**`: parity features, chat wire, shell (composer + menu rows). Check with `npm run native:parity`, `native:wire`, `shell:contract:check` |
| Voice relay | `relay/` (its own package) |
| Agent runtime | `runner/agent-core` (vendored; build with `npm run build --prefix runner/agent-core`), `runner/env-server`, `scripts/work-runner.ts` |
| Deploy | `.github/workflows/deploy.yml`. A push to `main` runs gates, then builds and deploys to the VM with health and smoke checks. `deploy/deploy.sh` |
| Other CI | CodeQL, `native.yml` (macOS/iOS build and tests, has `workflow_dispatch`), `native-snapshots.yml` (new, see §7). The Vercel preview check fails on main too and can be ignored |

**Feature flags** (env, default off):
- `AGENT_VAULT_ENABLED`, `AGENT_TEACH_ENABLED`.
- `CHANNEL_SENDBLUE_*` (iMessage).
- `STRIPE_ISSUING_*` (agent payment cards).
- `COMPUTER_PROVIDER`.
- `TOOL_RUNTIME` / `CODE_INTERPRETER_URL` (code execution).
- New flags from the integration PR are listed in its PR body.
- Owner runbooks are in `docs/design/agents-v2/`: `ENABLE_COMPUTERS.md`, `ENABLE_IMESSAGE.md`, `ENABLE_PAYMENTS.md`, `VAULT.md`, `TEACH.md`.

## 3. Working rules that keep `main` green

- **Node 24** is required (`node -v` → v24).
- **Gates before any PR.** Mirror `deploy.yml` and CI:
  - `npm run typecheck`
  - `npx eslint src scripts tests --max-warnings 0`
  - `npx tsx --test tests/*.test.ts` (0 failures; one wall-clock perf test can fail under heavy load and passes alone)
  - `npx prisma validate`
  - contract checks: `npm run native:parity`, `npm run native:wire`, `npm run shell:contract:check`
  - when tokens, icons or shared recipes change: `npm run design:tokens`, `npm run design:editor:check`, `npm run native:icons`
  - `npm run build`
  - the dependency audit (`scripts/dependency-audit.mjs`; exceptions expire, max 90 days)
- **Never:** `eslint-disable`, skipping, weakening or deleting tests, weakening auth, ownership (`OWNER_COLUMN`), RLS, approvals, encryption, sandbox/CSP or rate limits. Secrets never reach the model or logs.
- **Migrations:** new folder with a unique timestamp that sorts last; additive only; RLS like neighbouring tables; an `OWNER_COLUMN` entry; a `SECURITY.md` row for encrypted fields.
- **New API routes:** classify them in `contracts/parity/features.json`, then `npm run native:parity`. For chat request/wire changes, update contracts and run `npm run native:wire`.
- **Design-system rules:**
  - The duration ladder is closed: 70/120/160/220/360/560 ms, plus named delay/hold/loop/spring tokens.
  - Animate only transform, opacity, clip-path and grid-rows.
  - No opacity on text inks; no `backdrop-filter` in product chrome; in-flow surfaces are flat; shadows only on floating layers.
  - Menus use `menu-recipe.ts`.
  - The `+` menu rows and send/stop/voice faces are fixed by `contracts/product/juno-shell-v1.json` (changing them regenerates Swift enums).
  - Changing an existing token value is cheap (regenerated). Renaming or removing tokens breaks Swift consumers. Shadows and composed surfaces are not projected to native and must be ported by hand.
  - Details: `design/map-principles.md`.
- **Commits** end with the repo's attribution lines. PR bodies follow `.github/pull_request_template.md` if present.

## 4. Live in production before today

| PR | What |
|---|---|
| #119 | Agents, computers and chat reliability |
| #120 | Deploy fix: relay deps installed before the app build |
| #121 | Design rules to zero, consistent padding and radius, Live UI, memory, tool-call and Orbit fixes |
| #122 | Orbit: iMessage, agent payment cards, credential vault, teach-by-demonstration, full app catalogue |

## 5. Merged today: the integration PR `integrate/2026-10-31`

The integration PR merges these branches. Unfinished user-visible features go behind default-off flags. **Check the PR body for the final list, the flags and anything left out.**

| Branch | What it does | State at handoff |
|---|---|---|
| `ci/native-snapshots-pending` | CI job that captures real macOS and iOS screenshots (§7) plus DEBUG-only preview hooks | Works: 106 Mac and 66 iOS captures. Gap: 3 Mac menus don't open during capture (`--juno-preview-press` can't find the element; see the MANIFEST notes) |
| `polish/mobile-a11y` | 44px touch targets (segments, tabs, chips, code-block keys, memory, customize, library, goals, question cards, Live UI), axe contrast/ARIA fixes, keyboard-reachable wide table | 5 commits, done |
| `polish/core-journeys` | Real-app e2e journey specs (first send, turn actions and states, reading stability, canvas edit/export) and fixes: composer primary-button face, office-export offer | Last commit is an unreviewed WIP snapshot |
| `fix/overlay-defects` | Dialogs pin header, footer and close with one scrolling body; shared `ConfirmDialog` for every "Delete X?"; Skill/MCP dialogs on the house dialog; one bottom-sheet engine; computer view, document fullscreen and `/settings` made modal (focus trap, return, scroll lock); toasts on `--z-toast`; one notification surface; keyboard hover cards; Code popovers portalled; one approval-button grammar | 8 commits plus a WIP pin; the review stage did not run |
| `fix/motion-defects` | Sent messages get their entrance (rise-user); view-transition hold 450→80 ms; highlights 0 ms in / 120 ms out (no smear); hover only for real pointers; press dips kept; reduced-motion sweep; timing single source; layout-shift fixes; off-ladder durations; docs reconciled | Commits plus a WIP snapshot; review did not run |
| `feat/share-people` | Share a chat or artifact with specific emails (signed-in, verified viewers), alongside link sharing | Built; review did not run |
| `feat/memory-off-chat` | Per-conversation "memory off" (no read/write, background jobs skip it, header indicator) | Built with tests; review did not run |
| `feat/cloud-attach` | Attach from Google Drive / OneDrive in the composer `+` menu, through the normal attachment pipeline | Built; review did not run |
| `feat/voice-connectors` | Voice calls can use connectors and tools with the same approval rules (relay never gets tokens) | Built; review did not run |
| `feat/tone-capabilities` | Tone sliders (warmth, enthusiasm, emoji, headers/lists, conciseness), plus `src/lib/capabilities.ts` corrected to match shipped and flagged features | Built; review did not run |
| `feat/artifact-ai` | AI-powered artifacts: `window.alevr.complete()` and `window.alevr.storage` through a validated sandbox bridge, metered on the viewer's account | **WIP snapshot.** Must stay behind its flag until finished and security-reviewed |

**First job for the next engineer:** run the skipped review stage on each branch above, using the specs in §8.C and §8.B:
- adversarial security and correctness review;
- before/after screenshots in light and dark at 1280 and 390;
- then fix what you find.

## 6. Not started or stopped mid-way (no code yet)

- **Parity features never started:**
  - PDF export for documents and decks plus "Open in Google Docs / Slides";
  - locked chats;
  - MCP Apps (`ui://` interactive widgets);
  - plugins bundling skills, connectors and instructions.

  Specs are in §8.C.
- **Design defect packages never started:**
  - components and menus;
  - icons;
  - native.

  Specs are in §8.B.
- **Design direction:**
  - three directions are drawn;
  - the judging, synthesis and critique steps did not run;
  - **the owner has not approved a direction yet.**

## 7. How to see the native apps from Linux

Apple targets can't run on Linux, so a CI job captures them.
- **Run it:** push to branch `ci/native-snapshots`, or dispatch `native-snapshots.yml` (inputs `platforms`, `only_macos`, `only_ios`).
- **What it captures:** the Debug apps' preview harness (`--juno-ui-preview`, fixture data, no network), light and dark. Mac at 1440 wide (the runner caps height at about 677). iPhone 17 Pro simulator. Plus the hosted iOS snapshot suites.
- **Where the results go:** an orphan commit on `ci/native-snapshots-out` (`git fetch origin ci/native-snapshots-out`) and an artifact. Each folder has a `MANIFEST.md`.
- **Driver:** `native/Scripts/ci-native-snapshots.py`. It detects springboard/blank captures. macOS minutes cost 10×, so run it deliberately.
- **Compile check for Swift changes:** dispatch `native.yml` on your branch.

## 8. Work queue (priority order)

### 8.A Fix first: privacy and security issues found by the audits

1. **DR-01: private-data leak through research URLs.**
   - A deep-research worker can `open_page` any public URL the model names.
   - Queries are cleaned against the private fingerprint, but URLs are not.
   - So text from a user's private files, project, library, memory or mail can be exfiltrated by a crafted URL, for example from a prompt-injected page.
   - Fix: `privateSafeOpenUrl()` in `src/lib/research/private-sources.ts`, used by `bindWorkerTools().openPage` (`src/lib/research/stages/workers.ts`).
   - Full spec: `depth/deep-research-spec.md` §DR-01. This must ship before connecting Gmail or other apps to research.
2. **PRJ-0: deleted project files still reach the model.**
   - `loadProjectLineage` (`src/lib/projects/project-tree-server.ts`) loads files without a `deletedAt` filter, so tombstoned files' text is still sent on every project turn.
   - Spec: `depth/projects-spec.md` §PRJ-0.
3. **PRJ-1: the project knowledge index is never populated in production,** so project retrieval never runs. Spec: `depth/projects-spec.md` §PRJ-1.
4. **MEM-01: memory embeddings ignore the conversation's provider policy.** Spec: `depth/memory-spec.md`.

### 8.B Design: finish the redesign the owner asked for

**Diagnosis (done, read these first).** Ten audits with file:line evidence are in `design/`:

| Map | Key finding |
|---|---|
| `map-menus.md` | **Six** separate menu systems: radii 8/12/14/16/18, 13 widths, rows 32/34/36/46, about 16 selected-state styles, 4 in-menu toggle forms, 7 shortcut styles, 6 entrance animations. Dark hover contrast 1.09:1. Submenus flush (first row 7px low). The `+` menu and sidebar kebab claim to be "one object" but `.cmenu` overrides the recipe |
| `map-composer.md` | Weak primary (pale grey voice button when empty), icons darker than labels (inverted ink), 7 glyph sizes on one row, dead model-chip CSS, landing→dock is a remount that jumps, three popover materials, drag-over triple outline. 35 findings and a fix order |
| `map-components.md` | Radius and material sprawl (5 card materials, 61 raw shadows), deprecated type rungs widely used, broken Badge `soft`, Slider globally overridden by Live UI CSS, 4 focus languages, 9 press depths. 50 findings and a ranked fix list |
| `map-popups.md` | About 30 overlay surfaces, 12 close-button variants, 8 title styles, no shared confirm, 3 bottom-sheet engines, toasts ignore `--z-toast`, full-screen layers without focus trap. Partly fixed by `fix/overlay-defects` |
| `map-motion.md` | Messages had no entrance, 450 ms route hold, highlight smear, reduced-motion inconsistencies, timing tables disagree, unused tokens, layout-shifting animations. Mostly fixed by `fix/motion-defects` |
| `map-icons.md` | 237 glyphs in two drawing languages (13 nav glyphs redrawn on Lucide geometry), a line ladder that is never crisp, uneven mass, glyphs sit about 0.75 px low, wrong registry picks, Design pen-nib regression, missing Lucide NOTICE. P0/P1/P2 fix order |
| `map-native-macos.md` | Layout inverted vs web (glass sidebar, full-bleed content), about 220 glass capsules incl. about 48 glass-on-glass, edgeless glass composer, custom Chat/Code orbit in the toolbar, duplicated page titles, 32 button styles, 58 sub-12pt text calls |
| `map-native-ios.md` | Drawer IA differs from web, about 114 glass call sites (glass on content), 5 composers (radii 26/24/24/22/28), model hidden behind a gauge glyph, tool calls not rendered, 274 icons as bitmaps (no Dynamic Type), sub-44pt targets |
| `map-principles.md` | Hard constraints, lint, contracts, costs of token changes, owner rules |
| `map-competitors.md` | ChatGPT's public `openai/apps-sdk-ui` tokens (menus radius 12, inset 6, rows 32, 14/20 type; 350 ms open / 200 ms close with `cubic-bezier(.19,1,.22,1)`), Apple HIG menu/motion/sheet rules, Radix timings (100 ms submenu delay, 300 ms safe triangle) |

**Three directions are drawn** in `design/`. Each `.md` is a full spec covering foundations, icons, components, menus, pop-ups, composer, a step-by-step motion storyboard, tokens and native SwiftUI mapping. Each `.html` is a clickable board with a slow-motion toggle; open it in a browser.

| Direction | Character |
|---|---|
| `a-quiet-native` | Apple-grade: opaque hairline surfaces, one soft elevation, concentric radii, 32/44 rows, checkmarks, origin-aware scale+fade, springs for sheets |
| `b-editorial-calm` | Claude-grade: typographic, roomy 36 px rows (52 with description), tinted hover, calm composer |
| `c-precise-power` | ChatGPT/Linear-grade: one command surface (`.cmd`, radius 12, inset 4, rows 32/44, instant highlight, search on menus longer than 7 items), shared palette for the model picker, `+` and slash menus |

**Next steps:**
1. Judge the three with five lenses: product fit/constraints, usability/a11y, craft vs ChatGPT/Claude/Apple, pixel-level detail and motion steps, native fidelity. Synthesize one direction with exact values. Have a strict critic review it, then fix. **Show it to the owner and get approval.**
2. Build it in this order:
   1. tokens/foundations;
   2. icon line ladder and redraw;
   3. recipes/primitives;
   4. menus (one system, replacing all six);
   5. pop-ups;
   6. composer;
   7. motion;
   8. call-site migration;
   9. macOS (web layout with native components; glass only on the control layer; system Menu/Picker/sheets; fix glass-on-glass);
   10. iOS (same).
3. Loop until it beats ChatGPT, Claude and Apple:
   - capture web screenshots and native CI snapshots;
   - judges compare side by side with ChatGPT, Claude and Apple apps;
   - fix;
   - repeat.

**Remaining defect packages** (safe to do before approval, because they are wrong under any direction):
- **Components + menus:**
  - Badge soft fill; Slider override scoped to Live UI; dark `--selected` equals `--border`.
  - Menu hover contrast; tooltip shortcut badge contrast (light mode).
  - Shared Kbd component; one selected state; one in-menu toggle; one group-label font; no menu text under 12px.
  - Destructive rows last; submenu alignment; consistent arrow keys plus Compare picker arrow navigation; Code v2 lists on the menu recipe.
  - One keyboard focus ring; visible primary hover.
  - VerbButton/Answer reuse Button; `shadow-soft`/`shadow-raised` dedupe.
- **Icons (P0/P2, not the redraw):**
  - Design mark regression; wrong registry picks; `weight="fill"` silently outline; `video` alias override.
  - Dead glyph code; unused `lucide-react` / `@phosphor-icons` deps; Lucide NOTICE.
  - Recipe-level optical centring; one press depth.
- **Native:**
  - iOS: sub-44pt targets; `Color.red` → danger token; terracotta/umber remnants; single-detent grabbers; drawer "N waiting" bug; user bubble parity; render tool calls in the iOS transcript.
  - macOS: glass-on-glass inside sheets/popovers; glass lint gate exempting its own file (`scripts/check-native-glass.mjs`); sub-12pt text; Code coral accent; orphaned xcconfigs.
  - Verify by dispatching `native.yml` on the branch.

### 8.C Features: beat ChatGPT and Claude

Verified, build-ready specs (ranked, each item self-contained with files, data model, APIs, acceptance tests) are in `depth/*-spec.md`. Areas whose verification did not finish have only `*-audit.md`, so verify each claim against the code before building.

- **Deep research** (`depth/deep-research-spec.md`):
  - DR-01 leak (above);
  - DR-02 follow-ups cite with on-screen numbers;
  - DR-03 live quality/cost harness;
  - DR-04 connected apps as sources;
  - DR-05 report archetypes shaped to the question;
  - DR-06 section-wise claim repair;
  - DR-07 parallel tool calls;
  - DR-08 tiered search fan-out;
  - DR-09 in-app search;
  - DR-10 `research_lookup`;
  - DR-11 live guidance;
  - DR-12 cited charts.
- **Live UI** (`depth/live-ui-spec.md`):
  - LU-01 views that always render (server-side validation, auto-repair, eval);
  - LU-02 charts that read right;
  - LU-03 view state saved and visible to the model;
  - LU-04 keep, export or copy a view;
  - LU-05 Mac/iPhone render all 30 types (today 24);
  - LU-06 tap-to-ask;
  - LU-07 sortable/filterable tables;
  - LU-08 in-place updates (cheaper history);
  - LU-09 cross-device state;
  - LU-10 settings;
  - LU-11 diagrams;
  - LU-12 sandboxed `live-html` for simulations.
- **Projects** (`depth/projects-spec.md`):
  - PRJ-0/1 (above);
  - PRJ-2 adaptive context plus a `search_project_knowledge` tool;
  - PRJ-3 clickable citations into files;
  - PRJ-4 knowledge status/capacity;
  - PRJ-5/6 shared projects that work (access layer, invites, "Shared with me");
  - PRJ-7 retrieval quality (pgvector ANN, eval);
  - PRJ-8 GitHub sync;
  - PRJ-9 Drive sync;
  - PRJ-10 project routines.
- **Memory** (`depth/memory-spec.md`):
  - MEM-01 provider-respecting embeddings;
  - MEM-02 one visible writer ("remember X" never silent);
  - MEM-03 old facts stop disappearing;
  - MEM-04 never-store sensitive class;
  - MEM-05 past chats you can open (semantic recall with citations; today it is lexical BM25);
  - MEM-06 project chats use account memory;
  - MEM-07 cheaper extraction;
  - MEM-08 memory off the TTFT path;
  - MEM-09 extraction v3;
  - MEM-10 own embedding service.
- **Code** (`depth/code-spec.md`):
  - CODE-1 data analysis on every plan (execution host pool);
  - CODE-2 per-conversation workspace;
  - CODE-3 interactive charts/tables from code;
  - CODE-4 persistent Python variables;
  - CODE-5 verified PRs;
  - CODE-6 data-science packages;
  - CODE-7 AI PR review;
  - CODE-8 network levels;
  - CODE-9 start coding from chat;
  - CODE-10 diff review;
  - CODE-11 cache-stable tool rounds.
- **Chat core** (`depth/chat-core-audit.md`, unverified):
  - CC-1 instant send (no blocking pre-send triage for ordinary messages);
  - CC-2 TTFT pipeline measured end to end;
  - CC-3 inline citations on every search answer;
  - CC-4 answer-craft contract with feature contracts loaded only when needed;
  - CC-5 one-round search answers;
  - CC-6 adaptive thinking plus "Answer now";
  - CC-7 Auto that remembers difficulty and cache affinity;
  - CC-8 everyday-answer eval vs ChatGPT/Claude;
  - CC-9 edit an answer in place;
  - CC-10 seamless Continue.
- **Files, vision and documents** (`depth/files-vision-docs-audit.md`, unverified):
  - FV-1 model-aware image preparation;
  - FV-2 large resumable uploads;
  - FV-3 open/edit the user's own Office files keeping formatting;
  - FV-4 patch-based edits for text artifacts;
  - FV-5 visually rich decks/docs;
  - FV-6 vision OCR/visual indexing;
  - FV-8 spreadsheet depth.
- **Agents and tasks** (`depth/agents-tasks-audit.md`, unverified):
  - R1 task results land in chat as real messages;
  - R2 presence-aware "done" notifications;
  - R3 proactive daily brief (inbox, calendar, Slack);
  - R4 checkpoint resume and lab failover;
  - R5 a browser that works on real sites;
  - R6 approve from anywhere / edit-then-approve.
- **Parity features not started** (specs written for the builders):
  1. **PDF + Google export:** PDF for document and deck artifacts with a renderer that works on the 900 MB VM (prefer pure JS or the existing design-PDF pipeline over Chromium). "Open in Google Docs/Slides" uploads the docx/pptx to Drive with conversion when the Drive connector is connected. Export menu entries in the canvas. Current code: `src/app/api/artifacts/[id]/export/route.ts`, `src/lib/office-export.ts`, `src/lib/design/export.ts`.
  2. **Locked chats:** lock a conversation; opening it requires step-up (password/passkey via the existing account-security mechanisms) with a 15-minute per-session unlock window. While locked the chat shows "Locked chat" in the sidebar and is excluded from search/recall (`src/lib/recall/service.ts`), memory extraction and cross-chat context, and its content is not returned by any API including `/api/v1` (return a locked state the native apps can show).
  3. **MCP Apps:** host support for the MCP Apps extension (`ui://` resources, SEP-1865): `resources/read`, render in the existing opaque-origin sandbox with CSP built from declared domains, a postMessage JSON-RPC bridge (`ui/initialize`, `tools/call` under the same approvals, size changes), shown under the tool call. Code: `src/lib/mcp*`, `src/components/canvas/sandbox-frame.tsx`, Live UI host.
  4. **Plugins:**
     - **Manifest:** name, description, icon, version, skills[], mcpServers[], instructions?. Validated strictly: rejects path traversal, oversize and unknown fields.
     - **Catalog:** a curated first-party catalog, plus upload.
     - **Install and uninstall:** install creates owned skills and connectors atomically (connectors still need their own OAuth and approvals); uninstall removes them cleanly.
     - **Toggles:** enable or disable each plugin.
     - **Settings > Plugins page:** routes are classified in the parity contract.
- **Also see** `parity-gap.md` for the full ChatGPT/Claude capability matrix with sources. Deferred (larger): native document views, Slack app, Android, browser extension, real-time co-editing.

### 8.D Cost: cheaper API calls, same quality

Rule: the user's chosen model and its answers never change. Savings come from caching, routing auxiliary work, trimming waste, batching non-urgent work and avoiding duplicates. Verified items are in `cost/*-verified.md`; findings in `cost/*-findings.md` (batch-flex, retrieval-search, voice-realtime and metering are not yet verified).

- **Start with measurement:** label every aux request; meter research workers and runner side calls; add per-segment prompt size instrumentation (`context-waste-verified.md` K0, `output-reasoning-verified.md` K6).
- **Prompt cache** (`cache-prefix-verified.md`): 70–80% of input is cached today.
  - K1: move per-message instructions out of the cached system tier. With K2 and K3 this saves −7% to −23% of Anthropic chat input.
  - K2: keep the tool set stable on regenerate.
  - K3: stop writing unread cache entries (research synthesis −46% input).
  - K4: project files must not flip into `history[0]`, with a zero-passage fallback (−25% to −45% in lexical-only project chats).
  - K5: 1h marker gated on measured gaps.
  - K6: salted user hash for OpenAI `prompt_cache_key`, after a probe.
  - K7: stable untrusted-content rule (measure first).
  - K8: date placement on compat/Gemini/pre-5.6 OpenAI.
  - K9: semantic outlines to the tail.
- **Aux calls** (`aux-routing-verified.md`, about 14% of spend):
  - K1: lowest thinking tier for aux calls.
  - K2: pre-send triage at the floor tier now; a cheaper model only behind an eval (≥95% agreement).
  - K3: no summary rebuild while the account is active.
  - K4: research judge and expand at floor effort.
  - K5: effective-price ranking.
  - K6: persist follow-up pills.
  - K7: title skip.
  - K8: private moderation cache.
  - K9: reflection skip-when-unchanged.
- **Context** (`context-waste-verified.md`):
  - K1: collapse superseded artifact versions in history.
  - K2: patch revisions (eval-gated).
  - K3: image/PDF token estimate fix.
  - K4: tool search for large connector sets.
- **Output/reasoning** (`output-reasoning-verified.md`):
  - K4: send tool-round reasoning back on OpenAI-compatible labs.
  - K5: Code compaction replay keeps effort and cache key.
  - K7: repetition detector in shadow mode.
- **Turn savings into usage:** check how plan limits are computed (`metering-findings.md`). If they are cost-based, savings raise effective limits automatically; otherwise convert them to cost-based budgets.

### 8.E QA

- Run the e2e journeys from `polish/core-journeys` against a real Postgres (docker) with the deterministic test model, and fix what fails.
- Re-run axe and touch-target sweeps on the dev galleries at 390 and 1280 after each design change.
- `/dev/run` has a pre-existing "server-only" import error in the dev gallery; avoid it or fix it.

## 9. File index for this folder

| Path | What |
|---|---|
| `HANDOFF.md` | This file |
| `parity-gap.md` | ChatGPT vs Claude vs Alevr capability matrix with sources and a ranked gap list |
| `design/map-*.md` | Ten current-state design audits (web, macOS, iOS, competitors, principles) |
| `design/{a,b,c}-*.md` and `.html` | Three design directions: spec and clickable board |
| `depth/*-audit.md` | Feature-depth audits per area (competitor research plus code evidence) |
| `depth/*-spec.md` | Verified, build-ready specs (deep research, Live UI, projects, memory, code) |
| `cost/*-findings.md` and `*-verified.md` | Cost findings and the skeptic-verified subset |

Real native screenshots are on branch `ci/native-snapshots-out`, with a `MANIFEST.md` per folder.

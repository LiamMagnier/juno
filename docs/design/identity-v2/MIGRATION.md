# Identity v2 · MIGRATION (build waves)

Appendix to `docs/design/IDENTITY_V2.md` §18. This is the execution plan: ten waves with explicit file
ownership so waves can run in parallel without editing the same file, their dependencies, the gates each
must pass, and the screenshot set each must hand the owner. Revision 3 (review): a complete ownership
table, the missing dependency edges, gates that actually run in CI, a screenshot harness built on the QA
runner, and aliases for type, radius and springs as well as colour.

## 0. Ground rules

1. **Ownership is exclusive.** A file belongs to exactly one wave at a time (§2.0 assigns every directory).
   A wave may make a *contracted edit* in another wave's file only where this document lists it ("touches
   by contract"), and only after that file's owner has merged.
2. **Shared-file protocol with the running workstreams.** Other workstreams edit the repo now (agent
   computers, Orbit runtime, feature fixes for Live UI, memory, research, artifacts, the geometry audit).
   **At each wave's start, run `git log --since=7.days --name-only --format= -- <each owned glob> | sort -u`
   and treat every file it prints as † (shared)**, in addition to the † marks below. For a † file: rebase on
   `main` immediately before starting it; take only presentation (markup, classes, CSS, copy); leave
   behaviour to that workstream; merge in one short-lived PR; never hold the file across days. Files
   modified in the working tree on 30 Oct 2026 and therefore † from the start include
   `src/components/app/app-sidebar.tsx` (W4), `native/macOS/JunoDesktop/App/MessageRow.swift` and
   `FinishNote.swift` (W7), `tests/agents-face.test.ts` (W0) and the face files
   `src/components/agents/{face-rig,face-geometry}.ts`, `agent-face.tsx` (frozen; §2.0).
3. **Aliases first.** W0 ships the new roles with the old names as aliases: colour (TOKENS §1.6), type
   rungs (TOKENS §2.2), radius names (TOKENS §4), springs (MOTION §3) and the native accent members
   (TOKENS §1.7), so nothing breaks while W1–W8 migrate their own files. Legacy-name lints
   (`no-legacy-colour-role`, `no-legacy-type-rung`, `no-legacy-radius`) warn from W0 and become errors in
   W9; W9 removes the aliases one release after it lands.
4. **Every wave ends green**: `npm run lint`, `npm run typecheck`, `npm test`, `npm run design:tokens:check`,
   `npm run design:contract:check`, `npm run shell:contract:check`, `npm run native:icons:check`,
   `npm run native:design:check`, and its own gates below. **Node**: `package.json` requires Node 24
   (`"engines": ">=24.0.0 <25"`); this environment's default is v22.22.0 (`/opt/node22/bin/node`) and no
   Node 24 is installed, so wave agents run checks with `npx -y node@24 …` or rely on CI
   (`actions/setup-node` 24); a Node 22 local run is never a gate. **macOS**: the `native.yml` jobs
   `packages`, `macos-app` and `ios-app` run on `macos-26` for every pull request; they are blocking for W0,
   W7 and W8 (the owner marks them required in branch protection; a PR may not merge with them skipped). No
   new `eslint-disable` for design rules. **Lint**: each wave adds `eslint-rules/enforce/identity-v2-w<n>.json`
   listing its owned globs, which turns the design-rule warnings into errors for those files (the existing
   enforce mechanism, `eslint.config.mjs:20-25`), so "no new warnings" is enforced, not hoped for.
5. **Every wave hands the owner a screenshot set** (§3): before and after, light and dark, desktop and
   phone, as PNG pairs and one contact sheet per theme.
6. Branches: `identity-v2/w<n>-<slug>`; PR titles "Identity v2 · W<n> · <what>". Commit only what the wave
   owns.

## 1. Dependency graph

```
W0 foundations (+ contract strings, gate infrastructure, baseline shots)
 ├── W1 brand ───────────────┬──────────────────────────────┐
 │                           ├── W2 icons v4 (symbol move needs W1) ──┐
 ├── W3 floating layers ─────┼── W4 shell ──┬── W5 transcript + voice ──┐
 │                           │              └── W6 pages ──────────────┤
 └───────────────────────────┴── W7 native foundations + Mac (needs W0, W1, W2; face port after the Orbit
                                     workstream merges) ── W8 iPhone ───┴── W9 coherence sweep
```

Edges, each for a reason:

| Edge | Why |
|---|---|
| W0 → every wave | tokens, aliases, the generator, the screenshot harness and **all edits to `contracts/product/juno-shell-v1.json`** (IA, greeting, retired strings): W4, W7 and W8 read the contract and its generated `JunoShellContract.swift` and `Shell.xcstrings` (`generate-shell-contract.mjs:40`, `:671-672`), so the contract changes once, first |
| W1 → W2 | W2 moves the symbol code out of `JunoBrand.swift` into `JunoSymbols.swift` after W1 finishes the mark parts of `JunoBrand.swift`; in the same PR W2 updates `generate-shell-contract.mjs:39`, which hard-codes `JunoBrand.swift` to find the `JunoIcon` enum |
| W1 → W4 | the sidebar mark |
| W3 → W4 | primitives |
| W2 → W7 | W2 changes `check-native-sficons.mjs` and `check-native-symbols.mjs` and their entries in `scripts/check-native-design-baseline.json` (by contract); W7 owns every other gate and the rest of that file, so W7 starts after W2's baseline entries land |
| W4 → W5, W6 | the shell and the composer |
| W4 → W7 (IA half of `check-ia-parity.mjs`) | W4 writes the web half; W7 extends it with the Mac half by contract |
| Orbit workstream → W7 face port | the face files are frozen until that workstream merges (NATIVE §6) |
| W7 → W8 | the package |
| all → W9 | |

W1, W3 and W2's web part run in parallel after W0. W5 and W6 run in parallel after W4.

## 2. Ownership

### 2.0 Every directory, one owner

`†` = shared with a running workstream (presentation only). "frozen" = no Identity v2 wave edits it.

| Path | Owner |
|---|---|
| `src/app/globals.css` | W0 (token blocks, generated regions, motion tokens); then its component sections move out in each owner's first commit: focus rules and `.ui-tooltip`, `.overlay-glass`, `.surface-float`, `.control-primary` → W3 (`src/components/ui/controls.css`); `.app-main-canvas`, `.app-sidebar-frame`, `.stream-progress`, page gutter → W4 (`src/components/app/shell.css`) |
| `tailwind.config.ts`, `scripts/generate-design-tokens.ts`, `src/lib/tokens/**` (new `palette.source.ts`, `type.source.ts`), `src/lib/design/tokens.generated.ts` | W0 |
| `src/lib/{accents,motion,motion-preference}.ts`, `postcss/motion-preference.cjs` | W0 |
| `src/lib/input-modality.ts` | W3 |
| `src/lib/app-icons.ts` | W2 |
| `src/lib/shortcut-groups.ts` | W4 |
| `src/app/layout.tsx` (fonts, `data-accent`), `src/app/fonts/**` | W0 |
| `src/app/{icon.svg,icon1.ico,apple-icon.png,manifest.ts,opengraph-image.tsx,twitter-image.tsx}`, `public/brand/**` (prompt files deleted in W1; the photo art in W6) | W1 |
| `src/app/(app)/layout.tsx`, `src/app/(app)/loading.tsx`, `src/app/(app)/settings/**`, `src/app/(app)/chat/**` (route shell) | W4 |
| `src/app/(app)/a/**` (artifact full page), `src/app/sandbox/**` †, `src/app/computer-view/**` † | W5 |
| `src/app/(app)/{activity,agents,artifacts,assistants,automations,code,compare,connections,crew,customize,design,knowledge,library,memory,permissions,profile,projects,research,roadmap,skills,tasks,upgrade,work}/**` †, `src/app/(app)/error.tsx`, `src/app/(auth)/**`, `src/app/(legal)/**`, `src/app/{page.tsx,not-found.tsx,global-error.tsx,offline,pair,r,share,suspended,vs,download,app-auth}/**` | W6 |
| `src/app/(app)/admin/**`, `src/app/(engineering)/**`, `src/app/aura-preview/**` (deleted) | W9 |
| `src/app/dev/**`, `src/app/(app)/dev/**` | per gallery: `controls` W3, `shell` W4, `transcript`, `live-ui`, `agents` W5, the rest W9 |
| `src/app/api/**` | frozen (behaviour), except `src/app/api/settings/route.ts` (W0 by contract: accent ids) |
| `src/components/ui/**` | W3, except `juno-icons/**`, `icons.tsx`, `juno-glyph-paths.ts` (W2), `composer-shell.tsx` (W4), `app-page.tsx` (W6) |
| `src/components/providers.tsx` | W3 (tooltip delays only) |
| `src/components/brand/**` | W1 (the galaxy and thinking marks are deleted by W9) |
| `src/components/app/**`, `src/components/notifications/**` | W4 |
| `src/components/settings/{settings-modal*,settings-rail,settings-pane,setting-row,settings-sections}.*`, `src/components/settings/use-settings-save.ts` (after W0's contract edit) | W4 |
| `src/components/settings/sections/**`, `src/components/settings/model-picker.tsx` (replaced by `ui/model-picker.tsx`) | W6 |
| `src/components/chat/{composer.tsx,composer.css,composer-plus-menu.tsx,composer-menu.tsx,composer-tray.tsx,composer-dictation*.{ts,tsx},composer-clarification-popover.tsx,composer-media-params.*,context-composer-*.tsx,context-editor-*.ts,model-selector.tsx,reasoning-slider.tsx,model-catalogue.tsx,catalogue-focus.ts,task-mode-chip.tsx,private-chat-toggle.tsx,incognito-glyph.tsx,empty-state.tsx,home-starters.*}` | W4 |
| every other file in `src/components/chat/**` † (including `margin/**` new, `run/**`, `panel/**`, `live-ui/**` presentation only) | W5; `chat-view.tsx` † is shared by contract: W4 the home branch, footer removal and composer mount; W5 the transcript branch after W4 |
| `src/components/voice/**` | W5 (the voice bar; a contracted edit to W4's `composer.tsx` for the Talk entry after W4 merges) |
| `src/components/agents/{agent-thread-header,agent-panel,agent-bits,agents.css,thread-agent-state,agent-computer,computer-viewer}.*` †, `src/components/agents/agent-face.css` † (paint only: TOKENS §1.2) | W5 |
| `src/components/agents/{face-rig,face-geometry,face-shapes,face-outlines}.ts`, `agent-face.tsx` | frozen (owner rule 6; the Orbit workstream) |
| every other file in `src/components/agents/**` † | W6 |
| `src/components/{artifacts,canvas,documents,permissions}/**` † | W5 |
| `src/components/{activity,assistants,auth,billing,code,compare,compare-public,connections,customize,design,download,home,i18n,landing,legal,library,memory,profile,projects,public,referral,research,roadmap,share,skills,work}/**` (presentation; † where a workstream edits) | W6 (`design/**` keeps the user-content `backdrop-filter` exemption, TOKENS §7) |
| `src/components/{admin,aicss,ambient,effects,engineering,semantic,signature}/**` | W9 (delete or sweep) |
| `contracts/product/juno-shell-v1.json`, `scripts/generate-shell-contract.mjs` (string edits), `src/lib/strings/shell.generated.ts` (generated) | W0; `generate-shell-contract.mjs:39` icon source path by contract in W2 |
| `eslint-rules/{design-system,wave2}.mjs`, `eslint.config.mjs` | W0; `eslint-rules/enforce/identity-v2-w<n>.json` by each wave |
| `playwright.config.ts`, `.github/workflows/design-gates.yml` (the identity-v2 step) | W0 |
| `scripts/design-audit/{geometry-*.mjs,routes.json,scales.*.json}` † | W0 by contract with the geometry workstream: the face exemption, the corner-scale rule (TOKENS §4), new selectors |
| `scripts/design-audit/{identity-shots.mjs,identity-scenes.json,identity-seed.ts,motion-frames.mjs}` (new) | W0 (harness, seed); W3 (`motion-frames.mjs`) |
| `scripts/check-contrast-matrix.ts`, `tests/{design-token-parity,wave2-p1-globals,presence-token,settings-save-ledger,palette-source,motion-tokens,font-budget,tailwind-class-resolution}.test.ts`, `tests/agents-face.test.ts` † (tone values only) | W0 |
| `scripts/check-ia-parity.mjs` (new) | W4 (web half), W7 (native half, by contract) |
| `scripts/brand/**`, `scripts/generate-native-brand-geometry.mjs` | W1 |
| `scripts/generate-native-icons.mjs`, `scripts/lib/stroke-outline.mjs` (new), `scripts/icon-sources/**`, `scripts/outline-glyph-strokes.swift` (retired), `scripts/check-native-sficons.mjs`, `scripts/check-native-symbols.mjs` | W2 |
| `scripts/generate-native-faces.mjs` (new), every other `scripts/check-native-*.mjs`, `scripts/check-native-design-baseline.json` (W2's two entries by contract) | W7 |
| `package.json`, `package-lock.json` | W0 (scripts, `engines` untouched); W2 by contract only if it adds an outliner dependency (ICONS §3 avoids one) |
| `native/Packages/JunoNativeKit/Sources/JunoDesignSystem/Generated/**` | W0 (generated) |
| `native/Packages/JunoNativeKit/Sources/JunoDesignSystem/{JunoBrand*.swift,JunoBrandGeometry.swift,Brand/**}` | W1 (including the `Brand/JunoProductOrbit.swift` and `Brand/JunoDotGrid.swift` deletions) |
| `native/Packages/JunoNativeKit/Sources/JunoDesignSystem/JunoSymbols.swift` (new) | W2 |
| the rest of `native/Packages/JunoNativeKit/Sources/JunoDesignSystem/**`, `native/Packages/JunoNativeKit/Sources/{JunoChatKit,JunoWorkKit,JunoVoiceKit,JunoDesignKit}/**`, `native/Packages/JunoWork/**`, `native/Packages/JunoNativeKit/Tests/**` | W7 |
| `native/Packages/JunoNativeKit/Sources/{JunoAPI,JunoAgentProtocol,JunoAuth,JunoCore,JunoPreviewSupport,JunoSearch,JunoStorage,JunoSync}/**`, `native/Packages/JunoScreenControl/**` | frozen (no surfaces); W9 if a gate finds one |
| `native/Packages/JunoCode/**` (656 Swift files), `native/Packages/JunoNativeKit/Sources/JunoCodeKit/**` | **W9**, with its own native gate threshold (§4) |
| `native/macOS/JunoDesktop/{App,Tests,UITests}/**`, `native/macOS/JunoDesktop/project.yml` (except icon settings) | W7 |
| `native/iOS/JunoMobile/{App,Widgets,Tests,UITests}/**`, `native/iOS/JunoMobile/Resources/**` (except the icon sets), `native/iOS/JunoMobile/project.yml` (except icon settings) | W8 |
| app icon sets in both `Resources/Assets.xcassets`, `native/Brand/Alevr.icon`, the alternate-icon build settings in both `project.yml` files (`ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES`, `ASSETCATALOG_COMPILER_INCLUDE_ALL_APPICON_ASSETS`) and the iOS `Info.plist` icon keys | W1 (by contract in W7/W8's files) |
| `native/{macOS,iOS}/…/Resources/Icons.xcassets/**` | W2 |
| `docs/design/AGENTS.md` † | W5 by contract (needs-you colour, face tones, the orbit paint, the one-eye-ink note) |
| `docs/native/{WEB_TO_NATIVE_DESIGN,MACOS_LIQUID_GLASS_REDESIGN}.md` | W7 |
| `docs/design/{FLAT_UI,ICONS_AND_MOTION,UI_UX_MOTION_SPEC_2026-10,SOFT_UI}.md` | W9 (a first line pointing to `IDENTITY_V2.md`) |

## 3. The waves

### W0 · Foundations

**Owns**: §2.0 rows marked W0.

**Touches by contract**: the accent picker blocks in `src/components/settings/sections/general.tsx` and
`src/components/app/onboarding.tsx`; `src/components/settings/use-settings-save.ts`;
`src/app/api/settings/route.ts`; `src/lib/sync-mutations.ts`; `src/lib/preferences.ts`;
`src/components/chat/mermaid-block.tsx`; `src/app/dev/directions/tokens.ts`;
`src/app/dev/research/gallery.tsx`; `src/app/dev/run/gallery.tsx`; `src/app/aura-preview/preview.tsx`
(stop setting `data-accent`); native `JunoAccent.swift` (members become deprecated aliases),
`JunoDesignTokens.swift` (accent and motion sections) and the picker and launch call sites of TOKENS §1.7
step 5; `scripts/design-audit/geometry-*.mjs` †.

**Tasks**:
- palette source → triplets with the round-trip check (TOKENS §1.1); new roles + the generated alias map
  with the unmapped-role failure; HC twins including every status ink; alpha roles including
  `--drawer-dim`; agent tones and the one eye ink; chart series;
- `--shadow-1/2/3` in the generator grammar in all four appearances and `JunoGeneratedElevation`;
- springs and the duration ladder with the spring aliases (MOTION §2–3);
- type: `fontSize` entries in rem, `src/lib/tokens/type.source.ts` with the platform data, the type
  aliases, `display-compact`, the hero clamp with a rem intercept (TOKENS §2.2);
- radius: the seven names, the aliases, the `--r` plugin and the one `@supports` corner layer (TOKENS §4);
- shell metrics, all of TOKENS §3: `--sidebar-min/default/max`, `--header-h`, `--stage-inset`, `--measure`,
  `--measure-wide`, `--margin-gap`, `--margin-rail`, `--composer-w`, `--composer-text-inset`, plus the
  `SHELL_NUMBER` list edit in `generate-design-tokens.ts:327` (`galaxy-max-animating` removed with its
  token, or the generator throws);
- generated `AccentColor.colorset` (both apps) and `LaunchBackground.colorset` (iOS only);
- accent retirement (TOKENS §1.7: web in one PR; native step one: deprecated aliases, pickers removed);
- fonts: commit the Inter subsets (roman, italic, Cyrillic, Greek, Vietnamese) and the Geologica WOFF2 and
  TTF instances from `docs/design/identity-v2/tools/fonts-out/` and `proto/fonts/` into `src/app/fonts/`
  with the OFL texts; port the subsetting to `scripts/brand/fonts.py` with `tools/requirements.txt`
  (fontTools 4.68.0, brotli 1.2.1);
- the contract: greeting keys (the owner's pick from IDENTITY_V2 §20 Q1, default "What needs doing, Sam?"
  / "Qu’y a-t-il à faire, Sam ?"), placeholders, the retired list of IDENTITY_V2 §14.2 (including the
  competitor lines), the IA (Orbit busy set, Research destination, canonical Memory and Apps homes);
- new lint rules as warn (`bronze-budget`, `signal-budget`, `no-ink-3-text`, `glyph-size`,
  `no-legacy-colour-role`, `no-legacy-type-rung`, `no-legacy-radius`);
- gate infrastructure: the `e2e/wave2/identity-v2/` package with its `gates.ts`, `playwright.config.ts`
  projects (`chromium-1440`, `chromium-1280`, `chromium-390`, `webkit-390`, `webkit-1440`), and its step in
  `design-gates.yml`; `eslint-rules/enforce/identity-v2-w0.json`;
- the screenshot harness and the **full-product baseline** (§3 protocol) in W0's first PR, before any token
  changes.

**Gates**: `design:tokens:check` (palette round trip, unmapped roles); `tests/palette-source.test.ts`
(TOKENS §1.5 row); `check-contrast-matrix.ts` (every pair and state fill of TOKENS §1.3);
`tests/motion-tokens.test.ts`; `tests/font-budget.test.ts` (preloaded ≤ 120 KB; target 89,204 B);
`tests/tailwind-class-resolution.test.ts` (every `rounded-*`/`text-*` class used under `src/` resolves);
`shell:contract:check`; native `packages` and `macos-app` jobs green on `macos-26` (blocking).

**Screens**: the full baseline (every route in `routes.json`, light and dark, 1440 and 390) as "before"
for the whole program; then `/dev/controls`, `/dev/shell`, `/dev/transcript`, a seeded chat thread,
Projects, Settings (the accent picker gone) in light, dark, HC light, HC dark at 1440 × 900 and 390 × 844.

### W1 · Brand assets

**Owns**: §2.0 rows marked W1.

**Tasks**: port `docs/design/identity-v2/brand/geometry.json` into `arch-geometry.ts` (the generator
reads it); masters 16/20/24/large; mono; wordmark cuts as outlined paths; favicon set; Icon Composer layers;
**one iPhone alternate icon (Light)** with the `project.yml` and `Info.plist` settings; no Mac alternates;
share images from the Geologica static 460 TTF (Satori cannot read WOFF2); the sidebar mark component with
the `live` prop (stone bronze while live) and the once-per-launch rise; port `tools/brand3.py` and
`tools/vendor/{brand2,outline}.py` to `scripts/brand/` (no scratchpad paths: they now read
`tools/fonts-src/`); delete `Brand/JunoProductOrbit.swift`, `Brand/JunoDotGrid.swift` and the two public
prompt files.

**Gates**: brand geometry `--check`; `tests/brand-arch.test.ts` (the 16 master: every arch edge on a whole
pixel, stone 4 px, ≥ 1 px clearance and lift); Playwright render of the favicon at 16 px, DPR 1 and 2, on
light and dark grounds asserting ≥ 4 bronze pixels at 1x; **recognition check** (BRAND §2.1): the 16 and
20 px silhouettes' overlap (intersection over union) with Inter's and Geologica's lowercase "n" at the
same height stays below 0.80, and an unlabelled five-person test ("what is this?") is recorded; if either
fails, the small masters widen toward an aspect ≥ 1.0; **trademark clearance recorded (BRAND §8) before
the production deploy**.

**Screens**: the sidebar top-left; the landing nav; sign-in; share images. **Owner-device deliverables**
(manual, blocking the production deploy only, not the merge): the favicon in real Chrome, Safari and
Firefox tabs, light and dark, zoomed at 1x and 2x; the app icon in the Mac Dock and on an iPhone home
screen in every appearance; the Icon Composer render.

### W2 · Icons v4 and the native icon pipeline

**Owns**: §2.0 rows marked W2.

**Tasks**: ICONS §1–§4 for all export names (242 today, **243 after W2** adds `JunoProjects`; 204
drawings + `projects`, `auto`, `skill`, `apps`, `filter`; the Research telescope, ICONS §2);
`iconStrokePx(size, dpr, theme)`; delete hover articulation; the purpose-built outliner
`scripts/lib/stroke-outline.mjs` (ICONS §3); variable symbol templates; the `JunoSymbols.swift` move after
W1 merges, with `generate-shell-contract.mjs:39` updated to the new file in the same PR; W2's entries in
`check-native-design-baseline.json`.

**Gates**: `npm run native:icons:check` on Linux CI; `tests/icons-v4.test.ts` (the export count is read
from `icons.tsx`, never typed; every export resolves to a v4 drawing); `tests/stroke-outline.test.ts`
(every drawing at the three master widths has identical contour and point counts); before/after and
in-context sheets at 1x and 2x both themes, "before" rendered with `tools/vendor/icons-v3-entry.tsx`.
Owner-device (manual): SF Symbols app validation; a real 1x display check in both themes.

**Screens**: `before-after-{light,dark}@{1x,2x}.png`, `context-{light,dark}@{1x,2x}.png` (sidebar rows,
`+` menu with a submenu, row menu, composer, message action row, toolbar), the full sheet at 16/20/24.

### W3 · Web floating layers and controls

**Owns**: §2.0 rows marked W3: `src/components/ui/{dropdown-menu,select,popover,dialog,sheet,bottom-sheet,
tooltip,sonner,button,icon-button,input,textarea,field,switch,checkbox,radio-group,segmented-control,tabs,
toggle,slider,kbd,badge,card,empty-state,load-error,skeleton,progress,separator,label,pressable,
focus-return,scroll-fade,page-header,model-picker,live,needs-you,list-row}.tsx`,
`src/components/ui/{menu-recipe,sheet-gesture}.ts`, `src/components/ui/sheet.css`, new
`src/components/ui/controls.css`; delete `src/components/ui/surface-tabs.tsx`; `src/lib/input-modality.ts`;
`src/components/providers.tsx` (tooltip delays); `src/app/dev/controls/**`;
`scripts/design-audit/motion-frames.mjs`.

**Tasks**: COMPONENTS §1–§9, §11, §12, §14, §15 as primitives; the keyboard ring in menus; disabled items
focusable with visible reasons; first-row submenu alignment; context menus at the pointer with
Shift+right-click passthrough; the phone sheet + drill-in with its dialog semantics; the button ladder;
segmented ring; whole-row switches; one empty/loading/error recipe; the page header; the model picker with
the Effort group; `NeedsYouAnnouncer`; the forced-colours set carried from globals.css.

**Gates**: unit tests for `menu-recipe.ts` (row 32/44, inset 4, radius 12/8, ring on keyboard);
**owner rule 1 tests**: `tests/focus-keyboard-only.test.ts`, `tests/input-modality.test.ts` and
`e2e/keyboard-focus.spec.ts` stay green and are extended (the menu inset ring and the phone sheet ring
appear only after keyboard input; clicking a menu row, a button or a field draws no ring);
`e2e/wave2/identity-v2/menu-keyboard.spec.ts` (no running animation on keyboard open; Esc closes one level;
disabled items take focus and expose their reason; type-ahead; Effort's Left/Right never open a submenu);
`scrim.spec.ts`; `context-menu.spec.ts`; `phone-sheet.spec.ts` (COMPONENTS §1.9); `reduced-motion.spec.ts`;
`corner-shape.spec.ts` (Chromium: every rounded element carries the superellipse with the scale); axe 0
serious/critical on `/dev/controls` light, dark and forced colours; MOTION §7 frame strips. **WebKit and
Firefox screenshots run in CI only** (`webkit-*` projects): this environment has only Chromium
(`~/.cache/ms-playwright/chromium-1234`) and `playwright install` is not allowed here.

**Screens**: every layer type open (menu, submenu, context menu, select, popover, dialog, sheet, toast,
tooltip, palette), pointer and keyboard focus states, disabled row, destructive row; phone sheet and
drill-in at 390 px; light, dark and forced colours; Chromium and WebKit for corners.

### W4 · Shell (sidebar, composer, home, settings frame)

**Owns**: §2.0 rows marked W4.

**Tasks**: IDENTITY_V2 §11 (composition, sidebar order, Orbit once with the counted header row and the busy
set, non-agent asks on their Recent rows, pinned in Recent, ⌘\ collapse to nothing with ⌘⇧S kept as an
alias for one release, New chat ⌘⇧O on the web, the bell inbox, settings taking the sidebar column with
exactly 12 sections and the canonical Memory and Apps homes, the home composition with the one left edge and
the reserved margin lane); `src/lib/shortcut-groups.ts` and the keyboard-shortcuts sheet updated; the
composer contract (COMPONENTS §10) with the model token, Talk and the two-state send; the composer lift
sentinel; delete the disclaimer footer and the starters; delete `page-backdrop.tsx`, `product-switch.tsx`
once their last users (in W4's own files) are gone, otherwise W6 deletes them.

**Gates**: `tests/owner-rules.test.ts` (node, data only: 12 section ids; the busy-state filter keeps
working, thinking, listening, waiting, blocked and drops idle, paused, done; pinned-first sort; the
contract's retired list contains every IDENTITY_V2 §14.2 left-hand string); **`e2e/wave2/identity-v2/
owner-rules.spec.ts`** (Chromium at 390 and 1440: no element with suggestion semantics before the composer;
the Orbit section renders exactly the busy agents and its header count equals the rows, a waiting agent
included; no retired or competitor string in the rendered home, thread or settings; every shortcut hint
printed in the sidebar is bound and is not a browser-reserved chord: ⌘N, ⌘T, ⌘W, ⌘⇧N, ⌘L, ⌘R are refused);
`scripts/check-ia-parity.mjs` (web half); geometry gate on shell routes (§4); axe;
`e2e/wave2/identity-v2/composer.spec.ts` (send disc two states and names; empty-field press focuses the
field; token remove targets ≥ 24 px pointer, ≥ 44 px coarse; Code controls never render a single-letter
label at 390 px; the placeholder's first character, the greeting and the dateline share one left edge
±0.5 px); `home.spec.ts` (the column does not move on the first send or the first cited answer); **the greeting collision check**: a person with accounts compares the chosen greeting with the live ChatGPT, Claude and Gemini home screens and records the result in the PR (manual; blocking the merge, IDENTITY_V2 §11.5).

**Screens**: home with and without a waiting needs-you card (compare `shots/home-1440-*.png`,
`home-390-*.png`), a thread, settings (General and one other section; compare `shots/settings-1440-*.png`),
sidebar collapsed and expanded, the `+` menu open above the composer, phone home, phone thread, phone
drawer; light and dark; 1440, 1280 and 390; **and the home and thread at 1440 and 390 beside the competitor
reference shots** (`ref/` and the competitive audit's) as the owner's "principles, not pixels" check before
merge.

### W5 · Transcript, agents in the thread, voice

**Owns**: §2.0 rows marked W5.

**Tasks**: IDENTITY_V2 §10 entirely (margin with the reserved lane, the source line in the none tier,
numerals as buttons with line-box hit areas and clusters, the stamp grammar, the step rail with tool glyphs
and state words, the needs-you card variants with the shadow lag and the announcer, sources, Live UI and
artifact visuals, memory in chat); LUI §11, ART §6, MEM §7 visual requirements; the agent header (face 34),
the profile in the side slot and the computer full screen over the thread, restyled (AGENTS.md §5.2); the
face paint in `agent-face.css` (TOKENS §1.2) and the matching AGENTS.md edits; the voice bar
(COMPONENTS §13) and the Talk entry by contract in `composer.tsx`; delete shimmer and skeleton bars in the
transcript; the streaming block fade; the `WritingPoint`.

**Gates**: `e2e/wave2/identity-v2/margin.spec.ts`: tiers by content width (1,168 → wide, 1,008 → compact,
900 → none; at Large 18 px, 1,094 → compact); notes in DOM order after their paragraph, as plain `li`;
each numeral's `aria-describedby` resolves; **24 × 24 hit areas inside their own line box at Default and
Small reading sizes, for a single numeral and a two-numeral cluster**; **a code block and a table in the
seeded answer at 1,440, 1,280 and 940 px content widths and at Large: every block stays inside the stage's
content box minus the page gutter**; no layout shift of the column while streaming (the first paragraph's
top constant ±0 px across 50 token updates; relayout count ≤ committed paragraphs); the column does not move
when the first cited answer arrives; `needs-you.spec.ts` (entrance ≤ 400 ms; the shadow layer still moving
after the body's 95 % point; no leading stripe; shadow only while waiting; the announcer fires once per new
item); `live-loop.spec.ts`; `voice.spec.ts` (no `filter`, `box-shadow` glow or gradient in the voice bar;
the stone's travel ≤ 6 px; reduced motion shows the meter); axe on `/dev/transcript`, `/dev/live-ui`,
`/dev/agents` light and dark with notes present in every tier; contrast of Live UI on-accent text ≥ 4.5:1 in
dark (fixes 2.36:1, LUI B5).

**Screens**: a seeded answer with 3 citations, a code block and a table at 1440, 1280 and 1180 widths
(wide, compact, none) and 390; streaming state; the agent thread with the step rail and a waiting needs-you
card, then answered (compare `shots/agent-1440-*.png`); each needs-you variant; a Live UI chart, table and
calculator; an artifact open in the canvas; the voice bar listening and speaking at 1440 and 390 (compare
`shots/voice-*.png`); light and dark.

### W6 · Pages

**Owns**: §2.0 rows marked W6 (presentation; behaviour stays with the feature workstreams †).

**Tasks**: IDENTITY_V2 §12; every page on the page header, list row and empty/loading/error recipes; the
Orbit home restyled on today's information architecture (needs-you cards, the crew with large live faces,
the hire field; AGENTS.md §4.3, §5.1); the Research list destination (RES §6); Memory (MEM §7) as the
Customize › Memory tab; the landing rebuilt on app tokens with the real product hero and neutral sample
content (compare `shots/landing-1440-*.png`); auth on the stage with the lockup (compare
`shots/auth-1440-*.png`); Projects as a table (compare `shots/projects-1440-*.png`); the settings section
panes (`settings/sections/**`) on the grouped cards; the legal page's template marker removed; 404 and 500
on the page-error recipe; delete `editorial.css`, `page-backdrop.tsx`, `product-switch.tsx` (if W4 could
not), `alv-base.css`, the dot constructions and `public/brand/*.webp` photo art once nothing imports them.

**Gates**: geometry gate on every page route; axe; `tests/landing-content.test.ts` (no third-party domain
other than `*.example.com/.org/.net` in landing fixtures; no vendor sample names; no `--alv-*` token; the
Mac download button renders only when a build exists); `rg 'font-serif|Newsreader|Literata'` returns only
the font licence files.

**Screens**: every page in the routes list, populated and empty, light and dark, 1440 and 390; the landing
full scroll (no reveal choreography hiding content); auth; 404; 500.

### W7 · Native foundations and the Mac

**Owns**: §2.0 rows marked W7.

**Tasks**: NATIVE §0–§8 for the package and the Mac: four-way colour, `JunoType` weights from generated
data, motion without `platformFactor`, the generated elevation renderer with the shadow lag, no Alevr glass,
system sidebar selection, the inset stage (NATIVE §0.1) with its fallback, Mac settings as exactly 12
sections, Orbit busy-only, keyboard-only focus (NATIVE §2.1), follow-up chips removed, the faces in two
parts (generated data now; the hand port after the Orbit workstream merges; golden frames), decorative
deletions, retired copy, the `junoAccent` references in the files W7 owns; extend `JunoComposerShell`
(it exists: 375 lines, used by `ChatComposer.swift` and `DesktopQuickEntry.swift`) with the v2 anatomy and
the voice bar.

**Gates**: `npm run native:design:check` with the new gates at their target values (including
`check-native-focus.mjs`); `native:consumption:test` and `native:test` on `macos-26` (blocking);
`check-ia-parity.mjs` (Mac half); faces `--check`; the golden-frame test; NATIVE §9 items 1, 2, 5 (n/a on
Mac), 6, 7, 8, 9, 10, 11 verified on a Mac and recorded.

**Screens**: produced by the `macos-app` job running `scripts/native-snapshots.sh` and uploaded as the
artifact `identity-v2-native-mac`: Mac window light and dark: chat thread, home, settings (12 sections), the
`+` menu, the agent thread with a needs-you card, Library, the voice bar; sidebar focused and unfocused;
Increase Contrast on; the inset stage vs edge-to-edge pair; the click-focus vs Tab-focus pair.

### W8 · iPhone app

**Owns**: §2.0 rows marked W8.

**Tasks**: NATIVE §1–§7 for the iPhone: the shell contract compiled in; the push drawer from the leading
edge revealing the base behind the stage sheet; the shared `JunoComposerShell` (delete
`JunoMobileComposer.swift`, `JunoMobileComposerPanels.swift`, `JunoMobileCapsuleControls.swift`); system
`Menu`s for `+` and the model token; `junoType` everywhere with the accessibility-size layouts (NATIVE
§5.1); the literal palette deleted; 12 settings sections; numerals as links and the source line; haptics
and announcements; ChatGPT references and retired copy removed; the `junoAccent` references in its files.

**Gates**: as W7 for iOS; `check-native-targets.mjs` touch violations 0; NATIVE §9 items 1, 3, 4, 5, 7, 12
verified on an iPhone and recorded.

**Screens**: produced by the `ios-app` job (simulator) as the artifact `identity-v2-native-ios`: iPhone
light and dark: home, thread, drawer open, `+` menu and a drill-in submenu, model menu, agent thread with
needs-you, settings, Library, the voice bar; AX3 and AX5 text sizes; Reduce Transparency on.

### W9 · Coherence sweep

**Owns**: §2.0 rows marked W9, plus everything not yet migrated by lint report: remaining
`muted-foreground`/`border`/`accent` call sites (codemod `scripts/codemods/identity-v2-roles.mjs`), the
type-rung and radius codemods (`identity-v2-type.mjs`, `identity-v2-radius.mjs`), 14 px glyph classes,
mono-as-label uses (746 `font-mono` today), arbitrary shadows and radii; `native/Packages/JunoCode/**` and
`JunoCodeKit`; the remaining `junoAccent` references, then `JunoAccent.swift` and `JunoAccentSelection`
deleted; deletions: `src/components/{ambient,signature,effects,aicss}/**`,
`src/components/brand/galaxy-*`, `thinking-mark*`, `src/components/voice/voice-glow-*` (nothing replaces
them: the voice bar of COMPONENTS §13 has no glow or edge light), `src/app/aura-preview/**`, shimmer in the
10 files listed in WA §2.7, `animate-spin` outside buttons and fields; the alias removal one release later;
every legacy lint promoted to error; the superseded docs get a first line pointing to `IDENTITY_V2.md`.

**Gates**: the geometry gate at its final thresholds (§4) on every route in
`scripts/design-audit/routes.json`; axe 0 serious/critical on every gallery and key route in four
appearances and forced colours; `check-contrast-matrix.ts`; `check-ia-parity.mjs` full; every lint rule at
error with zero warnings for the design rules; native gates at 0 including `JunoCode`.

**Screens**: the full contact sheet of the product (every route in `routes.json`, light and dark, 1440 and
390) against **W0's full baseline**; the Mac and iPhone sets against W7/W8's.

## 4. Screenshot protocol (every wave)

- **Harness**: `scripts/design-audit/identity-shots.mjs` (W0), started only through
  `scripts/qa/run-prod-e2e.sh` (production build, disposable `*_test` database, the e2e storage state,
  `ALEVR_QA_RUNNER=1`, nothing left running), so it never touches the shared dev server on :3000. It reads
  `scripts/design-audit/identity-scenes.json` (route, seed, actions to open a layer, viewport), runs
  Playwright Chromium (WebKit too, in CI, where the wave asks), `reducedMotion: 'reduce'` for the stills,
  waits for fonts and for `[aria-busy="true"]` to clear.
- **Seed**: `scripts/design-audit/identity-seed.ts` (W0), built on `scripts/qa/seed-qa-fixtures.ts`, with
  the committed neutral content of `docs/design/identity-v2/tools/seed/identity-seed.json`: sources on
  `field-notes.example.org`, `ledger.example.com`, `harbor.example.net`; people "Ana Ortiz", "Ben Hale",
  "Chen Kim", "Dana Noor"; vendors "Vendor A", "Vendor B"; agents Mira, Otto, Nell. No real third-party
  site.
- **Before and after**: CI captures "before" on the pull request's merge-base SHA in a **separate
  `git worktree` that the CI job creates**, and "after" on the head; never in a shared working tree. The
  program-wide baseline (every route in `routes.json`) is captured by W0's first PR before any token
  changes.
- Viewports: desktop 1440 × 900, laptop 1280 × 800 (the compact margin tier), phone 390 × 844; DPR 2.
- Themes: light and dark for every wave; HC light, HC dark and forced colours for W0, W3 and W9.
- Output: `docs/design/identity-v2/waves/W<n>/{before,after}/<scene>--<theme>--<viewport>.png` and
  `W<n>/contact-<theme>.png`, uploaded as the CI artifact `identity-v2-w<n>-shots` and committed only for the
  owner's review set.
- Native: the `macos-app` and `ios-app` jobs (artifacts `identity-v2-native-mac`, `identity-v2-native-ios`),
  same naming under `waves/W7`, `waves/W8`. Device-only items (NATIVE §9, W1's tabs and home screens) are
  owner-device deliverables.

## 5. Gate catalogue and thresholds

| Gate | Command | Threshold |
|---|---|---|
| Token drift | `npm run design:tokens:check` | 0 differences (palette region, springs, shadows in four appearances, Swift, TS, colorsets); 0 unmapped colour roles |
| Palette | `tests/palette-source.test.ts` | TOKENS §1.3 targets in 4 appearances (text ≥ 4.5:1 on every ground and state fill; `ink-2` ≥ 6.0 light / ≥ 6.9 dark everywhere, ≥ 7 on the four dark grounds; status words ≥ 6.0 / ≥ 7.0 on the four grounds); APCA `ink-2` dark \|Lc\| ≥ 70 (error), status inks ≥ 55 (warn); chart ≥ 0.095 OKLab from status inks; the neutral hue gate |
| Contrast matrix | `npx tsx scripts/check-contrast-matrix.ts` | every pair in TOKENS §1.3 including every state fill and the composer and search-field boundaries |
| Class resolution | `tests/tailwind-class-resolution.test.ts` | every `text-*`/`rounded-*` used under `src/` resolves |
| Icons | `npm run native:icons:check`; `tests/icons-v4.test.ts`; `tests/stroke-outline.test.ts` | 0 drift; every export in `icons.tsx` (counted, 243 after W2) resolves to v4; identical topology across masters |
| Brand | `node scripts/generate-native-brand-geometry.mjs --check`; `tests/brand-arch.test.ts` | 0 drift; 16 master fitted; recognition check recorded |
| Geometry | `node scripts/design-audit/geometry-audit.mjs --scales scripts/design-audit/scales.identity-v2.json` | per route: target failures 0 (24 px pointer, 44 px touch, text-only controls included); off-ladder radii 0 (dividing by 1.35 only where `corner-shape` is active); off-scale control heights 0 (24, 28, 32, 40, 44); off-scale icon sizes 0 (12, 16, 20, 24, 32, 40; faces exempt, faces ≥ 20); concentric violations 0; off-scale spacing ≤ 3 per route in W4–W6, 0 in W9 |
| Accessibility | Playwright + `axe-core` (installed) on gallery and key routes, the `e2e/wave2/identity-v2/` package | 0 serious or critical violations, light, dark and forced colours; HC through `emulateMedia({ contrast: 'more' })` where the Playwright version supports it (otherwise the palette test covers HC) |
| Owner rules | `tests/owner-rules.test.ts` (node, data) + `e2e/wave2/identity-v2/owner-rules.spec.ts` (Chromium 390 and 1440, DOM) | all pass |
| Focus (owner rule 1) | `tests/focus-keyboard-only.test.ts`, `tests/input-modality.test.ts`, `e2e/keyboard-focus.spec.ts`, `check-native-focus.mjs` | all pass |
| IA parity | `node scripts/check-ia-parity.mjs` | web, Mac, iPhone and the contract agree |
| Native design | `npm run native:design:check` | every gate at or below its baseline; new gates at 0 by W8 outside `JunoCode`/`JunoCodeKit`, and at 0 there by W9 |
| Native build/tests | `native.yml` jobs `packages`, `macos-app`, `ios-app` on `macos-26` | green; blocking for W0, W7, W8 |
| Lint | `npm run lint` with `eslint-rules/enforce/identity-v2-w<n>.json` | design rules at error inside each finished wave's globs; W9: all design rules at error with 0 warnings |

## 6. Release notes the waves must ship

- W0: "Accent colours are gone; Alevr uses one ink everywhere." (iPhone, after W1: "Pick the light app icon
  in Settings › General.")
- W0/W5: "'Needs you' is now blue (it was orange). The words 'Needs you' and the face's badge are
  unchanged; only the colour is new."
- W1: "New mark and app icon: the Arch."
- W2: "Lighter, redrawn icons."
- W4: "Settings now open in the sidebar column; the sidebar hides completely with ⌘\ (⌘⇧S still works for
  now)."
- W5: "Sources now sit beside the line they support on wide windows, and under each paragraph on phones.
  Voice conversations now happen in the message box."

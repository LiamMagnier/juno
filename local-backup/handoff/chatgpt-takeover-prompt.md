You are taking over all remaining work on Alevr from Claude. Claude has stopped, so you now own both lanes: your own and the one Claude had.

# The product and the goal

Alevr is an AI assistant: chat, Code (a coding agent on the web, the Mac and cloud runners), Work (background agents and routines), research, artifacts and a canvas. It ships on the web, macOS and iOS.

The owner's goal is for Alevr to be better than ChatGPT (Chat, Work, Codex), Claude (Chat, Claude Code, Cowork), T3, Cursor, Perplexity and Gemini on features, design and motion, with the web, macOS and iOS improved together.

- **Codename:** the repository's codename is Juno. Users must never see it.
- **Repository:** /Users/liammagnier/Developer/project/Juno (GitHub LiamMagnier/juno, branch main, last seen at 28a62db2a). Pushing to main and deploying through GitHub Actions is authorised.
- **Stack:** Next.js 15, React, TypeScript, Tailwind, Prisma and Postgres, SwiftUI apps in native/, and Node runtimes in runner/agent-core and runner/env-server.

# Read these first

1. `/Users/liammagnier/Developer/project/Juno/.claude/handoff/LANES.md`: the coordination file and the memory rule. Claude's lane is yours now, so update the file as you go.
2. `docs/rework/program/COMPETITIVE_AUDIT_2026-10-15.md`: 98 ranked gaps in 6 waves. Search "### G<nn> ·" for any gap's details.
3. `docs/design/UI_UX_MOTION_SPEC_2026-10.md`: the approved UI, UX and motion spec ("Editorial Calm, Finished").
   - It sets decisions D1 to D30, tokens, motion and layout, and contains 12 build packages, P0 to P11, in the appendix, each with owned files and acceptance checks.
   - The owner approved sign-offs S1 (ember "needs you" colour with the hand), S3 (one bubble shape), S4 (layout changes and a 12px type floor) and S7 (Cobalt replaces Ultramarine).
   - S2 stays at no change. S6 ships opt-in. S8 waits until every provider's terms are checked.
4. `.claude/handoff/chatgpt-parallel-lane.md`: your earlier brief. Its environment, safety and integration rules still apply.

# What is already done and live

- **Production web** deploys through GitHub Actions, the `Production` environment and its PROD_ENV secret.
- **Wave 1** (about 30 gaps):
  - Chat: branching, the selection bar, inline reasoning, thumbs-down reasons, permission modes and memory sources.
  - Code: composer, attachments, slash commands, draft sync, session rows and actions, and Mac Code billing.
  - Work: routines from chat, routine health and finished-task actions.
  - Design: the motion system, home starters, mobile bottom sheets, brand cleanup and dictation.
  - Canvas and research: canvas autosave, research export, and artifact diff, rename and remix.
  - iOS fixes: Face ID on every approval path, the push entitlement check, the small widget and the prompt editor.
- **Computer-use upgrade:** take over and hand back, step frames and replay, marked approvals, and the Mac local-control floor with its presence HUD.
- **Canvas live blueprint:** the page's real structure draws itself while a page builds. The commit is 99177648a.
- **Your own merges:** PRs #94, #95 and #96 (connectors, MCP unification and connector triggers).
- **Mac app:** Alevr for Mac 1.11.1 is published as a development-signed prerelease. Existing installs update through `/api/downloads?channel=next` on https://chat.liams.dev.

# Paused work, in priority order

1. **PR #98, `claude/native-ci-green`** (18 commits ahead of main): make the GitHub "native" workflow green on Xcode 26.6 runners.
   - Still failing: "Swift packages (JunoCode)". The xctest process exits midway; the branch carries a TEMPORARY backtrace step to find the crashing test.
   - Earlier a "macOS app" compile error was also failing: `ChatComposer.swift:1206` is too complex for Xcode 26 to type-check. Main just gained 28a62db2a, which addresses macOS 26 SDK support, so rebase first and re-check.
   - Fix the code, never the gates: no weakened warnings-as-errors, strict concurrency or design ratchets, and no deleted tests.
   - Remove the temporary backtrace step, get every native job green, then squash-merge.
   - Ignore the "Vercel" check; production is not on Vercel.
2. **Design foundations**, the spec's appendix. These were paused mid-build on branches with work committed:
   - `claude/design-p0-qa-harness` (4 commits): P0, a safe production QA runner and base gate.
   - `claude/design-p1-pipeline` (9 commits): P1, the token, string and generator pipeline to TS and Swift, the lint framework and the contrast matrix.
   - `claude/design-p2-web-foundations` (17 commits): P2, web motion, gesture and overlay primitives. It is built on P1.

   None of these has been reviewed. For each one:
   1. Check out the branch.
   2. Compare it with its package's scope and acceptance in the spec.
   3. Finish what is missing and fix what is wrong.
   4. Rebase on main and run the gates.
   5. Open a PR and merge it.

   P3 (native foundations) has not started. Start it after #98 is merged, because it touches native/Config and project.yml.
3. **Design surfaces, P4 to P11**, after the foundations:
   - P4: web shell.
   - P5: web chat.
   - P6: web Code.
   - P7: web pages.
   - P8: macOS app.
   - P9: iOS app.
   - P10: native Code and Work.
   - P11: settings, auth and onboarding.

   Fold in the wave 2 gaps that belong to the same surface:
   - G18: pin the new user turn to the top.
   - G04: image generation from chat.
   - G05: the Code ship flow (commit, push, PR, CI, auto-fix).
   - G16: Mac files and @file mentions.
   - G17: offline Mac-thread history.
   - G25: diff review.
   - G59: the goal and todo row.
   - G70: the Activity view.
   - G29: generative UI.
   - G27: direct document editing.
   - G47: onboarding.
   - G49: incognito.
4. **Native parity for wave 1.** These are web-only today:
   - the branch pager and regenerating any answer;
   - the selection bar;
   - the thumbs-down reason picker on iOS and the Mac;
   - the routine card;
   - permission modes;
   - memory sources;
   - Code share and the row menu.
5. **Waves 3 to 6** from the audit, then a fresh competitor re-audit. Keep iterating until Alevr leads on every surface.
6. **Known small follow-ups:**
   - Switching away from a Code session declines a waiting screen-control card. Consider keeping it pending instead.
   - The Mac "needs permission" banner is not restored after a relaunch.
   - The canvas blueprint has not been checked in light theme. Confirm its dissolve fires on the real preview "done" signal in a working sandbox.
   - Selection after click-to-code is lost while source is still streaming.

# Releasing the Mac app

There is no paid Apple Developer membership. That means no notarization, no Developer ID and no iOS push or TestFlight.

- **Certificate:** this Mac has a free Apple Development certificate for team 58PVP763WX in the login keychain. Every earlier release used that team, so the updater accepts its builds.
- **Steps:**
  1. Bump `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` in `native/Config/Base.xcconfig`.
  2. Commit and push to main with a clean tree.
  3. Run `JUNO_RELEASE_DIR=/private/tmp/alevr-release-<v> bash .claude/handoff/heavy.sh bash native/Scripts/release-macos.sh <version> --publish-dev`. Run it outside any sandbox, because xcodebuild needs the keychain.
- **What publishing does:** it creates a prerelease. Development-signed installs, including the owner's, pick it up through the next channel.
- **If the GitHub asset upload times out** (it happened once with HTTP 408):
  1. Upload the missing assets from the release directory with `gh release upload`.
  2. Check them against SHA256SUMS.txt.
  3. Publish the draft with `gh api --method PATCH repos/LiamMagnier/juno/releases/<id> -F draft=false -F prerelease=true`.
  4. Confirm `https://chat.liams.dev/api/downloads?channel=next` reports the new version.
- **Smoke test** the built app before publishing.

# Rules that were learned the hard way

- **Memory:**
  - The Mac has 24 GB, and one full typecheck uses about 5 GB.
  - Run every heavy command through `bash .claude/handoff/heavy.sh <cmd>`, which allows 2 machine-wide slots. Heavy means typecheck, next build/dev, Playwright, xcodebuild, swift build/test, the simulator and whole test suites.
  - Stop dev servers, simulators and `testmanagerd` when done.
- **Node 24:** `export PATH=/Users/liammagnier/.npm/_npx/387698761821791d/node_modules/node/bin:$PATH`.
- **Databases:** use only the disposable Postgres at postgresql://postgres@127.0.0.1:55439 (container alevr-upgrade-pg-1015).
  - Database names must end in `_test`, and some suites demand an exact name; read each test's header.
  - Set DATABASE_URL and DIRECT_URL explicitly, because `.env.local` exists.
  - Never touch production data, secrets, PROD_ENV or GitHub secrets.
- **Worktrees** that symlink node_modules share one generated Prisma client. Run `npx prisma generate` after schema merges.
- **Generated files:** regenerate them, never hand-merge.
  - The generators are native:wire, native:parity, capabilities:generate, work:contract:generate, agent:protocol, shell:contract:generate, code-v2:contracts (`node scripts/check-code-v2-contracts.mjs --write`) and design:editor.
  - Then run all the `:check` scripts and `npm run native:design:check`.
- **Migrations:** additive only. Timestamp them after the newest migration on main, and restamp before merging if main moved on.
- **CI's Xcode 26 rejects what local Xcode 27 accepts:**
  - locals that shadow the function they call;
  - expressions that are too complex to type-check;
  - main-actor calls from nonisolated tests.

  Native design ratchets fail when counts rise; never raise the baselines.
- **CI gates:** before pushing to main, run typecheck, lint, the full `tsx --test tests/*.test.ts`, the contract checks, and the database suites the deploy workflow's `migrations` job lists. A red main blocks deploys.
- **Copy:** every user-visible string goes through the i18n layer, in plain sentence case, and never says "Juno".
  - Respect reduced motion through `@lib/motion-preference`; eslint enforces it.
  - Every new behaviour gets a regression test.
- **Reporting:** report honestly, including what you could not verify.

# How to work

Go down the priority list without waiting for approval between items. Ask the owner only for decisions that are genuinely theirs, such as new sign-offs, money, or outside accounts. Keep LANES.md and docs up to date, and after each merged item write a short report: what changed, the tests run, and what was not verified.

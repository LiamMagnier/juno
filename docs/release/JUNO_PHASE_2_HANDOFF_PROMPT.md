# Juno Phase 2 continuation prompt

Copy the prompt below into the next coding agent after checking out the current
`main` branch. This is deliberately a continuation prompt, not an acceptance
claim. The current tree was released as `v1.2.3` / macOS build `66` through the
explicit development-signed, non-notarized path.

```text
You are taking over Juno at /Users/liammagnier/Desktop/juno.

Goal: finish the outstanding Juno Phase 2 closure work. Do not merely make
checkers green. Work until the real iPhone/iPad UI has been visually redesigned
and reviewed, and Gemini 3.7 Flash is wired through the supported Google API as
the real model. Preserve truthful limitations and do not claim acceptance from
ratchets, placeholders, or a successful compile alone.

Read first:
- docs/release/JUNO_PHASE_2_ACCEPTANCE.md
- docs/release/JUNO_PHASE_2_RECOVERY_LEDGER.json
- docs/JUNO.md
- docs/product-completion/status.json
- scripts/verify-phase2.mjs
- scripts/verify-phase2-ci.mjs
- native/Scripts/release-macos.sh

Current known state:
- The current branch is main and contains the v1.2.3 development-signed macOS
  release. It is not notarized because there is no paid Apple Developer
  subscription. Never call that artifact production-ready or notarized.
- The local web regression, lint, build, model validation, and strict local
  Chromium chat E2E gates were run successfully before packaging. The iOS
  simulator app also compiled successfully after the latest native edits.
  Re-run current-tree checks rather than trusting these historical results.
- The native mobile redesign is NOT accepted. Existing
  JunoMobileModelSelector/JunoMobileSettingsView files, native:design:check,
  and a 'no new violations' ratchet are not proof of the requested redesign.
  Some real simulator screenshots were captured, but the redesign pass stopped
  partway through and was not signed off.
- The production browser smoke against https://chat.liams.dev was blocked by
  the available session redirecting to /sign-in. Do not claim that smoke passed
  without an authenticated session.
- The Gemini 3.7 catalog/adapter is intentionally unfinished. Earlier
  OpenAI-compatible probing returned HTTP 403 for 3.7 while 3.6 returned 200.
  A later live probe using the configured GOOGLE_API_KEY against Google's native
  Generative Language API returned HTTP 200 for BOTH:
    https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent
    https://generativelanguage.googleapis.com/v1/models/gemini-3.7-flash:generateContent
  The same native endpoints also returned 200 for gemini-3.6-flash. This proves
  the prior 403 was not proof that 3.7 is nonexistent or unavailable to this
  account. Do not downgrade 3.7 to 3.6 while the UI says 3.7.

Workstream A — real iPhone/iPad visual redesign:
1. Build and install native/iOS/JunoMobile/JunoMobile.xcodeproj for the iPhone
   simulator UDID 8DDC140C-7953-4E85-898B-98EB44EDB1D7 and iPad simulator UDID
   3E21CD47-A52E-445F-8407-F7C847FD02EC. Use the current Xcode beta if needed.
2. Render the actual app and inspect screenshots in both light and dark mode.
   Capture before/after evidence for representative iPhone and iPad screens;
   visually review every result rather than relying on source inspection.
3. Use the current Web product at https://chat.liams.dev as design-language
   reference, while keeping the implementation idiomatic native SwiftUI and
   responsive to iPhone/iPad. The target is neutral/warm editorial surfaces,
   sparse accent color, stronger type hierarchy, quieter icons, cleaner
   sidebar/drawer, fewer arbitrary cards, no card-inside-card noise, restrained
   glass, consistent radii/spacing, modern artifacts/project/settings/model
   picker presentation, intentional Chat/Work/Code navigation, and excellent
   light/dark behavior.
4. Audit and redesign all of these, including states and chrome: Chat,
   composer, sidebar/drawer, Pinned, Projects, Project detail, Search, Library,
   Artifacts, Artifact detail, Connections, Tasks, Work, Code, Code Remote,
   Voice, Model Selector, Settings, Memory, Usage, attachments, empty/loading/
   error states, sheets, menus, and navigation chrome. Do not stop after the
   chat screen looks better.
5. Fix the design itself, not just screenshots or the checker. Add focused
   SwiftUI previews/fixtures if they make the surfaces deterministic. Rebuild,
   install, navigate, capture, and review the resulting simulator UI. Record
   exactly which screens were checked and any external limitation.

Workstream B — Gemini 3.7 Flash through Google's supported API:
1. Inspect src/lib/openai-compat.ts, src/lib/gemini-search.ts, src/lib/models.ts,
   src/lib/model-discovery-core.ts, src/lib/model-request.ts, provider tests,
   and the native model/catalog code. The normal Google chat path currently uses
   the OpenAI-compatible base URL and the catalog still retires/maps 3.7 to
   3.6; that is the incomplete part.
2. Implement a native Google Generative Language adapter for normal text chat
   using the supported `v1` or `v1beta` `models/{model}:generateContent` surface
   that the live probe proved callable. Keep the real provider model id exactly
   `gemini-3.7-flash`. Do not use a UI alias that sends 3.6.
3. Preserve the product contract: streaming if supported by the API, system/
   user/assistant message conversion, attachments and multimodal parts,
   thinking configuration, usage accounting, citations/search behavior, tool or
   function calls where the product exposes them, abort/error handling, and
   provider capability reporting. Handle the native response shape explicitly.
4. Remove the retired 3.7 -> 3.6 mapping and add 3.7 as a real selectable
   current catalog row only after the adapter sends and verifies the exact
   `gemini-3.7-flash` provider id. Update discovery, fallback, runner/native
   model catalogs, migrations, i18n, and docs as appropriate.
5. Add tests that prove request URL/body/model identity, successful native
   response parsing/streaming, attachments or multimodal behavior, usage and
   failure behavior, and that no 3.7 request silently becomes 3.6. Test the
   permission/entitlement failure path honestly if another Google API surface
   behaves differently.

Verification and closure:
- Run npm test, npm run lint, npm run build, npm run validate:models, the
  targeted model/catalog tests, native package tests, and the iOS build.
- Run E2E with the deterministic local smoke provider. If production credentials
  are available, run the authenticated browser journey against chat.liams.dev:
  login, first chat, reload, persistence, and a second successful turn. Without
  credentials, keep it explicitly blocked.
- Run npm run phase2:verify on a clean tree and inspect the generated exact-SHA
  manifest/report. Push the tested commit and run npm run phase2:ci:verify using
  the exact GitHub SHA; do not substitute an earlier workflow run.
- Recheck docs/release/JUNO_PHASE_2_ACCEPTANCE.md and status.json so every
  status says what was actually observed. Do not mark iOS design verified from
  native:design:check alone. Do not mark Gemini 3.7 unavailable from the old
  OpenAI-compatible 403 now that native Google calls returned 200.
- In the final report, include the commit SHA, exact tests, simulator screenshot
  paths, authenticated-production limitations, Gemini endpoint/model evidence,
  and the distinction between a development-signed build and a notarized
  public release.
```

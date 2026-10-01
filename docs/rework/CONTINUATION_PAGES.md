# Secondary pages, connectors, skills and artifacts — continuation 2026-10-01

Root's consolidated record of the pages lane's reports at the owner's stop. Broad implementation is stopped. Changes were captured in `b1295d77`, then externally integrated with other branches into main `133dd285`. Resume from `/Users/liammagnier/Developer/project/juno`, not the old refoundation checkout. No feature is declared fully accepted merely because its UI/API exists.

## Implemented

- `src/app/(app)/customize/` and `src/components/customize/`: working Customize hub with Apps, Skills, Routines, Memory and Instructions tabs; existing backend/page capabilities reused. `/crew` is a user-facing alias; internal `/agents` identifiers and agent-thread routing remain.
- `components/agents/agents-home.tsx`, agent face/presence/CSS: simplified crew presentation, existing faces preserved, removed decorative halos/sheen/idle loops. A new Blender character is not selected or shipped.
- `components/connections/connector-directory.tsx`, connection types and `/connections`: flat app rows, stored OAuth scope/permission details or an explicit statement when scopes are absent. Removed fake localStorage “Use in chats” permission toggles; actual `blockedConnectors` policy goes through the connector API and broker. A displayed toggle must not be treated as authority independent of the server policy.
- `src/app/api/approvals/grants/` and `components/connections/standing-grants.tsx`: owner-scoped listing and revocation of standing approval grants. Grant listing is bounded and stale grants are pruned by the actual policy path.
- Skills import/export: reconciled the already implemented `../juno-skills` branch rather than blindly replacing files. File/ZIP/paste/link importer with provenance/trust details, bounded streamed link downloads and timeout, package ingestion at `/api/skills/import/package`, exporter at `/api/work/skills/[id]/export` using the real Markdown serializer. Work library/detail/transport helpers updated. Existing stable skill identifiers remain.
- `components/library/library-home.tsx`, `library-nav.tsx`, `library-files-page.tsx`, `library-trash.tsx`, `/library` and `/artifacts`: unified Library consumes the existing `/api/library/made` union of generated artifacts and Work outputs plus uploaded files, with grid/list/search/filters/chat links and real warnings. `?view=files` preserves the full file manager; `?view=trash` opens Recently deleted. The old artifacts route is still available.
- `components/artifacts/artifact-lifecycle-actions.tsx`: shared controls in artifact read view, artifact overview and DesignWorkspace for published/pinned output, paginated versions and source comparison, base-protected restore, duplicate, download/ZIP, trash. Generic artifacts and uploaded files have real Recently deleted controls; controls are connected to existing lifecycle endpoints.
- `src/app/dev/pages/gallery.tsx`: dev-only endpoint fixtures added for settings, grants, Library made outputs and previews so actual production components can be exercised signed out. These are test fixtures, not a fabricated production backend.

## Validation actually reported

- Root found two TypeScript errors in the initial LibraryHome port (alt text and Date/timeAgo argument); the lane corrected them, then TypeScript passed at that checkpoint.
- Secondary-page desktop/mobile/light/dark gallery QA was underway. The lane reported checking 1440×1000 and 390×844 browser sizes, but no final screenshot artifact set or complete acceptance result was delivered to root before the stop. Do not claim a completed visual matrix or authenticated production inspection.
- Root's 4,498-test run failed the Library source assertion that expected its h1 in the previous route component. The new route delegates to LibraryHome/Files/Trash. A future meaningful test should assert the actual destination heading and view behavior; do not restore the obsolete page shape merely to satisfy a grep.
- Integrated main CI also failed voice-pupil CSS source-order expectations after the externally merged voice/presentation changes. Verify actual motion/reduced-motion behavior before adjusting that assertion. This lane did not report a final all-green test suite.

## Remaining gaps

1. **Binary WorkArtifact lifecycle:** binary deliverables appear in the union, but lack their own delete/restore/version API. Generic artifact/file lifecycle does not establish binary output parity. Implement and test the proper owner-scoped API before claiming all output types support those actions.
2. **Save as skill from chat:** import pending-capture helpers exist in `skill-library-model.ts`, but root did not wire the other branch's message-item “Save as skill” change. The root owns `message-item.tsx`; finish its real callback/payload flow when resumed.
3. **Native Customize:** web's unified hub is ahead of the native account-connections mapping; native feature parity needs completion, not simply a navigation alias.
4. **Production acceptance:** OAuth reconnect/scope visibility, connector blocking, standing-grant revocation, file/ZIP/link/paste imports, exported round trips and artifact conflicts/trash/restore/publish/download need authenticated real-route testing. Dev fixtures alone are insufficient.
5. Some legacy secondary pages/components still retain prior layout, naming and incidental styling. The entire website was not independently accepted as a finished redesign.

The owner stopped work before these remaining items. The new brand-name/feature-name/icon workstream is separately recorded in `BRAND_IDENTITY_WORKSTREAM.md`; none of its proposed names were applied here.

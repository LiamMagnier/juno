# Juno for macOS — Implementation Status V2

Last updated: 2026-07-26

## Current state

The greenfield `JunoDesktop` application builds under strict Swift warnings.
Chat, the iPhone-style composer, the website-style provider/model selector, and
the ground-up Juno Code studio are implemented over the current shared
production-compatible packages. No deleted macOS source or Git history was
inspected.

## Completed

- Read the current website/backend documentation, native status/research/mobile
  design/testing records, native OpenAPI contract, iPhone composition, shared
  Swift packages, Juno Code packages, web routes/components, and design tokens.
- Confirmed the live deletion state in the `main` checkout.
- Confirmed the new app can reuse the current shared auth, encrypted store,
  synchronization, Chat, project/file/artifact/memory/search, task/connector,
  and Code infrastructure without a duplicate service.
- Recorded current gaps and explicit non-reuse rules in
  `MACOS_REUSABLE_CODE_INVENTORY_V2.md`.
- Passed native contract drift verification.
- Added the `JunoDesktop` target, Debug/Next/Stable configuration files,
  resources, privacy declarations, entitlements, tests, and preview harness.
- Composed production browser authentication, Keychain credentials, encrypted
  account storage, sync/outbox, Chat, projects, library, artifacts, memory,
  search, connectors, tasks, local Code, cloud/device Code, and remote Code
  models without a second backend contract.
- Rebuilt Chat around a compact iPhone-style Liquid Glass composer.
- Added a fixed native model selector with provider rail, search, catalog,
  model detail, full account model manifest, and the same provider image assets
  used by the website/iPhone catalog.
- Added an explicit local Code model-routing boundary. Canonical Juno model
  identifiers are translated to provider model identifiers only at transport
  time; Anthropic Messages, OpenAI Chat Completions, and OpenAI Responses
  payloads and streams are handled independently. The local selector exposes
  only models the agent runtime can actually call; `juno:auto` remains a Chat
  choice because it cannot preserve a local tool-call loop.
- Reworked Juno Code from zero as one studio:
  - persistent product/Code rail;
  - Start, Runs, and Continue information architecture;
  - local/cloud/device target selection at task creation;
  - workspace/repository/device, model, reasoning, role, permission, and
    Ask/Plan/Code behavior controls beside the task prompt;
  - unified local and remote run library;
  - shared local transcript, approvals, changes, diff, terminal, tests,
    previews, files, Git, context, and Computer Use inspector;
  - enforced read-only inspection tools for Ask and Plan, with the full
    editing/delegation tool registry available only to Code;
  - a real URL-addressable ephemeral web preview and permission-backed Computer
    Use controls rather than simulated status;
  - a bounded UTF-8 native editor with containment checks, atomic
    fingerprint-checked saves, persistent checkpoints, and conflict reporting;
  - unified and side-by-side review layouts over the same diff source;
  - per-hunk Keep/Revert controls; hunk reversal validates the rendered
    content and current fingerprint, writes atomically, records a new
    checkpoint, and recomputes the surviving diff;
  - an explicit Git publish flow that resolves the real branch/upstream,
    confirms the exact target, rejects stale plans, and never force-pushes;
  - read-only GitHub pull-request and CI visibility for the current branch via
    the installed authenticated CLI, with real no-PR/unconfigured/error states;
  - cloud/device events, approvals, cancellation, and PR results;
  - remote-device continuation and follow-up controls.
- Removed the nested `NavigationSplitView`/`.inspector` composition that caused
  AppKit constraint-loop crashes and replaced it with stable explicit panes.
- Fixed the independent TCC speech-permission crash by moving the authorization
  continuation bridge out of `@MainActor` isolation.
- Removed the superseded private desktop Code layout so the studio has one
  implementation and one information-architecture owner.

## In progress

- Repeat signed XCUI interaction tests after the Mac is manually unlocked.
- Capture durable light/dark and compact/standard/wide screenshot evidence.
- Exercise production-account authentication, sync, Chat streaming, and
  cloud/device Code against live services.
- Finish remaining release and accessibility gates listed in `TESTING.md`.

## Verification record

| Gate | Result |
| --- | --- |
| Native OpenAPI → Swift drift | Pass |
| JunoNativeKit strict isolated tests | Pass — 391 tests, no failures; actor-isolation warning removed |
| JunoCode strict isolated tests | Pass — 214 tests, no failures, including provider routing, behavior enforcement, safe manual editing, checkpointed hunk review, confirmation-bound Git publication, GitHub PR/CI parsing, real vertical slice, and reconnect recovery |
| New macOS target strict build | Pass — warnings as errors, signing disabled |
| New macOS app unit tests | Pass — 2 tests, no failures |
| New macOS preview launch | Pass — Chat, Code launchpad, local session, inspector, and model selector inspected |
| Signed XCUI suite | Pending rerun — the Mac locked and XCTest reported the app as `Running Background`; this is not recorded as a product pass or failure |
| Signed live auth/sync/chat | Not run yet |
| Visual standard-size review | Pass for Code launchpad, local session, inspector, Chat composer, and provider selector |
| Visual light/dark compact/wide matrix | Not run yet |

## External release boundaries

Developer ID signing, notarization, stapling, TestFlight/App Store operations,
and production connector/provider availability require external credentials or
interactive account state. They are never inferred from a compile result.

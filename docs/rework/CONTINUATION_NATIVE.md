# Native and Code — continuation 2026-10-01

Root's consolidated record of the native/Code lane's reports and checkpoint evidence at the owner's stop. The implementation was made in the shared refoundation checkout, captured as `b1295d77`, then externally integrated with other native/agent/MCP/voice work into main `133dd285`. The old refoundation checkout is now clean at `756a93dc`. Resume from `/Users/liammagnier/Developer/project/juno` on main when the owner authorizes it. No native application was published by this continuation.

## Code runtime, protocol and control projection

- Reapplied the held verifier patch `1f119cbf` (previously reverted by `b161b935`) and reconciled it with the existing Phase 10 autonomous runtime. Full JunoCode tests passed before and after the reported parity changes; log recorded at `/tmp/juno-native-code-tests.log`.
- Native session/protocol/task projection now carries pending question/plan inputs and `question.answer` / `plan.decide` controls. macOS queues them through the session machinery; web renders `code-input-request.tsx` and waits for real host acknowledgement through the task respond API; iOS renders remote input cards. A plan approval never raises the underlying permission grant.
- Per-run usage emits `usage.updated`; protocol folding/projection distinguishes failure/interruption from completion. Tests cover the terminal transcript/projection and run index behavior.
- Files include `JunoCodeBridge/AgentProtocolProjection.swift`, `CodeTaskWireProjection.swift`, `JunoCodeCore/SessionEvents.swift`, `JunoCodeRuntime/AgentOrchestrator.swift` / `SubagentControlRegistry.swift` / `DelegateTaskTool.swift`, UI SessionController/Workbench/RunIndex/Studio controls, NativeCode task store/model, web `code-session-view.tsx`, `use-code-session.ts`, `src/lib/code-task-input.ts`, task respond route and code event/transcript files. Read the Git diff of `b1295d77` for the complete file-level patch.

## Shell, context and artifact parity

- Native Chat/Crew/Code shell presentation simplified on macOS and iOS/iPadOS; iPad keyboard navigation includes the third product. Existing faces remain. Removed decorative beams/halos; retained the functional voice behavior. Generated design tokens reflect root's neutral round-3 palette.
- `JunoChatKit/NativeContextToken.swift` and `NativeContextSuggestions.swift`: shared context representation and owner-scoped `/api/mentions` lookup; macOS/iOS compose at actual word boundaries, so an email address does not trigger suggestions. Targeted wire/token/word-boundary ChatKit tests passed. Context is preserved through the reported generation retry path.
- iOS artifact editing captures the opened baseVersion for conflict protection and keeps the draft/editor when a save fails. Added sharing of existing publication links without publishing on open and local version comparison. macOS already had much of restore/export support; the lane did not claim a complete new native lifecycle implementation.
- Native `accountCustomize` currently maps into an existing native connection/account destination. This does not implement full web-equivalent Apps/Skills/Routines/Memory/Instructions composition.
- Root updated the shared shell contract to version2 and regenerated macOS source, but the generator was still macOS-oriented. New mobile tab metadata (including search) is not a proof of a complete native projection; actual platform differences need explicit resolution/documentation.
- **Icon parity remains:** root mapped production web glyphs to approved round-3 house drawings, but did not regenerate native catalog geometry from them. Native stable enum/symbol names must be preserved while changing the drawing source. Do not claim the old native assets already match the new web family.

## Release/trust changes

- `DesktopUpdater.swift` refuses automatic replacement when the current app lacks a trusted signing Team ID. A Developer ID/Apple Development install retains team matching. This makes existing ad-hoc distribution an explicit release limitation; no independent Ed25519 signing key or signed update chain was provisioned by this lane.
- `native/Scripts/release-ios.sh` adds a local stable-SDK unsigned simulator `--check-only`, optional archive and explicitly requested upload paths, with temporary App Store Connect key isolation. The stable unsigned check passed twice, including the reported context/artifact changes. No App Store upload, TestFlight release or signed device distribution occurred.
- Shared gates were inserted into the macOS release script by the security lane; external main integration later reinstated skip controls elsewhere. Source checks and actual publication are separate facts.

## Checks and exact limits

- **JunoCode full suite:** passed at the lane checkpoints; root did not rerun it after the broader external merge.
- **ChatKit targeted tests:** passed for context serialization/lookup word boundaries and related API changes.
- **Full NativeKit suite:** stalled in an existing JunoAuthTests asynchronous waiter. The lane captured a sample; a pass for targeted ChatKit must not be described as a pass for the complete suite.
- **iOS stable SDK unsigned check:** passed twice. Simulator compilation is not real iPhone/iPad visual, voice, camera, keyboard or installed-workflow acceptance.
- **Six native design gates:** passed after fixing 68 explicit control hit regions in the Phase10 Studio/preview/goal/command UI, removing deprecated preview menu styles and reducing baseline counts (targets 197→164, menus 3→1). Contract/runtime/remote/preview checks passed at that checkpoint; typecheck passed.
- **macOS stable SDK27 build:** corrected a duplicate assistants switch case in `DesktopAccountScreens`, unused withAnimation result and deprecated Text concatenation. The lane's last report still said it was fixing notifications compile drift. Root received no final complete Mac build-pass evidence before the stop. Do not invent a successful archive.
- **Integrated native CI at 133dd285:** Web parity failed “Every chat wire field is classified”; API contract failed “Design editor bundle is current”. Design rules and Native changes detection passed; macOS/iOS/Swift package jobs were skipped in that run. Logs were saved at `/tmp/juno-native-ci-failed.log`.
- Integrated web CI has additional task/handoff source-gating assertions after other branches were merged. These remain for regression review and are not explained away by the earlier native lane pass.

## Still open when stopped

Finish the Mac stable build, resolve the full auth-test stall, project the custom icon geometry to both native catalogs, finish native Customize/shared mobile contract parity, verify pending-input host/reconnect/cancel flows on actual remote devices, validate context insertion/send/retry/reload, and check artifact conflicts/version/share/trash on real native routes. Signed/notarized Mac publication, trusted updater-key provisioning and signed iOS/App Store release remain separate authorized release work.

The source snapshot is preserved on main. Any work that had not landed in `b1295d77` when the external session moved/reset the shared checkout must be recovered from actual tool logs or source before claiming it present; root's final Git inspection found no remaining native source changes in either checkout. The owner stopped development before complete cross-platform acceptance.

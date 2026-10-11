# Restricted Chat folder commands

This change depends on the native build fixes in PR #83. The baseline at
`58cd3739d283088491fc67be710fb8f1c92e267f` ran Chat commands without containment
when sandbox-exec was missing, then warned after execution. Its Code profile also
permitted document reads outside the Chat grant and writes to global temp/caches.

## Implemented boundary

- CommandExecutionService.contained never changes to developer mode. Missing
  containment refuses before launch. An explicitly constructed developer executor
  with no sandbox remains available to separately authorized Code workflows.
- Chat checks containment before requesting approval and again after it. It checks
  cancellation and grant revocation after approvals; uncontained outcomes cannot
  count as successful.
- Chat uses a dedicated default-deny profile: document reads/writes in the canonical
  folder, system runtime reads, no network, no global temp/home-cache write grants.
  zsh needs to open `/` during startup; only that directory itself is allowed, not
  descendant document contents. Metadata remains readable for runtime path lookup.
- The strict profile keeps the canonical grant path rather than resolving a
  replacement root symlink into a broader grant. GrantAccess detects changed root
  resolution, retains the original canonical root, and frees its realpath buffer.
- Removing/changing a grant or stopping a turn cancels active calls. Active duplicate
  call ids refuse. Approval cancellation cannot leave an executable call waiting.
- A cancelled command iterator reports cancellation rather than a misleading launch
  failure when it ends before the terminal event.

## Verified locally

Xcode 27.0 / Swift 6.4, signing disabled. Test data only; no real credentials,
real documents or production database were used.

- Full strict JunoCode package suite passed after the changes.
- Full strict JunoWork package suite passed, including missing containment before
  approval, loss of containment while approving, grant revocation while approving,
  uncontained-result rejection and existing traversal/read-only boundaries.
- Seven real kernel tests passed: authorized read/write, sibling read/write refusal,
  symlink escape, configured-root replacement, fixture credentials, socket denial
  (including loopback/private endpoint; assert EPERM rather than a closed port),
  and cancellation before a delayed mutation. Zero unauthorized fixture operations.
- Strict Mac app tests compiled and DesktopChatFolderTests passed, including real
  in-flight command cancellation on folder revocation and turn stop. Both tests
  wait for a started marker before stopping and assert the delayed mutation did
  not occur; active duplicate delivery refuses.

Local raw logs are under `/tmp/alevr-quality-evidence/folder-*-verified.log`;
Mac app final log is `folder-desktop-complete.log`. These are local execution
records, not three release candidates or physical iPhone acceptance.

## Residual limitations

Seatbelt/sandbox-exec is deprecated; a future execution service or VM is warranted.
System runtime reads and metadata visibility are explicit exceptions. This suite
covers command sandbox boundaries and selected existing file-service tests; it does
not prove every filesystem race, kernel exploit, prompt injection or external app
boundary safe. Other computer-use and cloud Work credential boundaries remain
separate acceptance work. No production deployment or release was performed.

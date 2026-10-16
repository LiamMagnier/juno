# Computer-use reliability: Alevr 1.11.2

## OpenAI research and implementation boundary

Reviewed official documentation on 16 October 2026. These sources describe
public behavior and integration contracts, not Codex's private implementation.
Alevr applies the documented principles; this release does not establish
feature parity, identical model quality, or locked-use support.

- [Computer Use](https://learn.chatgpt.com/docs/computer-use): macOS supports
  background app control, app-specific access, persistent approvals and user
  takeover. Structured integrations are preferred when they can do the work.
  Alevr already has app grants, background input, app ownership and emergency
  Stop; this release strengthens their execution path.
- [Browser and desktop drivers](https://developers.openai.com/api/docs/guides/tools-computer-use-sdk-drivers):
  actions execute once and in order, driver failures must be explicit, and
  actions and screenshots must share a coordinate system. This informed the
  numeric validation, batch limits and failed-typing behavior below.
- [Integration recipes](https://developers.openai.com/api/docs/guides/tools-computer-use-integration):
  capture after action batches, preserve useful screenshot resolution and
  enforce consent in the runtime. Alevr retains its prepare/approve/perform
  checks and final-frame behavior. Observation caching never caches images
  or permission decisions; full-display captures still discover exclusions
  afresh.

## Confirmed failures and changes

The installed 1.11.1 (108) crash report, incident
`450FC32E-056F-431F-94FE-576D170FDFC9`, matches the archived arm64 dSYM UUID
`16E288B8-68F0-366E-8AB8-9A1236A255ED`. Symbolication identifies
`ScreenControlService.accessibility` calling `captureFrame` while an
optional-chain assignment holds a write access to `sessions`. The new
cold-accessibility test aborts with “Fatal access conflict detected” before
the fix and passes afterward. Capture now finishes before the assignment,
and session generation is rechecked before committing its result.

Additional changes:

- Accessibility metadata is read in one batched IPC request per node;
  secure-field values remain excluded. Traversal deduplicates cycles and
  bounds queued nodes, depth, elapsed time and individual IPC waits. Partial
  trees are explicitly identified. Cancellation clears old element references.
- Consecutive background window captures share discovery for 750 ms, with
  concurrent discovery coalesced. Each image is fresh, geometry is read live,
  window identity includes PID, and missing windows invalidate discovery.
  Failed capture invalidates the cache without retrying input.
- Oversized and non-integral arguments are rejected without trapping Swift
  integer conversions. Extreme zoom bounds are clamped before conversion.
- Batches enforce the advertised 20-action limit before performing anything.
  Verified partial typing is a failure, stopping dependent actions; input is
  never replayed automatically.

## Validation

Run `bash scripts/native-test.sh JunoScreenControl JunoCode`. The regression
tests cover the cold-controls crash, cached-frame reuse, unavailable images,
Stop/deactivation during capture, cyclic/wide/slow trees, cache coalescing,
expiry/invalidation, numeric boundaries and partial typing.

Opt-in real-Mac check:
`JUNO_LIVE_SCREEN_TESTS=1 JUNO_SWIFT_FILTER=SystemScreenDriversLiveTests bash scripts/native-test.sh JunoScreenControl`.
It opens Calculator in the background, reads its actual controls and captures
two real images without posting input. Missing macOS grants cause an explicit
skip. On this Mac it passed: 35 AX nodes; cold capture 145 ms, warm capture
42 ms. These are individual local observation timings, not end-to-end agent
latency or a comparison with Codex.

The release script additionally runs shared repository gates, env-server
tests, desktop tests, signing and updater-feed verification. Development-signed
builds remain prereleases; no notarization claim is made.

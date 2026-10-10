# Native voice: status

Branch `polish/native-voice` (from `origin/main` e3c6f6b6d). Two jobs, from the
owner: make iOS chat voice mode work (the model neither hears nor speaks on the
iPhone, while the Mac works), and replace the old voice-mode and dictation
visuals on iOS and the Mac with the website's current design.

## State at pause (2026-10-10)

Paused at the coordinator's request: the Mac was swapping (load average about
900) with several agents compiling at once. All my builds were stopped and the
simulator I booted ("Voice iPhone", B1A0FD84) is shut down. **Nothing on this
branch has been compiled yet.** The first step on resume is a package build,
then the iOS and Mac builds.

### iOS voice bug: findings so far (root cause NOT yet confirmed)

The cause is not settled. The harness that would show it never got to run on
the overloaded machine (the simulator took more than 10 minutes to boot and
then never launched the test host).

What has been ruled out by reading the code:

- **The relay and the token are the same on both platforms.** iOS and the Mac
  build `JunoRealtimeVoiceController` the same way, and both get the relay URL
  from `/api/voice/relay-token`. That route has no platform logic.
- **Info.plist is fine.** `NSMicrophoneUsageDescription`,
  `NSSpeechRecognitionUsageDescription` and `UIBackgroundModes: audio` are all
  present.
- **Permission.** iOS uses `AVAudioApplication.requestRecordPermission`, which
  is correct.
- **The session is set before the engine starts.** `startAudioEngine()` sets
  `.playAndRecord` / `.voiceChat` / `[.defaultToSpeaker, .allowBluetoothHFP]`
  and calls `setActive(true)` before it builds the graph.

What is iOS-only in the path, and so still a suspect:

1. **The unified graph.** On iOS the capture and playback share one
   `AVAudioEngine` (the Mac uses two), and voice processing is requested on
   the input node. If that engine is not rendering, both directions fail
   together, which matches the report: no uplink means the model never hears,
   and with nothing heard there is no reply. A stopped engine also leaves
   scheduled playback buffers never completing, and
   `RealtimePlaybackDrain.isActive` then holds the uplink suppressed.
2. **The uplink needs float buffers.** `VoiceRelayShuttle.processMic` returns
   early unless `buffer.floatChannelData` is non-nil. It ignores the
   `AVAudioConverter` it was configured with and hand-downsamples. If the
   voice-processed iOS input format is not deinterleaved Float32, no frame is
   ever sent and the meter stays at zero.
3. **`JunoMobileVoiceAudioSession`** mutes the call on any
   `interruptionNotification .began` and unmutes only when `.shouldResume` is
   set. A spurious "began" at session activation, which iOS can deliver with
   `wasSuspended`, would leave the call muted with no visible cause.
4. **Dictation leaves the shared session active** (`JunoSpeechService`
   teardown does not deactivate it: `.playAndRecord` / `.spokenAudio`). Voice
   resets the category, so this is lower on the list.

### The test that will settle it

`native/iOS/JunoMobile/Tests/JunoMobileVoiceAudioTests.swift` (new, and in the
regenerated xcodeproj) runs a whole call on the phone's real audio stack,
hosted in the app, against a WebSocket relay in the same process (`NWListener`).
It asserts three things:

- PCM from the microphone reaches the relay;
- a tone sent down the socket becomes `playbackAudible`;
- the microphone is heard again once the reply drains.

Grant the microphone first:
`xcrun simctl privacy <udid> grant microphone com.liammagnier.JunoMobile.debug`.
Run it with
`-only-testing:JunoMobileTests/JunoMobileVoiceAudioTests`. Whichever assertion
fails points at suspect 1, 2 or 3 above.

### Redesign: written, not yet compiled

- **`JunoDesignSystem/JunoVoiceGlow.swift`** is rewritten as a port of the
  website's voice light. It covers the engine (`voice-glow-engine.ts`: rest
  pose, 45/150 ms envelopes, the handoff beam of 6 × 70 ms steps re-passing
  every 1.6 s, Reduce Motion poses), the palette (ember and presence ink, light
  and dark) and the renderer (the edge walked by arc length from the bottom
  centre, a 1pt edge, an outer falloff, an inner rim, additive on dark, and a
  solid edge under Reduce Transparency).
- The new API is `JunoVoiceGlow(mode:you:alevr:cornerRadius:)`, where
  `JunoVoiceGlowMode` is `.you`, `.alevr`, `.thinking`, `.muted` or `.off`.
- **Removed:** `JunoVoiceAura`, `JunoVoiceOrb`, the old multi-hue band, the
  `glowBands` bridge, and the old glow tests. Their replacement is
  `JunoVoiceGlowEngineTests`, a port of `tests/voice-glow-engine.test.ts`.
- **Controller:** it now publishes `micLoudness` and `replyLoudness`, so the
  light draws each voice from its own audio. `JunoSpeechService` publishes
  `loudness` and `loudnessHistory`, and has a DEBUG preview take.
- **iOS:**
  - The call glow sits on the composer card's own edge.
  - The full-screen call is a glass disc carrying the same light; the orb and
    the aura are gone.
  - Dictation is rebuilt as the composer card listening: the words in the
    field, a live waveform row with ✕, ✓ and ↑ in the composer's positions, and
    ember on the edge.
  - The composer cross-fades the two cards in one bottom-aligned cell.
  - The DEBUG flag `--juno-preview-dictation idle|listening|transcribed` puts
    it in a fixed state for screenshots.
- **Mac:**
  - The call glow uses the new light and is no longer clipped to the shell.
  - Dictation now wears the light, in ember.
  - The `junoPreviewDictation` environment hook is there for snapshots.
  - Not touched: `DesktopDictation.swift`, which only the Code product uses.

### Still to do

1. Build. Then run the voice harness and fix the root cause it shows.
2. Check that the custom light renders correctly, in particular the circular
   arcs against the `.continuous` corners of the glass card.
3. Screenshots and frame strips, iOS and Mac, light and dark: dictation idle,
   listening and transcribed; voice listening and speaking. They go in
   `.claude/handoff/native-voice/`.
4. Gates: `JunoMobileTests`, `JunoDesktopTests`, the JunoNativeKit tests, and
   `npm run native:design:check`.

import XCTest
@testable import JunoVoiceKit

/// The realtime session lifecycle, exercised without a microphone or a relay.
///
/// This is the reason ``RealtimeSessionMachine`` exists as a value rather than as
/// branches inside `JunoRealtimeVoiceController`: reconnect and barge-in are the
/// two most failure-prone paths in the voice stack, and against real hardware the
/// only way to reach either is to unplug something mid-call.
final class RealtimeSessionMachineTests: XCTestCase {

    private func capabilities(
        video: Bool = false,
        screen: Bool = false,
        trueS2S: Bool = true,
        clientTranscript: Bool = false,
        maxSessionSec: Int = 900
    ) -> JunoVoiceCapabilities {
        JunoVoiceCapabilities(
            videoInput: video,
            screenInput: screen,
            trueS2S: trueS2S,
            needsClientTranscript: clientTranscript,
            maxSessionSec: maxSessionSec
        )
    }

    /// Drives a machine to `listening`, returning it ready for the interesting part.
    private func liveMachine(
        bargeIn: RealtimeBargeInPolicy = .automatic
    ) -> RealtimeSessionMachine {
        var machine = RealtimeSessionMachine(provider: .openai, bargeIn: bargeIn)
        machine.apply(.start)
        machine.apply(.transportOpened)
        machine.apply(.sessionReady(provider: .openai, capabilities: capabilities()))
        return machine
    }

    // MARK: Opening

    /// Audio comes up before the socket. A reconnect onto a stopped engine is a
    /// conversation with no audio in either direction and nothing to explain it.
    func testOpeningBringsAudioUpBeforeTheSocket() {
        var machine = RealtimeSessionMachine(provider: .openai)

        let effects = machine.apply(.start)

        XCTAssertEqual(effects, [.startAudio, .openTransport])
        XCTAssertEqual(machine.phase, .connecting)
    }

    func testNegotiationCompletesOnlyWhenTheRelaySaysSo() {
        var machine = RealtimeSessionMachine(provider: .openai)
        machine.apply(.start)

        XCTAssertEqual(machine.apply(.transportOpened), [.sendSessionStart])
        XCTAssertEqual(machine.phase, .negotiating)
        XCTAssertNil(machine.capabilities, "nobody has been told what this session can do yet")

        let ready = machine.apply(
            .sessionReady(provider: .gemini, capabilities: capabilities(video: true))
        )

        XCTAssertEqual(ready, [.setUplinkSuppressed(false)])
        XCTAssertEqual(machine.phase, .listening)
        XCTAssertEqual(machine.provider, .gemini, "the relay may substitute a provider")
        XCTAssertEqual(machine.capabilities?.videoInput, true)
    }

    /// A second start on a live session must not open a second socket onto one
    /// audio graph — the double-tap case.
    func testStartIsIgnoredWhileASessionIsAlreadyRunning() {
        var machine = liveMachine()

        XCTAssertEqual(machine.apply(.start), [])
        XCTAssertEqual(machine.phase, .listening)
    }

    // MARK: Half-duplex

    func testTheUplinkIsSuppressedExactlyWhileTheModelHoldsTheFloor() {
        var machine = liveMachine()

        XCTAssertEqual(machine.apply(.assistantTurnBegan), [.setUplinkSuppressed(true)])
        XCTAssertEqual(machine.phase, .responding)

        XCTAssertEqual(machine.apply(.assistantTurnEnded), [.setUplinkSuppressed(false)])
        XCTAssertEqual(machine.phase, .listening)
    }

    /// The relay and this client agreeing late is not an error.
    func testATurnEndingWhileTheReaderAlreadyHasTheFloorDoesNothing() {
        var machine = liveMachine()

        XCTAssertEqual(machine.apply(.assistantTurnEnded), [])
        XCTAssertEqual(machine.phase, .listening)
    }

    // MARK: Barge-in

    /// Local playback is flushed **before** the relay is told, because the queued
    /// buffers are already on the player node: waiting for the relay means the
    /// model keeps talking over the interruption for a whole round trip.
    func testTalkingOverTheAnswerFlushesLocallyBeforeTellingTheRelay() {
        var machine = liveMachine(bargeIn: .automatic)
        machine.apply(.assistantTurnBegan)

        let effects = machine.apply(.userSpeechDetected)

        XCTAssertEqual(effects, [.flushPlayback, .sendInterrupt, .setUplinkSuppressed(false)])
        XCTAssertEqual(machine.phase, .interrupting)
    }

    /// Without echo cancellation the microphone hears the speakers, so "someone
    /// is talking" is the model talking — and automatic barge-in becomes a
    /// session that interrupts itself after the first syllable of every answer.
    func testDetectedSpeechIsIgnoredWhenTheHardwareCannotCancelEcho() {
        var machine = liveMachine(bargeIn: .manualOnly)
        machine.apply(.assistantTurnBegan)

        XCTAssertEqual(machine.apply(.userSpeechDetected), [])
        XCTAssertEqual(machine.phase, .responding)
    }

    /// The on-screen control is the interruption that is always available, which
    /// is what makes `manualOnly` a usable mode rather than a broken one.
    func testTheInterruptControlWorksEvenWithoutEchoCancellation() {
        var machine = liveMachine(bargeIn: .manualOnly)
        machine.apply(.assistantTurnBegan)

        let effects = machine.apply(.interruptRequested)

        XCTAssertEqual(effects, [.flushPlayback, .sendInterrupt, .setUplinkSuppressed(false)])
        XCTAssertEqual(machine.phase, .interrupting)
    }

    /// A second interrupt into the same window is a frame the relay bills for and
    /// discards.
    func testASecondInterruptIsNotSentWhileTheFirstIsOutstanding() {
        var machine = liveMachine(bargeIn: .automatic)
        machine.apply(.assistantTurnBegan)
        machine.apply(.interruptRequested)

        XCTAssertEqual(machine.apply(.interruptRequested), [])
        XCTAssertEqual(machine.apply(.userSpeechDetected), [])
        XCTAssertEqual(machine.phase, .interrupting)
    }

    /// The relay answers a barge-in with either an acknowledgement or the end of
    /// the turn. Both have to land the reader back on the floor.
    func testEitherRelayAnswerEndsTheInterruption() {
        var acknowledged = liveMachine()
        acknowledged.apply(.assistantTurnBegan)
        acknowledged.apply(.interruptRequested)
        XCTAssertEqual(acknowledged.apply(.relayInterrupted), [])
        XCTAssertEqual(acknowledged.phase, .listening)

        var turnEnded = liveMachine()
        turnEnded.apply(.assistantTurnBegan)
        turnEnded.apply(.interruptRequested)
        XCTAssertEqual(turnEnded.apply(.assistantTurnEnded), [.setUplinkSuppressed(false)])
        XCTAssertEqual(turnEnded.phase, .listening)
    }

    /// The model starting its next answer while the interruption is outstanding
    /// has to re-suppress the uplink, or the session is half-duplex in name only.
    func testANewTurnDuringAnInterruptionTakesTheFloorBack() {
        var machine = liveMachine()
        machine.apply(.assistantTurnBegan)
        machine.apply(.interruptRequested)

        XCTAssertEqual(machine.apply(.assistantTurnBegan), [.setUplinkSuppressed(true)])
        XCTAssertEqual(machine.phase, .responding)
    }

    /// A relay-initiated interruption still has to reach the speaker, or the
    /// answer keeps playing after the model has moved on.
    func testARelayInitiatedInterruptionFlushesPlayback() {
        var machine = liveMachine()
        machine.apply(.assistantTurnBegan)

        let effects = machine.apply(.relayInterrupted)

        XCTAssertEqual(effects, [.flushPlayback, .setUplinkSuppressed(false)])
        XCTAssertEqual(machine.phase, .listening)
    }

    // MARK: Reconnect

    /// The budget is *earned* by reaching live. A socket that drops before
    /// `session.ready` was almost certainly refused, and retrying a refusal costs
    /// the backend a token mint per attempt.
    func testADropBeforeTheSessionIsUpFailsRatherThanRetrying() {
        var machine = RealtimeSessionMachine(provider: .openai)
        machine.apply(.start)
        machine.apply(.transportOpened)

        let effects = machine.apply(.transportFailed("socket closed"))

        XCTAssertEqual(effects, [.stopAudio, .closeTransport(normally: false)])
        XCTAssertEqual(machine.phase, .failed(.transport("socket closed")))
    }

    func testADropAfterTheSessionIsUpReconnectsOnceAndClearsCapabilities() {
        var machine = liveMachine()
        machine.apply(.assistantTurnBegan)

        let effects = machine.apply(.transportFailed("dropped"))

        XCTAssertEqual(
            effects,
            [
                .flushPlayback,
                .setUplinkSuppressed(false),
                .closeTransport(normally: false),
                .scheduleReconnect,
            ]
        )
        XCTAssertEqual(machine.phase, .reconnecting)
        XCTAssertNil(
            machine.capabilities,
            "capabilities describe the negotiated session, not the account"
        )
        XCTAssertFalse(machine.reconnectAvailable, "the budget is spent")
    }

    func testASecondDropBeforeRecoveringFails() {
        var machine = liveMachine()
        machine.apply(.transportFailed("dropped"))
        machine.apply(.transportOpened)

        let effects = machine.apply(.transportFailed("dropped again"))

        XCTAssertEqual(effects, [.stopAudio, .closeTransport(normally: false)])
        XCTAssertEqual(machine.phase, .failed(.transport("dropped again")))
    }

    /// Per outage, not per session: a call that recovered has earned another
    /// attempt if it drops again ten minutes later.
    func testRecoveringRefundsTheReconnectBudget() {
        var machine = liveMachine()
        machine.apply(.transportFailed("dropped"))
        machine.apply(.transportOpened)
        machine.apply(.sessionReady(provider: .openai, capabilities: capabilities()))

        XCTAssertEqual(machine.phase, .listening)
        XCTAssertTrue(machine.reconnectAvailable)
        XCTAssertEqual(machine.apply(.transportFailed("again")).last, .scheduleReconnect)
    }

    /// A reconnect that dropped mid-answer arrives at `session.ready` with the
    /// uplink still suppressed, and an uplink nobody un-suppresses is a
    /// microphone that never works again for the rest of the call.
    func testRecoveringAlwaysUnsuppressesTheUplink() {
        var machine = liveMachine()
        machine.apply(.assistantTurnBegan)
        machine.apply(.transportFailed("dropped"))
        machine.apply(.transportOpened)

        let effects = machine.apply(
            .sessionReady(provider: .openai, capabilities: capabilities())
        )

        XCTAssertEqual(effects, [.setUplinkSuppressed(false)])
    }

    // MARK: Relay trouble

    /// Once audio is flowing, an `error` frame means "that turn had a problem".
    /// Hanging up on it would end conversations that were fine.
    func testARelayErrorMidSessionIsANoticeAndNotAnEnding() {
        var machine = liveMachine()

        let effects = machine.apply(.relayError("that image was too large"))

        XCTAssertEqual(effects, [.notice("that image was too large")])
        XCTAssertEqual(machine.phase, .listening)
    }

    func testARelayErrorBeforeTheSessionIsUpIsFatal() {
        var machine = RealtimeSessionMachine(provider: .openai)
        machine.apply(.start)
        machine.apply(.transportOpened)

        let effects = machine.apply(.relayError("budget exceeded"))

        XCTAssertEqual(effects, [.stopAudio, .closeTransport(normally: true)])
        XCTAssertEqual(machine.phase, .failed(.relay("budget exceeded")))
    }

    /// Running out of session time is an ending, not a failure — offering
    /// "Something went wrong" for it trains people to distrust the error copy
    /// that matters.
    func testHittingTheSessionLimitClosesRatherThanFails() {
        var machine = liveMachine()

        let effects = machine.apply(.relayClosed(.sessionLimit))

        XCTAssertEqual(effects, [.stopAudio, .closeTransport(normally: true)])
        XCTAssertEqual(machine.phase, .closed(.sessionLimit))
    }

    /// No reconnect budget is spent on a microphone failure: the socket is fine,
    /// and reopening it would not put a microphone back.
    func testAnAudioFailureDoesNotTriggerAReconnect() {
        var machine = liveMachine()

        let effects = machine.apply(.audioFailed("input device disappeared"))

        XCTAssertEqual(effects, [.stopAudio, .closeTransport(normally: true)])
        XCTAssertEqual(machine.phase, .failed(.audio("input device disappeared")))
    }

    // MARK: Ending

    /// Both the close button and the view's disappearance send this, in either
    /// order.
    func testEndWinsFromEveryPhaseAndIsIdempotent() {
        for phase in [
            RealtimeSessionPhase.connecting, .negotiating, .listening, .responding,
            .interrupting, .reconnecting,
        ] {
            var machine = RealtimeSessionMachine(provider: .openai, phase: phase)
            XCTAssertEqual(
                machine.apply(.end),
                [.stopAudio, .closeTransport(normally: true)],
                "end was ignored from \(phase)"
            )
            XCTAssertEqual(machine.phase, .closed(.client))
            XCTAssertEqual(machine.apply(.end), [], "a second end must do nothing")
        }
    }

    /// A session that already ended with the relay's reason keeps it: overwriting
    /// it with "client" loses the only explanation the reader is going to get.
    func testEndDoesNotOverwriteAReasonTheRelayAlreadyGave() {
        var machine = liveMachine()
        machine.apply(.relayClosed(.sessionLimit))

        XCTAssertEqual(machine.apply(.end), [])
        XCTAssertEqual(machine.phase, .closed(.sessionLimit))
    }

    func testStartingAgainAfterAFailureIsAllowedAndResetsCapabilities() {
        var machine = liveMachine()
        machine.apply(.transportFailed("dropped"))
        machine.apply(.transportOpened)
        machine.apply(.transportFailed("dropped again"))
        XCTAssertEqual(machine.phase, .failed(.transport("dropped again")))

        XCTAssertEqual(machine.apply(.start), [.startAudio, .openTransport])
        XCTAssertEqual(machine.phase, .connecting)
        XCTAssertNil(machine.capabilities)
    }

    // MARK: Unexpected pairs

    /// A realtime session receives events from a network peer and a hardware
    /// callback. The correct response to "that cannot happen" is to ignore it,
    /// not to end a conversation someone is having.
    func testUnexpectedEventsAreIgnoredRatherThanFatal() {
        var machine = RealtimeSessionMachine(provider: .openai)

        XCTAssertEqual(machine.apply(.assistantTurnBegan), [])
        XCTAssertEqual(machine.apply(.relayInterrupted), [])
        XCTAssertEqual(machine.apply(.transportOpened), [])
        XCTAssertEqual(machine.phase, .idle)
    }
}

// MARK: - Voice activity

/// The detector that decides whether the reader is talking over the answer.
final class RealtimeVoiceActivityDetectorTests: XCTestCase {

    /// One loud frame is a cough, a chair, or the plosive at the start of the
    /// model's own word.
    func testASingleLoudFrameDoesNotCountAsSpeech() {
        var detector = RealtimeVoiceActivityDetector(onsetFrames: 3)

        XCTAssertNil(detector.observe(loudness: 0.9))
        XCTAssertFalse(detector.isSpeaking)
    }

    func testSustainedSpeechFiresOnceOnTheOnsetFrame() {
        var detector = RealtimeVoiceActivityDetector(onsetFrames: 3)

        XCTAssertNil(detector.observe(loudness: 0.9))
        XCTAssertNil(detector.observe(loudness: 0.9))
        XCTAssertEqual(detector.observe(loudness: 0.9), .began)
        XCTAssertTrue(detector.isSpeaking)
        XCTAssertNil(detector.observe(loudness: 0.9), "onset is an edge, not a level")
    }

    /// Speech dips between syllables. A symmetric threshold turns one sentence
    /// into six utterances.
    func testTheHysteresisBandHoldsThroughTheGapBetweenSyllables() {
        var detector = RealtimeVoiceActivityDetector(
            onsetThreshold: 0.34, releaseThreshold: 0.20, onsetFrames: 2, releaseFrames: 4
        )
        _ = detector.observe(loudness: 0.6)
        XCTAssertEqual(detector.observe(loudness: 0.6), .began)

        // In the band: neither loud enough to reinforce nor quiet enough to end.
        for _ in 0..<20 { XCTAssertNil(detector.observe(loudness: 0.27)) }
        XCTAssertTrue(detector.isSpeaking)
    }

    func testSpeechEndsOnlyAfterASustainedQuietRun() {
        var detector = RealtimeVoiceActivityDetector(
            onsetThreshold: 0.34, releaseThreshold: 0.20, onsetFrames: 1, releaseFrames: 3
        )
        XCTAssertEqual(detector.observe(loudness: 0.8), .began)

        XCTAssertNil(detector.observe(loudness: 0.05))
        XCTAssertNil(detector.observe(loudness: 0.05))
        XCTAssertEqual(detector.observe(loudness: 0.05), .ended)
        XCTAssertFalse(detector.isSpeaking)
    }

    /// Room tone must never reach onset, or every silent pause interrupts the
    /// model.
    func testRoomToneNeverReachesOnsetAtTheShippedDefaults() {
        var detector = RealtimeVoiceActivityDetector()
        // −60 dBFS and below: fans, a quiet office, a distant street.
        for _ in 0..<200 {
            XCTAssertNil(detector.observe(loudness: RealtimeLoudness.normalized(0.001)))
        }
        XCTAssertFalse(detector.isSpeaking)
    }

    /// And ordinary speech must reach it quickly, or barge-in feels broken.
    func testOrdinarySpeechReachesOnsetAtTheShippedDefaults() {
        var detector = RealtimeVoiceActivityDetector()
        // ≈ −34 dBFS — someone talking normally at a laptop.
        let ordinary = RealtimeLoudness.normalized(0.02)
        var began = false
        for _ in 0..<6 where !began {
            began = detector.observe(loudness: ordinary) == .began
        }
        XCTAssertTrue(began, "a normal voice must be able to interrupt the model")
    }

    /// The floor changing hands invalidates the run: frames counted while the
    /// model was talking must not decide anything about the reader who just got
    /// the microphone back.
    func testResetClearsTheRunWithoutLeavingSpeechLatched() {
        var detector = RealtimeVoiceActivityDetector(onsetFrames: 2)
        _ = detector.observe(loudness: 0.9)
        detector.reset()

        XCTAssertFalse(detector.isSpeaking)
        XCTAssertNil(detector.observe(loudness: 0.9), "the earlier frame must not still count")
    }
}

// MARK: - Barge-in policy

final class RealtimeBargeInPolicyTests: XCTestCase {

    /// An endpoint that cannot say whether it is cancelling echo has not said
    /// that it is. Treating silence as a yes is the difference between a feature
    /// being unavailable and a call that hangs up on itself.
    func testUnknownEchoCancellationResolvesToManualOnly() {
        XCTAssertEqual(RealtimeBargeInPolicy(echoCancellation: .unknown), .manualOnly)
        XCTAssertEqual(RealtimeBargeInPolicy(echoCancellation: .unavailable), .manualOnly)
        XCTAssertEqual(RealtimeBargeInPolicy(echoCancellation: .active), .automatic)
    }
}

final class RealtimeAudioGraphPlanTests: XCTestCase {
    func testPlatformTopologyIsPinned() {
        #if os(macOS)
        XCTAssertEqual(RealtimeAudioGraphPlan.current.topology, .splitCapturePlayback)
        #else
        XCTAssertEqual(RealtimeAudioGraphPlan.current.topology, .unifiedDuplex)
        #endif
    }

    func testVoiceProcessingFallsBackToRawInputExactlyOnce() {
        XCTAssertEqual(RealtimeAudioGraphPlan.current.voiceProcessingAttempts, [true, false])
    }
}

// MARK: - Echo cancellation, as read from the node

/// The gate that decides whether talking over Juno is allowed to interrupt it.
///
/// These are the assertions that make it safe to request the voice-processing
/// unit on iOS as well as macOS: the request is not an input to the answer, so
/// asking on a second platform cannot, by construction, turn barge-in on
/// anywhere the hardware did not.
final class RealtimeEchoCancellationTests: XCTestCase {

    /// The whole safety property in one test. The resolver is handed the node's
    /// own `isVoiceProcessingEnabled` and nothing else — no request to trust, no
    /// `AVAudioSession.mode` to infer from — so a phone that asked for the unit
    /// and did not get it reads exactly like a phone that never asked.
    func testResolutionFollowsTheNodeAndNotTheRequest() {
        XCTAssertEqual(
            RealtimeEchoCancellation.fromInputNode(reportsVoiceProcessing: true), .active
        )
        XCTAssertEqual(
            RealtimeEchoCancellation.fromInputNode(reportsVoiceProcessing: false), .unavailable
        )
    }

    /// End to end through the policy, which is the pair the audio graph actually
    /// evaluates once `engine.start()` has returned. Asking for the unit is not
    /// what turns automatic barge-in on; the node reporting it back is.
    func testOnlyANodeThatReportsTheUnitEarnsAutomaticBargeIn() {
        XCTAssertEqual(
            RealtimeBargeInPolicy(
                echoCancellation: .fromInputNode(reportsVoiceProcessing: true)
            ),
            .automatic
        )
        XCTAssertEqual(
            RealtimeBargeInPolicy(
                echoCancellation: .fromInputNode(reportsVoiceProcessing: false)
            ),
            .manualOnly,
            "a request that the unit refused must leave the call exactly where it was"
        )
    }

    /// ``RealtimeEchoCancellation/unknown`` is "no graph", which is a third answer
    /// and not a pessimistic second one. A reading of a node that is running can
    /// never mean it, and a caller that tells the two apart — "not started" and
    /// "started without a canceller" want different UI — depends on that.
    func testANodeReadingNeverAnswersUnknown() {
        for reported in [true, false] {
            XCTAssertNotEqual(
                RealtimeEchoCancellation.fromInputNode(reportsVoiceProcessing: reported),
                .unknown
            )
        }
    }
}

// MARK: - Input format sanity

/// Whether the voice processor left the input node describing something a
/// capture graph can be built on — the check that decides between withdrawing
/// the unit and keeping the call, and failing the whole attempt.
final class RealtimeInputFormatTests: XCTestCase {

    func testOrdinaryHardwareFormatsAreUsable() {
        for rate in [8_000.0, 16_000, 24_000, 44_100, 48_000, 96_000] {
            XCTAssertTrue(RealtimeInputFormat.isUsable(sampleRate: rate, channelCount: 1))
            XCTAssertTrue(RealtimeInputFormat.isUsable(sampleRate: rate, channelCount: 2))
        }
    }

    /// What an aggregate device, a driver with no voice-processing unit, or a
    /// phone whose route changed under the request leaves behind. Recoverable:
    /// the graph withdraws voice processing and re-reads rather than giving up.
    func testANodeLeftDescribingNothingRecordableIsNotUsable() {
        XCTAssertFalse(RealtimeInputFormat.isUsable(sampleRate: 0, channelCount: 1))
        XCTAssertFalse(RealtimeInputFormat.isUsable(sampleRate: 48_000, channelCount: 0))
        XCTAssertFalse(RealtimeInputFormat.isUsable(sampleRate: -48_000, channelCount: 1))
        XCTAssertFalse(RealtimeInputFormat.isUsable(sampleRate: 0, channelCount: 0))
    }

    /// The case the two old inline spellings both missed. `Double.nan` is neither
    /// `<= 0` nor `> 0`, so it slipped past the "withdraw and re-read" branch *and*
    /// past the "this rung is finished" guard — and the uplink divides by the
    /// sample rate, where `AVAudioFrameCount(_:)` traps on NaN and infinity rather
    /// than saturating, on the realtime audio thread.
    func testNonFiniteSampleRatesAreNotUsable() {
        XCTAssertFalse(RealtimeInputFormat.isUsable(sampleRate: .nan, channelCount: 1))
        XCTAssertFalse(RealtimeInputFormat.isUsable(sampleRate: .infinity, channelCount: 1))
        XCTAssertFalse(RealtimeInputFormat.isUsable(sampleRate: -.infinity, channelCount: 1))
        XCTAssertFalse(
            RealtimeInputFormat.isUsable(sampleRate: .signalingNaN, channelCount: 2)
        )
    }

    /// No upper bound, on purpose. A 384 kHz interface is a real thing a person
    /// owns and the converter downsamples whatever arrives — refusing one would
    /// trade a call that happens for a hazard that does not exist.
    func testUnusuallyHighRatesAreStillUsable() {
        XCTAssertTrue(RealtimeInputFormat.isUsable(sampleRate: 192_000, channelCount: 1))
        XCTAssertTrue(RealtimeInputFormat.isUsable(sampleRate: 384_000, channelCount: 8))
    }
}

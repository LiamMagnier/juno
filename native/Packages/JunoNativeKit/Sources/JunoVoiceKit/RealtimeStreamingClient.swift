import Foundation

// MARK: - Why this exists next to JunoRealtimeVoiceController
//
// `JunoRealtimeVoiceController` is the shipping session: it owns the SwiftUI
// surface's observable state, the AVAudioEngine graph, ScreenCaptureKit, and the
// on-device recognizer. It is also, for exactly those reasons, a type no test can
// instantiate — the whole file is behind `#if canImport(AVFoundation) &&
// canImport(Speech)`, `start()` prompts for the microphone, and every lifecycle
// decision it makes is a branch buried between two hardware calls.
//
// So the *decisions* live here instead, in a reducer with no imports beyond
// Foundation, and the hardware sits behind ``RealtimeAudioEndpoint``. The wire
// protocol is not restated: this drives the frozen `JunoVoiceRelayProtocol`
// verbatim, reuses ``JunoVoiceTranscriptRecord`` for line ordering, and reuses
// ``JunoVoiceRelayAuthorizing`` for the credential. What is new is that the
// lifecycle can now be exercised — including the two behaviours that were
// previously only reachable by unplugging a real microphone mid-call: reconnect,
// and barge-in.

// MARK: - Loudness

/// Linear RMS → 0…1 across a speech window, in decibels.
///
/// Hoisted out of ``JunoRealtimeVoiceController`` — which now calls through to
/// it — because two things need the same mapping and must not drift apart: the
/// orb the reader watches, and ``RealtimeVoiceActivityDetector``, which decides
/// whether someone is talking over the model. A detector calibrated against a
/// different curve than the one on screen produces the worst possible bug report:
/// "it cut the answer off and the light hadn't even moved."
///
/// It lives outside the AVFoundation gate on purpose. The controller compiles
/// away entirely on a platform without AVFAudio; the arithmetic must not.
public enum RealtimeLoudness: Sendable {
    /// The quietest speech worth showing, and the loudest worth scaling to.
    /// −52 dBFS is a soft voice across a desk; −12 is close and emphatic.
    public static let quietFloorDB: Double = -52
    public static let loudCeilingDB: Double = -12

    public static func normalized(_ rms: Double) -> Double {
        guard rms > 0 else { return 0 }
        let decibels = 20 * log10(rms)
        let range = loudCeilingDB - quietFloorDB
        return min(1, max(0, (decibels - quietFloorDB) / range))
    }
}

// MARK: - Voice activity

/// Decides, from the meter alone, whether the person in front of the microphone
/// has started talking.
///
/// Two thresholds and two counts rather than one of each, and the asymmetry is
/// the entire point. A single threshold crossed by a single frame fires on a
/// cough, a chair, and the plosive at the start of the model's own word; a single
/// threshold *held* is then released by the gap between two syllables. So onset
/// needs several consecutive loud frames and release needs several consecutive
/// quiet ones, at a lower threshold — the reader has to mean it to start, and has
/// to actually stop to end.
///
/// Pure and `Equatable`: the defaults below are the only tuning in the voice
/// stack that can be argued about with a test rather than with a headset.
public struct RealtimeVoiceActivityDetector: Equatable, Sendable {
    /// Normalized loudness (see ``RealtimeLoudness``) that starts the onset
    /// count. 0.34 is a little above the level a room full of laptop fans
    /// produces and a little below ordinary speech.
    public var onsetThreshold: Double
    /// Deliberately lower than ``onsetThreshold``. Speech dips between syllables,
    /// and a symmetric threshold turns one sentence into six utterances.
    public var releaseThreshold: Double
    /// Consecutive frames above ``onsetThreshold`` before speech is declared. At
    /// the endpoint's ~30 Hz meter this is roughly 100 ms — long enough to
    /// discard a transient, short enough that an interruption still feels instant.
    public var onsetFrames: Int
    /// Consecutive frames below ``releaseThreshold`` before speech is retired.
    /// Longer than onset, because ending a turn early is worse than ending it
    /// late.
    public var releaseFrames: Int

    public private(set) var isSpeaking = false
    private var above = 0
    private var below = 0

    public enum Transition: Equatable, Sendable {
        case began
        case ended
    }

    public init(
        onsetThreshold: Double = 0.34,
        releaseThreshold: Double = 0.20,
        onsetFrames: Int = 3,
        releaseFrames: Int = 12
    ) {
        self.onsetThreshold = onsetThreshold
        self.releaseThreshold = releaseThreshold
        self.onsetFrames = max(1, onsetFrames)
        self.releaseFrames = max(1, releaseFrames)
    }

    /// Feeds one meter frame. Returns a transition only on the frame that changes
    /// the answer, so a caller can treat the result as an edge and never has to
    /// remember the previous state itself.
    public mutating func observe(loudness: Double) -> Transition? {
        if loudness >= onsetThreshold {
            above += 1
            below = 0
        } else if loudness <= releaseThreshold {
            below += 1
            above = 0
        } else {
            // The hysteresis band: neither count advances. Sitting here holds
            // whatever the answer already was, which is what a band is for.
            return nil
        }

        if !isSpeaking, above >= onsetFrames {
            isSpeaking = true
            above = 0
            return .began
        }
        if isSpeaking, below >= releaseFrames {
            isSpeaking = false
            below = 0
            return .ended
        }
        return nil
    }

    /// Forgets the run of frames without changing ``isSpeaking``'s meaning —
    /// used when the floor changes hands, so counts accumulated against the
    /// previous speaker cannot trip the next decision.
    public mutating func reset() {
        isSpeaking = false
        above = 0
        below = 0
    }
}

// MARK: - Barge-in policy

/// Whether the model's answer may be cut off by the reader simply talking.
///
/// This is not a preference; it is a fact about the audio hardware, which is why
/// ``RealtimeStreamingClient`` reads it from the endpoint rather than from a
/// setting. Without echo cancellation the microphone hears the speakers, so the
/// detector's "someone is talking" is the *model* talking — and automatic
/// barge-in becomes a session that interrupts itself after the first syllable of
/// every answer, forever, with no way for the reader to work out why.
///
/// ``manualOnly`` is therefore not a degraded mode, it is the correct mode on a
/// Mac whose input and output are different devices — precisely the case
/// `JunoRealtimeVoiceController.buildAudioGraph` falls back to when the
/// voice-processing unit refuses.
public enum RealtimeBargeInPolicy: Equatable, Sendable {
    /// Talking over the answer interrupts it.
    case automatic
    /// Only an explicit ``RealtimeStreamingClient/interrupt()`` interrupts.
    case manualOnly

    /// Chosen from what the hardware actually reports.
    ///
    /// **`.unknown` resolves to ``manualOnly``**, and that asymmetry is
    /// deliberate: an endpoint that cannot say whether it is cancelling echo has
    /// not said that it is. Treating silence as a yes is the difference between
    /// a feature that is unavailable and a call that hangs up on itself.
    public init(echoCancellation: RealtimeEchoCancellation) {
        self = echoCancellation == .active ? .automatic : .manualOnly
    }
}

// MARK: - Audio graph plan

/// The deterministic graph contract shared by both native realtime endpoints.
/// macOS keeps capture and playback on separate hardware graphs so a duplex
/// voice-processing unit cannot force unrelated devices onto one format.
public struct RealtimeAudioGraphPlan: Equatable, Sendable {
    public enum Topology: Equatable, Sendable {
        case splitCapturePlayback
        case unifiedDuplex
    }

    public let topology: Topology
    public let voiceProcessingAttempts: [Bool]

    public static var current: Self {
        #if os(macOS)
        // A macOS Voice Processing input node is a duplex AudioUnit even when it
        // lives in a capture-only AVAudioEngine. In the split topology its
        // hidden downlink has no timestamped render source: the graph can report
        // `start()` success and then continuously fail at runtime with
        // `ProcessDownlinkAudio` / invalid sample-time I/O faults. That is worse
        // than an ordinary startup refusal because there is no thrown error for
        // the fallback ladder to catch. Raw capture is therefore the only
        // compatible macOS split-graph attempt; interruption remains available
        // explicitly and the mixer in the independent playback engine still
        // resamples the provider's 24 kHz stream to the output hardware.
        Self(topology: .splitCapturePlayback, voiceProcessingAttempts: [false])
        #else
        Self(topology: .unifiedDuplex, voiceProcessingAttempts: [true, false])
        #endif
    }
}

/// Tracks whether provider audio is still physically queued for playback.
/// `turn.end` means the provider stopped producing bytes; it does not mean the
/// speaker has consumed the buffers already scheduled on AVAudioPlayerNode.
public struct RealtimePlaybackDrain: Equatable, Sendable {
    /// Raw macOS capture hears a short acoustic tail after CoreAudio reports the
    /// final buffer played. Keep that tail out of the provider uplink as well.
    public static let acousticTailSeconds: TimeInterval = 0.75

    public private(set) var pendingBuffers = 0
    public private(set) var suppressUntilUptime: TimeInterval = 0
    public var isActive: Bool { isActive(atUptime: ProcessInfo.processInfo.systemUptime) }

    public init() {}

    public mutating func scheduled() {
        pendingBuffers += 1
        suppressUntilUptime = 0
    }

    public mutating func completed(
        atUptime uptime: TimeInterval = ProcessInfo.processInfo.systemUptime
    ) {
        guard pendingBuffers > 0 else { return }
        pendingBuffers -= 1
        if pendingBuffers == 0 {
            suppressUntilUptime = uptime + Self.acousticTailSeconds
        }
    }

    public func isActive(atUptime uptime: TimeInterval) -> Bool {
        pendingBuffers > 0 || uptime < suppressUntilUptime
    }

    /// An explicit interruption intentionally reopens the microphone now; late
    /// completion callbacks from the discarded buffers must not re-arm a tail.
    public mutating func clear() {
        pendingBuffers = 0
        suppressUntilUptime = 0
    }
}

// MARK: - Session failures

/// Why a realtime session stopped, when it stopped for a reason that is not an
/// ending. Kept apart from ``JunoVoiceCloseReason`` for the same reason the
/// controller keeps them apart: running out of session time is not a failure, and
/// offering "Something went wrong" for it teaches people to ignore the copy that
/// matters.
public enum RealtimeSessionFailure: Equatable, Sendable {
    case transport(String)
    case relay(String)
    case audio(String)
    case notConfigured

    public var message: String {
        switch self {
        case .transport(let detail):
            detail.isEmpty ? "Couldn't reach the voice relay." : detail
        case .relay(let detail):
            detail.isEmpty ? "The voice relay reported an error." : detail
        case .audio(let detail):
            detail.isEmpty ? "The audio engine couldn't start." : detail
        case .notConfigured:
            "Realtime voice isn't configured for this environment."
        }
    }
}

// MARK: - Session phases, events, effects

/// Where a realtime session is.
///
/// Finer than ``JunoRealtimeVoiceController/Phase`` in exactly one place that
/// matters: `live` is split into who holds the floor. The controller tracked the
/// same fact in a separate `assistantSpeaking` boolean, and a boolean beside an
/// enum is a pair that can disagree — "live and not speaking" and "listening" are
/// then two spellings of one state, and every guard has to check both.
public enum RealtimeSessionPhase: Equatable, Sendable {
    case idle
    /// Credential fetched, transport opening.
    case connecting
    /// Transport open, `session.start` sent, waiting for the relay to say what
    /// this session can actually do.
    case negotiating
    /// Live. The floor is the reader's.
    case listening
    /// Live. The model is talking.
    case responding
    /// Barge-in sent, waiting for the relay to confirm it dropped the turn. A
    /// distinct phase rather than an immediate return to ``listening`` because
    /// the relay can answer with either `interrupted` *or* the end of the turn,
    /// and a second interrupt sent into that window is one the relay bills for
    /// and discards.
    case interrupting
    case reconnecting
    case closed(JunoVoiceCloseReason)
    case failed(RealtimeSessionFailure)

    /// True in the three phases where audio is genuinely flowing both ways.
    public var isLive: Bool {
        switch self {
        case .listening, .responding, .interrupting: true
        default: false
        }
    }

    /// True once the session is over and ``RealtimeSessionMachine/apply(_:)``
    /// will refuse everything but a fresh ``RealtimeSessionEvent/start``.
    public var isTerminal: Bool {
        switch self {
        case .closed, .failed: true
        default: false
        }
    }
}

/// Everything that can move a session, from all four sources: the reader, the
/// transport, the relay, and the microphone.
public enum RealtimeSessionEvent: Equatable, Sendable {
    case start
    case transportOpened
    case sessionReady(provider: JunoVoiceProvider, capabilities: JunoVoiceCapabilities)
    case assistantTurnBegan
    case assistantTurnEnded
    /// The local detector believes the reader started talking. Acted on only
    /// under ``RealtimeBargeInPolicy/automatic``; see the policy for why.
    case userSpeechDetected
    /// The reader pressed Interrupt.
    case interruptRequested
    /// The relay confirmed it dropped the turn.
    case relayInterrupted
    case relayError(String)
    case relayClosed(JunoVoiceCloseReason)
    case transportFailed(String)
    case audioFailed(String)
    case end
}

/// What the reducer wants done, in the order it wants it done.
///
/// Effects rather than direct calls so the whole lifecycle is a value: a test
/// asserts on the array, and the actor below is a dumb executor that cannot
/// quietly add a fifth thing the state machine never asked for.
public enum RealtimeSessionEffect: Equatable, Sendable {
    /// Bring the audio graph up. First, before the socket — a reconnect onto a
    /// stopped engine is a conversation with no audio in either direction and
    /// nothing to explain it.
    case startAudio
    case openTransport
    case sendSessionStart
    case sendInterrupt
    /// Drop what is queued for playback locally. Always emitted *before*
    /// ``sendInterrupt``: the buffers are already on the player, so waiting for
    /// the relay means the model talks over the interruption for a round trip.
    case flushPlayback
    /// Half-duplex. True while the model holds the floor — see
    /// `VoiceRelayShuttle.assistantSpeaking` for the failure this prevents.
    case setUplinkSuppressed(Bool)
    case scheduleReconnect
    case closeTransport(normally: Bool)
    case stopAudio
    /// Something the reader should see but the session survives.
    case notice(String)
}

// MARK: - The reducer

/// The whole lifecycle of a realtime voice session, as a value.
///
/// Three rules here are load-bearing and each one exists because of a specific
/// way a live call breaks:
///
/// - **Capabilities are cleared on every reconnect and every provider switch.**
///   They describe the negotiated session, not the account, and a stale copy is
///   how a client keeps shipping video frames to a provider that cannot see.
///   Nil is "not yet told", never "no" — see ``capabilities``.
/// - **Reconnect is budgeted, and the budget is earned by reaching `live`.** A
///   socket that drops before `session.ready` was almost certainly refused, and
///   retrying a refusal costs the backend a token mint per attempt.
/// - **`end` wins from anywhere and is idempotent.** Both the close button and
///   the view's disappearance send it, in either order.
public struct RealtimeSessionMachine: Equatable, Sendable {
    public private(set) var phase: RealtimeSessionPhase
    /// What the negotiated session can do — **nil until the relay says**.
    ///
    /// Absent is not "no video" and not "no screen": it is "nobody has been told
    /// yet", and a caller that reads it as a denial silently disables features
    /// that were available. Every gate in this file spells the check
    /// `capabilities?.x == true` for that reason.
    public private(set) var capabilities: JunoVoiceCapabilities?
    /// The provider the relay actually gave us, which is not always the one that
    /// was asked for.
    public private(set) var provider: JunoVoiceProvider
    public private(set) var bargeIn: RealtimeBargeInPolicy
    /// Spent by a reconnect, refunded by the next `session.ready`. Per outage,
    /// not per session: a call that recovered has earned another attempt.
    public private(set) var reconnectAvailable = false

    public init(
        provider: JunoVoiceProvider,
        bargeIn: RealtimeBargeInPolicy = .manualOnly,
        phase: RealtimeSessionPhase = .idle
    ) {
        self.provider = provider
        self.bargeIn = bargeIn
        self.phase = phase
    }

    /// Barge-in policy is hardware truth, and hardware changes underneath a live
    /// session — headphones on a Mac can hand a call echo cancellation it did
    /// not start with, and unplugging them takes it away again.
    public mutating func setBargeInPolicy(_ policy: RealtimeBargeInPolicy) {
        bargeIn = policy
    }

    /// Applies one event and returns what to do about it.
    ///
    /// Never throws and never traps on an unexpected pair: a realtime session
    /// receives events from a network peer and a hardware callback, and the
    /// correct response to "that cannot happen" is to ignore it, not to end a
    /// conversation someone is having. An ignored event returns `[]` and leaves
    /// the phase alone.
    @discardableResult
    public mutating func apply(_ event: RealtimeSessionEvent) -> [RealtimeSessionEffect] {
        // `end` first, because it is the one event that must be honoured from
        // every phase — including the two it is a no-op in.
        if case .end = event {
            guard !phase.isTerminal else { return [] }
            phase = .closed(.client)
            capabilities = nil
            reconnectAvailable = false
            return [.stopAudio, .closeTransport(normally: true)]
        }

        switch (phase, event) {

        // MARK: Opening

        case (.idle, .start), (.closed, .start), (.failed, .start):
            phase = .connecting
            capabilities = nil
            reconnectAvailable = false
            return [.startAudio, .openTransport]

        case (.connecting, .transportOpened), (.reconnecting, .transportOpened):
            phase = .negotiating
            return [.sendSessionStart]

        case let (.negotiating, .sessionReady(readyProvider, readyCapabilities)):
            provider = readyProvider
            capabilities = readyCapabilities
            reconnectAvailable = true
            phase = .listening
            // Explicitly un-suppressed rather than left alone: a reconnect that
            // dropped mid-answer arrives here with the uplink still muted, and
            // an uplink nobody unmutes is a microphone that never works again.
            return [.setUplinkSuppressed(false)]

        // MARK: Floor changes

        case (.listening, .assistantTurnBegan), (.interrupting, .assistantTurnBegan):
            phase = .responding
            return [.setUplinkSuppressed(true)]

        case (.responding, .assistantTurnEnded), (.interrupting, .assistantTurnEnded):
            phase = .listening
            return [.setUplinkSuppressed(false)]

        // A turn that ends while the floor is already the reader's is the relay
        // and this client agreeing, late. Nothing to do, and nothing wrong.
        case (.listening, .assistantTurnEnded):
            return []

        // MARK: Barge-in

        case (.responding, .userSpeechDetected):
            guard bargeIn == .automatic else { return [] }
            phase = .interrupting
            return [.flushPlayback, .sendInterrupt, .setUplinkSuppressed(false)]

        case (.responding, .interruptRequested):
            phase = .interrupting
            return [.flushPlayback, .sendInterrupt, .setUplinkSuppressed(false)]

        // Already interrupting: the reader pressing the button again, or the
        // detector firing a second time, must not send a second frame. The relay
        // bills for it and drops it.
        case (.interrupting, .interruptRequested), (.interrupting, .userSpeechDetected):
            return []

        case (.interrupting, .relayInterrupted):
            phase = .listening
            return []

        // The relay dropping a turn nobody asked it to drop still has to reach
        // the speaker, or the answer keeps playing after the model has moved on.
        case (.listening, .relayInterrupted), (.responding, .relayInterrupted):
            phase = .listening
            return [.flushPlayback, .setUplinkSuppressed(false)]

        // Speech while the reader already has the floor is just speech.
        case (.listening, .userSpeechDetected), (.listening, .interruptRequested):
            return []

        // MARK: Relay trouble

        case let (_, .relayError(detail)):
            // Fatal only before the session is up. Once audio is flowing the same
            // frame means "that turn had a problem", and hanging up on it ends
            // conversations that were fine.
            if phase.isLive {
                return [.notice(detail)]
            }
            phase = .failed(.relay(detail))
            capabilities = nil
            return [.stopAudio, .closeTransport(normally: true)]

        case let (_, .relayClosed(reason)):
            phase = .closed(reason)
            capabilities = nil
            reconnectAvailable = false
            return [.stopAudio, .closeTransport(normally: true)]

        case let (_, .transportFailed(detail)):
            guard reconnectAvailable else {
                phase = .failed(.transport(detail))
                capabilities = nil
                return [.stopAudio, .closeTransport(normally: false)]
            }
            reconnectAvailable = false
            // The next session negotiates its own capabilities; carrying these
            // across the gap is how a client keeps talking to the provider it
            // used to have.
            capabilities = nil
            phase = .reconnecting
            return [
                .flushPlayback,
                .setUplinkSuppressed(false),
                .closeTransport(normally: false),
                .scheduleReconnect,
            ]

        case let (_, .audioFailed(detail)):
            // No reconnect budget spent on this one: the socket is fine and
            // reopening it would not put a microphone back.
            phase = .failed(.audio(detail))
            capabilities = nil
            reconnectAvailable = false
            return [.stopAudio, .closeTransport(normally: true)]

        default:
            return []
        }
    }
}

// MARK: - Injected transport

/// One frame on the relay socket. Text is control, binary is audio — the split
/// the relay's own protocol makes, restated here so the transport does not have
/// to know what either contains.
public enum RealtimeTransportFrame: Equatable, Sendable {
    case text(String)
    case binary(Data)
}

public enum RealtimeTransportError: Error, Equatable, Sendable {
    case notOpen
    case closed
}

/// The socket, behind a protocol.
///
/// Injected for one reason above all others: reconnect. It is the single most
/// failure-prone path in the voice stack and, against a real `URLSession`, the
/// only way to exercise it is to physically interrupt the network mid-call. With
/// this, a test drops the socket on the frame of its choosing.
public protocol RealtimeTransport: Sendable {
    func open(url: URL) async throws
    func send(_ frame: RealtimeTransportFrame) async throws
    /// One frame, awaited. Throwing is how a dropped socket is reported; the
    /// client turns that into ``RealtimeSessionEvent/transportFailed(_:)``.
    func receive() async throws -> RealtimeTransportFrame
    func close(normally: Bool) async
}

/// ``RealtimeTransport`` over `URLSessionWebSocketTask` — the real socket.
///
/// Thin on purpose. Everything that could be a decision (when to reconnect, what
/// a dropped frame means, whether a close was clean) belongs to
/// ``RealtimeSessionMachine``, and a transport that made any of those would put
/// them back out of reach of a test.
///
/// One thing here is not thin, and it is the ``receive()`` contract: a cancelled
/// task makes the pending receive throw, which is exactly how a close and a drop
/// are told apart upstream — the client cancels its own receive loop *before*
/// closing, so its own teardown never arrives as
/// ``RealtimeSessionEvent/transportFailed(_:)``.
public actor URLSessionRealtimeTransport: RealtimeTransport {
    private let session: URLSession
    private var task: URLSessionWebSocketTask?

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func open(url: URL) async throws {
        // A reconnect reuses this object, and a previous task still holding the
        // connection is a socket the relay counts against this account's session
        // limit long after nothing is reading it.
        task?.cancel(with: .goingAway, reason: nil)
        let task = session.webSocketTask(with: url)
        self.task = task
        task.resume()
    }

    public func send(_ frame: RealtimeTransportFrame) async throws {
        guard let task else { throw RealtimeTransportError.notOpen }
        switch frame {
        case .text(let text): try await task.send(.string(text))
        case .binary(let data): try await task.send(.data(data))
        }
    }

    public func receive() async throws -> RealtimeTransportFrame {
        guard let task else { throw RealtimeTransportError.notOpen }
        switch try await task.receive() {
        case .string(let text): return .text(text)
        case .data(let data): return .binary(data)
        @unknown default:
            // A frame kind this SDK does not know is not a reason to end a call;
            // it is a reason to read the next one. Throwing `closed` here would
            // hang up on a future URLSession.
            return .binary(Data())
        }
    }

    public func close(normally: Bool) async {
        task?.cancel(with: normally ? .normalClosure : .abnormalClosure, reason: nil)
        task = nil
    }
}

// MARK: - Injected audio

/// Whether the microphone is being kept from hearing the speakers.
///
/// Three cases, not a `Bool`, because the third one is real and common: an
/// endpoint that has not started, or a platform that cannot report it, knows
/// nothing — and see ``RealtimeBargeInPolicy`` for why calling that "no" and
/// calling it "yes" are both wrong.
public enum RealtimeEchoCancellation: Equatable, Sendable {
    case active
    case unavailable
    case unknown

    /// Resolved from the audio input node, and from nothing else.
    ///
    /// **The one thing this deliberately cannot see is what was asked for.**
    /// `setVoiceProcessingEnabled(true)` only sets a flag — the voice-processing
    /// IO unit either initialises inside `engine.start()` or it does not, and
    /// `isVoiceProcessingEnabled` on the node afterwards is the only witness. Both
    /// audio graphs in this package now request the unit on macOS *and* iOS, so
    /// "we asked" is true almost everywhere and means almost nothing; a resolver
    /// handed the request would eventually be edited to trust it, and trusting it
    /// is the self-interrupting call. Without a canceller the microphone hears the
    /// speakers, ``RealtimeVoiceActivityDetector`` reads that as the reader
    /// talking, and every answer is cut off by its own first syllable with the
    /// Interrupt button apparently pressing itself. This function cannot make that
    /// mistake because it is not given the material for it.
    ///
    /// Note what is equally absent: `AVAudioSession.mode`. `.voiceChat` genuinely
    /// does cancel echo at the session level on iOS, and it is a perfectly good
    /// reason to *ask* the node for its unit — it is not evidence that the ask
    /// succeeded, and it is not a reading of this node.
    ///
    /// ``unknown`` is unreachable from here on purpose. Being able to read the
    /// node at all means a graph is up; "no graph" is the third answer and belongs
    /// to whoever owns the lifecycle, not to a reading of hardware that is
    /// running.
    ///
    /// - Parameter reportsVoiceProcessing: `AVAudioInputNode.isVoiceProcessingEnabled`,
    ///   read **after** `engine.start()` returned. Read before then it describes a
    ///   pending request rather than a running unit.
    public static func fromInputNode(
        reportsVoiceProcessing: Bool
    ) -> RealtimeEchoCancellation {
        reportsVoiceProcessing ? .active : .unavailable
    }
}

// MARK: - Input format sanity

/// Whether what an input node is describing is something a capture graph can
/// actually be built on.
///
/// One rule, in one place, because the audio graphs had two spellings of it and
/// they had already drifted: the "withdraw voice processing and re-read" branch
/// tested `sampleRate <= 0`, while the "give up on this rung" guard tested
/// `sampleRate > 0`. Those are not complements. `Double.nan` fails both — it is
/// not `<= 0` and it is not `> 0` — so a node left describing NaN skipped the
/// cheap recovery and failed the whole attempt instead.
///
/// It matters more now that iOS asks for the voice-processing unit too. A
/// processor that attaches and leaves the node describing nothing recordable is
/// the *recoverable* failure — withdraw it, re-read, and the call still happens
/// on manual barge-in — and it can only be recovered from if it is recognised.
public enum RealtimeInputFormat: Sendable {

    /// - Parameters:
    ///   - sampleRate: `AVAudioFormat.sampleRate`. Non-finite counts as unusable:
    ///     the uplink divides by it, and `AVAudioFrameCount(_:)` traps on inf and
    ///     NaN rather than saturating — on the realtime audio thread, which is an
    ///     immediate crash.
    ///   - channelCount: `AVAudioFormat.channelCount`. Zero is a node that has
    ///     been configured out of existence, not a mono node.
    /// - Returns: True when a converter and a tap built from this format will
    ///   describe real audio.
    public static func isUsable(sampleRate: Double, channelCount: UInt32) -> Bool {
        // No upper bound on the rate, deliberately. A 384 kHz interface is a real
        // thing a person owns, the converter downsamples whatever arrives, and
        // refusing one would be a call that does not happen in exchange for a
        // hazard that does not exist.
        sampleRate.isFinite && sampleRate > 0 && channelCount > 0
    }
}

/// One slice of captured audio, as the client sees it.
public struct RealtimeCaptureFrame: Equatable, Sendable {
    /// PCM16 mono 16 kHz, ready for the wire — or **nil when nothing is being
    /// uploaded**, because the reader is muted or the model holds the floor.
    ///
    /// Nil rather than empty `Data`: an empty buffer is a slice of silence that
    /// was genuinely recorded and genuinely sent, and the two must not be the
    /// same value. A relay that receives silence hears a reader who has stopped
    /// talking; a relay that receives nothing hears a reader who is muted.
    public let pcm16: Data?
    /// 0…1 via ``RealtimeLoudness``. Measured even while nothing is uploaded —
    /// the meter is what tells someone their microphone is muted rather than
    /// broken, and it is what the detector reads.
    public let loudness: Double

    public init(pcm16: Data?, loudness: Double) {
        self.pcm16 = pcm16
        self.loudness = loudness
    }
}

/// The microphone and the speaker, behind a protocol so a test needs neither.
///
/// Deliberately narrow. Everything here is something the session machine asks
/// for by name in ``RealtimeSessionEffect``; nothing here is a knob. Format
/// negotiation, converter lifetimes, voice-processing fallbacks and route changes
/// are the conformer's business — see ``AVAudioEngineRealtimeEndpoint``, and see
/// `JunoRealtimeVoiceController.buildAudioGraph` for why that business does not
/// belong anywhere a state machine can see it.
public protocol RealtimeAudioEndpoint: Sendable {
    /// Brings capture and playback up. Throwing here becomes
    /// ``RealtimeSessionEvent/audioFailed(_:)``.
    func start() async throws
    func stop() async

    /// Half-duplex. While suppressed the endpoint keeps metering and stops
    /// producing ``RealtimeCaptureFrame/pcm16``.
    func setUplinkSuppressed(_ suppressed: Bool) async
    /// The reader's own mute. Distinct from suppression: both stop the uplink,
    /// but only one of them is something the reader chose, and a session that
    /// conflated them un-muted people when the model stopped talking.
    func setMuted(_ muted: Bool) async

    /// Queues one relay audio frame (PCM16 mono 24 kHz) for playback.
    func enqueuePlayback(_ pcm16: Data) async
    /// Drops everything queued. Barge-in's local half.
    func flushPlayback() async

    /// What the hardware is actually doing about echo, now.
    var echoCancellation: RealtimeEchoCancellation { get async }

    /// The capture stream. One frame per buffer; finishes when the endpoint stops.
    func captureFrames() -> AsyncStream<RealtimeCaptureFrame>
}

// MARK: - Client

/// What a caller watches while a session runs.
///
/// A stream rather than `@Observable` properties, because this type is an actor
/// and not a view model: the app's existing voice surface is
/// ``JunoRealtimeVoiceController``, and anything new that wants to draw an orb
/// can hop these to the main actor itself. That keeps the testable core free of
/// a main-actor requirement no test wants.
public enum RealtimeSessionUpdate: Equatable, Sendable {
    case phase(RealtimeSessionPhase)
    case transcript([JunoVoiceTranscriptRecord.Line])
    case level(Double)
    case usage(JunoVoiceUsage)
    case notice(String)
    case capabilities(JunoVoiceCapabilities?)
}

/// A bidirectional realtime voice session: microphone up, model speech down,
/// control frames on the same socket.
///
/// This is ``RealtimeSessionMachine`` plugged into an injected transport and an
/// injected audio endpoint, and almost nothing else. Every branch worth arguing
/// about is in the reducer; what is left here is plumbing, ordered to match the
/// effects the reducer emits.
public actor RealtimeStreamingClient {

    public struct Configuration: Sendable {
        public var provider: JunoVoiceProvider
        /// The chat that was on screen when the call opened. Bounded on the way
        /// in — the relay truncates silently, and an unbounded chat can make a
        /// frame the transport refuses before the relay ever parses it.
        public var history: [JunoVoiceHistoryEntry]
        /// How long to wait before a reconnect. One second, matching the
        /// controller: long enough that a relay restarting is back, short enough
        /// that the reader has not concluded the call died.
        public var reconnectDelay: Duration
        public var detector: RealtimeVoiceActivityDetector

        public init(
            provider: JunoVoiceProvider = .productionDefault,
            history: [JunoVoiceHistoryEntry] = [],
            reconnectDelay: Duration = .seconds(1),
            detector: RealtimeVoiceActivityDetector = RealtimeVoiceActivityDetector()
        ) {
            self.provider = provider
            self.history = JunoVoiceHistoryEntry.bounded(history)
            self.reconnectDelay = reconnectDelay
            self.detector = detector
        }
    }

    private let authorization: any JunoVoiceRelayAuthorizing
    private let fallbackRelayURL: URL?
    private let transport: any RealtimeTransport
    private let audio: any RealtimeAudioEndpoint

    private var machine: RealtimeSessionMachine
    private var configuration: Configuration
    private var detector: RealtimeVoiceActivityDetector
    private var record = JunoVoiceTranscriptRecord()
    private var seededHistory: [JunoVoiceHistoryEntry]
    private var muted = false
    private var level: Double = 0
    private var usage: JunoVoiceUsage?

    private var receiveLoop: Task<Void, Never>?
    private var captureLoop: Task<Void, Never>?
    private var pingLoop: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var updateContinuations: [UUID: AsyncStream<RealtimeSessionUpdate>.Continuation] = [:]

    public init(
        authorization: any JunoVoiceRelayAuthorizing,
        relayURL: URL? = nil,
        transport: any RealtimeTransport,
        audio: any RealtimeAudioEndpoint,
        configuration: Configuration = Configuration()
    ) {
        self.authorization = authorization
        self.fallbackRelayURL = relayURL
        self.transport = transport
        self.audio = audio
        self.configuration = configuration
        self.detector = configuration.detector
        self.seededHistory = configuration.history
        self.machine = RealtimeSessionMachine(provider: configuration.provider)
    }

    // MARK: Observation

    public var phase: RealtimeSessionPhase { machine.phase }
    public var capabilities: JunoVoiceCapabilities? { machine.capabilities }
    public var transcript: [JunoVoiceTranscriptRecord.Line] { record.lines }
    public var bargeInPolicy: RealtimeBargeInPolicy { machine.bargeIn }
    public var currentUsage: JunoVoiceUsage? { usage }

    /// A stream of everything that changed. Multiple subscribers are fine; each
    /// gets its own continuation, and a dropped one unregisters itself so a view
    /// that goes away does not keep a buffer alive for the length of the call.
    public func updates() -> AsyncStream<RealtimeSessionUpdate> {
        AsyncStream { continuation in
            let id = UUID()
            updateContinuations[id] = continuation
            continuation.onTermination = { [weak self] _ in
                Task { await self?.removeContinuation(id) }
            }
            continuation.yield(.phase(machine.phase))
        }
    }

    private func removeContinuation(_ id: UUID) {
        updateContinuations[id] = nil
    }

    private func publish(_ update: RealtimeSessionUpdate) {
        for continuation in updateContinuations.values { continuation.yield(update) }
    }

    // MARK: Lifecycle

    /// Opens a session. Safe to call from `idle`, `closed` or `failed` — which is
    /// how "Start again" works without rebuilding the object — and a no-op from
    /// everything else, which is what stops a double tap from putting two sockets
    /// on one audio graph.
    ///
    /// - Parameter history: Nil, not empty, means "unchanged". A retry after a
    ///   failure passes nothing and keeps the context the first attempt had;
    ///   passing `[]` would restart the conversation blind.
    public func start(
        provider requested: JunoVoiceProvider? = nil,
        history: [JunoVoiceHistoryEntry]? = nil
    ) async {
        guard machine.phase == .idle || machine.phase.isTerminal else { return }
        if let history { seededHistory = JunoVoiceHistoryEntry.bounded(history) }
        if let requested { configuration.provider = requested }
        record.reset()
        usage = nil
        detector.reset()
        machine = RealtimeSessionMachine(provider: configuration.provider)
        await run(machine.apply(.start))
    }

    public func end() async {
        await run(machine.apply(.end))
    }

    /// Barge-in, by hand. Works under either policy — the on-screen control is
    /// the interruption that is always available, which is exactly why
    /// ``RealtimeBargeInPolicy/manualOnly`` is a usable mode rather than a
    /// broken one.
    public func interrupt() async {
        await run(machine.apply(.interruptRequested))
    }

    public func setMuted(_ newValue: Bool) async {
        muted = newValue
        await audio.setMuted(newValue)
        // A muted microphone cannot be talking over the answer. Retiring the
        // detector's run here is what stops the frames captured just before the
        // mute from firing an interruption just after it.
        if newValue { detector.reset() }
    }

    /// Sends one turn as text — the on-device recognizer's output for providers
    /// that cannot hear audio, or a typed message while the call is open.
    ///
    /// - Returns: false when nothing was sent, so a caller can fall back to the
    ///   normal chat path instead of quietly losing the message.
    @discardableResult
    public func sendText(_ text: String) async -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard machine.phase.isLive, !trimmed.isEmpty else { return false }
        return await send(.inputText(trimmed))
    }

    /// One JPEG for providers that take video.
    ///
    /// Gated on `capabilities?.videoInput == true` and not on `!= false`: before
    /// `session.ready` nobody has said this provider can see, and shipping a
    /// megabyte on that assumption is a frame that is billed and discarded.
    @discardableResult
    public func sendVideoFrame(base64JPEG: String) async -> Bool {
        guard machine.phase.isLive, machine.capabilities?.videoInput == true,
            !base64JPEG.isEmpty, base64JPEG.utf8.count < 2_000_000
        else { return false }
        return await send(.videoFrame(jpegBase64: base64JPEG))
    }

    // MARK: Effects

    private func run(_ effects: [RealtimeSessionEffect]) async {
        publish(.phase(machine.phase))
        for effect in effects {
            switch effect {
            case .startAudio:
                do {
                    try await audio.start()
                    // Read *after* start: an endpoint that has not been brought up
                    // reports `.unknown`, and resolving the policy from that would
                    // pin every session to manual barge-in.
                    machine.setBargeInPolicy(
                        RealtimeBargeInPolicy(echoCancellation: await audio.echoCancellation)
                    )
                    startCaptureLoop()
                } catch {
                    // Re-entering the machine from inside its own effect run is
                    // safe and deliberate: the audio failure supersedes whatever
                    // else this batch was going to do, and the remaining effects
                    // for a session that has no microphone are not worth running.
                    await run(machine.apply(.audioFailed(error.localizedDescription)))
                    return
                }

            case .openTransport:
                await openTransport()

            case .sendSessionStart:
                _ = await send(
                    .sessionStart(provider: configuration.provider, history: startHistory())
                )

            case .sendInterrupt:
                _ = await send(.controlInterrupt)

            case .flushPlayback:
                await audio.flushPlayback()

            case .setUplinkSuppressed(let suppressed):
                await audio.setUplinkSuppressed(suppressed)
                // The floor changing hands invalidates the detector's run: frames
                // counted while the model was talking must not decide anything
                // about the reader who just got the microphone back.
                detector.reset()

            case .scheduleReconnect:
                scheduleReconnect()

            case .closeTransport(let normally):
                // The receive loop is cancelled *first*, so this client's own
                // teardown never comes back around as `transportFailed`: closing
                // the socket makes the pending receive throw, and a live loop
                // would report that as a dropped relay and spend the reconnect
                // budget hanging up on itself.
                receiveLoop?.cancel()
                receiveLoop = nil
                pingLoop?.cancel()
                pingLoop = nil
                await transport.close(normally: normally)

            case .stopAudio:
                captureLoop?.cancel()
                captureLoop = nil
                pingLoop?.cancel()
                pingLoop = nil
                reconnectTask?.cancel()
                reconnectTask = nil
                await audio.stop()
                level = 0
                publish(.level(0))

            case .notice(let message):
                publish(.notice(message))
            }
        }
        publish(.capabilities(machine.capabilities))
    }

    /// The context for `session.start`: the chat the call was opened from, plus
    /// anything already said in the call.
    ///
    /// The second half is what makes a reconnect invisible — a dropped socket
    /// gets a fresh relay session with an empty provider history, so without this
    /// the conversation resumes with a model that has forgotten the last ten
    /// minutes. Hypotheses are excluded: a half-heard sentence is not something
    /// to reintroduce as fact.
    private func startHistory() -> [JunoVoiceHistoryEntry] {
        let spoken = record.lines.compactMap { line -> JunoVoiceHistoryEntry? in
            let text = line.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard line.final, !text.isEmpty else { return nil }
            return JunoVoiceHistoryEntry(role: line.role, text: text)
        }
        return JunoVoiceHistoryEntry.bounded(seededHistory + spoken)
    }

    private func openTransport() async {
        let credential: JunoVoiceRelayToken
        do {
            credential = try await authorization.relayToken()
        } catch {
            // A credential that cannot be fetched is not a transport that
            // dropped: reporting it as one would spend the reconnect budget
            // retrying an account the backend is refusing.
            await run(machine.apply(.relayError(error.localizedDescription)))
            return
        }

        guard let base = credential.url ?? fallbackRelayURL,
            var components = URLComponents(url: base, resolvingAgainstBaseURL: false)
        else {
            await run(machine.apply(.relayError(RealtimeSessionFailure.notConfigured.message)))
            return
        }
        // The credential rides in the query string because that is the only place
        // a WebSocket handshake can carry it — the browser API cannot set headers,
        // so the relay authenticates from `?token=` for every client. It is
        // single-session and short-lived precisely because of that, and it is
        // never logged.
        var query = components.queryItems ?? []
        query.append(URLQueryItem(name: "token", value: credential.token))
        components.queryItems = query
        guard let url = components.url else {
            await run(machine.apply(.relayError(RealtimeSessionFailure.notConfigured.message)))
            return
        }

        do {
            try await transport.open(url: url)
        } catch {
            await run(machine.apply(.transportFailed(error.localizedDescription)))
            return
        }
        startReceiveLoop()
        startPingLoop()
        await run(machine.apply(.transportOpened))
    }

    /// The relay closes idle sockets, and a voice session is legitimately silent
    /// for long stretches while the reader thinks. Twenty seconds matches
    /// ``JunoRealtimeVoiceController``, which is what the relay's idle timeout was
    /// tuned against.
    private func startPingLoop() {
        pingLoop?.cancel()
        pingLoop = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(20))
                guard !Task.isCancelled, let self else { break }
                await self.pingIfLive()
            }
        }
    }

    /// A ping is a keepalive, not a probe. A failure to send one is reported
    /// through the same path as any other send, but it must not *manufacture* a
    /// session: pinging a socket that is connecting or already closed would open
    /// a failure the reader never had.
    private func pingIfLive() async {
        guard machine.phase.isLive else { return }
        _ = await send(.ping)
    }

    private func scheduleReconnect() {
        reconnectTask?.cancel()
        let delay = configuration.reconnectDelay
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled, let self else { return }
            await self.reconnectNow()
        }
    }

    private func reconnectNow() async {
        guard machine.phase == .reconnecting else { return }
        await openTransport()
    }

    @discardableResult
    private func send(_ message: JunoVoiceClientMessage) async -> Bool {
        guard let text = message.jsonText else { return false }
        do {
            try await transport.send(.text(text))
            return true
        } catch {
            // A send that fails is the same news as a receive that fails, and has
            // to reach the machine the same way — otherwise a half-dead socket
            // keeps a session nominally live with nothing crossing it.
            await run(machine.apply(.transportFailed(error.localizedDescription)))
            return false
        }
    }

    // MARK: Loops

    private func startReceiveLoop() {
        receiveLoop?.cancel()
        receiveLoop = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { break }
                do {
                    let frame = try await self.transport.receive()
                    guard !Task.isCancelled else { break }
                    await self.handle(frame)
                } catch {
                    // A cancelled receive is this client tearing down, not a
                    // dropped relay: reporting it would replace a clean ending
                    // with a connection error.
                    guard !Task.isCancelled else { break }
                    await self.handleTransportFailure(error)
                    break
                }
            }
        }
    }

    private func handleTransportFailure(_ error: any Error) async {
        await run(machine.apply(.transportFailed(error.localizedDescription)))
    }

    private func handle(_ frame: RealtimeTransportFrame) async {
        switch frame {
        case .binary(let data):
            // Playback is accepted whenever the session is live, including while
            // `interrupting`: the relay's last few frames are already in flight
            // when the interrupt goes out, and the flush that follows the relay's
            // acknowledgement is what actually silences them.
            guard machine.phase.isLive else { return }
            await audio.enqueuePlayback(data)
        case .text(let text):
            guard let message = JunoVoiceRelayMessage.decode(fromText: text) else { return }
            await handle(message)
        }
    }

    private func handle(_ message: JunoVoiceRelayMessage) async {
        switch message {
        case let .sessionReady(provider, capabilities):
            await run(machine.apply(.sessionReady(provider: provider, capabilities: capabilities)))

        case let .transcript(role, text, final, _):
            record.upsert(role: role, text: text, final: final, attachmentIDs: [])
            publish(.transcript(record.lines))

        case .turn(let turnPhase):
            if turnPhase == .start { record.beginAnswer() }
            await run(machine.apply(turnPhase == .start ? .assistantTurnBegan : .assistantTurnEnded))

        case .interrupted:
            await run(machine.apply(.relayInterrupted))

        case .usage(let update):
            usage = update
            publish(.usage(update))

        case .sessionClosed(let reason):
            await run(machine.apply(.relayClosed(reason)))

        case .error(let detail):
            await run(machine.apply(.relayError(detail)))

        case .pong, .unknown:
            break
        }
    }

    /// Drains the microphone: ship what may be shipped, meter everything, and let
    /// the detector decide whether the reader is talking over the answer.
    private func startCaptureLoop() {
        captureLoop?.cancel()
        let frames = audio.captureFrames()
        captureLoop = Task { [weak self] in
            for await frame in frames {
                guard !Task.isCancelled, let self else { break }
                await self.consume(frame)
            }
        }
    }

    private func consume(_ frame: RealtimeCaptureFrame) async {
        level = frame.loudness
        publish(.level(frame.loudness))

        if let pcm16 = frame.pcm16, machine.phase.isLive {
            do {
                try await transport.send(.binary(pcm16))
            } catch {
                await handleTransportFailure(error)
                return
            }
        }

        // The detector runs on the meter, which the endpoint reports whether or
        // not anything is being uploaded — that is the whole reason
        // ``RealtimeCaptureFrame`` carries both. While the model holds the floor
        // the uplink is suppressed and this is the only thing still listening.
        guard !muted, machine.phase == .responding, machine.bargeIn == .automatic else { return }
        if detector.observe(loudness: frame.loudness) == .began {
            await run(machine.apply(.userSpeechDetected))
        }
    }
}

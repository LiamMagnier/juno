#if canImport(AVFoundation) && canImport(Speech)
// `@preconcurrency` on this import alone, because AVFAudio's callback types are
// declared `@Sendable` while being invoked synchronously on the calling thread —
// annotations the framework predates. ``ConversionInput`` below is the *real*
// fix for the converter block; this covers the rest of the file's AVFoundation
// surface, which the macos-15 toolchain CI runs on diagnoses more strictly than
// the Xcode 27 toolchain available here. It is deliberately narrow: scoped to
// one import, so everything else in JunoVoiceKit stays fully checked.
@preconcurrency import AVFoundation
// CoreAudio's two error headers, imported by name rather than reached through
// AVFoundation: ``JunoRealtimeVoiceController/audioFailure(_:)`` matches on
// `kAudioUnitErr_*` and `kAudioHardware*` so that the mapping reads as the
// constants a developer will grep for, and not as a table of negative integers
// whose meanings are famously easy to transpose.
import AudioToolbox
import CoreAudio
import Foundation
import OSLog
import Observation
import Speech
#if os(macOS)
// Screen sharing only. AppKit is here for one call — CGImage → JPEG.
//
// ScreenCaptureKit is `@preconcurrency` defensively, in the same spirit as
// AVFoundation above: its filter and configuration are non-Sendable
// Objective-C classes that cross an `await` in ``runScreenShare(epoch:)``, and
// this toolchain accepts that while a stricter one need not. Screen share is a
// detail of one feature; it must not be able to fail the whole package's build.
import AppKit
@preconcurrency import ScreenCaptureKit
#endif

// MARK: - Session failures

/// Why a voice session could not start, or could not continue.
///
/// Split this finely on purpose. Every case here has a different remedy — open
/// Settings, retry, wait for the relay — and a single "voice failed" would leave
/// the UI guessing which one to offer.
public enum JunoRealtimeVoiceError: LocalizedError, Equatable {
    case notConfigured
    case micPermissionDenied
    case speechPermissionDenied
    case tokenFetchFailed(String)
    case connectionFailed(String)
    case audioEngineFailed(String)
    /// The relay reported a fatal problem of its own, in its own words.
    case relay(String)

    public var errorDescription: String? {
        switch self {
        case .notConfigured:
            "Realtime voice isn't configured for this environment."
        // The two platforms keep the switch in different places, and "Settings"
        // sends a Mac user to an app that does not have it.
        case .micPermissionDenied:
            #if os(macOS)
            "Microphone access was blocked. Allow it in System Settings › Privacy & Security › Microphone."
            #else
            "Microphone access was blocked. Allow it in Settings to talk to Juno."
            #endif
        case .speechPermissionDenied:
            #if os(macOS)
            "Speech recognition was blocked. This provider transcribes on this Mac — allow it in System Settings › Privacy & Security › Speech Recognition."
            #else
            "Speech recognition was blocked. This provider needs on-device transcription — allow it in Settings."
            #endif
        case .tokenFetchFailed(let detail):
            detail.isEmpty ? "Couldn't authorize the voice session." : detail
        case .connectionFailed(let detail):
            detail.isEmpty ? "Couldn't reach the voice relay." : detail
        case .audioEngineFailed(let detail):
            detail.isEmpty ? "The audio engine couldn't start." : detail
        case .relay(let detail):
            detail.isEmpty ? "The voice relay reported an error." : detail
        }
    }

    /// True when the fix is in Settings and not in retrying. The one distinction
    /// the UI has to make, because a retry button on a denied microphone does
    /// nothing at all — the system will never re-prompt.
    public var isPermissionDenial: Bool {
        self == .micPermissionDenied || self == .speechPermissionDenied
    }
}

// MARK: - Audio-thread shared state

/// The state the realtime audio thread and the main actor share.
///
/// A lock rather than an actor, for the same reason as `JunoSpeechService`'s tap
/// box: a tap block cannot `await`, and it runs under a realtime deadline. What
/// is different here is that this tap does not only *measure* — it converts and
/// **sends**, so the socket lives in the box too. Hopping to the main actor to
/// ship each ~40ms slice would put the uplink behind whatever else the UI is
/// doing on a busy frame, and voice is the one feature where that shows up as
/// audible lag rather than a dropped frame nobody sees.
private final class VoiceRelayShuttle: @unchecked Sendable {
    private let lock = NSLock()

    private var storedSocket: URLSessionWebSocketTask?
    private var storedConverter: AVAudioConverter?
    private var storedCaptureFormat: AVAudioFormat?
    private var storedSpeechRequest: SFSpeechAudioBufferRecognitionRequest?
    private var storedMuted = false
    private var storedAssistantSpeaking = false
    private var playbackDrain = RealtimePlaybackDrain()
    private var storedMicLevel: Double = 0
    private var storedPlaybackLevel: Double = 0

    var socket: URLSessionWebSocketTask? {
        get { lock.lock(); defer { lock.unlock() }; return storedSocket }
        set { lock.lock(); defer { lock.unlock() }; storedSocket = newValue }
    }

    var speechRequest: SFSpeechAudioBufferRecognitionRequest? {
        get { lock.lock(); defer { lock.unlock() }; return storedSpeechRequest }
        set { lock.lock(); defer { lock.unlock() }; storedSpeechRequest = newValue }
    }

    /// Mute is read on the audio thread, not applied by stopping the engine.
    /// Tearing the tap down and rebuilding it to unmute costs a rebuild's worth
    /// of dropped syllables; skipping the send costs nothing.
    var muted: Bool {
        get { lock.lock(); defer { lock.unlock() }; return storedMuted }
        set { lock.lock(); defer { lock.unlock() }; storedMuted = newValue }
    }

    /// True while Juno holds the floor, and the reason the uplink goes quiet.
    ///
    /// **This is half-duplex, and it is what stops Juno answering itself.** The
    /// speakers are feeding the microphone, so anything uploaded while the model
    /// is talking is the model's own voice coming back — which it hears as the
    /// user interrupting, and replies to. Voice-processing IO cancels that echo
    /// when it initialises, but it does not always: `startAudioEngine` falls back
    /// to a plain graph precisely because the voice-processing unit refuses on
    /// Macs whose input and output are different devices. On that rung there is
    /// no canceller at all, so suppressing the send is the only thing between a
    /// working call and a conversation the model has with itself.
    ///
    /// The web enforces exactly this for exactly this reason. Barge-in is the
    /// on-screen Interrupt control, not talking over the answer.
    var assistantSpeaking: Bool {
        get { lock.lock(); defer { lock.unlock() }; return storedAssistantSpeaking }
        set { lock.lock(); defer { lock.unlock() }; storedAssistantSpeaking = newValue }
    }

    /// Keeps raw-capture uplink suppressed until the speaker has actually
    /// drained, not merely until the provider has finished *sending* audio.
    /// Relay `turn.end` commonly arrives while several buffers are still queued;
    /// opening the microphone at that frame feeds the tail of Juno's own answer
    /// back as a new user turn on Macs running without echo cancellation.
    func playbackBufferScheduled() {
        lock.lock(); defer { lock.unlock() }
        playbackDrain.scheduled()
    }

    func playbackBufferCompleted() {
        lock.lock(); defer { lock.unlock() }
        playbackDrain.completed()
    }

    func clearPlaybackBuffers() {
        lock.lock(); defer { lock.unlock() }
        playbackDrain.clear()
    }

    var micLevel: Double {
        get { lock.lock(); defer { lock.unlock() }; return storedMicLevel }
        set { lock.lock(); defer { lock.unlock() }; storedMicLevel = newValue }
    }

    var playbackLevel: Double {
        get { lock.lock(); defer { lock.unlock() }; return storedPlaybackLevel }
        set { lock.lock(); defer { lock.unlock() }; storedPlaybackLevel = newValue }
    }

    func configureCapture(converter: AVAudioConverter, captureFormat: AVAudioFormat) {
        lock.lock(); defer { lock.unlock() }
        storedConverter = converter
        storedCaptureFormat = captureFormat
    }

    func reset() {
        lock.lock(); defer { lock.unlock() }
        storedSocket = nil
        storedConverter = nil
        storedCaptureFormat = nil
        storedSpeechRequest = nil
        storedMicLevel = 0
        storedPlaybackLevel = 0
        playbackDrain.clear()
        // A session that ends mid-answer leaves this true, and a stale true is a
        // microphone that never uploads again. The controller does re-assign
        // `assistantSpeaking` on the next start, but a teardown invariant should
        // not depend on a distant assignment to be safe.
        storedAssistantSpeaking = false
    }

    /// The whole uplink, on the audio thread: meter, feed the recognizer,
    /// downsample to PCM16 mono 16 kHz, ship one binary frame.
    ///
    /// The level is measured even while muted — the meter is what tells someone
    /// their microphone is muted rather than broken.
    func processMic(_ buffer: AVAudioPCMBuffer) {
        let frames = Int(buffer.frameLength)
        guard frames > 0, let floatData = buffer.floatChannelData else { return }
        let channelCount = Int(buffer.format.channelCount)
        let ch0 = floatData[0]
        let ch1 = channelCount > 1 ? floatData[1] : nil

        var sum: Float = 0
        for index in 0..<frames {
            let sample = ch1 != nil ? (ch0[index] + ch1![index]) * 0.5 : ch0[index]
            sum += sample * sample
        }
        micLevel = Double((sum / Float(frames)).squareRoot())

        // Metering continues above this line and the send stops below it.
        lock.lock()
        let uplinkSuppressed = storedMuted || storedAssistantSpeaking
            || playbackDrain.isActive
        lock.unlock()
        guard !uplinkSuppressed else { return }
        speechRequest?.append(buffer)

        lock.lock()
        let socket = storedSocket
        lock.unlock()
        guard let socket else { return }

        let inRate = buffer.format.sampleRate
        guard inRate > 0 else { return }
        let targetRate = 16000.0
        let ratio = inRate / targetRate
        let outFrames = max(1, Int(Double(frames) / ratio))
        var pcmData = Data(count: outFrames * MemoryLayout<Int16>.size)
        pcmData.withUnsafeMutableBytes { raw in
            let dest = raw.bindMemory(to: Int16.self)
            for k in 0..<outFrames {
                let start = Int(Double(k) * ratio)
                let end = min(frames, Int(Double(k + 1) * ratio))
                var acc: Float = 0
                if end > start {
                    for j in start..<end {
                        let sample = ch1 != nil ? (ch0[j] + ch1![j]) * 0.5 : ch0[j]
                        acc += sample
                    }
                    acc /= Float(end - start)
                } else if start < frames {
                    acc = ch1 != nil ? (ch0[start] + ch1![start]) * 0.5 : ch0[start]
                }
                let clamped = max(-1.0, min(1.0, acc))
                dest[k] = Int16(clamped * 32767.0).littleEndian
            }
        }
        socket.send(.data(pcmData)) { _ in }
    }
}

/// The single input buffer handed to one `AVAudioConverter.convert` call, plus
/// the flag that makes it a once-only supply.
///
/// `@unchecked Sendable`, and the reason is specific rather than a shrug:
/// `AVAudioConverterInputBlock` is *typed* `@Sendable` but is invoked
/// **synchronously**, on the calling thread, before
/// `convert(to:error:withInputFrom:)` returns. One instance is created per tap
/// callback, is reachable only from that one `convert` call, and is dead before
/// the next line runs — so no two threads can ever see it, and the compiler's
/// concurrency rules are being satisfied for an API that predates them.
///
/// A captured `var` and a bare buffer were used here before, which the checker
/// rejects for exactly the right general reason; the box is what states the
/// narrower fact that makes it safe. Nothing outside this file may hold one.
private final class ConversionInput: @unchecked Sendable {
    let buffer: AVAudioPCMBuffer
    var consumed = false

    init(buffer: AVAudioPCMBuffer) {
        self.buffer = buffer
    }
}

// MARK: - Composed turns

/// One image on a composed voice turn: the JPEG the model is shown, and the
/// uploaded attachment it came from.
///
/// The two travel together rather than as parallel arrays because they are
/// pruned together — the relay's frame ceiling drops individual images, and an
/// id left behind by a dropped one would file a picture into the saved
/// conversation that nothing in the conversation ever saw.
///
/// ``attachmentID`` is optional, and nil is a real state rather than a caller's
/// mistake: the picture is on the reader's device the moment they pick it, and
/// the upload that mints its id finishes some time later. Sending the turn
/// without waiting is the right trade — the model sees the image either way, and
/// only the saved copy goes without it.
public struct JunoVoiceTurnImage: Equatable, Sendable {
    public let jpeg: Data
    public let attachmentID: String?

    public init(jpeg: Data, attachmentID: String? = nil) {
        self.jpeg = jpeg
        self.attachmentID = attachmentID
    }
}

// MARK: - Controller

/// One realtime voice session against the Juno voice relay.
///
/// A single WebSocket carries microphone audio up as PCM16/16k and the model's
/// speech down as PCM16/24k, with JSON control frames on the same socket (see
/// `JunoVoiceRelayProtocol`). This owns the audio engine, the reconnect, and the
/// on-device recognizer that only some providers need — but nothing visual. The
/// app draws its own orb from ``level`` and ``phase``.
///
/// Three things here are deliberate and easy to undo by accident:
///
/// - **The relay credential is injected**, not fetched from a singleton. See
///   ``JunoVoiceRelayAuthorizing``.
/// - **The microphone tap is installed from a `nonisolated static` helper.**
///   Under Swift 6 a closure written inside this `@MainActor` type inherits main
///   actor isolation, and the compiler's executor check then runs
///   `dispatch_assert_queue` on the realtime audio thread and traps. See
///   ``installMicTap(on:format:box:)``.
/// - **Reconnect is attempted exactly once**, and only from `live`. A retry loop
///   against a relay that is refusing this account is a loop that bills the
///   backend and never reaches audio.
@MainActor
@Observable
public final class JunoRealtimeVoiceController {

    /// Where the session is. `reconnecting` deliberately persists until the
    /// relay's next `session.ready`, so the UI cannot claim the conversation is
    /// back while the provider is still being re-established.
    public enum Phase: Equatable, Sendable {
        case idle
        case connecting
        case live
        case reconnecting
        case ended(JunoVoiceCloseReason)
        case error(JunoRealtimeVoiceError)
    }

    /// One line of conversation. Non-final lines are live hypotheses and are
    /// rewritten in place, which is why identity is a `UUID` and not the text.
    public typealias TranscriptLine = JunoVoiceTranscriptRecord.Line

    /// How many lines are kept. A long session otherwise grows an array that
    /// SwiftUI re-diffs on every partial transcript, several times a second.
    public static let transcriptCapacity = JunoVoiceTranscriptRecord.capacity

    public private(set) var phase: Phase = .idle

    /// The conversation as it happened.
    ///
    /// Reading through the record rather than storing the array directly is what
    /// keeps the ordering rule in one testable place — see
    /// ``JunoVoiceTranscriptRecord``, which exists because getting this wrong
    /// prints every question underneath its own answer.
    public var transcript: [TranscriptLine] { record.lines }
    private var record = JunoVoiceTranscriptRecord()
    /// The provider actually in use — set from the relay's `session.ready`, not
    /// from the request, so a relay that substituted a provider is not
    /// misreported in the UI.
    public private(set) var provider: JunoVoiceProvider
    public private(set) var capabilities: JunoVoiceCapabilities?
    public private(set) var usage: JunoVoiceUsage?
    /// 0–1, smoothed: the greater of the microphone level while the user talks
    /// and the playback level while the model does. One number, because the orb
    /// only ever shows whoever currently holds the floor.
    public private(set) var level: Double = 0
    /// Mirrored onto the audio shuttle on every change, because the uplink reads
    /// it from the audio thread to hold half-duplex — see
    /// ``VoiceRelayShuttle/assistantSpeaking``. A `didSet` rather than an
    /// assignment beside each of the six places this moves: the one that gets
    /// forgotten is the one where Juno starts answering itself, and that failure
    /// looks like a model bug rather than a missing line.
    public private(set) var assistantSpeaking = false {
        didSet { box.assistantSpeaking = assistantSpeaking }
    }
    public private(set) var muted = false
    /// Whether talking over Juno interrupts it.
    ///
    /// **A fact about the audio hardware, never a preference**, which is why it
    /// is resolved from the input node in ``buildAudioGraph(voiceProcessing:)``
    /// and not from a setting. Without echo cancellation the microphone hears the
    /// speakers, so the detector's "someone is talking" is *Juno* talking — and
    /// automatic barge-in becomes a session that hangs up on its own first
    /// syllable, every answer, with nothing on screen to explain it. See
    /// ``RealtimeBargeInPolicy``, whose `.unknown` case resolves to
    /// ``RealtimeBargeInPolicy/manualOnly`` for exactly that reason.
    ///
    /// ``manualOnly`` is not a degraded mode: the Interrupt control works under
    /// both policies and is the interruption that is always available.
    public private(set) var bargeIn: RealtimeBargeInPolicy = .manualOnly
    /// The session as ``RealtimeSessionMachine`` sees it — finer than ``phase``
    /// in the one place a reader can feel: `listening` / `responding` /
    /// `interrupting` are three separate states where ``Phase/live`` is one.
    ///
    /// Published so a surface can say "Interrupting…" for the round trip between
    /// the interrupt going out and the relay confirming it dropped the turn.
    /// Without it that window renders as "Juno is speaking" over silence, which
    /// reads as the interruption having been ignored.
    public private(set) var sessionPhase: RealtimeSessionPhase = .idle
    /// A non-fatal relay notice, cleared after a few seconds. The relay sends
    /// `error` frames mid-session for things a conversation survives; promoting
    /// those to ``Phase/error(_:)`` would hang up on a recoverable hiccup.
    public private(set) var notice: String?
    /// True while this controller's native desktop screen capture is being
    /// streamed to the model. iPhone ReplayKit capture is owned by the mobile
    /// voice dock and uses ``sendVideoFrame(_:)`` directly, because ReplayKit's
    /// lifecycle is distinct from the controller's macOS ScreenCaptureKit task.
    public private(set) var screenSharing = false
    #if os(iOS)
    public private(set) var speakerOutput = true
    #endif

    private let authorization: any JunoVoiceRelayAuthorizing
    /// Used only when the token response does not name a relay.
    private let fallbackRelayURL: URL?

    /// The shared lifecycle reducer, run **alongside** this controller rather
    /// than in place of it.
    ///
    /// Every event this controller learns about is mirrored in, so the reducer's
    /// phase is a second, testable reading of the same session — but only the
    /// barge-in transitions have their effects executed (see ``perform(_:)``).
    /// A full swap would put the reconnect, the recognizer, ScreenCaptureKit and
    /// the composed-turn bookkeeping through a reducer none of them has ever run
    /// under; this gets the two behaviours that were previously unreachable —
    /// automatic barge-in and an observable `interrupting` — without moving the
    /// working call onto an untested spine.
    ///
    /// Drift is safe by construction: an event the reducer does not expect
    /// returns `[]` and leaves its phase alone, and every barge-in decision is
    /// gated on it being in ``RealtimeSessionPhase/responding``. A mirror that
    /// has fallen behind therefore withholds automatic barge-in, which is the
    /// same place the hardware gate already lands.
    private var session: RealtimeSessionMachine
    /// Reads the same 0…1 meter the orb is drawn from and decides whether the
    /// reader has started talking over the answer. Only consulted under
    /// ``RealtimeBargeInPolicy/automatic``.
    private var detector = RealtimeVoiceActivityDetector()
    /// What the input node reported once the graph was up. ``RealtimeEchoCancellation/unknown``
    /// before ``startAudioEngine()`` and after teardown — a third answer, not a
    /// pessimistic second one.
    private var echoCancellation: RealtimeEchoCancellation = .unknown

    private let box = VoiceRelayShuttle()
    /// On macOS capture and playback must not share a graph. The Voice Processing
    /// IO unit is duplex even when requested from `inputNode`; combining it with
    /// the player made CoreAudio reconcile independent device formats and is the
    /// reproduced source of -10875 on the owner's built-in route.
    private var audioEngine: AVAudioEngine?
    private var playbackEngine: AVAudioEngine?
    private var playerNode: AVAudioPlayerNode?
    private var playbackFormat: AVAudioFormat?
    private var socket: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var pingTask: Task<Void, Never>?
    private var meterTask: Task<Void, Never>?
    private var noticeTask: Task<Void, Never>?
    private var audioConfigurationObservers: [NSObjectProtocol] = []
    private var audioRouteRecoveryTask: Task<Void, Never>?
    /// Set by ``end()``. Every async step re-checks it, because a token fetch or
    /// a permission prompt can outlive the screen that started it and would
    /// otherwise bring an audio engine up behind a dismissed sheet.
    private var closedByUser = false
    private var reconnectAttempted = false
    /// The chat that was on screen when the call opened, already bounded. Kept
    /// for the length of the session because a reconnect is a new socket to a
    /// new relay session, which seeds its history from scratch.
    private var seededHistory: [JunoVoiceHistoryEntry] = []
    /// Attachment ids for composed turns the relay has not echoed back yet, in
    /// send order. An array rather than a dictionary so the oldest is the one
    /// dropped when the bound is reached.
    private var pendingTurnAttachments: [
        (turnID: String, attachmentIDs: [String], context: String?)
    ] = []
    #if os(macOS)
    private var screenShareTask: Task<Void, Never>?
    /// Bumped by every start and every stop. A capture loop that is already
    /// unwinding checks it before touching ``screenSharing``, so a stop
    /// immediately followed by a start cannot have the old loop's last statement
    /// switch the new one off.
    private var screenShareEpoch = 0
    #endif

    // On-device transcription — only for providers whose capabilities say the
    // relay has no transcript of its own.
    private var speechRecognizer: SFSpeechRecognizer?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var transcribing = false
    /// Resolved once per session; see the note where it is assigned.
    private var prefersOnDeviceRecognition = false
    private var transcriberRestartTask: Task<Void, Never>?

    // MARK: Lifecycle

    /// - Parameters:
    ///   - authorization: Supplies the per-session relay credential.
    ///   - relayURL: The relay to dial when the token response does not name
    ///     one. Optional rather than required so a build with no relay
    ///     configured fails as ``JunoRealtimeVoiceError/notConfigured`` at
    ///     `start()` instead of being unrepresentable at the call site.
    ///   - provider: The provider the first session asks for.
    public init(
        authorization: any JunoVoiceRelayAuthorizing,
        relayURL: URL? = nil,
        provider: JunoVoiceProvider = .productionDefault
    ) {
        self.authorization = authorization
        self.fallbackRelayURL = relayURL
        self.provider = provider
        self.session = RealtimeSessionMachine(provider: provider)
    }

    // MARK: Session mirror

    /// Feeds one event to ``session`` and republishes its phase.
    ///
    /// The returned effects are **discarded by default**. This controller
    /// already owns the socket, the engine, the recognizer and the reconnect,
    /// and running the reducer's `closeTransport`/`stopAudio`/`scheduleReconnect`
    /// on top of that would tear a session down twice. Only ``interrupt()`` and
    /// ``noticeBargeIn(_:)`` pass the result on to ``perform(_:)``, because the
    /// barge-in effects are the ones the controller has no other source for.
    @discardableResult
    private func advance(_ event: RealtimeSessionEvent) -> [RealtimeSessionEffect] {
        let effects = session.apply(event)
        sessionPhase = session.phase
        return effects
    }

    /// Executes the barge-in effects, and only those.
    ///
    /// `flushPlayback` before `sendInterrupt` is the reducer's ordering and it is
    /// load-bearing: the queued buffers are already on the player node, so
    /// waiting for the relay to acknowledge means Juno talks over the
    /// interruption for a whole round trip. `setUplinkSuppressed(false)` matters
    /// just as much — half-duplex has the microphone muted while Juno holds the
    /// floor, and an interruption nobody unmutes is one the relay never hears.
    ///
    /// Anything else the reducer asks for is ignored here on purpose; see
    /// ``advance(_:)``.
    private func perform(_ effects: [RealtimeSessionEffect]) {
        for effect in effects {
            switch effect {
            case .flushPlayback:
                flushPlayback()
            case .sendInterrupt:
                send(.controlInterrupt)
            case .setUplinkSuppressed(let suppressed):
                assistantSpeaking = suppressed
            case .notice(let message):
                showNotice(message)
            case .startAudio, .openTransport, .sendSessionStart, .scheduleReconnect,
                .closeTransport, .stopAudio:
                // Owned by this controller's own lifecycle, which has already
                // run them or is about to.
                break
            }
        }
    }

    /// The floor changed hands, so the run of frames counted against the
    /// previous speaker must not decide anything about the next one. Called
    /// wherever ``assistantSpeaking`` moves for a reason other than barge-in.
    private func resetVoiceActivity() {
        detector.reset()
    }

    /// Automatic barge-in, one meter frame at a time.
    ///
    /// Four gates, each one a specific failure it prevents: the policy (the
    /// microphone hears the speakers without echo cancellation), mute (a muted
    /// microphone cannot be talking over anything, and the frames captured just
    /// before the mute must not fire an interruption just after it),
    /// ``assistantSpeaking`` (there is nothing to interrupt otherwise), and the
    /// reducer itself, which returns no effects unless it agrees Juno holds the
    /// floor.
    private func noticeBargeIn(_ loudness: Double) {
        guard bargeIn == .automatic, !muted, assistantSpeaking else { return }
        guard detector.observe(loudness: loudness) == .began else { return }
        perform(advance(.userSpeechDetected))
    }

    /// Hardware truth, mirrored onto both the published property and the
    /// reducer, so a surface and a barge-in decision can never read different
    /// answers to the same question.
    private func setBargeInPolicy(_ policy: RealtimeBargeInPolicy) {
        bargeIn = policy
        session.setBargeInPolicy(policy)
        resetVoiceActivity()
    }

    /// A never-empty detail for the reducer's failure events. `LocalizedError`
    /// makes `errorDescription` optional and the reducer stores whatever it is
    /// handed; an empty string there would render as a blank explanation.
    private nonisolated static func mirrorDetail(_ error: JunoRealtimeVoiceError) -> String {
        let described = error.errorDescription ?? ""
        return described.isEmpty ? "The voice session could not continue." : described
    }

    /// Connects and starts a session. Safe to call again from `ended` or
    /// `error`, which is how "Start again" works without rebuilding the object —
    /// and refusing it from `connecting`/`live` is what stops a double tap from
    /// opening two sockets onto one audio engine.
    ///
    /// - Parameter history: The finalized turns of the chat this call was opened
    ///   from, so the model knows what is being talked about. Nil, not empty, is
    ///   "unchanged" — "Start again" after a failure passes nothing and keeps the
    ///   context the first attempt was given, where an empty array would restart
    ///   the conversation blind. Bounding happens here; callers pass the chat.
    public func start(
        provider requested: JunoVoiceProvider? = nil,
        history: [JunoVoiceHistoryEntry]? = nil
    ) async {
        switch phase {
        case .idle, .ended, .error: break
        default: return
        }
        closedByUser = false
        reconnectAttempted = false
        if let history { seededHistory = JunoVoiceHistoryEntry.bounded(history) }
        pendingTurnAttachments = []
        record.reset()
        usage = nil
        capabilities = nil
        notice = nil
        assistantSpeaking = false
        if let requested { provider = requested }
        phase = .connecting
        // A fresh reducer per session, pinned to manual barge-in until the audio
        // graph has been asked what it is actually doing about echo. Carrying the
        // previous call's policy across would let a session that had headphones
        // start automatic on a Mac that no longer has them.
        session = RealtimeSessionMachine(provider: provider)
        echoCancellation = .unknown
        setBargeInPolicy(.manualOnly)
        advance(.start)

        guard await requestMicPermission() else {
            advance(.audioFailed(Self.mirrorDetail(JunoRealtimeVoiceError.micPermissionDenied)))
            phase = .error(.micPermissionDenied)
            return
        }
        guard !closedByUser else { return }
        await connect(isReconnect: false)
    }

    /// Tears everything down. Idempotent, because both the close button and the
    /// view's disappearance call it and either can come first.
    public func end() {
        guard !closedByUser else { return }
        closedByUser = true
        advance(.end)
        teardown(closeCode: .normalClosure)
        // A session that already ended or failed keeps that phase: overwriting a
        // relay's reason with "client" would lose the only explanation the user
        // is going to get.
        switch phase {
        case .ended, .error: break
        default: phase = .ended(.client)
        }
    }

    // MARK: Controls

    public func toggleMute() {
        setMuted(!muted)
    }

    /// Mute stops the uplink, not the capture — see ``VoiceRelayShuttle/muted``.
    public func setMuted(_ newValue: Bool) {
        muted = newValue
        box.muted = newValue
        // A muted microphone cannot be talking over the answer. Retiring the
        // run here is what stops the frames captured just before the mute from
        // firing an interruption just after it.
        if newValue { resetVoiceActivity() }
    }

    /// Barge-in, by hand. Local playback is flushed *before* the relay is told,
    /// because the queued buffers are already on the player node: waiting for the
    /// relay to acknowledge means the model keeps talking over the interruption
    /// for as long as the round trip takes.
    ///
    /// Works under **either** ``bargeIn`` policy — the on-screen control is the
    /// interruption that is always available, which is exactly why
    /// ``RealtimeBargeInPolicy/manualOnly`` is a usable mode and not a broken one.
    ///
    /// The flush and the send stay here rather than being delegated to the
    /// reducer's effects: this is the path a reader's finger takes, and it must
    /// not become conditional on the mirror agreeing about whose turn it is.
    /// ``advance(_:)`` is still fed, so the mirror reaches `interrupting` and the
    /// surface can say so.
    public func interrupt() {
        guard phase == .live else { return }
        flushPlayback()
        send(.controlInterrupt)
        resetVoiceActivity()
        advance(.interruptRequested)
    }

    /// Switches provider on the live socket when live, or restarts connection when connecting.
    public func switchProvider(_ newProvider: JunoVoiceProvider) {
        guard newProvider != provider else { return }
        provider = newProvider
        // Everything derived from capabilities is invalid until the new
        // `session.ready` says otherwise. Leaving the recognizer running would
        // send this client's transcript to a provider that also hears the audio,
        // and the model would answer everything twice.
        capabilities = nil
        stopTranscriber()
        #if os(macOS)
        // A capture belongs to the provider that accepted it. Stopping it here
        // is what keeps a switch to a provider without screen support from
        // leaving the screen being recorded with nothing reading it — the one
        // failure a purple menu-bar indicator makes very visible.
        stopScreenShare()
        #endif
        flushPlayback()
        assistantSpeaking = false
        // The mirror has no "switch provider" event, and it does not need one:
        // the floor is being handed back either way, and saying so is what stops
        // it sitting in `responding` for a turn that was just dropped.
        resetVoiceActivity()
        advance(.assistantTurnEnded)
        if phase == .live {
            send(.sessionSwitch(provider: newProvider))
        } else {
            Task {
                end()
                await start(provider: newProvider)
            }
        }
    }

    #if os(iOS)
    /// Speaker vs. receiver. Routing only — the session is not disturbed, so
    /// this can be flipped mid-sentence.
    public func toggleSpeaker() {
        speakerOutput.toggle()
        try? AVAudioSession.sharedInstance()
            .overrideOutputAudioPort(speakerOutput ? .speaker : .none)
    }
    #endif

    // MARK: Connection

    private func connect(isReconnect: Bool) async {
        let credential: JunoVoiceRelayToken
        do {
            credential = try await authorization.relayToken()
        } catch {
            phase = .error(.tokenFetchFailed(error.localizedDescription))
            return
        }
        guard !closedByUser else { return }

        guard let base = credential.url ?? fallbackRelayURL,
            var components = URLComponents(url: base, resolvingAgainstBaseURL: false)
        else {
            phase = .error(.notConfigured)
            return
        }
        // The credential rides in the query string because that is the only
        // place a WebSocket handshake can carry it — the browser API cannot set
        // headers, so the relay authenticates from `?token=` for every client.
        // It is single-session and short-lived precisely because of that.
        var query = components.queryItems ?? []
        query.append(URLQueryItem(name: "token", value: credential.token))
        components.queryItems = query
        guard let relayURL = components.url else {
            phase = .error(.notConfigured)
            return
        }

        // Reconnects reuse the running engine. Rebuilding it would re-arm the
        // audio session and swallow the first word after the gap — but only a
        // *running* engine is worth reusing. A route change stops the engine
        // underneath a live session (AirPods walking out of range, an interface
        // unplugged), and reconnecting onto that carcass hands the reader a
        // conversation with no audio in either direction and no error to
        // explain it.
        if audioEngine?.isRunning != true || playbackEngine?.isRunning != true {
            do {
                try startAudioEngine()
            } catch {
                // Already a ``JunoRealtimeVoiceError``: the audio path maps
                // CoreAudio's OSStatus onto something actionable itself, and
                // re-wrapping it in `.audioEngineFailed(_:)` here would flatten
                // the refusal case the UI turns into a Settings link.
                advance(.audioFailed(Self.mirrorDetail(error)))
                phase = .error(error)
                return
            }
        }

        let task = URLSession.shared.webSocketTask(with: relayURL)
        socket = task
        box.socket = task
        task.resume()
        send(.sessionStart(provider: provider, history: startHistory()))
        startReceiving(on: task)
        startPinging()
        startMetering()
        // After the send, not before: the reducer answers `transportOpened` with
        // `sendSessionStart`, and this controller has already done that. Feeding
        // it here keeps the mirror's phase at `negotiating` — which is what makes
        // the next `session.ready` a transition the reducer accepts rather than
        // one it ignores, and an ignored `ready` is a mirror that never reaches
        // `responding` and therefore never allows barge-in.
        advance(.transportOpened)
        if isReconnect { phase = .reconnecting }
    }

    /// The context for `session.start`: the chat the call was opened from, plus
    /// anything already said in the call itself.
    ///
    /// The second half is what makes a reconnect invisible. A dropped socket
    /// gets a fresh relay session with an empty provider history, so without
    /// replaying what has been said the conversation resumes mid-thought with a
    /// model that has forgotten the last ten minutes. Hypotheses are excluded:
    /// a half-heard sentence is not something to reintroduce as fact.
    private func startHistory() -> [JunoVoiceHistoryEntry] {
        let spoken = record.lines.compactMap { line -> JunoVoiceHistoryEntry? in
            let text = line.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard line.final, !text.isEmpty else { return nil }
            return JunoVoiceHistoryEntry(role: line.role, text: text, context: line.context)
        }
        return JunoVoiceHistoryEntry.bounded(seededHistory + spoken)
    }

    private func startReceiving(on task: URLSessionWebSocketTask) {
        receiveTask?.cancel()
        receiveTask = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    let message = try await task.receive()
                    guard !Task.isCancelled else { break }
                    await self?.handle(message)
                } catch {
                    // A cancelled receive is this controller tearing down, not a
                    // dropped relay: reporting it would replace a clean ending
                    // with a connection error.
                    guard !Task.isCancelled else { break }
                    self?.socketFailed(error)
                    break
                }
            }
        }
    }

    /// The relay closes idle sockets, and a voice session is legitimately silent
    /// for long stretches while the user thinks.
    private func startPinging() {
        pingTask?.cancel()
        pingTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(20))
                guard !Task.isCancelled, let self else { break }
                self.send(.ping)
            }
        }
    }

    private func socketFailed(_ error: any Error) {
        guard !closedByUser else { return }
        if case .ended = phase { return }
        advance(.transportFailed(error.localizedDescription))
        if phase == .live, !reconnectAttempted {
            // Once, and only from `live`. A drop before the first
            // `session.ready` is usually a rejected credential, and retrying it
            // just fails again more expensively.
            reconnectAttempted = true
            phase = .reconnecting
            stopTranscriber()
            flushPlayback()
            capabilities = nil
            assistantSpeaking = false
            resetVoiceActivity()
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(1))
                guard let self, !self.closedByUser else { return }
                await self.connect(isReconnect: true)
            }
        } else {
            teardown(closeCode: .abnormalClosure)
            phase = .error(.connectionFailed(error.localizedDescription))
        }
    }

    // MARK: Inbound

    private func handle(_ message: URLSessionWebSocketTask.Message) async {
        switch message {
        case .data(let data):
            schedulePlayback(data)
        case .string(let text):
            guard let decoded = JunoVoiceRelayMessage.decode(fromText: text) else { return }
            await handleRelayMessage(decoded)
        @unknown default:
            break
        }
    }

    private func handleRelayMessage(_ message: JunoVoiceRelayMessage) async {
        switch message {
        case .sessionReady(let readyProvider, let readyCapabilities):
            provider = readyProvider
            capabilities = readyCapabilities
            // The reconnect budget is per outage, not per session: a session
            // that recovered has earned another attempt if it drops again.
            reconnectAttempted = false
            phase = .live
            advance(.sessionReady(provider: readyProvider, capabilities: readyCapabilities))
            if readyCapabilities.needsClientTranscript {
                await startTranscriber()
            } else {
                stopTranscriber()
            }

        case .transcript(let role, let text, let final, let turnID):
            upsertTranscript(role: role, text: text, final: final, turnID: turnID)

        case .turn(let turnPhase):
            assistantSpeaking = turnPhase == .start
            // The floor changed hands, so the run of loud frames counted against
            // whoever had it before must not decide anything about whoever has it
            // now — otherwise the tail of Juno's own first word arrives at the
            // detector as the reader interrupting.
            resetVoiceActivity()
            advance(turnPhase == .start ? .assistantTurnBegan : .assistantTurnEnded)
            // The answer starts here, whatever arrives next. Recorded on the
            // relay's own turn frame rather than on the first assistant word,
            // because some relays send the frame first and some do not.
            if turnPhase == .start { record.beginAnswer() }

        case .interrupted:
            flushPlayback()
            assistantSpeaking = false
            resetVoiceActivity()
            advance(.relayInterrupted)

        case .usage(let update):
            usage = update

        case .sessionClosed(let reason):
            advance(.relayClosed(reason))
            teardown(closeCode: .normalClosure)
            phase = .ended(reason)

        case .error(let detail):
            // Fatal only before the session is up. Once audio is flowing the
            // same frame means "that turn had a problem", and hanging up on it
            // would end conversations that were fine.
            //
            // The mirror is fed the same frame and draws the same distinction
            // itself — its `notice` effect is dropped here rather than executed,
            // because ``showNotice(_:)`` below is already the one that runs.
            advance(.relayError(detail))
            if phase == .connecting || phase == .reconnecting {
                teardown(closeCode: .normalClosure)
                phase = .error(.relay(detail))
            } else {
                showNotice(detail)
            }

        case .pong, .unknown:
            break
        }
    }

    /// Delegates to ``JunoVoiceTranscriptRecord``, which owns the ordering rule
    /// and is tested on its own. Nothing about placing a line depends on the
    /// socket, so nothing about it belongs in the socket's controller.
    ///
    /// The turn id is resolved here rather than in the record, because what a
    /// turn id means — "the composed turn this socket sent, coming back" — is a
    /// fact about the socket and nothing at all about ordering lines. Only the
    /// reader's own turns can carry images, so an id echoed on an assistant line
    /// claims nothing.
    ///
    /// Defaulted to nil so the on-device recognizer — which invents its own
    /// lines and has no turn to claim — keeps calling this without one.
    private func upsertTranscript(
        role: JunoVoiceTranscriptRole,
        text: String,
        final: Bool,
        turnID: String? = nil
    ) {
        let metadata = role == .user ? takeTurnMetadata(for: turnID) : nil
        record.upsert(
            role: role,
            text: text,
            final: final,
            attachmentIDs: metadata?.attachmentIDs ?? [],
            context: metadata?.context
        )
    }

    private func showNotice(_ message: String) {
        notice = message
        noticeTask?.cancel()
        noticeTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(6))
            guard !Task.isCancelled else { return }
            self?.notice = nil
        }
    }

    // MARK: Outbound

    private func send(_ message: JunoVoiceClientMessage) {
        guard let socket, let text = message.jsonText else { return }
        socket.send(.string(text)) { _ in }
    }

    // MARK: Video

    /// Ships one JPEG to the model as a `video.frame`.
    ///
    /// The encode and the send happen here, on the main actor, and deliberately
    /// **not** through ``VoiceRelayShuttle``: that box exists for the microphone's
    /// realtime thread, and base64-encoding a megabyte inside an audio callback
    /// would miss the buffer deadline the entire uplink depends on. A frame a
    /// second on the main actor is nothing; a frame a second in the tap is a
    /// glitch a second.
    ///
    /// Silent about every frame it drops, on purpose. This is called on a timer —
    /// once a second while a screen is shared, and per preview frame from the
    /// iPhone's camera — so a session that is not live, or a provider that cannot
    /// see, has to cost nothing rather than produce a notice a second.
    public func sendVideoFrame(_ jpeg: Data) {
        guard phase == .live, socket != nil, (capabilities?.videoInput == true || capabilities?.screenInput == true) else { return }
        guard let encoded = Self.relayFrame(jpeg) else { return }
        send(.videoFrame(jpegBase64: encoded))
    }

    /// Base64 for the wire, or nil when the relay would throw the frame away.
    ///
    /// The ceiling is checked on the *encoded* string because that is the length
    /// the relay measures; the check on the raw bytes in front of it only avoids
    /// allocating a third again as much memory for a frame that is already past
    /// hope. A frame the relay discards is one the user waited a second for and
    /// the model never saw, so it is better not to spend the uplink on it.
    nonisolated static func relayFrame(_ jpeg: Data) -> String? {
        guard !jpeg.isEmpty, jpeg.count < maxVideoFrameBytes else { return nil }
        let encoded = jpeg.base64EncodedString()
        guard encoded.utf8.count < maxVideoFrameBytes else { return nil }
        return encoded
    }

    /// The relay forwards a frame only while its base64 payload is under this.
    nonisolated static let maxVideoFrameBytes = 2_000_000
    /// Matches the web composer, and the `/api/voice/transcript` schema, which
    /// caps `attachmentIds` at four per turn. Past four images a turn, providers
    /// start answering about the first one and ignoring the rest.
    nonisolated static let maxTurnImages = 4

    /// Sends one composed turn — text plus up to four images — through the live
    /// session, the way the web composer does while voice is open.
    ///
    /// The images go up as ordinary `video.frame`s first and the text follows,
    /// because that is the order every provider reads context in. The `turnId`
    /// is what keeps the turn from being written twice: the relay echoes it back
    /// on its `transcript` frame, and `displayText` is what the reader is shown
    /// when the text actually sent to the model is the stand-in prompt below
    /// rather than anything they typed.
    ///
    /// That same echo is how the images reach the saved conversation. A
    /// `video.frame` is anonymous — bytes and nothing else — so the attachment
    /// ids are held here against the `turnId` and attached to the transcript
    /// line when the relay hands the turn back. Nothing else on this socket can
    /// say which line the pictures belonged to.
    ///
    /// - Returns: false when nothing was sent, so a caller can fall back to the
    ///   normal chat path instead of quietly losing the message.
    @discardableResult
    public func sendTurn(
        text: String,
        images: [JunoVoiceTurnImage],
        context: String? = nil,
        documentAttachmentIDs: [String] = []
    ) async -> Bool {
        guard phase == .live, let socket else { return false }
        let requested = Array(images.prefix(Self.maxTurnImages))
        guard requested.isEmpty || capabilities?.videoInput == true else { return false }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)

        var frames: [EncodedTurnImage] = []
        if !requested.isEmpty {
            frames = await Self.encodeFrames(requested)
            // Encoding several megabytes takes long enough for the session to
            // have ended, reconnected or switched provider underneath it.
            // Comparing the socket by identity is what stops these images from
            // being attached to a stranger's turn on the socket that replaced
            // this one; re-reading `capabilities` covers the switch, which keeps
            // the same socket but leaves capabilities nil until the new
            // `session.ready` arrives.
            guard self.socket === socket, phase == .live,
                capabilities?.videoInput == true
            else { return false }
            if frames.count < requested.count {
                showNotice(
                    requested.count == 1
                        ? "That image is too large to share over voice."
                        : "Some of those images were too large to share over voice."
                )
            }
        }

        let boundedContext: String?
        if let context {
            let trimmedContext = context.trimmingCharacters(in: .whitespacesAndNewlines)
            let bounded = String(
                trimmedContext.prefix(JunoVoiceHistoryEntry.maximumContextCharacters)
            )
            boundedContext = bounded.isEmpty ? nil : bounded
        } else {
            boundedContext = nil
        }
        let documentIDs = Array(
            documentAttachmentIDs
                .filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
                .prefix(Self.maxTurnImages - min(Self.maxTurnImages, frames.count))
        )
        guard !trimmed.isEmpty || !frames.isEmpty || boundedContext != nil else { return false }
        guard !documentIDs.isEmpty || boundedContext == nil || !trimmed.isEmpty || !frames.isEmpty else {
            return false
        }
        let sharedCount = max(frames.count + documentIDs.count, 1)
        let displayText = trimmed.isEmpty
            ? (sharedCount == 1 ? "Shared an attachment" : "Shared \(sharedCount) attachments")
            : trimmed
        let message = trimmed.isEmpty
            ? "Please use the attachment context I just shared and respond naturally."
            : trimmed
        let turnID = UUID().uuidString
        // Only what actually went up. An id kept for a frame the ceiling
        // dropped would put a picture in the saved conversation that the model
        // was never shown, which reads back as the model ignoring it.
        let attachmentIDs = Array(
            frames.compactMap(\.attachmentID) + documentIDs
        ).prefix(Self.maxTurnImages)
        rememberTurnAttachments(Array(attachmentIDs), context: boundedContext, for: turnID)
        for frame in frames { send(.videoFrame(jpegBase64: frame.base64)) }
        send(
            .inputText(
                message,
                turnId: turnID,
                displayText: displayText,
                context: boundedContext,
                attachmentIDs: Array(attachmentIDs)
            )
        )
        return true
    }

    /// A turn's image after encoding: what goes on the wire, and what the save
    /// needs to file it under.
    private struct EncodedTurnImage: Sendable {
        let base64: String
        let attachmentID: String?
    }

    /// Base64 for a whole turn's images, off the main actor.
    ///
    /// `nonisolated async` rather than a plain helper: under SE-0338 that is what
    /// actually leaves the main actor, and four images at the relay's ceiling is
    /// enough work to drop frames from the orb if it ran here.
    private nonisolated static func encodeFrames(
        _ images: [JunoVoiceTurnImage]
    ) async -> [EncodedTurnImage] {
        images.compactMap { image in
            relayFrame(image.jpeg).map {
                EncodedTurnImage(base64: $0, attachmentID: image.attachmentID)
            }
        }
    }

    /// How many unechoed turns keep their images. The relay answers a composed
    /// turn immediately, so more than a couple outstanding means the echoes are
    /// not coming at all — and an unbounded map would then grow for the length
    /// of the call holding ids no line will ever claim.
    private static let pendingTurnAttachmentLimit = 8

    private func rememberTurnAttachments(
        _ attachmentIDs: [String],
        context: String?,
        for turnID: String
    ) {
        guard !attachmentIDs.isEmpty || context != nil else { return }
        pendingTurnAttachments.append(
            (turnID: turnID, attachmentIDs: attachmentIDs, context: context)
        )
        if pendingTurnAttachments.count > Self.pendingTurnAttachmentLimit {
            pendingTurnAttachments.removeFirst(
                pendingTurnAttachments.count - Self.pendingTurnAttachmentLimit
            )
        }
    }

    /// Claims the exact files and context sent under this turn id, once.
    private func takeTurnMetadata(
        for turnID: String?
    ) -> (attachmentIDs: [String], context: String?)? {
        guard let turnID,
            let index = pendingTurnAttachments.firstIndex(where: { $0.turnID == turnID })
        else { return nil }
        let metadata = pendingTurnAttachments.remove(at: index)
        return (attachmentIDs: metadata.attachmentIDs, context: metadata.context)
    }

    // MARK: Screen share

    #if os(macOS)
    /// Starts sharing this Mac's main display with the model at about 1 fps.
    ///
    /// ScreenCaptureKit rather than the older `CGWindowListCreateImage` path, for
    /// the permission as much as the deprecation: without screen recording
    /// consent the CoreGraphics call returns a picture of the desktop wallpaper,
    /// so a refusal would read as "the model can see my screen and is ignoring
    /// what is on it". SCK throws, which is a thing this can explain.
    ///
    /// A one-second timer around ``SCScreenshotManager`` rather than a live
    /// `SCStream`: the budget the relay and every provider expect is one frame a
    /// second, and a stream would deliver sixty and have this discard
    /// fifty-nine — holding a surface queue and a capture pipeline open for the
    /// whole conversation to do it.
    public func startScreenShare() {
        guard phase == .live, (capabilities?.screenInput == true || capabilities?.videoInput == true), !screenSharing else { return }
        screenShareEpoch += 1
        let epoch = screenShareEpoch
        screenShareTask?.cancel()
        screenShareTask = Task { [weak self] in
            await self?.runScreenShare(epoch: epoch)
        }
    }

    /// Idempotent: both the toolbar button and ``end()`` call it, and either can
    /// come first.
    public func stopScreenShare() {
        screenShareEpoch += 1
        screenShareTask?.cancel()
        screenShareTask = nil
        screenSharing = false
    }

    private func runScreenShare(epoch: Int) async {
        #if os(macOS)
        if !CGPreflightScreenCaptureAccess() {
            _ = CGRequestScreenCaptureAccess()
        }
        #endif
        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(
                false,
                onScreenWindowsOnly: true
            )
        } catch {
            guard screenShareEpoch == epoch else { return }
            showNotice(
                "Screen sharing needs permission. Allow Juno in System Settings › Privacy & Security › Screen & System Audio Recording, then try again."
            )
            return
        }
        guard screenShareEpoch == epoch, !Task.isCancelled, phase == .live,
            (capabilities?.screenInput == true || capabilities?.videoInput == true)
        else { return }
        guard let display = content.displays.first else {
            showNotice("No display is available to share right now.")
            return
        }

        // Matching the web's budget: longest edge 1024, JPEG 0.6. The cap is what
        // keeps a 6K display under the relay's per-frame ceiling, and asking
        // ScreenCaptureKit for the smaller image is far cheaper than capturing
        // full size and scaling it here once a second.
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let configuration = SCStreamConfiguration()
        let longestEdge = Double(max(display.width, display.height))
        let scale = longestEdge > Self.screenShareMaxEdge
            ? Self.screenShareMaxEdge / longestEdge
            : 1
        configuration.width = max(1, Int((Double(display.width) * scale).rounded()))
        configuration.height = max(1, Int((Double(display.height) * scale).rounded()))
        configuration.showsCursor = true
        screenSharing = true

        while !Task.isCancelled {
            guard screenShareEpoch == epoch, phase == .live,
                (capabilities?.screenInput == true || capabilities?.videoInput == true), socket != nil
            else { break }
            if let image = try? await SCScreenshotManager.captureImage(
                contentFilter: filter,
                configuration: configuration
            ), let jpeg = Self.screenFrameJPEG(from: image) {
                sendVideoFrame(jpeg)
            }
            try? await Task.sleep(for: .seconds(1))
        }
        // Only if this loop is still the one that owns the flag — see
        // ``screenShareEpoch``.
        if screenShareEpoch == epoch { screenSharing = false }
    }

    nonisolated static let screenShareMaxEdge: Double = 1024
    nonisolated static let screenShareQuality: Double = 0.6

    /// One captured frame as JPEG. Synchronous and non-isolated, so it runs
    /// inline on whichever actor called it — at 1024px that is a couple of
    /// milliseconds once a second, which is not worth a hop.
    private nonisolated static func screenFrameJPEG(from image: CGImage) -> Data? {
        NSBitmapImageRep(cgImage: image).representation(
            using: .jpeg,
            properties: [.compressionFactor: screenShareQuality]
        )
    }
    #endif

    // MARK: Audio engine

    /// Asks for the microphone, through the API that actually prompts on this
    /// platform.
    ///
    /// **This is why voice did nothing on the Mac.** `AVAudioApplication`'s
    /// record-permission pair is an AVAudioSession-era API: the session it asks
    /// on behalf of only exists on iOS, and on macOS the call reports a state
    /// nobody ever transitions out of. So a Mac that had never been granted the
    /// microphone sat at `.undetermined`, was never prompted, and the guard above
    /// this turned that into "permission denied" — for a permission the reader
    /// was never offered. macOS routes microphone consent through TCC, and
    /// `AVCaptureDevice` is the door.
    private func requestMicPermission() async -> Bool {
        #if os(macOS)
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return true
        // Denied and restricted are both final: asking again returns false
        // without prompting, so it would only delay the message that tells the
        // reader where the real switch is.
        case .denied, .restricted: return false
        default: return await AVCaptureDevice.requestAccess(for: .audio)
        }
        #else
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return true
        case .denied: return false
        default: return await AVAudioApplication.requestRecordPermission()
        }
        #endif
    }

    /// Brings the audio graph up: once with the hardware's help, once without.
    ///
    /// **The two attempts are why voice starts on the Mac at all — and they are
    /// what makes asking on a phone safe.** The first rung asks the input node
    /// for voice processing, and that request is only honoured at *initialisation*
    /// time — `setVoiceProcessingEnabled(true)` merely sets a flag, so a Mac whose
    /// input and output are different devices (a USB microphone with sound going
    /// out over HDMI, an aggregate device, a driver with no voice-processing unit,
    /// or a voice processor another engine in this process already holds) reports
    /// a perfectly plausible input format and then fails inside `engine.start()`.
    /// Nothing readable before `start()` predicts it, so the only way to find out
    /// is to try — and the shipped build had no second try, which is how the
    /// reader ended up looking at `-10875` above the dock.
    ///
    /// The same is true on iOS, where the refusals are different but the shape is
    /// identical: a route that cannot host the unit, a session another app is
    /// holding, a call arriving mid-setup. The rung below is what turns any of
    /// those into a working call rather than a broken one.
    ///
    /// The second rung drops voice processing and takes the format the hardware
    /// actually reports, on a brand-new engine. There is no third: a plain input
    /// node on the plain hardware format is the simplest thing this process can
    /// ask CoreAudio for, so a third attempt would fail identically and only
    /// delay the message.
    private func startAudioEngine() throws(JunoRealtimeVoiceError) {
        #if os(iOS)
        // `.playAndRecord` with `.voiceChat` is the **precondition** for what
        // `buildAudioGraph` does next, not a substitute for it. The node's
        // voice-processing unit can only be enabled under a category that both
        // records and plays, and `.voiceChat` is the mode Apple documents for it.
        //
        // The mode does also cancel echo at the *session* level, which is real and
        // is why calls on a phone sounded fine long before any of this — but it is
        // invisible to `isVoiceProcessingEnabled`, so it has never been evidence
        // the barge-in gate could read, and it is still not treated as any.
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(
                .playAndRecord,
                mode: .voiceChat,
                options: [.defaultToSpeaker, .allowBluetoothHFP]
            )
            try session.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            Self.audioLog.error(
                "Voice session activation failed: \(Self.diagnostic(error), privacy: .public)"
            )
            throw Self.audioFailure(error)
        }
        #endif

        // Whatever a previous session left behind still holds this process's
        // claim on the input device, and a second engine built on top of that
        // claim is one of the ways a perfectly good microphone produces an
        // initialisation failure. Costs nothing when there is nothing to drop.
        disposeAudioGraph()

        let attempts = RealtimeAudioGraphPlan.current.voiceProcessingAttempts
        do {
            try buildAudioGraph(voiceProcessing: attempts[0])
        } catch where attempts.count > 1 {
            Self.audioLog.error(
                "Voice start failed, voice processing: \(Self.diagnostic(error), privacy: .public)"
            )
            do {
                try buildAudioGraph(voiceProcessing: attempts[1])
            } catch {
                Self.audioLog.error(
                    "Voice start failed, raw format: \(Self.diagnostic(error), privacy: .public)"
                )
                throw Self.audioFailure(error)
            }
        } catch {
            Self.audioLog.error(
                "Voice start failed, raw format: \(Self.diagnostic(error), privacy: .public)"
            )
            throw Self.audioFailure(error)
        }
    }

    /// One attempt at a complete graph: left running on success, left as though
    /// it had never been built on failure.
    ///
    /// The order here is load-bearing twice.
    ///
    /// The player is connected to `mainMixerNode` **before** the input format is
    /// read, because touching the mixer is what instantiates the output half of
    /// the graph — and with voice processing on, input and output are one unit.
    /// Read the input format first and it describes a node that is about to be
    /// reconfigured underneath it.
    ///
    /// And the format is read **as late as possible**, immediately before the
    /// converter and the tap that are built from it. On macOS the default input
    /// device and its sample rate can change at any moment, from anything: a
    /// headset connecting, another app claiming the device, the user in Sound
    /// settings. A converter built from a format the node has since left
    /// resamples wrong, and a tap installed with one raises an Objective-C
    /// exception rather than returning an error.
    ///
    /// - Parameter voiceProcessing: Echo cancellation and automatic gain from
    ///   the input node's voice-processing unit. Requested on **both** platforms;
    ///   false is the caller's second rung, after the first one failed.
    private func buildAudioGraph(voiceProcessing: Bool) throws {
        let engine = AVAudioEngine()
        #if os(macOS)
        let outputEngine = AVAudioEngine()
        #else
        let outputEngine = engine
        #endif
        let player = AVAudioPlayerNode()
        let input = engine.inputNode
        // Any exit but the last one leaves a half-built graph holding the input
        // device open, and the caller's retry is about to ask that same device
        // for a different configuration.
        var started = false
        defer {
            if !started {
                Self.unwind(captureEngine: engine, playbackEngine: outputEngine, player: player)
            }
        }

        // Ask this node for its voice-processing IO unit: echo cancellation, so
        // the model does not hear itself through the speakers and interrupt its
        // own turn, and automatic gain, so a far-field microphone reaches the
        // relay at a usable level.
        //
        // Both matter to what is on screen as well. Without AGC the raw RMS of
        // someone talking a normal distance from a MacBook sits around 0.01–0.03,
        // which is why the field barely moved while they were speaking.
        //
        // **Asked for on iOS too, and that is the whole of how barge-in became
        // reachable on a phone.** The `.voiceChat` session in the caller cancels
        // echo at the session level, but ``echoCancellation(of:)`` reads
        // `isVoiceProcessingEnabled`, which describes the unit on *this node* — so
        // a phone that never asked was answering "no" to the only question the
        // barge-in gate knows how to ask, and every iPhone call was manual-only no
        // matter how well its echo was being cancelled. The fix is to make the
        // condition true rather than to assume it: ask here, and read back
        // whatever actually happened. If the unit does not come up the node still
        // says `false`, the gate still resolves to
        // ``RealtimeBargeInPolicy/manualOnly``, and nothing is worse than it was.
        //
        // `try?` because a device with no voice-processing unit refuses right
        // here, and a conversation without echo cancellation is still a
        // conversation. The devices that *accept* the flag and then fail to
        // initialise are what the caller's second attempt exists for.
        if voiceProcessing {
            try? input.setVoiceProcessingEnabled(true)
        } else {
            try? input.setVoiceProcessingEnabled(false)
        }

        // Model speech arrives as PCM16 mono 24 kHz. Scheduling Float32 mono
        // 24 kHz and letting the mixer resample is what keeps this correct on
        // hardware that runs its output at 44.1 kHz.
        guard let playback = AVAudioFormat(standardFormatWithSampleRate: 24_000, channels: 1),
            let capture = AVAudioFormat(
                commonFormat: .pcmFormatInt16, sampleRate: 16_000,
                channels: 1, interleaved: true
            )
        else {
            throw RealtimeAudioSetupError.formatUnavailable
        }
        outputEngine.attach(player)
        outputEngine.connect(player, to: outputEngine.mainMixerNode, format: playback)

        let inputFormat = Self.usableInputFormat(of: input)
        guard RealtimeInputFormat.isUsable(
            sampleRate: inputFormat.sampleRate, channelCount: inputFormat.channelCount
        ) else {
            throw RealtimeAudioSetupError.noInput
        }
        guard let converter = AVAudioConverter(from: inputFormat, to: capture) else {
            throw RealtimeAudioSetupError.formatUnavailable
        }
        box.configureCapture(converter: converter, captureFormat: capture)
        box.muted = muted

        // Defensive: installing a second tap on a bus that still has one raises
        // an Objective-C exception, which is a crash and not a Swift error.
        input.removeTap(onBus: 0)
        Self.installMicTap(on: input, format: inputFormat, box: box)
        engine.prepare()
        #if os(macOS)
        outputEngine.prepare()
        #endif
        try engine.start()
        #if os(macOS)
        try outputEngine.start()
        #endif

        started = true
        player.play()
        audioEngine = engine
        playbackEngine = outputEngine
        playerNode = player
        playbackFormat = playback
        installAudioConfigurationObservers(captureEngine: engine, playbackEngine: outputEngine)
        // Read from the node, never from what was asked for: `setVoiceProcessingEnabled`
        // only sets a flag, and on the Macs whose input and output are different
        // devices the unit refuses to initialise inside `engine.start()`. Asking
        // for the canceller and getting it are different facts, and only the
        // second one makes automatic barge-in safe — so the policy is derived
        // here, once the graph is genuinely up.
        echoCancellation = Self.echoCancellation(of: input)
        Self.audioLog.info(
            "Voice graph started: \(Self.graphDiagnostic(captureEngine: engine, playbackEngine: outputEngine, voiceProcessing: input.isVoiceProcessingEnabled), privacy: .public)"
        )
        setBargeInPolicy(RealtimeBargeInPolicy(echoCancellation: echoCancellation))
    }

    /// What the hardware is doing about echo, as the input node reports it.
    ///
    /// Deliberately the same rule ``AVAudioEngineRealtimeEndpoint`` uses, and
    /// deliberately a *reading* rather than a conclusion. `isVoiceProcessingEnabled`
    /// tracks the voice-processing IO unit on this node, which
    /// ``buildAudioGraph(voiceProcessing:)`` now asks for on both platforms and
    /// which neither platform promises.
    ///
    /// **What changed for iOS is the evidence, not the standard.** The phone used
    /// to answer ``RealtimeEchoCancellation/unavailable`` because nothing had
    /// asked; it now answers whatever the unit did. The old refusal to infer
    /// `.active` from `AVAudioSession.mode` was right and is still in force — see
    /// ``RealtimeEchoCancellation/fromInputNode(reportsVoiceProcessing:)``, which
    /// is not given anything to infer from. The cost of being wrong in one
    /// direction is a feature nobody notices is missing; the cost of being wrong
    /// in the other is every answer cut off by its own first syllable, with the
    /// Interrupt button apparently pressing itself.
    private nonisolated static func echoCancellation(
        of input: AVAudioInputNode
    ) -> RealtimeEchoCancellation {
        .fromInputNode(reportsVoiceProcessing: input.isVoiceProcessingEnabled)
    }

    /// AVAudioEngine stops itself when the default route changes. Rebuild both
    /// graphs after the route settles while retaining the relay and transcript.
    private func installAudioConfigurationObservers(
        captureEngine: AVAudioEngine,
        playbackEngine: AVAudioEngine
    ) {
        removeAudioConfigurationObservers()
        var engines = [captureEngine]
        if playbackEngine !== captureEngine { engines.append(playbackEngine) }
        audioConfigurationObservers = engines.map { engine in
            NotificationCenter.default.addObserver(
                forName: .AVAudioEngineConfigurationChange,
                object: engine,
                queue: nil
            ) { [weak self] _ in
                Task { @MainActor [weak self] in self?.scheduleAudioRouteRecovery() }
            }
        }
    }

    private func removeAudioConfigurationObservers() {
        for observer in audioConfigurationObservers {
            NotificationCenter.default.removeObserver(observer)
        }
        audioConfigurationObservers.removeAll()
    }

    /// A headset transition can emit several graph notifications; debounce them
    /// into one fresh voice-processing attempt followed by the raw fallback.
    private func scheduleAudioRouteRecovery() {
        guard phase == .live, !closedByUser else { return }
        audioRouteRecoveryTask?.cancel()
        Self.audioLog.notice("Audio route changed; scheduling voice graph recovery")
        audioRouteRecoveryTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled, let self, self.phase == .live, !self.closedByUser else {
                return
            }
            do {
                try self.startAudioEngine()
                Self.audioLog.info("Voice graph recovered after audio route change")
            } catch {
                let voiceError = error as? JunoRealtimeVoiceError ?? Self.audioFailure(error)
                Self.audioLog.error(
                    "Voice route recovery failed: \(Self.diagnostic(error), privacy: .public)"
                )
                self.teardown(closeCode: .abnormalClosure)
                self.phase = .error(voiceError)
            }
        }
    }

    /// The input node's format now, with voice processing withdrawn if enabling
    /// it left the node describing nothing recordable.
    ///
    /// Behind a helper so the caller can bind a `let`: some inputs — an aggregate
    /// device, a driver that does not implement the unit, a phone whose route
    /// changed under the request — report zero channels, a zero sample rate or
    /// NaN once the voice processor attaches, and a conversation without echo
    /// cancellation beats no conversation at all.
    ///
    /// **This is the cheap half of the fallback, and it runs on iOS now for the
    /// same reason the request does.** The caller's second rung rebuilds the whole
    /// graph; this one recovers inside the first rung when the only casualty was
    /// the format. Either way the node is left reporting `false`, so the barge-in
    /// gate lands on manual-only for the call that results — degraded audio is
    /// traded for working audio, never for an unearned `.active`.
    private nonisolated static func usableInputFormat(
        of input: AVAudioInputNode
    ) -> AVAudioFormat {
        var format = input.outputFormat(forBus: 0)
        if !RealtimeInputFormat.isUsable(
            sampleRate: format.sampleRate, channelCount: format.channelCount
        ) {
            try? input.setVoiceProcessingEnabled(false)
            format = input.outputFormat(forBus: 0)
        }
        if !RealtimeInputFormat.isUsable(
            sampleRate: format.sampleRate, channelCount: format.channelCount
        ) {
            let busFormat = input.inputFormat(forBus: 0)
            if RealtimeInputFormat.isUsable(
                sampleRate: busFormat.sampleRate, channelCount: busFormat.channelCount
            ) {
                format = busFormat
            }
        }
        return format
    }

    /// Takes an engine apart far enough that the audio device is genuinely free.
    ///
    /// `stop()` alone is not enough in either direction. The tap has to come off
    /// first, or a buffer already in flight is handed to a block whose format has
    /// gone away; and the voice-processing unit has to be released afterwards, or
    /// the *device* stays configured for a session that no longer exists — which
    /// is the state a retry cannot recover from, because it would read the dead
    /// session's sample rate straight back out of the hardware.
    ///
    /// The release is unconditional now that both platforms ask for the unit. It
    /// has to be: the caller's whole fallback ladder is "try, unwind, try again
    /// differently", and an unwind that left the unit attached would hand the
    /// second rung exactly the configuration the first one failed on. On iOS it
    /// also hands the shared session back un-voice-processed before it is
    /// deactivated, which is what the next thing in this process to claim the
    /// microphone — dictation, in `JunoSpeechService` — expects to find.
    ///
    /// Ordered before the session is deactivated, in every caller: reaching
    /// `engine.inputNode` under a dead session is not something to ask iOS for.
    private nonisolated static func unwind(
        captureEngine: AVAudioEngine,
        playbackEngine: AVAudioEngine,
        player: AVAudioPlayerNode?
    ) {
        captureEngine.inputNode.removeTap(onBus: 0)
        player?.stop()
        playbackEngine.stop()
        if playbackEngine !== captureEngine { captureEngine.stop() }
        try? captureEngine.inputNode.setVoiceProcessingEnabled(false)
        if let player, playbackEngine.attachedNodes.contains(player) {
            playbackEngine.detach(player)
        }
    }

    /// Releases the running graph and forgets it.
    ///
    /// Shared by ``teardown(closeCode:)`` and by ``startAudioEngine()``, because
    /// *setup* needs it every bit as much as shutdown does: a start that failed
    /// halfway, or an engine a route change stopped, still owns this process's
    /// claim on the input device.
    private func disposeAudioGraph() {
        removeAudioConfigurationObservers()
        if let engine = audioEngine {
            Self.unwind(
                captureEngine: engine,
                playbackEngine: playbackEngine ?? engine,
                player: playerNode
            )
        }
        audioEngine = nil
        playbackEngine = nil
        playerNode = nil
        playbackFormat = nil
        // Back to the third answer, not to a pessimistic second one: "no graph"
        // and "a graph with no canceller" want different UI, and the policy that
        // falls out of both is manual either way.
        echoCancellation = .unknown
        setBargeInPolicy(RealtimeBargeInPolicy(echoCancellation: .unknown))
    }

    // MARK: Audio failures

    /// Where the OSStatus goes now that the reader is handed a sentence instead.
    private nonisolated static let audioLog = Logger(
        subsystem: "com.liammagnier.juno", category: "voice.audio"
    )

    /// Domain, numeric code and framework text — for the log, and nowhere else.
    /// A voice bug report without the OSStatus is one nobody can act on.
    nonisolated static func diagnostic(_ error: any Error) -> String {
        let failure = error as NSError
        return "\(failure.domain) \(failure.code): \(failure.localizedDescription)"
    }

    /// Active topology and hardware formats, without device or user names.
    private nonisolated static func graphDiagnostic(
        captureEngine: AVAudioEngine,
        playbackEngine: AVAudioEngine,
        voiceProcessing: Bool
    ) -> String {
        let input = captureEngine.inputNode.inputFormat(forBus: 0)
        let output = playbackEngine.outputNode.outputFormat(forBus: 0)
        let topology = RealtimeAudioGraphPlan.current.topology == .splitCapturePlayback
            ? "split" : "unified"
        return "topology=\(topology) capture=\(Int(input.sampleRate))Hz/\(input.channelCount)ch playback=\(Int(output.sampleRate))Hz/\(output.channelCount)ch voiceProcessing=\(voiceProcessing)"
    }

    /// AVFAudio's error domain, which the framework does not export as a symbol.
    nonisolated static let avfAudioErrorDomain = "com.apple.coreaudio.avfaudio"

    /// Translates whatever CoreAudio threw into a failure whose first sentence
    /// names something the reader can do.
    ///
    /// This exists because of one shipped screenshot: "The operation couldn't be
    /// completed. (com.apple.coreaudio.avfaudio error -10875.)", floating above
    /// the voice dock. `AVAudioEngine` reports OSStatus verbatim and
    /// `localizedDescription` has nothing to add, so the reader gets a number and
    /// no next step — while the number, the one genuinely useful part, ends up
    /// buried in a sentence nobody is going to retype into a bug report. So the
    /// code goes to ``audioLog`` and, wherever the advice is not already
    /// specific, into a parenthetical.
    ///
    /// Every case below is reachable from this path. Note that `-10875` is
    /// `kAudioUnitErr_FailedInitialization` and **not** the format error it is
    /// almost universally mistaken for — that one is `-10868`, and the two call
    /// for opposite advice, which is the whole reason for spelling the constants
    /// out here.
    nonisolated static func audioFailure(_ error: any Error) -> JunoRealtimeVoiceError {
        // The setup errors raised in this file are already sentences.
        if let setup = error as? RealtimeAudioSetupError {
            return .audioEngineFailed(setup.errorDescription ?? "")
        }
        let failure = error as NSError
        // Only these two domains put an OSStatus in `code`. Decoding any other
        // domain's `code` as one would attach a confident, wholly unrelated
        // message to a failure it knows nothing about.
        guard failure.domain == avfAudioErrorDomain || failure.domain == NSOSStatusErrorDomain,
            let status = OSStatus(exactly: failure.code)
        else {
            return .audioEngineFailed(error.localizedDescription)
        }

        // Built up front rather than per case, because the audio unit and the
        // HAL have *different numbers for the same situation* and only one of
        // each pair is even visible to Swift on a given platform. Naming the
        // situation once is what keeps the two branches saying the same thing.
        #if os(macOS)
        let elsewhere = "Choose a different input in System Settings › Sound"
        #else
        let elsewhere = "Disconnect any audio accessory"
        #endif
        let wrongFormat =
            "Juno can't record from this input's audio format. \(elsewhere), then start "
            + "voice again. (audio error \(status))"
        let busy =
            "The microphone is busy. Quit whatever else is recording — a call, a screen "
            + "recorder — and start voice again. (audio error \(status))"
        #if os(macOS)
        let deviceGone =
            "The microphone Juno was using is no longer there. \(elsewhere), then start "
            + "voice again. (audio error \(status))"
        #endif

        switch status {
        case kAudioUnitErr_Unauthorized:
            return .micPermissionDenied

        // "The audio unit is unable to be initialized." By the time this is
        // reached ``startAudioEngine()`` has already retried against the plain
        // hardware format, so the configuration is not what is wrong.
        case kAudioUnitErr_FailedInitialization:
            #if os(macOS)
            let micStatus = AVCaptureDevice.authorizationStatus(for: .audio)
            if micStatus == .denied || micStatus == .restricted {
                return .micPermissionDenied
            }
            return .audioEngineFailed(
                "Juno couldn't start the audio stream. Check default input in System Settings › Sound, or retry. (audio error \(status))"
            )
            #else
            return .audioEngineFailed(
                "Juno couldn't open the microphone. Close anything else that might be "
                    + "using it, then try again. (audio error \(status))"
            )
            #endif

        // Another voice processor in this process is already initialised —
        // dictation, or a session that has not finished letting go of one.
        case kAudioUnitErr_MultipleVoiceProcessors:
            return .audioEngineFailed(
                "The microphone is already in use by another part of Juno. Stop dictation, "
                    + "then start voice again. (audio error \(status))"
            )

        case kAudioUnitErr_FormatNotSupported, kAudioUnitErr_InvalidPropertyValue:
            return .audioEngineFailed(wrongFormat)

        case kAudioUnitErr_CannotDoInCurrentContext:
            return .audioEngineFailed(busy)

        case kAudioUnitErr_NoConnection, kAudioUnitErr_Uninitialized,
            kAudioUnitErr_InvalidElement:
            return .audioEngineFailed(
                "Juno couldn't build the audio path for this conversation. Start voice "
                    + "again. (audio error \(status))"
            )

        #if os(macOS)
        // The HAL's own codes, which reach a Swift caller only on macOS — the
        // platform with a device list to be wrong about in the first place.
        case kAudioDeviceUnsupportedFormatError:
            return .audioEngineFailed(wrongFormat)

        case kAudioHardwareNotRunningError, kAudioHardwareNotReadyError:
            return .audioEngineFailed(busy)

        case kAudioHardwareBadDeviceError, kAudioHardwareBadObjectError:
            return .audioEngineFailed(deviceGone)
        #endif

        default:
            #if os(macOS)
            return .audioEngineFailed(
                "Juno couldn't start recording on this Mac. Start voice again, or choose a "
                    + "different input in System Settings › Sound. (audio error \(status))"
            )
            #else
            return .audioEngineFailed(
                "Juno couldn't start recording on this iPhone. Start voice again. "
                    + "(audio error \(status))"
            )
            #endif
        }
    }

    /// Installs the microphone tap from a **non-isolated** context.
    ///
    /// This has to be `nonisolated`, for a crash rather than for tidiness. This
    /// type is `@MainActor`, so under `-swift-version 6` a closure written inside
    /// one of its methods inherits that isolation and the compiler emits an
    /// executor check at the top of it. `AVAudioEngine` calls a tap block on the
    /// realtime audio thread, so that check runs `dispatch_assert_queue` off the
    /// main queue and traps — `EXC_BREAKPOINT` the instant a session goes live.
    /// The same trap took out dictation in `JunoSpeechService`, which is fixed
    /// the same way.
    ///
    /// Formed here, the block is genuinely non-isolated, which is the truth about
    /// where it runs. It touches nothing but the lock-guarded box.
    private nonisolated static func installMicTap(
        on input: AVAudioInputNode,
        format: AVAudioFormat,
        box: VoiceRelayShuttle
    ) {
        input.installTap(onBus: 0, bufferSize: 2048, format: format) { buffer, _ in
            box.processMic(buffer)
        }
    }

    /// Decodes one relay binary frame (PCM16 LE mono 24 kHz) into Float32 and
    /// queues it, tracking a playback level on the way through — measuring here
    /// costs one pass over samples that are already being touched, where a tap
    /// on the output would cost a second one.
    private func schedulePlayback(_ data: Data) {
        guard let playerNode, let playbackFormat else { return }
        let frames = data.count / MemoryLayout<Int16>.size
        guard frames > 0,
            let buffer = AVAudioPCMBuffer(
                pcmFormat: playbackFormat,
                frameCapacity: AVAudioFrameCount(frames)
            ),
            let channel = buffer.floatChannelData
        else { return }
        buffer.frameLength = AVAudioFrameCount(frames)
        var energy: Float = 0
        data.withUnsafeBytes { raw in
            let samples = raw.bindMemory(to: Int16.self)
            for index in 0..<frames {
                let sample = Float(Int16(littleEndian: samples[index])) / 32_768
                channel[0][index] = sample
                energy += sample * sample
            }
        }
        // `max`, because several frames arrive per meter tick and the loudest is
        // the one the ear registers; averaging them flattens every consonant.
        box.playbackLevel = max(box.playbackLevel, Double((energy / Float(frames)).squareRoot()))
        box.playbackBufferScheduled()
        Self.schedulePlaybackBuffer(buffer, on: playerNode, box: box)
    }

    private nonisolated static func schedulePlaybackBuffer(
        _ buffer: AVAudioPCMBuffer,
        on player: AVAudioPlayerNode,
        box: VoiceRelayShuttle
    ) {
        player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { _ in
            box.playbackBufferCompleted()
        }
    }

    /// Drops everything queued. `stop()` alone leaves the node unable to accept
    /// new buffers, so the `play()` is not optional — without it an interrupted
    /// session goes permanently silent.
    private func flushPlayback() {
        guard let playerNode else { return }
        playerNode.stop()
        box.clearPlaybackBuffers()
        box.playbackLevel = 0
        playerNode.play()
    }

    /// 30Hz metering pump.
    ///
    /// **Loudness is measured in decibels, not in raw RMS.** The previous version
    /// multiplied linear RMS by a constant, which is why the field looked inert:
    /// conversational speech lands around 0.02–0.08 RMS, so `× 4` spent its whole
    /// range in the bottom third and every syllable moved the light by a few
    /// points. Hearing is logarithmic — mapping a speech window in dBFS across
    /// the full 0…1 range is what makes a normal voice reach the top of it, and
    /// what makes the difference between a whisper and a raised voice visible.
    ///
    /// **Attack is fast and decay is slow**, and deliberately not symmetric: the
    /// light has to jump on a syllable and fall away over a word, matching the
    /// web's aura (`21` up, `3.6` down, per second). A single rate flickers on
    /// every consonant, which is what the old `0.25` both ways did.
    private func startMetering() {
        meterTask?.cancel()
        meterTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(Int(Self.meterInterval * 1_000)))
                guard !Task.isCancelled, let self else { break }
                let micLoudness = Self.loudness(self.box.micLevel)
                // Automatic barge-in reads the same number the orb is drawn from,
                // on the same pump, so a detector calibrated against one curve and
                // a light drawn from another can never drift apart — the failure
                // that produces the least debuggable report in the stack: "it cut
                // the answer off and the light hadn't even moved."
                //
                // Fed here and not from the tap because this loop runs at a fixed
                // ~30Hz, which is the cadence ``RealtimeVoiceActivityDetector``'s
                // frame counts are tuned against; the tap's rate follows whatever
                // buffer size the hardware chose.
                self.noticeBargeIn(micLoudness)
                let micTarget = self.muted ? 0 : micLoudness
                // Playback decays rather than being cleared: the relay's audio
                // arrives in bursts, and resetting between them would strobe the
                // field through zero while the model is still mid-word.
                let playbackTarget = Self.loudness(self.box.playbackLevel)
                self.box.playbackLevel *= 0.86
                let target = max(micTarget, playbackTarget)
                let rate = target > self.level ? Self.attackRate : Self.decayRate
                self.level += (target - self.level) * (1 - exp(-rate * Self.meterInterval))
            }
        }
    }

    nonisolated static let meterInterval: Double = 0.033
    /// Per second. The field climbs on a syllable and falls away over a word.
    nonisolated static let attackRate: Double = 21
    nonisolated static let decayRate: Double = 3.6
    /// The quietest speech worth showing, and the loudest worth scaling to.
    /// −52 dBFS is a soft voice across a desk; −12 is close and emphatic.
    nonisolated static var quietFloorDB: Double { RealtimeLoudness.quietFloorDB }
    nonisolated static var loudCeilingDB: Double { RealtimeLoudness.loudCeilingDB }

    /// Linear RMS → 0…1 across a speech window, in decibels.
    ///
    /// The arithmetic moved to ``RealtimeLoudness`` and this forwards to it,
    /// rather than the two keeping their own copy. ``RealtimeVoiceActivityDetector``
    /// decides whether someone is talking over the model from the same numbers
    /// the orb is drawn from, and a detector tuned against a curve that had since
    /// drifted from the one on screen would produce the least debuggable report
    /// in the stack: "it cut the answer off and the light hadn't moved."
    ///
    /// `nonisolated` because it is pure arithmetic and needs to be testable
    /// without a main-actor hop, and because the meter pump is the only caller.
    nonisolated static func loudness(_ rms: Double) -> Double {
        RealtimeLoudness.normalized(rms)
    }

    // MARK: On-device transcription

    /// Runs only for providers whose capabilities report
    /// ``JunoVoiceCapabilities/needsClientTranscript``. Speech authorization is
    /// requested here rather than at `start()` so the providers that do not need
    /// it never make the user grant it.
    private func startTranscriber() async {
        guard !transcribing else { return }
        let status = SFSpeechRecognizer.authorizationStatus()
        let authorized: Bool
        if status == .notDetermined {
            authorized = await withCheckedContinuation { continuation in
                SFSpeechRecognizer.requestAuthorization {
                    continuation.resume(returning: $0 == .authorized)
                }
            }
        } else {
            authorized = status == .authorized
        }
        guard !closedByUser else { return }
        // Fatal, unlike an unavailable recognizer: this provider has no other
        // way to hear the user, so a session that continues is one where nobody
        // is listening.
        guard authorized else {
            teardown(closeCode: .normalClosure)
            phase = .error(.speechPermissionDenied)
            return
        }
        guard let recognizer = SFSpeechRecognizer(locale: .autoupdatingCurrent)
            ?? SFSpeechRecognizer(),
            recognizer.isAvailable
        else {
            showNotice("Speech recognition isn't available right now.")
            return
        }
        speechRecognizer = recognizer
        // Cached once per session, deliberately. `supportsOnDeviceRecognition` is
        // a *synchronous XPC round trip* into the speech daemon, and recognition
        // restarts after every utterance — asking per restart blocked the main
        // thread once per pause in speech, mid-conversation.
        prefersOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
        transcribing = true
        beginRecognitionPass()
    }

    private func beginRecognitionPass() {
        guard transcribing, let recognizer = speechRecognizer else { return }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.taskHint = .dictation
        request.addsPunctuation = true
        if prefersOnDeviceRecognition {
            request.requiresOnDeviceRecognition = true
        }
        box.speechRequest = request

        recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            // This callback is not on the main actor; read what is needed, then
            // hop before touching any state.
            let text = result?.bestTranscription.formattedString
            let isFinal = result?.isFinal ?? false
            let failed = error != nil
            Task { @MainActor [weak self] in
                guard let self, self.transcribing else { return }
                if let text, !text.isEmpty {
                    self.upsertTranscript(role: .user, text: text, final: false)
                }
                if isFinal {
                    // The final utterance is the only one sent upstream: the
                    // relay would treat each partial as a new user turn and the
                    // model would start answering a half-finished sentence.
                    if let text, !text.isEmpty {
                        self.upsertTranscript(role: .user, text: text, final: true)
                        self.send(.inputText(text))
                    }
                    self.scheduleRecognitionRestart()
                } else if failed {
                    // "No speech detected" is routine in a conversation with
                    // pauses, not the end of listening — keep the loop alive.
                    self.scheduleRecognitionRestart()
                }
            }
        }
    }

    /// Restarts recognition, throttled to 300ms so a hard recognizer failure
    /// cannot hot-loop for the length of the session.
    private func scheduleRecognitionRestart() {
        recognitionTask?.cancel()
        recognitionTask = nil
        box.speechRequest?.endAudio()
        box.speechRequest = nil
        transcriberRestartTask?.cancel()
        transcriberRestartTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled, let self, self.transcribing else { return }
            self.beginRecognitionPass()
        }
    }

    private func stopTranscriber() {
        transcribing = false
        transcriberRestartTask?.cancel()
        transcriberRestartTask = nil
        recognitionTask?.cancel()
        recognitionTask = nil
        box.speechRequest?.endAudio()
        box.speechRequest = nil
        speechRecognizer = nil
    }

    // MARK: Teardown

    /// Order matters: the pumps stop before the socket, and the tap comes off
    /// before the engine stops. A tap still installed when the engine tears down
    /// can be handed a buffer whose format has already gone away.
    private func teardown(closeCode: URLSessionWebSocketTask.CloseCode) {
        receiveTask?.cancel(); receiveTask = nil
        pingTask?.cancel(); pingTask = nil
        meterTask?.cancel(); meterTask = nil
        noticeTask?.cancel(); noticeTask = nil
        audioRouteRecoveryTask?.cancel(); audioRouteRecoveryTask = nil
        stopTranscriber()
        #if os(macOS)
        // Before the socket, like the pumps: a capture that outlives the session
        // is a Mac still recording its own screen for a conversation that is over.
        stopScreenShare()
        #endif
        socket?.cancel(with: closeCode, reason: nil)
        socket = nil
        disposeAudioGraph()
        box.reset()
        level = 0
        assistantSpeaking = false
        #if os(iOS)
        // Deactivated here, unlike dictation: a voice session held
        // `.playAndRecord` with `.voiceChat`, and leaving that active keeps
        // other apps' audio ducked after the call is over.
        try? AVAudioSession.sharedInstance()
            .setActive(false, options: .notifyOthersOnDeactivation)
        #endif
    }
}

private enum RealtimeAudioSetupError: LocalizedError {
    case noInput
    case formatUnavailable

    var errorDescription: String? {
        switch self {
        case .noInput: "No microphone input is available."
        case .formatUnavailable: "The audio formats for the voice session couldn't be created."
        }
    }
}
#endif

#if DEBUG
extension JunoRealtimeVoiceController {
    /// A live-looking session with no relay behind it, for the UI preview
    /// harness.
    ///
    /// The orb, the captions and the call controls are the one surface of the
    /// phone that could not be looked at without a server, a token and a
    /// microphone: every fixture launch of full-screen voice showed "Voice
    /// unavailable" over an empty captions box. This puts the controller
    /// straight into ``Phase/live`` with a transcript, capabilities that
    /// unlock the camera controls, a running cost, and a synthetic level that
    /// moves the way a voice does. `end()` tears it down like any session.
    /// Debug-only, like the harness it exists for.
    public func beginPreviewSession(
        lines: [(role: JunoVoiceTranscriptRole, text: String)],
        assistantSpeaking speaking: Bool = true
    ) {
        closedByUser = false
        reconnectAttempted = false
        record.reset()
        for line in lines {
            record.upsert(role: line.role, text: line.text, final: true)
            // The record files a question that arrives after an answer began
            // *above* that answer — right for a live call, where the reader's
            // words are transcribed late. Seeded lines are already in order,
            // so each answer closes its turn before the next line lands.
            if line.role == .assistant { record.beginAnswer() }
        }
        capabilities = JunoVoiceCapabilities(
            videoInput: true, screenInput: true, trueS2S: true,
            needsClientTranscript: false, maxSessionSec: 1800
        )
        usage = JunoVoiceUsage(
            provider: provider, audioInSec: 48, audioOutSec: 71, estCostUsd: 0.034
        )
        notice = nil
        session = RealtimeSessionMachine(provider: provider)
        phase = .live
        assistantSpeaking = speaking
        sessionPhase = speaking ? .responding : .listening
        meterTask?.cancel()
        meterTask = Task { @MainActor [weak self] in
            let started = Date()
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(40))
                guard let self, !Task.isCancelled else { return }
                let t = Date().timeIntervalSince(started)
                // Two slow envelopes under a fast tremor: reads as speech, not
                // as a metronome.
                let envelope = 0.5 + 0.5 * sin(t * 1.7) * sin(t * 0.6 + 1)
                let tremor = 0.5 + 0.5 * sin(t * 11)
                level = self.muted ? 0 : 0.18 + 0.55 * envelope * (0.6 + 0.4 * tremor)
            }
        }
    }
}
#endif

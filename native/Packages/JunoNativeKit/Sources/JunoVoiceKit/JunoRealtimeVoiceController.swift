#if canImport(AVFoundation) && canImport(Speech)
// `@preconcurrency` on this import alone, because AVFAudio's callback types are
// declared `@Sendable` while being invoked synchronously on the calling thread —
// annotations the framework predates. ``ConversionInput`` below is the *real*
// fix for the converter block; this covers the rest of the file's AVFoundation
// surface, which the macos-15 toolchain CI runs on diagnoses more strictly than
// the Xcode 27 toolchain available here. It is deliberately narrow: scoped to
// one import, so everything else in JunoVoiceKit stays fully checked.
@preconcurrency import AVFoundation
import Foundation
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
    }

    /// The whole uplink, on the audio thread: meter, feed the recognizer,
    /// downsample to PCM16 mono 16 kHz, ship one binary frame.
    ///
    /// The level is measured even while muted — the meter is what tells someone
    /// their microphone is muted rather than broken.
    func processMic(_ buffer: AVAudioPCMBuffer) {
        if let channel = buffer.floatChannelData?.pointee, buffer.frameLength > 0 {
            var sum: Float = 0
            for index in 0..<Int(buffer.frameLength) {
                let sample = channel[index]
                sum += sample * sample
            }
            micLevel = Double((sum / Float(buffer.frameLength)).squareRoot())
        }
        guard !muted else { return }
        speechRequest?.append(buffer)

        // One acquisition for the three values the conversion needs: taking the
        // lock per field would let a teardown land between them and hand this
        // block a converter that no longer matches the format it is writing to.
        lock.lock()
        let converter = storedConverter
        let captureFormat = storedCaptureFormat
        let socket = storedSocket
        lock.unlock()
        guard let converter, let captureFormat, let socket else { return }

        // A tap buffer can arrive describing a format with a zero sample rate —
        // that is what an input device reports as it is being pulled out from
        // under a live session (AirPods disconnecting, a USB interface unplugged).
        // Dividing by it gives `+inf`, and `AVAudioFrameCount(_:)` traps on
        // inf/NaN rather than saturating: "Double value cannot be converted to
        // UInt32". On the realtime audio thread that is an immediate crash, and
        // the setup path already guards the same way at `configureAudio`. One
        // dropped buffer during a route change is not audible; the trap is.
        guard buffer.format.sampleRate > 0, buffer.frameLength > 0 else { return }
        let ratio = captureFormat.sampleRate / buffer.format.sampleRate
        // The +16 is slack: the resampler can emit a frame or two more than the
        // ratio predicts, and an exactly-sized buffer turns that into an error
        // return and a silent gap in the uplink.
        //
        // Clamped as well as guarded: `ratio` is finite here, but a pathological
        // format pair could still scale a 2048-frame buffer past `UInt32.max`,
        // and the conversion below cannot want more than a second of audio.
        let projected = (Double(buffer.frameLength) * ratio).rounded(.up)
        let ceiling = Double(captureFormat.sampleRate)
        let capacity = AVAudioFrameCount(min(max(projected, 1), ceiling)) + 16
        guard let out = AVAudioPCMBuffer(pcmFormat: captureFormat, frameCapacity: capacity) else {
            return
        }
        // The input buffer and the once-only flag travel into the block together,
        // in one box, because `AVAudioConverterInputBlock` is typed `@Sendable`
        // and neither a captured `var` nor a bare `AVAudioPCMBuffer` may cross
        // that boundary. See ``ConversionInput`` for why the box is safe.
        let input = ConversionInput(buffer: buffer)
        var conversionError: NSError?
        let status = converter.convert(to: out, error: &conversionError) { _, inputStatus in
            // `.noDataNow` after the single input buffer, never `.endOfStream`:
            // end-of-stream retires the converter, and the next tap callback
            // would find it permanently drained.
            if input.consumed {
                inputStatus.pointee = .noDataNow
                return nil
            }
            input.consumed = true
            inputStatus.pointee = .haveData
            return input.buffer
        }
        guard status != .error, conversionError == nil, out.frameLength > 0,
            let samples = out.int16ChannelData
        else { return }
        let data = Data(bytes: samples[0], count: Int(out.frameLength) * MemoryLayout<Int16>.size)
        socket.send(.data(data)) { _ in }
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
    public private(set) var assistantSpeaking = false
    public private(set) var muted = false
    /// A non-fatal relay notice, cleared after a few seconds. The relay sends
    /// `error` frames mid-session for things a conversation survives; promoting
    /// those to ``Phase/error(_:)`` would hang up on a recoverable hiccup.
    public private(set) var notice: String?
    /// True while this Mac's screen is being streamed to the model. It stays
    /// false on iPhone by construction: the phone shares a *camera*, and that
    /// capture session belongs to the app's camera surface, which hands frames
    /// here through ``sendVideoFrame(_:)``.
    public private(set) var screenSharing = false
    #if os(iOS)
    public private(set) var speakerOutput = true
    #endif

    private let authorization: any JunoVoiceRelayAuthorizing
    /// Used only when the token response does not name a relay.
    private let fallbackRelayURL: URL?

    private let box = VoiceRelayShuttle()
    private var audioEngine: AVAudioEngine?
    private var playerNode: AVAudioPlayerNode?
    private var playbackFormat: AVAudioFormat?
    private var socket: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var pingTask: Task<Void, Never>?
    private var meterTask: Task<Void, Never>?
    private var noticeTask: Task<Void, Never>?
    /// Set by ``end()``. Every async step re-checks it, because a token fetch or
    /// a permission prompt can outlive the screen that started it and would
    /// otherwise bring an audio engine up behind a dismissed sheet.
    private var closedByUser = false
    private var reconnectAttempted = false
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
        provider: JunoVoiceProvider = .openai
    ) {
        self.authorization = authorization
        self.fallbackRelayURL = relayURL
        self.provider = provider
    }

    /// Connects and starts a session. Safe to call again from `ended` or
    /// `error`, which is how "Start again" works without rebuilding the object —
    /// and refusing it from `connecting`/`live` is what stops a double tap from
    /// opening two sockets onto one audio engine.
    public func start(provider requested: JunoVoiceProvider? = nil) async {
        switch phase {
        case .idle, .ended, .error: break
        default: return
        }
        closedByUser = false
        reconnectAttempted = false
        record.reset()
        usage = nil
        capabilities = nil
        notice = nil
        assistantSpeaking = false
        if let requested { provider = requested }
        phase = .connecting

        guard await requestMicPermission() else {
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
    }

    /// Barge-in. Local playback is flushed *before* the relay is told, because
    /// the queued buffers are already on the player node: waiting for the relay
    /// to acknowledge means the model keeps talking over the interruption for as
    /// long as the round trip takes.
    public func interrupt() {
        guard phase == .live else { return }
        flushPlayback()
        send(.controlInterrupt)
    }

    /// Switches provider on the live socket rather than reconnecting — the relay
    /// keeps the conversation, so the audio path never has to come down.
    public func switchProvider(_ newProvider: JunoVoiceProvider) {
        guard newProvider != provider, phase == .live else { return }
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
        send(.sessionSwitch(provider: newProvider))
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
        // audio session and swallow the first word after the gap.
        if audioEngine == nil {
            do {
                try startAudioEngine()
            } catch {
                phase = .error(.audioEngineFailed(error.localizedDescription))
                return
            }
        }

        let task = URLSession.shared.webSocketTask(with: relayURL)
        socket = task
        box.socket = task
        task.resume()
        send(.sessionStart(provider: provider))
        startReceiving(on: task)
        startPinging()
        startMetering()
        if isReconnect { phase = .reconnecting }
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
            if readyCapabilities.needsClientTranscript {
                await startTranscriber()
            } else {
                stopTranscriber()
            }

        case .transcript(let role, let text, let final):
            upsertTranscript(role: role, text: text, final: final)

        case .turn(let turnPhase):
            assistantSpeaking = turnPhase == .start
            // The answer starts here, whatever arrives next. Recorded on the
            // relay's own turn frame rather than on the first assistant word,
            // because some relays send the frame first and some do not.
            if turnPhase == .start { record.beginAnswer() }

        case .interrupted:
            flushPlayback()
            assistantSpeaking = false

        case .usage(let update):
            usage = update

        case .sessionClosed(let reason):
            teardown(closeCode: .normalClosure)
            phase = .ended(reason)

        case .error(let detail):
            // Fatal only before the session is up. Once audio is flowing the
            // same frame means "that turn had a problem", and hanging up on it
            // would end conversations that were fine.
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
    private func upsertTranscript(role: JunoVoiceTranscriptRole, text: String, final: Bool) {
        record.upsert(role: role, text: text, final: final)
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
        guard phase == .live, socket != nil, capabilities?.videoInput == true else { return }
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
    /// Matches the web composer. Past four images a turn, providers start
    /// answering about the first one and ignoring the rest.
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
    /// - Returns: false when nothing was sent, so a caller can fall back to the
    ///   normal chat path instead of quietly losing the message.
    @discardableResult
    public func sendTurn(text: String, images: [Data]) async -> Bool {
        guard phase == .live, let socket else { return false }
        let requested = Array(images.prefix(Self.maxTurnImages))
        guard requested.isEmpty || capabilities?.videoInput == true else { return false }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)

        var frames: [String] = []
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

        guard !trimmed.isEmpty || !frames.isEmpty else { return false }
        let displayText = trimmed.isEmpty
            ? (frames.count == 1 ? "Shared an image" : "Shared \(frames.count) images")
            : trimmed
        let message = trimmed.isEmpty
            ? "Please look at the image context I just shared and respond naturally."
            : trimmed
        for frame in frames { send(.videoFrame(jpegBase64: frame)) }
        send(.inputText(message, turnId: UUID().uuidString, displayText: displayText))
        return true
    }

    /// Base64 for a whole turn's images, off the main actor.
    ///
    /// `nonisolated async` rather than a plain helper: under SE-0338 that is what
    /// actually leaves the main actor, and four images at the relay's ceiling is
    /// enough work to drop frames from the orb if it ran here.
    private nonisolated static func encodeFrames(_ images: [Data]) async -> [String] {
        images.compactMap(relayFrame)
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
        guard phase == .live, capabilities?.screenInput == true, !screenSharing else { return }
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
        let content: SCShareableContent
        do {
            // Also the permission gate. The first call prompts; a Mac that has
            // refused throws here rather than handing back an empty display list,
            // which is the only reason this failure can be named accurately.
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
            capabilities?.screenInput == true
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
                capabilities?.screenInput == true, socket != nil
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

    private func startAudioEngine() throws {
        #if os(iOS)
        // `.voiceChat` is what buys echo cancellation: without it the model
        // hears itself through the speaker and interrupts its own turn.
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(
            .playAndRecord,
            mode: .voiceChat,
            options: [.defaultToSpeaker, .allowBluetoothHFP]
        )
        try session.setActive(true, options: .notifyOthersOnDeactivation)
        #endif

        let engine = AVAudioEngine()
        let player = AVAudioPlayerNode()
        let input = engine.inputNode

        #if os(macOS)
        // What `.voiceChat` buys on iOS, asked for directly here: echo
        // cancellation so the model does not hear itself through the speakers and
        // interrupt its own turn, and automatic gain so a laptop's far-field
        // microphone reaches the relay at a usable level.
        //
        // Both matter to what is on screen as well. Without AGC the raw RMS of
        // someone talking a normal distance from a MacBook sits around 0.01–0.03,
        // which is why the field barely moved while they were speaking.
        //
        // It must be enabled BEFORE the format is read: turning it on re-formats
        // the node, and a converter built from the old format would then be
        // wrong. Failure is not fatal — a Mac with no voice-processing-capable
        // input still holds a conversation, just without the help.
        try? input.setVoiceProcessingEnabled(true)
        #endif

        var inputFormat = input.outputFormat(forBus: 0)
        #if os(macOS)
        // Some inputs report nothing usable once voice processing is on — an
        // aggregate device, or a driver that does not implement the unit. Better
        // a conversation without echo cancellation than no conversation, so the
        // help is withdrawn and the node re-read rather than the session failing.
        if inputFormat.sampleRate <= 0 || inputFormat.channelCount == 0 {
            try? input.setVoiceProcessingEnabled(false)
            inputFormat = input.outputFormat(forBus: 0)
        }
        #endif
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else {
            throw RealtimeAudioSetupError.noInput
        }
        // Model speech arrives as PCM16 mono 24 kHz. Scheduling Float32 mono
        // 24 kHz and letting the mixer resample is what keeps this correct on
        // hardware that runs its output at 44.1 kHz.
        guard let playback = AVAudioFormat(standardFormatWithSampleRate: 24_000, channels: 1),
            let capture = AVAudioFormat(
                commonFormat: .pcmFormatInt16, sampleRate: 16_000,
                channels: 1, interleaved: true
            ),
            let converter = AVAudioConverter(from: inputFormat, to: capture)
        else {
            throw RealtimeAudioSetupError.formatUnavailable
        }
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: playback)
        box.configureCapture(converter: converter, captureFormat: capture)
        box.muted = muted

        // Defensive: installing a second tap on a bus that still has one raises
        // an Objective-C exception, which is a crash and not a Swift error.
        input.removeTap(onBus: 0)
        Self.installMicTap(on: input, format: inputFormat, box: box)
        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            throw error
        }
        player.play()
        audioEngine = engine
        playerNode = player
        playbackFormat = playback
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
        playerNode.scheduleBuffer(buffer)
    }

    /// Drops everything queued. `stop()` alone leaves the node unable to accept
    /// new buffers, so the `play()` is not optional — without it an interrupted
    /// session goes permanently silent.
    private func flushPlayback() {
        guard let playerNode else { return }
        playerNode.stop()
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
                let micTarget = self.muted ? 0 : Self.loudness(self.box.micLevel)
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
    nonisolated static let quietFloorDB: Double = -52
    nonisolated static let loudCeilingDB: Double = -12

    /// Linear RMS → 0…1 across a speech window, in decibels.
    ///
    /// `nonisolated` because it is pure arithmetic and needs to be testable
    /// without a main-actor hop, and because the meter pump is the only caller.
    nonisolated static func loudness(_ rms: Double) -> Double {
        guard rms > 0 else { return 0 }
        let decibels = 20 * log10(rms)
        let range = loudCeilingDB - quietFloorDB
        return min(1, max(0, (decibels - quietFloorDB) / range))
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
        stopTranscriber()
        #if os(macOS)
        // Before the socket, like the pumps: a capture that outlives the session
        // is a Mac still recording its own screen for a conversation that is over.
        stopScreenShare()
        #endif
        socket?.cancel(with: closeCode, reason: nil)
        socket = nil
        if let engine = audioEngine {
            engine.inputNode.removeTap(onBus: 0)
            playerNode?.stop()
            engine.stop()
            if let playerNode { engine.detach(playerNode) }
        }
        audioEngine = nil
        playerNode = nil
        playbackFormat = nil
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

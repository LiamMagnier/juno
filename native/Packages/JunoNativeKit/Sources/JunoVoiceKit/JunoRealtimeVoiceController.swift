#if canImport(AVFoundation) && canImport(Speech)
import AVFoundation
import Foundation
import Observation
import Speech

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
        case .micPermissionDenied:
            "Microphone access was blocked. Allow it in Settings to talk to Juno."
        case .speechPermissionDenied:
            "Speech recognition was blocked. This provider needs on-device transcription — allow it in Settings."
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

        let ratio = captureFormat.sampleRate / buffer.format.sampleRate
        // The +16 is slack: the resampler can emit a frame or two more than the
        // ratio predicts, and an exactly-sized buffer turns that into an error
        // return and a silent gap in the uplink.
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 16
        guard let out = AVAudioPCMBuffer(pcmFormat: captureFormat, frameCapacity: capacity) else {
            return
        }
        var consumed = false
        var conversionError: NSError?
        let status = converter.convert(to: out, error: &conversionError) { _, inputStatus in
            // `.noDataNow` after the single input buffer, never `.endOfStream`:
            // end-of-stream retires the converter, and the next tap callback
            // would find it permanently drained.
            if consumed {
                inputStatus.pointee = .noDataNow
                return nil
            }
            consumed = true
            inputStatus.pointee = .haveData
            return buffer
        }
        guard status != .error, conversionError == nil, out.frameLength > 0,
            let samples = out.int16ChannelData
        else { return }
        let data = Data(bytes: samples[0], count: Int(out.frameLength) * MemoryLayout<Int16>.size)
        socket.send(.data(data)) { _ in }
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
    public struct TranscriptLine: Identifiable, Equatable, Sendable {
        public let id: UUID
        public var role: JunoVoiceTranscriptRole
        public var text: String
        public var final: Bool

        public init(id: UUID = UUID(), role: JunoVoiceTranscriptRole, text: String, final: Bool) {
            self.id = id
            self.role = role
            self.text = text
            self.final = final
        }
    }

    /// How many lines are kept. A long session otherwise grows an array that
    /// SwiftUI re-diffs on every partial transcript, several times a second.
    public static let transcriptCapacity = 200

    public private(set) var phase: Phase = .idle
    public private(set) var transcript: [TranscriptLine] = []
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
        transcript = []
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

    /// Rewrites the open line for this speaker, or opens one. The relay streams
    /// each utterance as a growing string, so appending every frame would print
    /// the same sentence a dozen times as it is spoken.
    private func upsertTranscript(role: JunoVoiceTranscriptRole, text: String, final: Bool) {
        if let index = transcript.lastIndex(where: { $0.role == role && !$0.final }) {
            transcript[index].text = text
            transcript[index].final = final
        } else {
            transcript.append(TranscriptLine(role: role, text: text, final: final))
        }
        if transcript.count > Self.transcriptCapacity {
            transcript.removeFirst(transcript.count - Self.transcriptCapacity)
        }
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

    // MARK: Audio engine

    private func requestMicPermission() async -> Bool {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return true
        // Denied is final. Calling `requestRecordPermission()` again returns
        // false without prompting, so asking would only delay the error copy
        // that tells the user where the real switch is.
        case .denied: return false
        default: return await AVAudioApplication.requestRecordPermission()
        }
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
        let inputFormat = input.outputFormat(forBus: 0)
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

    /// 30Hz smoothing pump. Same easing constant as `JunoSpeechService` and the
    /// web's `attachLevelMeter`, so all three clients' meters move alike.
    ///
    /// Playback decays 14% per tick rather than being cleared: the relay's audio
    /// frames arrive in bursts, and a level reset between them would strobe the
    /// orb through zero while the model is still mid-word.
    private func startMetering() {
        meterTask?.cancel()
        meterTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(33))
                guard !Task.isCancelled, let self else { break }
                let micTarget = self.muted ? 0 : min(1, self.box.micLevel * 4)
                let playbackTarget = min(1, self.box.playbackLevel * 2.5)
                self.box.playbackLevel *= 0.86
                let target = max(micTarget, playbackTarget)
                self.level += (target - self.level) * 0.25
            }
        }
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

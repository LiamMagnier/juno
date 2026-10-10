#if canImport(Speech) && canImport(AVFoundation)
import AVFoundation
import Foundation
import Observation
import Speech

/// Live speech-to-text: `SFSpeechRecognizer` fed by an `AVAudioEngine` tap.
///
/// This is the native counterpart of the website's dictation pipeline
/// (`src/components/chat/composer-dictation.tsx`), but it deliberately does
/// **not** copy its two-tier design. The web needs two transcribers because the
/// browser's own recognizer mangles anything but English, so it shows Web Speech
/// as an approximate live preview and re-transcribes the captured audio
/// server-side for the text that actually reaches the composer. `SFSpeechRecognizer`
/// is not that: it is locale-aware, punctuates, and on most languages runs
/// entirely on device. One transcriber is the right answer here, and it means a
/// dictated message needs no upload and no round trip at all.
///
/// What *is* ported is the behaviour the web tuned:
///
/// - **Continuous.** The recognizer finalises an utterance after a pause and
///   stops. Committed text is accumulated and recognition restarts, throttled to
///   300ms so a hard failure cannot hot-loop — the same guard as the web's
///   `onEnd` restart.
/// - **Freeze before teardown.** Stopping clears the interim hypothesis, so the
///   transcript is captured *before* the engine is torn down. Reading it after is
///   the race that silently drops the last few words.
/// - **A real level meter.** RMS from the tap, ×4 gain, eased toward the target
///   at 0.25 per frame — the web's `attachLevelMeter` constants, so the two
///   clients' meters move alike.
@MainActor
@Observable
public final class JunoSpeechService {
    public enum Permission: Equatable, Sendable {
        case undetermined
        case granted
        case denied
    }

    public enum Failure: LocalizedError, Equatable {
        case permissionDenied
        case recognizerUnavailable
        case noAudioInput
        case engineFailed(String)

        public var errorDescription: String? {
            switch self {
            case .permissionDenied:
                "Microphone or speech access was blocked. Allow it in Settings to dictate."
            case .recognizerUnavailable:
                "Speech recognition isn't available right now."
            case .noAudioInput:
                "No microphone input is available."
            case .engineFailed(let detail):
                detail.isEmpty ? "The audio engine couldn't start." : detail
            }
        }
    }

    /// How many recent levels the waveform can draw.
    public static let levelHistoryCapacity = 72

    public private(set) var permission: Permission = .undetermined
    public private(set) var isListening = false
    /// Committed text, accumulated across recognizer restarts.
    public private(set) var finalizedText = ""
    /// The live hypothesis for the utterance in progress.
    public private(set) var partialText = ""
    /// Smoothed microphone level, 0–1.
    public private(set) var level: Double = 0
    /// Recent levels, newest last, for the waveform.
    public private(set) var levelHistory: [Double] = []
    /// The microphone on the speech-loudness window (-52...-12 dBFS → 0...1),
    /// unsmoothed: the scale the voice light and the waveform read, where a
    /// normal voice reaches the top and a quiet room stays at the bottom.
    public private(set) var loudness: Double = 0
    /// Recent ``loudness`` values, newest last, one per meter tick (30 Hz).
    public private(set) var loudnessHistory: [Double] = []
    public private(set) var lastErrorMessage: String?

    /// Everything heard so far — committed text plus the live hypothesis.
    public var transcript: String {
        [finalizedText, partialText]
            .filter { !$0.isEmpty }
            .joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Whether this device can transcribe at all. False on a Simulator without a
    /// recognizer, and the reason the composer hides its microphone rather than
    /// offering a control that cannot work.
    public static var isSupported: Bool {
        SFSpeechRecognizer(locale: .autoupdatingCurrent) != nil || SFSpeechRecognizer() != nil
    }

    /// One engine per take, released when the take ends. A long-lived engine
    /// keeps its input node, and with it a claim on the microphone, for as
    /// long as the composer that made it exists, which is the claim a voice
    /// call then fought with.
    private var audioEngine: AVAudioEngine?
    private let tap = TapBox()
    private var recognizer: SFSpeechRecognizer?
    private var recognitionTask: SFSpeechRecognitionTask?
    /// True while the caller still wants recognition running — the guard that
    /// makes the continuous restart stop when asked.
    private var active = false
    /// Whether this recognizer can transcribe without the network. Resolved once
    /// per session; see the note where it is set.
    private var prefersOnDevice = false
    private var lastRestartAt: Date = .distantPast
    private var levelPump: Task<Void, Never>?
    private var restart: Task<Void, Never>?

    public init() {
        refreshPermission()
    }

    // MARK: - Permissions

    /// Reads the current authorization without prompting.
    public func refreshPermission() {
        let mic = AVAudioApplication.shared.recordPermission
        let speech = SFSpeechRecognizer.authorizationStatus()
        if mic == .denied || speech == .denied || speech == .restricted {
            permission = .denied
        } else if mic == .granted, speech == .authorized {
            permission = .granted
        } else {
            permission = .undetermined
        }
    }

    /// Requests microphone *and* speech authorization. Prompts only for what is
    /// still undetermined, so a second attempt after a denial does not re-ask for
    /// something the system will never re-present.
    @discardableResult
    public func requestPermission() async -> Bool {
        let micGranted: Bool
        switch AVAudioApplication.shared.recordPermission {
        case .granted: micGranted = true
        case .denied: micGranted = false
        default: micGranted = await AVAudioApplication.requestRecordPermission()
        }

        let speechStatus: SFSpeechRecognizerAuthorizationStatus
        let current = SFSpeechRecognizer.authorizationStatus()
        if current == .notDetermined {
            speechStatus = await Self.requestSpeechAuthorization()
        } else {
            speechStatus = current
        }

        let granted = micGranted && speechStatus == .authorized
        permission = granted ? .granted : .denied
        return granted
    }

    /// Speech calls this completion on a TCC worker queue. Keeping the bridge
    /// `nonisolated` is essential: defining the completion inline in this
    /// `@MainActor` service makes Swift attach a main-actor executor assertion
    /// to it, and TCC then traps before the continuation can resume.
    private nonisolated static func requestSpeechAuthorization() async
        -> SFSpeechRecognizerAuthorizationStatus
    {
        await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status)
            }
        }
    }

    // MARK: - Lifecycle

    /// Starts transcribing. Call ``requestPermission()`` first.
    public func start(locale: Locale = .autoupdatingCurrent) throws {
        guard !isListening else { return }
        guard permission == .granted else { throw Failure.permissionDenied }

        guard let recognizer = SFSpeechRecognizer(locale: locale) ?? SFSpeechRecognizer(),
            recognizer.isAvailable
        else { throw Failure.recognizerUnavailable }
        self.recognizer = recognizer

        finalizedText = ""
        partialText = ""
        lastErrorMessage = nil

        // A call (or another take) lets go of the microphone first. If a call
        // claims it back, this take ends the way Cancel would.
        JunoMicrophoneArbiter.shared.claim(.dictation, by: self) { [weak self] in
            self?.cancel()
        }

        #if os(iOS)
        // `.playAndRecord` rather than `.record`: a dictation that ends in a
        // spoken reply must not have to tear the session down and build a new
        // one, which audibly clicks and drops the first syllable.
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(
                .playAndRecord,
                mode: .spokenAudio,
                options: [.duckOthers, .defaultToSpeaker, .allowBluetoothHFP]
            )
            try session.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            releaseMicrophone()
            throw error
        }
        #endif

        let engine = AVAudioEngine()
        audioEngine = engine
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            releaseMicrophone()
            throw Failure.noAudioInput
        }

        // Cached once, deliberately. `supportsOnDeviceRecognition` is a
        // *synchronous XPC round trip* into the speech daemon, and the recognizer
        // is restarted after every utterance — asking each time blocked the main
        // thread once per pause in speech.
        prefersOnDevice = recognizer.supportsOnDeviceRecognition

        active = true
        input.removeTap(onBus: 0)
        Self.installTap(on: input, format: format, box: tap)

        engine.prepare()
        do {
            try engine.start()
        } catch {
            active = false
            input.removeTap(onBus: 0)
            releaseMicrophone()
            throw Failure.engineFailed(error.localizedDescription)
        }

        beginRecognition()
        startLevelPump()
        isListening = true
    }

    /// Stops and returns the transcript, captured **before** teardown.
    @discardableResult
    public func stopAndFreeze() -> String {
        let frozen = transcript
        teardown()
        return frozen
    }

    /// Stops and discards everything heard.
    public func cancel() {
        teardown()
        finalizedText = ""
        partialText = ""
    }

    // MARK: - Recognition

    private func beginRecognition() {
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.taskHint = .dictation
        // Dictated prose without punctuation reads as one runaway sentence, and
        // the reader would have to add it by hand before sending.
        request.addsPunctuation = true
        if prefersOnDevice {
            request.requiresOnDeviceRecognition = true
        }
        tap.request = request
        lastRestartAt = .now

        recognitionTask = recognizer?.recognitionTask(with: request) { [weak self] result, error in
            // The callback is not on the main actor; hop before touching state.
            let text = result?.bestTranscription.formattedString
            let isFinal = result?.isFinal ?? false
            let failed = error != nil
            Task { @MainActor [weak self] in
                guard let self, self.active else { return }
                if let text, !text.isEmpty, text != self.partialText {
                    self.partialText = text
                }
                if isFinal {
                    if let text, !text.isEmpty {
                        self.finalizedText = [self.finalizedText, text]
                            .filter { !$0.isEmpty }
                            .joined(separator: " ")
                    }
                    self.partialText = ""
                    self.scheduleRestart()
                } else if failed {
                    // A recognizer hiccup ("no speech detected") is routine, not
                    // the end of dictation — keep the loop alive.
                    self.scheduleRestart()
                }
            }
        }
    }

    /// Restarts recognition, never more than once per 300ms.
    private func scheduleRestart() {
        guard active else { return }
        recognitionTask?.cancel()
        recognitionTask = nil
        tap.request?.endAudio()
        tap.request = nil

        let wait = max(0, 0.3 - Date.now.timeIntervalSince(lastRestartAt))
        restart?.cancel()
        restart = Task { [weak self] in
            if wait > 0 { try? await Task.sleep(for: .seconds(wait)) }
            guard !Task.isCancelled else { return }
            guard let self, self.active else { return }
            self.beginRecognition()
        }
    }

    /// 30Hz is the meter's own resolution — a display link would sample the same
    /// RMS twice and animate nothing extra.
    private func startLevelPump() {
        levelPump?.cancel()
        levelPump = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(33))
                guard let self else { break }
                guard self.active else { continue }
                let target = min(1, self.tap.rawLevel * 4)
                self.level += (target - self.level) * 0.25
                if self.levelHistory.count >= Self.levelHistoryCapacity {
                    self.levelHistory.removeFirst()
                }
                self.levelHistory.append(self.level)
                self.loudness = RealtimeLoudness.normalized(self.tap.rawLevel)
                if self.loudnessHistory.count >= Self.levelHistoryCapacity {
                    self.loudnessHistory.removeFirst()
                }
                self.loudnessHistory.append(self.loudness)
            }
        }
    }

    private func teardown() {
        active = false
        restart?.cancel()
        restart = nil
        levelPump?.cancel()
        levelPump = nil
        recognitionTask?.cancel()
        recognitionTask = nil
        tap.request?.endAudio()
        tap.request = nil
        releaseMicrophone()
        tap.rawLevel = 0
        level = 0
        levelHistory = []
        loudness = 0
        loudnessHistory = []
        isListening = false
    }

    /// Stops the take's engine, drops it, and gives the microphone back.
    ///
    /// On iOS the session is deactivated too, but only when nothing else in
    /// the process holds the microphone: a call that took it over has already
    /// set its own category, and deactivating under it would stop its graph.
    /// Leaving dictation's `.spokenAudio` session active kept other apps
    /// ducked after the take and handed the next call a session in the wrong
    /// mode.
    private func releaseMicrophone() {
        if let engine = audioEngine {
            engine.inputNode.removeTap(onBus: 0)
            if engine.isRunning { engine.stop() }
        }
        audioEngine = nil
        let held = JunoMicrophoneArbiter.shared.isHeld(by: self)
        JunoMicrophoneArbiter.shared.release(by: self)
        #if os(iOS)
        if held, JunoMicrophoneArbiter.shared.owner == nil {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
        #endif
    }

    /// Installs the microphone tap from a **non-isolated** context.
    ///
    /// This has to be `nonisolated`, and the reason is a crash rather than
    /// tidiness. This type is `@MainActor`, so under Swift 6 a closure written
    /// inside one of its methods inherits that isolation — and the compiler emits
    /// an executor check at the top of it. `AVAudioEngine` calls a tap block on the
    /// realtime audio thread, so that check ran `dispatch_assert_queue` off the
    /// main queue and trapped: `EXC_BREAKPOINT` on
    /// `RealtimeMessenger.mServiceQueue`, every time dictation started.
    ///
    /// Formed here instead, the block is genuinely non-isolated — which is the
    /// truth about where it runs. It touches nothing but the lock-guarded box.
    private nonisolated static func installTap(
        on input: AVAudioInputNode,
        format: AVAudioFormat,
        box: TapBox
    ) {
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            box.append(buffer)
        }
    }

    /// The handful of values the audio thread and the main actor share.
    ///
    /// A lock rather than an actor: the tap block cannot `await`, and it runs
    /// under a realtime deadline. `NSLock` here is uncontended in practice — the
    /// main actor only reads the level 30 times a second.
    private final class TapBox: @unchecked Sendable {
        private let lock = NSLock()
        private var storedRequest: SFSpeechAudioBufferRecognitionRequest?
        private var storedLevel: Double = 0

        var request: SFSpeechAudioBufferRecognitionRequest? {
            get { lock.lock(); defer { lock.unlock() }; return storedRequest }
            set { lock.lock(); defer { lock.unlock() }; storedRequest = newValue }
        }

        var rawLevel: Double {
            get { lock.lock(); defer { lock.unlock() }; return storedLevel }
            set { lock.lock(); defer { lock.unlock() }; storedLevel = newValue }
        }

        /// Called on the audio thread: feed the recognizer, then measure.
        func append(_ buffer: AVAudioPCMBuffer) {
            request?.append(buffer)
            // Time-domain RMS. Cheap enough for a realtime callback, and it is the
            // measure the web's own meter uses.
            guard let channel = buffer.floatChannelData?.pointee else { return }
            let frames = Int(buffer.frameLength)
            guard frames > 0 else { return }
            var sum: Float = 0
            for index in 0..<frames {
                let sample = channel[index]
                sum += sample * sample
            }
            rawLevel = Double((sum / Float(frames)).squareRoot())
        }
    }
}
#endif

#if DEBUG && canImport(AVFoundation) && canImport(Speech)
extension JunoSpeechService {
    /// A take with no microphone behind it, for the screenshot harnesses: the
    /// words given, and a synthetic loudness that moves the way a voice does
    /// (two slow envelopes under a syllable tremor), so the waveform and the
    /// voice light can be looked at on a simulator or offscreen. Debug-only.
    /// `cancel()` or `stopAndFreeze()` ends it like a real take.
    public func beginPreviewSession(final: String = "", partial: String = "", speaking: Bool = true) {
        finalizedText = final
        partialText = partial
        isListening = true
        active = true
        permission = .granted
        levelPump?.cancel()
        levelPump = Task { [weak self] in
            let started = Date()
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(33))
                guard let self, self.active else { break }
                let t = Date().timeIntervalSince(started)
                let envelope = 0.5 + 0.5 * sin(t * 1.9) * sin(t * 0.7 + 1)
                let tremor = 0.5 + 0.5 * sin(t * 13)
                let loud = speaking ? 0.22 + 0.62 * envelope * (0.55 + 0.45 * tremor) : 0.05
                self.loudness = loud
                if self.loudnessHistory.count >= Self.levelHistoryCapacity {
                    self.loudnessHistory.removeFirst()
                }
                self.loudnessHistory.append(loud)
                self.level = loud * 0.6
            }
        }
    }

    /// Seeds the waveform's history with `seconds` of synthetic speech at once,
    /// so an offscreen still shows a full row rather than its first frame.
    public func seedPreviewHistory(phase: Double = 0) {
        loudnessHistory = (0..<Self.levelHistoryCapacity).map { index in
            let t = phase + Double(index) / 30
            let envelope = 0.5 + 0.5 * sin(t * 1.9) * sin(t * 0.7 + 1)
            let tremor = 0.5 + 0.5 * sin(t * 13)
            return 0.22 + 0.62 * envelope * (0.55 + 0.45 * tremor)
        }
        loudness = loudnessHistory.last ?? 0
    }
}
#endif

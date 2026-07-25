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
    public static let levelHistoryCapacity = 48

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

    private let audioEngine = AVAudioEngine()
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
            speechStatus = await withCheckedContinuation { continuation in
                SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
            }
        } else {
            speechStatus = current
        }

        let granted = micGranted && speechStatus == .authorized
        permission = granted ? .granted : .denied
        return granted
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

        #if os(iOS)
        // `.playAndRecord` rather than `.record`: a dictation that ends in a
        // spoken reply must not have to tear the session down and build a new
        // one, which audibly clicks and drops the first syllable.
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(
            .playAndRecord,
            mode: .spokenAudio,
            options: [.duckOthers, .defaultToSpeaker, .allowBluetoothHFP]
        )
        try session.setActive(true, options: .notifyOthersOnDeactivation)
        #endif

        let input = audioEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
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

        audioEngine.prepare()
        do {
            try audioEngine.start()
        } catch {
            active = false
            input.removeTap(onBus: 0)
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
        if audioEngine.isRunning { audioEngine.stop() }
        audioEngine.inputNode.removeTap(onBus: 0)
        tap.rawLevel = 0
        level = 0
        levelHistory = []
        isListening = false
        // The iOS audio session is left active on purpose: deactivating it here
        // clicks, and anything that speaks next would have to rebuild it.
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

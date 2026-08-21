#if canImport(AVFoundation)
// `@preconcurrency` for the same reason ``JunoRealtimeVoiceController`` needs it:
// AVFAudio's callback types are declared `@Sendable` while being invoked
// synchronously on the calling thread, an annotation the framework predates.
// Scoped to this one import so the rest of JunoVoiceKit stays fully checked.
@preconcurrency import AVFoundation
import Foundation

// MARK: - The realtime audio endpoint, on real hardware

/// ``RealtimeAudioEndpoint`` backed by `AVAudioEngine`.
///
/// The graph is the one `JunoRealtimeVoiceController` proved out — microphone tap
/// → `AVAudioConverter` → PCM16 mono 16 kHz for the uplink, and an
/// `AVAudioPlayerNode` fed Float32 mono 24 kHz for the model's speech — and the
/// three lessons it paid for are kept verbatim, because each one is a crash or a
/// silent call:
///
/// - **The tap is installed from a `nonisolated static` helper.** A closure
///   written inside an isolated context inherits that isolation, and the
///   compiler's executor check then runs `dispatch_assert_queue` on the realtime
///   audio thread and traps.
/// - **Voice processing is attempted and then withdrawn.**
///   `setVoiceProcessingEnabled(true)` only sets a flag; the refusal surfaces
///   inside `engine.start()`, on Macs whose input and output are different
///   devices and on phones whose route cannot host the unit. There is a second
///   attempt without it, and no third — a plain input node on the hardware's own
///   format is the simplest thing CoreAudio can be asked for.
/// - **The input format is read as late as possible**, immediately before the
///   converter and tap built from it. A converter built from a format the node
///   has since left resamples wrong, and a tap installed with one raises an
///   Objective-C exception rather than returning an error.
///
/// What is *new* here is ``echoCancellation``, which the controller never needed
/// to answer out loud: it drives ``RealtimeBargeInPolicy``, so the difference
/// between "cancelling" and "cannot say" is the difference between talking over
/// the model and a call that interrupts itself on its own first syllable.
public actor AVAudioEngineRealtimeEndpoint: RealtimeAudioEndpoint {

    /// Why the graph could not come up. Deliberately not a mapping of every
    /// OSStatus — ``JunoRealtimeVoiceController`` already owns that translation
    /// for the surface the reader sees. These are the three the *endpoint* can
    /// distinguish before CoreAudio is even asked.
    public enum Failure: LocalizedError, Equatable {
        case noInput
        case formatUnavailable
        case engine(String)

        public var errorDescription: String? {
            switch self {
            case .noInput: "No microphone input is available."
            case .formatUnavailable:
                "The audio formats for the voice session couldn't be created."
            case .engine(let detail):
                detail.isEmpty ? "The audio engine couldn't start." : detail
            }
        }
    }

    /// Uplink format, matching the relay: PCM16 mono 16 kHz.
    public static let uplinkSampleRate: Double = 16_000
    /// Downlink format, matching the relay: PCM16 mono 24 kHz, played as Float32
    /// so the mixer resamples for hardware that runs its output at 44.1 kHz.
    public static let downlinkSampleRate: Double = 24_000

    private let box = CaptureShuttle()
    /// Capture and playback deliberately use separate engines on macOS. A
    /// voice-processing input node is a duplex AudioUnit; placing the player in
    /// that same graph makes CoreAudio reconcile the microphone and speaker
    /// device formats during `start()`. On real Mac hardware that can leave the
    /// input advertising the voice processor's synthetic multichannel format
    /// and fail with `kAudioUnitErr_FailedInitialization` (-10875). Separate
    /// engines keep the hardware clocks independent while each mixer performs
    /// its own conversion.
    private var engine: AVAudioEngine?
    private var playbackEngine: AVAudioEngine?
    private var player: AVAudioPlayerNode?
    private var playbackFormat: AVAudioFormat?
    private var resolvedEchoCancellation: RealtimeEchoCancellation = .unknown

    public init() {}

    // MARK: Lifecycle

    public func start() async throws {
        #if os(iOS)
        // `.playAndRecord` with `.voiceChat` is the **precondition** for the
        // voice-processing request in ``build(voiceProcessing:)``, not a
        // substitute for it: the unit can only be enabled under a category that
        // both records and plays. The mode does also cancel echo at the session
        // level — which is why calls on a phone sounded fine before any of this —
        // but that is invisible to `isVoiceProcessingEnabled` and is therefore no
        // evidence at all as far as ``echoCancellation`` is concerned.
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(
                .playAndRecord,
                mode: .voiceChat,
                options: [.defaultToSpeaker, .allowBluetoothHFP]
            )
            try session.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            throw Failure.engine(error.localizedDescription)
        }
        #endif

        // Whatever a previous session left behind still holds this process's
        // claim on the input device, and a second engine built on top of that
        // claim is one of the ways a working microphone produces an
        // initialisation failure. Costs nothing when there is nothing to drop.
        dispose()

        let attempts = RealtimeAudioGraphPlan.current.voiceProcessingAttempts
        do {
            try build(voiceProcessing: attempts[0])
        } catch {
            // The refusal only surfaces at `start()`, so the only way to find out
            // is to try. A conversation without echo cancellation is still a
            // conversation — it is just one where barge-in has to be manual.
            do {
                try build(voiceProcessing: attempts[1])
            } catch {
                throw Failure.engine(error.localizedDescription)
            }
        }
    }

    public func stop() async {
        dispose()
        box.finish()
        resolvedEchoCancellation = .unknown
        #if os(iOS)
        // Deactivated deliberately: a voice session held `.playAndRecord` with
        // `.voiceChat`, and leaving that active keeps other apps' audio ducked
        // after the call is over.
        try? AVAudioSession.sharedInstance()
            .setActive(false, options: .notifyOthersOnDeactivation)
        #endif
    }

    // MARK: Uplink control

    /// Half-duplex, applied by skipping the send rather than by stopping the
    /// tap. Tearing the tap down and rebuilding it costs a rebuild's worth of
    /// dropped syllables every time the model finishes a sentence.
    public func setUplinkSuppressed(_ suppressed: Bool) async {
        box.suppressed = suppressed
    }

    public func setMuted(_ muted: Bool) async {
        box.muted = muted
    }

    // MARK: Downlink

    public func enqueuePlayback(_ pcm16: Data) async {
        guard let player, let playbackFormat else { return }
        let frames = pcm16.count / MemoryLayout<Int16>.size
        guard frames > 0,
            let buffer = AVAudioPCMBuffer(
                pcmFormat: playbackFormat,
                frameCapacity: AVAudioFrameCount(frames)
            ),
            let channel = buffer.floatChannelData
        else { return }
        buffer.frameLength = AVAudioFrameCount(frames)
        pcm16.withUnsafeBytes { raw in
            let samples = raw.bindMemory(to: Int16.self)
            for index in 0..<frames {
                channel[0][index] = Float(Int16(littleEndian: samples[index])) / 32_768
            }
        }
        Self.schedule(buffer, on: player)
    }

    /// Queues one buffer and returns immediately.
    ///
    /// Through a **synchronous** helper on purpose. Inside an `async` method the
    /// bare `scheduleBuffer(_:)` resolves to AVFAudio's *awaitable* overload,
    /// which does not return until the buffer has finished playing — so the
    /// endpoint's actor would be held for the duration of every frame, which
    /// serializes the downlink into stutter and blocks ``flushPlayback()``
    /// precisely when barge-in needs it. The compiler cannot know that here,
    /// which is why it suggests the asynchronous alternative; moving the call
    /// somewhere non-async is what states that the fire-and-forget form is the
    /// one that is wanted.
    private nonisolated static func schedule(
        _ buffer: AVAudioPCMBuffer,
        on player: AVAudioPlayerNode
    ) {
        player.scheduleBuffer(buffer)
    }

    /// Barge-in's local half. `stop()` alone leaves the node unable to accept new
    /// buffers, so the `play()` is not optional — without it an interrupted
    /// session goes permanently silent, which reads as the interruption having
    /// ended the call.
    public func flushPlayback() async {
        guard let player else { return }
        player.stop()
        player.play()
    }

    // MARK: Reporting

    /// What the hardware is actually doing about echo, right now.
    ///
    /// Resolved from the input node after the graph is up, never guessed:
    /// `isVoiceProcessingEnabled` is the only thing that knows whether the unit
    /// that was *asked for* actually initialised. Before ``start()`` — and after
    /// ``stop()`` — this is ``RealtimeEchoCancellation/unknown``, which is a
    /// third answer rather than a pessimistic second one, because "not running"
    /// and "running without cancellation" want different UI.
    public var echoCancellation: RealtimeEchoCancellation {
        resolvedEchoCancellation
    }

    /// Nonisolated because the protocol's requirement is synchronous and because
    /// the stream is registered on a lock-guarded box, not on actor state — the
    /// realtime tap has to be able to yield into it without hopping anywhere.
    public nonisolated func captureFrames() -> AsyncStream<RealtimeCaptureFrame> {
        box.makeStream()
    }

    // MARK: Graph

    /// One attempt at a complete graph: left running on success, left as though
    /// it had never been built on failure.
    ///
    /// The order is load-bearing twice. The player is connected to
    /// `mainMixerNode` **before** the input format is read, because touching the
    /// mixer instantiates the output half of the graph — and with voice
    /// processing on, input and output are one unit. And the input format is read
    /// **last**, immediately before the converter and tap built from it.
    private func build(voiceProcessing: Bool) throws {
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

        // Asked for on **both** platforms. On iOS this is what makes ``echoCancellation``
        // able to answer `.active` at all: the session's `.voiceChat` mode cancels
        // echo without ever touching `isVoiceProcessingEnabled`, so a phone that
        // did not ask for the node's own unit reported "no" to the only question
        // ``RealtimeBargeInPolicy`` knows how to ask, and automatic barge-in could
        // never engage. Asking makes the condition true where the hardware allows
        // it; where it does not, the node still says `false` and the policy still
        // lands on manual, which is exactly where it was.
        //
        // `try?` because a device with no voice-processing unit refuses right
        // here, and that is a recoverable outcome — the devices that *accept* the
        // flag and then fail to initialise are what the caller's second attempt
        // exists for.
        if voiceProcessing { try? input.setVoiceProcessingEnabled(true) }

        guard let playback = AVAudioFormat(
                standardFormatWithSampleRate: Self.downlinkSampleRate, channels: 1
            ),
            let capture = AVAudioFormat(
                commonFormat: .pcmFormatInt16,
                sampleRate: Self.uplinkSampleRate,
                channels: 1,
                interleaved: true
            )
        else { throw Failure.formatUnavailable }

        outputEngine.attach(player)
        outputEngine.connect(player, to: outputEngine.mainMixerNode, format: playback)

        let inputFormat = Self.usableInputFormat(of: input)
        guard RealtimeInputFormat.isUsable(
            sampleRate: inputFormat.sampleRate, channelCount: inputFormat.channelCount
        ) else {
            throw Failure.noInput
        }
        guard let converter = AVAudioConverter(from: inputFormat, to: capture) else {
            throw Failure.formatUnavailable
        }
        box.configure(converter: converter, uplinkFormat: capture)

        // Defensive: installing a second tap on a bus that still has one raises
        // an Objective-C exception, which is a crash and not a Swift error.
        input.removeTap(onBus: 0)
        Self.installTap(on: input, format: inputFormat, box: box)
        engine.prepare()
        #if os(macOS)
        outputEngine.prepare()
        #endif
        do {
            try engine.start()
            #if os(macOS)
            try outputEngine.start()
            #endif
        } catch {
            throw Failure.engine(error.localizedDescription)
        }

        started = true
        player.play()
        self.engine = engine
        self.playbackEngine = outputEngine
        self.player = player
        self.playbackFormat = playback
        // Read from the node rather than from what was requested: asking for the
        // unit and getting it are different facts, and only the second one makes
        // automatic barge-in safe.
        resolvedEchoCancellation = Self.echoCancellation(of: input)
    }

    /// The input node's format now, with voice processing withdrawn if enabling
    /// it left the node describing nothing recordable — some aggregate devices,
    /// some drivers and some phone routes report zero channels, a zero sample
    /// rate or NaN once the voice processor attaches, and a call without echo
    /// cancellation beats no call at all.
    ///
    /// The cheap half of the fallback: the caller's second attempt rebuilds
    /// everything, this recovers inside the first. Either way the node is left
    /// reporting `false`, so ``echoCancellation`` stays truthful and the policy
    /// lands on manual for the call that results.
    private nonisolated static func usableInputFormat(
        of input: AVAudioInputNode
    ) -> AVAudioFormat {
        let format = input.outputFormat(forBus: 0)
        guard !RealtimeInputFormat.isUsable(
            sampleRate: format.sampleRate, channelCount: format.channelCount
        ) else { return format }
        try? input.setVoiceProcessingEnabled(false)
        return input.outputFormat(forBus: 0)
    }

    /// The node's own answer, never the request that preceded it — see
    /// ``RealtimeEchoCancellation/fromInputNode(reportsVoiceProcessing:)``, which
    /// is deliberately not given the request to look at.
    private nonisolated static func echoCancellation(
        of input: AVAudioInputNode
    ) -> RealtimeEchoCancellation {
        .fromInputNode(reportsVoiceProcessing: input.isVoiceProcessingEnabled)
    }

    /// Takes an engine apart far enough that the audio device is genuinely free.
    /// `stop()` alone is not: the tap has to come off first, or a buffer already
    /// in flight is handed to a block whose format has gone away, and the
    /// voice-processing unit has to be released afterwards, or the *device* stays
    /// configured for a session that no longer exists.
    ///
    /// The release is unconditional, because both platforms now ask for the unit
    /// and the retry ladder depends on it: an unwind that left the unit attached
    /// would hand the second attempt the very configuration the first one failed
    /// on. Always called before ``stop()`` deactivates the iOS session — reaching
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

    private func dispose() {
        if let engine {
            Self.unwind(
                captureEngine: engine,
                playbackEngine: playbackEngine ?? engine,
                player: player
            )
        }
        engine = nil
        playbackEngine = nil
        player = nil
        playbackFormat = nil
        box.reset()
    }

    /// Installs the microphone tap from a **non-isolated** context.
    ///
    /// This has to be `nonisolated`, for a crash rather than for tidiness: a
    /// closure formed inside an isolated method inherits that isolation and the
    /// compiler emits an executor check at the top of it. `AVAudioEngine` calls
    /// the tap on the realtime audio thread, so that check runs
    /// `dispatch_assert_queue` off the expected executor and traps —
    /// `EXC_BREAKPOINT` the instant a session goes live. The same trap took out
    /// dictation in `JunoSpeechService` and voice in
    /// `JunoRealtimeVoiceController`, and is fixed the same way in all three.
    private nonisolated static func installTap(
        on input: AVAudioInputNode,
        format: AVAudioFormat,
        box: CaptureShuttle
    ) {
        input.installTap(onBus: 0, bufferSize: 2048, format: format) { buffer, _ in
            box.process(buffer)
        }
    }
}

// MARK: - Audio-thread shared state

/// What the realtime audio thread and the endpoint's actor share.
///
/// A lock rather than an actor, and `@unchecked Sendable` with a specific reason
/// rather than a shrug: a tap block cannot `await`, and it runs under a realtime
/// deadline. Everything the block touches is behind this one lock, and the
/// non-Sendable AVFAudio objects it holds (`AVAudioConverter`, `AVAudioFormat`)
/// never leave it.
private final class CaptureShuttle: @unchecked Sendable {
    private let lock = NSLock()
    private var converter: AVAudioConverter?
    private var uplinkFormat: AVAudioFormat?
    private var continuations: [UUID: AsyncStream<RealtimeCaptureFrame>.Continuation] = [:]
    private var storedMuted = false
    private var storedSuppressed = false

    var muted: Bool {
        get { lock.lock(); defer { lock.unlock() }; return storedMuted }
        set { lock.lock(); defer { lock.unlock() }; storedMuted = newValue }
    }

    var suppressed: Bool {
        get { lock.lock(); defer { lock.unlock() }; return storedSuppressed }
        set { lock.lock(); defer { lock.unlock() }; storedSuppressed = newValue }
    }

    func configure(converter: AVAudioConverter, uplinkFormat: AVAudioFormat) {
        lock.lock(); defer { lock.unlock() }
        self.converter = converter
        self.uplinkFormat = uplinkFormat
    }

    func makeStream() -> AsyncStream<RealtimeCaptureFrame> {
        // `.bufferingNewest(8)` rather than unbounded: a consumer that stalls on
        // a slow socket must drop old microphone frames, not accumulate a
        // conversation's worth of audio in memory to send later. Audio nobody
        // shipped in time is audio nobody wants.
        AsyncStream(bufferingPolicy: .bufferingNewest(8)) { continuation in
            let id = UUID()
            lock.lock()
            continuations[id] = continuation
            lock.unlock()
            continuation.onTermination = { [weak self] _ in
                guard let self else { return }
                self.lock.lock()
                self.continuations[id] = nil
                self.lock.unlock()
            }
        }
    }

    func finish() {
        lock.lock()
        let live = continuations.values
        continuations = [:]
        lock.unlock()
        for continuation in live { continuation.finish() }
    }

    func reset() {
        lock.lock(); defer { lock.unlock() }
        converter = nil
        uplinkFormat = nil
        storedSuppressed = false
    }

    /// The whole uplink, on the audio thread: meter, downsample to PCM16 mono
    /// 16 kHz, yield one frame.
    ///
    /// **The level is measured even when nothing is uploaded.** It is what tells
    /// someone their microphone is muted rather than broken, and it is the only
    /// thing still listening while the model holds the floor — which is what
    /// makes automatic barge-in possible at all.
    func process(_ buffer: AVAudioPCMBuffer) {
        var loudness: Double = 0
        if let channel = buffer.floatChannelData?.pointee, buffer.frameLength > 0 {
            var sum: Float = 0
            for index in 0..<Int(buffer.frameLength) {
                let sample = channel[index]
                sum += sample * sample
            }
            loudness = RealtimeLoudness.normalized(
                Double((sum / Float(buffer.frameLength)).squareRoot())
            )
        }

        let pcm16 = (muted || suppressed) ? nil : encode(buffer)
        // Absent, not empty: nil says "nothing was uploaded", and a zero-length
        // `Data` would say "a slice of silence was". See ``RealtimeCaptureFrame``.
        yield(RealtimeCaptureFrame(pcm16: pcm16, loudness: loudness))
    }

    private func yield(_ frame: RealtimeCaptureFrame) {
        lock.lock()
        let live = Array(continuations.values)
        lock.unlock()
        for continuation in live { continuation.yield(frame) }
    }

    private func encode(_ buffer: AVAudioPCMBuffer) -> Data? {
        // One acquisition for both values: taking the lock per field would let a
        // teardown land between them and hand this block a converter that no
        // longer matches the format it is writing to.
        lock.lock()
        let converter = self.converter
        let uplinkFormat = self.uplinkFormat
        lock.unlock()
        guard let converter, let uplinkFormat else { return nil }

        // A tap buffer can arrive describing a format with a zero sample rate —
        // that is what an input device reports as it is pulled out from under a
        // live session (AirPods disconnecting, a USB interface unplugged).
        // Dividing by it gives `+inf`, and `AVAudioFrameCount(_:)` traps on
        // inf/NaN rather than saturating. On the realtime audio thread that is an
        // immediate crash; one dropped buffer during a route change is not even
        // audible.
        guard buffer.format.sampleRate > 0, buffer.frameLength > 0 else { return nil }
        let ratio = uplinkFormat.sampleRate / buffer.format.sampleRate
        // The +16 is slack: the resampler can emit a frame or two more than the
        // ratio predicts, and an exactly-sized buffer turns that into an error
        // return and a silent gap in the uplink. Clamped as well as guarded,
        // because a pathological format pair could scale past `UInt32.max`.
        let projected = (Double(buffer.frameLength) * ratio).rounded(.up)
        let capacity = AVAudioFrameCount(
            min(max(projected, 1), uplinkFormat.sampleRate)
        ) + 16
        guard let out = AVAudioPCMBuffer(pcmFormat: uplinkFormat, frameCapacity: capacity) else {
            return nil
        }

        let input = ConversionSource(buffer: buffer)
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
        else { return nil }
        return Data(bytes: samples[0], count: Int(out.frameLength) * MemoryLayout<Int16>.size)
    }
}

/// The single input buffer handed to one `AVAudioConverter.convert` call, plus
/// the flag that makes it a once-only supply.
///
/// `@unchecked Sendable` for a narrow, stated reason:
/// `AVAudioConverterInputBlock` is *typed* `@Sendable` but is invoked
/// **synchronously**, on the calling thread, before `convert` returns. One
/// instance is created per tap callback, is reachable only from that one call,
/// and is dead before the next line runs — so no two threads can ever see it.
private final class ConversionSource: @unchecked Sendable {
    let buffer: AVAudioPCMBuffer
    var consumed = false

    init(buffer: AVAudioPCMBuffer) {
        self.buffer = buffer
    }
}
#endif

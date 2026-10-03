import Foundation

/// The two sounds of a voice call: a soft rising fifth when the call can hear
/// you, the same pair falling when it ends.
///
/// The twin of `src/lib/voice-cues.ts`, number for number, so a call sounds
/// the same on the web, the Mac and the phone. The rules, which matter more
/// than the notes:
///
/// - **Ready plays on `session.ready`**, when the microphone is already
///   streaming — never on the button press. A chime that fires before the call
///   can hear you is a promise the call then breaks.
/// - **Ended plays once when a call that was live stops**, whoever stopped it:
///   End, the relay, an error. A call that never came up is silent at both
///   ends; a reconnect or a provider switch is the same call and makes no sound.
/// - **The uplink sends nothing while the ready cue plays** (see
///   ``JunoRealtimeVoiceController``), so the chime can never become a turn.
///
/// Synthesised rather than bundled: a sine with a little triangle for body,
/// through a gentle low-pass, peaking near -18 dBFS so it sits under speech.
public enum JunoVoiceCues {
    public enum Kind: String, Sendable, CaseIterable {
        case start
        case end
    }

    public struct Note: Sendable, Equatable {
        public let frequency: Double
        public let at: Double
        public let duration: Double
        public let peakDB: Double
    }

    public struct Spec: Sendable, Equatable {
        public let notes: [Note]
        public let attack: Double
        public let release: Double
        public let decayDB: Double
        public let triangleMix: Double
        public let lowpassHz: Double

        public var duration: Double { notes.map { $0.at + $0.duration }.max() ?? 0 }
    }

    /// The "Voice sounds" switch, per device. Absent means on.
    public static let defaultsKey = "alevr.voice.sounds"

    public static var enabled: Bool {
        UserDefaults.standard.object(forKey: defaultsKey) as? Bool ?? true
    }

    /// Silence on the uplink after the ready cue starts, beyond the cue itself.
    public static let micGatePad: Double = 0.12

    private static let a4 = 440.0
    private static let e5 = 659.25

    public static func spec(_ kind: Kind) -> Spec {
        switch kind {
        case .start:
            Spec(
                notes: [
                    Note(frequency: a4, at: 0, duration: 0.12, peakDB: -18),
                    Note(frequency: e5, at: 0.09, duration: 0.17, peakDB: -19.5),
                ],
                attack: 0.008, release: 0.04, decayDB: 14, triangleMix: 0.22, lowpassHz: 2800
            )
        case .end:
            Spec(
                notes: [
                    Note(frequency: e5, at: 0, duration: 0.12, peakDB: -19.5),
                    Note(frequency: a4, at: 0.1, duration: 0.18, peakDB: -21),
                ],
                attack: 0.01, release: 0.05, decayDB: 14, triangleMix: 0.22, lowpassHz: 2600
            )
        }
    }

    static func gain(_ db: Double) -> Double { pow(10, db / 20) }

    /// Raised-cosine attack, exponential decay, raised-cosine release to zero.
    public static func envelope(_ spec: Spec, _ note: Note, at t: Double) -> Double {
        guard t >= 0, t < note.duration else { return 0 }
        let peak = gain(note.peakDB)
        if t < spec.attack { return peak * 0.5 * (1 - cos(.pi * t / spec.attack)) }
        let releaseStart = note.duration - spec.release
        let span = max(1e-6, releaseStart - spec.attack)
        let decayed = peak * gain(-spec.decayDB * min(t - spec.attack, span) / span)
        if t < releaseStart { return decayed }
        return decayed * 0.5 * (1 + cos(.pi * (t - releaseStart) / spec.release))
    }

    private static func triangle(_ phase: Double) -> Double {
        let x = phase / (2 * .pi) + 0.25
        return 4 * abs(x - (x + 0.5).rounded(.down)) - 1
    }

    /// The cue as mono samples. Pure and deterministic.
    public static func render(_ kind: Kind, sampleRate: Double) -> [Float] {
        let spec = spec(kind)
        let length = Int((spec.duration * sampleRate).rounded(.up))
        var out = [Double](repeating: 0, count: length)
        let mixNorm = 1 / (1 + spec.triangleMix)
        for note in spec.notes {
            let from = Int((note.at * sampleRate).rounded())
            let to = min(length, from + Int((note.duration * sampleRate).rounded(.up)))
            let w = 2 * Double.pi * note.frequency
            guard from < to else { continue }
            for i in from..<to {
                let t = Double(i - from) / sampleRate
                let phase = w * t
                let wave = (sin(phase) + spec.triangleMix * triangle(phase)) * mixNorm
                out[i] += wave * envelope(spec, note, at: t)
            }
        }
        let a = exp(-2 * Double.pi * spec.lowpassHz / sampleRate)
        var y = 0.0
        for i in 0..<length {
            y = (1 - a) * out[i] + a * y
            out[i] = y
        }
        return out.map { Float($0) }
    }

    /// 16-bit PCM WAV, for players that take a file or data.
    public static func wav(_ kind: Kind, sampleRate: Int = 44_100) -> Data {
        let samples = render(kind, sampleRate: Double(sampleRate))
        var data = Data()
        func put<T: FixedWidthInteger>(_ value: T) {
            withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) }
        }
        let bytes = samples.count * 2
        data.append(contentsOf: Array("RIFF".utf8)); put(UInt32(36 + bytes))
        data.append(contentsOf: Array("WAVE".utf8))
        data.append(contentsOf: Array("fmt ".utf8)); put(UInt32(16)); put(UInt16(1)); put(UInt16(1))
        put(UInt32(sampleRate)); put(UInt32(sampleRate * 2)); put(UInt16(2)); put(UInt16(16))
        data.append(contentsOf: Array("data".utf8)); put(UInt32(bytes))
        for sample in samples {
            put(Int16(max(-32767, min(32767, (Double(sample) * 32767).rounded()))))
        }
        return data
    }

    /// One bracket per call. `observe` is idempotent, so every place a phase
    /// changes may report it and each cue still plays once.
    public struct Scheduler: Sendable {
        public private(set) var open = false

        public init() {}

        /// The cue to play for this phase, if any. Whether to actually play it
        /// (the switch) is the caller's, read at that moment.
        public mutating func observe(_ phase: JunoRealtimeVoiceController.Phase) -> Kind? {
            switch phase {
            case .live:
                guard !open else { return nil }
                open = true
                return .start
            case .idle, .ended, .error:
                guard open else { return nil }
                open = false
                return .end
            case .connecting, .reconnecting:
                return nil
            }
        }
    }
}

#if canImport(AVFoundation)
@preconcurrency import AVFoundation
#if os(iOS)
import AudioToolbox
#endif

/// Plays a cue without touching the call's audio graph.
///
/// **iPhone: as a system sound**, which is the one playback path that honours
/// the Ring/Silent switch — a call's `.playAndRecord` session overrides it for
/// everything else. The controller lets system sounds through while the
/// microphone records (`setAllowHapticsAndSystemSoundsDuringRecording`), and
/// the ended cue plays after the session has already been released.
///
/// **Mac: an `AVAudioPlayer`** on the default output, beside the call's own
/// playback engine rather than inside it.
@MainActor
final class JunoVoiceCuePlayer {
    #if os(iOS)
    private var sounds: [JunoVoiceCues.Kind: SystemSoundID] = [:]
    #else
    private var players: [AVAudioPlayer] = []
    #endif

    /// Seconds of sound started, 0 when nothing played.
    @discardableResult
    func play(_ kind: JunoVoiceCues.Kind) -> Double {
        #if os(iOS)
        guard let id = soundID(kind) else { return 0 }
        AudioServicesPlaySystemSound(id)
        return JunoVoiceCues.spec(kind).duration
        #else
        guard let player = try? AVAudioPlayer(data: JunoVoiceCues.wav(kind)) else { return 0 }
        players.removeAll { !$0.isPlaying }
        players.append(player)
        player.play()
        return JunoVoiceCues.spec(kind).duration
        #endif
    }

    #if os(iOS)
    private func soundID(_ kind: JunoVoiceCues.Kind) -> SystemSoundID? {
        if let id = sounds[kind] { return id }
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("alevr-voice-\(kind.rawValue).wav")
        do {
            try JunoVoiceCues.wav(kind).write(to: url, options: .atomic)
        } catch {
            return nil
        }
        var id: SystemSoundID = 0
        guard AudioServicesCreateSystemSoundID(url as CFURL, &id) == kAudioServicesNoError else { return nil }
        sounds[kind] = id
        return id
    }
    #endif
}
#endif

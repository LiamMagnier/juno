import Foundation
import JunoDesignSystem

/// How a voice sounds right now, as the glow draws it: overall loudness plus
/// three coarse bands, each 0…1 on the same decibel window as
/// ``RealtimeLoudness``.
///
/// The bands are what make the light *articulate* rather than merely louder
/// and quieter: vowels sit in the lows and mids, so the centre of the glow
/// swells on them; sibilants and plosives are almost all highs, so an "s" or a
/// "t" flicks the outer lobes. That is the difference between a light that
/// follows a voice and one that follows a volume knob.
public struct JunoVoiceSpectrum: Equatable, Sendable {
    public var level: Double
    public var low: Double
    public var mid: Double
    public var high: Double

    public init(level: Double = 0, low: Double = 0, mid: Double = 0, high: Double = 0) {
        self.level = level
        self.low = low
        self.mid = mid
        self.high = high
    }

    public static let silent = JunoVoiceSpectrum()

    /// Linear RMS per band → the 0…1 decibel window. The upper bands carry far
    /// less energy than the lows in speech, so they are lifted before mapping
    /// (about +2 dB mids, +9 dB highs) or a sibilant would never register.
    static func normalized(rms: Double, low: Double, mid: Double, high: Double) -> JunoVoiceSpectrum {
        JunoVoiceSpectrum(
            level: RealtimeLoudness.normalized(rms),
            low: RealtimeLoudness.normalized(low),
            mid: RealtimeLoudness.normalized(mid * 1.25),
            high: RealtimeLoudness.normalized(high * 2.8)
        )
    }
}

/// Splits samples into low / mid / high energy with two one-pole filters: no
/// FFT, one multiply-add per filter per sample, cheap enough for the realtime
/// thread. Lows are below ~400 Hz (voicing, the fundamental), highs above
/// ~2.5 kHz (sibilance, frication), mids the formants in between.
///
/// Stateful so a window boundary never clicks the filters back to zero.
public struct JunoVoiceBandSplitter: Sendable {
    public static let lowCutoff: Double = 400
    public static let highCutoff: Double = 2_500

    private let lowCoefficient: Float
    private let highCoefficient: Float
    private var lowState: Float = 0
    private var highState: Float = 0

    public init(sampleRate: Double) {
        let rate = max(1, sampleRate)
        lowCoefficient = Float(exp(-2 * Double.pi * Self.lowCutoff / rate))
        highCoefficient = Float(exp(-2 * Double.pi * Self.highCutoff / rate))
    }

    /// Measures one window. `sample(i)` supplies the i-th mono sample, so the
    /// callers can feed interleaved PCM16, planar float or a stereo mixdown
    /// without copying.
    public mutating func measure(count: Int, sample: (Int) -> Float) -> JunoVoiceSpectrum {
        guard count > 0 else { return .silent }
        var total: Float = 0
        var lowEnergy: Float = 0
        var midEnergy: Float = 0
        var highEnergy: Float = 0
        var lowState = self.lowState
        var highState = self.highState
        let lowA = lowCoefficient
        let highA = highCoefficient
        for index in 0..<count {
            let x = sample(index)
            lowState = (1 - lowA) * x + lowA * lowState
            highState = (1 - highA) * x + highA * highState
            let high = x - highState
            let mid = highState - lowState
            total += x * x
            lowEnergy += lowState * lowState
            midEnergy += mid * mid
            highEnergy += high * high
        }
        self.lowState = lowState.isFinite ? lowState : 0
        self.highState = highState.isFinite ? highState : 0
        let n = Float(count)
        return JunoVoiceSpectrum.normalized(
            rms: Double((total / n).squareRoot()),
            low: Double((lowEnergy / n).squareRoot()),
            mid: Double((midEnergy / n).squareRoot()),
            high: Double((highEnergy / n).squareRoot())
        )
    }

    public mutating func reset() {
        lowState = 0
        highState = 0
    }
}

/// Juno's voice, measured when it is *decoded* but read back when it is
/// *heard*.
///
/// The relay streams speech faster than real time, so a level taken as each
/// chunk arrives runs ahead of the speaker by however much is queued, often a
/// second or more: the light peaks on a word Juno has not said yet and goes
/// dark while it is still talking. This keeps the measurement (one pass over
/// samples already being decoded, so no second tap on the output) but files
/// every short window under the player-timeline sample it will play at. The
/// meter then asks for the window at the playhead.
///
/// Positions are in the player node's own timeline (`playerTime.sampleTime`),
/// which starts at zero on `play()` and keeps running through silence. A
/// buffer scheduled with no time plays as soon as the queue ahead of it
/// drains, so its start is `max(playhead, end of what is queued)` — the same
/// cursor the web keeps for its `AudioBufferSourceNode`s.
public struct JunoVoicePlaybackEnvelope: Sendable {
    public struct Window: Equatable, Sendable {
        public var start: Int64
        public var end: Int64
        public var spectrum: JunoVoiceSpectrum
    }

    /// 20 ms at 24 kHz: short enough to resolve a syllable, long enough that
    /// the lowest band settles inside it.
    public static let windowFrames = 480

    public private(set) var windows: [Window] = []
    /// Where the last queued buffer ends, in player samples.
    public private(set) var cursor: Int64 = 0
    private var splitter: JunoVoiceBandSplitter

    public init(sampleRate: Double) {
        splitter = JunoVoiceBandSplitter(sampleRate: sampleRate)
    }

    /// Files one decoded buffer. `playhead` is the player's current sample
    /// (nil before the first render, when the timeline has not started).
    /// Returns the sample the buffer will start at.
    @discardableResult
    public mutating func append(
        frames: Int,
        playhead: Int64?,
        sample: (Int) -> Float
    ) -> Int64 {
        guard frames > 0 else { return cursor }
        let start = max(playhead ?? 0, cursor)
        var offset = 0
        while offset < frames {
            let count = min(Self.windowFrames, frames - offset)
            let base = offset
            let spectrum = splitter.measure(count: count) { sample(base + $0) }
            windows.append(Window(
                start: start + Int64(offset),
                end: start + Int64(offset + count),
                spectrum: spectrum
            ))
            offset += count
        }
        cursor = start + Int64(frames)
        return start
    }

    /// The window playing at `position`, discarding everything already heard.
    /// Silent when the playhead is in a gap or past the end of the queue.
    public mutating func spectrum(at position: Int64) -> JunoVoiceSpectrum {
        var drop = 0
        while drop < windows.count, windows[drop].end <= position { drop += 1 }
        if drop > 0 { windows.removeFirst(drop) }
        guard let first = windows.first, first.start <= position else { return .silent }
        return first.spectrum
    }

    /// Anything still queued at or after `position`: the speaker has not
    /// finished this answer yet.
    public func hasAudio(after position: Int64) -> Bool {
        windows.contains { $0.end > position }
    }

    /// An interruption or a rebuilt graph: the player's timeline restarts at
    /// zero, so the cursor has to as well.
    public mutating func clear() {
        windows.removeAll(keepingCapacity: true)
        cursor = 0
        splitter.reset()
    }
}

extension JunoRealtimeVoiceController {
    /// The live bands, shaped for ``JunoVoiceGlow``'s `bands` input.
    public var glowBands: JunoVoiceGlowBands {
        JunoVoiceGlowBands(low: spectrum.low, mid: spectrum.mid, high: spectrum.high)
    }
}

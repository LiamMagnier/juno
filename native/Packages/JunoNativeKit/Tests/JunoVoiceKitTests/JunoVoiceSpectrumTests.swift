import XCTest
@testable import JunoVoiceKit

/// The glow follows what is *heard*, split into bands that move independently.
final class JunoVoiceSpectrumTests: XCTestCase {

    private func sine(_ frequency: Double, amplitude: Float = 0.3, rate: Double = 24_000) -> (Int) -> Float {
        { index in amplitude * Float(sin(2 * Double.pi * frequency * Double(index) / rate)) }
    }

    // MARK: Bands

    /// A vowel-like tone lights the lows, not the highs.
    func testLowToneLightsTheLowBand() {
        var splitter = JunoVoiceBandSplitter(sampleRate: 24_000)
        let spectrum = splitter.measure(count: 4_800, sample: sine(150))
        XCTAssertGreaterThan(spectrum.low, 0.5)
        XCTAssertGreaterThan(spectrum.low, spectrum.high + 0.2)
    }

    /// A sibilant-like tone lights the highs, not the lows.
    func testHighToneLightsTheHighBand() {
        var splitter = JunoVoiceBandSplitter(sampleRate: 24_000)
        let spectrum = splitter.measure(count: 4_800, sample: sine(6_000))
        XCTAssertGreaterThan(spectrum.high, 0.5)
        XCTAssertGreaterThan(spectrum.high, spectrum.low + 0.2)
    }

    func testSilenceIsSilent() {
        var splitter = JunoVoiceBandSplitter(sampleRate: 48_000)
        XCTAssertEqual(splitter.measure(count: 1_024) { _ in 0 }, .silent)
        XCTAssertEqual(splitter.measure(count: 0) { _ in 1 }, .silent)
    }

    // MARK: Playhead envelope

    /// The bug this exists for: audio that arrives a second early must not
    /// light the glow until the playhead reaches it.
    func testSpeechQueuedAheadIsSilentUntilItPlays() {
        var envelope = JunoVoicePlaybackEnvelope(sampleRate: 24_000)
        // Half a second of silence already queued, then half a second of voice.
        envelope.append(frames: 12_000, playhead: 0) { _ in 0 }
        envelope.append(frames: 12_000, playhead: 100, sample: sine(200))

        XCTAssertEqual(envelope.spectrum(at: 6_000), .silent, "still playing the silence")
        XCTAssertGreaterThan(envelope.spectrum(at: 18_000).level, 0.5, "the voice, when it is heard")
        XCTAssertTrue(envelope.hasAudio(after: 18_000))
        XCTAssertEqual(envelope.spectrum(at: 30_000), .silent, "past the end of the queue")
        XCTAssertFalse(envelope.hasAudio(after: 30_000))
    }

    /// A buffer arriving after the queue ran dry starts at the playhead, not
    /// at the stale end of the previous answer.
    func testBufferAfterAGapStartsAtThePlayhead() {
        var envelope = JunoVoicePlaybackEnvelope(sampleRate: 24_000)
        envelope.append(frames: 2_400, playhead: 0, sample: sine(200))
        let start = envelope.append(frames: 2_400, playhead: 50_000, sample: sine(200))
        XCTAssertEqual(start, 50_000)
        XCTAssertEqual(envelope.cursor, 52_400)
    }

    /// Back-to-back buffers queue end to end.
    func testBuffersQueueEndToEnd() {
        var envelope = JunoVoicePlaybackEnvelope(sampleRate: 24_000)
        envelope.append(frames: 2_400, playhead: 10, sample: sine(200))
        let second = envelope.append(frames: 2_400, playhead: 20, sample: sine(200))
        XCTAssertEqual(second, 2_410)
    }

    /// Reading forward discards what has been heard, so the queue never grows
    /// through a long answer.
    func testReadingDiscardsHeardWindows() {
        var envelope = JunoVoicePlaybackEnvelope(sampleRate: 24_000)
        envelope.append(frames: 24_000, playhead: 0, sample: sine(200))
        XCTAssertEqual(envelope.windows.count, 50)
        _ = envelope.spectrum(at: 12_000)
        XCTAssertEqual(envelope.windows.count, 25)
    }

    /// An interruption restarts the player's timeline at zero.
    func testClearRestartsTheTimeline() {
        var envelope = JunoVoicePlaybackEnvelope(sampleRate: 24_000)
        envelope.append(frames: 24_000, playhead: 0, sample: sine(200))
        envelope.clear()
        XCTAssertEqual(envelope.cursor, 0)
        XCTAssertFalse(envelope.hasAudio(after: 0))
        XCTAssertEqual(envelope.append(frames: 480, playhead: 0, sample: sine(200)), 0)
    }

    // MARK: Smoothing

    func testBandsRiseFastAndFallSlower() {
        let loud = JunoVoiceSpectrum(level: 1, low: 1, mid: 1, high: 1)
        let up = JunoRealtimeVoiceController.smoothed(.silent, toward: loud)
        let down = JunoRealtimeVoiceController.smoothed(loud, toward: .silent)
        XCTAssertGreaterThan(up.low, 0.6, "a syllable lands within a tick or two")
        XCTAssertGreaterThan(down.low, 0.6, "and falls away over a few")
    }
}

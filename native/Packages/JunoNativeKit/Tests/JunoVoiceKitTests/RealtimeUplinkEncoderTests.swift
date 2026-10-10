#if canImport(AVFoundation)
import AVFoundation
import XCTest
@testable import JunoVoiceKit

/// The uplink must carry the microphone whatever layout the input node hands
/// over. The iPhone call that never reached the model dropped every buffer
/// that was not Float32; these pin each layout to a non-silent PCM16 stream.
final class RealtimeUplinkEncoderTests: XCTestCase {
    private func tone(
        format: AVAudioFormat, seconds: Double = 0.1, amplitude: Double = 0.5
    ) -> AVAudioPCMBuffer {
        let frames = AVAudioFrameCount(format.sampleRate * seconds)
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames)!
        buffer.frameLength = frames
        let channels = Int(format.channelCount)
        for index in 0..<Int(frames) {
            let value = amplitude * sin(2 * .pi * 440 * Double(index) / format.sampleRate)
            for channel in 0..<channels {
                let slot = format.isInterleaved ? (index * channels + channel, 0) : (index, channel)
                if let data = buffer.floatChannelData {
                    data[slot.1][slot.0] = Float(value)
                } else if let data = buffer.int16ChannelData {
                    data[slot.1][slot.0] = Int16(value * 32_767)
                } else if let data = buffer.int32ChannelData {
                    data[slot.1][slot.0] = Int32(value * 2_147_483_647)
                }
            }
        }
        return buffer
    }

    /// Runs `chunks` buffers through one encoder (a resampler primes, so the
    /// first call may be short) and returns everything it produced.
    private func encode(_ format: AVAudioFormat, chunks: Int = 5) -> [Int16] {
        let encoder = RealtimeUplinkEncoder()
        var data = Data()
        for _ in 0..<chunks {
            if let chunk = encoder.encode(tone(format: format)) { data.append(chunk) }
        }
        return data.withUnsafeBytes { Array($0.bindMemory(to: Int16.self)) }
    }

    private func assertCarriesTheTone(_ samples: [Int16], chunks: Int = 5, file: StaticString = #filePath, line: UInt = #line) {
        let expected = Int(RealtimeUplinkEncoder.sampleRate * 0.1) * chunks
        XCTAssertGreaterThan(samples.count, expected * 8 / 10, "too few frames", file: file, line: line)
        XCTAssertLessThanOrEqual(samples.count, expected + 64, "too many frames", file: file, line: line)
        let peak = samples.map { abs(Int($0)) }.max() ?? 0
        XCTAssertGreaterThan(peak, 8_000, "the tone was lost", file: file, line: line)
    }

    func testFloat32MonoAt48kBecomesPCM16At16k() {
        let format = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!
        assertCarriesTheTone(encode(format))
    }

    /// The voice-processing unit's layout on some phones: Int16, interleaved.
    /// Before the fix this was dropped without a frame.
    func testInt16InterleavedIsNotDropped() {
        let format = AVAudioFormat(
            commonFormat: .pcmFormatInt16, sampleRate: 48_000, channels: 1, interleaved: true
        )!
        assertCarriesTheTone(encode(format))
    }

    func testInt32DeinterleavedIsNotDropped() {
        let format = AVAudioFormat(
            commonFormat: .pcmFormatInt32, sampleRate: 24_000, channels: 1, interleaved: false
        )!
        assertCarriesTheTone(encode(format))
    }

    func testStereoAt44kIsMixedToMono() {
        let format = AVAudioFormat(standardFormatWithSampleRate: 44_100, channels: 2)!
        assertCarriesTheTone(encode(format))
    }

    func testAFormatChangeMidCallRebuildsTheConverter() {
        let encoder = RealtimeUplinkEncoder()
        let first = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!
        let second = AVAudioFormat(
            commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true
        )!
        var produced = 0
        for _ in 0..<3 { produced += encoder.encode(tone(format: first))?.count ?? 0 }
        var after = 0
        for _ in 0..<3 { after += encoder.encode(tone(format: second))?.count ?? 0 }
        XCTAssertGreaterThan(produced, 0)
        XCTAssertGreaterThan(after, 0)
    }

    func testTheMeterReadsEveryLayout() throws {
        for format in [
            AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!,
            AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 48_000, channels: 2, interleaved: true)!,
            AVAudioFormat(commonFormat: .pcmFormatInt32, sampleRate: 48_000, channels: 1, interleaved: false)!,
        ] {
            let buffer = tone(format: format)
            let read = try XCTUnwrap(RealtimeUplinkEncoder.monoSamples(of: buffer))
            let peak = (0..<Int(buffer.frameLength)).map { abs(read($0)) }.max() ?? 0
            XCTAssertEqual(peak, 0.5, accuracy: 0.02, "\(format)")
        }
    }

    func testAnEmptyBufferSendsNothing() {
        let format = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 64)!
        buffer.frameLength = 0
        XCTAssertNil(RealtimeUplinkEncoder().encode(buffer))
    }
}
#endif

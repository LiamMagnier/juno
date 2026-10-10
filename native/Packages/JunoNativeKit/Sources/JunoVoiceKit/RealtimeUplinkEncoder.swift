#if canImport(AVFoundation)
@preconcurrency import AVFoundation
import Foundation

/// One microphone buffer, in whatever format the input node hands over, made
/// into the relay's uplink: PCM16 little-endian, mono, 16 kHz.
///
/// **Why this exists: the iPhone call that never reached the model.** The tap
/// used to read `floatChannelData` and return early when it was nil, so a
/// buffer in any other layout (Int16 or Int32 samples, which the
/// voice-processing unit can hand over on a phone) was dropped without a
/// word: the meter sat at zero, nothing went up the socket, and the model had
/// nothing to answer. Every layout now goes through `AVAudioConverter`, which
/// also does the resampling and the downmix properly instead of a hand-rolled
/// box filter.
///
/// Used only from the tap block, which `AVAudioEngine` calls serially, so it
/// needs no lock of its own. A format change mid-call (a route change hands
/// the tap a different rate) rebuilds the converter on the next buffer.
final class RealtimeUplinkEncoder: @unchecked Sendable {
    static let sampleRate: Double = 16_000

    static let targetFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16, sampleRate: sampleRate, channels: 1, interleaved: true
    )!

    private var converter: AVAudioConverter?
    private var sourceFormat: AVAudioFormat?

    init() {}

    /// The buffer as PCM16 mono 16 kHz, or nil when there is nothing to send
    /// (an empty buffer, a format no converter can read, or a converter still
    /// priming).
    func encode(_ buffer: AVAudioPCMBuffer) -> Data? {
        let frames = buffer.frameLength
        guard frames > 0, buffer.format.sampleRate > 0, buffer.format.channelCount > 0 else {
            return nil
        }
        if converter == nil || sourceFormat != buffer.format {
            converter = AVAudioConverter(from: buffer.format, to: Self.targetFormat)
            converter?.downmix = true
            sourceFormat = buffer.format
        }
        guard let converter else { return nil }

        let ratio = Self.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount((Double(frames) * ratio).rounded(.up)) + 64
        guard let output = AVAudioPCMBuffer(pcmFormat: Self.targetFormat, frameCapacity: capacity) else {
            return nil
        }
        let input = ConversionInput(buffer: buffer)
        var failure: NSError?
        let status = converter.convert(to: output, error: &failure) { _, outStatus in
            if input.consumed {
                outStatus.pointee = .noDataNow
                return nil
            }
            input.consumed = true
            outStatus.pointee = .haveData
            return input.buffer
        }
        guard status != .error, failure == nil, output.frameLength > 0,
            let samples = output.int16ChannelData
        else { return nil }
        return Data(bytes: samples[0], count: Int(output.frameLength) * MemoryLayout<Int16>.size)
    }

    /// A reader for the buffer's samples as Float in -1...1, mixed to mono,
    /// whatever the layout: the meter needs this for every format the encoder
    /// accepts, or a call that sends audio would still show a dead microphone.
    static func monoSamples(of buffer: AVAudioPCMBuffer) -> ((Int) -> Float)? {
        let channels = Int(buffer.format.channelCount)
        guard channels > 0 else { return nil }
        let interleaved = buffer.format.isInterleaved
        func mix(_ read: @escaping (Int, Int) -> Float) -> (Int) -> Float {
            if channels == 1 { return { read(0, $0) } }
            let scale = 1 / Float(channels)
            return { index in
                var sum: Float = 0
                for channel in 0..<channels { sum += read(channel, index) }
                return sum * scale
            }
        }
        if let data = buffer.floatChannelData {
            return interleaved
                ? mix { channel, index in data[0][index * channels + channel] }
                : mix { channel, index in data[channel][index] }
        }
        if let data = buffer.int16ChannelData {
            return interleaved
                ? mix { channel, index in Float(data[0][index * channels + channel]) / 32_768 }
                : mix { channel, index in Float(data[channel][index]) / 32_768 }
        }
        if let data = buffer.int32ChannelData {
            return interleaved
                ? mix { channel, index in Float(data[0][index * channels + channel]) / 2_147_483_648 }
                : mix { channel, index in Float(data[channel][index]) / 2_147_483_648 }
        }
        return nil
    }
}

/// The single input buffer handed to one `AVAudioConverter.convert` call, plus
/// the flag that makes it a once-only supply.
///
/// `@unchecked Sendable`, and the reason is specific: the converter's input
/// block is *typed* `@Sendable` but is invoked **synchronously**, on the
/// calling thread, before `convert(to:error:withInputFrom:)` returns. One
/// instance is created per call and is dead before the next line runs.
final class ConversionInput: @unchecked Sendable {
    let buffer: AVAudioPCMBuffer
    var consumed = false

    init(buffer: AVAudioPCMBuffer) {
        self.buffer = buffer
    }
}
#endif

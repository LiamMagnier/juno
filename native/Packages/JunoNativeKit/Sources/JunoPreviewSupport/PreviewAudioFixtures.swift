#if DEBUG
import Foundation

/// The bytes behind the preview's generated track: a real WAV, made at
/// launch, so the transcript's audio card runs the same decode and playback
/// path a Lyria file from the server does.
///
/// Twelve seconds of a soft three-note arpeggio (A minor, 8 kHz mono, 16-bit)
/// with a gentle envelope on each note: small enough to make instantly, and
/// pleasant if someone does press Play.
public enum PreviewAudioFixtures {
    public static let sampleRate = 8_000
    public static let seconds = 12

    private static let lock = NSLock()
    private nonisolated(unsafe) static var cached: Data?

    public static var wav: Data {
        lock.lock()
        defer { lock.unlock() }
        if let cached { return cached }
        let data = make()
        cached = data
        return data
    }

    private static func make() -> Data {
        let count = sampleRate * seconds
        let notes: [Double] = [220.0, 261.63, 329.63, 261.63]
        let noteLength = sampleRate / 2
        var samples = [Int16](repeating: 0, count: count)
        for index in 0..<count {
            let note = notes[(index / noteLength) % notes.count]
            let position = Double(index % noteLength) / Double(noteLength)
            let envelope = min(1, position * 20) * pow(1 - position, 1.6)
            let t = Double(index) / Double(sampleRate)
            let tone = sin(2 * .pi * note * t) * 0.6 + sin(2 * .pi * note * 2 * t) * 0.15
            samples[index] = Int16(max(-1, min(1, tone * envelope * 0.5)) * Double(Int16.max))
        }
        var data = Data()
        func append<T: FixedWidthInteger>(_ value: T) {
            withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) }
        }
        let byteCount = count * 2
        data.append(contentsOf: Array("RIFF".utf8))
        append(UInt32(36 + byteCount))
        data.append(contentsOf: Array("WAVEfmt ".utf8))
        append(UInt32(16))
        append(UInt16(1))
        append(UInt16(1))
        append(UInt32(sampleRate))
        append(UInt32(sampleRate * 2))
        append(UInt16(2))
        append(UInt16(16))
        data.append(contentsOf: Array("data".utf8))
        append(UInt32(byteCount))
        for sample in samples { append(sample) }
        return data
    }
}
#endif

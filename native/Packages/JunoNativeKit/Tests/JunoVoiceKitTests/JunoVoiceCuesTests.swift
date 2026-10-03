import XCTest
@testable import JunoVoiceKit

/// The native twin of tests/voice-cues.test.ts: the same bracket, the same
/// numbers, so a call sounds the same on every surface.
final class JunoVoiceCuesTests: XCTestCase {
    private func run(_ phases: [JunoRealtimeVoiceController.Phase]) -> [JunoVoiceCues.Kind] {
        var bracket = JunoVoiceCues.Scheduler()
        return phases.compactMap { bracket.observe($0) }
    }

    func testReadyPlaysOnceWhenLiveNotOnConnect() {
        XCTAssertEqual(run([.idle, .connecting]), [])
        XCTAssertEqual(run([.connecting, .live, .live]), [.start])
    }

    func testEndedPlaysOnceHoweverTheCallEnds() {
        XCTAssertEqual(run([.connecting, .live, .ended(.client), .ended(.client), .idle]), [.start, .end])
        XCTAssertEqual(run([.connecting, .live, .error(.notConfigured), .ended(.client)]), [.start, .end])
    }

    func testACallThatNeverCameUpIsSilent() {
        XCTAssertEqual(run([.connecting, .error(.notConfigured), .idle]), [])
    }

    func testReconnectIsTheSameCall() {
        XCTAssertEqual(run([.connecting, .live, .reconnecting, .live, .ended(.client)]), [.start, .end])
    }

    func testRetryIsANewBracket() {
        XCTAssertEqual(
            run([.connecting, .live, .ended(.client), .connecting, .live, .ended(.client)]),
            [.start, .end, .start, .end]
        )
    }

    func testRenderMatchesTheWebSpec() {
        let rate = 48_000.0
        for kind in JunoVoiceCues.Kind.allCases {
            let samples = JunoVoiceCues.render(kind, sampleRate: rate)
            let spec = JunoVoiceCues.spec(kind)
            XCTAssertEqual(samples.count, Int((spec.duration * rate).rounded(.up)))
            let peak = samples.map { abs(Double($0)) }.max() ?? 0
            let peakDB = 20 * log10(peak)
            XCTAssertLessThanOrEqual(peakDB, -17, "\(kind)")
            XCTAssertGreaterThanOrEqual(peakDB, -21, "\(kind)")
            XCTAssertLessThan(abs(samples.first ?? 1), 1e-3)
            XCTAssertLessThan(abs(samples.last ?? 1), 1e-3)
            for note in spec.notes {
                XCTAssertEqual(JunoVoiceCues.envelope(spec, note, at: 0), 0)
                XCTAssertEqual(JunoVoiceCues.envelope(spec, note, at: spec.attack), pow(10, note.peakDB / 20), accuracy: 1e-9)
            }
        }
        XCTAssertLessThan(JunoVoiceCues.spec(.start).notes[0].frequency, JunoVoiceCues.spec(.start).notes[1].frequency)
        XCTAssertGreaterThan(JunoVoiceCues.spec(.end).notes[0].frequency, JunoVoiceCues.spec(.end).notes[1].frequency)
    }

    func testWavHeader() {
        let data = JunoVoiceCues.wav(.start, sampleRate: 44_100)
        XCTAssertEqual(String(decoding: data.prefix(4), as: UTF8.self), "RIFF")
        XCTAssertEqual(data.count, 44 + JunoVoiceCues.render(.start, sampleRate: 44_100).count * 2)
    }
}

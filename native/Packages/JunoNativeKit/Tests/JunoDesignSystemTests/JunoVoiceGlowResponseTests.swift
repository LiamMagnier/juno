import Foundation
import XCTest
@testable import JunoDesignSystem

final class JunoVoiceGlowResponseTests: XCTestCase {
    func testComposerGlowFollowsSyllablesAndSettlesInSpeechGaps() {
        let engine = JunoVoiceGlowEngine()
        let start = Date(timeIntervalSince1970: 0)
        _ = engine.step(to: start, level: 0, processing: false, still: false, palette: .warmLight)
        _ = engine.step(to: start.addingTimeInterval(0.1), level: 1, processing: false, still: false, palette: .warmLight)
        XCTAssertGreaterThan(engine.level, 0.8)
        _ = engine.step(to: start.addingTimeInterval(0.2), level: 0, processing: false, still: false, palette: .warmLight)
        XCTAssertLessThan(engine.level, 0.5)
        _ = engine.step(to: start.addingTimeInterval(0.3), level: 0, processing: false, still: false, palette: .warmLight)
        XCTAssertLessThan(engine.level, 0.3)
    }

    func testReducedMotionChangesIntensityWithoutTravel() {
        let engine = JunoVoiceGlowEngine()
        let start = Date(timeIntervalSince1970: 0)
        let quiet = engine.step(to: start, level: 0, processing: false, still: true, palette: .warmLight)
        let spoken = engine.step(to: start.addingTimeInterval(0.1), level: 1, processing: false, still: true, palette: .warmLight)
        XCTAssertEqual(spoken.flow, quiet.flow)
        XCTAssertEqual(spoken.clock, quiet.clock)
        XCTAssertGreaterThan(engine.level, 0.8)
    }
}

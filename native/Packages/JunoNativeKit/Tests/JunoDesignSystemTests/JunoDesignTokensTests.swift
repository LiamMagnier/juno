import XCTest
@testable import JunoDesignSystem

final class JunoDesignTokensTests: XCTestCase {
    func testColorTokensRejectOutOfRangeComponents() {
        XCTAssertThrowsError(try JunoColorToken(red: 1.1, green: 0, blue: 0)) {
            XCTAssertEqual($0 as? JunoColorTokenError, .componentOutOfRange)
        }
    }

    func testReducedMotionRemovesAnimationDuration() {
        let preferences = JunoAccessibilityPreferences(reduceMotion: true)
        XCTAssertEqual(preferences.animationDuration(0.3), 0)
    }

    func testReducedTransparencyUsesOpaqueTransientSurfaces() {
        let preferences = JunoAccessibilityPreferences(reduceTransparency: true)
        XCTAssertTrue(preferences.usesOpaqueTransientSurfaces)
    }
}

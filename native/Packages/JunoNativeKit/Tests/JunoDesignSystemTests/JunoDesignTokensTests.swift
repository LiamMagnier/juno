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

    func testPaletteTokensAreWithinRange() {
        let tokens: [JunoColorToken] = [
            .accentLight, .accentDark, .canvasLight, .canvasDark,
            .surfaceLight, .surfaceDark, .hairlineLight, .hairlineDark,
        ]
        for token in tokens {
            for component in [token.red, token.green, token.blue, token.opacity] {
                XCTAssertTrue((0...1).contains(component))
            }
        }
    }

    func testLightAndDarkSurfacesDiffer() {
        XCTAssertNotEqual(JunoColorToken.canvasLight, JunoColorToken.canvasDark)
        XCTAssertNotEqual(JunoColorToken.surfaceLight, JunoColorToken.surfaceDark)
        XCTAssertNotEqual(JunoColorToken.accentLight, JunoColorToken.accentDark)
    }

    func testHairlinesAreTranslucent() {
        XCTAssertLessThan(JunoColorToken.hairlineLight.opacity, 1)
        XCTAssertLessThan(JunoColorToken.hairlineDark.opacity, 1)
    }
}

import SwiftUI
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
    }

    /// The accent is the one token that must *not* differ. `--primary` is
    /// `15 54% 46%` in both `:root` and `.dark` in `src/app/globals.css`; the
    /// native palette used to brighten it in dark mode, which drifted the brand.
    func testAccentIsTheSameCoralInBothAppearances() {
        XCTAssertEqual(JunoColorToken.accentLight, JunoColorToken.accentDark)
        XCTAssertEqual(JunoColorToken.accentLight, JunoColorToken.coral)
    }

    /// Juno's neutrals are warm in both appearances — red is the highest channel
    /// and blue the lowest. A neutral or blue-leaning grey is the single most
    /// visible way the native app stops looking like Juno.
    ///
    /// The list is deliberately exhaustive over the neutral ramp, including the
    /// light surfaces. It used to cover five tokens, and every one it skipped is
    /// where the drift accumulated: `JunoSurfaces` had grown a second, *cool*
    /// dark ground (blue highest) sitting beside `warmBlack`, and three
    /// separate pure whites, none of which this test could see.
    func testBrandNeutralsAreWarmInBothAppearances() {
        let tokens: [JunoColorToken] = [
            .canvasLight, .canvasDark,
            .surfaceLight, .surfaceDark,
            .popoverLight, .popoverDark,
            .mutedLight, .mutedDark,
            .mutedForegroundLight, .mutedForegroundDark,
            .foregroundLight, .foregroundDark,
            .sidebarLight, .sidebarDark,
            .sidebarSelectionLight, .sidebarSelectionDark,
            .sidebarForegroundLight, .sidebarForegroundDark,
            // Added after `terminalDark` shipped cool (blue highest) through the
            // pass that fixed exactly that bug elsewhere. A hand-enumerated list
            // only guards what someone remembered to add, so any NEW neutral
            // surface token belongs here on the day it is written.
            .terminalLight, .terminalDark,
        ]
        for token in tokens {
            XCTAssertGreaterThan(token.red, token.blue, "expected a warm neutral")
            XCTAssertGreaterThanOrEqual(token.green, token.blue)
        }
    }

    /// The desktop shell's canvas and the phone's are the same ground.
    ///
    /// `junoCanvasWarm` and `junoRaised` were once independently authored
    /// surfaces in `JunoSurfaces.swift`; they are now aliases. Asserting the
    /// identity is what stops someone re-forking them the next time the desktop
    /// wants a slightly different cream.
    func testWarmCanvasAndRaisedAliasTheSharedGround() {
        XCTAssertEqual(Color.junoCanvasWarm, Color.junoCanvas)
        XCTAssertEqual(Color.junoRaised, Color.junoSurface)
    }

    func testDarkCanvasIsDarkerThanEverySurfaceAboveIt() {
        // Elevation must read as lighter in dark mode, or cards vanish.
        XCTAssertLessThan(JunoColorToken.canvasDark.red, JunoColorToken.surfaceDark.red)
        XCTAssertLessThan(JunoColorToken.surfaceDark.red, JunoColorToken.popoverDark.red)
    }

    func testSpacingAndRadiiScalesAreMonotonic() {
        let spacing = [
            JunoSpacing.compact, JunoSpacing.small, JunoSpacing.control,
            JunoSpacing.content, JunoSpacing.comfortable, JunoSpacing.section, JunoSpacing.page,
        ]
        XCTAssertEqual(spacing, spacing.sorted())
        XCTAssertLessThan(JunoCornerRadius.compactControl, JunoCornerRadius.control)
        XCTAssertLessThan(JunoCornerRadius.control, JunoCornerRadius.row)
        XCTAssertLessThan(JunoCornerRadius.card, JunoCornerRadius.composer)
    }

    func testHairlinesAreTranslucent() {
        XCTAssertLessThan(JunoColorToken.hairlineLight.opacity, 1)
        XCTAssertLessThan(JunoColorToken.hairlineDark.opacity, 1)
    }
}

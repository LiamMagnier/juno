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

    /// The surviving scales are ordered.
    ///
    /// This used to walk `JunoSpacing` and `JunoCornerRadius`, which is why it
    /// never noticed that a *second* scale existed carrying different numbers
    /// under the same role names — a monotonicity check passes just as happily
    /// on two contradictory ladders as on one.
    func testTheSurvivingScalesAreMonotonic() {
        let spacing = [
            JunoSpace.hairline, JunoSpace.tight, JunoSpace.snug, JunoSpace.cozy,
            JunoSpace.regular, JunoSpace.roomy, JunoSpace.section, JunoSpace.region,
        ]
        XCTAssertEqual(spacing, spacing.sorted())

        let radii = [
            JunoRadius.control, JunoRadius.row, JunoRadius.panel, JunoRadius.card,
            JunoRadius.message, JunoRadius.floating, JunoRadius.composer,
        ]
        XCTAssertEqual(radii, radii.sorted())
    }

    /// The deprecated scales resolve onto the surviving ones.
    ///
    /// The point of this test is not the values, it is that there is exactly one
    /// source for them. A future author who "restores" a number to
    /// `JunoCornerRadius` — the natural response to noticing a corner got 2pt
    /// tighter — recreates the two-scales-one-name defect, and this is what
    /// stops that landing silently.
    ///
    /// Marked deprecated itself so that exercising the deprecated members does
    /// not fill the build log with the warnings the deprecation exists to
    /// produce everywhere else.
    @available(*, deprecated)
    func testTheSupersededScalesAliasTheSurvivingOnes() {
        XCTAssertEqual(JunoSpacing.compact, JunoSpace.tight)
        XCTAssertEqual(JunoSpacing.small, JunoSpace.snug)
        XCTAssertEqual(JunoSpacing.control, JunoSpace.cozy)
        XCTAssertEqual(JunoSpacing.content, JunoSpace.regular)
        XCTAssertEqual(JunoSpacing.comfortable, JunoSpace.roomy)
        XCTAssertEqual(JunoSpacing.section, JunoSpace.section)
        XCTAssertEqual(JunoSpacing.page, JunoSpace.region)
        XCTAssertEqual(JunoSpacing.spacious, JunoSpace.region)

        XCTAssertEqual(JunoCornerRadius.compactControl, JunoRadius.row)
        XCTAssertEqual(JunoCornerRadius.control, JunoRadius.row)
        XCTAssertEqual(JunoCornerRadius.row, JunoRadius.panel)
        XCTAssertEqual(JunoCornerRadius.panel, JunoRadius.card)
        XCTAssertEqual(JunoCornerRadius.card, JunoRadius.card)
        XCTAssertEqual(JunoCornerRadius.message, JunoRadius.message)
        XCTAssertEqual(JunoCornerRadius.floating, JunoRadius.floating)
        XCTAssertEqual(JunoCornerRadius.composer, JunoRadius.composer)
    }

    // MARK: - Motion

    /// The ladder's rungs are ordered, and the named animations are built from
    /// them rather than from literals that drifted alongside.
    func testTheMotionLadderIsOrdered() {
        let ladder = [
            JunoMotion.Duration.press, JunoMotion.Duration.fast,
            JunoMotion.Duration.exit, JunoMotion.Duration.base,
            JunoMotion.Duration.slow,
        ]
        XCTAssertEqual(ladder, ladder.sorted())
        // The web's own numbers: press 70 / fast 120 / exit 160 / base 220 /
        // slow 360. Pinned because a rung that drifts by 20ms is invisible in
        // review and is exactly the near-miss the ladder exists to prevent.
        XCTAssertEqual(ladder, [0.07, 0.12, 0.16, 0.22, 0.36])
    }

    /// Reduce Motion is answered per tier, not by one flat rule.
    ///
    /// The three outcomes are the whole of the tiering: travel collapses to a
    /// cross-fade, colour survives intact, and an ambient loop stops. The last
    /// one is the reason `reduced` returns an `Animation?` at all.
    func testReduceMotionIsTieredByWhatTheAnimationDoes() {
        let ambient = JunoMotion.standard

        XCTAssertNil(JunoMotion.reduced(ambient, when: true, tier: .ambient))
        XCTAssertNil(JunoMotion.ambient(ambient, when: true))
        XCTAssertEqual(JunoMotion.ambient(ambient, when: false), ambient)

        XCTAssertEqual(JunoMotion.reduced(ambient, when: true, tier: .tint), ambient)
        XCTAssertEqual(JunoMotion.reduced(ambient, when: false, tier: .tint), ambient)

        // Travel is the default tier, and it neither passes the animation
        // through nor drops it: it substitutes the flat cross-fade.
        let travelled = JunoMotion.reduced(ambient, when: true)
        XCTAssertNotNil(travelled)
        XCTAssertNotEqual(travelled, ambient)
        XCTAssertEqual(travelled, .easeOut(duration: JunoMotion.Duration.exit))
        XCTAssertEqual(JunoMotion.reduced(ambient, when: false), ambient)
    }

    func testHairlinesAreTranslucent() {
        XCTAssertLessThan(JunoColorToken.hairlineLight.opacity, 1)
        XCTAssertLessThan(JunoColorToken.hairlineDark.opacity, 1)
    }
}

import SwiftUI
import XCTest
@testable import JunoDesignSystem

final class JunoDesignTokensTests: XCTestCase {
    /// Every `JunoMotion.Duration` rung is the web rung it claims to be.
    ///
    /// The exact counterpart of ``testRadiusScaleMatchesTheWebLadder()``, and
    /// the axis that was missing it. Radius and colour were genuinely
    /// drift-proof; motion only looked it. `JunoGeneratedDuration` was
    /// projected from the `--dur-*` properties, verified by
    /// `design:tokens:check`, and had **zero consumers anywhere in the tree**,
    /// while `JunoMotion.Duration` re-declared the same five numbers as
    /// independent literals and the suite pinned only those literals. Retuning
    /// `--dur-base` to 200ms on the web would have left Swift at 0.22 and left
    /// every check green — a silent, permanent divergence in the one token
    /// axis a reader feels rather than sees.
    ///
    /// Both halves are asserted for the reason the radius test states: the
    /// token reference catches a Swift-side literal creeping back in, and the
    /// number catches a web-side retune nobody meant to ship to the Mac.
    func testMotionLadderMatchesTheWebDurations() {
        XCTAssertEqual(JunoMotion.Duration.press, JunoGeneratedDuration.press)
        XCTAssertEqual(JunoMotion.Duration.press, 0.07)

        XCTAssertEqual(JunoMotion.Duration.fast, JunoGeneratedDuration.fast)
        XCTAssertEqual(JunoMotion.Duration.fast, 0.12)

        XCTAssertEqual(JunoMotion.Duration.exit, JunoGeneratedDuration.exit)
        XCTAssertEqual(JunoMotion.Duration.exit, 0.16)

        XCTAssertEqual(JunoMotion.Duration.base, JunoGeneratedDuration.base)
        XCTAssertEqual(JunoMotion.Duration.base, 0.22)

        XCTAssertEqual(JunoMotion.Duration.slow, JunoGeneratedDuration.slow)
        XCTAssertEqual(JunoMotion.Duration.slow, 0.36)

        // The rung the hand-copied enum never carried. `--dur-emphasis` has
        // been in the stylesheet and in the projection since the ladder was
        // written; Swift simply could not reach it.
        XCTAssertEqual(JunoMotion.Duration.emphasis, JunoGeneratedDuration.emphasis)
        XCTAssertEqual(JunoMotion.Duration.emphasis, 0.56)
    }

    /// The ladder is strictly increasing, with no two rungs close enough to
    /// read as one intention executed inconsistently.
    ///
    /// `JunoMotion.Duration`'s own doc records the audit that motivated it: 35
    /// inline curve constructors carrying 21 distinct durations, where the harm
    /// was not the outliers but 0.15 sitting beside `fast` 0.12 and 0.2 beside
    /// `base` 0.22. This asserts the property that audit was really about, so a
    /// future rung cannot be added into one of those near-miss gaps.
    func testMotionLadderRungsAreDistinguishable() {
        let ladder: [TimeInterval] = [
            JunoMotion.Duration.press,
            JunoMotion.Duration.fast,
            JunoMotion.Duration.exit,
            JunoMotion.Duration.base,
            JunoMotion.Duration.slow,
            JunoMotion.Duration.emphasis,
        ]
        XCTAssertEqual(ladder, ladder.sorted(), "The ladder must read fastest-first.")
        for (faster, slower) in zip(ladder, ladder.dropFirst()) {
            XCTAssertGreaterThanOrEqual(
                slower / faster,
                1.3,
                """
                \(faster)s and \(slower)s are within 30% of each other. Two rungs \
                that close cannot be told apart in use, so call sites pick between \
                them arbitrarily — which is the drift this ladder exists to stop.
                """
            )
        }
    }

    /// Every `JunoRadius` rung is the web rung it claims to be.
    ///
    /// `JunoGeneratedRadius` is projected from tailwind.config.ts and guarded by
    /// `npm run design:tokens:check`, so pinning to it here closes the loop:
    /// the config cannot drift from the projection, and the app cannot drift
    /// from the projection either. Re-hardcoding any of these as a literal
    /// fails right here.
    ///
    /// Written as explicit numbers as well as token references on purpose. The
    /// numbers catch a web-side retune that nobody intended to reach the Mac;
    /// the token references catch a Swift-side literal. Either alone would miss
    /// half the drift this is for.
    func testRadiusScaleMatchesTheWebLadder() {
        XCTAssertEqual(JunoRadius.chip, JunoGeneratedRadius.xs)
        XCTAssertEqual(JunoRadius.chip, 6)

        XCTAssertEqual(JunoRadius.row, JunoGeneratedRadius.md)
        XCTAssertEqual(JunoRadius.row, 8)

        XCTAssertEqual(JunoRadius.well, JunoGeneratedRadius.field)
        XCTAssertEqual(JunoRadius.well, 12)

        XCTAssertEqual(JunoRadius.card, JunoGeneratedRadius.card)
        XCTAssertEqual(JunoRadius.card, 16)

        XCTAssertEqual(JunoRadius.message, JunoGeneratedRadius.popover)
        XCTAssertEqual(JunoRadius.floating, JunoGeneratedRadius.popover)
        XCTAssertEqual(JunoRadius.message, 16)

        // These literals track the Soft UI ladder (docs/design/SOFT_UI.md
        // §2.3): control 10 · field 12 · menu 14 · card 16 · popover 16 ·
        // panel 20 · composer 20. When the web retunes, the paired token
        // references above keep passing and only these numbers move — that
        // is this assertion doing its job, not failing at it.
        //
        // 20 by way of the web's `rounded-composer`, never by way of
        // `--radius`: the rung once hardcoded 24 while claiming composer
        // parity, and `--radius` merely happened to sit nearby. See the note
        // on JunoRadius.composer.
        XCTAssertEqual(JunoRadius.composer, JunoGeneratedRadius.composer)
        XCTAssertEqual(JunoRadius.composer, 20)
    }

    /// The redesign's radius names (§8.4 plus errata 9) are the web's own
    /// ladder names at the web's own values, so a port reads `rounded-panel`
    /// and writes `JunoRadius.panel` and gets the same corner.
    func testTheWebsRadiusNamesMeanTheWebsSizes() {
        let pairs: [(CGFloat, CGFloat, CGFloat, String)] = [
            (JunoRadius.micro, JunoGeneratedRadius.micro, 2, "micro"),
            (JunoRadius.sm, JunoGeneratedRadius.sm, 4, "sm"),
            (JunoRadius.xs, JunoGeneratedRadius.xs, 6, "xs"),
            (JunoRadius.md, JunoGeneratedRadius.md, 8, "md"),
            (JunoRadius.control, JunoGeneratedRadius.control, 10, "control"),
            (JunoRadius.field, JunoGeneratedRadius.field, 12, "field"),
            (JunoRadius.menu, JunoGeneratedRadius.menu, 14, "menu"),
            (JunoRadius.card, JunoGeneratedRadius.card, 16, "card"),
            (JunoRadius.panel, JunoGeneratedRadius.panel, 20, "panel"),
        ]
        for (value, generated, number, name) in pairs {
            XCTAssertEqual(value, generated, "\(name) must alias the generated rung")
            XCTAssertEqual(value, number, "\(name) moved on the web; check the Mac still wants it")
        }
        // Errata 9: the dashed empty-state well is a field, a toast is a card.
        XCTAssertEqual(JunoRadius.field, 12)
        XCTAssertEqual(JunoRadius.card, 16)
    }

    /// The concentric helper is a uniform concentric rectangle with a floor, the
    /// SDK's `.rect(corners: .concentric(minimum:))` — never a fixed radius.
    func testConcentricChildrenTakeTheContainersShape() {
        let rect = CGRect(x: 0, y: 0, width: 120, height: 40)
        XCTAssertEqual(
            JunoRadius.concentric().path(in: rect),
            ConcentricRectangle(corners: .concentric(minimum: .fixed(JunoRadius.control)), isUniform: true)
                .path(in: rect)
        )
        XCTAssertEqual(
            JunoRadius.concentric(minimum: JunoRadius.xs).path(in: rect),
            ConcentricRectangle(corners: .concentric(minimum: .fixed(6)), isUniform: true)
                .path(in: rect)
        )
        // With no container declared, a concentric child falls back to its
        // floor — it never draws square.
        XCTAssertNotEqual(JunoRadius.concentric().path(in: rect), Rectangle().path(in: rect))
    }

    /// The three names that used to mean different sizes on the two platforms.
    ///
    /// `control` and `panel` were renamed precisely because the web owns those
    /// words, and owned them at 10px and 28px when the Swift rungs sitting on
    /// those names meant 6px and 12px. The web has since retuned both — they
    /// are 9px and 18px now — which is exactly why this is written as an
    /// inequality against the generated token rather than against the numbers
    /// of the day: the point was never the specific gap, it was that these two
    /// words already mean something else. If either name is ever reclaimed
    /// here, this says why it must not be.
    func testRenamedRungsDoNotReclaimTheWebsMeaning() {
        XCTAssertNotEqual(JunoRadius.chip, JunoGeneratedRadius.control, "web `control` is 9, this rung is 6")
        XCTAssertNotEqual(JunoRadius.well, JunoGeneratedRadius.panel, "web `panel` is 18, this rung is 10")
    }

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
            // The redesign's neutrals (§8.1).
            .secondaryLight, .secondaryDark,
            .hoverLight, .hoverDark,
            .inputLight, .inputDark,
            .selectedFillLight, .selectedFillDark,
            .selectedLight, .selectedDark,
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

    /// Elevation must read as lighter in dark mode, or cards vanish: canvas
    /// (11.5%) < card (14%) < popover (16.5%), in HSL lightness, the unit the
    /// web writes the ramp in (§8.1).
    ///
    /// Measured on the ground the Mac paints. The phone keeps its 4% ground
    /// for now (see `JunoColorToken.canvasDark`), which satisfies the same
    /// order with more room.
    func testDarkCanvasIsDarkerThanEverySurfaceAboveIt() {
        func lightness(_ token: JunoColorToken) -> Double {
            (max(token.red, token.green, token.blue) + min(token.red, token.green, token.blue)) / 2
        }
        let canvas = lightness(.canvasDark)
        let card = lightness(.surfaceDark)
        let popover = lightness(.popoverDark)
        XCTAssertLessThan(canvas, card)
        XCTAssertLessThan(card, popover)
        XCTAssertEqual(canvas, 0.115, accuracy: 0.001, "the Mac canvas is the web's warm charcoal")
        XCTAssertEqual(card, 0.14, accuracy: 0.001)
        XCTAssertEqual(popover, 0.165, accuracy: 0.001)
    }

    /// The Mac canvas is `--background` itself: #FAF9F6 / #1F1D1C. The old
    /// hand-kept `warmBlack` (4%) is gone from the Mac.
    func testTheMacCanvasIsTheGeneratedBackground() {
        XCTAssertEqual(JunoColorToken.canvasLight, JunoGeneratedColors.background.light)
        #if os(macOS)
        XCTAssertEqual(JunoColorToken.canvasDark, JunoGeneratedColors.background.dark)
        #endif
    }

    /// The surviving scales are ordered.
    ///
    /// This used to walk `JunoSpacing` and `JunoCornerRadius`, which is why it
    /// never noticed that a *second* scale existed carrying different numbers
    /// under the same role names — a monotonicity check passes just as happily
    /// on two contradictory ladders as on one.
    func testTheSurvivingScalesAreMonotonic() {
        let spacing = [
            JunoSpace.micro, JunoSpace.hairline, JunoSpace.tight, JunoSpace.snug,
            JunoSpace.close, JunoSpace.cozy, JunoSpace.comfy, JunoSpace.regular,
            JunoSpace.ample, JunoSpace.roomy, JunoSpace.section, JunoSpace.wide,
            JunoSpace.region, JunoSpace.expanse, JunoSpace.vast,
        ]
        XCTAssertEqual(spacing, spacing.sorted())

        let radii = [
            JunoRadius.micro, JunoRadius.sm, JunoRadius.xs, JunoRadius.md,
            JunoRadius.control, JunoRadius.field, JunoRadius.menu, JunoRadius.card,
            JunoRadius.panel,
        ]
        XCTAssertEqual(radii, radii.sorted())
        let roles = [
            JunoRadius.chip, JunoRadius.row, JunoRadius.well, JunoRadius.card,
            JunoRadius.message, JunoRadius.floating, JunoRadius.composer,
        ]
        XCTAssertEqual(roles, roles.sorted())
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
        XCTAssertEqual(JunoCornerRadius.row, JunoRadius.well)
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
        // through nor drops it: the spring becomes `--ease-out-soft` at
        // `--dur-base`, as the web's reduced-motion block re-points it.
        let travelled = JunoMotion.reduced(ambient, when: true)
        XCTAssertNotNil(travelled)
        XCTAssertNotEqual(travelled, ambient)
        XCTAssertEqual(travelled, JunoMotion.outSoft(JunoMotion.Duration.base))
        XCTAssertEqual(JunoMotion.reduced(ambient, when: false), ambient)

        // The travel itself goes to zero, and scale to identity.
        XCTAssertEqual(JunoMotion.shift(JunoMotion.riseDistance, reduceMotion: true), 0)
        XCTAssertEqual(JunoMotion.shift(JunoMotion.riseDistance, reduceMotion: false), 6)
        XCTAssertEqual(JunoMotion.scaleFrom(0.97, reduceMotion: true), 1)
        XCTAssertEqual(JunoMotion.scaleFrom(0.97, reduceMotion: false), 0.97)

        // "Prefer Cross-Fade Transitions" asks for the same substitution for
        // travel, and nothing for loops.
        let crossFade = JunoAccessibilityPreferences(prefersCrossFadeTransitions: true)
        XCTAssertTrue(crossFade.reducesTravel)
        XCTAssertFalse(crossFade.reduceMotion)
        XCTAssertFalse(JunoAccessibilityPreferences().reducesTravel)
    }

    /// The timed rungs are the web's own `transition: <dur> <ease>` pairs,
    /// built from the generated curves rather than SwiftUI's stock `.easeOut`
    /// and `.easeIn`, which are neither of the web's curves (§8.5).
    func testTheTimedRungsAreTheWebsCurves() {
        func curve(
            _ points: (x1: CGFloat, y1: CGFloat, x2: CGFloat, y2: CGFloat),
            _ duration: TimeInterval
        ) -> Animation {
            .timingCurve(points.x1, points.y1, points.x2, points.y2, duration: duration)
        }
        XCTAssertEqual(JunoMotion.press, curve(JunoGeneratedEasing.outSoft, 0.07))
        XCTAssertEqual(JunoMotion.fast, curve(JunoGeneratedEasing.outSoft, 0.12))
        XCTAssertEqual(JunoMotion.exit, curve(JunoGeneratedEasing.in, 0.16))
        XCTAssertEqual(JunoMotion.base, curve(JunoGeneratedEasing.outSoft, 0.22))
        XCTAssertEqual(JunoMotion.slow, curve(JunoGeneratedEasing.outExpo, 0.36))

        // The curves themselves, so a web retune is a decision and not a surprise.
        XCTAssertTrue(JunoGeneratedEasing.outSoft == (0.33, 1.0, 0.68, 1.0))
        XCTAssertTrue(JunoGeneratedEasing.in == (0.4, 0.0, 1.0, 1.0))
        XCTAssertTrue(JunoGeneratedEasing.outExpo == (0.16, 1.0, 0.3, 1.0))

        // `rise-in` is `animate-rise-in`: base on out-soft, over 6pt — not the
        // out-strong-over-360ms it used to be. (The phone keeps the old
        // entrance until its own pass.)
        #if os(macOS)
        XCTAssertEqual(JunoMotion.riseIn, JunoMotion.base)
        #endif
        XCTAssertEqual(JunoMotion.riseDistance, 6)
    }

    /// The springs, and the Mac's 0.75 — applied to springs only.
    func testTheSpringsAndThePlatformFactor() {
        #if os(macOS)
        XCTAssertEqual(JunoMotion.platformFactor, 0.75)
        #else
        XCTAssertEqual(JunoMotion.platformFactor, 1)
        #endif
        let factor = JunoMotion.platformFactor
        XCTAssertEqual(JunoMotion.standard, .spring(duration: 0.22 * factor, bounce: 0.05))
        XCTAssertEqual(JunoMotion.emphasized, .spring(duration: 0.36 * factor, bounce: 0.10))
        XCTAssertEqual(JunoMotion.layout, .spring(duration: 0.36 * factor, bounce: 0))
    }

    /// The live-state loops, at the web's periods.
    func testTheLoopsAreTheWebsPeriods() {
        XCTAssertEqual(JunoMotion.Loop.matrix, 1.8)
        XCTAssertEqual(JunoMotion.Loop.statusBreathe, 2.8)
        XCTAssertEqual(JunoMotion.Loop.skeletonBreathe, 1.8)
    }

    // MARK: - Spacing and layout (§8.3)

    /// The ladder is the web's 4pt grid from 2 to 48 plus its 18 step, read
    /// from the generated projection of Tailwind's scale.
    func testTheSpaceLadderIsTheWebsScale() {
        let ladder = [
            JunoSpace.micro, JunoSpace.hairline, JunoSpace.tight, JunoSpace.snug,
            JunoSpace.close, JunoSpace.cozy, JunoSpace.comfy, JunoSpace.regular,
            JunoSpace.ample, JunoSpace.roomy, JunoSpace.section, JunoSpace.wide,
            JunoSpace.region, JunoSpace.expanse, JunoSpace.vast,
        ]
        XCTAssertEqual(ladder, JunoGeneratedSpace.all)
        XCTAssertEqual(ladder, [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48])
        XCTAssertEqual(JunoSpace.turnGap, 24)
        XCTAssertEqual(JunoSpace.pageSectionGap, 32)
    }

    /// The gutter steps on the column, at the web's container-query widths.
    func testTheGutterStepsAtTheWebsColumnWidths() {
        XCTAssertEqual(JunoSpace.gutter(forWidth: 320), 16)
        XCTAssertEqual(JunoSpace.gutter(forWidth: 639.5), 16)
        XCTAssertEqual(JunoSpace.gutter(forWidth: 640), 24)
        XCTAssertEqual(JunoSpace.gutter(forWidth: 1023), 24)
        XCTAssertEqual(JunoSpace.gutter(forWidth: 1024), 32)
        XCTAssertEqual(JunoSpace.gutter(forWidth: 1800), 32)
        XCTAssertEqual(JunoReadingMeasure.reading, 768)
        XCTAssertEqual(JunoReadingMeasure.wide, 1024)
    }

    func testHairlinesAreTranslucent() {
        XCTAssertLessThan(JunoColorToken.hairlineLight.opacity, 1)
        XCTAssertLessThan(JunoColorToken.hairlineDark.opacity, 1)
    }
}

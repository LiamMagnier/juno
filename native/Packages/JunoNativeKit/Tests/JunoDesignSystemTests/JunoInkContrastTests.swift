import SwiftUI
import XCTest
@testable import JunoDesignSystem

/// WCAG contrast for the ink ramp, and the shape of the collapsed scales.
///
/// The ink ramp is the one part of the palette that cannot be checked by eye:
/// two warm greys a step apart look fine side by side and fail 4.5:1 against the
/// canvas, which is exactly how the per-message meta line shipped at 1.89:1.
/// These assertions are the reason a future retune of `--muted-foreground`
/// cannot quietly cross the floor.
final class JunoInkContrastTests: XCTestCase {

    // MARK: - WCAG 2.1 relative luminance

    private func luminance(_ token: JunoColorToken) -> Double {
        func linear(_ channel: Double) -> Double {
            channel <= 0.04045 ? channel / 12.92 : pow((channel + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * linear(token.red)
            + 0.7152 * linear(token.green)
            + 0.0722 * linear(token.blue)
    }

    private func contrast(_ ink: JunoColorToken, on ground: JunoColorToken) -> Double {
        let a = luminance(ink)
        let b = luminance(ground)
        return (max(a, b) + 0.05) / (min(a, b) + 0.05)
    }

    /// Sanity: the helper agrees with the two ends of the sRGB range.
    func testContrastHelperMatchesTheKnownBlackOnWhiteRatio() {
        let white = JunoColorToken(unchecked: 1, 1, 1)
        let black = JunoColorToken(unchecked: 0, 0, 0)
        XCTAssertEqual(contrast(black, on: white), 21, accuracy: 0.001)
        XCTAssertEqual(contrast(white, on: white), 1, accuracy: 0.001)
    }

    // MARK: - The ramp

    /// Primary ink clears AAA on every ground it is drawn on, in both
    /// appearances. `junoInk()` is what long-form reading uses, so 7:1 rather
    /// than 4.5:1 is the bar.
    func testPrimaryInkClearsAAAOnEveryGround() {
        let grounds: [(String, JunoColorToken, JunoColorToken)] = [
            ("canvas", .canvasLight, .canvasDark),
            ("surface", .surfaceLight, .surfaceDark),
            ("popover", .popoverLight, .popoverDark),
            ("muted", .mutedLight, .mutedDark),
            ("sidebar", .sidebarLight, .sidebarDark),
            ("terminal", .terminalLight, .terminalDark),
        ]
        for (name, light, dark) in grounds {
            XCTAssertGreaterThan(
                contrast(.foregroundLight, on: light), 7,
                "junoForeground on \(name) (light)"
            )
            XCTAssertGreaterThan(
                contrast(.foregroundDark, on: dark), 7,
                "junoForeground on \(name) (dark)"
            )
        }
    }

    /// Secondary ink clears AA for body text on the reading grounds.
    ///
    /// This is the token `junoSecondaryInk()` and `junoMetaInk()` both resolve
    /// to, which means it is also the floor for every caption, timestamp and
    /// provenance line in the product. It measures ~5.2:1 light and ~7.2:1 dark
    /// on the canvas — real margin, but not much, which is why nothing below it
    /// exists.
    func testSecondaryInkClearsAAOnTheReadingGrounds() {
        let grounds: [(String, JunoColorToken, JunoColorToken)] = [
            ("canvas", .canvasLight, .canvasDark),
            ("surface", .surfaceLight, .surfaceDark),
            ("popover", .popoverLight, .popoverDark),
            ("muted", .mutedLight, .mutedDark),
        ]
        for (name, light, dark) in grounds {
            XCTAssertGreaterThanOrEqual(
                contrast(.mutedForegroundLight, on: light), 4.5,
                "junoMutedForeground on \(name) (light)"
            )
            XCTAssertGreaterThanOrEqual(
                contrast(.mutedForegroundDark, on: dark), 4.5,
                "junoMutedForeground on \(name) (dark)"
            )
        }
    }

    /// The navigation column's resting ink is read at the same sizes as the rest
    /// of the app's labels, so it answers to the same floor.
    func testSidebarInkClearsAAOnTheColumn() {
        XCTAssertGreaterThanOrEqual(
            contrast(.sidebarForegroundLight, on: .sidebarLight), 4.5
        )
        XCTAssertGreaterThanOrEqual(
            contrast(.sidebarForegroundDark, on: .sidebarDark), 4.5
        )
        // And on the selected row, which is a different fill again.
        XCTAssertGreaterThanOrEqual(
            contrast(.foregroundLight, on: .sidebarSelectionLight), 4.5
        )
        XCTAssertGreaterThanOrEqual(
            contrast(.foregroundDark, on: .sidebarSelectionDark), 4.5
        )
    }

    /// The ramp has to be ordered as well as legible: secondary must be *quieter*
    /// than primary, or the hierarchy inverts and the two modifiers are
    /// interchangeable in a way that hides mistakes.
    func testSecondaryInkIsQuieterThanPrimaryOnTheCanvas() {
        XCTAssertLessThan(
            contrast(.mutedForegroundLight, on: .canvasLight),
            contrast(.foregroundLight, on: .canvasLight)
        )
        XCTAssertLessThan(
            contrast(.mutedForegroundDark, on: .canvasDark),
            contrast(.foregroundDark, on: .canvasDark)
        )
    }

    /// The tertiary ink is the web's `text-muted-foreground/70`, composited
    /// over the ground it sits on — and it is **not** AA text. This pins the
    /// number the accessibility rule is written against (errata: 2.87:1 on the
    /// V3 light canvas; 2.89:1 on the warm one before it), so the rule "only non-essential text of 13pt and up;
    /// keycaps and timers take the secondary ink" is checked against the colour
    /// it describes rather than against a number someone once measured.
    func testTertiaryInkContrastIsTheDocumentedFloor() {
        func composite(_ ink: JunoColorToken, over ground: JunoColorToken) -> JunoColorToken {
            let a = ink.opacity
            return JunoColorToken(
                unchecked: ink.red * a + ground.red * (1 - a),
                ink.green * a + ground.green * (1 - a),
                ink.blue * a + ground.blue * (1 - a)
            )
        }
        let light = contrast(composite(.tertiaryInkLight, over: .canvasLight), on: .canvasLight)
        XCTAssertEqual(light, 2.87, accuracy: 0.01)
        XCTAssertLessThan(light, 4.5, "tertiary ink is not body text; the doc comment says so")

        #if os(macOS)
        // On the Mac's charcoal it measures 3.61:1 (4.25:1 on the warm
        // charcoal before V3) — under AA, so the same rule holds in both
        // appearances.
        let dark = contrast(composite(.tertiaryInkDark, over: .canvasDark), on: .canvasDark)
        XCTAssertEqual(dark, 3.61, accuracy: 0.02)
        XCTAssertLessThan(dark, 4.5)
        #endif

        // And it is quieter than the secondary ink it is derived from.
        XCTAssertLessThan(light, contrast(.mutedForegroundLight, on: .canvasLight))
    }

    /// The redesign's status inks and the accent ink are the web's AA text
    /// ramps; they are read as text, so they answer to the text floor.
    func testTheGeneratedInksClearAAOnTheCanvas() {
        let inks: [(String, JunoColorToken, JunoColorToken)] = [
            ("success-ink", .successInkLight, .successInkDark),
            ("warning-ink", .warningInkLight, .warningInkDark),
            ("destructive-ink", .destructiveInkLight, .destructiveInkDark),
            ("sidebar ink", .sidebarForegroundLight, .sidebarForegroundDark),
        ]
        for (name, light, dark) in inks {
            XCTAssertGreaterThanOrEqual(
                contrast(light, on: .canvasLight), 4.5, "\(name) on canvas (light)"
            )
            XCTAssertGreaterThanOrEqual(
                contrast(dark, on: .canvasDark), 4.5, "\(name) on canvas (dark)"
            )
        }
        let coralInk = JunoAccent.coral.generatedPalette.ink
        XCTAssertGreaterThanOrEqual(contrast(coralInk.light, on: .canvasLight), 4.5)
        XCTAssertGreaterThanOrEqual(contrast(coralInk.dark, on: .canvasDark), 4.5)
    }

    /// The focus ring is a graphical object: 3:1 against the canvas it
    /// outlines, in both appearances.
    func testTheRingClearsTheNonTextFloor() {
        let ring = JunoAccent.coral.generatedPalette.ring
        XCTAssertGreaterThanOrEqual(contrast(ring.light, on: .canvasLight), 3)
        XCTAssertGreaterThanOrEqual(contrast(ring.dark, on: .canvasDark), 3)
    }

    /// The status ramp is read as text — "3 failed", stderr, a denial — so it
    /// answers to the text floor and not to the 3:1 one for graphical objects.
    func testStatusInkClearsAAOnTheReadingGrounds() {
        let ramp: [(String, JunoColorToken, JunoColorToken)] = [
            ("success", .successLight, .successDark),
            ("danger", .dangerLight, .dangerDark),
            ("caution", .cautionLight, .cautionDark),
            ("source", .sourceLight, .sourceDark),
        ]
        for (name, light, dark) in ramp {
            XCTAssertGreaterThanOrEqual(
                contrast(light, on: .canvasLight), 4.5, "\(name) on canvas (light)"
            )
            XCTAssertGreaterThanOrEqual(
                contrast(dark, on: .canvasDark), 4.5, "\(name) on canvas (dark)"
            )
        }
    }
}

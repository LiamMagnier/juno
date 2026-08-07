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

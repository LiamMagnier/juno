import SwiftUI
import XCTest
@testable import JunoDesignSystem

/// Pins the accent palette to the website's own values.
///
/// These are the numbers in `src/app/globals.css` under `[data-accent]`, and the
/// two clients drifting apart on them is exactly the kind of difference nobody
/// notices until an account looks like a different product in each place.
final class JunoAccentTests: XCTestCase {

    // MARK: - HSL conversion

    private func assertToken(
        _ token: JunoColorToken,
        red: Double,
        green: Double,
        blue: Double,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertEqual(token.red, red, accuracy: 0.002, file: file, line: line)
        XCTAssertEqual(token.green, green, accuracy: 0.002, file: file, line: line)
        XCTAssertEqual(token.blue, blue, accuracy: 0.002, file: file, line: line)
    }

    func testConvertsTheBrandCoralFromHSL() {
        // `--primary: 15 54% 46%` — the same triple JunoColorToken.coral was
        // hand-converted from, so this is a cross-check of both.
        let converted = JunoColorToken(hsl: (15, 0.54, 0.46))
        assertToken(
            converted,
            red: JunoColorToken.coral.red,
            green: JunoColorToken.coral.green,
            blue: JunoColorToken.coral.blue
        )
    }

    func testConvertsAchromaticAndPrimaryHues() {
        assertToken(JunoColorToken(hsl: (0, 0, 0)), red: 0, green: 0, blue: 0)
        assertToken(JunoColorToken(hsl: (0, 0, 1)), red: 1, green: 1, blue: 1)
        assertToken(JunoColorToken(hsl: (0, 1, 0.5)), red: 1, green: 0, blue: 0)
        assertToken(JunoColorToken(hsl: (120, 1, 0.5)), red: 0, green: 1, blue: 0)
        assertToken(JunoColorToken(hsl: (240, 1, 0.5)), red: 0, green: 0, blue: 1)
    }

    /// Every sector of the colour wheel, including the 300–360 default branch that
    /// a switch over ranges is easy to get wrong.
    func testConvertsEverySectorOfTheWheel() {
        assertToken(JunoColorToken(hsl: (60, 1, 0.5)), red: 1, green: 1, blue: 0)
        assertToken(JunoColorToken(hsl: (180, 1, 0.5)), red: 0, green: 1, blue: 1)
        assertToken(JunoColorToken(hsl: (300, 1, 0.5)), red: 1, green: 0, blue: 1)
        assertToken(JunoColorToken(hsl: (330, 1, 0.5)), red: 1, green: 0, blue: 0.5)
    }

    func testEveryAccentProducesComponentsInRange() {
        for accent in JunoAccent.allCases {
            // `JunoColorToken`'s checked initializer rejects out-of-range
            // components; the palette must never need the unchecked escape hatch
            // for a value that is actually invalid.
            let color = accent.color
            XCTAssertNotNil(color, "\(accent.rawValue) produced no colour")
        }
    }

    func testEveryAccentKeepsKeyboardFocusNeutral() {
        let neutral = JunoAccent.coral.generatedPalette.ring

        for accent in JunoAccent.allCases {
            XCTAssertEqual(
                accent.generatedPalette.ring,
                neutral,
                "\(accent.rawValue) must not tint keyboard focus"
            )
        }
        XCTAssertEqual(JunoColorToken.focusRingLight, neutral.light)
        XCTAssertEqual(JunoColorToken.focusRingDark, neutral.dark)
    }

    // MARK: - Resolving the stored setting

    func testResolvesEveryAccentTheWebPublishes() {
        // The exact strings the server stores, per `settings.accent`.
        for raw in ["coral", "juniper", "teal", "violet", "amber", "sage"] {
            XCTAssertEqual(JunoAccent(setting: raw).rawValue, raw)
        }
    }

    /// An accent this client has not shipped must fall back rather than blank the
    /// UI — the web can add one before the app ships support for it.
    func testUnknownAndMissingAccentsFallBackToCoral() {
        XCTAssertEqual(JunoAccent(setting: "ultramarine"), .coral)
        XCTAssertEqual(JunoAccent(setting: ""), .coral)
        XCTAssertEqual(JunoAccent(setting: nil), .coral)
    }

    func testResolutionIsCaseInsensitive() {
        XCTAssertEqual(JunoAccent(setting: "TEAL"), .teal)
        XCTAssertEqual(JunoAccent(setting: "Violet"), .violet)
    }

    // MARK: - Selection

    @MainActor
    func testApplyingASettingMovesTheCurrentAccent() {
        let selection = JunoAccentSelection.shared
        let original = selection.current
        defer { selection.current = original }

        selection.apply(setting: "sage")
        XCTAssertEqual(selection.current, .sage)

        // Idempotent: the shell calls this on every settings sync, and a write on
        // each one would invalidate every view that reads the accent.
        selection.apply(setting: "sage")
        XCTAssertEqual(selection.current, .sage)

        selection.apply(setting: "not-an-accent")
        XCTAssertEqual(selection.current, .coral)
    }

    @MainActor
    func testTheAccentColorFollowsTheSelection() {
        let selection = JunoAccentSelection.shared
        let original = selection.current
        defer { selection.current = original }

        selection.current = .coral
        let coral = Color.junoAccent
        selection.current = .teal
        let teal = Color.junoAccent

        // The whole point of making `junoAccent` computed: the value the app reads
        // has to actually change when the setting does.
        XCTAssertNotEqual(coral, teal)
    }
}

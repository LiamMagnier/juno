import SwiftUI
import XCTest
@testable import JunoDesignSystem

/// Every colour the redesign names (§8.1) resolves to its generated counterpart.
///
/// `design:tokens:check` proves the *projection* matches `globals.css`. It
/// cannot prove anything reads the projection: `JunoGeneratedDuration` was
/// generated, checked and consumed by nothing for a whole release while the
/// motion ladder carried its own literals. This closes that loop for colour by
/// resolving each `Color` the way a view does — through an environment, in
/// each appearance — and comparing what comes out with the generated pair it
/// claims to be. A hand-typed triple creeping back into `JunoColors.swift`
/// fails here even if it is only a rounding step off.
@MainActor
final class JunoColorConsumptionTests: XCTestCase {

    private func resolved(_ color: Color, dark: Bool) -> Color.Resolved {
        var environment = EnvironmentValues()
        environment.colorScheme = dark ? .dark : .light
        return color.resolve(in: environment)
    }

    private func assertResolves(
        _ color: Color,
        to pair: JunoGeneratedPair,
        _ name: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        for (dark, token) in [(false, pair.light), (true, pair.dark)] {
            let r = resolved(color, dark: dark)
            let appearance = dark ? "dark" : "light"
            XCTAssertEqual(Double(r.red), token.red, accuracy: 0.001, "\(name) red (\(appearance))", file: file, line: line)
            XCTAssertEqual(Double(r.green), token.green, accuracy: 0.001, "\(name) green (\(appearance))", file: file, line: line)
            XCTAssertEqual(Double(r.blue), token.blue, accuracy: 0.001, "\(name) blue (\(appearance))", file: file, line: line)
            XCTAssertEqual(Double(r.opacity), token.opacity, accuracy: 0.001, "\(name) opacity (\(appearance))", file: file, line: line)
        }
    }

    private func pair(_ light: JunoColorToken, _ dark: JunoColorToken) -> JunoGeneratedPair {
        JunoGeneratedPair(light: light, dark: dark)
    }

    func testTheGroundsAreTheWebsGrounds() {
        #if os(macOS)
        // The phone keeps its shipped 4% ground; the Mac is the web's charcoal.
        assertResolves(.junoCanvas, to: JunoGeneratedColors.background, "junoCanvas")
        assertResolves(.junoBorder, to: JunoGeneratedColors.border, "junoBorder")
        #endif
        assertResolves(.junoCard, to: JunoGeneratedColors.card, "junoCard")
        assertResolves(.junoSecondary, to: JunoGeneratedColors.secondary, "junoSecondary")
        assertResolves(.junoHover, to: JunoGeneratedColors.accent, "junoHover")
        assertResolves(.junoInput, to: JunoGeneratedColors.input, "junoInput")
    }

    func testTheInksAreTheWebsInks() {
        let foreground = JunoGeneratedColors.foreground
        let muted = JunoGeneratedColors.mutedForeground
        assertResolves(.junoForeground, to: foreground, "junoForeground")
        assertResolves(.junoSecondaryInk, to: muted, "junoSecondaryInk")
        assertResolves(
            .junoTertiaryInk,
            to: pair(muted.light.withOpacity(0.7), muted.dark.withOpacity(0.7)),
            "junoTertiaryInk"
        )
        assertResolves(.junoSidebarInk, to: JunoGeneratedColors.sidebarForeground, "junoSidebarInk")
    }

    func testTheStatusPairsAreTheWebsPairs() {
        assertResolves(.junoSuccessInk, to: JunoGeneratedColors.successInk, "junoSuccessInk")
        assertResolves(.junoWarning, to: JunoGeneratedColors.warning, "junoWarning")
        assertResolves(.junoWarningInk, to: JunoGeneratedColors.warningForeground, "junoWarningInk")
        assertResolves(.junoDestructive, to: JunoGeneratedColors.destructive, "junoDestructive")
        assertResolves(.junoDestructiveInk, to: JunoGeneratedColors.destructiveInk, "junoDestructiveInk")
        assertResolves(.junoCodeString, to: JunoGeneratedColors.codeString, "junoCodeString")
        assertResolves(.junoCodeNumber, to: JunoGeneratedColors.codeNumber, "junoCodeNumber")
    }

    /// `junoSource` is the file's one declared divergence: one lightness step
    /// darker than `--source` in light mode, for text contrast, and exactly
    /// `--source` in dark.
    func testSourceIsTheWebsTealWithItsOneDeclaredStep() {
        let source = JunoGeneratedColors.source
        assertResolves(
            .junoSource,
            to: pair(source.light.adjustingLightness(by: -0.01), source.dark),
            "junoSource"
        )
        // The step is what the literal it replaced said: `187 62% 33%`.
        let stepped = source.light.adjustingLightness(by: -0.01)
        XCTAssertEqual(stepped.red, 0.1254, accuracy: 0.0005)
        XCTAssertEqual(stepped.green, 0.4869, accuracy: 0.0005)
        XCTAssertEqual(stepped.blue, 0.5346, accuracy: 0.0005)
    }

    func testGlassAndSelectionAreDerivedFromTheForeground() {
        let foreground = JunoGeneratedColors.foreground
        assertResolves(
            .junoGlassHover,
            to: pair(foreground.light.withOpacity(0.06), foreground.dark.withOpacity(0.08)),
            "junoGlassHover"
        )
        assertResolves(
            .junoGlassFill,
            to: pair(foreground.light.withOpacity(0.08), foreground.dark.withOpacity(0.12)),
            "junoGlassFill"
        )
        assertResolves(
            .junoSelectedEdge,
            to: pair(foreground.light.withOpacity(0.12), foreground.dark.withOpacity(0.14)),
            "junoSelectedEdge"
        )
        assertResolves(
            .junoSelectedEdge(increaseContrast: true),
            to: pair(foreground.light.withOpacity(0.24), foreground.dark.withOpacity(0.24)),
            "junoSelectedEdge (Increase Contrast)"
        )
        XCTAssertEqual(Color.junoSelectedEdge(increaseContrast: false), Color.junoSelectedEdge)
    }

    /// Errata: the selection fill is **opaque**, so the system-accent
    /// highlight the platform paints underneath can never show through.
    func testTheSelectedFillIsOpaque() {
        assertResolves(.junoSelectedFill, to: JunoGeneratedColors.sidebarSelected, "junoSelectedFill")
        for dark in [false, true] {
            XCTAssertEqual(resolved(.junoSelectedFill, dark: dark).opacity, 1)
        }
    }

    /// The accent family follows the account's accent, in every accent.
    func testTheAccentFamilyFollowsTheSelection() {
        let selection = JunoAccentSelection.shared
        let original = selection.current
        defer { selection.current = original }

        for accent in JunoAccent.allCases {
            selection.current = accent
            let palette = accent.generatedPalette
            assertResolves(.junoAccent, to: palette.primary, "junoAccent (\(accent))")
            assertResolves(.junoAccentInk, to: palette.ink, "junoAccentInk (\(accent))")
            assertResolves(.junoOnAccent, to: palette.onPrimary, "junoOnAccent (\(accent))")
            assertResolves(.junoRing, to: palette.ring, "junoRing (\(accent))")
        }
    }

    /// The accent's HSL triples, kept for the voice aura, still agree with the
    /// projection the colours now read.
    func testTheAccentTriplesAgreeWithTheProjection() {
        for accent in JunoAccent.allCases {
            for dark in [false, true] {
                let fromTriple = JunoColorToken(hsl: accent.hsl(dark: dark))
                let generated = accent.generatedPalette.primary.resolve(dark: dark)
                XCTAssertEqual(fromTriple.red, generated.red, accuracy: 0.001, "\(accent)")
                XCTAssertEqual(fromTriple.green, generated.green, accuracy: 0.001, "\(accent)")
                XCTAssertEqual(fromTriple.blue, generated.blue, accuracy: 0.001, "\(accent)")
            }
        }
    }

    /// The older names are aliases of the redesign's, not a second palette.
    func testTheOlderNamesAliasTheRedesignsNames() {
        XCTAssertEqual(Color.junoSurface, Color.junoCard)
        XCTAssertEqual(Color.junoRaised, Color.junoCard)
        XCTAssertEqual(Color.junoCanvasWarm, Color.junoCanvas)
        XCTAssertEqual(Color.junoMutedForeground, Color.junoSecondaryInk)
        XCTAssertEqual(Color.junoSidebarForeground, Color.junoSidebarInk)
        XCTAssertEqual(Color.junoSidebarSelection, Color.junoSelectedFill)
        assertResolves(
            .junoFocusRing, to: JunoAccent.coral.generatedPalette.ring, "junoFocusRing"
        )
    }

    /// On the Mac the retired neutral alphas resolve to the generated tokens
    /// that have their jobs; the phone keeps them for now.
    func testTheRetiredAlphasResolveToGeneratedTokensOnTheMac() {
        #if os(macOS)
        let foreground = JunoGeneratedColors.foreground
        assertResolves(
            .junoRowHover,
            to: pair(foreground.light.withOpacity(0.06), foreground.dark.withOpacity(0.08)),
            "junoRowHover"
        )
        assertResolves(
            .junoRowSelected,
            to: pair(foreground.light.withOpacity(0.08), foreground.dark.withOpacity(0.12)),
            "junoRowSelected"
        )
        assertResolves(.junoSeparator, to: JunoGeneratedColors.hairline, "junoSeparator")
        #endif
        let ink = JunoGeneratedColors.shadowInk
        assertResolves(
            .junoCardShadow,
            to: pair(ink.light.withOpacity(0.07), ink.dark.withOpacity(0.42)),
            "junoCardShadow"
        )
    }

    /// The Mac app's `AccentColor` asset stays graphite: the neutral ring, in
    /// both appearances. It is what AppKit draws the focus ring and unstyled
    /// selection in, so a coral asset would put the action colour on every
    /// focused control (§0.4) — the accent is applied with `junoAccentTint()`
    /// below the toolbar owner instead.
    func testTheMacAccentColorAssetIsTheGraphiteRing() throws {
        let asset = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // → JunoDesignSystemTests
            .deletingLastPathComponent() // → Tests
            .deletingLastPathComponent() // → JunoNativeKit
            .deletingLastPathComponent() // → Packages
            .deletingLastPathComponent() // → native
            .appendingPathComponent("macOS/JunoDesktop/Resources/Assets.xcassets/AccentColor.colorset/Contents.json")
        let json = try JSONSerialization.jsonObject(with: Data(contentsOf: asset)) as? [String: Any]
        let entries = try XCTUnwrap(json?["colors"] as? [[String: Any]])
        let ring = JunoAccent.coral.generatedPalette.ring
        var checked = 0
        for entry in entries {
            let appearance = (entry["appearances"] as? [[String: String]])?.first?["value"]
            let components = try XCTUnwrap((entry["color"] as? [String: Any])?["components"] as? [String: String])
            let expected = appearance == "dark" ? ring.dark : ring.light
            XCTAssertEqual(Double(components["red"] ?? "") ?? -1, expected.red, accuracy: 0.002)
            XCTAssertEqual(Double(components["green"] ?? "") ?? -1, expected.green, accuracy: 0.002)
            XCTAssertEqual(Double(components["blue"] ?? "") ?? -1, expected.blue, accuracy: 0.002)
            checked += 1
        }
        XCTAssertEqual(checked, 2, "one light and one dark entry")
    }

    /// A content hairline is drawn at 0.8, and at full strength under Increase
    /// Contrast (§8.1).
    func testHairlineStrengthAnswersIncreaseContrast() {
        XCTAssertEqual(JunoHairline.opacity(increaseContrast: false), 0.8)
        XCTAssertEqual(JunoHairline.opacity(increaseContrast: true), 1)
    }
}

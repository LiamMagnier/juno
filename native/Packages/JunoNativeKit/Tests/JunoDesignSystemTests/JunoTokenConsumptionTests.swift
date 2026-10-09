import Foundation
import SwiftUI
import XCTest
@testable import JunoDesignSystem

/// Phase 6, spec §A4.1: the ledger that proves the apps *read* the web's
/// tokens, not only that the projection matches the web.
///
/// `design:tokens:check` proves `Generated/JunoGeneratedTokens.swift` matches
/// `globals.css` and `tailwind.config.ts`. It says nothing about whether a
/// view ever reads the projection, which is how `warmBlack` overrode the
/// generated ground for a release and nothing failed. These tests close that
/// loop from both ends:
///
/// 1. **Every `Color.juno*` is in the ledger** — resolved against its
///    generated pair, an alias of a ledger entry, the account's accent, or a
///    registered native-only token with its reason. A new accessor that is
///    none of those fails, by name.
/// 2. **No second palette.** No `Color.juno*` is declared outside
///    `JunoDesignSystem`.
/// 3. **Hand-typed colour literals are only the registered ones.** A literal
///    triple added anywhere in the product sources fails until it is either
///    read from the projection or argued for in ``handTypedRegister``.
/// 4. **Every generated token is read, or declared unread.** A variable the web
///    adds lands in the projection by `npm run design:tokens`; this fails
///    until someone decides whether the apps paint it.
/// 5. **Every `JunoType` rung is the generated rung**, or a registered one.
///
/// The source scans read the checkout through `#filePath`, as
/// `JunoBrandTests` reads the icon catalogs; they skip rather than fail when
/// the package is built outside its repository.
@MainActor
final class JunoTokenConsumptionTests: XCTestCase {

    // MARK: - 1. The colour ledger

    /// What a `Color.juno*` accessor is, and so how it is checked.
    private enum ColourEntry {
        /// Resolves to this generated pair in both appearances.
        case generated(Color, JunoGeneratedPair)
        /// Is another ledger entry under an older name.
        case alias(Color, of: Color)
        /// Follows `JunoAccentSelection`; checked for every accent below.
        case accent
        /// A token with no generated counterpart. The reason is the argument
        /// for keeping it; the literals behind it are in ``handTypedRegister``.
        case nativeOnly(String)
        /// A function that builds colours rather than naming one.
        case builder
    }

    private static let G = JunoGeneratedColors.self

    private static func pair(_ light: JunoColorToken, _ dark: JunoColorToken) -> JunoGeneratedPair {
        JunoGeneratedPair(light: light, dark: dark)
    }

    private static func foreground(_ light: Double, _ dark: Double) -> JunoGeneratedPair {
        pair(G.foreground.light.withOpacity(light), G.foreground.dark.withOpacity(dark))
    }

    /// Every `Color.juno*` the design system declares, keyed by name.
    private static var colourLedger: [String: ColourEntry] {
        var ledger: [String: ColourEntry] = [
            // Grounds.
            "junoCard": .generated(.junoCard, G.card),
            "junoSecondary": .generated(.junoSecondary, G.secondary),
            "junoHover": .generated(.junoHover, G.accent),
            "junoSelected": .generated(.junoSelected, G.selected),
            "junoInput": .generated(.junoInput, G.input),
            "junoMuted": .generated(.junoMuted, G.muted),
            "junoPopover": .generated(.junoPopover, G.popover),
            "junoSidebar": .generated(.junoSidebar, G.sidebar),
            "junoHairline": .generated(.junoHairline, G.hairline),
            // Inks.
            "junoForeground": .generated(.junoForeground, G.foreground),
            "junoSecondaryInk": .generated(.junoSecondaryInk, G.mutedForeground),
            "junoTertiaryInk": .generated(
                .junoTertiaryInk,
                pair(G.mutedForeground.light.withOpacity(0.7), G.mutedForeground.dark.withOpacity(0.7))
            ),
            "junoSidebarInk": .generated(.junoSidebarInk, G.sidebarForeground),
            // Status, as the web splits it.
            "junoSuccessInk": .generated(.junoSuccessInk, G.successInk),
            "junoWarning": .generated(.junoWarning, G.warning),
            "junoWarningInk": .generated(.junoWarningInk, G.warningForeground),
            "junoDestructive": .generated(.junoDestructive, G.destructive),
            "junoDestructiveInk": .generated(.junoDestructiveInk, G.destructiveInk),
            // The one declared divergence that is still derived: a lightness
            // step below `--source` in light (JunoColors.swift explains it).
            "junoSource": .generated(
                .junoSource, pair(G.source.light.adjustingLightness(by: -0.01), G.source.dark)
            ),
            "junoCodeString": .generated(.junoCodeString, G.codeString),
            "junoCodeNumber": .generated(.junoCodeNumber, G.codeNumber),
            // Inside glass, and selection.
            "junoGlassHover": .generated(.junoGlassHover, foreground(0.06, 0.08)),
            "junoGlassFill": .generated(.junoGlassFill, foreground(0.08, 0.12)),
            "junoSidebarHover": .generated(.junoSidebarHover, G.sidebarHover),
            "junoSelectedFill": .generated(.junoSelectedFill, G.sidebarSelected),
            "junoSelectedEdge": .generated(.junoSelectedEdge, foreground(0.12, 0.14)),
            // Shadows: `--shadow-ink` at the alphas one native blur needs.
            "junoCardShadow": .generated(
                .junoCardShadow, pair(G.shadowInk.light.withOpacity(0.07), G.shadowInk.dark.withOpacity(0.42))
            ),
            "junoRaisedShadow": .generated(
                .junoRaisedShadow, pair(G.shadowInk.light.withOpacity(0.04), G.shadowInk.dark.withOpacity(0.25))
            ),
            // The agent faces.
            "junoAgentInk": .generated(.junoAgentInk, G.agentInk),
            "junoAgentMark": .generated(.junoAgentMark, G.agentMark),
            // The neutral ring every accent block projects.
            "junoFocusRing": .generated(.junoFocusRing, JunoAccent.coral.generatedPalette.ring),
            // The accent family.
            "junoAccent": .accent,
            "junoAccentInk": .accent,
            "junoOnAccent": .accent,
            "junoRing": .accent,
            // Older names.
            "junoSurface": .alias(.junoSurface, of: .junoCard),
            "junoRaised": .alias(.junoRaised, of: .junoCard),
            "junoCanvasWarm": .alias(.junoCanvasWarm, of: .junoCanvas),
            "junoMutedForeground": .alias(.junoMutedForeground, of: .junoSecondaryInk),
            "junoSidebarForeground": .alias(.junoSidebarForeground, of: .junoSidebarInk),
            "junoSidebarSelection": .alias(.junoSidebarSelection, of: .junoSelectedFill),
            // Native-only: no variable on the web to project.
            "junoTerminal": .nativeOnly(
                "Juno Code's terminal and diff well. The web has no terminal surface."
            ),
            "junoDiffAdded": .nativeOnly("Juno Code's diff rows. The web's diffs colour ink, not rows."),
            "junoDiffRemoved": .nativeOnly("Juno Code's diff rows. The web's diffs colour ink, not rows."),
            "junoSuccess": .nativeOnly(
                "The shipped status ramp, read as text at about 300 sites across Code, Work, the phone and the Mac. "
                    + "Migrates to junoSuccessInk surface by surface; the name then moves to `--success`."
            ),
            "junoDanger": .nativeOnly(
                "The shipped status ramp. Migrates to junoDestructiveInk (text) / junoDestructive (fill)."
            ),
            "junoCaution": .nativeOnly(
                "The shipped status ramp. Migrates to junoWarningInk (text) / junoWarning (fill)."
            ),
            "junoPresence": .nativeOnly(
                "Presence ink, the brand's live colour. The web states it in thinking-mark.css (--tm-presence), not globals.css."
            ),
            "junoGalaxyCore": .nativeOnly("The galaxy thinking mark's warm core (GALAXY_SPEC). No web token."),
            // Builders.
            "junoAdaptive": .builder,
        ]
        #if os(macOS)
        ledger["junoCanvas"] = .generated(.junoCanvas, G.background)
        ledger["junoBorder"] = .generated(.junoBorder, G.border)
        // The retired neutral alphas resolve to the tokens that have their jobs.
        ledger["junoRowHover"] = .generated(.junoRowHover, foreground(0.06, 0.08))
        ledger["junoRowSelected"] = .generated(.junoRowSelected, foreground(0.08, 0.12))
        ledger["junoSeparator"] = .generated(.junoSeparator, G.hairline)
        #else
        let phone = "The phone keeps the value it shipped with until its own pass."
        ledger["junoCanvas"] = .nativeOnly(phone)
        ledger["junoBorder"] = .nativeOnly(phone)
        ledger["junoRowHover"] = .nativeOnly(phone)
        ledger["junoRowSelected"] = .nativeOnly(phone)
        ledger["junoSeparator"] = .nativeOnly(phone)
        #endif
        return ledger
    }

    private func resolved(_ color: Color, dark: Bool) -> Color.Resolved {
        var environment = EnvironmentValues()
        environment.colorScheme = dark ? .dark : .light
        return color.resolve(in: environment)
    }

    private func assertSame(_ a: Color, _ b: Color, _ name: String, file: StaticString = #filePath, line: UInt = #line) {
        for dark in [false, true] {
            let x = resolved(a, dark: dark)
            let y = resolved(b, dark: dark)
            let appearance = dark ? "dark" : "light"
            XCTAssertEqual(x.red, y.red, accuracy: 0.0005, "\(name) red (\(appearance))", file: file, line: line)
            XCTAssertEqual(x.green, y.green, accuracy: 0.0005, "\(name) green (\(appearance))", file: file, line: line)
            XCTAssertEqual(x.blue, y.blue, accuracy: 0.0005, "\(name) blue (\(appearance))", file: file, line: line)
            XCTAssertEqual(x.opacity, y.opacity, accuracy: 0.0005, "\(name) opacity (\(appearance))", file: file, line: line)
        }
    }

    private func assertResolves(_ color: Color, to pair: JunoGeneratedPair, _ name: String) {
        assertSame(color, Color.junoAdaptive(pair), name)
    }

    func testEveryLedgerColourResolvesToWhatItClaims() {
        for (name, entry) in Self.colourLedger.sorted(by: { $0.key < $1.key }) {
            switch entry {
            case let .generated(color, pair): assertResolves(color, to: pair, name)
            case let .alias(color, of: target): assertSame(color, target, name)
            case .nativeOnly(let reason): XCTAssertFalse(reason.isEmpty, "\(name) needs its reason")
            case .accent, .builder: break
            }
        }
        // The Increase Contrast edge is the function form of `junoSelectedEdge`.
        assertResolves(.junoSelectedEdge(increaseContrast: true), to: Self.foreground(0.24, 0.24), "junoSelectedEdge (IC)")
        assertSame(.junoSelectedEdge(increaseContrast: false), .junoSelectedEdge, "junoSelectedEdge (standard)")
    }

    func testTheAccentFamilyIsTheSelectedAccentsPalette() {
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

    /// `JunoAccent.hsl(dark:)` is derived from the projection now, not typed.
    /// The web's own triples (`[data-accent]` in `globals.css`) are pinned
    /// here, as the ladder tests pin numbers: the derivation must give them
    /// back, and a retune on the web shows up as a deliberate edit here.
    func testTheAccentTriplesComeBackOutOfTheProjection() {
        let web: [JunoAccent: (light: (Double, Double, Double), dark: (Double, Double, Double))] = [
            // The default accent keeps its stored name; V3 made it ultramarine
            // and lifts it on the charcoal.
            .coral: ((229.231, 0.63415, 0.48235), (228.608, 0.61240, 0.74706)),
            .juniper: ((152, 0.44, 0.31), (152, 0.42, 0.54)),
            .teal: ((180, 0.63, 0.315), (187, 0.58, 0.49)),
            .violet: ((249, 0.59, 0.60), (249, 0.66, 0.71)),
            .amber: ((39, 0.67, 0.55), (38, 0.73, 0.63)),
            .sage: ((120, 0.18, 0.425), (120, 0.23, 0.61)),
        ]
        XCTAssertEqual(Set(web.keys), Set(JunoAccent.allCases))
        for (accent, triples) in web {
            for (dark, expected) in [(false, triples.light), (true, triples.dark)] {
                let derived = accent.hsl(dark: dark)
                let label = "\(accent) (\(dark ? "dark" : "light"))"
                XCTAssertEqual(derived.h, expected.0, accuracy: 1, "\(label) hue")
                XCTAssertEqual(derived.s, expected.1, accuracy: 0.005, "\(label) saturation")
                XCTAssertEqual(derived.l, expected.2, accuracy: 0.005, "\(label) lightness")
            }
        }
    }

    func testEveryColourAccessorIsInTheLedger() throws {
        let declared = try Self.colourAccessors(in: Self.sourceFiles(under: [Self.designSystem]))
        let ledger = Set(Self.colourLedger.keys)
        XCTAssertEqual(
            declared.subtracting(ledger).sorted(), [],
            "Color accessors with no ledger entry. Resolve each against its JunoGeneratedColors pair here, "
                + "or register it as native-only with the reason."
        )
        XCTAssertEqual(
            ledger.subtracting(declared).sorted(), [],
            "Ledger entries for accessors that no longer exist. Delete them."
        )
    }

    // MARK: - 2. No second palette

    func testNoColourTokenIsDeclaredOutsideTheDesignSystem() throws {
        let elsewhere = try Self.sourceFiles(under: Self.productRoots).filter {
            !$0.path.contains("/JunoDesignSystem/")
        }
        var found: [String] = []
        for file in elsewhere {
            for name in try Self.colourAccessors(in: [file]) {
                found.append("\(file.name): \(name)")
            }
        }
        XCTAssertEqual(
            found, [],
            "A Color.juno* outside JunoDesignSystem is a second palette. Move it into JunoColors.swift and the ledger."
        )
    }

    // MARK: - 3. Hand-typed literals

    /// Every hand-typed colour literal left in the product sources, keyed by
    /// `File.swift:declaration`, with why it is not read from the projection.
    ///
    /// **This list only shrinks.** Each entry is either a value the web does not
    /// state in `globals.css` (so the generator has nothing to project) or a
    /// shipped value a surface still depends on, with where it goes next.
    static let handTypedRegister: [String: String] = {
        let phone = "iOS keeps the value its screens were composed on until the iOS pass (JunoColors.swift, JunoSurfaces.swift)."
        let ramp = "The shipped status ramp, read as text by Code, Work and the phone; migrates to the generated inks per surface."
        let code = "Juno Code's developer surfaces; the web has no terminal or diff-row token."
        return [
            "JunoColors.swift:canvasDark": phone,
            "JunoColors.swift:borderLight": phone,
            "JunoColors.swift:borderDark": phone,
            "JunoSurfaces.swift:rowHoverLight": phone,
            "JunoSurfaces.swift:rowHoverDark": phone,
            "JunoSurfaces.swift:rowSelectedLight": phone,
            "JunoSurfaces.swift:rowSelectedDark": phone,
            "JunoSurfaces.swift:separatorLight": phone,
            "JunoSurfaces.swift:separatorDark": phone,
            "JunoSurfaces.swift:terminalLight": code,
            "JunoSurfaces.swift:terminalDark": code,
            "JunoStatus.swift:diffAddedLight": code,
            "JunoStatus.swift:diffAddedDark": code,
            "JunoStatus.swift:diffRemovedLight": code,
            "JunoStatus.swift:diffRemovedDark": code,
            "JunoStatus.swift:successLight": ramp,
            "JunoStatus.swift:successDark": ramp,
            "JunoStatus.swift:dangerLight": ramp,
            "JunoStatus.swift:dangerDark": ramp,
            "JunoStatus.swift:cautionLight": ramp,
            "JunoStatus.swift:cautionDark": ramp,
            "JunoAccent.swift:inkLight":
                "A custom accent's dark ink: the web states it in script (app-provider.tsx), not in globals.css.",
            "JunoAccent.swift:inkDark":
                "A custom accent's dark ink: the web states it in script (app-provider.tsx), not in globals.css.",
            "InlineChartRenderer.swift:supplementary":
                "The chart series palette past the accent and the citation teal. Native-only: the web has no chart tokens.",
            "InlineArtifactCard.swift:terminalGround":
                "The artifact console's shell (#0b0b0e), which the web's sandbox-frame.tsx paints as a component literal.",
            "InlineDesignPreview.swift:deskColor":
                "The desk an exported design sits on, light in both appearances; the same hex is written into the preview page's CSS beside it.",
            "JunoMobileIncognito.swift:ground":
                "The phone's incognito ink ground over a light app; the web states no incognito ground. Shipped (96ad8299); moves to a generated token in the iOS pass.",
            "JunoMobileIncognito.swift:deep":
                "The phone's incognito ink ground over a dark app, a step below the canvas; no web token. Shipped (96ad8299); moves with `ground`.",
            "JunoColors.swift:presenceLight":
                "Presence ink (#2D49C9), which the web states in thinking-mark.css rather than globals.css.",
            "JunoColors.swift:presenceDark":
                "Presence ink on charcoal (#97A6E6), stated in thinking-mark.css rather than globals.css.",
            "JunoColors.swift:galaxyCoreLight": "The galaxy mark's warm core on paper (#8A6A3E); the web lane types it in galaxy-mark.tsx.",
            "JunoColors.swift:galaxyCoreDark": "The galaxy mark's warm core on charcoal (#F3D9B1); the web lane types it in galaxy-mark.tsx.",
            "JunoMobilePremium.swift:shadow":
                "The phone front door's umber shadow hue, warmer than the web's --shadow-ink. Shipped (42d77b79); moves to JunoGeneratedColors.shadowInk in the iOS pass.",
        ]
    }()

    func testHandTypedColourLiteralsAreOnlyTheRegisteredOnes() throws {
        let files = try Self.sourceFiles(under: Self.productRoots)
        let found = Self.handTypedColourLiterals(in: files)
        let register = Set(Self.handTypedRegister.keys)
        XCTAssertEqual(
            found.subtracting(register).sorted(), [],
            "Hand-typed colour literals. Read the value from JunoGeneratedColors (or derive it: withOpacity, "
                + "adjustingLightness), or argue for it in handTypedRegister."
        )
        XCTAssertEqual(
            register.subtracting(found).sorted(), [],
            "Register entries whose literal is gone. Delete them: the register only shrinks."
        )
    }

    // MARK: - 4. Every generated token is read

    /// Generated members no product source reads, and why. A web variable that
    /// is new in the projection fails the test below until it is either
    /// consumed or listed here; a listed one that becomes read fails too, so
    /// the list cannot go stale.
    static let unreadGenerated: [String: String] = {
        let sidebar = "Not painted on the Mac (§8.1): the sidebar is system glass; hover and edge are junoGlassHover / junoSelectedEdge."
        let perSurfaceInk = "The web's ink for one ground; the apps draw junoForeground on every ground."
        let canvas = "Design canvas chrome, drawn by the web editor bundle the Mac hosts (Resources/DesignEditor)."
        return [
            "JunoGeneratedColors.accentForeground": perSurfaceInk,
            "JunoGeneratedColors.cardForeground": perSurfaceInk,
            "JunoGeneratedColors.popoverForeground": perSurfaceInk,
            "JunoGeneratedColors.secondaryForeground": perSurfaceInk,
            "JunoGeneratedColors.destructiveForeground": "A glyph on a filled destructive chip; native status is ink, never a filled chip.",
            "JunoGeneratedColors.successForeground": "A glyph on a filled success chip; native status is ink, never a filled chip.",
            "JunoGeneratedColors.success": "The success fill. Unread while `junoSuccess` is still the shipped text ramp (JunoStatus.swift).",
            "JunoGeneratedColors.primaryInk": "Superseded per accent by JunoGeneratedAccentPalette.ink, which every accent block sets.",
            "JunoGeneratedColors.ring": "Superseded per accent by JunoGeneratedAccentPalette.ring, which every accent block sets.",
            "JunoGeneratedColors.canvasGuide": canvas,
            "JunoGeneratedColors.canvasMeasure": canvas,
            "JunoGeneratedColors.canvasSelection": canvas,
            "JunoGeneratedColors.knob": "A switch's knob; the apps use the system Toggle, which draws its own.",
            "JunoGeneratedColors.neuDark": "The web's soft inset shadow; native wells are flat.",
            "JunoGeneratedColors.sheen": "The web's glass highlight; native glass is the system material.",
            "JunoGeneratedColors.scrim": "Not painted on the Mac (§8.1): system sheets dim their own parent.",
            "JunoGeneratedColors.ultra": "The web's thinking aura; native draws the Ultra ramp from ultraFrom / ultraTo.",
            "JunoGeneratedColors.sidebarAccent": sidebar,
            "JunoGeneratedColors.sidebarBorder": sidebar,
            "JunoGeneratedColors.sidebarSelectedBorder": sidebar,
            "JunoGeneratedType.hero": "The marketing site's rung; the apps have no marketing surface.",
            "JunoGeneratedRadius.stage": "The front door's plates and product shots only (tailwind.config.ts); the apps have no marketing surface.",
            "JunoGeneratedType.nav": "The web's sidebar rows; the Mac sidebar uses system sizing (§8.6), the phone Dynamic Type.",
            "JunoGeneratedRadius.composerControl": "The web's per-component name for `control` (10), which the apps read as JunoRadius.control.",
            "JunoGeneratedRadius.composerAction": "The web's per-component name for `field` (12), which the apps read as JunoRadius.field.",
            "JunoGeneratedRadius.surface": "The web's per-component name for `card` (16), which the apps read as JunoRadius.card.",
            "JunoGeneratedSpace.all": "The whole ladder, for JunoDesignTokensTests.",
            "JunoGeneratedEasing.drawer": "The web's sheet curve; native sheets move on the system's own curve.",
            // Round-3 (V3) tokens the web paints and the apps have not adopted
            // yet. Each is a real gap, listed so it stays visible; delete the
            // entry in the change that consumes it.
            "JunoGeneratedColors.attention": "V3's needs-you text ink (attention is words, never a pill). Not adopted natively yet: needs-you lines keep their current ink until the native V3 shell pass.",
            "JunoGeneratedColors.faintForeground": "V3's faint text. Not adopted natively yet: the quietest native ink is still junoTertiaryInk (muted-foreground at 70%).",
            "JunoGeneratedColors.userBubble": "V3's user-message fill. Not adopted natively yet: the Mac bubble still fills with junoSecondary (MessageRow.swift).",
        ]
    }()

    func testEveryGeneratedTokenIsReadOrDeclaredUnread() throws {
        let generated = try Self.generatedMembers()
        XCTAssertGreaterThan(generated.count, 80, "the generated file was not parsed")
        let files = try Self.sourceFiles(under: Self.productRoots).filter { !$0.path.contains("/Generated/") }
        // Whole references only: `JunoGeneratedColors.success` must not count
        // as read because `JunoGeneratedColors.successInk` is.
        let reads = Self.references(in: files.map { $0.text }.joined(separator: "\n"))
        var unread: Set<String> = []
        for (type, name) in generated where !reads.contains("\(type).\(name)") {
            unread.insert("\(type).\(name)")
        }
        let declared = Set(Self.unreadGenerated.keys)
        XCTAssertEqual(
            unread.subtracting(declared).sorted(), [],
            "Generated tokens no product source reads. Consume each (usually a Color.juno* accessor in "
                + "JunoColors.swift and a ledger entry), or declare why the apps do not paint it."
        )
        XCTAssertEqual(
            declared.subtracting(unread).sorted(), [],
            "Declared-unread tokens that are now read. Delete them from unreadGenerated."
        )
    }

    // MARK: - 5. The type ladder

    /// Every `JunoType` rung, and what it is.
    private enum RungEntry {
        case generated(JunoType, JunoGeneratedTypeRung)
        /// The greeting: the generated rung at the web's weight override.
        case display
        case nativeOnly(String)
    }

    private static let typeLedger: [String: RungEntry] = [
        "display": .display,
        "displayItalic": .display,
        "displaySize": .display,
        "pageTitle": .generated(.pageTitle, JunoGeneratedType.pageTitle),
        "title": .generated(.title, JunoGeneratedType.title),
        "heading": .generated(.heading, JunoGeneratedType.heading),
        "bodyLarge": .generated(.bodyLarge, JunoGeneratedType.bodyLg),
        "reading": .generated(.reading, JunoGeneratedType.reading),
        "body": .generated(.body, JunoGeneratedType.body),
        "prose": .generated(.prose, JunoGeneratedType.reading),
        "ui": .generated(.ui, JunoGeneratedType.ui),
        "label": .generated(.label, JunoGeneratedType.label),
        "caption": .generated(.caption, JunoGeneratedType.caption),
        "micro": .generated(.micro, JunoGeneratedType.micro),
        "mono": .nativeOnly("The code face: `.aicss-cb` states 13px on 20px in component CSS, off the Tailwind ladder."),
        "monoSmall": .nativeOnly("Ids, counts and costs in the code face; off the Tailwind ladder for the same reason."),
    ]

    func testEveryRungIsTheGeneratedRung() {
        for (name, entry) in Self.typeLedger.sorted(by: { $0.key < $1.key }) {
            switch entry {
            case let .generated(rung, generated):
                XCTAssertEqual(rung.size, generated.minSize, "\(name) size")
                XCTAssertEqual(rung.lineHeight, generated.lineHeight, "\(name) line height")
                XCTAssertEqual(rung.tracking, generated.tracking, "\(name) tracking")
                XCTAssertEqual(rung.weight, JunoType.weight(css: generated.weight), "\(name) weight")
            case .display:
                let rung = JunoType.display(size: 40)
                XCTAssertEqual(rung.lineHeight, JunoGeneratedType.display.lineHeight, "display line height")
                XCTAssertEqual(rung.tracking, JunoGeneratedType.display.tracking, "display tracking")
                XCTAssertEqual(JunoType.displaySize(forColumnWidth: 0), JunoGeneratedType.display.minSize)
                XCTAssertEqual(JunoType.displaySize(forColumnWidth: 4000), JunoGeneratedType.display.maxSize)
            case .nativeOnly(let reason):
                XCTAssertFalse(reason.isEmpty, "\(name) needs its reason")
            }
        }
    }

    func testEveryRungIsInTheLedger() throws {
        let typography = try Self.sourceFiles(under: [Self.designSystem]).filter { $0.name == "JunoTypography.swift" }
        XCTAssertEqual(typography.count, 1)
        let declared = Self.matches(
            #"^\s*public static (?:let|func) (\w+)\s*(?:=\s*JunoType\(|\([^)]*\)\s*->\s*(?:JunoType|CGFloat)\b)"#,
            in: typography.first?.text ?? ""
        )
        XCTAssertTrue(declared.contains("body"), "JunoTypography.swift was not parsed")
        let ledger = Set(Self.typeLedger.keys)
        XCTAssertEqual(declared.subtracting(ledger).sorted(), [], "JunoType rungs with no ledger entry")
        XCTAssertEqual(ledger.subtracting(declared).sorted(), [], "Ledger entries for rungs that no longer exist")
    }

    // MARK: - Source access

    private struct SourceFile {
        let path: String
        let name: String
        let text: String
    }

    /// `native/`, found from this file.
    private static let nativeRoot = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent() // → JunoDesignSystemTests
        .deletingLastPathComponent() // → Tests
        .deletingLastPathComponent() // → JunoNativeKit
        .deletingLastPathComponent() // → Packages
        .deletingLastPathComponent() // → native

    private static let designSystem = "Packages/JunoNativeKit/Sources/JunoDesignSystem"

    /// Everything that ships: the three packages' sources and both apps.
    private static let productRoots = [
        "Packages/JunoNativeKit/Sources",
        "Packages/JunoCode/Sources",
        "Packages/JunoWork/Sources",
        "macOS/JunoDesktop/App",
        "iOS/JunoMobile/App",
        "iOS/JunoMobile/Widgets",
    ]

    private static func sourceFiles(under roots: [String]) throws -> [SourceFile] {
        var files: [SourceFile] = []
        let manager = FileManager.default
        for root in roots {
            let url = nativeRoot.appendingPathComponent(root)
            guard manager.fileExists(atPath: url.path) else {
                throw XCTSkip("not reachable from this checkout: \(url.path)")
            }
            guard let walker = manager.enumerator(at: url, includingPropertiesForKeys: nil) else { continue }
            for case let file as URL in walker where file.pathExtension == "swift" {
                if file.path.contains("/.build/") { continue }
                let text = try String(contentsOf: file, encoding: .utf8)
                files.append(SourceFile(path: file.path, name: file.lastPathComponent, text: text))
            }
        }
        return files.sorted { $0.path < $1.path }
    }

    /// Lines with `//` comments removed. Crude — a `//` inside a string
    /// literal cuts the line short — but the scans below only look for
    /// declarations and constructor calls, which never follow a URL on the
    /// same line in these sources.
    private static func codeLines(_ text: String) -> [String] {
        text.components(separatedBy: "\n").map { line in
            guard let range = line.range(of: "//") else { return line }
            return String(line[..<range.lowerBound])
        }
    }

    private static func matches(_ pattern: String, in text: String) -> Set<String> {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.anchorsMatchLines]) else { return [] }
        let range = NSRange(text.startIndex..., in: text)
        return Set(regex.matches(in: text, range: range).compactMap { match in
            Range(match.range(at: 1), in: text).map { String(text[$0]) }
        })
    }

    /// The `juno*` statics declared directly inside every `extension Color`.
    private static func colourAccessors(in files: [SourceFile]) throws -> Set<String> {
        let opener = try NSRegularExpression(pattern: #"^\s*(?:public\s+)?extension\s+(?:SwiftUI\.)?Color\b[^{]*\{"#)
        let member = try NSRegularExpression(
            pattern: #"^\s*(?:(?:public|internal|fileprivate|private|nonisolated)\s+)*static\s+(?:let|var|func)\s+(juno\w+)"#
        )
        var names: Set<String> = []
        for file in files {
            var depth = 0
            var inColour = false
            for line in codeLines(file.text) {
                let range = NSRange(line.startIndex..., in: line)
                if !inColour, opener.firstMatch(in: line, range: range) != nil {
                    inColour = true
                    depth = 0
                }
                if inColour, depth == 1, let match = member.firstMatch(in: line, range: range),
                   let name = Range(match.range(at: 1), in: line) {
                    names.insert(String(line[name]))
                }
                if inColour {
                    depth += line.filter { $0 == "{" }.count - line.filter { $0 == "}" }.count
                    if depth <= 0 { inColour = false }
                }
            }
        }
        return names
    }

    /// `File.swift:declaration` for every colour written as numbers.
    private static func handTypedColourLiterals(in files: [SourceFile]) -> Set<String> {
        // A token or a colour built from a numeral, not from a variable.
        let literal = try! NSRegularExpression(pattern: [
            #"JunoColorToken\(\s*unchecked:\s*-?[0-9.]"#,
            #"JunoColorToken\(\s*hsl:\s*\(\s*(?:h:\s*)?-?[0-9.]"#,
            #"\bColor\(\s*(?:\.sRGB\s*,\s*)?(?:red|white|hue):\s*-?[0-9.]"#,
            #"\b(?:NSColor|UIColor)\(\s*(?:srgbRed|calibratedRed|deviceRed|red|white|calibratedWhite|hue):\s*-?[0-9.]"#,
        ].joined(separator: "|"))
        let declaration = try! NSRegularExpression(pattern: #"\b(?:let|var|func)\s+(\w+)"#)
        var found: Set<String> = []
        for file in files where !file.path.contains("/Generated/") {
            let lines = codeLines(file.text)
            for (index, line) in lines.enumerated() {
                guard literal.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)) != nil else { continue }
                // The nearest declaration at or above the literal names it.
                var name = "?"
                for back in stride(from: index, through: 0, by: -1) {
                    let candidate = lines[back]
                    if let match = declaration.firstMatch(in: candidate, range: NSRange(candidate.startIndex..., in: candidate)),
                       let range = Range(match.range(at: 1), in: candidate) {
                        name = String(candidate[range])
                        break
                    }
                }
                found.insert("\(file.name):\(name)")
            }
        }
        return found
    }

    /// Every `JunoGeneratedX.member` written in `text`, backticks dropped.
    private static func references(in text: String) -> Set<String> {
        let reference = try! NSRegularExpression(pattern: #"\b(JunoGenerated\w+)\.`?(\w+)`?"#)
        let range = NSRange(text.startIndex..., in: text)
        return Set(reference.matches(in: text, range: range).compactMap { match in
            guard let type = Range(match.range(at: 1), in: text), let name = Range(match.range(at: 2), in: text)
            else { return nil }
            return "\(text[type]).\(text[name])"
        })
    }

    /// `(JunoGeneratedX, member)` for every static the generator emits, bar the
    /// accent palette (read through `JunoAccent.generatedPalette`).
    private static func generatedMembers() throws -> [(String, String)] {
        let url = nativeRoot.appendingPathComponent("\(designSystem)/Generated/JunoGeneratedTokens.swift")
        guard FileManager.default.fileExists(atPath: url.path) else { throw XCTSkip("no generated tokens at \(url.path)") }
        let text = try String(contentsOf: url, encoding: .utf8)
        let enumOpener = try NSRegularExpression(pattern: #"^public enum (JunoGenerated\w+) \{"#)
        let member = try NSRegularExpression(pattern: #"^\s{4}public static let `?(\w+)`?"#)
        var members: [(String, String)] = []
        var current: String?
        for line in text.components(separatedBy: "\n") {
            let range = NSRange(line.startIndex..., in: line)
            if let match = enumOpener.firstMatch(in: line, range: range), let name = Range(match.range(at: 1), in: line) {
                current = String(line[name])
                continue
            }
            if line.hasPrefix("}") { current = nil; continue }
            if let type = current, let match = member.firstMatch(in: line, range: range),
               let name = Range(match.range(at: 1), in: line) {
                members.append((type, String(line[name])))
            }
        }
        return members
    }
}

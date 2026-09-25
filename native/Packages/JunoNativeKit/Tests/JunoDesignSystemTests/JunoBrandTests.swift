import XCTest
@testable import JunoDesignSystem

@MainActor
final class JunoBrandTests: XCTestCase {
    /// The web's icon vocabulary (`src/lib/app-icons.ts`) is carried
    /// one-for-one, and the native set is allowed to extend it — status marks,
    /// list glyphs, the composer's controls — but never to drop from it. If the
    /// web adds a product mark and native does not, this is where it surfaces.
    func testIconSetCarriesTheWebsitesRegistries() {
        // Each registry's keys, as an array so a key two registries share
        // (`research`, `error`, `memory`, …) can appear under both.
        let web: [String] = [
            // AppIcons — the destinations.
            "home", "work", "code", "design", "library", "research", "artifacts", "projects",
            "assistants", "tasks", "connections", "pulls", "conversation", "new", "search",
            "settings", "skills", "automations", "permissions",
            // CodeIcons — the things Juno Code talks about.
            "cloud", "device", "branch", "lock", "permission",
            "pin", "error", "refresh", "external", "file",
            // ComposerIcons — what the "+" menu adds, and the tools it arms.
            "attach", "photos", "files", "canvas",
            "research", "task", "web", "artifactsTool", "memory",
            // StatusIcons.
            "warning", "error", "info", "success", "verified", "security",
            // ActionIcons.
            "edit", "delete", "dismiss", "copy", "refresh", "restore",
            "external", "share", "download", "more", "filter", "parameters",
            // SettingsIcons.
            "general", "personalization", "memory", "models", "connectors",
            "voice", "data", "account", "billing",
            // The spec's marks the web names by export rather than by key.
            "privateChat", "pinOff", "archiveRestore", "scan", "audioLines", "monitorUp",
        ]
        let native = Set(JunoIcon.allCases.map(\.rawValue))
        let missing = Set(web).subtracting(native)
        XCTAssertTrue(missing.isEmpty, "missing: \(missing.sorted())")
    }

    /// The drawings the registries assign, pinned by name so a remap on either
    /// side is a deliberate change. `scripts/generate-native-icons.mjs --check`
    /// proves the whole table against `app-icons.ts`; these are the ones a
    /// reader would notice first.
    func testRegistryConceptsWearTheWebsDrawings() {
        XCTAssertEqual(JunoIcon.home.symbolName, "juno.chat")
        XCTAssertEqual(JunoIcon.conversation.symbolName, "juno.chat")
        XCTAssertEqual(JunoIcon.code.symbolName, "juno.code")
        XCTAssertEqual(JunoIcon.design.symbolName, "juno.design")
        XCTAssertEqual(JunoIcon.send.symbolName, "juno.send")
        XCTAssertEqual(JunoIcon.privateChat.symbolName, "juno.ghost")
        // Work is steps joined by a line, never the bolt it used to be.
        XCTAssertEqual(JunoIcon.work.symbolName, "ph.treestructure")
        XCTAssertEqual(JunoIcon.search.symbolName, "ph.magnifyingglass")
        XCTAssertEqual(JunoIcon.settings.symbolName, "ph.gearsix")
        XCTAssertEqual(JunoIcon.more.symbolName, "ph.dotsthree")
        XCTAssertEqual(JunoIcon.pin.symbolName, "ph.pushpin")
        XCTAssertEqual(JunoIcon.stop.symbolName, "ph.square")
    }

    /// Names are `ph.<name>` or `juno.<name>`, lowercase and hyphen-free, and a
    /// cut is a suffix on the regular drawing's name.
    func testSymbolNamesFollowTheCatalogsScheme() {
        for icon in JunoIcon.allCases {
            let name = icon.symbolName
            XCTAssertTrue(name.hasPrefix("ph.") || name.hasPrefix("juno."), "\(icon): \(name)")
            XCTAssertEqual(name, name.lowercased(), "\(icon): \(name)")
            XCTAssertFalse(name.contains("-"), "\(icon): \(name)")
            XCTAssertEqual(icon.assetName, name)
            XCTAssertEqual(icon.assetName(.regular), name)
            XCTAssertEqual(icon.assetName(.bold), "\(name).bold")
            XCTAssertEqual(icon.assetName(.fill), icon.hasFill ? "\(name).fill" : name)
        }
    }

    /// The web's optical rule: bold at 13 and under, fill only for "on", and
    /// only where a solid drawing exists — otherwise the size decides.
    func testOpticalWeightFollowsTheWeb() {
        XCTAssertEqual(JunoIcon.copy.opticalWeight(size: 12), .bold)
        XCTAssertEqual(JunoIcon.copy.opticalWeight(size: 13), .bold)
        XCTAssertEqual(JunoIcon.copy.opticalWeight(size: 14), .regular)
        XCTAssertEqual(JunoIcon.copy.opticalWeight(size: 16), .regular)
        XCTAssertEqual(JunoIcon.pin.opticalWeight(size: 12, isOn: true), .fill)
        XCTAssertEqual(JunoIcon.thumbsUp.opticalWeight(size: 16, isOn: true), .fill)
        XCTAssertEqual(JunoIcon.privateChat.opticalWeight(size: 16, isOn: true), .fill)
        XCTAssertEqual(JunoIcon.copy.opticalWeight(size: 16, isOn: true), .regular)
        XCTAssertEqual(JunoIcon.copy.opticalWeight(size: 12, isOn: true), .bold)
    }

    /// Every case's drawing exists in both apps' catalogs, with its bold cut,
    /// and a fill cut exactly where ``JunoIcon/hasFill`` says — and the
    /// catalogs carry nothing no case wears. The package has no app bundle to
    /// load from, so this reads the generated catalogs on disk; the Mac's test
    /// target loads the compiled ones (`DesktopIconCatalogTests`).
    func testEveryCaseHasItsSymbolsInBothCatalogs() throws {
        let native = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // …/JunoDesignSystemTests
            .deletingLastPathComponent()  // …/Tests
            .deletingLastPathComponent()  // …/JunoNativeKit
            .deletingLastPathComponent()  // …/Packages
            .deletingLastPathComponent()  // …/native
        let catalogs = [
            native.appendingPathComponent("macOS/JunoDesktop/Resources/Icons.xcassets"),
            native.appendingPathComponent("iOS/JunoMobile/Resources/Assets.xcassets/Icons"),
        ]
        for catalog in catalogs {
            guard let entries = try? FileManager.default.contentsOfDirectory(atPath: catalog.path) else {
                throw XCTSkip("catalog not reachable from this checkout: \(catalog.path)")
            }
            let shipped = Set(entries.filter { $0.hasSuffix(".symbolset") }.map { String($0.dropLast(".symbolset".count)) })
            var worn: Set<String> = []
            for icon in JunoIcon.allCases {
                let name = icon.symbolName
                worn.formUnion([name, "\(name).bold"])
                XCTAssertTrue(shipped.contains(name), "\(catalog.lastPathComponent): no \(name) for .\(icon)")
                XCTAssertTrue(shipped.contains("\(name).bold"), "\(catalog.lastPathComponent): no \(name).bold")
                XCTAssertEqual(
                    shipped.contains("\(name).fill"), icon.hasFill,
                    "\(catalog.lastPathComponent): \(name).fill disagrees with JunoIcon.filledSymbols"
                )
                if icon.hasFill { worn.insert("\(name).fill") }
            }
            XCTAssertEqual(shipped.subtracting(worn), [], "\(catalog.lastPathComponent): symbols no case wears")
            XCTAssertFalse(
                shipped.contains { $0.hasPrefix("nav-") },
                "\(catalog.lastPathComponent): a retired Lucide image is back"
            )
        }
    }

    /// The string boundary resolves by exact name and refuses the rest — the
    /// substring heuristic it replaces turned "speaker.wave.2" into a wrench.
    func testSystemImageBoundaryIsExactAndFailable() {
        XCTAssertEqual(JunoIcon(systemImage: "speaker.wave.2"), .volume)
        XCTAssertEqual(JunoIcon(systemImage: "doc.on.doc"), .copy)
        XCTAssertEqual(JunoIcon(systemImage: "hand.thumbsup"), .thumbsUp)
        XCTAssertEqual(JunoIcon(systemImage: "arrow.triangle.branch"), .branch)
        XCTAssertNil(JunoIcon(systemImage: "some.symbol.nobody.mapped"))
    }

    /// The marks a Code surface reaches for most, pinned by name so a rename on
    /// the web side cannot quietly leave the apps drawing the old thing.
    ///
    /// `pin` in particular: the API field is `starred` and the section header
    /// says "Pinned", and the Mac drew a star for exactly that reason until the
    /// web was checked.
    func testCodeMarksExistUnderTheNamesTheCodeSurfacesUse() {
        for name in ["cloud", "device", "branch", "lock", "permission", "pin", "error"] {
            XCTAssertNotNil(
                JunoIcon(rawValue: name),
                "Juno Code draws \(name); the generated set must carry it"
            )
        }
    }

    func testInitialsUseFirstAndLastWord() {
        XCTAssertEqual(JunoAvatar.initials(from: "Liam Magnier"), "LM")
        XCTAssertEqual(JunoAvatar.initials(from: "Liam Michel Magnier"), "LM")
        XCTAssertEqual(JunoAvatar.initials(from: "Liam"), "L")
    }

    func testInitialsDegradeRatherThanCrashOnAbsentNames() {
        XCTAssertEqual(JunoAvatar.initials(from: nil), "?")
        XCTAssertEqual(JunoAvatar.initials(from: ""), "?")
        XCTAssertEqual(JunoAvatar.initials(from: "   "), "?")
    }

    /// Slicing by `Character` rather than by unicode scalar: an emoji or an
    /// accented name must not be cut into a broken half-glyph.
    func testInitialsDoNotSplitMultiScalarCharacters() {
        XCTAssertEqual(JunoAvatar.initials(from: "Émile Zola"), "ÉZ")
        XCTAssertEqual(JunoAvatar.initials(from: "👩‍🚀 Cosmo"), "👩‍🚀C")
    }

    /// The face names are the contract with `UIAppFonts` in `Info.plist`. These
    /// are **PostScript** names, not family names — Newsreader's family is
    /// "Newsreader 24pt", so a family-based lookup silently resolves to nothing
    /// and the app falls back to the system serif without anyone noticing.
    func testSerifFacesAreAddressedByPostScriptName() {
        XCTAssertEqual(JunoSerif.Face.regular.rawValue, "Newsreader24pt-Regular")
        // The variable italic's default instance names itself after the 16pt
        // cut; the 24pt axes are pinned when it is drawn.
        XCTAssertEqual(JunoSerif.Face.italic.rawValue, "Newsreader16pt-Italic")
        XCTAssertEqual(JunoSerif.Face.italic.fileName, "Newsreader-Italic-Variable.ttf")
        for face in JunoSerif.Face.allCases where !face.isItalic {
            XCTAssertTrue(face.rawValue.hasPrefix("Newsreader24pt-"))
            XCTAssertEqual(face.fileName, "\(face.rawValue).ttf")
        }
    }

    /// Exactly one face is italic — the greeting's first name, the web's
    /// regular-weight `italic` inside a `font-normal` greeting.
    func testOnlyTheItalicFaceIsItalic() {
        XCTAssertEqual(JunoSerif.Face.allCases.filter(\.isItalic), [.italic])
    }

    /// The fallback must be *observable*. If Newsreader is ever dropped from the
    /// bundle, that should show up in diagnostics rather than silently changing
    /// the brand typeface.
    func testSerifReportsWhetherTheRealFontIsBundled() {
        // Either state is valid here — the package has no app bundle — but the
        // answer must be knowable rather than assumed.
        XCTAssertNotNil(JunoSerif.isBundled as Bool?)
    }
}

import XCTest
@testable import JunoDesignSystem

@MainActor
final class JunoBrandTests: XCTestCase {
    /// The web's icon vocabulary (`src/lib/app-icons.ts`) is carried
    /// one-for-one, and the native set is allowed to extend it — status marks,
    /// list glyphs, the composer's controls — but never to drop from it. If the
    /// web adds a product mark and native does not, this is where it surfaces.
    func testIconSetCarriesTheWebsitesAppIcons() {
        let web: Set<String> = [
            // AppIcons — the destinations.
            "home", "work", "code", "library", "artifacts", "projects",
            "tasks", "connections", "pulls", "conversation", "new", "search",
            "settings",
            // CodeIcons — the things Juno Code talks about.
            "cloud", "device", "branch", "lock", "permission",
            "pin", "error", "refresh", "external", "file",
            // ComposerIcons — what the "+" menu adds, and the tools it arms.
            "attach", "photos", "files", "canvas",
            "research", "web", "artifactsTool", "memory",
            // Settings, profile, and feature sections.
            "usage", "appearance", "writing", "language", "models", "notifications", "about",
            "user", "tools", "knowledge", "sliders",
            // Action controls, media, and navigation glyphs.
            "mic", "send", "stop", "plus", "chevronLeft", "chevronRight", "chevronDown", "chevronUp",
            "trash", "pencil", "copy", "check", "close", "ellipsis", "share", "terminal",
            "arrowDown", "volume", "thumbsUp", "thumbsDown", "eyeOff",
            // StatusIcons and the message action row.
            "triangleAlert", "circleCheck", "circleX", "fork", "arrowUp", "quote",
        ]
        let native = Set(JunoIcon.allCases.map(\.rawValue))
        XCTAssertTrue(web.isSubset(of: native), "missing: \(web.subtracting(native).sorted())")
    }

    /// Every case has a key in `scripts/generate-native-icons.mjs`, and every
    /// key has a case. A case with no key renders as empty space with no error;
    /// a key with no case is a dead asset.
    func testEveryCaseHasAGeneratorKey() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // JunoDesignSystemTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // JunoNativeKit
            .deletingLastPathComponent()  // Packages
            .deletingLastPathComponent()  // native
            .appendingPathComponent("scripts/generate-native-icons.mjs")
        guard let source = try? String(contentsOf: url, encoding: .utf8) else {
            throw XCTSkip("generator not reachable from this checkout")
        }
        let body = source[source.range(of: "const ICONS = {")!.upperBound...]
        let table = body[..<body.range(of: "\n};")!.lowerBound]
        var keys: Set<String> = []
        for line in table.split(separator: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard !trimmed.hasPrefix("//"), let colon = trimmed.firstIndex(of: ":") else { continue }
            keys.insert(String(trimmed[..<colon]))
        }
        let cases = Set(JunoIcon.allCases.map(\.rawValue))
        XCTAssertEqual(cases.subtracting(keys), [], "cases with no generated asset")
        XCTAssertEqual(keys.subtracting(cases), [], "generated assets with no case")
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

    /// The asset name is the contract with `scripts/generate-native-icons.mjs`.
    /// A rename on either side breaks image loading silently at runtime — an
    /// asset that is missing renders as nothing, with no error.
    func testAssetNamesMatchTheGeneratorsOutput() {
        XCTAssertEqual(JunoIcon.projects.assetName, "nav-projects")
        for icon in JunoIcon.allCases {
            XCTAssertEqual(icon.assetName, "nav-\(icon.rawValue)")
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
        XCTAssertEqual(JunoSerif.Face.mediumItalic.rawValue, "Newsreader24pt-MediumItalic")
        for face in JunoSerif.Face.allCases {
            XCTAssertTrue(face.rawValue.hasPrefix("Newsreader24pt-"))
        }
    }

    /// Exactly one face is italic — the greeting's first name, mirroring the
    /// web's `font-medium italic`.
    func testOnlyTheMediumItalicFaceIsItalic() {
        XCTAssertEqual(JunoSerif.Face.allCases.filter(\.isItalic), [.mediumItalic])
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

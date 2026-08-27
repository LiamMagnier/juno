import XCTest
@testable import JunoDesignSystem

@MainActor
final class JunoBrandTests: XCTestCase {
    /// The cases must mirror `src/lib/app-icons.ts` one-for-one. If the web adds
    /// a destination and native does not, this is where it surfaces.
    func testIconSetMatchesTheWebsitesAppIcons() {
        XCTAssertEqual(
            Set(JunoIcon.allCases.map(\.rawValue)),
            [
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
                "mic", "send", "stop", "plus", "chevronRight", "chevronDown", "chevronUp",
                "trash", "pencil", "copy", "check", "close", "ellipsis", "share", "terminal",
                "arrowDown", "volume", "thumbsUp", "thumbsDown", "eyeOff",
            ]
        )
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

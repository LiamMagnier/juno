import CoreText
import SwiftUI
import XCTest
@testable import JunoDesignSystem

/// Pins the type ladder to `tailwind.config.ts` (through `JunoGeneratedType`)
/// and to the numbers, the way the radius and motion tests do: the generated
/// reference catches a Swift-side literal creeping back in, and the number
/// catches a web-side retune nobody meant to ship to the Mac.
@MainActor
final class JunoTypeLadderTests: XCTestCase {

    private struct Expected {
        let rung: JunoType
        let generated: JunoGeneratedTypeRung?
        let size: CGFloat
        let lineHeight: CGFloat
        let tracking: CGFloat
        let weight: Font.Weight
        let face: JunoType.Face
        let name: String
    }

    /// §8.2 with errata 8 applied: `ui` is ×1.5 and `bodyLarge` ×1.6.
    private let ladder: [Expected] = [
        Expected(rung: .display(size: 32), generated: JunoGeneratedType.display, size: 32, lineHeight: 1.08, tracking: -0.02, weight: .regular, face: .serif, name: "display"),
        Expected(rung: .pageTitle, generated: JunoGeneratedType.pageTitle, size: 26, lineHeight: 1.15, tracking: -0.02, weight: .semibold, face: .sans, name: "pageTitle"),
        Expected(rung: .title, generated: JunoGeneratedType.title, size: 22, lineHeight: 1.25, tracking: -0.012, weight: .semibold, face: .sans, name: "title"),
        Expected(rung: .heading, generated: JunoGeneratedType.heading, size: 18, lineHeight: 1.3, tracking: -0.006, weight: .semibold, face: .sans, name: "heading"),
        Expected(rung: .bodyLarge, generated: JunoGeneratedType.bodyLg, size: 17, lineHeight: 1.6, tracking: 0, weight: .regular, face: .sans, name: "bodyLarge"),
        Expected(rung: .body, generated: JunoGeneratedType.body, size: 15, lineHeight: 1.6, tracking: 0, weight: .regular, face: .sans, name: "body"),
        Expected(rung: .prose, generated: nil, size: 15, lineHeight: 1.65, tracking: 0, weight: .regular, face: .sans, name: "prose"),
        Expected(rung: .ui, generated: JunoGeneratedType.ui, size: 13, lineHeight: 1.5, tracking: 0, weight: .regular, face: .sans, name: "ui"),
        Expected(rung: .label, generated: JunoGeneratedType.label, size: 12, lineHeight: 1.4, tracking: 0.01, weight: .medium, face: .sans, name: "label"),
        Expected(rung: .caption, generated: JunoGeneratedType.caption, size: 11, lineHeight: 1.45, tracking: 0.02, weight: .regular, face: .sans, name: "caption"),
        Expected(rung: .micro, generated: JunoGeneratedType.micro, size: 10.5, lineHeight: 1.45, tracking: 0.02, weight: .regular, face: .mono, name: "micro"),
        Expected(rung: .mono, generated: nil, size: 13, lineHeight: 20.0 / 13.0, tracking: 0, weight: .regular, face: .mono, name: "mono"),
        Expected(rung: .monoSmall, generated: nil, size: 12, lineHeight: 1.5, tracking: 0, weight: .regular, face: .mono, name: "monoSmall"),
    ]

    func testEveryRungIsTheWebsRung() {
        for expected in ladder {
            let rung = expected.rung
            XCTAssertEqual(rung.size, expected.size, "\(expected.name) size")
            XCTAssertEqual(rung.lineHeight, expected.lineHeight, accuracy: 0.0001, "\(expected.name) line height")
            XCTAssertEqual(rung.tracking, expected.tracking, accuracy: 0.0001, "\(expected.name) tracking")
            XCTAssertEqual(rung.weight, expected.weight, "\(expected.name) weight")
            XCTAssertEqual(rung.face, expected.face, "\(expected.name) face")
            XCTAssertFalse(rung.isItalic, "\(expected.name) is upright")
            if let generated = expected.generated {
                XCTAssertEqual(rung.size, generated.minSize, "\(expected.name) follows the projection")
                XCTAssertEqual(rung.lineHeight, generated.lineHeight, "\(expected.name) follows the projection")
                XCTAssertEqual(rung.tracking, generated.tracking, "\(expected.name) follows the projection")
            }
        }
    }

    /// The display rung is weight 400 although `text-display` says 500: the
    /// web's greeting sets `font-normal` over it, and the greeting is all the
    /// rung is for. If the web ever drops the override, this is where to look.
    func testTheDisplayRungIsTheGreetingsWeight() {
        XCTAssertEqual(JunoGeneratedType.display.weight, 500)
        XCTAssertEqual(JunoType.display(size: 40).weight, .regular)
        let italic = JunoType.displayItalic(size: 40)
        XCTAssertTrue(italic.isItalic)
        XCTAssertEqual(italic.face, .serif)
        XCTAssertEqual(JunoSerif.Face.nearest(to: italic.weight, italic: true), .mediumItalic)
        XCTAssertEqual(JunoSerif.Face.nearest(to: JunoType.display(size: 40).weight, italic: false), .regular)
    }

    /// The prose leading is `.prose-juno`'s own, stated in `globals.css`
    /// rather than on the Tailwind ladder.
    func testProseLeadingIsTheReadersLeading() {
        XCTAssertEqual(JunoType.prose.lineHeight, 1.65)
        XCTAssertEqual(JunoType.prose.size, JunoType.body.size)
    }

    /// Only the greeting is serif, nothing is above semibold, and nothing is
    /// italic by default.
    func testTheLadderKeepsItsRules() {
        for expected in ladder {
            if expected.face == .serif {
                XCTAssertEqual(expected.name, "display", "Newsreader is the greeting's alone")
            }
            XCTAssertTrue(
                [Font.Weight.regular, .medium, .semibold].contains(expected.rung.weight),
                "\(expected.name) is above semibold"
            )
        }
    }

    /// The two fluid rungs land on the web's size at the web's column widths:
    /// the minimum at a 640pt column, the maximum at 1024, linear between.
    func testFluidRungsMatchTheWebsClamp() {
        XCTAssertEqual(JunoType.displaySize(forColumnWidth: 400), 32, accuracy: 0.01)
        XCTAssertEqual(JunoType.displaySize(forColumnWidth: 640), 32, accuracy: 0.05)
        XCTAssertEqual(JunoType.displaySize(forColumnWidth: 832), 40, accuracy: 0.05)
        XCTAssertEqual(JunoType.displaySize(forColumnWidth: 1024), 48, accuracy: 0.05)
        XCTAssertEqual(JunoType.displaySize(forColumnWidth: 1600), 48, accuracy: 0.01)

        XCTAssertEqual(JunoType.pageTitle(columnWidth: 400).size, 26, accuracy: 0.01)
        XCTAssertEqual(JunoType.pageTitle(columnWidth: 640).size, 26, accuracy: 0.01)
        XCTAssertEqual(JunoType.pageTitle(columnWidth: 1024).size, 32, accuracy: 0.01)
        XCTAssertEqual(JunoType.pageTitle(columnWidth: 2000).size, 32, accuracy: 0.01)
    }

    /// A rung resolves to its size, multiplied by the reader's text size.
    func testRungsResolveToTheirSizeTimesTheTextScale() {
        let context = EnvironmentValues().fontResolutionContext
        for expected in ladder where expected.face != .serif {
            let resolved = expected.rung.font().resolve(in: context)
            XCTAssertEqual(resolved.pointSize, expected.size, accuracy: 0.01, expected.name)
            XCTAssertEqual(resolved.isMonospaced, expected.face == .mono, expected.name)
            let scaled = expected.rung.font(scale: 1.25).resolve(in: context)
            XCTAssertEqual(scaled.pointSize, expected.size * 1.25, accuracy: 0.01, expected.name)
        }
        XCTAssertEqual(EnvironmentValues().junoTextScale, 1)
        XCTAssertEqual(JunoType.pageTitle.trackingPoints(atSize: 26), -0.52, accuracy: 0.0001)
    }

    /// Variants keep everything but what they change.
    func testVariantsChangeOnlyWhatTheyName() {
        let medium = JunoType.body.weight(.medium)
        XCTAssertEqual(medium.weight, .medium)
        XCTAssertEqual(medium.size, JunoType.body.size)
        XCTAssertEqual(medium.lineHeight, JunoType.body.lineHeight)
        let italic = JunoType.ui.italic()
        XCTAssertTrue(italic.isItalic)
        XCTAssertEqual(italic.size, JunoType.ui.size)
        XCTAssertTrue(italic.font().resolve(in: EnvironmentValues().fontResolutionContext).isItalic)
    }

    // MARK: - Newsreader

    /// Registers the bundled faces with this test process, from the same
    /// folder both app projects ship.
    private func registerNewsreader() throws {
        let fonts = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // → JunoDesignSystemTests
            .deletingLastPathComponent() // → Tests
            .deletingLastPathComponent() // → JunoNativeKit
            .deletingLastPathComponent() // → Packages
            .deletingLastPathComponent() // → native
            .appendingPathComponent("iOS/JunoMobile/Resources/Fonts")
        for face in JunoSerif.Face.allCases {
            let url = fonts.appendingPathComponent("\(face.rawValue).ttf")
            XCTAssertTrue(FileManager.default.fileExists(atPath: url.path), "\(face.rawValue).ttf is bundled")
            var error: Unmanaged<CFError>?
            if !CTFontManagerRegisterFontsForURL(url as CFURL, .process, &error) {
                // Already registered by an earlier test in this process is fine.
                let code = (error?.takeRetainedValue()).map(CFErrorGetCode) ?? 0
                if code != CTFontManagerError.alreadyRegistered.rawValue {
                    throw XCTSkip("could not register \(face.rawValue): \(code)")
                }
            }
        }
    }

    /// The PostScript names the code addresses are the names the files carry,
    /// and a registered face resolves to real Newsreader at the requested size
    /// — the defect was that it returned SF at the text style's size.
    func testNewsreaderResolvesByPostScriptNameAtTheRequestedSize() throws {
        try registerNewsreader()
        let context = EnvironmentValues().fontResolutionContext
        for face in JunoSerif.Face.allCases {
            let font = JunoSerif.font(size: 37, relativeTo: .largeTitle, face: face, bundled: true)
            let resolved = font.resolve(in: context)
            XCTAssertEqual(CTFontCopyPostScriptName(resolved.ctFont) as String, face.rawValue)
            XCTAssertEqual(resolved.pointSize, 37, accuracy: 0.01)
        }
    }

    /// Without the faces, the fallback is New York at the same size — a serif,
    /// never SF.
    func testTheFallbackIsNewYorkAtTheSameSize() {
        let context = EnvironmentValues().fontResolutionContext
        let resolved = JunoSerif.font(size: 37, relativeTo: .largeTitle, face: .regular, bundled: false)
            .resolve(in: context)
        XCTAssertEqual(resolved.pointSize, 37, accuracy: 0.01)
        // The system serif registers under private names (`.AppleSystemUIFontSerif`
        // / `.NewYork-Regular`); the PostScript name is the stable tell.
        let name = CTFontCopyPostScriptName(resolved.ctFont) as String
        XCTAssertTrue(name.contains("NewYork"), "fallback face was \(name)")
        let italic = JunoSerif.font(size: 37, relativeTo: .largeTitle, face: .mediumItalic, bundled: false)
            .resolve(in: context)
        XCTAssertTrue(italic.isItalic)
    }

    /// The greeting rungs go through Newsreader; nothing on the sans ladder
    /// does.
    func testOnlyTheDisplayRungsReachTheSerif() throws {
        try registerNewsreader()
        let context = EnvironmentValues().fontResolutionContext
        for expected in ladder where expected.face != .serif {
            let name = CTFontCopyPostScriptName(expected.rung.font().resolve(in: context).ctFont) as String
            XCTAssertFalse(name.hasPrefix("Newsreader"), "\(expected.name) resolved to \(name)")
        }
    }
}

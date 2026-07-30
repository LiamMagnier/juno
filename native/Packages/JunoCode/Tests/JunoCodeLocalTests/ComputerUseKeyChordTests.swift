import CoreGraphics
import XCTest
@testable import JunoCodeLocal

/// The key vocabulary `computer_press_key` can actually express.
///
/// Before chords and characters existed here, the table held the navigation keys
/// and the *standalone* modifiers and nothing else — so an agent driving the
/// screen could press Tab, Escape and the arrows, but not ⌘S, not ⌘C, and not the
/// letter `a`. Almost every real keyboard interaction in a Mac app is a chord or a
/// character, which made the tool close to useless in practice.
final class ComputerUseKeyChordTests: XCTestCase {

    private func resolve(_ key: String) throws -> (CGKeyCode, CGEventFlags) {
        try SystemComputerUseDriver.resolveChord(key)
    }

    // MARK: - Chords

    func testCommandChordCarriesTheCommandFlag() throws {
        let (code, flags) = try resolve("cmd+s")
        XCTAssertEqual(code, 1, "s is kVK_ANSI_S")
        XCTAssertTrue(flags.contains(.maskCommand))
    }

    func testMultipleModifiersAccumulate() throws {
        let (code, flags) = try resolve("cmd+shift+p")
        XCTAssertEqual(code, 35, "p is kVK_ANSI_P")
        XCTAssertTrue(flags.contains(.maskCommand))
        XCTAssertTrue(flags.contains(.maskShift))
    }

    /// Every spelling a model is likely to produce for the same physical key.
    func testModifierAliasesAllResolve() throws {
        for spelling in ["cmd+a", "command+a", "meta+a", "super+a"] {
            let (_, flags) = try resolve(spelling)
            XCTAssertTrue(
                flags.contains(.maskCommand),
                "\(spelling) should mean Command"
            )
        }
        for spelling in ["opt+a", "option+a", "alt+a"] {
            let (_, flags) = try resolve(spelling)
            XCTAssertTrue(flags.contains(.maskAlternate), "\(spelling) should mean Option")
        }
        for spelling in ["ctrl+a", "control+a"] {
            let (_, flags) = try resolve(spelling)
            XCTAssertTrue(flags.contains(.maskControl), "\(spelling) should mean Control")
        }
    }

    /// Both separators parse, because models write either.
    func testHyphenSeparatedChordsParseToo() throws {
        let (code, flags) = try resolve("cmd-c")
        XCTAssertEqual(code, 8, "c is kVK_ANSI_C")
        XCTAssertTrue(flags.contains(.maskCommand))
    }

    // MARK: - Single keys

    func testLettersAndDigitsResolve() throws {
        XCTAssertEqual(try resolve("a").0, 0)
        XCTAssertEqual(try resolve("z").0, 6)
        XCTAssertEqual(try resolve("0").0, 29)
        XCTAssertEqual(try resolve("9").0, 25)
    }

    func testASingleKeyCarriesNoModifiers() throws {
        let (code, flags) = try resolve("return")
        XCTAssertEqual(code, 36)
        XCTAssertTrue(flags.isEmpty)
    }

    /// Holding one modifier is occasionally the whole gesture, so a bare modifier
    /// still resolves to its own key code rather than becoming a flag.
    func testABareModifierIsStillAKey() throws {
        let (code, flags) = try resolve("shift")
        XCTAssertEqual(code, 56)
        XCTAssertTrue(flags.isEmpty)
    }

    func testKeysAreCaseAndWhitespaceInsensitive() throws {
        XCTAssertEqual(try resolve("  CMD+S  ").0, try resolve("cmd+s").0)
        XCTAssertEqual(try resolve("Return").0, 36)
    }

    // MARK: - Refusals

    func testAnUnknownKeyIsRefusedRatherThanGuessed() {
        XCTAssertThrowsError(try resolve("hyperspace"))
    }

    func testAnUnknownModifierIsRefused() {
        XCTAssertThrowsError(try resolve("hyper+s"))
    }

    func testAnEmptyKeyIsRefused() {
        XCTAssertThrowsError(try resolve("   "))
    }
}

#if os(macOS)
import Carbon.HIToolbox
import XCTest
@testable import JunoScreenControl

/// Layout-aware chords (CU-02). Layouts are loaded by input-source id from
/// the installed list; the system layout is never switched.
@MainActor
final class KeyboardLayoutMapperTests: XCTestCase {
    private func layout(_ id: String) throws -> KeyboardLayout {
        do {
            return try KeyboardLayoutMapper.layout(inputSourceID: id)
        } catch {
            throw XCTSkip("\(id) is not installed on this Mac.")
        }
    }

    /// On French AZERTY the US "A" key types "q". The old table sent key code
    /// 0 for cmd+a, which on the owner's Mac pressed ⌘Q and quit the app.
    func testFrenchCommandChordsUseTheKeysThatTypeTheirLetters() throws {
        let french = try layout("com.apple.keylayout.French")
        let a = try french.resolve(chord: "cmd+a")
        XCTAssertEqual(a.keyCode, UInt16(kVK_ANSI_Q), "a is where US has Q")
        XCTAssertEqual(a.modifiers, .command)
        XCTAssertNotEqual(a.keyCode, UInt16(kVK_ANSI_A), "key code 0 is q on AZERTY: ⌘Q")
        XCTAssertEqual(try french.resolve(chord: "cmd+z").keyCode, UInt16(kVK_ANSI_W), "z is where US has W")
        XCTAssertEqual(try french.resolve(chord: "cmd+w").keyCode, UInt16(kVK_ANSI_Z), "w is where US has Z")
        XCTAssertEqual(try french.resolve(chord: "cmd+m").keyCode, UInt16(kVK_ANSI_Semicolon), "m is where US has ;")
        XCTAssertEqual(try french.resolve(chord: "cmd+q").keyCode, UInt16(kVK_ANSI_A), "q is where US has A")
    }

    func testFrenchDigitsNeedShiftAndKeepIt() throws {
        let french = try layout("com.apple.keylayout.French")
        // On AZERTY the top row types & é " ' without shift; digits need it.
        let one = try french.resolve(chord: "cmd+1")
        XCTAssertEqual(one.keyCode, UInt16(kVK_ANSI_1))
        XCTAssertTrue(one.modifiers.contains(.shift))
        XCTAssertTrue(one.modifiers.contains(.command))
    }

    func testDvorakChordsUseTheDvorakPositions() throws {
        let dvorak = try layout("com.apple.keylayout.Dvorak")
        XCTAssertEqual(try dvorak.resolve(chord: "cmd+a").keyCode, UInt16(kVK_ANSI_A), "a stays home on Dvorak")
        XCTAssertEqual(try dvorak.resolve(chord: "cmd+z").keyCode, UInt16(kVK_ANSI_Slash))
        XCTAssertEqual(try dvorak.resolve(chord: "cmd+w").keyCode, UInt16(kVK_ANSI_Comma))
        XCTAssertEqual(try dvorak.resolve(chord: "cmd+s").keyCode, UInt16(kVK_ANSI_Semicolon))
        XCTAssertEqual(try dvorak.resolve(chord: "cmd+m").keyCode, UInt16(kVK_ANSI_M))
    }

    func testEveryMappedCharacterTypesItselfBack() throws {
        for id in ["com.apple.keylayout.US", "com.apple.keylayout.French", "com.apple.keylayout.Dvorak"] {
            let layout = try layout(id)
            XCTAssertGreaterThan(layout.strokes.count, 60, id)
            for letter in "abcdefghijklmnopqrstuvwxyz" {
                XCTAssertNotNil(layout.stroke(for: letter), "\(id) types \(letter)")
                XCTAssertEqual(layout.stroke(for: letter)?.modifiers, [], "\(id) types \(letter) without modifiers")
            }
        }
    }

    func testAnUnmappableCharacterIsANamedError() throws {
        let us = try layout("com.apple.keylayout.US")
        XCTAssertThrowsError(try us.resolve(chord: "cmd+ж")) { error in
            guard case let KeyboardLayoutError.unmappable(character, layout) = error else {
                return XCTFail("\(error)")
            }
            XCTAssertEqual(character, "ж")
            XCTAssertFalse(layout.isEmpty)
            XCTAssertTrue((error as? LocalizedError)?.errorDescription?.contains("Type it with the type action") == true)
        }
    }

    func testNamedKeysKeepTheirPhysicalCodesOnEveryLayout() throws {
        let french = try layout("com.apple.keylayout.French")
        XCTAssertEqual(try french.resolve(chord: "Return").keyCode, UInt16(kVK_Return))
        XCTAssertEqual(try french.resolve(chord: "cmd+Return").modifiers, .command)
        XCTAssertEqual(try french.resolve(chord: "Escape").keyCode, UInt16(kVK_Escape))
        XCTAssertEqual(try french.resolve(chord: "BackSpace").keyCode, UInt16(kVK_Delete))
        XCTAssertEqual(try french.resolve(chord: "forward_delete").keyCode, UInt16(kVK_ForwardDelete))
        XCTAssertEqual(try french.resolve(chord: "Page_Down").keyCode, UInt16(kVK_PageDown))
        XCTAssertEqual(try french.resolve(chord: "F5").keyCode, UInt16(kVK_F5))
    }
}

/// Chord parsing, which does not need a layout.
final class KeyChordTests: XCTestCase {
    func testChordsParse() throws {
        XCTAssertEqual(try KeyChord.parse("cmd+shift+s"), KeyChord(modifiers: [.command, .shift], key: .character("s")))
        XCTAssertEqual(try KeyChord.parse("ctrl+Return"), KeyChord(modifiers: .control, key: .named(.return)))
        XCTAssertEqual(try KeyChord.parse("super+a"), KeyChord(modifiers: .command, key: .character("a")))
        XCTAssertEqual(try KeyChord.parse("cmd+A"), KeyChord(modifiers: .command, key: .character("a")), "letters are case-free")
    }

    func testMinusAndPlusAreKeys() throws {
        XCTAssertEqual(try KeyChord.parse("cmd+-"), KeyChord(modifiers: .command, key: .character("-")))
        XCTAssertEqual(try KeyChord.parse("cmd++"), KeyChord(modifiers: .command, key: .character("+")))
        XCTAssertEqual(try KeyChord.parse("+"), KeyChord(modifiers: [], key: .character("+")))
    }

    func testABareModifierIsAKey() throws {
        XCTAssertEqual(try KeyChord.parse("shift"), KeyChord(modifiers: [], key: .named(.shift)))
    }

    func testBadChordsAreRefusedBySentence() {
        XCTAssertThrowsError(try KeyChord.parse("")) { XCTAssertEqual($0 as? KeyboardLayoutError, .emptyChord) }
        XCTAssertThrowsError(try KeyChord.parse("hyper+a")) { XCTAssertEqual($0 as? KeyboardLayoutError, .unknownModifier("hyper")) }
        XCTAssertThrowsError(try KeyChord.parse("cmd+banana")) { XCTAssertEqual($0 as? KeyboardLayoutError, .unknownKey("banana")) }
    }

    func testTheUSFallbackTable() throws {
        let us = KeyboardLayout.usANSI
        XCTAssertEqual(try us.resolve(chord: "cmd+a").keyCode, 0)
        XCTAssertEqual(try us.resolve(chord: "cmd+?").modifiers, [.command, .shift])
    }
}
#endif

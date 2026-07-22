import SwiftUI
import XCTest
@testable import JunoMac

final class JunoMacProductModeTests: XCTestCase {
    func testChatIsTheFirstAndDefaultMode() {
        XCTAssertEqual(JunoMacProductMode.allCases.first, .chat)
        XCTAssertEqual(JunoMacProductMode.restored(from: "chat"), .chat)
    }

    func testBothProductsAreReachable() {
        XCTAssertEqual(JunoMacProductMode.allCases, [.chat, .code])
    }

    /// Scene storage holds a raw string, so a value written by an older or a
    /// newer build must land on Chat rather than leaving the window on a mode
    /// the app cannot render.
    func testUnknownStoredValuesFallBackToChat() {
        for raw in ["", "code2", "CHAT", "remote", "🙂"] {
            XCTAssertEqual(
                JunoMacProductMode.restored(from: raw),
                .chat,
                "\(raw) should fall back to Chat"
            )
        }
    }

    func testRoundTripsThroughItsRawValue() {
        for mode in JunoMacProductMode.allCases {
            XCTAssertEqual(JunoMacProductMode.restored(from: mode.rawValue), mode)
        }
    }

    func testEveryModeHasASymbolAndDistinctLabels() {
        XCTAssertTrue(JunoMacProductMode.allCases.allSatisfy { !$0.systemImage.isEmpty })
        let titles = JunoMacProductMode.allCases.map(\.shortTitle)
        XCTAssertEqual(Set(titles).count, titles.count)
        XCTAssertTrue(titles.allSatisfy { !$0.isEmpty }, "labels stay visible")
    }

    /// ⌘1 and ⌘2 belong to the product switch. The Chat destinations moved to
    /// ⌥⌘n so nothing collides; Settings keeps the conventional plain ⌘,.
    func testModeShortcutsDoNotCollideWithSectionShortcuts() {
        let modeShortcuts = JunoMacProductMode.allCases.map {
            String($0.keyboardShortcut.character)
        }
        XCTAssertEqual(Set(modeShortcuts).count, modeShortcuts.count)

        for section in JunoMacSection.allCases {
            let character = String(section.keyboardShortcut.character)
            guard modeShortcuts.contains(character) else { continue }
            XCTAssertNotEqual(
                section.keyboardModifiers,
                EventModifiers.command,
                "\(section.rawValue) would collide with a product-mode shortcut"
            )
        }
    }

    func testSettingsKeepsThePlainCommandComma() {
        XCTAssertEqual(JunoMacSection.settings.keyboardModifiers, .command)
        XCTAssertEqual(String(JunoMacSection.settings.keyboardShortcut.character), ",")
    }

    /// Juno Code is a mode, not a destination — it brings its own sidebar and
    /// workspace rather than filling Chat's detail column.
    func testCodeIsNotAChatSection() {
        XCTAssertFalse(JunoMacSection.allCases.map(\.rawValue).contains("code"))
    }
}

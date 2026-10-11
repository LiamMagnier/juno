import XCTest
@testable import JunoChatKit

@MainActor
final class NativeSuggestionCursorTests: XCTestCase {
    func testKeyboardSelectionWrapsAndEscapeClosesUntilQueryChanges() {
        let cursor = NativeSuggestionCursor()
        var chosen: [String] = []
        cursor.configure(query: "git", actions: [{ chosen.append("first") }, { chosen.append("second") }])
        cursor.move(-1)
        XCTAssertTrue(cursor.pick())
        XCTAssertEqual(chosen, ["second"])
        cursor.move(1)
        XCTAssertTrue(cursor.pick())
        XCTAssertEqual(chosen, ["second", "first"])
        cursor.dismiss(query: "git")
        XCTAssertFalse(cursor.isOpen(for: "git"))
        cursor.configure(query: "github", actions: [])
        XCTAssertTrue(cursor.isOpen(for: "github"))
        XCTAssertFalse(cursor.pick())
        XCTAssertFalse(cursor.isOpen(for: nil))
    }

    func testSlashMatchesOnlyABareLeadingTokenAndMentionsIgnoreEmailAddresses() {
        XCTAssertEqual(NativeSlashQuery.query(in: "/Research"), "research")
        XCTAssertNil(NativeSlashQuery.query(in: "/usr/local"))
        XCTAssertNil(NativeSlashQuery.query(in: "/research this"))
        XCTAssertEqual(NativeContextMention.query(in: "Ask @git"), "git")
        XCTAssertNil(NativeContextMention.query(in: "name@example.com"))
    }
}

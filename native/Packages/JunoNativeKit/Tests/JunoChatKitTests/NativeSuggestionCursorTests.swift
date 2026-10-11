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

    func testKeyboardSkipsDisconnectedEntriesInBothDirections() {
        let cursor = NativeSuggestionCursor()
        var picked = ""
        cursor.configure(query: "", actions: [nil, { picked = "file" }, nil, { picked = "app" }])
        XCTAssertEqual(cursor.selectedIndex, 1)
        cursor.move(-1)
        XCTAssertEqual(cursor.selectedIndex, 3)
        XCTAssertTrue(cursor.pick())
        XCTAssertEqual(picked, "app")
        cursor.move(1)
        XCTAssertEqual(cursor.selectedIndex, 1)
        cursor.configure(query: "none", actions: [nil, nil])
        cursor.move(1)
        XCTAssertFalse(cursor.pick())
    }

    func testSlashMatchesOnlyABareLeadingTokenAndMentionsIgnoreEmailAddresses() {
        XCTAssertEqual(NativeSlashQuery.query(in: "/Research"), "research")
        XCTAssertEqual(NativeSlashQuery.query(in: "/model GPT"), "model gpt")
        let commands: [NativeComposerCommand] = [.init("model", hint: "Switch"), .init("model:openai:gpt", hint: "openai", category: "Models", label: "GPT"), .init("tidy-inbox", hint: "File invoices", category: "Skills")]
        XCTAssertEqual(NativeComposerCommand.matching(commands, query: "").map(\.id), ["model", "tidy-inbox"])
        XCTAssertEqual(NativeComposerCommand.matching(commands, query: "model gpt").map(\.id), ["model:openai:gpt"])
        XCTAssertEqual(NativeComposerCommand.matching(commands, query: "invoice").map(\.id), ["tidy-inbox"])
        XCTAssertNil(NativeSlashQuery.query(in: "/usr/local"))
        XCTAssertNil(NativeSlashQuery.query(in: "/research this"))
        XCTAssertEqual(NativeContextMention.query(in: "Ask @git"), "git")
        XCTAssertNil(NativeContextMention.query(in: "name@example.com"))
    }
}

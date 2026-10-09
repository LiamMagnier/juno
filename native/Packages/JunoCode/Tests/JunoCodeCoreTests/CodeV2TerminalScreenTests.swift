import XCTest
@testable import JunoCodeCore

final class CodeV2TerminalScreenTests: XCTestCase {
    func testColoursAndTitlesAreDroppedNotPrinted() {
        var screen = CodeV2TerminalScreen()
        screen.feed("\u{1B}]0;~/repo\u{07}\u{1B}[1;32m✓\u{1B}[0m passed\r\n\u{1B}[?2004h$ ")
        XCTAssertEqual(screen.text, "✓ passed\n$ ")
    }

    func testCarriageReturnOverwritesAndEraseInLineClears() {
        var screen = CodeV2TerminalScreen()
        screen.feed("Progress 10%\rProgress 100%\r\n")
        screen.feed("abcdef\r\u{1B}[Kxy\r\n")
        XCTAssertEqual(screen.text, "Progress 100%\nxy")
    }

    func testBackspaceTabAndCursorMoves() {
        var screen = CodeV2TerminalScreen()
        screen.feed("ab\u{08}c\tz\r\n")
        screen.feed("hello\u{1B}[3Dy\u{1B}[1GH")
        XCTAssertEqual(screen.text, "ac      z\nHeylo")
    }

    func testSequencesSplitAcrossChunksStillApply() {
        var whole = CodeV2TerminalScreen()
        let stream = "one\u{1B}[31mred\u{1B}[0m\r\ntwo\u{1B}]2;title\u{1B}\\three\r\n"
        whole.feed(stream)
        var sliced = CodeV2TerminalScreen()
        for character in stream { sliced.feed(String(character)) }
        XCTAssertEqual(whole, sliced)
        XCTAssertEqual(sliced.text, "onered\ntwothree")
    }

    func testClearScreenAndScrollbackLimit() {
        var screen = CodeV2TerminalScreen(maximumLines: 10)
        for index in 0..<25 { screen.feed("line \(index)\r\n") }
        XCTAssertEqual(screen.lines.count, 10)
        XCTAssertEqual(screen.droppedLines, 16)
        XCTAssertTrue(screen.text.hasPrefix("line 16"))
        screen.feed("\u{1B}[H\u{1B}[2Jfresh")
        XCTAssertEqual(screen.text, "fresh")
    }
}

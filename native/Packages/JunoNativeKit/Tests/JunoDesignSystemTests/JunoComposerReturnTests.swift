import SwiftUI
import XCTest
@testable import JunoDesignSystem
#if canImport(AppKit)
import AppKit
#endif

/// One Return rule for every composer: Return sends, Shift-Return and
/// Option-Return break the line, and an input method's Return is its own.
final class JunoComposerReturnTests: XCTestCase {
    func testReturnSends() {
        XCTAssertEqual(JunoComposerReturn.resolve(shift: false, option: false, composing: false), .send)
        XCTAssertEqual(JunoComposerReturn.resolve([], composing: false), .send)
        // Command-Return is still a send (it steers a running Code turn).
        XCTAssertEqual(JunoComposerReturn.resolve(.command, composing: false), .send)
    }

    func testShiftAndOptionReturnBreakTheLine() {
        XCTAssertEqual(JunoComposerReturn.resolve(.shift, composing: false), .newline)
        XCTAssertEqual(JunoComposerReturn.resolve(.option, composing: false), .newline)
        XCTAssertEqual(JunoComposerReturn.resolve([.shift, .option], composing: false), .newline)
    }

    func testAnInputMethodsReturnNeverSendsOrBreaks() {
        XCTAssertEqual(JunoComposerReturn.resolve([], composing: true), .inputMethod)
        XCTAssertEqual(JunoComposerReturn.resolve(.shift, composing: true), .inputMethod)
        XCTAssertEqual(JunoComposerReturn.resolve(.command, composing: true), .inputMethod)
    }

    #if canImport(AppKit)
    @MainActor
    func testTheBreakGoesAtTheCaretAndReplacesTheSelection() {
        let editor = NSTextView(frame: .init(x: 0, y: 0, width: 200, height: 40))
        editor.string = "first second"
        editor.setSelectedRange(NSRange(location: 5, length: 1))
        XCTAssertTrue(JunoTextEditing.insertLineBreak(in: editor))
        XCTAssertEqual(editor.string, "first\nsecond")
        XCTAssertEqual(editor.selectedRange(), NSRange(location: 6, length: 0))
        XCTAssertFalse(JunoTextEditing.insertLineBreak(in: nil), "no focused field: the key is let through")
        editor.isEditable = false
        XCTAssertFalse(JunoTextEditing.insertLineBreak(in: editor))
    }

    @MainActor
    func testMarkedTextIsComposition() {
        let editor = NSTextView(frame: .init(x: 0, y: 0, width: 200, height: 40))
        editor.setMarkedText("にほ", selectedRange: NSRange(location: 2, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
        XCTAssertTrue(editor.hasMarkedText(), "the state JunoTextEditing.isComposing reads from the focused editor")
    }
    #endif
}

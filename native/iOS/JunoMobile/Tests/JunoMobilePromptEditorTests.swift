import Foundation
import XCTest
@testable import JunoMobile

/// When the composer offers the full-screen editor: once its field is at the
/// six-line cap, measured or plainly counted, and never for an empty draft.
final class JunoMobilePromptEditorTests: XCTestCase {
  private let line: CGFloat = 20.29

  func testAnEmptyOrBlankDraftNeverOffersIt() {
    XCTAssertFalse(JunoMobilePromptEditorOffer.offers(prompt: "", fieldHeight: line * 6, lineHeight: line))
    XCTAssertFalse(JunoMobilePromptEditorOffer.offers(prompt: "  \n\n ", fieldHeight: line * 6, lineHeight: line))
  }

  func testAFieldBelowItsCapDoesNotOfferIt() {
    let prompt = "A paragraph that wraps a few times but has not reached the cap."
    XCTAssertFalse(JunoMobilePromptEditorOffer.offers(prompt: prompt, fieldHeight: line, lineHeight: line))
    XCTAssertFalse(JunoMobilePromptEditorOffer.offers(prompt: prompt, fieldHeight: line * 5, lineHeight: line))
  }

  func testAFieldMeasuredAtItsCapOffersIt() {
    let prompt = String(repeating: "wrapping words ", count: 40)
    XCTAssertTrue(JunoMobilePromptEditorOffer.offers(prompt: prompt, fieldHeight: line * 6, lineHeight: line))
    // Rounding in layout must not hide it.
    XCTAssertTrue(JunoMobilePromptEditorOffer.offers(prompt: prompt, fieldHeight: line * 6 - 4, lineHeight: line))
  }

  func testSixWrittenLinesOfferItBeforeLayoutHasMeasured() {
    let prompt = (1...6).map { "Line \($0)" }.joined(separator: "\n")
    XCTAssertEqual(JunoMobilePromptEditorOffer.lineCount(prompt), 6)
    XCTAssertTrue(JunoMobilePromptEditorOffer.offers(prompt: prompt, fieldHeight: 0, lineHeight: line))
    let five = (1...5).map { "Line \($0)" }.joined(separator: "\n")
    XCTAssertFalse(JunoMobilePromptEditorOffer.offers(prompt: five, fieldHeight: 0, lineHeight: line))
  }

  func testWindowsLineEndingsCountOnce() {
    XCTAssertEqual(JunoMobilePromptEditorOffer.lineCount("a\r\nb\r\nc"), 3)
  }

  func testLargerTextScalesTheCapWithIt() {
    // At a larger Dynamic Type size both the line and the field grow; five
    // large lines are still below the cap.
    let large: CGFloat = 34
    let prompt = String(repeating: "wrapping words ", count: 40)
    XCTAssertFalse(JunoMobilePromptEditorOffer.offers(prompt: prompt, fieldHeight: line * 6, lineHeight: large))
    XCTAssertTrue(JunoMobilePromptEditorOffer.offers(prompt: prompt, fieldHeight: large * 6, lineHeight: large))
  }
}

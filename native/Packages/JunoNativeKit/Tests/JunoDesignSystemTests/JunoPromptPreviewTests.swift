import XCTest
@testable import JunoDesignSystem

final class JunoPromptPreviewTests: XCTestCase {
    func testShowsProseInsteadOfStructuralTags() {
        XCTAssertEqual(
            JunoPromptPreview.text(
                "<role> You are a research assistant. </role>\n<context>Use primary sources.</context>"
            ),
            "You are a research assistant. Use primary sources."
        )
    }

    func testKeepsOrdinaryComparisonText() {
        XCTAssertEqual(
            JunoPromptPreview.text("Keep a < b, x <= 3, and arrows -> intact."),
            "Keep a < b, x <= 3, and arrows -> intact."
        )
    }

    func testUsesCallerFallbackForEmptyInput() {
        XCTAssertEqual(JunoPromptPreview.text(" \n\t ", fallback: "Nothing here."), "Nothing here.")
    }
}

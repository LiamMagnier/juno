import XCTest

@testable import JunoChatKit

/// Guards the fix for `<juno:memory>` markers rendering into the transcript.
final class NativeMessageContentTests: XCTestCase {
    func testMemoryTagsAreRemovedWithTheirContents() {
        let raw = """
        Here is the answer.

        <juno:memory>The user is following a structured JavaScript curriculum.</juno:memory>
        """
        XCTAssertEqual(NativeMessageContent.cleanForDisplay(raw), "Here is the answer.")
    }

    func testProseAroundAMemoryTagSurvives() {
        let raw = "Before.<juno:memory>fact</juno:memory>After."
        XCTAssertEqual(NativeMessageContent.cleanForDisplay(raw), "Before.After.")
    }

    func testSeveralMemoriesAreAllRemoved() {
        let raw = "A<juno:memory>one</juno:memory>B<juno:memory>two</juno:memory>C"
        XCTAssertEqual(NativeMessageContent.cleanForDisplay(raw), "ABC")
    }

    /// A reply renders while it streams, so the opening tag lands many frames
    /// before its close. Without this the raw tag flashes on screen mid-answer.
    func testAnUnclosedMemoryTagIsHiddenWhileStreaming() {
        let raw = "The answer.\n\n<juno:memory>The user is fol"
        XCTAssertEqual(NativeMessageContent.cleanForDisplay(raw), "The answer.")
    }

    func testClarificationWizardBlocksAreRemoved() {
        let raw = "Ask:\n:::clarification-wizard\nquestion: pick one\n:::\nDone."
        XCTAssertEqual(NativeMessageContent.cleanForDisplay(raw), "Ask:\n\nDone.")
    }

    /// Ordinary text must pass through untouched — including angle brackets and
    /// code fences that merely look like markup.
    func testOrdinaryTextIsUnchanged() {
        let raw = "Use `a < b` and <div> in HTML."
        XCTAssertEqual(NativeMessageContent.cleanForDisplay(raw), raw)
    }

    func testAMessageThatIsOnlyAMemoryRendersEmpty() {
        XCTAssertEqual(
            NativeMessageContent.cleanForDisplay("<juno:memory>only</juno:memory>"), ""
        )
    }
}

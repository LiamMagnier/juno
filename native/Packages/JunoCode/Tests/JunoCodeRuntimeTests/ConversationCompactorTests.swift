import XCTest
import JunoCodeCore
@testable import JunoCodeRuntime

final class ConversationCompactorTests: XCTestCase {
    func testCompactionRetainsOriginalRequestAndRecentToolSequence() throws {
        let messages: [ModelMessage] = [
            .user("Build the dashboard"),
            .assistant("I inspected the existing app."),
            .toolCall(id: "old-1", name: "read_file", input: ["path": "README.md"]),
            .toolResult(id: "old-1", content: "old contents", isError: false),
            .user("Now add the chart"),
            .assistant("I am wiring the chart."),
            .user("Run the checks"),
            .assistant("I will run the checks."),
            .toolCall(id: "latest-1", name: "run_command", input: ["command": "npm test"]),
            .toolResult(id: "latest-1", content: "all tests passed", isError: false),
        ]

        let result = try XCTUnwrap(
            ConversationCompactor.compact(
                messages,
                maximumBytes: 1,
                recentTurns: 1
            )
        )

        guard case let .user(anchor) = result.messages.first else {
            return XCTFail("the original user request must remain the anchor")
        }
        XCTAssertTrue(anchor.hasPrefix("Build the dashboard"))
        XCTAssertTrue(anchor.contains("[Juno retained context]"))
        XCTAssertTrue(result.summary.contains("add the chart"))
        XCTAssertEqual(result.removedMessageCount, 5)

        guard result.messages.count >= 5 else {
            return XCTFail("the recent user-led sequence was dropped")
        }
        if case .user("Run the checks") = result.messages[1] {
            // Expected: the newest user turn starts the retained sequence.
        } else {
            XCTFail("the newest user turn must be retained")
        }
        if case .toolCall(id: "latest-1", name: "run_command", input: _) = result.messages[3] {
            // The tool call remains paired with its result.
        } else {
            XCTFail("the newest tool call must remain in the retained sequence")
        }
        if case .toolResult(id: "latest-1", content: "all tests passed", isError: false) =
            result.messages[4]
        {
            // Expected.
        } else {
            XCTFail("the newest tool result must remain paired with its call")
        }
    }

    func testCompactionSummarizesImagesWithoutPersistingImageBytes() throws {
        let image = ModelImage(
            mediaType: "image/png",
            data: Data(repeating: 0xFF, count: 2048),
            detail: .high
        )
        let messages: [ModelMessage] = [
            .user("Inspect this screenshot"),
            .userWithImages("The screenshot is attached", [image]),
            .assistant("I found the broken layout."),
            .user("Fix it"),
        ]

        let result = try XCTUnwrap(
            ConversationCompactor.compact(
                messages,
                maximumBytes: 1,
                recentTurns: 1
            )
        )

        XCTAssertTrue(result.summary.contains("attached image"))
        XCTAssertFalse(result.summary.contains("FF"))
        if case let .user(anchor) = result.messages[0] {
            XCTAssertFalse(anchor.contains("FF"))
        } else {
            XCTFail("expected a text anchor")
        }
    }

    func testForcedCompactionCanReduceAConversationBelowTheByteGuard() throws {
        let messages: [ModelMessage] = [
            .user("Original request"),
            .assistant("The first pass is complete."),
            .user("Continue"),
            .assistant("The second pass is complete."),
        ]

        let result = try XCTUnwrap(
            ConversationCompactor.compact(
                messages,
                maximumBytes: Int.max,
                recentTurns: 1,
                force: true
            )
        )

        XCTAssertTrue(result.summary.contains("first pass"))
        XCTAssertEqual(result.removedMessageCount, 1)
    }
}

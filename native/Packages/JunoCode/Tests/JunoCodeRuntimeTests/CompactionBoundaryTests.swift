import XCTest
import JunoCodeCore
@testable import JunoCodeRuntime

final class CompactionBoundaryTests: XCTestCase {
    /// One request followed by a long tool loop used to be uncompactable: the
    /// only cut point the compactor knew was a user message.
    func testASingleLongRequestCanBeCompacted() throws {
        var messages: [ModelMessage] = [.user("Refactor the parser")]
        for step in 0..<40 {
            messages.append(.assistant("Step \(step)"))
            messages.append(.toolCall(id: "c\(step)", name: "read_file", input: ["path": .string("f\(step).swift")]))
            messages.append(.toolResult(id: "c\(step)", content: String(repeating: "x", count: 2_000), isError: false))
        }
        let result = try XCTUnwrap(
            ConversationCompactor.compact(messages, maximumBytes: 20_000, recentTurns: 3)
        )
        XCTAssertTrue(ConversationIntegrity.isValid(result.messages))
        XCTAssertLessThan(result.messages.count, messages.count)
        guard case let .user(anchor) = result.messages[0] else { return XCTFail("anchor") }
        XCTAssertTrue(anchor.hasPrefix("Refactor the parser"))
        XCTAssertEqual(result.messages.last, messages.last)
    }

    /// A second compaction folds the first one's notes in rather than stacking
    /// another block onto the anchor, and keeps the newest notes.
    func testRecompactionFoldsEarlierNotes() throws {
        var messages: [ModelMessage] = [.user("Task")]
        for step in 0..<12 {
            messages.append(.user("turn \(step)"))
            messages.append(.assistant("answer \(step)"))
        }
        let first = try XCTUnwrap(ConversationCompactor.compact(messages, maximumBytes: 1, recentTurns: 2, force: true))
        let continued = first.messages + [.user("turn 12"), .assistant("answer 12"), .user("turn 13")]
        let second = try XCTUnwrap(ConversationCompactor.compact(continued, maximumBytes: 1, recentTurns: 1, force: true))
        guard case let .user(anchor) = second.messages[0] else { return XCTFail("anchor") }
        XCTAssertEqual(anchor.components(separatedBy: ConversationCompactor.retainedContextMarker).count, 2)
        XCTAssertTrue(anchor.contains("answer 0"))
        XCTAssertTrue(anchor.contains("answer 12"))
    }

    func testTightBudgetKeepsTheNewestNotes() throws {
        var messages: [ModelMessage] = [.user("Task")]
        for step in 0..<50 {
            messages.append(.user("question number \(step)"))
            messages.append(.assistant("reply number \(step)"))
        }
        let result = try XCTUnwrap(
            ConversationCompactor.compact(messages, maximumBytes: 1, recentTurns: 1, maximumSummaryCharacters: 400, force: true)
        )
        XCTAssertTrue(result.summary.contains("reply number 48"))
        XCTAssertFalse(result.summary.contains("reply number 1 "))
        XCTAssertTrue(result.summary.contains("dropped"))
    }
}

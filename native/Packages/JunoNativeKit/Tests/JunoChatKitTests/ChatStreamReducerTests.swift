import XCTest
@testable import JunoChatKit

final class ChatStreamReducerTests: XCTestCase {
    func testReducerBuildsStreamAndCompletes() throws {
        var state = ChatStreamState()
        XCTAssertEqual(try state.apply(.opened(sequence: 10, messageID: "message_1")), .applied)
        XCTAssertEqual(try state.apply(.textDelta(sequence: 11, text: "Hello")), .applied)
        XCTAssertEqual(try state.apply(.reasoningDelta(sequence: 12, text: "Checked")), .applied)
        XCTAssertEqual(try state.apply(.completed(sequence: 13)), .applied)
        XCTAssertEqual(state.text, "Hello")
        XCTAssertEqual(state.reasoning, "Checked")
        XCTAssertEqual(state.phase, .completed(messageID: "message_1"))
    }

    func testDuplicateEventIsIgnored() throws {
        var state = ChatStreamState()
        try state.apply(.opened(sequence: 1, messageID: "message_1"))
        XCTAssertEqual(try state.apply(.opened(sequence: 1, messageID: "message_1")), .duplicate)
        XCTAssertEqual(state.lastSequence, 1)
    }

    func testGapFailsWithoutAdvancingCursor() throws {
        var state = ChatStreamState()
        try state.apply(.opened(sequence: 4, messageID: "message_1"))
        XCTAssertThrowsError(try state.apply(.textDelta(sequence: 6, text: "late"))) {
            XCTAssertEqual(
                $0 as? ChatStreamReducerError,
                .sequenceGap(expected: 5, received: 6)
            )
        }
        XCTAssertEqual(state.lastSequence, 4)
    }

    func testTerminalStateRejectsNewEvents() throws {
        var state = ChatStreamState()
        try state.apply(.opened(sequence: 1, messageID: "message_1"))
        try state.apply(.cancelled(sequence: 2))
        XCTAssertThrowsError(try state.apply(.textDelta(sequence: 3, text: "ignored"))) {
            XCTAssertEqual($0 as? ChatStreamReducerError, .invalidTransition)
        }
    }
}

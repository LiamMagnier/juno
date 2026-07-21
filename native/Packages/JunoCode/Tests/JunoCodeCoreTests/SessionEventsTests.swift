import XCTest
@testable import JunoCodeCore

final class SessionEventsTests: XCTestCase {
    func testEventCodableRoundTrip() throws {
        let sessionID = CodeSessionID()
        let events: [SessionEventPayload] = [
            .userPrompt(UserPromptEvent(text: "Fix the parser")),
            .assistantMessage(AssistantMessageEvent(text: "Done.")),
            .toolProposed(
                ToolProposedEvent(
                    toolCallID: "call_1",
                    toolName: "read_file",
                    input: ["path": "src/parser.swift"],
                    risk: .read,
                    summary: "Read src/parser.swift"
                )
            ),
            .toolOutput(
                ToolOutputEvent(toolCallID: "call_1", channel: .stdout, text: "line")
            ),
            .toolCompleted(
                ToolCompletedEvent(
                    toolCallID: "call_1",
                    status: .succeeded,
                    resultSummary: "82 lines",
                    durationSeconds: 0.02
                )
            ),
            .fileChanged(
                FileChangedEvent(
                    path: try WorkspacePath("src/parser.swift"),
                    kind: .modified,
                    linesAdded: 4,
                    linesRemoved: 1,
                    checkpointID: "chk_1"
                )
            ),
            .statusChanged(StatusChangedEvent(status: .running)),
            .runCompleted(
                RunCompletedEvent(summary: "Fixed", filesChanged: 1, testsPassed: true, durationSeconds: 12)
            ),
        ]
        let encoder = JSONEncoder()
        let decoder = JSONDecoder()
        for (index, payload) in events.enumerated() {
            let event = SessionEvent(
                sessionID: sessionID,
                sequence: index,
                timestamp: Date(timeIntervalSince1970: 42),
                payload: payload
            )
            let data = try encoder.encode(event)
            let decoded = try decoder.decode(SessionEvent.self, from: data)
            XCTAssertEqual(decoded, event)
        }
    }

    func testTerminalAndActiveStatuses() {
        XCTAssertTrue(SessionStatus.completed.isTerminal)
        XCTAssertTrue(SessionStatus.failed.isTerminal)
        XCTAssertTrue(SessionStatus.cancelled.isTerminal)
        XCTAssertFalse(SessionStatus.running.isTerminal)
        XCTAssertTrue(SessionStatus.waitingForApproval.isActive)
        XCTAssertFalse(SessionStatus.idle.isActive)
        XCTAssertFalse(SessionStatus.completed.isActive)
    }
}

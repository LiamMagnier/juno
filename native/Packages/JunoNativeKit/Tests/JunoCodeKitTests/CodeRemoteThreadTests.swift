import Foundation
import JunoCore
import XCTest

@testable import JunoCodeKit

final class CodeRemoteThreadTests: XCTestCase {
    private func event(_ seq: Int, _ kind: String, _ payload: [String: JunoJSONValue] = [:]) -> CodeRemoteSessionEvent {
        CodeRemoteSessionEvent(
            seq: seq, kind: kind, payload: payload,
            createdAt: Date(timeIntervalSince1970: 1_700_000_000 + Double(seq))
        )
    }

    func testProseDeltasFoldIntoOneParagraph() {
        let thread = CodeRemoteThread.reduce([
            event(1, "user_message", ["text": .string("Fix the flaky test")]),
            event(2, "text_delta", ["text": .string("Looking ")]),
            event(3, "text_delta", ["delta": .string("at the suite")]),
            event(4, "text_delta", ["text": .string(" now.")]),
        ])

        XCTAssertEqual(thread.items.count, 2)
        guard case .userMessage(_, let prompt, _) = thread.items[0] else { return XCTFail("prompt first") }
        XCTAssertEqual(prompt, "Fix the flaky test")
        guard case .assistantText(_, let text) = thread.items[1] else { return XCTFail("prose second") }
        XCTAssertEqual(text, "Looking at the suite now.")
    }

    func testConsecutiveToolActivityGroupsIntoOneWorkLog() {
        let thread = CodeRemoteThread.reduce([
            event(1, "tool_start", ["toolCallId": .string("c1"), "name": .string("read_file"), "input": .string("src/a.ts")]),
            event(2, "tool_result", ["toolCallId": .string("c1"), "output": .string("42 lines")]),
            event(3, "tool_start", ["toolCallId": .string("c2"), "name": .string("shell"), "command": .string("npm test")]),
            event(4, "command_output", ["toolCallId": .string("c2"), "text": .string("1 passing")]),
            event(5, "tool_result", ["toolCallId": .string("c2"), "exitCode": .number(0)]),
            event(6, "text_delta", ["text": .string("All green.")]),
            event(7, "tool_start", ["toolCallId": .string("c3"), "name": .string("shell")]),
        ])

        XCTAssertEqual(thread.items.count, 3, "two work logs split by a paragraph")
        guard case .workLog(_, let activities) = thread.items[0] else { return XCTFail("work log first") }
        XCTAssertEqual(activities.map(\.id), ["c1", "c2"])
        XCTAssertEqual(activities[0].output, "42 lines")
        XCTAssertTrue(activities[0].isFinished)
        XCTAssertEqual(activities[1].output, "1 passing")
        XCTAssertEqual(activities[1].exitCode, 0)
        XCTAssertFalse(activities[1].isError)
        XCTAssertEqual(thread.terminalLines, ["42 lines", "1 passing"])
        guard case .workLog(_, let later) = thread.items[2] else { return XCTFail("work log last") }
        XCTAssertFalse(later[0].isFinished)
    }

    func testApprovalRequestIsResolvedInPlace() {
        var thread = CodeRemoteThread.reduce([
            event(1, "approval_request", ["requestId": .string("r1"), "summary": .string("Run rm -rf build"), "risk": .string("high")]),
        ])
        XCTAssertEqual(thread.pendingApproval?.requestID, "r1")

        thread = CodeRemoteThread.reduce([
            event(1, "approval_request", ["requestId": .string("r1"), "summary": .string("Run rm -rf build"), "risk": .string("high")]),
            event(2, "approval_response", ["requestId": .string("r1"), "approved": .bool(true)]),
        ])
        XCTAssertNil(thread.pendingApproval)
        XCTAssertEqual(thread.items.count, 1, "the decision updates the card rather than adding a row")
        guard case .approval(let approval) = thread.items[0] else { return XCTFail("approval card") }
        XCTAssertEqual(approval.approved, true)
    }

    func testFileChangesAndTestsAreCollected() {
        let thread = CodeRemoteThread.reduce([
            event(1, "file_change", ["path": .string("src/a.ts"), "changeKind": .string("edit"), "linesAdded": .number(3), "linesRemoved": .number(1), "diff": .string("--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y")]),
            event(2, "test_update", ["status": .string("running")]),
            event(3, "test_update", ["passed": .number(12), "failed": .number(0), "total": .number(12)]),
        ])

        XCTAssertEqual(thread.changes.map(\.path), ["src/a.ts"])
        XCTAssertEqual(thread.changes[0].additions, 3)
        XCTAssertEqual(thread.changes[0].deletions, 1)
        XCTAssertEqual(thread.latestTests?.status, .passed)
        XCTAssertEqual(thread.latestTests?.passed, 12)
        // The two test updates collapse into one row that shows the latest.
        XCTAssertEqual(thread.items.filter { if case .tests = $0 { true } else { false } }.count, 1)
    }

    func testStatusAndCompletion() {
        let running = CodeRemoteThread.reduce([event(1, "status_update", ["status": .string("running")])])
        XCTAssertTrue(running.isRunning)
        XCTAssertFalse(running.isComplete)

        let done = CodeRemoteThread.reduce([
            event(1, "status_update", ["status": .string("running")]),
            event(2, "completed", ["summary": .string("Opened PR #12")]),
        ])
        XCTAssertTrue(done.isComplete)
        XCTAssertFalse(done.isRunning)
        XCTAssertEqual(done.status, "completed")

        let failed = CodeRemoteThread.reduce([event(1, "error", ["message": .string("boom")])])
        XCTAssertEqual(failed.lastError, "boom")
    }

    func testQueuedPromptsClearWhenTheHostEchoesThem() {
        let thread = CodeRemoteThread.reduce(
            [event(1, "user_message", ["text": .string("also update docs")])],
            queuedPrompts: ["also update docs", "then run lint"]
        )
        XCTAssertEqual(thread.queuedPrompts, ["then run lint"])
    }

    func testCanonicalEnvelopeIsUnwrapped() {
        let envelope: JunoJSONValue = .object([
            "sequence": .number(1),
            "payload": .object([
                "toolStarted": .object([
                    "toolCallId": .string("c9"), "name": .string("grep"),
                ])
            ]),
        ])
        let thread = CodeRemoteThread.reduce([
            event(1, "canonical_session_event", ["event": envelope]),
            event(2, "canonical_session_event", ["event": .object([
                "payload": .object(["assistantMessage": .object(["text": .string("Found it.")])])
            ])]),
        ])
        XCTAssertEqual(thread.items.count, 2)
        guard case .workLog(_, let activities) = thread.items[0] else { return XCTFail("work log") }
        XCTAssertEqual(activities.first?.name, "grep")
        guard case .assistantText(_, let text) = thread.items[1] else { return XCTFail("prose") }
        XCTAssertEqual(text, "Found it.")
    }

    func testSubagentUpdatesCoalesceByAgent() {
        let thread = CodeRemoteThread.reduce([
            event(1, "subagent_update", ["agent": .object(["id": .string("a1"), "title": .string("Explorer"), "status": .string("running")])]),
            event(2, "subagent_update", ["agent": .object(["id": .string("a1"), "title": .string("Explorer"), "status": .string("done")])]),
        ])
        XCTAssertEqual(thread.subagents.count, 1)
        XCTAssertEqual(thread.subagents[0].status, "done")
        XCTAssertEqual(thread.items.count, 1)
    }
}

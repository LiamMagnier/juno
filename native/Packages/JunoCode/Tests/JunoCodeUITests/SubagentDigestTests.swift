import XCTest
import JunoCodeCore
@testable import JunoCodeUI

/// The fold the Sub-agents pane renders: one row per agent, split into Active
/// and Done, over a transcript that carries several agents from one delegating
/// call — and over an older transcript that carries none of the new events at
/// all.
final class SubagentDigestTests: XCTestCase {
    private let sessionID = CodeSessionID(value: "parent")
    private var sequence = 0
    private var clock = Date(timeIntervalSince1970: 1_700_000_000)

    override func setUp() {
        super.setUp()
        sequence = 0
        clock = Date(timeIntervalSince1970: 1_700_000_000)
    }

    // MARK: - The live path

    func testEveryUpdateForOneAgentCollapsesIntoOneRow() throws {
        let events = [
            proposal(call: "call-1", tasks: 1),
            update("call-1#0", call: "call-1", status: .queued),
            update("call-1#0", call: "call-1", status: .preparing),
            update(
                "call-1#0", call: "call-1", status: .running,
                child: CodeSessionID(value: "child-a"),
                activity: "Read Sources/App.swift",
                startedAt: at(10)
            ),
            update(
                "call-1#0", call: "call-1", status: .completed,
                child: nil,
                startedAt: at(10),
                completedAt: at(46),
                summary: "Three call sites, all in Sources/App.swift."
            ),
        ]

        let runs = SubagentDigest.runs(in: events)
        XCTAssertEqual(runs.count, 1, "four transitions describe one agent, not four")
        let run = try XCTUnwrap(runs.first)
        XCTAssertEqual(run.status, .completed)
        XCTAssertEqual(run.summary, "Three call sites, all in Sources/App.swift.")
        XCTAssertEqual(
            run.childSessionID, CodeSessionID(value: "child-a"),
            "the session id is published once and must not be lost by later updates"
        )
        XCTAssertEqual(try XCTUnwrap(run.durationSeconds), 36, accuracy: 0.001)
        XCTAssertFalse(run.isActive)
    }

    func testOneCallFanningOutIsOneRowPerAgentSplitByStatus() {
        let events = [
            proposal(call: "call-1", tasks: 3),
            update("call-1#0", call: "call-1", status: .running, startedAt: at(5)),
            update("call-1#1", call: "call-1", status: .running, startedAt: at(6)),
            update("call-1#2", call: "call-1", status: .queued),
            update(
                "call-1#1", call: "call-1", status: .failed,
                startedAt: at(6), completedAt: at(20),
                error: "The model transport failed."
            ),
        ]

        let runs = SubagentDigest.runs(in: events)
        XCTAssertEqual(runs.map(\.agentID), ["call-1#0", "call-1#1", "call-1#2"])
        XCTAssertEqual(
            runs.filter(\.isActive).map(\.agentID), ["call-1#0", "call-1#2"],
            "queued and running are both Active — an agent waiting for a slot has not finished"
        )
        XCTAssertEqual(runs.filter { $0.status.isTerminal }.map(\.agentID), ["call-1#1"])
        XCTAssertNil(
            runs[0].durationSeconds,
            "a running agent has no settled duration; the row ticks instead"
        )
    }

    func testTheDelegatingCallIsOneRowUntilItPublishesItsAgents() {
        let singular = SubagentDigest.runs(in: [proposal(call: "call-0", tasks: 1)])
        XCTAssertEqual(singular.count, 1)
        XCTAssertEqual(singular.first?.status, .queued)
        XCTAssertEqual(
            singular.first?.title, "Map the reconnect callers",
            "the placeholder names the task so a call awaiting authorization is not anonymous"
        )

        let onlyProposed = [proposal(call: "call-1", tasks: 2)]
        XCTAssertEqual(SubagentDigest.runs(in: onlyProposed).count, 1)

        let withAgents = onlyProposed + [
            update("call-1#0", call: "call-1", status: .running, startedAt: at(5)),
            update("call-1#1", call: "call-1", status: .running, startedAt: at(5)),
        ]
        XCTAssertEqual(
            SubagentDigest.runs(in: withAgents).map(\.agentID),
            ["call-1#0", "call-1#1"],
            "the placeholder is replaced, never left behind as a phantom extra agent"
        )
    }

    func testAgentsLeftRunningWhenTheCallReturnedReadAsInterrupted() {
        let events = [
            proposal(call: "call-1", tasks: 2),
            update("call-1#0", call: "call-1", status: .running, startedAt: at(5)),
            update("call-1#1", call: "call-1", status: .running, startedAt: at(5)),
            update(
                "call-1#1", call: "call-1", status: .completed,
                startedAt: at(5), completedAt: at(30), summary: "Fine."
            ),
            completion(call: "call-1", status: .succeeded, result: "1 of 2", duration: 30),
        ]

        let runs = SubagentDigest.runs(in: events)
        XCTAssertEqual(runs.first?.status, .interrupted)
        XCTAssertNotNil(runs.first?.error, "an interrupted agent has to say why it stopped")
        XCTAssertEqual(runs.last?.status, .completed)
    }

    func testDelegationsFromSeparateCallsStayInCallOrder() {
        let events = [
            proposal(call: "call-1", tasks: 1),
            update("call-1#0", call: "call-1", status: .completed, completedAt: at(30)),
            completion(call: "call-1", status: .succeeded, result: "done", duration: 30),
            proposal(call: "call-2", tasks: 1),
            update("call-2#0", call: "call-2", status: .running, startedAt: at(40)),
        ]
        XCTAssertEqual(
            SubagentDigest.runs(in: events).map(\.toolCallID), ["call-1", "call-2"]
        )
    }

    // MARK: - Transcripts written before the lifecycle event existed

    func testALegacyTranscriptStillProducesARunWithItsOutcomeAndChildSession() throws {
        let events = [
            proposal(call: "legacy", tasks: 1),
            started(call: "legacy"),
            completion(
                call: "legacy",
                status: .succeeded,
                result: "Sub-agent session: child-legacy\nThe callers are all in App.swift.",
                duration: 42
            ),
        ]

        let runs = SubagentDigest.runs(in: events)
        XCTAssertEqual(runs.count, 1)
        let run = try XCTUnwrap(runs.first)
        XCTAssertEqual(run.status, .completed)
        XCTAssertEqual(
            run.childSessionID, CodeSessionID(value: "child-legacy"),
            "the marker line is still the only link an old transcript has"
        )
        XCTAssertEqual(
            run.summary, "The callers are all in App.swift.",
            "the marker line is stripped: it is shown as an identifier elsewhere"
        )
        XCTAssertEqual(try XCTUnwrap(run.durationSeconds), 42, accuracy: 0.001)
        XCTAssertNil(
            run.startedAt,
            "an old transcript recorded no per-agent start, and one must not be invented"
        )
    }

    func testALegacyCallStillRunningReadsAsRunning() {
        let runs = SubagentDigest.runs(in: [
            proposal(call: "legacy", tasks: 1),
            started(call: "legacy"),
        ])
        XCTAssertEqual(runs.first?.status, .running)
        XCTAssertTrue(runs.first?.isActive == true)
    }

    func testADeniedLegacyCallReadsAsCancelledWithItsReason() {
        let runs = SubagentDigest.runs(in: [
            proposal(call: "legacy", tasks: 1),
            completion(
                call: "legacy", status: .denied,
                result: "Action not permitted: delegation is disabled.", duration: 0.1
            ),
        ])
        XCTAssertEqual(runs.first?.status, .cancelled)
        XCTAssertEqual(runs.first?.error, "Action not permitted: delegation is disabled.")
        XCTAssertNil(runs.first?.summary, "a denied call produced no result to show")
    }

    func testCallsToOtherToolsAreNotDelegations() {
        let events = [
            event(.toolProposed(ToolProposedEvent(
                toolCallID: "call-read",
                toolName: "read_file",
                input: ["path": "App.swift"],
                risk: .read,
                summary: "Read App.swift"
            ))),
            completion(call: "call-read", status: .succeeded, result: "ok", duration: 0.2),
        ]
        XCTAssertTrue(SubagentDigest.runs(in: events).isEmpty)
    }

    func testInspectorListStatusLabelsStayCompactAndActionable() {
        let expected: [SubagentStatus: String] = [
            .queued: "Queued",
            .preparing: "Starting",
            .running: "Running",
            .waitingForApproval: "Needs approval",
            .completed: "Completed",
            .failed: "Failed",
            .cancelled: "Cancelled",
            .interrupted: "Interrupted",
        ]

        for status in SubagentStatus.allCases {
            XCTAssertEqual(
                SubagentFormatting.listLabel(status),
                expected[status],
                "the inspector row needs a short, stateful label for \(status.rawValue)"
            )
            XCTAssertLessThanOrEqual(
                SubagentFormatting.listLabel(status).count,
                15,
                "a list label should fit beside the role at the inspector minimum"
            )
        }
    }

    // MARK: - Fixtures

    private func at(_ offset: TimeInterval) -> Date {
        clock.addingTimeInterval(offset)
    }

    private func event(_ payload: SessionEventPayload) -> SessionEvent {
        sequence += 1
        return SessionEvent(
            id: "event-\(sequence)",
            sessionID: sessionID,
            sequence: sequence,
            timestamp: clock.addingTimeInterval(Double(sequence)),
            payload: payload
        )
    }

    private func proposal(call: String, tasks: Int) -> SessionEvent {
        let titles = ["Map the reconnect callers", "Review the backoff maths", "Check the tests"]
        let entries: [JSONValue] = (0..<tasks).map { index in
            [
                "task": .string("Investigate part \(index)."),
                "title": .string(titles[index % titles.count]),
                "role": "engineer",
            ]
        }
        return event(.toolProposed(ToolProposedEvent(
            toolCallID: call,
            toolName: SubagentDigest.toolName,
            input: tasks == 1 ? entries[0] : ["tasks": .array(entries)],
            risk: .read,
            summary: "Delegate \(tasks) task(s)"
        )))
    }

    private func started(call: String) -> SessionEvent {
        event(.toolStarted(ToolStartedEvent(toolCallID: call)))
    }

    private func completion(
        call: String,
        status: ToolCompletionStatus,
        result: String,
        duration: Double
    ) -> SessionEvent {
        event(.toolCompleted(ToolCompletedEvent(
            toolCallID: call,
            status: status,
            resultSummary: result,
            durationSeconds: duration
        )))
    }

    private func update(
        _ agentID: String,
        call: String,
        status: SubagentStatus,
        child: CodeSessionID? = nil,
        activity: String = "",
        startedAt: Date? = nil,
        completedAt: Date? = nil,
        summary: String? = nil,
        error: String? = nil
    ) -> SessionEvent {
        event(.subagentUpdated(SubagentUpdateEvent(
            agentID: agentID,
            toolCallID: call,
            childSessionID: child,
            title: "Map the reconnect callers",
            task: "Investigate part 0.",
            role: .engineer,
            status: status,
            currentActivity: activity,
            startedAt: startedAt,
            completedAt: completedAt,
            summary: summary,
            error: error
        )))
    }
}

import XCTest
import JunoAgentProtocol
import JunoCodeCore
import JunoCodeKit
import JunoCore
import JunoSync
@testable import JunoCodeBridge

/// A Mac session as the canonical agent protocol, and the two wires spelled
/// from it. The properties that matter: every event is one the generated
/// decoder reads as known, the numbering is deterministic and increasing, the
/// shared reducer reads outcomes as typed statuses, the relay carries the
/// protocol beside the payload a shipped phone reads, and the device-task wire
/// sends protocol rows only to a server that stores them.
final class AgentProtocolProjectionTests: XCTestCase {
    private let session = CodeSessionID(value: "s-1")

    func testEveryJournalEntryProjectsToEventsTheProtocolReaderKnows() throws {
        var lastSeq = 0
        for (index, payload) in samplePayloads().enumerated() {
            for projected in AgentProtocolProjection.events(for: event(index, payload)) {
                let data = try AgentProtocolProjection.jsonData(projected)
                let decoded = try JSONDecoder().decode(AgentEvent.self, from: data)
                XCTAssertTrue(decoded.isKnown, "\(projected.type) does not decode as a known event")
                XCTAssertEqual(decoded, projected, "\(projected.type) did not round-trip")
                XCTAssertGreaterThan(projected.seq, lastSeq, "seq must increase across the stream")
                lastSeq = projected.seq
            }
        }
    }

    func testTheSameEntryAlwaysProjectsTheSameEvents() {
        // The relay drops a re-sent batch as a replay only if it is identical.
        let entry = event(7, .userPrompt(UserPromptEvent(text: "again")))
        XCTAssertEqual(AgentProtocolProjection.events(for: entry), AgentProtocolProjection.events(for: entry))
    }

    func testTheSharedReducerReadsAMacSessionWithTypedOutcomes() {
        let local: [SessionEventPayload] = [
            .sessionCreated(SessionCreatedEvent(
                workspaceID: nil, executionRootPath: "/Users/me/secret", workspaceName: "juno",
                configuration: AgentConfiguration(modelID: "model-a")
            )),
            .userPrompt(UserPromptEvent(text: "Fix the login test")),
            .statusChanged(StatusChangedEvent(status: .running)),
            .toolProposed(ToolProposedEvent(toolCallID: "t-1", toolName: "run_command", input: .null, risk: .execute, summary: "Run swift test")),
            .toolOutput(ToolOutputEvent(toolCallID: "t-1", channel: .stdout, text: "1 test failed")),
            .toolCompleted(ToolCompletedEvent(toolCallID: "t-1", status: .failed, resultSummary: "exit 1", durationSeconds: 2)),
            .toolProposed(ToolProposedEvent(toolCallID: "t-2", toolName: "write_file", input: .null, risk: .write, summary: "Write a.swift")),
            .approvalRequested(ApprovalRequest(
                id: "a-1", sessionID: session, actionDigest: "d", toolName: "write_file",
                summary: "Write a.swift", risk: .write,
                requestedAt: Date(timeIntervalSince1970: 0), expiresAt: Date(timeIntervalSince1970: 600)
            )),
            .statusChanged(StatusChangedEvent(status: .waitingForApproval)),
            .approvalResolved(ApprovalResolvedEvent(approvalID: "a-1", decision: .denied)),
            .toolCompleted(ToolCompletedEvent(toolCallID: "t-2", status: .denied, resultSummary: "Denied", durationSeconds: 0)),
            .toolProposed(ToolProposedEvent(toolCallID: "t-3", toolName: "run_command", input: .null, risk: .execute, summary: "Run swift build")),
            .toolCompleted(ToolCompletedEvent(toolCallID: "t-3", status: .cancelled, resultSummary: "Not executed", durationSeconds: 0)),
            .goalUpdated(GoalUpdatedEvent(kind: .created, goal: SessionGoal(
                objective: "Green tests",
                steps: [GoalStep(id: "g1", title: "Fix the test", status: .inProgress, createdAt: Date(timeIntervalSince1970: 0))],
                createdAt: Date(timeIntervalSince1970: 0)
            ))),
            .runCompleted(RunCompletedEvent(summary: "Fixed.", filesChanged: 1, testsPassed: true, durationSeconds: 9)),
            .statusChanged(StatusChangedEvent(status: .idle)),
        ]
        let events = local.enumerated().flatMap { AgentProtocolProjection.events(for: event($0.offset, $0.element)) }
        let view = AgentSessionFold.fold(events)

        XCTAssertEqual(view.workspaceName, "juno")
        XCTAssertEqual(view.mode, .ask, "askBeforeChanges is the protocol's ask")
        XCTAssertEqual(view.items.filter { $0.kind == .tool }.map(\.toolStatus), [.error, .denied, .notExecuted])
        XCTAssertEqual(view.item("t-1")?.output, "1 test failed")
        XCTAssertEqual(view.turns.map(\.status), [.completed])
        XCTAssertEqual(view.turns.first?.filesChanged, 1)
        XCTAssertNil(view.pendingApproval)
        XCTAssertEqual(view.item("approval:a-1")?.decision, .deny)
        XCTAssertEqual(view.plan?.steps.map(\.status), [.inProgress])
        XCTAssertEqual(view.state, .idle)
        let json = String(describing: events)
        XCTAssertFalse(json.contains("/Users/me/secret"), "an absolute path never leaves the Mac")
    }

    func testTheRelayCarriesTheProtocolBesideThePayloadAPhoneReads() throws {
        let relay = CodeRelayEventProjection.relayEvent(event(3, .toolCompleted(
            ToolCompletedEvent(toolCallID: "t-1", status: .failed, resultSummary: "exit 1", durationSeconds: 2)
        )))
        // The payload a shipped phone reads, unchanged.
        XCTAssertEqual(relay.kind, "tool_result")
        XCTAssertEqual(relay.payload["status"], .string("failed"))
        XCTAssertEqual(relay.payload["isError"], .bool(true))
        XCTAssertEqual(relay.payload["durationSeconds"], .number(2))
        // And the protocol, typed, beside it.
        guard case .array(let carried)? = relay.payload[CodeRelayEventProjection.protocolKey] else {
            return XCTFail("the relay event carries no protocol events")
        }
        let decoded = try carried.map { value in
            try JSONDecoder().decode(AgentEvent.self, from: JSONEncoder().encode(value))
        }
        guard case .itemToolResult(let result)? = decoded.first?.payload else {
            return XCTFail("the carried event is not the tool's result")
        }
        XCTAssertEqual(result.status, .error)
    }

    func testAnEventTooLargeToCarryTwiceLeavesTheProtocolCopyOff() {
        // 8,000 characters of four-byte text is 32 KB once; twice, with the
        // envelope, it would crowd the relay's 64 KB per-event limit.
        let wide = String(repeating: "\u{1D11E}", count: 8_000)
        let relay = CodeRelayEventProjection.relayEvent(event(5, .toolOutput(
            ToolOutputEvent(toolCallID: "t-1", channel: .stdout, text: wide)
        )))
        XCTAssertEqual(relay.kind, "command_output")
        XCTAssertNotNil(relay.payload["text"], "the legacy payload is complete on its own")
        XCTAssertNil(relay.payload[CodeRelayEventProjection.protocolKey])
    }

    func testTheDeviceTaskWireSendsProtocolRowsOnlyToAServerThatStoresThem() {
        let completed = event(9, .toolCompleted(
            ToolCompletedEvent(toolCallID: "t-1", status: .failed, resultSummary: "exit 1", durationSeconds: 2)
        ))
        let current = CodeTaskWireProjection(includesProtocol: true).rows(for: completed)
        XCTAssertEqual(current.map(\.kind), ["protocol", "tool"])
        XCTAssertEqual(current[0].payload["type"], .string("item.tool_result"))
        XCTAssertEqual(current[0].payload["status"], .string("error"))
        XCTAssertEqual(current[1].payload["name"], .string("failed"), "the legacy row a shipped reader has always read")
        XCTAssertEqual(current[1].payload[CodeTaskWireProjection.derivedKey], current[0].payload["id"])

        let older = CodeTaskWireProjection(includesProtocol: false).rows(for: completed)
        XCTAssertEqual(older.map(\.kind), ["tool"])
        XCTAssertNil(older[0].payload[CodeTaskWireProjection.derivedKey])

        // A prompt is two protocol events (the turn and the message) and one legacy row.
        let prompt = CodeTaskWireProjection(includesProtocol: true).rows(for: event(1, .userPrompt(UserPromptEvent(text: "Go"))))
        XCTAssertEqual(prompt.map(\.kind), ["protocol", "protocol", "user"])
        XCTAssertEqual(CodeTaskWireProjection.taskStatus(.waitingForApproval), "awaiting_approval")
        XCTAssertEqual(CodeTaskWireProjection.taskStatus(.completed), "done")
    }

    func testTheDeviceTaskWireSplitsABurstIntoPostsTheRouteAccepts() throws {
        // A burst of output between two polls, now twice over (protocol row and
        // legacy twin): one body for all of it would pass the route's 256 KB
        // refusal, and a refused POST failed the whole task.
        let wire = CodeTaskWireProjection(includesProtocol: true)
        let chunk = String(repeating: "x", count: 7_000)
        let rows = (0..<40).flatMap { index in
            wire.rows(for: event(index, .toolOutput(ToolOutputEvent(toolCallID: "t-1", channel: .stdout, text: chunk))))
        }
        XCTAssertEqual(rows.count, 80)
        let batches = CodeTaskWireProjection.batches(rows)
        XCTAssertGreaterThan(batches.count, 1)
        XCTAssertEqual(batches.flatMap { $0 }, rows, "every row, once, in order")
        let encoder = JSONEncoder()
        for batch in batches {
            let bytes = try batch.reduce(0) { $0 + (try encoder.encode($1).count) + 1 }
            XCTAssertLessThanOrEqual(bytes, CodeTaskWireProjection.maximumBatchBytes)
            XCTAssertLessThanOrEqual(batch.count, CodeTaskWireProjection.maximumBatchCount)
        }

        // The count limit holds for small rows too, and a quiet poll is still
        // one POST — the one that carries the status and reads the controls.
        let small = Array(repeating: NativeCodeTaskEventInput(kind: "status", payload: ["status": .string("running")]), count: 900)
        XCTAssertEqual(CodeTaskWireProjection.batches(small).map(\.count), [400, 400, 100])
        XCTAssertEqual(CodeTaskWireProjection.batches([]).count, 1)
    }

    // MARK: - Helpers

    private func event(_ sequence: Int, _ payload: SessionEventPayload) -> SessionEvent {
        SessionEvent(
            id: "e-\(sequence)",
            sessionID: session, sequence: sequence,
            timestamp: Date(timeIntervalSince1970: TimeInterval(sequence)), payload: payload
        )
    }

    private func samplePayloads() -> [SessionEventPayload] {
        let configuration = AgentConfiguration(modelID: "model-a")
        // swiftlint:disable:next force_try
        let path = try! WorkspacePath("src/a.swift")
        return [
            .sessionCreated(SessionCreatedEvent(workspaceID: nil, workspaceName: nil, configuration: configuration)),
            .turnConfiguration(TurnConfigurationEvent(
                behavior: .code, permissionMode: .askBeforeChanges, modelID: "model-a", reasoningEffort: .high
            )),
            .userPrompt(UserPromptEvent(text: "a")),
            .userInstruction(UserInstructionEvent(text: "b", kind: .steer)),
            .userInstructionApplied(UserInstructionAppliedEvent(instructionID: "i-1")),
            .assistantMessage(AssistantMessageEvent(text: "c")),
            .reasoningSummary(ReasoningSummaryEvent(summary: "d")),
            .toolProposed(ToolProposedEvent(toolCallID: "t", toolName: "n", input: .null, risk: .read, summary: "s")),
            .toolStarted(ToolStartedEvent(toolCallID: "t")),
            .toolOutput(ToolOutputEvent(toolCallID: "t", channel: .stderr, text: "o")),
            .toolCompleted(ToolCompletedEvent(toolCallID: "t", status: .succeeded, resultSummary: "r", durationSeconds: 1)),
            .approvalResolved(ApprovalResolvedEvent(approvalID: "a", decision: .denied)),
            .fileChanged(FileChangedEvent(path: path, kind: .modified, linesAdded: 3, linesRemoved: 1, checkpointID: "cp")),
            .testRunCompleted(TestRunCompletedEvent(command: "swift test", passed: true, testsRun: 4, failures: 0, durationSeconds: 3)),
            .subagentUpdated(SubagentUpdateEvent(
                agentID: "ag-1", toolCallID: "t", childSessionID: nil, title: "Review", task: "brief",
                role: .reviewer, status: .running, currentActivity: "Reading", inputTokens: 10, outputTokens: 2
            )),
            .statusChanged(StatusChangedEvent(status: .completed)),
            .errorOccurred(ErrorEvent(message: "e", isRecoverable: true)),
            .runCompleted(RunCompletedEvent(summary: "done", filesChanged: 1, testsPassed: true, durationSeconds: 9)),
            .compaction(CompactionEvent(summary: "folded", beforeMessageCount: 12, afterMessageCount: 5)),
            .transcriptRewound(TranscriptRewoundEvent(turnID: "turn-1")),
            .hookActivity(HookActivityEvent(
                hookEvent: "PreToolUse", hookName: "guard.sh", outcome: .blocked, message: "no force pushes"
            )),
        ]
    }
}

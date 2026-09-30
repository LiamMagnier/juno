import XCTest
import JunoCodeCore
import JunoCodeKit
import JunoCore
@testable import JunoCodeBridge

/// What leaves the Mac for a phone, event by event. The properties that
/// matter: the numbering is the relay's replay key, the kinds are ones the
/// relay stores and the phone folds, and nothing the transcript does not show
/// — a file being written, an absolute path, a credential in output — is in it.
final class CodeRelayEventProjectionTests: XCTestCase {
    private let session = CodeSessionID(value: "s-1")

    /// The relay's `SESSION_EVENT_KINDS` (`src/lib/code-remote-sessions.ts`).
    /// An event of any other kind is refused with a 400, so every projection
    /// must land in this list.
    private let relayKinds: Set<String> = [
        "session_created", "session_updated", "user_message", "text_delta", "reasoning_delta",
        "tool_start", "tool_result", "command_output", "file_change", "test_update", "git_update",
        "approval_request", "approval_response", "subagent_update", "status_update", "usage",
        "error", "completed", "heartbeat", "canonical_session_event",
    ]

    func testRelaySequenceIsTheLocalSequencePlusOne() {
        let relay = CodeRelayEventProjection.relayEvent(event(0, .userPrompt(UserPromptEvent(text: "hi"))))
        XCTAssertEqual(relay.seq, 1, "the relay's sequences are one-based and contiguous from the first event")
    }

    func testEveryLocalEventProjectsToAKindTheRelayStores() {
        for (index, payload) in samplePayloads().enumerated() {
            let relay = CodeRelayEventProjection.relayEvent(event(index, payload))
            XCTAssertTrue(relayKinds.contains(relay.kind), "\(relay.kind) is not a relay event kind")
        }
    }

    func testAToolCallCarriesItsSummaryNeverItsInput() {
        let written = String(repeating: "secret source line\n", count: 50)
        let relay = CodeRelayEventProjection.relayEvent(event(3, .toolProposed(
            ToolProposedEvent(
                toolCallID: "t-1", toolName: "write_file",
                input: .object(["path": .string("src/a.swift"), "content": .string(written)]),
                risk: .write, summary: "Write src/a.swift"
            )
        )))

        XCTAssertEqual(relay.kind, "tool_start")
        XCTAssertEqual(relay.payload["summary"], .string("Write src/a.swift"))
        XCTAssertNil(relay.payload["input"])
        XCTAssertFalse(String(describing: relay.payload).contains("secret source line"))
    }

    func testAnAbsolutePathOnThisMacDoesNotLeave() {
        let relay = CodeRelayEventProjection.relayEvent(event(0, .sessionCreated(
            SessionCreatedEvent(
                workspaceID: WorkspaceID(value: "ws-1"),
                executionRootPath: "/Users/someone/Developer/secret-project/.worktrees/juno-1",
                workspaceName: "juno",
                configuration: AgentConfiguration(modelID: "model-a")
            )
        )))

        XCTAssertEqual(relay.payload["workspaceName"], .string("juno"))
        XCTAssertFalse(String(describing: relay.payload).contains("/Users/"))
    }

    func testCredentialsInOutputAreRedactedAndLongOutputIsBounded() {
        let output = "export API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123\n"
            + String(repeating: "x", count: 20_000)
        let relay = CodeRelayEventProjection.relayEvent(event(5, .toolOutput(
            ToolOutputEvent(toolCallID: "t-1", channel: .stdout, text: output)
        )))

        guard case .string(let text)? = relay.payload["text"] else { return XCTFail("no text") }
        XCTAssertFalse(text.contains("sk-abcdefghijklmnopqrstuvwxyz0123"))
        XCTAssertLessThan(text.count, CodeRelayEventProjection.maximumOutputCharacters + 100)
    }

    func testAFileChangeCarriesItsSizeAndCheckpointButNoContent() {
        let relay = CodeRelayEventProjection.relayEvent(event(7, .fileChanged(
            FileChangedEvent(
                path: try! WorkspacePath("src/a.swift"), kind: .modified,
                linesAdded: 3, linesRemoved: 1, checkpointID: "cp-9"
            )
        )))

        XCTAssertEqual(relay.kind, "file_change")
        XCTAssertEqual(relay.payload["path"], .string("src/a.swift"))
        XCTAssertEqual(relay.payload["linesAdded"], .number(3))
        XCTAssertEqual(relay.payload["checkpointId"], .string("cp-9"), "what lets the phone undo exactly this")
        XCTAssertNil(relay.payload["diff"])
    }

    func testStatusesUseTheRelaysSixWords() {
        XCTAssertEqual(CodeRelayEventProjection.relayStatus(.waitingForApproval), "awaiting_approval")
        XCTAssertEqual(CodeRelayEventProjection.relayStatus(.waitingForProvider), "running")
        XCTAssertEqual(CodeRelayEventProjection.relayStatus(.cancelled), "interrupted")
        let allowed: Set<String> = ["idle", "running", "awaiting_approval", "completed", "failed", "interrupted"]
        for status in SessionStatus.allCases {
            XCTAssertTrue(allowed.contains(CodeRelayEventProjection.relayStatus(status)))
        }
    }

    /// One unreadable line in the local file must not become a hole: the relay
    /// refuses a gap, and every later event would stall behind it.
    func testAMissingLocalEventBecomesAHeartbeatNotAGap() {
        let events = [
            event(0, .userPrompt(UserPromptEvent(text: "a"))),
            event(2, .assistantMessage(AssistantMessageEvent(text: "c"))),
        ]
        let relay = CodeRelayEventProjection.relayEvents(events, after: 0, limit: 10, total: 3)

        XCTAssertEqual(relay.map(\.seq), [1, 2, 3])
        XCTAssertEqual(relay.map(\.kind), ["user_message", "heartbeat", "text_delta"])
    }

    func testARangeIsBoundedByTheLimitAndTheTotal() {
        let events = (0..<10).map { event($0, .assistantMessage(AssistantMessageEvent(text: "\($0)"))) }
        XCTAssertEqual(
            CodeRelayEventProjection.relayEvents(events, after: 4, limit: 3, total: 10).map(\.seq),
            [5, 6, 7]
        )
        XCTAssertEqual(
            CodeRelayEventProjection.relayEvents(events, after: 8, limit: 5, total: 10).map(\.seq),
            [9, 10]
        )
        XCTAssertTrue(CodeRelayEventProjection.relayEvents(events, after: 10, limit: 5, total: 10).isEmpty)
    }

    /// The projection is only useful if the phone draws it. Folding it with
    /// the phone's own reducer is the check that the two agree.
    func testThePhonesReducerDrawsTheProjectedTranscript() {
        let local: [SessionEventPayload] = [
            .userPrompt(UserPromptEvent(text: "Fix the login test")),
            .statusChanged(StatusChangedEvent(status: .running)),
            .toolProposed(ToolProposedEvent(
                toolCallID: "t-1", toolName: "run_command", input: .object([:]),
                risk: .execute, summary: "Run swift test"
            )),
            .toolOutput(ToolOutputEvent(toolCallID: "t-1", channel: .stdout, text: "1 test failed")),
            .toolCompleted(ToolCompletedEvent(
                toolCallID: "t-1", status: .failed, resultSummary: "exit 1", durationSeconds: 2
            )),
            .approvalRequested(ApprovalRequest(
                id: "a-1", sessionID: session, actionDigest: "d", toolName: "write_file",
                summary: "Edit Tests/LoginTests.swift", risk: .write,
                requestedAt: Date(timeIntervalSince1970: 0), expiresAt: Date(timeIntervalSince1970: 600)
            )),
            .statusChanged(StatusChangedEvent(status: .waitingForApproval)),
        ]
        let relay = local.enumerated().map { CodeRelayEventProjection.relayEvent(event($0.offset, $0.element)) }

        let thread = CodeRemoteThread.reduce(relay)

        guard case .userMessage(_, let prompt, _)? = thread.items.first else {
            return XCTFail("the prompt opens the thread")
        }
        XCTAssertEqual(prompt, "Fix the login test")
        let activity = thread.items.compactMap { item -> CodeRemoteThread.ToolActivity? in
            if case .workLog(_, let activities) = item { return activities.first }
            return nil
        }.first
        XCTAssertEqual(activity?.summary, "Run swift test")
        XCTAssertEqual(activity?.output, "1 test failed")
        XCTAssertEqual(activity?.isError, true)
        XCTAssertEqual(thread.pendingApproval?.requestID, "a-1", "the phone can answer it")
        XCTAssertEqual(thread.status, "awaiting_approval")
    }

    // MARK: - Helpers

    private func event(_ sequence: Int, _ payload: SessionEventPayload) -> SessionEvent {
        SessionEvent(
            sessionID: session, sequence: sequence,
            timestamp: Date(timeIntervalSince1970: TimeInterval(sequence)), payload: payload
        )
    }

    private func samplePayloads() -> [SessionEventPayload] {
        let configuration = AgentConfiguration(modelID: "model-a")
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
            .testRunCompleted(TestRunCompletedEvent(command: "swift test", passed: true, testsRun: 4, failures: 0, durationSeconds: 3)),
            .statusChanged(StatusChangedEvent(status: .completed)),
            .errorOccurred(ErrorEvent(message: "e", isRecoverable: true)),
            .runCompleted(RunCompletedEvent(summary: "done", filesChanged: 1, testsPassed: true, durationSeconds: 9)),
            .compaction(CompactionEvent(summary: "folded", beforeMessageCount: 12, afterMessageCount: 5)),
            .transcriptRewound(TranscriptRewoundEvent(turnID: "turn-1")),
            .hookActivity(HookActivityEvent(
                hookEvent: "PreToolUse", hookName: "guard.sh", outcome: .blocked, message: "no force pushes"
            )),
            .todosUpdated(TodoListEvent(items: [TodoItem(id: "1", content: "x", status: .pending)])),
            .questionRequested(QuestionRequest(
                sessionID: session, toolCallID: "t", questions: [], requestedAt: Date(), expiresAt: Date()
            )),
            .questionResolved(QuestionResolvedEvent(requestID: "q", resolution: .declined)),
            .planSubmitted(PlanApprovalRequest(
                sessionID: session, toolCallID: "t", plan: "p", requestedAt: Date(), expiresAt: Date()
            )),
            .planResolved(PlanResolvedEvent(requestID: "p", decision: .approved(permissionMode: .workspaceWrite))),
        ]
    }

    /// A question has no legacy relay kind, so it goes as the typed event a
    /// phone can decode whole — and answer by its id later — with anything
    /// that looks like a credential taken out on the way.
    func testAQuestionTravelsAsTheTypedEventWithItsTextRedacted() throws {
        let secret = "ghp_" + String(repeating: "a", count: 36)
        let request = QuestionRequest(
            id: "question-1",
            sessionID: session,
            toolCallID: "t-9",
            questions: [
                UserQuestion(
                    id: "q1",
                    question: "Use the token \(secret)?",
                    header: "Auth",
                    options: [UserQuestionOption(label: "Yes"), UserQuestionOption(label: "No", description: "Ask later")],
                    allowsMultipleSelection: false
                ),
            ],
            requestedAt: Date(timeIntervalSince1970: 10),
            expiresAt: Date(timeIntervalSince1970: 1_810)
        )
        let relay = CodeRelayEventProjection.relayEvent(event(41, .questionRequested(request)))
        XCTAssertEqual(relay.kind, "canonical_session_event")
        XCTAssertEqual(relay.seq, 42)
        XCTAssertFalse(String(describing: relay.payload).contains(secret))

        let decoded = try XCTUnwrap(try CodeRelayProtocolAdapter.canonicalEvent(from: relay))
        guard case let .questionRequested(typed) = decoded.payload else {
            return XCTFail("\(decoded.payload)")
        }
        XCTAssertEqual(typed.id, "question-1")
        XCTAssertEqual(typed.questions.first?.options.map(\.label), ["Yes", "No"])
        XCTAssertEqual(typed.expiresAt, request.expiresAt)
    }

    func testAPlanTravelsBoundedAndItsDecisionWithIt() throws {
        let long = String(repeating: "step\n", count: 10_000)
        let submitted = CodeRelayEventProjection.relayEvent(event(5, .planSubmitted(PlanApprovalRequest(
            sessionID: session, toolCallID: nil, plan: long, requestedAt: Date(), expiresAt: Date()
        ))))
        guard case let .planSubmitted(plan)? = try CodeRelayProtocolAdapter.canonicalEvent(from: submitted)?.payload else {
            return XCTFail("not a plan")
        }
        XCTAssertLessThan(plan.plan.count, long.count)

        let decided = CodeRelayEventProjection.relayEvent(event(6, .planResolved(
            PlanResolvedEvent(requestID: "p", decision: .approved(permissionMode: .askBeforeChanges))
        )))
        guard case let .planResolved(resolved)? = try CodeRelayProtocolAdapter.canonicalEvent(from: decided)?.payload else {
            return XCTFail("not a decision")
        }
        XCTAssertEqual(resolved.decision, .approved(permissionMode: .askBeforeChanges))
    }

    /// The restart a rewind opens its transcript with reaches the phone as
    /// the one form of it the phone's thread recognises, under the relay's
    /// next number.
    func testARewindsRestartIsTheCanonicalEventThePhoneDropsItsThreadOn() {
        let relay = CodeRelayEventProjection.relayEvent(
            event(150, .transcriptRewound(TranscriptRewoundEvent(turnID: "turn-1")))
        )
        XCTAssertEqual(relay.kind, "canonical_session_event")
        XCTAssertEqual(relay.seq, 151)
        XCTAssertTrue(CodeRemoteThread.restartsTranscript(relay))
    }

    /// A hook's note is quiet and bounded, and its output is redacted like
    /// any other text that leaves the Mac.
    func testAHooksNoteIsQuietAndRedacted() {
        let relay = CodeRelayEventProjection.relayEvent(event(4, .hookActivity(HookActivityEvent(
            hookEvent: "PostToolUse", hookName: "lint", outcome: .failed,
            message: "export API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123 failed"
        ))))
        XCTAssertEqual(relay.kind, "session_updated", "not a status or an error the phone would act on")
        XCTAssertEqual(relay.payload["hook"], .string("PostToolUse hook failed"))
        XCTAssertFalse(String(describing: relay.payload).contains("sk-abcdefghijklmnopqrstuvwxyz0123"))
    }
}

/// The in-memory end of each listed session's transcript.
final class CodeRelayJournalTailTests: XCTestCase {
    private let session = CodeSessionID(value: "s-1")

    func testAHeldRangeIsServedWithoutReadingTheFile() {
        var tail = CodeRelayJournalTail()
        tail.load(events(0..<10), for: session, from: 4)

        let served = tail.events(for: session, from: 4, limit: 3, total: 10)

        XCTAssertEqual(served?.map(\.sequence), [4, 5, 6])
    }

    func testAppendsKeepTheTailCurrentAndAcknowledgedEventsAreDropped() {
        var tail = CodeRelayJournalTail()
        tail.load(events(0..<5), for: session, from: 0)
        tail.append(event(5))
        tail.append(event(6))

        let served = tail.events(for: session, from: 5, limit: 10, total: 7)

        XCTAssertEqual(served?.map(\.sequence), [5, 6])
        XCTAssertEqual(tail.heldCount(for: session), 2, "what the relay acknowledged is forgotten")
    }

    func testAGapInTheAppendsSendsTheCallerBackToTheFile() {
        var tail = CodeRelayJournalTail()
        tail.load(events(0..<5), for: session, from: 0)
        tail.append(event(7))

        XCTAssertNil(tail.events(for: session, from: 0, limit: 10, total: 8))
        XCTAssertEqual(tail.events(for: session, from: 0, limit: 5, total: 8)?.count, 5)
    }

    func testARangeBeforeWhatIsHeldIsNotAnswered() {
        var tail = CodeRelayJournalTail()
        tail.load(events(0..<10), for: session, from: 6)

        XCTAssertNil(tail.events(for: session, from: 2, limit: 3, total: 10))
    }

    func testTheLeastRecentlyUsedSessionIsEvicted() {
        var tail = CodeRelayJournalTail()
        for index in 0...CodeRelayJournalTail.maximumSessions {
            tail.load([], for: CodeSessionID(value: "s-\(index)"), from: 0)
        }
        XCTAssertNil(
            tail.events(for: CodeSessionID(value: "s-0"), from: 0, limit: 1, total: 0),
            "the first session loaded is the one dropped"
        )
    }

    private func events(_ range: Range<Int>) -> [SessionEvent] { range.map(event) }

    private func event(_ sequence: Int) -> SessionEvent {
        SessionEvent(
            sessionID: session, sequence: sequence, timestamp: Date(timeIntervalSince1970: 0),
            payload: .assistantMessage(AssistantMessageEvent(text: "\(sequence)"))
        )
    }
}

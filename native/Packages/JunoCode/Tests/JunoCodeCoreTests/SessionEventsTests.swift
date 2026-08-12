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
            .subagentUpdated(
                SubagentUpdateEvent(
                    agentID: "call_2#0",
                    toolCallID: "call_2",
                    childSessionID: CodeSessionID(value: "child-1"),
                    title: "Map the reconnect callers",
                    task: "Find every caller of reconnectLoop().",
                    role: .reviewer,
                    status: .running,
                    currentActivity: "Search for “reconnectLoop(”",
                    startedAt: Date(timeIntervalSince1970: 10)
                )
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

    /// The Mac and the cloud runner are read through one panel, so they have to
    /// spell a sub-agent's states the same way. These raw values are the
    /// TypeScript union in `runner/agent-core/src/subagents.ts`; changing one
    /// side alone silently makes "Done" mean two different things.
    func testSubagentStatusMatchesTheCloudRunnersVocabulary() {
        XCTAssertEqual(
            Set(SubagentStatus.allCases.map(\.rawValue)),
            [
                "queued", "preparing", "running", "waiting_approval",
                "completed", "failed", "cancelled", "interrupted",
            ]
        )
        XCTAssertEqual(
            Set(SubagentStatus.allCases.filter(\.isTerminal).map(\.rawValue)),
            ["completed", "failed", "cancelled", "interrupted"],
            "the same four the web's agent cards treat as terminal"
        )
    }

    /// A child's report is capped where the runner caps its own, so one
    /// runaway sub-agent cannot write an unbounded string into the parent's
    /// append-only transcript.
    func testASubagentSummaryIsCappedOnTheWayIn() {
        let update = SubagentUpdateEvent(
            agentID: "a",
            toolCallID: "call",
            childSessionID: nil,
            title: "Long",
            task: "Say a lot.",
            role: .engineer,
            status: .completed,
            summary: String(repeating: "x", count: 5_000)
        )
        XCTAssertEqual(
            update.summary?.count, SubagentUpdateEvent.maximumSummaryCharacters
        )
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

    func testAgentBehaviorRoundTripsAndOldSessionsDefaultToCode() throws {
        let configured = AgentConfiguration(
            modelID: "anthropic:claude-sonnet-5",
            behavior: .survey
        )
        let data = try JSONEncoder().encode(configured)
        XCTAssertEqual(
            try JSONDecoder().decode(AgentConfiguration.self, from: data).behavior,
            .survey
        )

        let oldSession = """
        {
          "modelID":"anthropic:claude-sonnet-5",
          "reasoningEffort":"medium",
          "role":"engineer",
          "permissionMode":"askBeforeChanges",
          "location":"local",
          "computerUseEnabled":false
        }
        """
        let restored = try JSONDecoder().decode(
            AgentConfiguration.self,
            from: Data(oldSession.utf8)
        )
        XCTAssertEqual(restored.behavior, .code)
    }

    /// Making `workspaceID` optional changed the on-disk shape of every session
    /// record. The store is a JSON file on the reader's own Mac, and a decode
    /// failure there does not degrade gracefully — it empties the entire Code
    /// section — so both directions are pinned here: a record written before
    /// this change must still load, and one written without a project must load
    /// as having none rather than as a corrupt row.
    func testSessionsWithAndWithoutAProjectBothDecode() throws {
        let encoder = JSONEncoder()
        let decoder = JSONDecoder()
        encoder.dateEncodingStrategy = .iso8601
        decoder.dateDecodingStrategy = .iso8601

        let projectless = CodeSession(
            workspaceID: nil,
            title: "Explain how CRDTs converge",
            configuration: AgentConfiguration(modelID: "anthropic:claude-sonnet-5"),
            createdAt: Date(timeIntervalSince1970: 0),
            updatedAt: Date(timeIntervalSince1970: 0)
        )
        let roundTripped = try decoder.decode(
            CodeSession.self,
            from: encoder.encode(projectless)
        )
        XCTAssertNil(roundTripped.workspaceID)
        XCTAssertEqual(roundTripped.title, "Explain how CRDTs converge")

        let workspaceID = WorkspaceID(value: "ws-1")
        let withProject = CodeSession(
            workspaceID: workspaceID,
            title: "Fix the parser",
            configuration: AgentConfiguration(modelID: "anthropic:claude-sonnet-5"),
            createdAt: Date(timeIntervalSince1970: 0),
            updatedAt: Date(timeIntervalSince1970: 0)
        )
        XCTAssertEqual(
            try decoder.decode(CodeSession.self, from: encoder.encode(withProject)).workspaceID,
            workspaceID
        )
    }

    /// The transcript's opening event carries the same optionality, so a
    /// projectless session's log is readable rather than a decode failure at
    /// event zero.
    func testSessionCreatedEventDecodesWithoutAWorkspace() throws {
        let payload = SessionEventPayload.sessionCreated(
            SessionCreatedEvent(
                workspaceID: nil,
                workspaceName: nil,
                configuration: AgentConfiguration(modelID: "anthropic:claude-sonnet-5")
            )
        )
        let data = try JSONEncoder().encode(payload)
        guard case .sessionCreated(let restored) = try JSONDecoder().decode(
            SessionEventPayload.self,
            from: data
        ) else {
            return XCTFail("expected a sessionCreated payload")
        }
        XCTAssertNil(restored.workspaceID)
        XCTAssertNil(restored.workspaceName)
    }
}

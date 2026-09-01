import Foundation
import XCTest
@testable import JunoCodeCore

final class CodeSessionProtocolTests: XCTestCase {
    private let timestamp = Date(timeIntervalSince1970: 1_700_000_000)

    func testExecutionTargetAndConfigurationRoundTripWithoutPaths() throws {
        let target = ExecutionTarget(
            id: ExecutionTargetID(value: "device-a:workspace-a"),
            kind: .remote,
            displayName: "Liam's Mac",
            hostID: "device-a",
            workspace: ExecutionTargetWorkspace(
                id: WorkspaceID(value: "workspace-a"),
                displayName: "Juno",
                isGitRepository: true
            ),
            capabilities: [.workspaceAccess, .shell, .git, .approvals, .sessionResume],
            connectionState: .online,
            supportedModelIDs: ["openai:gpt-5.6-terra"],
            protocolVersion: .current
        )
        let configuration = AgentConfiguration(
            modelID: "openai:gpt-5.6-terra",
            location: .remote,
            executionTarget: target
        )

        let data = try JSONEncoder().encode(configuration)
        let decoded = try JSONDecoder().decode(AgentConfiguration.self, from: data)

        XCTAssertEqual(decoded.executionTarget, target)
        XCTAssertEqual(decoded.executionTarget.kind.sessionLocation, .remote)
        XCTAssertTrue(decoded.executionTarget.isSelectable)
        let text = String(decoding: data, as: UTF8.self)
        XCTAssertFalse(text.contains("/Users/"))
        XCTAssertFalse(text.contains("bookmark"))
    }

    func testOldConfigurationMigratesToNonRoutableLegacyTarget() throws {
        let legacy = """
        {
          "modelID":"openai:gpt-5.6-terra",
          "reasoningEffort":"high",
          "role":"engineer",
          "permissionMode":"askBeforeChanges",
          "location":"cloud",
          "computerUseEnabled":false
        }
        """

        let decoded = try JSONDecoder().decode(AgentConfiguration.self, from: Data(legacy.utf8))

        XCTAssertEqual(decoded.executionTarget.kind, .cloud)
        XCTAssertTrue(decoded.executionTarget.isLegacy)
        XCTAssertFalse(decoded.executionTarget.isSelectable)
    }

    func testExplicitTargetPreventsConflictingLegacyLocationFromPersisting() {
        let target = ExecutionTarget(
            id: ExecutionTargetID(value: "cloud-runner-a"),
            kind: .cloud,
            displayName: "Juno Cloud",
            repository: ExecutionTargetRepository(owner: "LiamMagnier", name: "juno"),
            connectionState: .online
        )
        let configuration = AgentConfiguration(
            modelID: "openai:gpt-5.6-terra",
            location: .local,
            executionTarget: target
        )

        XCTAssertEqual(configuration.location, .cloud)
        XCTAssertEqual(configuration.executionTarget, target)
    }

    func testVersionCompatibilityRejectsMajorDrift() {
        XCTAssertTrue(CodeProtocolVersion.current.isCompatible(with: .current))
        XCTAssertTrue(CodeProtocolVersion(major: 1, minor: 0).isCompatible(with: .init(major: 1, minor: 2)))
        XCTAssertFalse(CodeProtocolVersion.current.isCompatible(with: .init(major: 2)))
    }

    func testEventEnvelopeRoundTripsWithStableIdentity() throws {
        let event = envelope(sequence: 4, id: "event-4")
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601

        XCTAssertEqual(
            try decoder.decode(CodeSessionEventEnvelope.self, from: encoder.encode(event)),
            event
        )
    }

    func testReconnectSkipsPersistedEventsAndAcceptsOnlyContiguousTail() throws {
        let sessionID = CodeSessionID(value: "session-a")
        let plan = try CodeSessionEventAppendPlanner.plan(
            persistedThrough: 2,
            for: sessionID,
            incoming: [
                envelope(sessionID: sessionID, sequence: 4, id: "event-4"),
                envelope(sessionID: sessionID, sequence: 2, id: "replayed-event-2"),
                envelope(sessionID: sessionID, sequence: 3, id: "event-3"),
            ]
        )

        XCTAssertEqual(plan.accepted.map(\.sequence), [3, 4])
        XCTAssertEqual(plan.lastSequence, 4)
    }

    func testEventPlannerFailsClosedForGapsDuplicatesAndMajorVersionDrift() throws {
        let sessionID = CodeSessionID(value: "session-a")

        XCTAssertThrowsError(
            try CodeSessionEventAppendPlanner.plan(
                persistedThrough: 0,
                for: sessionID,
                incoming: [envelope(sessionID: sessionID, sequence: 2, id: "event-2")]
            )
        ) { error in
            XCTAssertEqual(
                error as? CodeSessionEventAppendError,
                .sequenceGap(expected: 1, received: 2)
            )
        }

        XCTAssertThrowsError(
            try CodeSessionEventAppendPlanner.plan(
                persistedThrough: 0,
                for: sessionID,
                incoming: [
                    envelope(sessionID: sessionID, sequence: 1, id: "event-1a"),
                    envelope(sessionID: sessionID, sequence: 1, id: "event-1b"),
                ]
            )
        ) { error in
            XCTAssertEqual(error as? CodeSessionEventAppendError, .duplicateSequence(1))
        }

        XCTAssertThrowsError(
            try CodeSessionEventAppendPlanner.plan(
                persistedThrough: 0,
                for: sessionID,
                incoming: [
                    CodeSessionEventEnvelope(
                        protocolVersion: .init(major: 2),
                        id: "event-1",
                        sessionID: sessionID,
                        sequence: 1,
                        occurredAt: timestamp,
                        payload: .statusChanged(StatusChangedEvent(status: .running))
                    ),
                ]
            )
        ) { error in
            XCTAssertEqual(
                error as? CodeSessionEventAppendError,
                .incompatibleProtocol(expectedMajor: 1, receivedMajor: 2)
            )
        }
    }

    func testCommandEnvelopeKeepsIdempotencyKeyAcrossRetriesAndExpiresClosed() throws {
        let command = CodeSessionCommandEnvelope(
            id: "command-1",
            idempotencyKey: "retry-safe-key",
            targetID: ExecutionTargetID(value: "host-a"),
            sessionID: CodeSessionID(value: "session-a"),
            kind: .approvalDecision,
            payload: ["approvalID": "call-1", "approved": true],
            issuedAt: timestamp,
            expiresAt: timestamp.addingTimeInterval(30)
        )
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601

        let decoded = try decoder.decode(
            CodeSessionCommandEnvelope.self,
            from: encoder.encode(command)
        )
        XCTAssertEqual(decoded.idempotencyKey, "retry-safe-key")
        XCTAssertFalse(decoded.isExpired(at: timestamp.addingTimeInterval(29)))
        XCTAssertTrue(decoded.isExpired(at: timestamp.addingTimeInterval(30)))
    }

    private func envelope(
        sessionID: CodeSessionID = CodeSessionID(value: "session-a"),
        sequence: Int,
        id: String
    ) -> CodeSessionEventEnvelope {
        CodeSessionEventEnvelope(
            id: id,
            sessionID: sessionID,
            sequence: sequence,
            occurredAt: timestamp,
            payload: .statusChanged(StatusChangedEvent(status: .running))
        )
    }
}

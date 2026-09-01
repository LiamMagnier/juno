import Foundation
import JunoCodeCore

public enum RuntimeCodeHostError: Error, Equatable, Sendable {
    case unsupportedProtocol(expectedMajor: Int, receivedMajor: Int)
    case unknownTarget(ExecutionTargetID)
    case unavailableTarget(ExecutionTargetID)
}

/// Long-lived, UI-independent host lifecycle. Platform composition roots inject
/// concrete workspace/runtime operations, but all clients share this one place
/// for target selection, command expiry, idempotent replay, and event cursors.
public actor RuntimeCodeHost: JunoCodeHosting {
    public typealias Targets = @Sendable () async throws -> [ExecutionTarget]
    public typealias Sessions = @Sendable () async throws -> [CodeSessionSummary]
    public typealias Events = @Sendable (CodeSessionEventCursor) async throws -> [CodeSessionEventEnvelope]
    public typealias Execute = @Sendable (CodeSessionCommandEnvelope) async throws -> CodeSessionCommandReceipt

    private let targetsProvider: Targets
    private let sessionsProvider: Sessions
    private let eventsProvider: Events
    private let executor: Execute
    private var receipts: [String: CodeSessionCommandReceipt] = [:]

    public init(
        targets: @escaping Targets,
        sessions: @escaping Sessions = { [] },
        events: @escaping Events,
        execute: @escaping Execute
    ) {
        targetsProvider = targets
        sessionsProvider = sessions
        eventsProvider = events
        executor = execute
    }

    public func executionTargets() async throws -> [ExecutionTarget] {
        try await targetsProvider()
    }

    public func sessions() async throws -> [CodeSessionSummary] {
        try await sessionsProvider().sorted { lhs, rhs in
            lhs.updatedAt == rhs.updatedAt ? lhs.id.value < rhs.id.value : lhs.updatedAt > rhs.updatedAt
        }
    }

    public func events(after cursor: CodeSessionEventCursor) async throws -> [CodeSessionEventEnvelope] {
        let events = try await eventsProvider(cursor)
        let plan = try CodeSessionEventAppendPlanner.plan(
            persistedThrough: cursor.afterSequence,
            for: cursor.sessionID,
            incoming: events
        )
        return plan.accepted
    }

    public func submit(_ command: CodeSessionCommandEnvelope) async throws -> CodeSessionCommandReceipt {
        if let receipt = receipts[command.idempotencyKey] { return receipt }
        guard command.protocolVersion.major == CodeProtocolVersion.current.major else {
            throw RuntimeCodeHostError.unsupportedProtocol(
                expectedMajor: CodeProtocolVersion.current.major,
                receivedMajor: command.protocolVersion.major
            )
        }
        if command.isExpired() {
            let receipt = CodeSessionCommandReceipt(
                commandID: command.id,
                idempotencyKey: command.idempotencyKey,
                disposition: .expired,
                errorCode: "expired",
                completedAt: Date()
            )
            receipts[command.idempotencyKey] = receipt
            return receipt
        }
        let targets = try await targetsProvider()
        guard let target = targets.first(where: { $0.id == command.targetID }) else {
            throw RuntimeCodeHostError.unknownTarget(command.targetID)
        }
        guard target.isSelectable else {
            throw RuntimeCodeHostError.unavailableTarget(command.targetID)
        }
        let receipt = try await executor(command)
        receipts[command.idempotencyKey] = receipt
        return receipt
    }
}

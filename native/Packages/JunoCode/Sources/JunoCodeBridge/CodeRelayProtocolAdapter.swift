import Foundation
import JunoCodeCore
import JunoCodeKit
import JunoCore

/// Compatibility adapter between the deployed relay DTOs and the canonical
/// Core protocol. It is intentionally the only place that translates legacy
/// string verbs; hosts and new clients use `CodeSessionCommandKind` directly.
public enum CodeRelayProtocolAdapter {
    public enum Error: Swift.Error, Equatable, Sendable {
        case unsupportedCommand(String)
        case malformedCanonicalEvent
    }

    public static func commandEnvelope(
        from command: CodeRemoteCommand,
        targetID: ExecutionTargetID,
        issuedAt: Date = Date()
    ) throws -> CodeSessionCommandEnvelope {
        guard let kind = commandKind(command.kind) else {
            throw Error.unsupportedCommand(command.kind)
        }
        return CodeSessionCommandEnvelope(
            // The relay has already made `command.id` idempotent. Reusing it
            // here preserves that guarantee during the adapter phase.
            id: command.id,
            idempotencyKey: command.id,
            targetID: targetID,
            sessionID: CodeSessionID(value: command.sessionID),
            kind: kind,
            payload: command.payload.mapValues(coreValue),
            issuedAt: issuedAt
        )
    }

    /// A canonical event travels through the existing append-only relay as one
    /// event kind. Older clients keep rendering their familiar legacy events;
    /// new clients can decode the complete typed event without inventing a
    /// second semantic vocabulary.
    public static func relayEvent(from event: CodeSessionEventEnvelope) throws -> CodeRemoteSessionEvent {
        let data = try encoder.encode(event)
        let encoded = try decoder.decode(JunoJSONValue.self, from: data)
        return CodeRemoteSessionEvent(
            seq: event.sequence,
            kind: "canonical_session_event",
            payload: ["event": encoded],
            createdAt: event.occurredAt
        )
    }

    public static func canonicalEvent(
        from event: CodeRemoteSessionEvent
    ) throws -> CodeSessionEventEnvelope? {
        guard event.kind == "canonical_session_event" else { return nil }
        guard let raw = event.payload["event"] else { throw Error.malformedCanonicalEvent }
        let data = try encoder.encode(raw)
        let decoded = try decoder.decode(CodeSessionEventEnvelope.self, from: data)
        guard decoded.sequence == event.seq else { throw Error.malformedCanonicalEvent }
        return decoded
    }

    private static func commandKind(_ raw: String) -> CodeSessionCommandKind? {
        switch raw {
        case "create_session": .createSession
        case "message", "send_message": .sendMessage
        case "stop", "stop_agent": .cancel
        case "approval", "approval_decision": .approvalDecision
        case "retry": .retry
        case "fork": .fork
        case "run_tests": .runTests
        case "stop_tests": .stopTests
        case "git", "git_action": .gitAction
        default: nil
        }
    }

    private static func coreValue(_ value: JunoJSONValue) -> JSONValue {
        switch value {
        case .null: .null
        case .bool(let value): .bool(value)
        case .number(let value): .number(value)
        case .string(let value): .string(value)
        case .array(let values): .array(values.map(coreValue))
        case .object(let values): .object(values.mapValues(coreValue))
        }
    }

    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()

    private static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()
}

/// The executor installed in the existing `CodeRemoteHost` during migration.
/// It accepts the deployed relay DTO, converts it to the canonical command,
/// then invokes the already-authorised runtime adapter. This makes the running
/// macOS remote path exercise the new contract today, without a flag-day relay
/// rollout or a second permission implementation.
public struct CanonicalRelayCommandExecutor: CodeRemoteCommandExecuting {
    private let adapter: RemoteCommandAdapter
    private let targetID: ExecutionTargetID

    public init(adapter: RemoteCommandAdapter, targetID: ExecutionTargetID) {
        self.adapter = adapter
        self.targetID = targetID
    }

    public func execute(_ command: CodeRemoteCommand) async throws -> [String: JunoJSONValue] {
        let canonical = try CodeRelayProtocolAdapter.commandEnvelope(
            from: command, targetID: targetID
        )
        let receipt = try await adapter.execute(canonical)
        guard receipt.disposition == .completed else {
            throw CodeRemoteCommandError.invalidField(
                "command", reason: receipt.errorCode ?? receipt.disposition.rawValue
            )
        }
        return (receipt.result ?? [:]).mapValues(relayValue)
    }

    private func relayValue(_ value: JSONValue) -> JunoJSONValue {
        switch value {
        case .null: .null
        case .bool(let value): .bool(value)
        case .number(let value): .number(value)
        case .string(let value): .string(value)
        case .array(let values): .array(values.map(relayValue))
        case .object(let values): .object(values.mapValues(relayValue))
        }
    }
}

/// Same relay edge, backed by the long-lived Core host rather than a UI model.
public struct CanonicalRelayHostExecutor: CodeRemoteCommandExecuting {
    private let host: any JunoCodeHosting
    private let targetID: ExecutionTargetID

    public init(host: any JunoCodeHosting, targetID: ExecutionTargetID) {
        self.host = host
        self.targetID = targetID
    }

    public func execute(_ command: CodeRemoteCommand) async throws -> [String: JunoJSONValue] {
        let canonical = try CodeRelayProtocolAdapter.commandEnvelope(from: command, targetID: targetID)
        let receipt = try await host.submit(canonical)
        guard receipt.disposition == .completed else {
            throw CodeRemoteCommandError.invalidField("command", reason: receipt.errorCode ?? receipt.disposition.rawValue)
        }
        return (receipt.result ?? [:]).mapValues(relayValue)
    }

    private func relayValue(_ value: JSONValue) -> JunoJSONValue {
        switch value {
        case .null: .null; case .bool(let value): .bool(value); case .number(let value): .number(value)
        case .string(let value): .string(value); case .array(let values): .array(values.map(relayValue))
        case .object(let values): .object(values.mapValues(relayValue))
        }
    }
}

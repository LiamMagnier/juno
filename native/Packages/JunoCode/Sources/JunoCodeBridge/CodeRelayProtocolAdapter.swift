import Foundation
import JunoCodeCore
import JunoCodeKit
import JunoCore

/// Compatibility adapter between the deployed relay DTOs and the canonical
/// Core protocol. It is intentionally the only place that translates legacy
/// string verbs; hosts and new clients use `CodeSessionCommandKind` directly.
public enum CodeRelayProtocolAdapter {
    public enum Error: Swift.Error, Equatable, Sendable, LocalizedError {
        case unsupportedCommand(String)
        /// A verb this Mac knows and will not take from another device.
        case refusedCommand(String, reason: String)
        case malformedCanonicalEvent

        /// This text is what the phone shows when a command fails, so it has
        /// to say what happened rather than name a Swift type.
        public var errorDescription: String? {
            switch self {
            case .unsupportedCommand(let kind):
                "This Mac cannot run a \"\(kind)\" command. Update Juno on the Mac and try again."
            case .refusedCommand(_, let reason):
                reason
            case .malformedCanonicalEvent:
                "A session event could not be read."
            }
        }
    }

    public static func commandEnvelope(
        from command: CodeRemoteCommand,
        targetID: ExecutionTargetID,
        issuedAt: Date = Date()
    ) throws -> CodeSessionCommandEnvelope {
        if let reason = refusal(for: command.kind) {
            throw Error.refusedCommand(command.kind, reason: reason)
        }
        guard let kind = commandKind(command) else {
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

    /// Every verb the relay carries maps here or is refused by name. The four
    /// review verbs used to fall through to "unsupported", which is how a phone
    /// tapping Undo got an error that named nothing it had done.
    private static func commandKind(_ command: CodeRemoteCommand) -> CodeSessionCommandKind? {
        switch command.kind {
        case "create_session": .createSession
        case "message", "send_message": .sendMessage
        case "steer": .steer
        case "queue": .queue
        case "stop", "stop_agent": .cancel
        case "approval", "approval_decision": .approvalDecision
        case "retry": .retry
        case "fork": .fork
        case "run_tests": .runTests
        case "stop_tests": .stopTests
        case "git", "git_action": .gitAction
        case "accept_change": .acceptChange
        case "reject_change": .rejectChange
        case "undo_change": .undoChange
        case "delete_change": .deleteChange
        case "update_session": .updateSession
        // `apply_patch` is what older relays made of the phone's session menu
        // ("patch"). With a change named it keeps a change; without one it
        // was always a settings update.
        case "apply_patch", "patch":
            RemoteCommandAdapter.changeFields.contains(where: {
                command.payload[$0]?.stringValue?.isEmpty == false
            }) ? .acceptChange : .updateSession
        default: nil
        }
    }

    /// Verbs this host understands and deliberately does not act on from
    /// another device, with what the reader should do instead.
    private static func refusal(for kind: String) -> String? {
        switch kind {
        case "delete", "delete_session":
            // A bare `delete` only reaches a host from the session route's
            // Delete; the relay's own `delete` becomes `delete_change` first.
            "Sessions are deleted on the Mac itself. This one is still there."
        default:
            nil
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

/// The relay edge the Mac's `CodeRemoteHost` executes through, backed by the
/// long-lived Core host rather than a UI model.
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

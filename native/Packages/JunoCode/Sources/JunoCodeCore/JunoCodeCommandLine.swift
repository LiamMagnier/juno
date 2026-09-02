import Foundation

/// Transport-neutral command client for the `juno` executable. Parsing and
/// rendering are deliberately separate from `JunoCodeHosting`: a Unix-socket,
/// XPC, or authenticated relay connection can all run the exact same commands.
public struct JunoCodeCommandLine: Sendable {
    public let host: any JunoCodeHosting

    public init(host: any JunoCodeHosting) { self.host = host }

    public func execute(arguments: [String]) async throws -> JunoCodeCLIResult {
        let args = Array(arguments.drop(while: { $0 == "juno" }))
        guard let command = args.first else { return .usage }
        switch command {
        case "targets", "devices":
            return .targets(try await host.executionTargets())
        case "sessions":
            return .sessions(try await host.sessions())
        case "status":
            guard args.count == 2 else { throw JunoCodeCLIError.usage("status <session-id>") }
            let id = CodeSessionID(value: args[1])
            guard let session = try await host.sessions().first(where: { $0.id == id }) else {
                throw JunoCodeCLIError.sessionNotFound(args[1])
            }
            return .sessions([session])
        case "events", "resume":
            guard args.count >= 2 else { throw JunoCodeCLIError.usage("events <session-id> [after-seq]") }
            let after = args.count == 3 ? try sequence(args[2]) : 0
            let events = try await host.events(after: .init(
                sessionID: CodeSessionID(value: args[1]), afterSequence: after
            ))
            return .events(events)
        case "run":
            return try await run(arguments: args)
        case "cancel":
            return try await submit(kind: .cancel, arguments: args)
        case "steer":
            return try await instruction(kind: .steer, arguments: args)
        case "queue":
            return try await instruction(kind: .queue, arguments: args)
        case "approvals":
            return try await approval(arguments: args)
        default:
            throw JunoCodeCLIError.usage("unknown command: \(command)")
        }
    }

    private func submit(
        kind: CodeSessionCommandKind, arguments: [String]
    ) async throws -> JunoCodeCLIResult {
        guard arguments.count == 3 else { throw JunoCodeCLIError.usage("cancel <target-id> <session-id>") }
        let receipt = try await host.submit(.init(
            targetID: .init(value: arguments[1]), sessionID: .init(value: arguments[2]), kind: kind
        ))
        return .receipt(receipt)
    }

    private func instruction(
        kind: CodeSessionCommandKind, arguments: [String]
    ) async throws -> JunoCodeCLIResult {
        guard arguments.count == 4 else {
            throw JunoCodeCLIError.usage("\(kind.rawValue) <target-id> <session-id> <message>")
        }
        let receipt = try await host.submit(.init(
            targetID: .init(value: arguments[1]),
            sessionID: .init(value: arguments[2]),
            kind: kind,
            payload: ["text": .string(arguments[3])]
        ))
        return .receipt(receipt)
    }

    /// Noninteractive run is one idempotent host command, never a CLI-owned
    /// agent loop. Keeping the first prompt on `createSession` is important for
    /// queued targets: a relay cannot know the eventual session id until its
    /// host has claimed the command, so a second, client-side message command
    /// would either race or need to invent a fake session identifier.
    ///
    /// The workspace is an opaque grant identifier; a host still verifies it
    /// before creation.
    private func run(arguments: [String]) async throws -> JunoCodeCLIResult {
        guard arguments.count >= 4 else {
            throw JunoCodeCLIError.usage("run <target-id> <workspace-id> <prompt> [--model id] [--reasoning level]")
        }
        let targetID = ExecutionTargetID(value: arguments[1])
        var payload: [String: JSONValue] = [
            "workspaceId": .string(arguments[2]),
            "initialMessage": .string(arguments[3]),
        ]
        var index = 4
        while index < arguments.count {
            guard index + 1 < arguments.count else { throw JunoCodeCLIError.usage("missing value for \(arguments[index])") }
            switch arguments[index] {
            case "--model": payload["modelId"] = .string(arguments[index + 1])
            case "--reasoning": payload["reasoning"] = .string(arguments[index + 1])
            default: throw JunoCodeCLIError.usage("unknown run option: \(arguments[index])")
            }
            index += 2
        }
        let created = try await host.submit(.init(
            targetID: targetID, sessionID: nil, kind: .createSession,
            payload: payload
        ))
        return .receipt(created)
    }

    private func approval(arguments: [String]) async throws -> JunoCodeCLIResult {
        guard arguments.count == 5, let approved = Bool(arguments[4]) else {
            throw JunoCodeCLIError.usage("approvals <target-id> <session-id> <request-id> <true|false>")
        }
        let receipt = try await host.submit(.init(
            targetID: .init(value: arguments[1]), sessionID: .init(value: arguments[2]),
            kind: .approvalDecision,
            payload: ["approvalId": .string(arguments[3]), "approved": .bool(approved)]
        ))
        return .receipt(receipt)
    }

    private func sequence(_ value: String) throws -> Int {
        guard let result = Int(value), result >= 0 else { throw JunoCodeCLIError.usage("after-seq must be >= 0") }
        return result
    }
}

public enum JunoCodeCLIResult: Sendable {
    case usage
    case targets([ExecutionTarget])
    case sessions([CodeSessionSummary])
    case events([CodeSessionEventEnvelope])
    case receipt(CodeSessionCommandReceipt)
}

public enum JunoCodeCLIError: Error, Equatable, LocalizedError, Sendable {
    case usage(String)
    case sessionNotFound(String)

    public var errorDescription: String? {
        switch self {
        case .usage(let detail): "Usage: juno \(detail)"
        case .sessionNotFound(let id): "No Juno Code session named \(id)."
        }
    }
}

import Foundation
import JunoCodeCore

/// The runtime-facing hook contract. The runtime deliberately knows nothing
/// about Claude/Juno configuration files or shell processes; those belong to
/// the local integration layer. This keeps the agent loop testable and lets a
/// future remote runner provide the same lifecycle without importing local
/// workspace code.
public struct AgentToolHookInvocation: Equatable, Sendable {
    public let sessionID: CodeSessionID
    public let toolName: String
    public let input: JSONValue

    public init(
        sessionID: CodeSessionID,
        toolName: String,
        input: JSONValue
    ) {
        self.sessionID = sessionID
        self.toolName = toolName
        self.input = input
    }
}

public enum AgentHookDecision: Equatable, Sendable {
    case allow
    case deny(reason: String)
}

/// Optional lifecycle integration for an agent run.
public protocol AgentLifecycleHooks: Sendable {
    func sessionStarted(sessionID: CodeSessionID) async

    /// Runs before Juno authorizes or executes a tool. A denial is returned to
    /// the model as a normal failed tool result and the tool is never started.
    func beforeTool(_ invocation: AgentToolHookInvocation) async -> AgentHookDecision

    /// Runs after the tool's result has been recorded. Post hooks are
    /// observational: they cannot rewrite a result that already happened.
    func afterTool(
        _ invocation: AgentToolHookInvocation,
        succeeded: Bool,
        summary: String
    ) async

    func sessionStopped(sessionID: CodeSessionID, status: SessionStatus) async
}

public extension AgentLifecycleHooks {
    func sessionStarted(sessionID _: CodeSessionID) async {}

    func beforeTool(_: AgentToolHookInvocation) async -> AgentHookDecision {
        .allow
    }

    func afterTool(
        _: AgentToolHookInvocation,
        succeeded _: Bool,
        summary _: String
    ) async {}

    func sessionStopped(sessionID _: CodeSessionID, status _: SessionStatus) async {}
}

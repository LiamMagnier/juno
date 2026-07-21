import Foundation
import JunoCodeCore

public enum ToolError: Error, Equatable, Sendable {
    case unknownTool(name: String)
    case invalidInput(message: String)
    case denied(reason: String)
    case cancelled
    case executionFailed(message: String)
}

/// The result a tool hands back to the agent loop.
public struct ToolResult: Sendable {
    /// Bounded text returned to the model.
    public let content: String
    public let isError: Bool
    /// Structured transcript events produced by this call (file changes,
    /// test outcomes, …) beyond the generic tool events.
    public let sideEffects: [SessionEventPayload]

    public init(content: String, isError: Bool = false, sideEffects: [SessionEventPayload] = []) {
        self.content = content
        self.isError = isError
        self.sideEffects = sideEffects
    }
}

/// Per-invocation services handed to a tool.
public struct ToolContext: Sendable {
    public let sessionID: CodeSessionID
    public let toolCallID: String
    /// Streams live output (command stdout/stderr) into the transcript.
    public let emitOutput: @Sendable (ToolOutputChannel, String) async -> Void

    public init(
        sessionID: CodeSessionID,
        toolCallID: String,
        emitOutput: @escaping @Sendable (ToolOutputChannel, String) async -> Void
    ) {
        self.sessionID = sessionID
        self.toolCallID = toolCallID
        self.emitOutput = emitOutput
    }
}

/// One agent-invocable tool: a JSON-schema input contract, argument-aware
/// risk assessment, a human-readable action summary, and the execution.
public protocol CodeTool: Sendable {
    var name: String { get }
    var description: String { get }
    var inputSchema: JSONValue { get }

    func assessRisk(input: JSONValue) -> ActionRisk
    func summary(input: JSONValue) -> String
    /// Semantic refusal before any authorization: return an error for input
    /// that must never run (forbidden commands), so it cannot even be
    /// proposed for approval.
    func precheck(input: JSONValue) -> ToolError?
    func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult
}

public extension CodeTool {
    func precheck(input: JSONValue) -> ToolError? { nil }
}

public extension CodeTool {
    /// The digest binding an approval to this exact invocation.
    func actionDigest(input: JSONValue) -> String {
        let canonical = JSONValue.object([
            "tool": .string(name),
            "input": input,
        ]).canonicalJSONString()
        return Digests.sha256Hex(canonical)
    }
}

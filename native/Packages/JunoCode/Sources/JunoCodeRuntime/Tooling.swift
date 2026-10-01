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
    /// Ephemeral visual output for the immediately following vision turn.
    /// The orchestrator bounds it and the session store strips it on write.
    public let images: [ModelImage]
    /// Structured transcript events produced by this call (file changes,
    /// test outcomes, …) beyond the generic tool events.
    public let sideEffects: [SessionEventPayload]
    /// Set when this call is the end of the run: the batch is answered and
    /// the run completes with this summary instead of asking the model for
    /// another turn. `exit_plan` uses it — an approved plan is implemented in
    /// a new Code turn, not by the read-only run that wrote it.
    public let endsRun: String?
    /// Context the call earned beyond its own answer — a folder's instruction
    /// files — kept apart from `content` so the result's own bounds apply to
    /// the tool's text alone. A read_file result is a header that vouches for
    /// the lines after it; with instructions inside the same string, a cut
    /// counted them as file lines, and cutting at all withdrew base_sha256.
    /// The orchestrator puts it after the bounded content.
    public let appendedContext: String?

    public init(
        content: String,
        isError: Bool = false,
        images: [ModelImage] = [],
        sideEffects: [SessionEventPayload] = [],
        endsRun: String? = nil,
        appendedContext: String? = nil
    ) {
        self.content = content
        self.isError = isError
        self.images = images
        self.sideEffects = sideEffects
        self.endsRun = endsRun
        self.appendedContext = appendedContext
    }

    /// The content with its appended context, as one text.
    public var contentWithContext: String {
        appendedContext.map { content + "\n\n" + $0 } ?? content
    }
}

/// Per-invocation services handed to a tool.
public struct ToolContext: Sendable {
    public let sessionID: CodeSessionID
    public let toolCallID: String
    /// Streams live output (command stdout/stderr) into the transcript.
    public let emitOutput: @Sendable (ToolOutputChannel, String) async -> Void
    /// Where this session keeps command output too long to return whole, in
    /// the session's own folder of the store. Nil where there is none, and
    /// then long output keeps only its ends. See ``CommandOutputSpill``.
    public let commandOutputDirectory: URL?

    public init(
        sessionID: CodeSessionID,
        toolCallID: String,
        emitOutput: @escaping @Sendable (ToolOutputChannel, String) async -> Void,
        commandOutputDirectory: URL? = nil
    ) {
        self.sessionID = sessionID
        self.toolCallID = toolCallID
        self.emitOutput = emitOutput
        self.commandOutputDirectory = commandOutputDirectory
    }
}

/// One agent-invocable tool: a JSON-schema input contract, argument-aware
/// risk assessment, a human-readable action summary, and the execution.
public protocol CodeTool: Sendable {
    var name: String { get }
    var description: String { get }
    var inputSchema: JSONValue { get }

    func assessRisk(input: JSONValue) -> ActionRisk
    /// Whether this tool's authorization is decided by the risk ladder alone.
    /// Defaults to `.byRisk`; a tool that must be seen before every run pins it
    /// to `.alwaysRequiresApproval` instead of inflating its risk tier.
    var approvalPolicy: ApprovalPolicy { get }
    /// The policy for one invocation. Defaults to `approvalPolicy`; a tool
    /// whose pin depends on what it is asked to do (`run_tests` follows the
    /// rules for an accepted recipe check) answers per input.
    func approvalPolicy(input: JSONValue) -> ApprovalPolicy
    func summary(input: JSONValue) -> String
    /// Semantic refusal before any authorization: return an error for input
    /// that must never run (forbidden commands), so it cannot even be
    /// proposed for approval.
    func precheck(input: JSONValue) -> ToolError?
    func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult
}

public extension CodeTool {
    func precheck(input: JSONValue) -> ToolError? { nil }
    var approvalPolicy: ApprovalPolicy { .byRisk }
    func approvalPolicy(input _: JSONValue) -> ApprovalPolicy { approvalPolicy }
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

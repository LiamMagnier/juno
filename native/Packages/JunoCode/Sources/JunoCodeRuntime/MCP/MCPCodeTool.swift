import Foundation
import JunoCodeCore

/// Adapts one discovered MCP tool to Juno's normal authorization and transcript
/// contract. MCP is an external side effect by definition: even a tool whose
/// description says "read" can reach a network service or mutate data outside
/// the workspace, so it is always approval-pinned.
public struct MCPCodeTool: CodeTool {
    private let registry: MCPToolRegistry
    private let reference: MCPToolReference

    public init(registry: MCPToolRegistry, reference: MCPToolReference) {
        self.registry = registry
        self.reference = reference
    }

    /// `mcp__<server>__<tool>`, never longer than providers accept.
    ///
    /// Anthropic and OpenAI both cap tool names at 64 characters and reject
    /// the *whole request* over one that is longer, so a single verbose MCP
    /// tool used to fail every turn of every session in that workspace. Past
    /// the limit the name keeps its readable start and ends in a digest of the
    /// full name, which keeps it stable and unique.
    public var name: String {
        let full = "mcp__" + Self.safeName(reference.serverID) + "__"
            + Self.safeName(reference.definition.name)
        guard full.count > Self.maximumNameLength else { return full }
        let digest = String(Digests.sha256Hex(full).prefix(8))
        return String(full.prefix(Self.maximumNameLength - digest.count - 1)) + "_" + digest
    }

    static let maximumNameLength = 64

    public var description: String {
        let server = reference.serverID
        let remoteDescription = reference.definition.description ?? "No description supplied."
        return "MCP server \(server) tool \(reference.definition.name): \(remoteDescription)"
    }

    public var inputSchema: JSONValue { reference.definition.inputSchema }

    public func assessRisk(input _: JSONValue) -> ActionRisk { .critical }

    public var approvalPolicy: ApprovalPolicy { .alwaysRequiresApproval }

    public func summary(input: JSONValue) -> String {
        "MCP \(reference.serverID)/\(reference.definition.name)"
    }

    public func precheck(input: JSONValue) -> ToolError? {
        guard input.objectValue != nil else {
            return .invalidInput(message: "MCP tool arguments must be an object.")
        }
        return nil
    }

    public func execute(input: JSONValue, context _: ToolContext) async throws -> ToolResult {
        let result = try await registry.invoke(
            serverID: reference.serverID,
            toolName: reference.definition.name,
            arguments: input,
            // The outer ToolRegistry already authorized this exact invocation.
            // Keeping the registry's callback explicit prevents a second,
            // weaker implicit policy from ever being added accidentally.
            authorize: { _, _ in }
        )
        var content = result.textContent
        if content.isEmpty, let structured = result.structuredContent {
            content = structured.canonicalJSONString()
        }
        if content.isEmpty {
            content = "MCP tool returned no text content."
        }
        return ToolResult(
            content: content,
            isError: result.isError
        )
    }

    /// One segment of the name, in the only characters providers accept:
    /// ASCII letters and digits, `_` and `-` (`^[a-zA-Z0-9_-]{1,64}$`).
    ///
    /// `isLetter` used to let `é` or a CJK name through, and a request
    /// declaring it was a 400 on every turn of every session in the
    /// workspace. Anything else becomes `_`. Where a character outside ASCII
    /// was replaced, a digest of the original follows, because two names in
    /// another script would otherwise both come out as underscores and
    /// collide.
    static func safeName(_ value: String) -> String {
        var replacedNonASCII = false
        let mapped = value.unicodeScalars.map { scalar -> Character in
            if scalar.isASCII,
               CharacterSet.alphanumerics.contains(scalar) || scalar == "_" || scalar == "-"
            {
                return Character(scalar)
            }
            if !scalar.isASCII { replacedNonASCII = true }
            return "_"
        }
        var result = String(String(mapped).prefix(96))
        if result.isEmpty { result = "tool" }
        if replacedNonASCII {
            result += "_" + String(Digests.sha256Hex(value).prefix(6))
        }
        return result
    }
}

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

    public var name: String {
        "mcp__" + Self.safeName(reference.serverID) + "__" + Self.safeName(reference.definition.name)
    }

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

    private static func safeName(_ value: String) -> String {
        let mapped = value.map { character in
            character.isLetter || character.isNumber || character == "_" || character == "-"
                ? character
                : "_"
        }
        let result = String(mapped)
        return result.isEmpty ? "tool" : String(result.prefix(96))
    }
}

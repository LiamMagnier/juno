import Foundation
import JunoCodeCore

/// Tools from Juno's extension points (§5.2, §5.8–§5.12), offered to Code
/// turns through `CodeToolProviders`.
///
/// Owned by Lane F (commands, hooks, MCP, agents and composer inputs). Today
/// these are the three tools that follow background sub-agents
/// (`delegate_task` with `background: true`): wait on them, read one, stop
/// one. They change nothing in the workspace — a sub-agent's own tool calls
/// go through its own approvals — so they are reads and never ask.
public struct ExtensionToolProvider: CodeToolProvider {
    public init() {}

    public func tools(for context: CodeToolProviderContext) async -> [any CodeTool] {
        guard let registry = context.backgroundSubagents else { return [] }
        return [
            AwaitSubagentsTool(registry: registry),
            InspectSubagentTool(registry: registry),
            CancelSubagentTool(registry: registry),
        ]
    }
}

/// `await_subagents {ids, timeout_s}`: waits for background sub-agents to
/// finish and returns their answers.
public struct AwaitSubagentsTool: CodeTool {
    let registry: BackgroundSubagentRegistry

    public init(registry: BackgroundSubagentRegistry) {
        self.registry = registry
    }

    /// The longest one call waits; the model can call again.
    public static let maximumTimeout = 600

    public let name = "await_subagents"
    public let description = """
        Wait for background sub-agents (started with delegate_task background: true) to \
        finish and return each one's answer. Pass their ids, or none for every background \
        sub-agent this session started. Returns when all have finished or timeout_s passes \
        (default 120, at most 600); ones still running are listed as such.
        """
    public var inputSchema: JSONValue {
        [
            "type": "object",
            "properties": [
                "ids": ["type": "array", "items": ["type": "string"]],
                "timeout_s": ["type": "integer", "minimum": 1, "maximum": .number(Double(Self.maximumTimeout))],
            ],
        ]
    }

    public func assessRisk(input _: JSONValue) -> ActionRisk { .read }

    public func summary(input: JSONValue) -> String {
        let count = input["ids"]?.arrayValue?.count ?? 0
        return count == 0 ? "Wait for background sub-agents" : "Wait for \(count) background sub-agent\(count == 1 ? "" : "s")"
    }

    public func execute(input: JSONValue, context _: ToolContext) async throws -> ToolResult {
        var ids = input["ids"]?.arrayValue?.compactMap(\.stringValue) ?? []
        if ids.isEmpty {
            ids = await registry.all().map(\.id)
        }
        guard !ids.isEmpty else {
            return ToolResult(content: "No background sub-agents have been started in this session.")
        }
        let seconds = min(max(Int(input["timeout_s"]?.numberValue ?? 120), 1), Self.maximumTimeout)
        let entries = await registry.waitFor(ids, timeout: .seconds(seconds))
        let unknown = ids.filter { id in !entries.contains { $0.id == id } }
        var sections = entries.map(Self.report)
        if !unknown.isEmpty {
            sections.append("Unknown ids: \(unknown.joined(separator: ", "))")
        }
        let running = entries.filter { !$0.isFinished }.count
        let headline = running == 0
            ? "\(entries.count) background sub-agent\(entries.count == 1 ? "" : "s") finished."
            : "\(running) still running after \(seconds)s."
        return ToolResult(content: ([headline] + sections).joined(separator: "\n\n"))
    }

    static func report(_ entry: BackgroundSubagentRegistry.Entry) -> String {
        guard entry.isFinished else { return "## \(entry.line)\nStill working." }
        return "## \(entry.line)\n\(entry.answer ?? "No answer was recorded.")"
    }
}

/// `inspect_subagent {id}`: how one background sub-agent stands.
public struct InspectSubagentTool: CodeTool {
    let registry: BackgroundSubagentRegistry

    public init(registry: BackgroundSubagentRegistry) {
        self.registry = registry
    }

    public let name = "inspect_subagent"
    public let description = """
        Read how one background sub-agent stands: its status, and its answer once it has \
        finished. Does not wait.
        """
    public var inputSchema: JSONValue {
        [
            "type": "object",
            "properties": ["id": ["type": "string"]],
            "required": ["id"],
        ]
    }

    public func assessRisk(input _: JSONValue) -> ActionRisk { .read }

    public func summary(input: JSONValue) -> String {
        "Check background sub-agent \(input["id"]?.stringValue ?? "")"
    }

    public func execute(input: JSONValue, context _: ToolContext) async throws -> ToolResult {
        let id = input["id"]?.stringValue ?? ""
        guard let entry = await registry.entry(id) else {
            return ToolResult(content: "No background sub-agent has the id \(id).", isError: true)
        }
        return ToolResult(content: AwaitSubagentsTool.report(entry))
    }
}

/// `cancel_subagent {id}`: stops one background sub-agent.
public struct CancelSubagentTool: CodeTool {
    let registry: BackgroundSubagentRegistry

    public init(registry: BackgroundSubagentRegistry) {
        self.registry = registry
    }

    public let name = "cancel_subagent"
    public let description = "Stop one background sub-agent this session started."
    public var inputSchema: JSONValue {
        [
            "type": "object",
            "properties": ["id": ["type": "string"]],
            "required": ["id"],
        ]
    }

    public func assessRisk(input _: JSONValue) -> ActionRisk { .read }

    public func summary(input: JSONValue) -> String {
        "Stop background sub-agent \(input["id"]?.stringValue ?? "")"
    }

    public func execute(input: JSONValue, context _: ToolContext) async throws -> ToolResult {
        let id = input["id"]?.stringValue ?? ""
        guard await registry.entry(id) != nil else {
            return ToolResult(content: "No background sub-agent has the id \(id).", isError: true)
        }
        return await registry.cancel(id)
            ? ToolResult(content: "Stopped \(id).")
            : ToolResult(content: "\(id) had already finished.")
    }
}

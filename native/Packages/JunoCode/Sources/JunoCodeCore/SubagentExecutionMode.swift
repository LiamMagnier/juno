/// Whether a delegated agent may mutate its isolated checkout.
///
/// This is part of the durable sub-agent lifecycle event as well as the
/// runtime execution request, so it belongs in Core rather than only in the
/// runtime module.
public enum SubagentExecutionMode: String, Codable, CaseIterable, Sendable {
    case readOnly = "read_only"
    case workspaceWrite = "workspace_write"
}

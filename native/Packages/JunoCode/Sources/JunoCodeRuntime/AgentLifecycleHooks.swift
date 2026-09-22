import Foundation
import JunoCodeCore

/// The runtime-facing hook contract. The runtime deliberately knows nothing
/// about Claude/Juno configuration files or shell processes; those belong to
/// the local integration layer. This keeps the agent loop testable and lets a
/// future remote runner provide the same lifecycle without importing local
/// workspace code.
public struct AgentToolHookInvocation: Equatable, Sendable {
    public let sessionID: CodeSessionID
    public let toolCallID: String
    public let toolName: String
    public let input: JSONValue

    public init(
        sessionID: CodeSessionID,
        toolCallID: String = "",
        toolName: String,
        input: JSONValue
    ) {
        self.sessionID = sessionID
        self.toolCallID = toolCallID
        self.toolName = toolName
        self.input = input
    }
}

/// How a session came to be starting, for `SessionStart` hooks.
public enum AgentSessionStartSource: String, Sendable {
    /// The session's first prompt.
    case startup
    /// A session with history, opened again.
    case resume
}

/// What a `Notification` hook is being told about.
public enum AgentHookNotificationKind: String, Sendable {
    /// The agent is waiting on an approval.
    case permissionPrompt = "permission_prompt"
    /// A run ended and nothing has happened since.
    case idlePrompt = "idle_prompt"
}

/// A hook's view of the approval prompt for one tool call.
public enum AgentHookPermission: Equatable, Sendable {
    /// Skip the prompt — but only where the reader's own allow rule could:
    /// never past a deny or ask rule, a read-only mode, a destructive action
    /// or a tool that always asks. See `PermissionCoordinator.ruling`.
    case allow
    /// Show the prompt, even where the mode would have let the call through.
    case ask
}

/// Everything the hooks for one lifecycle point had to say.
///
/// One shape for every event, because the questions are the same ones —
/// did a hook block this, end the run, add context, or need the reader to
/// know something — and the runtime decides what each means where it asks.
public struct AgentHookResponse: Equatable, Sendable {
    /// A hook blocked what triggered it: the tool does not run, the prompt is
    /// not sent, the agent does not stop. The text goes to whoever reads next
    /// — the model for a tool or a stop, the reader for a prompt.
    public var blockReason: String?
    /// A `PreToolUse` hook's answer about the approval prompt.
    public var permission: AgentHookPermission?
    /// `"continue": false`: the run ends here, and this is why.
    public var haltReason: String?
    /// Text to add to what the model reads next.
    public var context: [String]
    /// What the thread shows. Recorded by the runtime as `hookActivity`
    /// events, in order, at the point the hooks ran.
    public var notices: [HookActivityEvent]

    public init(
        blockReason: String? = nil,
        permission: AgentHookPermission? = nil,
        haltReason: String? = nil,
        context: [String] = [],
        notices: [HookActivityEvent] = []
    ) {
        self.blockReason = blockReason
        self.permission = permission
        self.haltReason = haltReason
        self.context = context
        self.notices = notices
    }

    public static let empty = AgentHookResponse()
}

/// Optional lifecycle integration for an agent run.
///
/// Every method has a default that does nothing, so an integration
/// implements only the events it cares about.
public protocol AgentLifecycleHooks: Sendable {
    /// Runs before a prompt is sent, once the session has something to send.
    /// An integration decides whether this is the session's start — Juno Code
    /// answers once per session per launch — and the context it returns
    /// travels with the prompt.
    func sessionStarted(
        sessionID: CodeSessionID,
        source: AgentSessionStartSource
    ) async -> AgentHookResponse

    /// Runs before a prompt, a steer or a queued message reaches the model.
    /// A block means it is never sent.
    func promptSubmitted(sessionID: CodeSessionID, prompt: String) async -> AgentHookResponse

    /// Runs before Juno authorizes or executes a tool. A block is returned to
    /// the model as a normal failed tool result and the tool is never started.
    func beforeTool(_ invocation: AgentToolHookInvocation) async -> AgentHookResponse

    /// Runs after the tool's result has been recorded. A post hook cannot
    /// undo what happened; a block here is a note the model reads with the
    /// result.
    func afterTool(
        _ invocation: AgentToolHookInvocation,
        succeeded: Bool,
        content: String
    ) async -> AgentHookResponse

    /// Runs when the agent is about to finish its turn of its own accord. A
    /// block keeps it working, with the reason as its next instruction.
    ///
    /// - Parameter stopHookActive: true when the agent is already working
    ///   because a stop hook sent it back — the flag a hook checks so it does
    ///   not keep a run going forever.
    func agentStopping(
        sessionID: CodeSessionID,
        stopHookActive: Bool,
        lastMessage: String
    ) async -> AgentHookResponse

    /// Told when a run has ended, however it ended.
    func sessionStopped(sessionID: CodeSessionID, status: SessionStatus) async

    /// Told when the session needs the reader.
    func notify(
        sessionID: CodeSessionID,
        kind: AgentHookNotificationKind,
        message: String
    ) async -> AgentHookResponse

    /// The hooks a delegated sub-agent's run should see, or nil for none.
    ///
    /// - Parameter executionRootPath: the folder the sub-agent works in, when
    ///   it has its own worktree.
    func subagentHooks(executionRootPath: String?) -> (any AgentLifecycleHooks)?
}

public extension AgentLifecycleHooks {
    func sessionStarted(
        sessionID _: CodeSessionID,
        source _: AgentSessionStartSource
    ) async -> AgentHookResponse {
        .empty
    }

    func promptSubmitted(sessionID _: CodeSessionID, prompt _: String) async -> AgentHookResponse {
        .empty
    }

    func beforeTool(_: AgentToolHookInvocation) async -> AgentHookResponse {
        .empty
    }

    func afterTool(
        _: AgentToolHookInvocation,
        succeeded _: Bool,
        content _: String
    ) async -> AgentHookResponse {
        .empty
    }

    func agentStopping(
        sessionID _: CodeSessionID,
        stopHookActive _: Bool,
        lastMessage _: String
    ) async -> AgentHookResponse {
        .empty
    }

    func sessionStopped(sessionID _: CodeSessionID, status _: SessionStatus) async {}

    func notify(
        sessionID _: CodeSessionID,
        kind _: AgentHookNotificationKind,
        message _: String
    ) async -> AgentHookResponse {
        .empty
    }

    func subagentHooks(executionRootPath _: String?) -> (any AgentLifecycleHooks)? {
        nil
    }
}

/// How hook context is put in front of the model.
///
/// Wrapped and labelled so the model can tell the project's automation from
/// the reader's own words, the way Claude Code marks the same text.
public enum AgentHookContext {
    public static func appending(_ context: [String], to prompt: String) -> String {
        let blocks = context
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        guard !blocks.isEmpty else { return prompt }
        let body = blocks.joined(separator: "\n\n")
        return prompt + "\n\n<hook_context>\n" + body + "\n</hook_context>"
    }
}

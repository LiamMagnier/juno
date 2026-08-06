import Foundation

/// One ordered entry in a session's transcript. The same event shape is used
/// for local, cloud, and remote sessions so the UI renders all three
/// identically.
public struct SessionEvent: Hashable, Codable, Sendable, Identifiable {
    public let id: String
    public let sessionID: CodeSessionID
    /// Strictly increasing per session; the transcript order of truth.
    public let sequence: Int
    public let timestamp: Date
    public let payload: SessionEventPayload

    public init(
        id: String = UUID().uuidString.lowercased(),
        sessionID: CodeSessionID,
        sequence: Int,
        timestamp: Date,
        payload: SessionEventPayload
    ) {
        self.id = id
        self.sessionID = sessionID
        self.sequence = sequence
        self.timestamp = timestamp
        self.payload = payload
    }
}

public enum SessionEventPayload: Hashable, Codable, Sendable {
    case sessionCreated(SessionCreatedEvent)
    case turnConfiguration(TurnConfigurationEvent)
    case userPrompt(UserPromptEvent)
    case assistantMessage(AssistantMessageEvent)
    case reasoningSummary(ReasoningSummaryEvent)
    case toolProposed(ToolProposedEvent)
    case toolStarted(ToolStartedEvent)
    case toolOutput(ToolOutputEvent)
    case toolCompleted(ToolCompletedEvent)
    case approvalRequested(ApprovalRequest)
    case approvalResolved(ApprovalResolvedEvent)
    case fileChanged(FileChangedEvent)
    case testRunCompleted(TestRunCompletedEvent)
    case subagentUpdated(SubagentUpdateEvent)
    case goalUpdated(GoalUpdatedEvent)
    case statusChanged(StatusChangedEvent)
    case errorOccurred(ErrorEvent)
    case runCompleted(RunCompletedEvent)
}

public struct SessionCreatedEvent: Hashable, Codable, Sendable {
    /// Nil when the session was started without a project. The transcript then
    /// opens on a conversation that has no folder rather than naming one.
    public let workspaceID: WorkspaceID?
    /// The isolated checkout used by this session, if any. Optional for
    /// backwards-compatible decoding of ordinary and older sessions.
    public let executionRootPath: String?
    public let workspaceName: String?
    public let configuration: AgentConfiguration

    public init(
        workspaceID: WorkspaceID?,
        executionRootPath: String? = nil,
        workspaceName: String?,
        configuration: AgentConfiguration
    ) {
        self.workspaceID = workspaceID
        self.executionRootPath = executionRootPath
        self.workspaceName = workspaceName
        self.configuration = configuration
    }
}

/// What the agent was permitted to do, and with which model, for the turn that
/// follows this event.
///
/// Recorded per turn rather than read from the session record, because mode,
/// permission level, model and reasoning effort are chosen in the composer for
/// the *next* message. Without this the transcript could not say which turn was
/// read-only and which was allowed to write — and a per-turn control the record
/// cannot account for is not a control the reader can trust.
public struct TurnConfigurationEvent: Hashable, Codable, Sendable {
    public let behavior: AgentBehavior
    public let permissionMode: PermissionMode
    public let modelID: String
    /// The depth this turn asked for, or nil when it sent no thinking parameter —
    /// the reader chose Instant, or the model publishes no control. Optional
    /// because the transcript records what was actually sent, and "nothing" is a
    /// real answer; `decodeIfPresent` keeps older records readable.
    public let reasoningEffort: ReasoningEffort?

    public init(
        behavior: AgentBehavior,
        permissionMode: PermissionMode,
        modelID: String,
        reasoningEffort: ReasoningEffort?
    ) {
        self.behavior = behavior
        self.permissionMode = permissionMode
        self.modelID = modelID
        self.reasoningEffort = reasoningEffort
    }

    /// The permission level in force, which is `readOnly` in Ask and Plan
    /// regardless of the session's stored mode.
    public var effectivePermissionMode: PermissionMode {
        behavior == .code ? permissionMode : .readOnly
    }
}

public struct UserPromptEvent: Hashable, Codable, Sendable {
    public let text: String

    public init(text: String) {
        self.text = text
    }
}

public struct AssistantMessageEvent: Hashable, Codable, Sendable {
    public let text: String

    public init(text: String) {
        self.text = text
    }
}

/// A short, product-facing summary of the model's reasoning. Never raw
/// private chain-of-thought.
public struct ReasoningSummaryEvent: Hashable, Codable, Sendable {
    public let summary: String

    public init(summary: String) {
        self.summary = summary
    }
}

public struct ToolProposedEvent: Hashable, Codable, Sendable {
    public let toolCallID: String
    public let toolName: String
    public let input: JSONValue
    public let risk: ActionRisk
    public let summary: String

    public init(toolCallID: String, toolName: String, input: JSONValue, risk: ActionRisk, summary: String) {
        self.toolCallID = toolCallID
        self.toolName = toolName
        self.input = input
        self.risk = risk
        self.summary = summary
    }
}

public struct ToolStartedEvent: Hashable, Codable, Sendable {
    public let toolCallID: String

    public init(toolCallID: String) {
        self.toolCallID = toolCallID
    }
}

public enum ToolOutputChannel: String, Codable, Sendable {
    case stdout
    case stderr
    case log
}

/// A bounded chunk of live output (for commands and tests).
public struct ToolOutputEvent: Hashable, Codable, Sendable {
    public let toolCallID: String
    public let channel: ToolOutputChannel
    public let text: String

    public init(toolCallID: String, channel: ToolOutputChannel, text: String) {
        self.toolCallID = toolCallID
        self.channel = channel
        self.text = text
    }
}

public enum ToolCompletionStatus: String, Codable, Sendable {
    case succeeded
    case failed
    case denied
    case cancelled
}

public struct ToolCompletedEvent: Hashable, Codable, Sendable {
    public let toolCallID: String
    public let status: ToolCompletionStatus
    public let resultSummary: String
    public let durationSeconds: Double

    public init(
        toolCallID: String,
        status: ToolCompletionStatus,
        resultSummary: String,
        durationSeconds: Double
    ) {
        self.toolCallID = toolCallID
        self.status = status
        self.resultSummary = resultSummary
        self.durationSeconds = durationSeconds
    }
}

public struct ApprovalResolvedEvent: Hashable, Codable, Sendable {
    public let approvalID: String
    public let decision: ApprovalDecision

    public init(approvalID: String, decision: ApprovalDecision) {
        self.approvalID = approvalID
        self.decision = decision
    }
}

public enum FileChangeKind: String, Codable, Sendable {
    case created
    case modified
    case deleted
    case moved
}

public struct FileChangedEvent: Hashable, Codable, Sendable {
    public let path: WorkspacePath
    public let kind: FileChangeKind
    public let linesAdded: Int
    public let linesRemoved: Int
    /// Identifier of the checkpoint captured before this change, when any.
    public let checkpointID: String?

    public init(
        path: WorkspacePath,
        kind: FileChangeKind,
        linesAdded: Int,
        linesRemoved: Int,
        checkpointID: String?
    ) {
        self.path = path
        self.kind = kind
        self.linesAdded = linesAdded
        self.linesRemoved = linesRemoved
        self.checkpointID = checkpointID
    }
}

public struct TestRunCompletedEvent: Hashable, Codable, Sendable {
    public let command: String
    public let passed: Bool
    public let testsRun: Int?
    public let failures: Int?
    public let durationSeconds: Double

    public init(
        command: String,
        passed: Bool,
        testsRun: Int?,
        failures: Int?,
        durationSeconds: Double
    ) {
        self.command = command
        self.passed = passed
        self.testsRun = testsRun
        self.failures = failures
        self.durationSeconds = durationSeconds
    }
}

/// Where one delegated sub-agent is in its life.
///
/// The raw values are the cloud runner's, character for character
/// (`runner/agent-core/src/subagents.ts`). Two runtimes describing the same
/// concept in two vocabularies is how a "Done" section ends up meaning something
/// different on the Mac than it does on the web — and the relay already declares
/// a `subagent_update` kind that both are expected to speak.
public enum SubagentStatus: String, Codable, CaseIterable, Sendable {
    /// Accepted, waiting for a concurrency slot.
    case queued
    /// Its session and tool registry are being built.
    case preparing
    case running
    case waitingForApproval = "waiting_approval"
    case completed
    case failed
    case cancelled
    /// The process ended before this agent did — a quit or a crash mid-run.
    /// Distinct from `cancelled`, which somebody asked for.
    case interrupted

    /// The four the web's agent cards also treat as terminal. Anything else
    /// belongs in the Active list, however long ago it was last heard from.
    public var isTerminal: Bool {
        switch self {
        case .completed, .failed, .cancelled, .interrupted: true
        case .queued, .preparing, .running, .waitingForApproval: false
        }
    }
}

/// One delegated sub-agent's state, recorded in the *delegating* session's
/// transcript every time that state changes.
///
/// This is what makes a sub-agent visible while it runs. Before it existed the
/// only trace of a delegation in the parent transcript was the `delegate_task`
/// tool call, which says nothing until it returns: a running child had no name,
/// no elapsed time and no link to its own transcript, so the only way to watch
/// one work was to open its session — which is precisely the "it just opened
/// another chat" the parent conversation is supposed to make unnecessary.
///
/// Emitted on transitions, not on every step. The child's own transcript is the
/// record of what it did; duplicating each of its tool calls into the parent's
/// event file would double the write volume of a delegated run to say something
/// the surface can read live from the child instead.
public struct SubagentUpdateEvent: Hashable, Codable, Sendable {
    /// Stable for the life of one delegated task and unique within the session.
    /// Derived from the delegating call so a single tool call that fans out to
    /// several agents still gives each one an identity the UI can key rows on.
    public let agentID: String
    /// The `delegate_task` call that asked for this agent.
    public let toolCallID: String
    /// The agent's own session, once it has been created. Nil in `queued` and in
    /// a `failed` update that never got that far.
    public let childSessionID: CodeSessionID?
    public let title: String
    /// The instruction the agent was given, verbatim.
    public let task: String
    public let role: AgentRole
    /// The execution contract recorded with the lifecycle, so a completed
    /// write-capable agent can be offered an explicit review/apply path.
    public let executionMode: SubagentExecutionMode
    public let status: SubagentStatus
    /// A short phrase for what the agent is doing at this moment. Empty when
    /// there is nothing more specific to say than its status.
    public let currentActivity: String
    /// When the agent began working — the anchor a live elapsed counter ticks
    /// from. Nil while queued, because a queued agent has not started.
    public let startedAt: Date?
    public let completedAt: Date?
    /// Provider-reported token accounting for the agent's own turns, when it
    /// reported any. Never estimated locally.
    public let inputTokens: Int?
    public let outputTokens: Int?
    /// The agent's written result, capped at the same 3,000 characters the
    /// cloud runner caps its own summaries at.
    public let summary: String?
    public let error: String?

    public static let maximumSummaryCharacters = 3_000

    private enum CodingKeys: String, CodingKey {
        case agentID, toolCallID, childSessionID, title, task, role
        case executionMode, status, currentActivity, startedAt, completedAt
        case inputTokens, outputTokens, summary, error
    }

    public init(
        agentID: String,
        toolCallID: String,
        childSessionID: CodeSessionID?,
        title: String,
        task: String,
        role: AgentRole,
        executionMode: SubagentExecutionMode = .readOnly,
        status: SubagentStatus,
        currentActivity: String = "",
        startedAt: Date? = nil,
        completedAt: Date? = nil,
        inputTokens: Int? = nil,
        outputTokens: Int? = nil,
        summary: String? = nil,
        error: String? = nil
    ) {
        self.agentID = agentID
        self.toolCallID = toolCallID
        self.childSessionID = childSessionID
        self.title = title
        self.task = task
        self.role = role
        self.executionMode = executionMode
        self.status = status
        self.currentActivity = currentActivity
        self.startedAt = startedAt
        self.completedAt = completedAt
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.summary = summary.map {
            String($0.prefix(Self.maximumSummaryCharacters))
        }
        self.error = error
    }

    /// Old transcripts predate the execution mode field. They are read as
    /// read-only, which is the safe interpretation for a run whose isolation
    /// contract was never recorded.
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        agentID = try values.decode(String.self, forKey: .agentID)
        toolCallID = try values.decode(String.self, forKey: .toolCallID)
        childSessionID = try values.decodeIfPresent(CodeSessionID.self, forKey: .childSessionID)
        title = try values.decode(String.self, forKey: .title)
        task = try values.decode(String.self, forKey: .task)
        role = try values.decode(AgentRole.self, forKey: .role)
        executionMode = try values.decodeIfPresent(SubagentExecutionMode.self, forKey: .executionMode) ?? .readOnly
        status = try values.decode(SubagentStatus.self, forKey: .status)
        currentActivity = try values.decodeIfPresent(String.self, forKey: .currentActivity) ?? ""
        startedAt = try values.decodeIfPresent(Date.self, forKey: .startedAt)
        completedAt = try values.decodeIfPresent(Date.self, forKey: .completedAt)
        inputTokens = try values.decodeIfPresent(Int.self, forKey: .inputTokens)
        outputTokens = try values.decodeIfPresent(Int.self, forKey: .outputTokens)
        summary = try values.decodeIfPresent(String.self, forKey: .summary)
        error = try values.decodeIfPresent(String.self, forKey: .error)
    }
}

/// Append-only audit entry for a durable goal mutation. The full goal snapshot
/// makes each event independently inspectable while `sequence` preserves the
/// authoritative order of changes.
public struct GoalUpdatedEvent: Hashable, Codable, Sendable {
    public enum Kind: String, Codable, CaseIterable, Sendable {
        case created
        case objectiveChanged
        case lifecycleChanged
        case stepAdded
        case stepStatusChanged
        case verificationAdded
    }

    public let kind: Kind
    public let goal: SessionGoal

    public init(kind: Kind, goal: SessionGoal) {
        self.kind = kind
        self.goal = goal
    }
}

public struct StatusChangedEvent: Hashable, Codable, Sendable {
    public let status: SessionStatus

    public init(status: SessionStatus) {
        self.status = status
    }
}

public struct ErrorEvent: Hashable, Codable, Sendable {
    public let message: String
    public let isRecoverable: Bool

    public init(message: String, isRecoverable: Bool) {
        self.message = message
        self.isRecoverable = isRecoverable
    }
}

public struct RunCompletedEvent: Hashable, Codable, Sendable {
    public let summary: String
    public let filesChanged: Int
    public let testsPassed: Bool?
    public let durationSeconds: Double

    public init(summary: String, filesChanged: Int, testsPassed: Bool?, durationSeconds: Double) {
        self.summary = summary
        self.filesChanged = filesChanged
        self.testsPassed = testsPassed
        self.durationSeconds = durationSeconds
    }
}

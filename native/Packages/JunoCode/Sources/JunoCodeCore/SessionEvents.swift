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
    case statusChanged(StatusChangedEvent)
    case errorOccurred(ErrorEvent)
    case runCompleted(RunCompletedEvent)
}

public struct SessionCreatedEvent: Hashable, Codable, Sendable {
    public let workspaceID: WorkspaceID
    public let workspaceName: String
    public let configuration: AgentConfiguration

    public init(workspaceID: WorkspaceID, workspaceName: String, configuration: AgentConfiguration) {
        self.workspaceID = workspaceID
        self.workspaceName = workspaceName
        self.configuration = configuration
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

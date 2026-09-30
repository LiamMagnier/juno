import Foundation

// MARK: - Todo list

public enum TodoStatus: String, Codable, CaseIterable, Sendable {
    case pending
    case inProgress = "in_progress"
    case completed
}

/// One step of the agent's working checklist.
public struct TodoItem: Hashable, Codable, Sendable, Identifiable {
    public let id: String
    /// What the step is, imperative: "Add the migration".
    public let content: String
    public let status: TodoStatus
    /// The same step while it runs: "Adding the migration".
    public let activeForm: String?

    public init(id: String, content: String, status: TodoStatus, activeForm: String? = nil) {
        self.id = id
        self.content = content
        self.status = status
        self.activeForm = activeForm
    }
}

/// The whole checklist, as the agent last wrote it. Each event replaces the
/// one before; the latest is the list.
public struct TodoListEvent: Hashable, Codable, Sendable {
    public let items: [TodoItem]

    public init(items: [TodoItem]) {
        self.items = items
    }

    public var completedCount: Int { items.filter { $0.status == .completed }.count }
}

// MARK: - Questions for the reader

public struct UserQuestionOption: Hashable, Codable, Sendable {
    public let label: String
    public let description: String?

    public init(label: String, description: String? = nil) {
        self.label = label
        self.description = description
    }
}

/// One question the agent asks, with the answers it offers. The reader may
/// always write their own answer instead.
public struct UserQuestion: Hashable, Codable, Sendable, Identifiable {
    public let id: String
    public let question: String
    /// A short label for the question, a few words.
    public let header: String?
    public let options: [UserQuestionOption]
    public let allowsMultipleSelection: Bool

    public init(
        id: String,
        question: String,
        header: String? = nil,
        options: [UserQuestionOption],
        allowsMultipleSelection: Bool = false
    ) {
        self.id = id
        self.question = question
        self.header = header
        self.options = options
        self.allowsMultipleSelection = allowsMultipleSelection
    }
}

/// The agent is waiting for the reader to answer. Recorded in the transcript
/// so a phone following the session can show it and answer it later.
public struct QuestionRequest: Hashable, Codable, Sendable, Identifiable {
    public let id: String
    public let sessionID: CodeSessionID
    public let toolCallID: String?
    public let questions: [UserQuestion]
    public let requestedAt: Date
    public let expiresAt: Date

    public init(
        id: String = UUID().uuidString.lowercased(),
        sessionID: CodeSessionID,
        toolCallID: String?,
        questions: [UserQuestion],
        requestedAt: Date,
        expiresAt: Date
    ) {
        self.id = id
        self.sessionID = sessionID
        self.toolCallID = toolCallID
        self.questions = questions
        self.requestedAt = requestedAt
        self.expiresAt = expiresAt
    }
}

/// The reader's answer to one question: options they picked, words they wrote.
public struct QuestionAnswer: Hashable, Codable, Sendable {
    public let questionID: String
    public let selectedOptions: [String]
    public let text: String?

    public init(questionID: String, selectedOptions: [String] = [], text: String? = nil) {
        self.questionID = questionID
        self.selectedOptions = selectedOptions
        let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.text = trimmed?.isEmpty == false ? trimmed : nil
    }

    public var isEmpty: Bool { selectedOptions.isEmpty && text == nil }
}

/// How a question ended. Answering is information for the agent, never a
/// permission: nothing here reaches the permission coordinator.
public enum QuestionResolution: Hashable, Codable, Sendable {
    case answered([QuestionAnswer])
    /// The reader chose not to answer.
    case declined
    case expired
    /// The run was stopped while the question waited.
    case cancelled
}

public struct QuestionResolvedEvent: Hashable, Codable, Sendable {
    public let requestID: String
    public let resolution: QuestionResolution

    public init(requestID: String, resolution: QuestionResolution) {
        self.requestID = requestID
        self.resolution = resolution
    }
}

// MARK: - Plan approval

/// A plan the agent wrote in Plan mode and asks the reader to approve.
public struct PlanApprovalRequest: Hashable, Codable, Sendable, Identifiable {
    public let id: String
    public let sessionID: CodeSessionID
    public let toolCallID: String?
    /// Markdown.
    public let plan: String
    public let requestedAt: Date
    public let expiresAt: Date

    public init(
        id: String = UUID().uuidString.lowercased(),
        sessionID: CodeSessionID,
        toolCallID: String?,
        plan: String,
        requestedAt: Date,
        expiresAt: Date
    ) {
        self.id = id
        self.sessionID = sessionID
        self.toolCallID = toolCallID
        self.plan = plan
        self.requestedAt = requestedAt
        self.expiresAt = expiresAt
    }
}

public enum PlanDecision: Hashable, Codable, Sendable {
    /// Implement it, in Code, with exactly the permission level the reader
    /// picked on the card.
    case approved(permissionMode: PermissionMode)
    /// Not yet: keep planning, with what the reader said to change.
    case keepPlanning(feedback: String?)
    case expired
    case cancelled
}

public struct PlanResolvedEvent: Hashable, Codable, Sendable {
    public let requestID: String
    public let decision: PlanDecision

    public init(requestID: String, decision: PlanDecision) {
        self.requestID = requestID
        self.decision = decision
    }
}

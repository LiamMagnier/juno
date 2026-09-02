import Foundation

/// Where a code session executes. The UI renders all three through the same
/// event model; only the local runtime is implemented in this package.
public enum SessionLocation: String, Codable, CaseIterable, Sendable {
    case local
    case cloud
    case remote
}

public enum SessionStatus: String, Codable, CaseIterable, Sendable {
    case idle
    case planning
    case running
    case waitingForApproval
    case waitingForProvider
    case degraded
    case stopping
    case completed
    case failed
    case cancelled

    public var isTerminal: Bool {
        switch self {
        case .completed, .failed, .cancelled: return true
        case .idle, .planning, .running, .waitingForApproval, .waitingForProvider, .degraded, .stopping: return false
        }
    }

    public var isActive: Bool {
        switch self {
        case .planning, .running, .waitingForApproval, .waitingForProvider, .degraded, .stopping: return true
        case .idle, .completed, .failed, .cancelled: return false
        }
    }
}

public struct CodeSessionID: Hashable, Codable, Sendable, CustomStringConvertible {
    public let value: String

    public init(value: String = UUID().uuidString.lowercased()) {
        self.value = value
    }

    public var description: String { value }
}

public struct WorkspaceID: Hashable, Codable, Sendable, CustomStringConvertible {
    public let value: String

    public init(value: String = UUID().uuidString.lowercased()) {
        self.value = value
    }

    public var description: String { value }
}

/// A workspace as known to the session layer. The bookmark data that grants
/// filesystem access is stored separately by the workspace access service and
/// never crosses into transcripts or sync records.
public struct WorkspaceDescriptor: Hashable, Codable, Sendable {
    public let id: WorkspaceID
    public var displayName: String
    /// Absolute path for local display and reopening; never sent off-device.
    public var localPathHint: String
    public var isGitRepository: Bool
    public var lastOpenedAt: Date

    public init(
        id: WorkspaceID = WorkspaceID(),
        displayName: String,
        localPathHint: String,
        isGitRepository: Bool,
        lastOpenedAt: Date
    ) {
        self.id = id
        self.displayName = displayName
        self.localPathHint = localPathHint
        self.isGitRepository = isGitRepository
        self.lastOpenedAt = lastOpenedAt
    }
}

/// Agent launch configuration chosen in the composer before a run.
public struct AgentConfiguration: Hashable, Codable, Sendable {
    public var modelID: String
    /// The thinking depth for each turn, or **nil to send no thinking parameter**.
    ///
    /// nil is the website's "Instant": the state a model offers whenever its
    /// manifest entry reports `canDisable`. It is also the only correct request for
    /// a model that does not reason at all, or that always reasons with no exposed
    /// control — several providers reject the parameter outright for those, which
    /// is a 400 rather than a deeper answer.
    public var reasoningEffort: ReasoningEffort?
    public var behavior: AgentBehavior
    public var role: AgentRole
    public var permissionMode: PermissionMode
    public var location: SessionLocation
    /// The explicit target selected for the session. `location` remains in the
    /// persisted shape for backward compatibility with existing sessions; new
    /// clients route through this value instead of making local/cloud/remote
    /// three unrelated runtime architectures.
    public var executionTarget: ExecutionTarget
    public var computerUseEnabled: Bool
    /// A workspace-authored agent (`.claude/agents/<name>.md` or
    /// `.juno/agents/<name>.md`) whose instructions shape this session, on top
    /// of the built-in ``role``. Nil for the three built-in roles alone.
    ///
    /// An identifier rather than the instructions themselves: the file is the
    /// source of truth and is re-read when the session is opened, so an agent
    /// edited in the repository takes effect on the next turn.
    public var customAgentID: String?

    public init(
        modelID: String,
        reasoningEffort: ReasoningEffort? = .medium,
        behavior: AgentBehavior = .code,
        role: AgentRole = .engineer,
        permissionMode: PermissionMode = .askBeforeChanges,
        location: SessionLocation = .local,
        executionTarget: ExecutionTarget? = nil,
        computerUseEnabled: Bool = false,
        customAgentID: String? = nil
    ) {
        self.modelID = modelID
        self.reasoningEffort = reasoningEffort
        self.behavior = behavior
        self.role = role
        self.customAgentID = customAgentID
        self.permissionMode = permissionMode
        self.executionTarget = executionTarget ?? .legacy(for: location)
        // `executionTarget` is the canonical routing value. Keep writing the
        // legacy location field so older stores stay readable, but never allow
        // the two fields to describe different runtimes in a newly written
        // session.
        self.location = self.executionTarget.kind.sessionLocation
        self.computerUseEnabled = computerUseEnabled
    }

    private enum CodingKeys: String, CodingKey {
        case modelID, reasoningEffort, behavior, role, permissionMode, location, executionTarget
        case computerUseEnabled
        case customAgentID
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        modelID = try container.decode(String.self, forKey: .modelID)
        // `decodeIfPresent`, so a session written before the effort became
        // optional still decodes: those records always carry a concrete value, and
        // a record written with Instant simply omits the key.
        reasoningEffort = try container.decodeIfPresent(
            ReasoningEffort.self,
            forKey: .reasoningEffort
        )
        behavior = try container.decodeIfPresent(AgentBehavior.self, forKey: .behavior) ?? .code
        role = try container.decode(AgentRole.self, forKey: .role)
        permissionMode = try container.decode(PermissionMode.self, forKey: .permissionMode)
        let legacyLocation = try container.decode(SessionLocation.self, forKey: .location)
        executionTarget = try container.decodeIfPresent(
            ExecutionTarget.self,
            forKey: .executionTarget
        ) ?? .legacy(for: legacyLocation)
        // Prefer the explicit target if both values are present but stale. The
        // target carries host/workspace identity; the old location is only a
        // compatibility mirror and cannot safely override it.
        location = executionTarget.kind.sessionLocation
        computerUseEnabled =
            try container.decodeIfPresent(Bool.self, forKey: .computerUseEnabled) ?? false
        customAgentID = try container.decodeIfPresent(String.self, forKey: .customAgentID)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(modelID, forKey: .modelID)
        // `encodeIfPresent`: Instant is the *absence* of the key, which is what
        // makes it round-trip through a store that predates it.
        try container.encodeIfPresent(reasoningEffort, forKey: .reasoningEffort)
        try container.encode(behavior, forKey: .behavior)
        try container.encode(role, forKey: .role)
        try container.encode(permissionMode, forKey: .permissionMode)
        try container.encode(location, forKey: .location)
        try container.encode(executionTarget, forKey: .executionTarget)
        try container.encode(computerUseEnabled, forKey: .computerUseEnabled)
        try container.encodeIfPresent(customAgentID, forKey: .customAgentID)
    }
}

/// How much thinking the model does before answering.
///
/// These are the website's six tiers, verbatim — `REASONING_TIERS` in
/// `src/lib/model-metrics.ts`. Code used to define only `low/medium/high`, and
/// that shortfall was not a simplification: it silently truncated every model
/// whose real ladder reached past `high`. `CodeModelCatalog.thinkingLadder`
/// only adopts a model's published ladder when *every* stop maps to a case
/// here, so one unmappable stop discarded the whole ladder and fell back to
/// three fixed depths. Kimi K3 publishes `low · high · max`; Code therefore
/// offered it Low / Medium / High — inventing a `medium` the model rejects and
/// hiding the `max` it actually supports.
///
/// Order is depth order, and `allCases` is read as the contract ladder, so a
/// new tier belongs in its true position rather than appended.
public enum ReasoningEffort: String, Codable, CaseIterable, Sendable {
    case minimal
    case low
    case medium
    case high
    case xhigh
    case max
}

/// What the local agent is allowed and instructed to do during the session.
/// Ask, Survey and Plan are read-only by construction; Code can make
/// checkpointed, permission-gated changes. Survey is intentionally distinct
/// from Ask: it is a reconnaissance contract for mapping a repository before
/// somebody commits to an implementation, and may use bounded read-only
/// delegation to parallelize that map.
public enum AgentBehavior: String, Codable, CaseIterable, Sendable {
    case ask
    case survey
    case plan
    case code
}

public enum AgentRole: String, Codable, CaseIterable, Sendable {
    case engineer
    case reviewer
    case explainer
}

/// Durable lifecycle for a session goal. Completion is terminal and may only
/// be entered after every ordered step is complete and verification evidence
/// has been recorded.
public enum GoalLifecycle: String, Codable, CaseIterable, Sendable {
    case active
    case paused
    case blocked
    case completed

    public func canTransition(to next: GoalLifecycle) -> Bool {
        switch (self, next) {
        case (.active, .active), (.paused, .paused),
             (.blocked, .blocked), (.completed, .completed),
             (.active, .paused), (.active, .blocked), (.active, .completed),
             (.paused, .active), (.paused, .blocked),
             (.blocked, .active), (.blocked, .paused):
            return true
        case (.paused, .completed), (.blocked, .completed),
             (.completed, .active), (.completed, .paused), (.completed, .blocked):
            return false
        }
    }
}

public enum GoalStepStatus: String, Codable, CaseIterable, Sendable {
    case pending
    case inProgress
    case completed
    case blocked

    public func canTransition(to next: GoalStepStatus) -> Bool {
        switch (self, next) {
        case (.pending, .pending),
             (.pending, .inProgress),
             (.pending, .blocked):
            return true
        case (.inProgress, .inProgress),
             (.inProgress, .completed),
             (.inProgress, .blocked),
             (.inProgress, .pending):
            return true
        case (.blocked, .blocked),
             (.blocked, .inProgress),
             (.blocked, .pending):
            return true
        case (.completed, .completed),
             (.completed, .inProgress):
            return true
        case (.pending, .completed),
             (.completed, .pending),
             (.completed, .blocked),
             (.blocked, .completed):
            return false
        }
    }
}

public struct GoalProgress: Hashable, Codable, Sendable {
    public let completedSteps: Int
    public let blockedSteps: Int
    public let totalSteps: Int
    public let fractionCompleted: Double

    public init(completedSteps: Int, blockedSteps: Int, totalSteps: Int) {
        self.completedSteps = completedSteps
        self.blockedSteps = blockedSteps
        self.totalSteps = totalSteps
        fractionCompleted = totalSteps == 0
            ? 0
            : Double(completedSteps) / Double(totalSteps)
    }
}

public struct GoalVerificationEvidence: Hashable, Codable, Sendable {
    public let id: String
    public let summary: String
    public let source: String?
    public let recordedAt: Date

    public init(
        id: String = UUID().uuidString.lowercased(),
        summary: String,
        source: String? = nil,
        recordedAt: Date
    ) {
        self.id = id
        self.summary = summary
        self.source = source
        self.recordedAt = recordedAt
    }

    public var isValid: Bool {
        !summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

public struct GoalStep: Hashable, Codable, Sendable, Identifiable {
    public let id: String
    public var title: String
    public var status: GoalStepStatus
    public let createdAt: Date
    public var updatedAt: Date
    public var completedAt: Date?

    public init(
        id: String = UUID().uuidString.lowercased(),
        title: String,
        status: GoalStepStatus = .pending,
        createdAt: Date,
        updatedAt: Date? = nil,
        completedAt: Date? = nil
    ) {
        self.id = id
        self.title = title
        self.status = status
        self.createdAt = createdAt
        self.updatedAt = updatedAt ?? createdAt
        self.completedAt = completedAt
    }

    public mutating func transition(
        to next: GoalStepStatus,
        at timestamp: Date
    ) throws {
        guard status.canTransition(to: next) else {
            throw GoalStateError.invalidStepTransition(
                stepID: id,
                from: status,
                to: next
            )
        }
        status = next
        updatedAt = timestamp
        completedAt = next == .completed ? timestamp : nil
    }
}

public enum GoalMutation: Hashable, Sendable {
    case setObjective(String)
    case setLifecycle(GoalLifecycle)
    case addStep(title: String)
    case setStepStatus(id: String, status: GoalStepStatus)
    case addVerificationEvidence(summary: String, source: String?)
}

public enum GoalStateError: Error, Equatable, Sendable {
    case objectiveRequired
    case atLeastOneStepRequired
    case stepTitleRequired(stepID: String)
    case duplicateStepID(String)
    case verificationSummaryRequired
    case stepNotFound(String)
    case invalidLifecycleTransition(from: GoalLifecycle, to: GoalLifecycle)
    case invalidStepTransition(
        stepID: String,
        from: GoalStepStatus,
        to: GoalStepStatus
    )
    case inactiveGoalRequiresResume(lifecycle: GoalLifecycle)
    case completedGoalIsImmutable
    case completionRequiresAllSteps
    case completionRequiresVerificationEvidence

    public var message: String {
        switch self {
        case .objectiveRequired:
            return "A goal objective is required."
        case .atLeastOneStepRequired:
            return "A goal requires at least one ordered step."
        case let .stepTitleRequired(stepID):
            return "Goal step '\(stepID)' requires a title."
        case let .duplicateStepID(stepID):
            return "Goal step ID '\(stepID)' is duplicated."
        case .verificationSummaryRequired:
            return "Verification evidence requires a non-empty summary."
        case let .stepNotFound(stepID):
            return "Goal step '\(stepID)' was not found."
        case let .invalidLifecycleTransition(from, to):
            return "Goal lifecycle cannot transition from \(from.rawValue) to \(to.rawValue)."
        case let .invalidStepTransition(stepID, from, to):
            return "Goal step '\(stepID)' cannot transition from \(from.rawValue) to \(to.rawValue)."
        case let .inactiveGoalRequiresResume(lifecycle):
            return "A \(lifecycle.rawValue) goal must be resumed before its contents can be changed."
        case .completedGoalIsImmutable:
            return "A completed goal is immutable."
        case .completionRequiresAllSteps:
            return "A goal cannot complete until every step is completed."
        case .completionRequiresVerificationEvidence:
            return "A goal cannot complete without verification evidence."
        }
    }
}

/// A durable, ordered completion contract attached to one code session.
public struct SessionGoal: Hashable, Codable, Sendable, Identifiable {
    public let id: String
    public var objective: String
    public var lifecycle: GoalLifecycle
    public var steps: [GoalStep]
    public var verificationEvidence: [GoalVerificationEvidence]
    public let createdAt: Date
    public var updatedAt: Date
    public var completedAt: Date?

    public init(
        id: String = UUID().uuidString.lowercased(),
        objective: String,
        lifecycle: GoalLifecycle = .active,
        steps: [GoalStep],
        verificationEvidence: [GoalVerificationEvidence] = [],
        createdAt: Date,
        updatedAt: Date? = nil,
        completedAt: Date? = nil
    ) {
        self.id = id
        self.objective = objective
        self.lifecycle = lifecycle
        self.steps = steps
        self.verificationEvidence = verificationEvidence
        self.createdAt = createdAt
        self.updatedAt = updatedAt ?? createdAt
        self.completedAt = completedAt
    }

    public var progress: GoalProgress {
        GoalProgress(
            completedSteps: steps.count { $0.status == .completed },
            blockedSteps: steps.count { $0.status == .blocked },
            totalSteps: steps.count
        )
    }

    public func validate() throws {
        guard !objective.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw GoalStateError.objectiveRequired
        }
        guard !steps.isEmpty else {
            throw GoalStateError.atLeastOneStepRequired
        }
        var stepIDs = Set<String>()
        for step in steps {
            guard !step.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw GoalStateError.stepTitleRequired(stepID: step.id)
            }
            guard stepIDs.insert(step.id).inserted else {
                throw GoalStateError.duplicateStepID(step.id)
            }
        }
        guard verificationEvidence.allSatisfy(\.isValid) else {
            throw GoalStateError.verificationSummaryRequired
        }
        if lifecycle == .completed {
            try validateCompletion()
        }
    }

    public mutating func apply(
        _ mutation: GoalMutation,
        at timestamp: Date
    ) throws {
        if lifecycle == .completed {
            if case .setLifecycle(.completed) = mutation {
                return
            }
            throw GoalStateError.completedGoalIsImmutable
        }
        if lifecycle == .paused || lifecycle == .blocked {
            guard case .setLifecycle = mutation else {
                throw GoalStateError.inactiveGoalRequiresResume(lifecycle: lifecycle)
            }
        }

        switch mutation {
        case let .setObjective(value):
            let objective = value.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !objective.isEmpty else {
                throw GoalStateError.objectiveRequired
            }
            self.objective = objective

        case let .setLifecycle(next):
            guard lifecycle.canTransition(to: next) else {
                throw GoalStateError.invalidLifecycleTransition(from: lifecycle, to: next)
            }
            if next == .completed {
                try validateCompletion()
            }
            lifecycle = next
            completedAt = next == .completed ? timestamp : nil

        case let .addStep(title):
            let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !title.isEmpty else {
                throw GoalStateError.stepTitleRequired(stepID: "new")
            }
            steps.append(
                GoalStep(
                    title: title,
                    createdAt: timestamp
                )
            )

        case let .setStepStatus(id, status):
            guard let index = steps.firstIndex(where: { $0.id == id }) else {
                throw GoalStateError.stepNotFound(id)
            }
            // Higher-level normalization: When an agent directly requests completion of a pending step,
            // normalize the transition atomically: pending -> inProgress -> completed.
            if steps[index].status == .pending && status == .completed {
                try steps[index].transition(to: .inProgress, at: timestamp)
                try steps[index].transition(to: .completed, at: timestamp)
            } else {
                try steps[index].transition(to: status, at: timestamp)
            }

        case let .addVerificationEvidence(summary, source):
            let summary = summary.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !summary.isEmpty else {
                throw GoalStateError.verificationSummaryRequired
            }
            let normalizedSource = source?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            verificationEvidence.append(
                GoalVerificationEvidence(
                    summary: summary,
                    source: normalizedSource.flatMap { $0.isEmpty ? nil : $0 },
                    recordedAt: timestamp
                )
            )
        }
        updatedAt = timestamp
        try validate()
    }

    private func validateCompletion() throws {
        guard steps.allSatisfy({ $0.status == .completed }) else {
            throw GoalStateError.completionRequiresAllSteps
        }
        guard !verificationEvidence.isEmpty,
              verificationEvidence.allSatisfy(\.isValid)
        else {
            throw GoalStateError.completionRequiresVerificationEvidence
        }
    }
}

public struct CodeSession: Hashable, Codable, Sendable {
    public let id: CodeSessionID
    /// The project this session works in, or nil when it has none.
    ///
    /// Nil is a real, supported state: a conversation started before any folder
    /// was granted. Such a session has no filesystem — see
    /// `SessionController`, which builds it with an empty tool registry and a
    /// system prompt that says so — and this is the property every layer keys
    /// off to know that.
    ///
    /// It stays a `let`: a session's project is fixed for its lifetime, which
    /// is what lets the sidebar caption, the window subtitle and the transcript
    /// header state it once and never re-derive it.
    ///
    /// Decoded with `decodeIfPresent` (see the memberwise `Codable` conformance
    /// below) so that records written before this was optional still load. The
    /// store is a JSON file on the reader's own disk; a decode failure here
    /// does not degrade, it empties the whole Code section.
    public let workspaceID: WorkspaceID?
    /// The concrete checkout this session executes in, when it is an isolated
    /// worktree. It is optional for ordinary sessions and older records. The
    /// UI must validate it is still contained by the parent workspace before
    /// turning it into a filesystem capability; this is metadata, not a grant.
    public let executionRootPath: String?
    /// The session that delegated this one, when it is a sub-agent rather than a
    /// conversation the reader started.
    ///
    /// This is the difference between a sub-agent that runs *inside* a
    /// conversation and one that appears beside it. A child used to be an
    /// ordinary peer session — the sidebar had no way to tell it apart, so a
    /// delegated investigation surfaced as a second chat under the project, which
    /// is the one thing delegation is supposed to avoid. Every list surface now
    /// filters on this; nothing else about a child session changes, so it keeps
    /// its own transcript, its own status and its own store entry, and stays
    /// fully addressable by the panel that shows it.
    ///
    /// Nil means "top level", which is what every record written before this
    /// field existed decodes to — the synthesized `Codable` conformance reads an
    /// optional with `decodeIfPresent`, so an older session keeps behaving
    /// exactly as it did. It stays a `let` for the same reason `workspaceID`
    /// does: parentage is fixed at creation.
    public let parentSessionID: CodeSessionID?
    public var title: String
    public var status: SessionStatus
    public var configuration: AgentConfiguration
    public var isFavorite: Bool
    public var gitBranch: String?
    public var hasPendingApproval: Bool
    public var lastErrorSummary: String?
    /// Optional for backward-compatible decoding of sessions created before
    /// durable Goal Mode existed.
    public var goal: SessionGoal?
    public let createdAt: Date
    public var updatedAt: Date

    /// True when this session is a sub-agent of another. The sidebar, the
    /// project groups and the recents list all read this rather than the title,
    /// which is presentation and can be renamed.
    public var isSubagent: Bool { parentSessionID != nil }

    public init(
        id: CodeSessionID = CodeSessionID(),
        workspaceID: WorkspaceID?,
        executionRootPath: String? = nil,
        parentSessionID: CodeSessionID? = nil,
        title: String,
        status: SessionStatus = .idle,
        configuration: AgentConfiguration,
        isFavorite: Bool = false,
        gitBranch: String? = nil,
        hasPendingApproval: Bool = false,
        lastErrorSummary: String? = nil,
        goal: SessionGoal? = nil,
        createdAt: Date,
        updatedAt: Date
    ) {
        self.id = id
        self.workspaceID = workspaceID
        self.executionRootPath = executionRootPath
        self.parentSessionID = parentSessionID
        self.title = title
        self.status = status
        self.configuration = configuration
        self.isFavorite = isFavorite
        self.gitBranch = gitBranch
        self.hasPendingApproval = hasPendingApproval
        self.lastErrorSummary = lastErrorSummary
        self.goal = goal
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

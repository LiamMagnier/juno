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
    case userInstruction(UserInstructionEvent)
    case userInstructionApplied(UserInstructionAppliedEvent)
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
    /// The model context was folded down. Recorded so the transcript can say,
    /// quietly and in place, that older turns now reach the model as a summary.
    case compaction(CompactionEvent)
    /// The reader rewound the session, and the transcript restarts here. Only
    /// ever the first event of a transcript; see ``TranscriptRewoundEvent``.
    case transcriptRewound(TranscriptRewoundEvent)
    /// A project hook changed the course of the run or failed, so the thread
    /// can say which hook it was and why.
    case hookActivity(HookActivityEvent)
    /// The agent's working checklist, whole, as `todo_write` last set it.
    case todosUpdated(TodoListEvent)
    /// The agent asked the reader something and is waiting for the answer.
    case questionRequested(QuestionRequest)
    case questionResolved(QuestionResolvedEvent)
    /// A Plan-mode run handed its plan to the reader for approval.
    case planSubmitted(PlanApprovalRequest)
    case planResolved(PlanResolvedEvent)

    // MARK: The autonomous loop (CODE_AGENT_SPEC §1.13)
    //
    // Recorded by the loop, the recorders and the goal runtime from what
    // actually happened, never from model text. Each maps to one protocol
    // event (named after the case). A build that predates them does not
    // record any, so a transcript without them reads exactly as before.

    /// The stop check, or a resume, sent the agent back to work with a runtime
    /// note and no new reader message. `run.continued`.
    case runContinued(RunContinuedEvent)
    /// How a run ended, with the report the runtime built from the ledger.
    /// `run.outcome`.
    case runOutcome(RunOutcomeEvent)
    /// A check ran and its result counts as evidence. `verify.result`.
    case verificationRecorded(VerificationRecord)
    /// The running result was looked at: a Preview route, a Simulator screen,
    /// a Mac app. `verify.ui`.
    case uiVerificationRecorded(UIVerificationRecord)
    /// A self-review of the diff finished. `review.findings`.
    case reviewCompleted(ReviewRecord)
    /// A goal was set. `goal.set`.
    case goalSet(GoalSetEvent)
    /// A goal's objective, criteria, constraints or budget changed.
    /// `goal.updated`; named apart from ``goalUpdated(_:)``, the older
    /// ``SessionGoal`` audit entry.
    case goalEdited(GoalEditedEvent)
    /// The goal was checked: the deterministic part, then the judge.
    /// `goal.verdict`.
    case goalVerdict(GoalVerdictEvent)
    /// The goal's status or spend changed. `goal.status`.
    case goalStatus(GoalStatusEvent)
    /// Background work kept the run waiting long enough for a check-in.
    /// `checkin.due`.
    case checkInDue(CheckInDueEvent)
    /// CI for a pull request Juno opened moved. `ci.status`.
    case ciStatus(CIStatusEvent)
    /// A run or goal budget was reached. `budget.reached`.
    case budgetReached(BudgetReachedEvent)

    /// Whether this event replaces everything before it in the stream, so a
    /// reader keeping its place by sequence drops what it holds and rebuilds
    /// from here rather than treating the jump in numbering as a hole.
    public var restartsTranscript: Bool {
        if case .transcriptRewound = self { return true }
        return false
    }
}

/// The transcript was cut back to just before one of the reader's messages,
/// and starts again from this event.
///
/// A rewind is the one change to a transcript that is not an append, and the
/// sequence number is how every reader of one keeps its place: a phone, or
/// `juno events`, asks for what came after the last sequence it saw. So a cut
/// transcript is never numbered from zero again. It opens with this event,
/// numbered past everything the session ever held, and the events it kept
/// follow it, renumbered after it. Whatever cursor a reader holds, this is the
/// next event it receives, and it says to drop what came before; a number the
/// reader has already seen is never given to an event it would then skip.
public struct TranscriptRewoundEvent: Hashable, Codable, Sendable {
    /// The transcript event of the message the session was rewound to, which
    /// is no longer in the transcript.
    public let turnID: String

    public init(turnID: String) {
        self.turnID = turnID
    }
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
    /// Where this prompt's message sits in the model-facing conversation: the
    /// number of messages that preceded it when it was sent.
    ///
    /// This is the rewind point. The transcript and the conversation are two
    /// records of the same session, and only this ties a row the reader can
    /// point at to the message a rewind has to cut before. Nil on prompts
    /// recorded before rewind existed, which the synthesized `Codable` reads
    /// with `decodeIfPresent`, so older transcripts still load.
    public let conversationIndex: Int?

    public init(text: String, conversationIndex: Int? = nil) {
        self.text = text
        self.conversationIndex = conversationIndex
    }
}

/// How an instruction submitted while an execution is active should be
/// delivered. This is runtime state, not presentation inferred from wording.
public enum UserInstructionKind: String, Codable, CaseIterable, Sendable {
    /// Amend the active execution before its next unsafe action or model turn.
    case steer
    /// Run after the current execution reaches a natural completion boundary.
    case queue
}

/// A durable user instruction accepted while an execution is active.
///
/// Acceptance and application are separate events so a process interrupted
/// between them can reconstruct the mailbox from the append-only transcript.
public struct UserInstructionEvent: Hashable, Codable, Sendable, Identifiable {
    public let id: String
    public let text: String
    public let kind: UserInstructionKind

    public init(
        id: String = UUID().uuidString.lowercased(),
        text: String,
        kind: UserInstructionKind
    ) {
        self.id = id
        self.text = text
        self.kind = kind
    }
}

/// Marks the point at which an accepted instruction entered model context.
/// The event sequence is therefore also the authoritative delivery order.
public struct UserInstructionAppliedEvent: Hashable, Codable, Sendable {
    public let instructionID: String
    /// Where the instruction's message landed in the model-facing
    /// conversation. Recorded here rather than on the instruction itself,
    /// because an instruction is accepted long before it is applied and only
    /// application fixes its place — see ``UserPromptEvent/conversationIndex``.
    public let conversationIndex: Int?

    public init(instructionID: String, conversationIndex: Int? = nil) {
        self.instructionID = instructionID
        self.conversationIndex = conversationIndex
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

/// The model-facing conversation was compacted: older turns were reduced to a
/// bounded summary and the recent ones kept whole.
///
/// This is a *transcript* event, not a change to the transcript. The reader's
/// record keeps every turn; only what the model is sent shrinks. It exists so
/// the surface can draw one quiet row at the moment it happened — a run that
/// suddenly forgets an early instruction is otherwise inexplicable — and so a
/// `/compact` the reader asked for has something to show for itself.
public struct CompactionEvent: Hashable, Codable, Sendable {
    /// Who wrote the summary.
    public enum SummarySource: String, Hashable, Codable, Sendable {
        /// The session's own model, asked to summarise the folded turns.
        case model
        /// Juno's bounded role-labelled notes: the fallback whenever the model
        /// could not be asked, did not answer in time, or answered with
        /// something that was not a summary.
        case structural
    }

    /// The bounded summary older turns were reduced to.
    public let summary: String
    /// Model messages before and after the fold.
    public let beforeMessageCount: Int
    public let afterMessageCount: Int
    /// The provider-reported prompt size before the fold, when one was known.
    public let beforeTokens: Int?
    /// Whether the reader asked for it (`/compact`) or the runtime did it on its
    /// own ahead of a provider limit.
    public let requestedByUser: Bool
    public let summarySource: SummarySource
    /// What the reader asked the summary to keep (`/compact keep the API
    /// decisions`), verbatim.
    public let focus: String?
    /// Why the model's summary was not used, when it was asked for one and the
    /// structural summary stood in. A sentence fragment: "it took too long".
    public let fallbackReason: String?
    /// What the summarising call was billed for, when one was made and the
    /// provider reported it. Recorded here because it is the one model call
    /// that no turn in the transcript accounts for.
    public let summaryInputTokens: Int?
    public let summaryOutputTokens: Int?

    private enum CodingKeys: String, CodingKey {
        case summary, beforeMessageCount, afterMessageCount, beforeTokens, requestedByUser
        case summarySource, focus, fallbackReason, summaryInputTokens, summaryOutputTokens
    }

    public init(
        summary: String,
        beforeMessageCount: Int,
        afterMessageCount: Int,
        beforeTokens: Int? = nil,
        requestedByUser: Bool = false,
        summarySource: SummarySource = .structural,
        focus: String? = nil,
        fallbackReason: String? = nil,
        summaryInputTokens: Int? = nil,
        summaryOutputTokens: Int? = nil
    ) {
        self.summary = summary
        self.beforeMessageCount = beforeMessageCount
        self.afterMessageCount = afterMessageCount
        self.beforeTokens = beforeTokens
        self.requestedByUser = requestedByUser
        self.summarySource = summarySource
        self.focus = focus
        self.fallbackReason = fallbackReason
        self.summaryInputTokens = summaryInputTokens
        self.summaryOutputTokens = summaryOutputTokens
    }

    /// Transcripts written before the model could summarise carry none of the
    /// newer fields, and every summary in them was structural.
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        summary = try values.decode(String.self, forKey: .summary)
        beforeMessageCount = try values.decode(Int.self, forKey: .beforeMessageCount)
        afterMessageCount = try values.decode(Int.self, forKey: .afterMessageCount)
        beforeTokens = try values.decodeIfPresent(Int.self, forKey: .beforeTokens)
        requestedByUser = try values.decodeIfPresent(Bool.self, forKey: .requestedByUser) ?? false
        summarySource = try values.decodeIfPresent(SummarySource.self, forKey: .summarySource) ?? .structural
        focus = try values.decodeIfPresent(String.self, forKey: .focus)
        fallbackReason = try values.decodeIfPresent(String.self, forKey: .fallbackReason)
        summaryInputTokens = try values.decodeIfPresent(Int.self, forKey: .summaryInputTokens)
        summaryOutputTokens = try values.decodeIfPresent(Int.self, forKey: .summaryOutputTokens)
    }

    /// `12 → 5 messages`.
    public var messageCountSummary: String {
        "\(beforeMessageCount) → \(afterMessageCount) messages"
    }
}

/// A hook did something the reader is owed an explanation for.
///
/// Only the moments that change what happens are recorded: a hook that
/// blocked a tool or a prompt, told the agent something after a tool ran, kept
/// the agent going when it meant to stop, ended the run, or failed. A hook
/// that ran and had nothing to say leaves no trace in the thread — hooks are
/// meant to be invisible until they matter.
public struct HookActivityEvent: Hashable, Codable, Sendable {
    public enum Outcome: String, Codable, CaseIterable, Sendable {
        /// Stopped a tool call before it ran, or a prompt before it was sent.
        case blocked
        /// Sent the agent a note about a tool call that already ran.
        case feedback
        /// Asked the agent to keep working when it was about to stop.
        case continued
        /// Ended the run (`"continue": false`).
        case stopped
        /// Exited with an error or timed out. The run carried on.
        case failed
        /// A message the hook asked to show the reader (`systemMessage`).
        case message
    }

    /// The lifecycle event, in the names hooks are configured with
    /// (`PreToolUse`, `UserPromptSubmit`, `Stop`…).
    public let hookEvent: String
    /// A short name for the hook — its script, or the start of its command.
    /// Empty when the runtime itself is speaking about hooks.
    public let hookName: String
    public let outcome: Outcome
    /// The hook's reason, or its error output, bounded.
    public let message: String
    /// The tool call a `PreToolUse` or `PostToolUse` hook was about.
    public let toolCallID: String?
    /// What was blocked when it is not a tool call: the prompt's text.
    public let subject: String?

    public init(
        hookEvent: String,
        hookName: String,
        outcome: Outcome,
        message: String,
        toolCallID: String? = nil,
        subject: String? = nil
    ) {
        self.hookEvent = hookEvent
        self.hookName = hookName
        self.outcome = outcome
        self.message = message
        self.toolCallID = toolCallID
        self.subject = subject
    }
}

public struct RunCompletedEvent: Hashable, Codable, Sendable {
    public let summary: String
    public let filesChanged: Int
    public let testsPassed: Bool?
    public let durationSeconds: Double
    /// Why the run ended (CODE_AGENT_SPEC §1.3). Nil in transcripts written
    /// before the stop check existed.
    public let endReason: RunEndReason?
    /// The end reason in words, for the divider after "Worked for 4m 12s":
    /// "Checked with `swift test`", "Stopped at 200 steps. Keep going?".
    public let endDetail: String?

    public init(
        summary: String,
        filesChanged: Int,
        testsPassed: Bool?,
        durationSeconds: Double,
        endReason: RunEndReason? = nil,
        endDetail: String? = nil
    ) {
        self.summary = summary
        self.filesChanged = filesChanged
        self.testsPassed = testsPassed
        self.durationSeconds = durationSeconds
        self.endReason = endReason
        self.endDetail = endDetail
    }
}

// MARK: - The autonomous loop's events (CODE_AGENT_SPEC §1.13)

/// The runtime kept the run going: the stop check did not let a turn end, or
/// the reader resumed one. Shown as a quiet caption ("Kept going: 2 todos were
/// open"), never as the reader's message.
public struct RunContinuedEvent: Hashable, Codable, Sendable {
    public let reason: RuntimeNote.Reason
    /// The concrete fact, for the caption: "2 todos were open",
    /// "`swift test` had not run since the last edit".
    public let detail: String
    /// The workspace revision it was decided at, when one is known.
    public let revision: Int?
    /// What starts the turn that follows.
    public let origin: TurnOrigin

    public init(reason: RuntimeNote.Reason, detail: String, revision: Int? = nil, origin: TurnOrigin) {
        self.reason = reason
        self.detail = detail
        self.revision = revision
        self.origin = origin
    }
}

/// One row of a run report's "Checked" section. Rendered only from ledger
/// records, so a check the model claims but the runtime never saw cannot
/// appear here.
public struct RunOutcomeCheck: Hashable, Codable, Sendable {
    /// `npm run typecheck`, `Preview /settings, desktop and phone`, `Review`.
    public let label: String
    public let passed: Bool
    /// `passed · 11 s · after the last edit`.
    public let detail: String?
    /// The ledger record it was rendered from.
    public let recordID: String?

    public init(label: String, passed: Bool, detail: String? = nil, recordID: String? = nil) {
        self.label = label
        self.passed = passed
        self.detail = detail
        self.recordID = recordID
    }
}

/// How a run ended, and the report built from its ledger: the record the
/// divider, the notification, the runs list, the phone and the web all read.
public struct RunOutcomeEvent: Hashable, Codable, Sendable {
    public let endReason: RunEndReason
    /// The outcome in one sentence, from the model's report when it wrote one.
    public let summary: String
    /// The divider's words about checks: "Checked with `swift test`",
    /// "Not checked: no test command for this project".
    public let verification: String?
    public let checks: [RunOutcomeCheck]
    public let notChecked: [String]
    public let left: [String]
    public let filesChanged: Int
    public let durationSeconds: Double

    public init(
        endReason: RunEndReason,
        summary: String,
        verification: String? = nil,
        checks: [RunOutcomeCheck] = [],
        notChecked: [String] = [],
        left: [String] = [],
        filesChanged: Int = 0,
        durationSeconds: Double = 0
    ) {
        self.endReason = endReason
        self.summary = summary
        self.verification = verification
        self.checks = checks
        self.notChecked = notChecked
        self.left = left
        self.filesChanged = filesChanged
        self.durationSeconds = durationSeconds
    }
}

/// Where a goal stands. Lane A's `GoalRun` (JunoCodeCore/GoalModels.swift)
/// carries it; the raw values are the protocol's `GoalStatus`.
public enum GoalStatus: String, Codable, CaseIterable, Sendable {
    case active
    case paused
    /// Waiting on the reader, always with a reason in words.
    case needsYou = "needs_you"
    case budgetReached = "budget_reached"
    case achieved
    case impossible
    case cleared

    /// Achieved, impossible and cleared goals stay readable but never run.
    public var isFinal: Bool {
        switch self {
        case .achieved, .impossible, .cleared: true
        case .active, .paused, .needsYou, .budgetReached: false
        }
    }
}

/// What a goal check concluded. The judge can only say not met, met or
/// impossible; the deterministic gate adds `gateBlocked`, which is decided
/// before any judge is asked.
public enum GoalVerdictKind: String, Codable, CaseIterable, Sendable {
    case notMet = "not_met"
    case met
    case impossible
    case gateBlocked = "gate_blocked"
}

/// Who set a goal.
public enum GoalOrigin: String, Codable, CaseIterable, Sendable {
    case reader
    case plan
    case ci
    case proposedByModel = "proposed_by_model"
}

/// How one goal criterion is checked.
public enum CriterionCheck: Hashable, Codable, Sendable {
    /// A fresh passing run of this recipe check.
    case command(checkID: String)
    /// A fresh UI check of this target on this surface.
    case ui(surface: UIVerificationSurface, target: String)
    /// Judged from the conversation.
    case judged
}

/// One goal criterion as an event records it.
public struct GoalCriterionSnapshot: Hashable, Codable, Sendable, Identifiable {
    /// `c1`, `c2` …
    public let id: String
    public let text: String
    public let check: CriterionCheck
    /// Whether the evidence satisfies it at the time of the event, when known.
    public let met: Bool?

    public init(id: String, text: String, check: CriterionCheck, met: Bool? = nil) {
        self.id = id
        self.text = text
        self.check = check
        self.met = met
    }
}

/// A goal was set: from `/goal`, an approved plan, CI, or a model proposal the
/// reader started.
public struct GoalSetEvent: Hashable, Codable, Sendable {
    public let goalID: String
    public let objective: String
    public let criteria: [GoalCriterionSnapshot]
    public let constraints: [String]
    public let budget: Budget
    public let origin: GoalOrigin

    public init(
        goalID: String,
        objective: String,
        criteria: [GoalCriterionSnapshot],
        constraints: [String] = [],
        budget: Budget = Budget(),
        origin: GoalOrigin
    ) {
        self.goalID = goalID
        self.objective = objective
        self.criteria = criteria
        self.constraints = constraints
        self.budget = budget
        self.origin = origin
    }
}

/// A goal as it stands after the reader edited it. The whole of it, so each
/// event is readable on its own.
public struct GoalEditedEvent: Hashable, Codable, Sendable {
    public let goalID: String
    public let objective: String
    public let criteria: [GoalCriterionSnapshot]
    public let constraints: [String]
    public let budget: Budget

    public init(
        goalID: String,
        objective: String,
        criteria: [GoalCriterionSnapshot],
        constraints: [String] = [],
        budget: Budget = Budget()
    ) {
        self.goalID = goalID
        self.objective = objective
        self.criteria = criteria
        self.constraints = constraints
        self.budget = budget
    }
}

/// One check of the goal, shown as a collapsed caption ("Checked the goal: not
/// yet — c2 has no Preview evidence").
public struct GoalVerdictEvent: Hashable, Codable, Sendable {
    public let goalID: String
    public let verdict: GoalVerdictKind
    /// At most 300 characters, shown in the thread.
    public let reason: String
    public let unmetCriteria: [String]
    public let revision: Int

    public static let maximumReasonCharacters = 300

    public init(goalID: String, verdict: GoalVerdictKind, reason: String, unmetCriteria: [String] = [], revision: Int) {
        self.goalID = goalID
        self.verdict = verdict
        self.reason = String(reason.prefix(Self.maximumReasonCharacters))
        self.unmetCriteria = unmetCriteria
        self.revision = revision
    }
}

/// The goal's status or spend changed.
public struct GoalStatusEvent: Hashable, Codable, Sendable {
    public let goalID: String
    public let status: GoalStatus
    /// Why, in words, for `needsYou` above all: "Waiting for you to allow
    /// `npm install`".
    public let reason: String?
    public let usage: BudgetUsage
    public let budget: Budget

    public init(goalID: String, status: GoalStatus, reason: String? = nil, usage: BudgetUsage = BudgetUsage(), budget: Budget = Budget()) {
        self.goalID = goalID
        self.status = status
        self.reason = reason
        self.usage = usage
        self.budget = budget
    }
}

/// Background work kept a run waiting long enough that the model is asked to
/// read it, keep waiting, or stop what is stuck.
public struct CheckInDueEvent: Hashable, Codable, Sendable {
    /// What is still running, in words: "`xcodebuild test` (12 min)".
    public let running: [String]
    public let waitedSeconds: Double
    /// Idle check-ins since the reader's last message; at most 3.
    public let idleCheckIns: Int

    public init(running: [String], waitedSeconds: Double, idleCheckIns: Int) {
        self.running = running
        self.waitedSeconds = waitedSeconds
        self.idleCheckIns = idleCheckIns
    }
}

/// Where one CI check stands. The raw values are the protocol's `CICheckState`.
public enum CICheckState: String, Codable, CaseIterable, Sendable {
    case queued
    case running
    case passed
    case failed
    case cancelled
    case skipped

    public var isSettled: Bool {
        switch self {
        case .passed, .failed, .cancelled, .skipped: true
        case .queued, .running: false
        }
    }
}

/// One CI check on a pull request.
public struct CICheck: Hashable, Codable, Sendable {
    public let name: String
    public let state: CICheckState
    public let url: String?

    public init(name: String, state: CICheckState, url: String? = nil) {
        self.name = name
        self.state = state
        self.url = url
    }
}

/// CI for a pull request Juno opened moved: "3 of 4 checks passed; `test
/// (ubuntu)` failed".
public struct CIStatusEvent: Hashable, Codable, Sendable {
    public let pullRequestNumber: Int?
    public let pullRequestURL: String?
    public let checks: [CICheck]

    public init(pullRequestNumber: Int? = nil, pullRequestURL: String? = nil, checks: [CICheck]) {
        self.pullRequestNumber = pullRequestNumber
        self.pullRequestURL = pullRequestURL
        self.checks = checks
    }
}

/// Whose budget was reached.
public enum BudgetScope: String, Codable, CaseIterable, Sendable {
    case run
    case goal
}

/// A run or goal budget was reached. A wrap-up turn follows; reaching a budget
/// is never "done", and Keep going adds the same budget again.
public struct BudgetReachedEvent: Hashable, Codable, Sendable {
    public let scope: BudgetScope
    public let limit: BudgetLimit
    public let budget: Budget
    public let usage: BudgetUsage
    /// The goal, when `scope` is `.goal`.
    public let goalID: String?

    public init(scope: BudgetScope, limit: BudgetLimit, budget: Budget, usage: BudgetUsage, goalID: String? = nil) {
        self.scope = scope
        self.limit = limit
        self.budget = budget
        self.usage = usage
        self.goalID = goalID
    }
}

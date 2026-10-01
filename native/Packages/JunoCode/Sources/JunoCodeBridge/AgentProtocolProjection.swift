import Foundation
import JunoAgentProtocol
import JunoCodeCore

/// A Mac session's transcript, as the canonical agent protocol.
///
/// The one mapping from `SessionEventPayload` to
/// `contracts/agent/juno-agent-protocol-v1.json`. Before it, the Mac had two:
/// `CodeRelayEventProjection` for the phone's relay and a second, different one
/// in `DesktopCodeHost` for device tasks — so the same run read one way on a
/// phone watching the session and another on the web watching the task. Both
/// wires are now derived from what this returns (`CodeRelayEventProjection`,
/// `CodeTaskWireProjection`), and both carry these events for readers that
/// speak the protocol.
///
/// **What leaves the Mac is decided here, field by field**, with the relay's
/// long-standing rules: a tool call's summary and never its input, a
/// workspace's name and never its path, bounded text with likely credentials
/// redacted.
///
/// **Deterministic**, because the relay numbers events from the journal and
/// drops a re-sent batch as a replay: the same journal entry always yields the
/// same events, ids and sequence numbers. An entry becomes at most four events,
/// numbered `sequence × 4 + 1…`, so `seq` increases across the whole stream.
public enum AgentProtocolProjection {
    /// Bounds per field, shared with the relay: a phone renders a paragraph and
    /// a terminal tail, not a log file, and the relay refuses an event over 64 KB.
    public static let maximumTextCharacters = 12_000
    public static let maximumOutputCharacters = 8_000
    public static let maximumSummaryCharacters = 1_000

    private static let redactor = SecretRedactor()

    /// The protocol events one journal entry means.
    public static func events(for event: SessionEvent) -> [AgentEvent] {
        var index = 0
        func make(_ payload: AgentEventPayload, turnId: String? = nil) -> AgentEvent {
            defer { index += 1 }
            return AgentEvent(
                id: index == 0 ? event.id : "\(event.id):\(index)",
                sessionId: event.sessionID.value,
                seq: event.sequence * 4 + index + 1,
                at: timestamp(event.timestamp),
                turnId: turnId,
                payload: payload
            )
        }

        switch event.payload {
        case .sessionCreated(let created):
            let configuration = created.configuration
            return [
                make(.sessionCreated(.init(
                    target: target(configuration.location),
                    // The workspace's name only: `executionRootPath` is an
                    // absolute path on this Mac and never leaves it.
                    workspaceName: created.workspaceName,
                    model: configuration.modelID,
                    effort: configuration.reasoningEffort.map(effort),
                    mode: mode(configuration.permissionMode)
                ))),
            ]

        case .turnConfiguration(let turn):
            return [
                make(.sessionConfigured(.init(
                    model: turn.modelID,
                    effort: turn.reasoningEffort.map(effort),
                    mode: mode(turn.effectivePermissionMode),
                    behavior: behavior(turn.behavior)
                ))),
            ]

        case .userPrompt(let prompt):
            // A prompt opens a turn; the turn is named after the prompt's
            // journal entry, which is also what a rewind points back to.
            let turnID = turnID(for: event.id)
            return [
                make(.turnStarted(.init(origin: .user)), turnId: turnID),
                make(
                    .itemUserMessage(.init(itemId: event.id, text: bounded(prompt.text, maximumTextCharacters), delivery: .prompt)),
                    turnId: turnID
                ),
            ]

        case .userInstruction(let instruction):
            return [
                make(.itemUserMessage(.init(
                    itemId: instruction.id,
                    text: bounded(instruction.text, maximumTextCharacters),
                    delivery: instruction.kind == .steer ? .steer : .queue
                ))),
            ]

        case .userInstructionApplied, .toolStarted:
            // Bookkeeping: an instruction reaching the model, a call leaving
            // the proposal stage. Neither is a new fact for a reader.
            return []

        case .assistantMessage(let message):
            return [make(.itemAssistantText(.init(itemId: event.id, text: bounded(message.text, maximumTextCharacters))))]

        case .reasoningSummary(let reasoning):
            return [make(.itemThinking(.init(itemId: event.id, summary: bounded(reasoning.summary, maximumTextCharacters))))]

        case .toolProposed(let tool):
            // The summary, never the input: a write's input is the whole file.
            return [
                make(.itemToolCall(.init(
                    itemId: tool.toolCallID,
                    toolName: tool.toolName,
                    toolKind: toolKind(tool.toolName),
                    title: bounded(tool.summary, maximumSummaryCharacters),
                    risk: risk(tool.risk)
                ))),
            ]

        case .toolOutput(let output):
            return [
                make(.itemToolOutput(.init(
                    itemId: output.toolCallID,
                    channel: channel(output.channel),
                    text: bounded(output.text, maximumOutputCharacters)
                ))),
            ]

        case .toolCompleted(let tool):
            return [
                make(.itemToolResult(.init(
                    itemId: tool.toolCallID,
                    status: status(tool.status, durationSeconds: tool.durationSeconds),
                    summary: bounded(tool.resultSummary, maximumSummaryCharacters),
                    durationMs: milliseconds(tool.durationSeconds)
                ))),
            ]

        case .approvalRequested(let approval):
            return [
                make(.approvalRequested(.init(
                    approvalId: approval.id,
                    action: approval.toolName,
                    summary: bounded(approval.summary, maximumSummaryCharacters),
                    risk: risk(approval.risk),
                    digest: approval.actionDigest,
                    expiresAt: timestamp(approval.expiresAt),
                    suggestedRule: approval.suggestedRule?.description
                ))),
            ]

        case .approvalResolved(let resolved):
            // The journal records approved or denied. "Always allow" saves a
            // rule and journals an approval, so it reads as allow_once here.
            return [
                make(.approvalResolved(.init(
                    approvalId: resolved.approvalID,
                    decision: resolved.decision == .approved ? .allowOnce : .deny,
                    by: .user
                ))),
            ]

        case .fileChanged(let change):
            // The workspace-relative path and its size, not its contents. The
            // checkpoint id is what lets a reader ask for exactly this change
            // to be undone.
            return [
                make(.itemFileChange(.init(
                    itemId: event.id,
                    path: change.path.value,
                    change: fileChange(change.kind),
                    linesAdded: change.linesAdded,
                    linesRemoved: change.linesRemoved,
                    checkpointId: change.checkpointID
                ))),
            ]

        case .testRunCompleted(let run):
            return [
                make(.itemTestRun(.init(
                    itemId: event.id,
                    command: bounded(run.command, maximumSummaryCharacters),
                    passed: run.passed,
                    testsRun: run.testsRun,
                    failures: run.failures,
                    durationMs: milliseconds(run.durationSeconds)
                ))),
            ]

        case .subagentUpdated(let update):
            // Its title, state and result — not the brief it was given.
            let usage: AgentUsage? = if let input = update.inputTokens, let output = update.outputTokens {
                AgentUsage(inputTokens: input, outputTokens: output)
            } else {
                nil
            }
            return [
                make(.itemSubagent(.init(
                    itemId: update.agentID,
                    title: bounded(update.title, maximumSummaryCharacters),
                    status: AgentSubagentStatus(rawValue: update.status.rawValue) ?? .unknown,
                    role: update.role.rawValue,
                    activity: update.currentActivity.isEmpty ? nil : bounded(update.currentActivity, maximumSummaryCharacters),
                    summary: update.summary.map { bounded($0, maximumSummaryCharacters) },
                    error: update.error.map { bounded($0, maximumSummaryCharacters) },
                    toolItemId: update.toolCallID,
                    usage: usage
                ))),
            ]

        case .goalUpdated(let goal):
            return [
                make(.planUpdated(.init(
                    steps: goal.goal.steps.map {
                        AgentPlanStep(id: $0.id, text: bounded($0.title, maximumSummaryCharacters), status: stepStatus($0.status))
                    },
                    objective: bounded(goal.goal.objective, maximumSummaryCharacters)
                ))),
            ]

        case .statusChanged(let status):
            return [make(.sessionState(.init(state: state(status.status))))]

        case .errorOccurred(let error):
            return [
                make(.sessionError(.init(error: AgentErrorInfo(
                    code: .internal,
                    message: bounded(error.message, maximumSummaryCharacters),
                    retryable: error.isRecoverable
                )))),
            ]

        case .runCompleted(let run):
            var events: [AgentEvent] = []
            if let usage = run.usage {
                events.append(make(.usageUpdated(.init(
                    usage: AgentUsage(
                        inputTokens: max(0, usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens),
                        outputTokens: usage.outputTokens,
                        cacheReadTokens: usage.cacheReadTokens,
                        cacheWriteTokens: usage.cacheWriteTokens
                    ), scope: .turn
                ))))
            }
            if run.endReason == .error {
                events.append(make(.turnFailed(.init(error: AgentErrorInfo(
                    code: .internal, message: bounded(run.summary, maximumSummaryCharacters), retryable: true
                )))))
            } else if run.endReason == .stopped || run.endReason == .interrupted {
                events.append(make(.turnInterrupted(.init(reason: run.endDetail ?? run.summary))))
            } else {
                events.append(make(.turnCompleted(.init(
                    stopReason: stopReason(run.endReason),
                    durationMs: milliseconds(run.durationSeconds),
                    filesChanged: run.filesChanged,
                    summary: bounded(run.summary, maximumTextCharacters)
                ))))
            }
            return events

        case .compaction(let compaction):
            return [
                make(.itemCompaction(.init(
                    itemId: event.id,
                    source: compaction.summarySource == .model ? .model : .structural,
                    beforeMessages: compaction.beforeMessageCount,
                    afterMessages: compaction.afterMessageCount,
                    requestedByUser: compaction.requestedByUser
                ))),
            ]

        case .transcriptRewound(let rewind):
            return [make(.transcriptRestarted(.init(rewoundToTurnId: turnID(for: rewind.turnID))))]

        case .todosUpdated(let list):
            // The checklist is the protocol's plan: every step, each
            // snapshot replacing the last. It has no objective; the goal's
            // snapshot is the one that carries one.
            return [
                make(.planUpdated(.init(
                    steps: list.items.map {
                        AgentPlanStep(id: $0.id, text: bounded($0.content, maximumSummaryCharacters), status: todoStatus($0.status))
                    }
                ))),
            ]

        case .questionRequested(let request):
            // One protocol question per request, named by the request: the
            // answer the journal records names only the request, and a reader
            // that folds the ask must be able to fold that answer onto it.
            // A single question keeps its options; several are written out
            // in one prompt, each with its choices.
            let single = request.questions.count == 1 ? request.questions.first : nil
            return [
                make(.questionAsked(.init(
                    questionId: request.id,
                    prompt: bounded(questionPrompt(request.questions), maximumTextCharacters),
                    options: single.map { question in
                        question.options.map {
                            let label = bounded($0.label, maximumSummaryCharacters)
                            return AgentQuestionOption(id: label, label: label)
                        }
                    },
                    multiSelect: single?.allowsMultipleSelection,
                    expiresAt: timestamp(request.expiresAt)
                ))),
            ]

        case .questionResolved(let resolved):
            // Declined, expired and cancelled close the question too, with
            // nothing chosen: the reader's state moves on either way.
            guard case let .answered(answers) = resolved.resolution else {
                return [make(.questionAnswered(.init(questionId: resolved.requestID)))]
            }
            let written = answers.compactMap(\.text)
            return [
                make(.questionAnswered(.init(
                    questionId: resolved.requestID,
                    answer: written.isEmpty ? nil : bounded(written.joined(separator: "\n"), maximumTextCharacters),
                    selected: answers.count == 1
                        ? answers[0].selectedOptions.map { bounded($0, maximumSummaryCharacters) }
                        : nil
                ))),
            ]

        case .planSubmitted(let request):
            return [make(.planProposed(.init(planId: request.id, text: bounded(request.plan, maximumTextCharacters))))]

        case .planResolved(let resolved):
            // Only an approval carries the plan out; keep planning, expiry
            // and a stopped run all leave it undone.
            let decision: AgentPlanDecision = if case .approved = resolved.decision { .approved } else { .rejected }
            return [make(.planResolved(.init(planId: resolved.requestID, decision: decision)))]

        case .hookActivity(let activity):
            // A quiet note: which hook stepped in and why. What it blocked
            // already reaches a reader as that tool's result.
            return [
                make(.itemNotice(.init(
                    itemId: event.id,
                    source: .hook,
                    text: "\(activity.hookEvent) hook \(activity.outcome.rawValue)",
                    detail: bounded(activity.message, maximumSummaryCharacters)
                ))),
            ]

        // The autonomous loop (protocol v1.1). Recorded evidence and goal
        // state, bounded like everything else; never a file's contents.
        case .runContinued(let continued):
            return [
                make(.runContinued(.init(
                    reason: AgentContinueReason(rawValue: continued.reason.rawValue) ?? .unknown,
                    detail: bounded(continued.detail, maximumSummaryCharacters),
                    revision: continued.revision
                ))),
            ]

        case .runOutcome(let outcome):
            return [
                make(.runOutcome(.init(
                    endReason: AgentRunEndReason(rawValue: outcome.endReason.rawValue) ?? .unknown,
                    summary: bounded(outcome.summary, maximumTextCharacters),
                    verification: outcome.verification.map { bounded($0, maximumSummaryCharacters) },
                    checks: outcome.checks.map {
                        AgentRunCheck(
                            label: bounded($0.label, maximumSummaryCharacters),
                            passed: $0.passed,
                            detail: $0.detail.map { bounded($0, maximumSummaryCharacters) }
                        )
                    },
                    notChecked: outcome.notChecked.map { bounded($0, maximumSummaryCharacters) },
                    left: outcome.left.map { bounded($0, maximumSummaryCharacters) },
                    filesChanged: outcome.filesChanged,
                    durationMs: milliseconds(outcome.durationSeconds)
                ))),
            ]

        case .verificationRecorded(let record):
            return [
                make(.verifyResult(.init(
                    command: bounded(record.command, maximumSummaryCharacters),
                    passed: record.passed,
                    exitCode: Int(record.exitCode),
                    revision: record.workspaceRevision,
                    check: record.checkID,
                    kind: AgentCheckKind(rawValue: record.kind.rawValue) ?? .unknown,
                    durationMs: record.durationMs,
                    excerpt: record.excerpt.isEmpty ? nil : bounded(record.excerpt, maximumOutputCharacters)
                ))),
            ]

        case .uiVerificationRecorded(let record):
            return [
                make(.verifyUi(.init(
                    surface: AgentVerifySurface(rawValue: record.surface.rawValue) ?? .unknown,
                    target: bounded(record.target, maximumSummaryCharacters),
                    passed: record.passed,
                    revision: record.workspaceRevision,
                    viewport: record.viewport,
                    checks: record.checks.map {
                        AgentUICheck(
                            name: bounded($0.name, maximumSummaryCharacters),
                            passed: $0.passed,
                            detail: $0.detail.map { bounded($0, maximumSummaryCharacters) }
                        )
                    },
                    screenshotHash: record.screenshotHash
                ))),
            ]

        case .reviewCompleted(let review):
            return [
                make(.reviewFindings(.init(
                    round: review.round,
                    overall: AgentReviewOverall(rawValue: review.overall.rawValue) ?? .unknown,
                    findings: review.findings.map {
                        AgentReviewFinding(
                            priority: AgentReviewPriority(rawValue: $0.priority.rawValue) ?? .unknown,
                            title: bounded($0.title, maximumSummaryCharacters),
                            confidence: $0.confidence,
                            path: $0.path,
                            line: $0.line,
                            body: $0.body.isEmpty ? nil : bounded($0.body, maximumSummaryCharacters),
                            criterion: $0.criterion
                        )
                    },
                    summary: review.summary.isEmpty ? nil : bounded(review.summary, maximumSummaryCharacters),
                    revision: review.workspaceRevision
                ))),
            ]

        case .goalSet(let goal):
            return [
                make(.goalSet(.init(
                    goalId: goal.goalID,
                    objective: bounded(goal.objective, maximumTextCharacters),
                    criteria: goal.criteria.map(criterion),
                    constraints: goal.constraints.map { bounded($0, maximumSummaryCharacters) },
                    budget: budget(goal.budget),
                    origin: AgentGoalOrigin(rawValue: goal.origin.rawValue) ?? .unknown
                ))),
            ]

        case .goalEdited(let goal):
            return [
                make(.goalUpdated(.init(
                    goalId: goal.goalID,
                    objective: bounded(goal.objective, maximumTextCharacters),
                    criteria: goal.criteria.map(criterion),
                    constraints: goal.constraints.map { bounded($0, maximumSummaryCharacters) },
                    budget: budget(goal.budget)
                ))),
            ]

        case .goalVerdict(let verdict):
            return [
                make(.goalVerdict(.init(
                    goalId: verdict.goalID,
                    verdict: AgentGoalVerdict(rawValue: verdict.verdict.rawValue) ?? .unknown,
                    reason: bounded(verdict.reason, GoalVerdictEvent.maximumReasonCharacters),
                    unmetCriteria: verdict.unmetCriteria,
                    revision: verdict.revision
                ))),
            ]

        case .goalStatus(let status):
            return [
                make(.goalStatus(.init(
                    goalId: status.goalID,
                    status: AgentGoalStatus(rawValue: status.status.rawValue) ?? .unknown,
                    reason: status.reason.map { bounded($0, maximumSummaryCharacters) },
                    usage: usage(status.usage),
                    budget: budget(status.budget)
                ))),
            ]

        case .checkInDue(let checkIn):
            return [
                make(.checkinDue(.init(
                    running: checkIn.running.map { bounded($0, maximumSummaryCharacters) },
                    waitedMs: milliseconds(checkIn.waitedSeconds),
                    idleCheckIns: checkIn.idleCheckIns
                ))),
            ]

        case .ciStatus(let ci):
            return [
                make(.ciStatus(.init(
                    checks: ci.checks.map {
                        AgentCICheck(
                            name: bounded($0.name, maximumSummaryCharacters),
                            state: AgentCICheckState(rawValue: $0.state.rawValue) ?? .unknown,
                            url: $0.url
                        )
                    },
                    prNumber: ci.pullRequestNumber,
                    prUrl: ci.pullRequestURL
                ))),
            ]

        case .budgetReached(let reached):
            return [
                make(.budgetReached(.init(
                    scope: AgentBudgetScope(rawValue: reached.scope.rawValue) ?? .unknown,
                    limit: AgentBudgetLimit(rawValue: reached.limit.rawValue) ?? .unknown,
                    goalId: reached.goalID,
                    usage: usage(reached.usage),
                    budget: budget(reached.budget)
                ))),
            ]
        }
    }

    private static func criterion(_ criterion: GoalCriterionSnapshot) -> AgentGoalCriterion {
        let text = bounded(criterion.text, maximumSummaryCharacters)
        switch criterion.check {
        case let .command(checkID):
            return AgentGoalCriterion(id: criterion.id, text: text, check: .command, checkId: checkID, met: criterion.met)
        case let .ui(surface, target):
            return AgentGoalCriterion(
                id: criterion.id,
                text: text,
                check: .ui,
                surface: AgentVerifySurface(rawValue: surface.rawValue) ?? .unknown,
                target: target,
                met: criterion.met
            )
        case .judged:
            return AgentGoalCriterion(id: criterion.id, text: text, check: .judged, met: criterion.met)
        }
    }

    private static func budget(_ budget: Budget) -> AgentBudget? {
        guard !budget.isUnlimited else { return nil }
        return AgentBudget(
            minutes: budget.minutes,
            turns: budget.turns,
            tokens: budget.tokens,
            costMicroUsd: budget.costUSD.map(microUSD)
        )
    }

    private static func usage(_ usage: BudgetUsage) -> AgentBudgetUsage {
        AgentBudgetUsage(
            minutes: usage.minutes,
            turns: usage.turns,
            tokens: usage.tokens,
            costMicroUsd: usage.costUSD.map(microUSD)
        )
    }

    /// Dollars as the protocol's millionths of a dollar.
    private static func microUSD(_ dollars: Double) -> Int {
        Int((dollars * 1_000_000).rounded())
    }

    /// An event as the JSON the protocol puts on the wire.
    public static func jsonData(_ event: AgentEvent) throws -> Data {
        try encoder.encode(event)
    }

    // MARK: - Vocabulary

    /// The turn a prompt opened, named after the prompt's journal entry.
    public static func turnID(for promptEventID: String) -> String {
        "turn:\(promptEventID)"
    }

    public static func mode(_ mode: PermissionMode) -> AgentPermissionMode {
        switch mode {
        case .readOnly: .plan
        case .askBeforeChanges: .ask
        case .workspaceWrite: .autoEdit
        case .fullAccess: .full
        }
    }

    /// The reverse, for the wires that still speak the Swift names.
    public static func permissionMode(_ mode: AgentPermissionMode) -> PermissionMode? {
        switch mode {
        case .plan: .readOnly
        case .ask: .askBeforeChanges
        case .autoEdit: .workspaceWrite
        case .full: .fullAccess
        case .unknown: nil
        }
    }

    public static func state(_ status: SessionStatus) -> AgentSessionState {
        switch status {
        case .idle: .idle
        case .planning, .running, .waitingForProvider, .degraded, .stopping: .running
        case .waitingForApproval: .awaitingApproval
        case .completed: .completed
        case .failed: .failed
        case .cancelled: .cancelled
        }
    }

    /// A cancelled call that never ran was not executed; one stopped while it
    /// ran may have done part of its work, and nobody knows how it ended.
    public static func status(_ status: ToolCompletionStatus, durationSeconds: Double) -> AgentToolResultStatus {
        switch status {
        case .succeeded: .ok
        case .failed: .error
        case .denied: .denied
        case .cancelled: durationSeconds > 0 ? .unknown : .notExecuted
        }
    }

    /// What kind of call a Mac tool is.
    public static func toolKind(_ name: String) -> AgentToolKind {
        switch name {
        case "read_file", "list_directory", "inspect_active_editor": return .read
        case "write_file", "apply_patch", "create_file", "delete_file", "move_file": return .edit
        case "run_command": return .execute
        case "glob", "grep", "find_files": return .search
        case "web_fetch", "web_search": return .fetch
        case "delegate_task", "update_goal": return .think
        default: return .other
        }
    }

    private static func target(_ location: SessionLocation) -> AgentSessionTarget {
        switch location {
        case .local: .local
        case .remote: .remote
        case .cloud: .cloud
        }
    }

    private static func effort(_ effort: ReasoningEffort) -> AgentReasoningEffort {
        AgentReasoningEffort(rawValue: effort.rawValue) ?? .unknown
    }

    private static func behavior(_ behavior: AgentBehavior) -> AgentTurnBehavior {
        AgentTurnBehavior(rawValue: behavior.rawValue) ?? .unknown
    }

    private static func risk(_ risk: ActionRisk) -> AgentRisk {
        AgentRisk(rawValue: risk.rawValue) ?? .unknown
    }

    private static func channel(_ channel: ToolOutputChannel) -> AgentOutputChannel {
        AgentOutputChannel(rawValue: channel.rawValue) ?? .unknown
    }

    private static func fileChange(_ kind: FileChangeKind) -> AgentFileChangeKind {
        AgentFileChangeKind(rawValue: kind.rawValue) ?? .unknown
    }

    private static func stepStatus(_ status: GoalStepStatus) -> AgentPlanStepStatus {
        switch status {
        case .pending: .pending
        case .inProgress: .inProgress
        case .completed: .completed
        case .blocked: .blocked
        }
    }

    /// How a run's end reads as the turn's stop reason. The full reason is
    /// in `run.outcome`; this is the nearest the older field can say.
    private static func stopReason(_ reason: RunEndReason?) -> AgentStopReason {
        switch reason {
        case .stepLimit?: .maxSteps
        case .budget?: .budget
        case .stalled?: .stalled
        case .blocked?: .blocked
        case .stopped?: .cancelled
        case .doneChecked?, .doneUnchecked?, .checksFailing?, .needsYou?, .waitingOnBackground?,
             .interrupted?, .error?, nil:
            .endTurn
        }
    }

    private static func todoStatus(_ status: TodoStatus) -> AgentPlanStepStatus {
        switch status {
        case .pending: .pending
        case .inProgress: .inProgress
        case .completed: .completed
        case .blocked: .blocked
        case .cancelled: .cancelled
        }
    }

    /// The questions of one request as one prompt: a lone question as it
    /// was asked, several numbered, each with its header and choices.
    static func questionPrompt(_ questions: [UserQuestion]) -> String {
        guard questions.count > 1 else { return questions.first?.question ?? "" }
        return questions.enumerated().map { index, question in
            let heading = question.header.map { "\($0): " } ?? ""
            let choices = question.options.map(\.label).joined(separator: " / ")
            return "\(index + 1). \(heading)\(question.question)" + (choices.isEmpty ? "" : " (\(choices))")
        }.joined(separator: "\n")
    }

    private static func milliseconds(_ seconds: Double) -> Int {
        guard seconds.isFinite, seconds > 0 else { return 0 }
        return Int((seconds * 1000).rounded())
    }

    private static func timestamp(_ date: Date) -> String {
        date.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
    }

    /// Redacted, then bounded, with a note that says so.
    static func bounded(_ value: String, _ limit: Int) -> String {
        let redacted = redactor.redact(value)
        guard redacted.count > limit else { return redacted }
        return String(redacted.prefix(limit)) + "\n… [shortened before it left this Mac]"
    }

    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }()
}

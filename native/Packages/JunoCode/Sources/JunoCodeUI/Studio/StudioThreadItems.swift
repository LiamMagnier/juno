import Foundation
import JunoCodeCore

/// One row of the thread.
///
/// The thread is built from the session's append-only events and the
/// projection's narrative groups. Machine activity is folded into
/// ``activity`` rows — one sentence per stretch of work — so the reader sees
/// prompts, replies and outcomes, and opens the machinery only when they want
/// it. Nothing here is a raw tool id.
enum StudioThreadItem: Identifiable, Equatable {
    case user(id: String, text: String)
    /// A message sent while the agent was working.
    case instruction(id: String, text: String, kind: UserInstructionKind)
    case assistant(id: String, text: String)
    /// Reasoning between two replies, shown only when the reader asked to see it.
    case reasoning(id: String, text: String)
    case activity(ActivityNarrativeGroup, reasoning: [String])
    /// An approval the reader already answered.
    case decision(id: String, summary: String, allowed: Bool)
    case plan(id: String, goal: SessionGoal)
    case subagent(id: String, update: SubagentUpdateEvent)
    case tests(id: String, run: TestRunCompletedEvent)
    case error(id: String, message: String)
    case compaction(id: String, event: CompactionEvent)
    /// A project hook blocked something, sent the agent back, ended the run
    /// or failed.
    case hook(id: String, event: HookActivityEvent)
    /// The mode changed between two turns.
    case modeChange(id: String, text: String)
    /// A run's end: how long it took and what it changed.
    case summary(id: String, run: RunCompletedEvent, turn: TurnTotals)
    /// The agent's checklist, as it last wrote it.
    case todos(id: String, list: TodoListEvent)
    /// A question the reader answered, declined or let lapse. One still
    /// waiting is the card above the composer, not a row.
    case question(id: String, request: QuestionRequest, resolution: QuestionResolution)
    /// A plan handed over from Plan mode, and what the reader decided.
    case planReview(id: String, request: PlanApprovalRequest, decision: PlanDecision?)

    var id: String {
        switch self {
        case let .user(id, _), let .instruction(id, _, _), let .assistant(id, _),
             let .reasoning(id, _), let .decision(id, _, _), let .plan(id, _),
             let .subagent(id, _), let .tests(id, _), let .error(id, _),
             let .compaction(id, _), let .hook(id, _), let .modeChange(id, _),
             let .summary(id, _, _), let .todos(id, _), let .question(id, _, _),
             let .planReview(id, _, _):
            id
        case let .activity(group, _):
            group.id
        }
    }

    /// What one run changed, accumulated from its file events.
    struct TurnTotals: Equatable {
        var files: Set<String> = []
        var added = 0
        var removed = 0
    }
}

enum StudioThreadItems {
    static func build(
        events: [SessionEvent],
        groups: [ActivityNarrativeGroup],
        pendingApprovalIDs: Set<String>,
        showReasoning: Bool,
        pendingPlanIDs: Set<String> = []
    ) -> [StudioThreadItem] {
        var owner: [String: Int] = [:]
        for (index, group) in groups.enumerated() {
            for id in group.eventIDs { owner[id] = index }
        }

        var decisions: [String: ApprovalDecision] = [:]
        var latestSubagent: [String: SubagentUpdateEvent] = [:]
        var latestGoal: SessionGoal?
        var questionResolutions: [String: QuestionResolution] = [:]
        var planDecisions: [String: PlanDecision] = [:]
        var lastTodosEventID: String?
        for event in events {
            switch event.payload {
            case let .questionResolved(resolved):
                questionResolutions[resolved.requestID] = resolved.resolution
            case let .planResolved(resolved):
                planDecisions[resolved.requestID] = resolved.decision
            case .todosUpdated:
                lastTodosEventID = event.id
            case let .approvalResolved(resolved):
                decisions[resolved.approvalID] = resolved.decision
            case let .subagentUpdated(update):
                latestSubagent[update.agentID] = update
            case let .goalUpdated(update):
                latestGoal = update.goal
            default:
                break
            }
        }

        var items: [StudioThreadItem] = []
        var placedGroups: Set<Int> = []
        var placedSubagents: Set<String> = []
        var placedPlan = false
        var pendingReasoning: [String] = []
        var lastConfiguration: TurnConfigurationEvent?
        var totals = StudioThreadItem.TurnTotals()

        func flushReasoning(id: String) {
            guard !pendingReasoning.isEmpty else { return }
            if showReasoning {
                items.append(.reasoning(id: "reasoning-\(id)", text: pendingReasoning.joined(separator: "\n\n")))
            }
            pendingReasoning = []
        }

        for event in events {
            if let index = owner[event.id] {
                if case let .fileChanged(change) = event.payload {
                    totals.files.insert(change.path.value)
                    totals.added += change.linesAdded
                    totals.removed += change.linesRemoved
                }
                guard !placedGroups.contains(index) else { continue }
                placedGroups.insert(index)
                items.append(.activity(groups[index], reasoning: showReasoning ? pendingReasoning : []))
                pendingReasoning = []
                continue
            }

            switch event.payload {
            case .sessionCreated, .statusChanged, .toolOutput, .toolStarted,
                 .approvalResolved, .userInstructionApplied, .toolProposed, .toolCompleted:
                continue

            // Where a rewound transcript starts. What was cut is gone, and
            // the prompt is back in the composer; the thread says nothing.
            case .transcriptRewound:
                continue

            case let .fileChanged(change):
                totals.files.insert(change.path.value)
                totals.added += change.linesAdded
                totals.removed += change.linesRemoved

            case let .turnConfiguration(configuration):
                defer { lastConfiguration = configuration }
                guard let previous = lastConfiguration, previous != configuration else { continue }
                if let text = modeChangeText(from: previous, to: configuration) {
                    items.append(.modeChange(id: event.id, text: text))
                }

            case let .userPrompt(prompt):
                flushReasoning(id: event.id)
                totals = StudioThreadItem.TurnTotals()
                items.append(.user(id: event.id, text: prompt.text))

            case let .userInstruction(instruction):
                items.append(.instruction(id: event.id, text: instruction.text, kind: instruction.kind))

            case let .assistantMessage(message):
                flushReasoning(id: event.id)
                items.append(.assistant(id: event.id, text: message.text))

            case let .reasoningSummary(summary):
                pendingReasoning.append(summary.summary)

            case let .approvalRequested(request):
                guard !pendingApprovalIDs.contains(request.id),
                      let decision = decisions[request.id]
                else { continue }
                items.append(.decision(id: event.id, summary: request.summary, allowed: decision == .approved))

            case .goalUpdated:
                guard !placedPlan, let latestGoal, !latestGoal.steps.isEmpty else { continue }
                placedPlan = true
                items.append(.plan(id: event.id, goal: latestGoal))

            case let .subagentUpdated(update):
                guard !placedSubagents.contains(update.agentID) else { continue }
                placedSubagents.insert(update.agentID)
                items.append(.subagent(id: event.id, update: latestSubagent[update.agentID] ?? update))

            case let .testRunCompleted(run):
                items.append(.tests(id: event.id, run: run))

            case let .errorOccurred(error):
                // A recoverable error is the runtime retrying; it says so in the
                // live status rather than as a red row the reader must parse.
                guard !error.isRecoverable else { continue }
                items.append(.error(id: event.id, message: error.message))

            case let .compaction(compaction):
                items.append(.compaction(id: event.id, event: compaction))

            case let .hookActivity(activity):
                items.append(.hook(id: event.id, event: activity))

            case let .runCompleted(run):
                flushReasoning(id: event.id)
                items.append(.summary(id: event.id, run: run, turn: totals))
                totals = StudioThreadItem.TurnTotals()

            case let .todosUpdated(list):
                // One checklist, where it last changed.
                guard event.id == lastTodosEventID, !list.items.isEmpty else { continue }
                items.append(.todos(id: event.id, list: list))

            case let .questionRequested(request):
                guard let resolution = questionResolutions[request.id] else { continue }
                items.append(.question(id: event.id, request: request, resolution: resolution))

            case let .planSubmitted(request):
                // Shown while waiting too: the plan is the answer the run
                // produced, and the card below only asks what to do with it.
                items.append(.planReview(
                    id: event.id,
                    request: request,
                    decision: pendingPlanIDs.contains(request.id) ? nil : planDecisions[request.id]
                ))

            case .questionResolved, .planResolved:
                continue
            }
        }
        return items
    }

    static func modeChangeText(
        from previous: TurnConfigurationEvent,
        to current: TurnConfigurationEvent
    ) -> String? {
        let before = StudioMode(behavior: previous.behavior, permission: previous.permissionMode)
        let after = StudioMode(behavior: current.behavior, permission: current.permissionMode)
        if before != after {
            return "Switched to \(after.title)"
        }
        if previous.modelID != current.modelID {
            return "Switched model"
        }
        return nil
    }
}

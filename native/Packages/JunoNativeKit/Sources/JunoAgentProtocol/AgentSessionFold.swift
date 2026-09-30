import Foundation

/// The canonical agent protocol, reduced to what a surface shows.
///
/// A line-for-line port of the web's reducer (`src/lib/agent-protocol/fold.ts`),
/// and held to the same golden transcripts: every
/// `contracts/agent/fixtures/<name>.jsonl` must fold to its `.folded.json` here
/// exactly as it does in TypeScript (`JunoAgentProtocolTests`). A rule changed on
/// one side and not the other fails that test, which is the point — a Mac, an
/// iPhone and a browser showing the same session must agree about what it did.
///
/// Pure and deterministic: events apply in the order given, an id already
/// applied is skipped, and a tool's outcome is the protocol's typed status —
/// never something read out of a display string.
public struct AgentSessionFold: Sendable {
    public private(set) var view = AgentSessionView()
    private var seen: Set<String> = []
    private var itemIndex: [String: Int] = [:]
    private var turnIndex: [String: Int] = [:]
    /// The turn items without a turnId join.
    private var openTurnID: String?

    public init() {}

    /// Folds a whole stream.
    public static func fold(_ events: some Sequence<AgentEvent>) -> AgentSessionView {
        var fold = AgentSessionFold()
        fold.apply(events)
        return fold.view
    }

    public mutating func apply(_ events: some Sequence<AgentEvent>) {
        for event in events { apply(event) }
    }

    // MARK: - The reducer

    public mutating func apply(_ event: AgentEvent) {
        guard seen.insert(event.id).inserted else { return }
        view.eventCount += 1
        if event.seq > view.lastSeq { view.lastSeq = event.seq }
        if view.sessionId == nil { view.sessionId = event.sessionId }

        switch event.payload {
        case .unknown:
            view.unknownEventCount += 1

        // Session
        case .sessionCreated(let created):
            view.target = created.target
            if let value = created.workspaceName { view.workspaceName = value }
            if let value = created.repository { view.repository = value }
            if let value = created.model { view.model = value }
            if let value = created.effort { view.effort = value }
            if let value = created.mode { view.mode = value }
            if let value = created.title { view.title = value }
        case .sessionConfigured(let configured):
            if let value = configured.model { view.model = value }
            if let value = configured.effort { view.effort = value }
            if let value = configured.mode { view.mode = value }
            if let value = configured.title { view.title = value }
        case .sessionState(let state):
            view.state = state.state
            if Self.terminalStates.contains(state.state) {
                if let open = openTurnID, let index = turnIndex[open], view.turns[index].status == .running {
                    closeTurn(
                        at: index,
                        status: state.state == .completed ? .completed : state.state == .failed ? .failed : .interrupted
                    )
                }
                settleRunningTools(inTurn: nil)
                view.pendingApprovalId = nil
                view.pendingQuestionId = nil
            }
        case .sessionError(let failure):
            view.lastError = failure.error
            let itemID = "error:\(event.id)"
            upsert(event, itemID: itemID, kind: .error) { $0.errorInfo = failure.error }

        // Turns
        case .turnStarted(let started):
            let turnID = event.turnId ?? "turn:\(event.id)"
            if let open = openTurnID, open != turnID, let index = turnIndex[open], view.turns[index].status == .running {
                // A turn that never said it ended: we did not see how, so say that.
                closeTurn(at: index, status: .interrupted)
            }
            if let index = turnIndex[turnID] {
                view.turns[index].status = .running
            } else {
                turnIndex[turnID] = view.turns.count
                view.turns.append(AgentTurnView(turnId: turnID, origin: started.origin))
            }
            openTurnID = turnID
            view.state = .running
        case .turnCompleted(let completed):
            if let index = targetTurnIndex(event) {
                view.turns[index].stopReason = completed.stopReason
                view.turns[index].durationMs = completed.durationMs
                view.turns[index].filesChanged = completed.filesChanged
                view.turns[index].summary = completed.summary
                closeTurn(at: index, status: .completed)
            }
            settleAfterTurn()
        case .turnFailed(let failed):
            view.lastError = failed.error
            if let index = targetTurnIndex(event) {
                view.turns[index].error = failed.error
                closeTurn(at: index, status: .failed)
            }
            settleAfterTurn()
        case .turnInterrupted:
            if let index = targetTurnIndex(event) {
                closeTurn(at: index, status: .interrupted)
            } else {
                settleRunningTools(inTurn: nil)
            }
            settleAfterTurn()
        case .transcriptRestarted:
            view.turns = []
            view.items = []
            itemIndex = [:]
            turnIndex = [:]
            openTurnID = nil
            view.pendingApprovalId = nil
            view.pendingQuestionId = nil
            view.lastError = nil

        // Items
        case .itemUserMessage(let message):
            upsert(event, itemID: message.itemId, kind: .userMessage, create: {
                $0.text = ""
                $0.delivery = message.delivery
            }) {
                $0.text = message.text
                $0.delivery = message.delivery
                $0.commandId = message.commandId
            }
        case .itemAssistantTextDelta(let delta):
            upsert(event, itemID: delta.itemId, kind: .assistantText, create: { $0.text = "" }) {
                $0.text = ($0.text ?? "") + delta.text
            }
        case .itemAssistantText(let text):
            upsert(event, itemID: text.itemId, kind: .assistantText, create: { $0.text = "" }) {
                $0.text = text.text
            }
        case .itemThinkingDelta(let delta):
            upsert(event, itemID: delta.itemId, kind: .thinking, create: { $0.text = "" }) {
                $0.text = ($0.text ?? "") + delta.text
            }
        case .itemThinking(let thinking):
            upsert(event, itemID: thinking.itemId, kind: .thinking, create: { $0.text = "" }) {
                $0.text = thinking.summary
            }
        case .itemToolCall(let call):
            upsertTool(event, itemID: call.itemId) {
                $0.toolName = call.toolName
                $0.toolKind = call.toolKind
                $0.title = call.title
                $0.inputSummary = call.inputSummary
                $0.risk = call.risk
            }
        case .itemToolOutput(let output):
            upsertTool(event, itemID: output.itemId) {
                $0.output = ($0.output ?? "") + output.text
                $0.outputChannel = output.channel
            }
        case .itemToolResult(let result):
            upsertTool(event, itemID: result.itemId) {
                $0.toolStatus = AgentToolItemStatus(result.status)
                $0.summary = result.summary
                $0.exitCode = result.exitCode
                $0.durationMs = result.durationMs
                if let output = result.output { $0.output = output }
            }
        case .itemFileChange(let change):
            upsert(event, itemID: change.itemId, kind: .fileChange, create: {
                $0.path = change.path
                $0.change = change.change
                $0.linesAdded = 0
                $0.linesRemoved = 0
            }) {
                $0.path = change.path
                $0.change = change.change
                $0.linesAdded = change.linesAdded
                $0.linesRemoved = change.linesRemoved
                $0.patch = change.patch
                $0.checkpointId = change.checkpointId
                $0.toolItemId = change.toolItemId
            }
        case .itemTestRun(let run):
            upsert(event, itemID: run.itemId, kind: .testRun, create: {
                $0.command = run.command
                $0.passed = run.passed
            }) {
                $0.command = run.command
                $0.passed = run.passed
                $0.testsRun = run.testsRun
                $0.failures = run.failures
                $0.durationMs = run.durationMs
            }
        case .itemSubagent(let agent):
            upsert(event, itemID: agent.itemId, kind: .subagent, create: {
                $0.title = agent.title
                $0.subagentStatus = agent.status
            }) {
                // The latest snapshot wins whole: a field it no longer carries is gone.
                $0.title = agent.title
                $0.subagentStatus = agent.status
                $0.role = agent.role
                $0.activity = agent.activity
                $0.summary = agent.summary
                $0.errorText = agent.error
                $0.toolItemId = agent.toolItemId
                $0.usage = agent.usage
            }
        case .itemCompaction(let compaction):
            upsert(event, itemID: compaction.itemId, kind: .compaction, create: {
                $0.compactionSource = compaction.source
            }) {
                $0.compactionSource = compaction.source
                $0.beforeMessages = compaction.beforeMessages
                $0.afterMessages = compaction.afterMessages
                $0.requestedByUser = compaction.requestedByUser
            }
        case .itemNotice(let notice):
            upsert(event, itemID: notice.itemId, kind: .notice, create: {
                $0.noticeSource = notice.source
                $0.text = notice.text
            }) {
                $0.noticeSource = notice.source
                $0.text = notice.text
                $0.detail = notice.detail
            }

        // Approvals, questions, plans
        case .approvalRequested(let request):
            var decided = false
            upsertApproval(event, approvalID: request.approvalId) {
                $0.action = request.action
                $0.summary = request.summary
                $0.risk = request.risk
                $0.toolItemId = request.itemId
                $0.digest = request.digest
                $0.expiresAt = request.expiresAt
                $0.suggestedRule = request.suggestedRule
                decided = $0.decision != nil
            }
            if !decided {
                view.pendingApprovalId = request.approvalId
                view.state = .awaitingApproval
            }
        case .approvalResolved(let resolved):
            upsertApproval(event, approvalID: resolved.approvalId) {
                $0.decision = resolved.decision
                $0.by = resolved.by
                $0.feedback = resolved.feedback
            }
            if view.pendingApprovalId == resolved.approvalId {
                view.pendingApprovalId = nil
                if view.state == .awaitingApproval { resume() }
            }
        case .questionAsked(let question):
            var answered = false
            upsertQuestion(event, questionID: question.questionId) {
                $0.prompt = question.prompt
                $0.options = question.options
                $0.multiSelect = question.multiSelect
                $0.expiresAt = question.expiresAt
                answered = $0.answered ?? false
            }
            if !answered {
                view.pendingQuestionId = question.questionId
                view.state = .awaitingInput
            }
        case .questionAnswered(let answer):
            upsertQuestion(event, questionID: answer.questionId) {
                $0.answered = true
                $0.answer = answer.answer
                $0.selected = answer.selected
            }
            if view.pendingQuestionId == answer.questionId {
                view.pendingQuestionId = nil
                if view.state == .awaitingInput { resume() }
            }
        case .planUpdated(let plan):
            view.plan = AgentPlanView(steps: plan.steps, objective: plan.objective)
        case .planProposed(let proposal):
            upsert(event, itemID: "plan:\(proposal.planId)", kind: .planProposal, create: {
                $0.planId = proposal.planId
                $0.text = proposal.text
            }) {
                $0.text = proposal.text
            }
        case .planResolved(let resolution):
            upsert(event, itemID: "plan:\(resolution.planId)", kind: .planProposal, create: {
                $0.planId = resolution.planId
                $0.text = ""
            }) {
                $0.planDecision = resolution.decision
            }

        // Usage and extensions
        case .usageUpdated(let report):
            view.usage.inputTokens += report.usage.inputTokens
            view.usage.outputTokens += report.usage.outputTokens
            view.usage.cacheReadTokens += report.usage.cacheReadTokens ?? 0
            view.usage.cacheWriteTokens += report.usage.cacheWriteTokens ?? 0
            view.usage.reasoningTokens += report.usage.reasoningTokens ?? 0
            view.usage.costMicroUsd += report.usage.costMicroUsd ?? 0
            if let model = report.model { view.usage.model = model }
        case .codePullRequest(let pr):
            view.pullRequest = AgentPullRequestView(
                branch: pr.branch, prUrl: pr.prUrl, prNumber: pr.prNumber, reused: pr.reused
            )
        }
    }

    // MARK: - Helpers

    private static let terminalStates: Set<AgentSessionState> = [.completed, .failed, .interrupted, .cancelled]

    /// The item with this id and kind, created (and placed in its turn) when
    /// it is new, then updated. An id that already names an item of another
    /// kind is replaced in place: the later event is the one that knows what
    /// the item is.
    private mutating func upsert(
        _ event: AgentEvent,
        itemID: String,
        kind: AgentItemView.Kind,
        create: (inout AgentItemView) -> Void = { _ in },
        update: (inout AgentItemView) -> Void
    ) {
        if let index = itemIndex[itemID] {
            if view.items[index].kind != kind {
                var fresh = AgentItemView(itemId: itemID, kind: kind)
                create(&fresh)
                fresh.turnId = view.items[index].turnId
                fresh.agentId = view.items[index].agentId
                view.items[index] = fresh
            }
            update(&view.items[index])
            return
        }
        var fresh = AgentItemView(itemId: itemID, kind: kind)
        create(&fresh)
        let turnID = event.turnId ?? openTurnID
        fresh.turnId = turnID
        fresh.agentId = event.agentId
        itemIndex[itemID] = view.items.count
        view.items.append(fresh)
        if let turnID, let index = turnIndex[turnID] {
            view.turns[index].itemIds.append(itemID)
        }
        update(&view.items[view.items.count - 1])
    }

    private mutating func upsertTool(_ event: AgentEvent, itemID: String, update: (inout AgentItemView) -> Void) {
        upsert(event, itemID: itemID, kind: .tool, create: {
            $0.toolName = ""
            $0.toolKind = .unknown
            $0.title = ""
            $0.toolStatus = .running
        }, update: update)
    }

    private mutating func upsertApproval(_ event: AgentEvent, approvalID: String, update: (inout AgentItemView) -> Void) {
        upsert(event, itemID: "approval:\(approvalID)", kind: .approval, create: {
            $0.approvalId = approvalID
            $0.action = ""
            $0.summary = ""
            $0.risk = .unknown
        }, update: update)
    }

    private mutating func upsertQuestion(_ event: AgentEvent, questionID: String, update: (inout AgentItemView) -> Void) {
        upsert(event, itemID: "question:\(questionID)", kind: .question, create: {
            $0.questionId = questionID
            $0.prompt = ""
            $0.answered = false
        }, update: update)
    }

    private func targetTurnIndex(_ event: AgentEvent) -> Int? {
        guard let turnID = event.turnId ?? openTurnID else { return nil }
        return turnIndex[turnID]
    }

    /// Tool calls in a turn (or anywhere) still running end with an unknown outcome.
    private mutating func settleRunningTools(inTurn turnID: String?) {
        for index in view.items.indices where view.items[index].kind == .tool && view.items[index].toolStatus == .running {
            if let turnID, view.items[index].turnId != turnID { continue }
            view.items[index].toolStatus = .unknown
        }
    }

    /// Ends a turn: its running tools have unknown outcomes and nothing it
    /// asked can still be answered.
    private mutating func closeTurn(at index: Int, status: AgentTurnStatus) {
        view.turns[index].status = status
        settleRunningTools(inTurn: view.turns[index].turnId)
        if openTurnID == view.turns[index].turnId { openTurnID = nil }
        view.pendingApprovalId = nil
        view.pendingQuestionId = nil
    }

    /// After a turn ends, a session that was working is waiting for the reader.
    private mutating func settleAfterTurn() {
        switch view.state {
        case .running, .awaitingApproval, .awaitingInput: view.state = .idle
        default: break
        }
    }

    /// Back to work after a question or an approval if a turn is open, else
    /// back to waiting.
    private mutating func resume() {
        if let open = openTurnID, let index = turnIndex[open], view.turns[index].status == .running {
            view.state = .running
        } else {
            view.state = .idle
        }
    }
}

// MARK: - The view

/// A tool call's status in the view: running until its result, then the
/// result's status.
public enum AgentToolItemStatus: String, Hashable, Sendable, Codable {
    case running
    case ok
    case error
    case denied
    case notExecuted = "not_executed"
    case unknown

    init(_ status: AgentToolResultStatus) {
        self = Self(rawValue: status.rawValue) ?? .unknown
    }
}

public enum AgentTurnStatus: String, Hashable, Sendable, Codable {
    case running
    case completed
    case failed
    case interrupted
}

public struct AgentTurnView: Hashable, Sendable, Encodable {
    public var turnId: String
    public var origin: AgentTurnOrigin
    public var status: AgentTurnStatus = .running
    public var stopReason: AgentStopReason?
    public var durationMs: Int?
    public var filesChanged: Int?
    public var summary: String?
    public var error: AgentErrorInfo?
    public var itemIds: [String] = []

    public init(turnId: String, origin: AgentTurnOrigin) {
        self.turnId = turnId
        self.origin = origin
    }
}

/// One item of the transcript. A single shape with a `kind`, rather than an
/// enum with a payload per kind, so the reducer can update any of it in place;
/// the fields a kind does not use stay nil and are not encoded, which is what
/// keeps its JSON identical to the TypeScript view's.
public struct AgentItemView: Hashable, Sendable, Encodable {
    public enum Kind: String, Hashable, Sendable, Codable {
        case userMessage = "user_message"
        case assistantText = "assistant_text"
        case thinking
        case tool
        case fileChange = "file_change"
        case testRun = "test_run"
        case subagent
        case compaction
        case notice
        case approval
        case question
        case planProposal = "plan_proposal"
        case error
    }

    public var itemId: String
    public var kind: Kind
    public var turnId: String?
    public var agentId: String?

    // Text-bearing kinds: user_message, assistant_text, thinking, notice, plan_proposal.
    public var text: String?
    public var delivery: AgentUserDelivery?
    public var commandId: String?

    // tool
    public var toolName: String?
    public var toolKind: AgentToolKind?
    public var title: String?
    public var inputSummary: String?
    public var risk: AgentRisk?
    public var toolStatus: AgentToolItemStatus?
    public var summary: String?
    public var exitCode: Int?
    public var durationMs: Int?
    public var output: String?
    public var outputChannel: AgentOutputChannel?

    // file_change
    public var path: String?
    public var change: AgentFileChangeKind?
    public var linesAdded: Int?
    public var linesRemoved: Int?
    public var patch: String?
    public var checkpointId: String?
    public var toolItemId: String?

    // test_run
    public var command: String?
    public var passed: Bool?
    public var testsRun: Int?
    public var failures: Int?

    // subagent
    public var subagentStatus: AgentSubagentStatus?
    public var role: String?
    public var activity: String?
    public var errorText: String?
    public var usage: AgentUsage?

    // compaction
    public var compactionSource: AgentCompactionSource?
    public var beforeMessages: Int?
    public var afterMessages: Int?
    public var requestedByUser: Bool?

    // notice
    public var noticeSource: AgentNoticeSource?
    public var detail: String?

    // approval
    public var approvalId: String?
    public var action: String?
    public var digest: String?
    public var expiresAt: String?
    public var suggestedRule: String?
    public var decision: AgentApprovalDecision?
    public var by: AgentApprovalResolver?
    public var feedback: String?

    // question
    public var questionId: String?
    public var prompt: String?
    public var options: [AgentQuestionOption]?
    public var multiSelect: Bool?
    public var answered: Bool?
    public var answer: String?
    public var selected: [String]?

    // plan_proposal
    public var planId: String?
    public var planDecision: AgentPlanDecision?

    // error
    public var errorInfo: AgentErrorInfo?

    public init(itemId: String, kind: Kind) {
        self.itemId = itemId
        self.kind = kind
    }

    private struct Key: CodingKey {
        var stringValue: String
        var intValue: Int? { nil }
        init(_ string: String) { stringValue = string }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { nil }
    }

    /// The keys are the TypeScript view's. Three JSON keys are shared by
    /// fields of different types — `status` (a tool's or a sub-agent's),
    /// `source` (a compaction's or a notice's), `error` (a sub-agent's message
    /// or an error item's info) and `decision` (an approval's or a plan's) —
    /// and each kind sets only one of each pair.
    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: Key.self)
        func put<T: Encodable>(_ value: T?, _ key: String) throws {
            if let value { try container.encode(value, forKey: Key(key)) }
        }
        try put(itemId, "itemId")
        try put(kind, "kind")
        try put(turnId, "turnId")
        try put(agentId, "agentId")
        try put(text, "text")
        try put(delivery, "delivery")
        try put(commandId, "commandId")
        try put(toolName, "toolName")
        try put(toolKind, "toolKind")
        try put(title, "title")
        try put(inputSummary, "inputSummary")
        try put(risk, "risk")
        try put(toolStatus, "status")
        try put(subagentStatus, "status")
        try put(summary, "summary")
        try put(exitCode, "exitCode")
        try put(durationMs, "durationMs")
        try put(output, "output")
        try put(outputChannel, "outputChannel")
        try put(path, "path")
        try put(change, "change")
        try put(linesAdded, "linesAdded")
        try put(linesRemoved, "linesRemoved")
        try put(patch, "patch")
        try put(checkpointId, "checkpointId")
        try put(toolItemId, "toolItemId")
        try put(command, "command")
        try put(passed, "passed")
        try put(testsRun, "testsRun")
        try put(failures, "failures")
        try put(role, "role")
        try put(activity, "activity")
        try put(errorText, "error")
        try put(errorInfo, "error")
        try put(usage, "usage")
        try put(compactionSource, "source")
        try put(noticeSource, "source")
        try put(beforeMessages, "beforeMessages")
        try put(afterMessages, "afterMessages")
        try put(requestedByUser, "requestedByUser")
        try put(detail, "detail")
        try put(approvalId, "approvalId")
        try put(action, "action")
        try put(digest, "digest")
        try put(expiresAt, "expiresAt")
        try put(suggestedRule, "suggestedRule")
        try put(decision, "decision")
        try put(planDecision, "decision")
        try put(by, "by")
        try put(feedback, "feedback")
        try put(questionId, "questionId")
        try put(prompt, "prompt")
        try put(options, "options")
        try put(multiSelect, "multiSelect")
        try put(answered, "answered")
        try put(answer, "answer")
        try put(selected, "selected")
        try put(planId, "planId")
    }
}

public struct AgentPlanView: Hashable, Sendable, Encodable {
    public var steps: [AgentPlanStep]
    public var objective: String?
}

public struct AgentPullRequestView: Hashable, Sendable, Encodable {
    public var branch: String
    public var prUrl: String?
    public var prNumber: Int?
    public var reused: Bool?
}

public struct AgentUsageTotals: Hashable, Sendable, Encodable {
    public var inputTokens = 0
    public var outputTokens = 0
    public var cacheReadTokens = 0
    public var cacheWriteTokens = 0
    public var reasoningTokens = 0
    public var costMicroUsd = 0
    /// The model the last usage report named.
    public var model: String?
}

/// A session as every Juno surface shows it.
public struct AgentSessionView: Hashable, Sendable, Encodable {
    public var sessionId: String?
    public var state: AgentSessionState = .idle
    public var target: AgentSessionTarget?
    public var workspaceName: String?
    public var repository: AgentRepositoryRef?
    public var model: String?
    public var effort: AgentReasoningEffort?
    public var mode: AgentPermissionMode?
    public var title: String?
    public var turns: [AgentTurnView] = []
    public var items: [AgentItemView] = []
    /// The approval a reader can answer now.
    public var pendingApprovalId: String?
    /// The question a reader can answer now.
    public var pendingQuestionId: String?
    public var plan: AgentPlanView?
    public var usage = AgentUsageTotals()
    public var pullRequest: AgentPullRequestView?
    public var lastError: AgentErrorInfo?
    /// The highest `seq` applied.
    public var lastSeq = 0
    /// Events applied, duplicates excluded, unknown types included.
    public var eventCount = 0
    /// Events of a type this build does not know.
    public var unknownEventCount = 0

    public init() {}

    /// The item with an id.
    public func item(_ itemID: String) -> AgentItemView? {
        items.first { $0.itemId == itemID }
    }

    /// The approval a reader can answer now, if any.
    public var pendingApproval: AgentItemView? {
        pendingApprovalId.flatMap { item("approval:\($0)") }
    }

    /// The question a reader can answer now, if any.
    public var pendingQuestion: AgentItemView? {
        pendingQuestionId.flatMap { item("question:\($0)") }
    }
}

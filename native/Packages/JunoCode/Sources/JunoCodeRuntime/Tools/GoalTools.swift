import Foundation
import JunoCodeCore

/// The goal tools: `get_goal`, `propose_goal` and `update_goal` (§2.5),
/// which replace `UpdateGoalTool` for Code sessions.
///
/// Owned by Lane A (loop, stop check and goal). All three are `.read`: they
/// change session state, not the workspace, so they never prompt. None of
/// them can complete or start a goal. A goal starts only when the reader
/// presses Start, and it is met only when the stop check and the judge say
/// so; `claim_achieved` merely asks for that check.
public struct GoalToolProvider: CodeToolProvider {
    public init() {}

    public func tools(for context: CodeToolProviderContext) async -> [any CodeTool] {
        [
            GetGoalTool(store: context.store),
            ProposeGoalTool(store: context.store),
            GoalUpdateTool(store: context.store),
        ]
    }
}

/// The goal as the model reads it in `<goal>`: objective, criteria with how
/// each is checked and what evidence it has, constraints, budget, last check.
public enum GoalText {
    public static func section(_ goal: GoalRun?) -> String {
        guard let goal, goal.status != .cleared else {
            return """
                No goal is set. When the reader asks for something that will take many turns, you \
                may suggest one with propose_goal; it starts only when they press Start.
                """
        }
        var lines = ["Objective: \(goal.objective)", "Criteria:"]
        let lastUnmet = Set(goal.lastVerdict?.unmetCriteria ?? [])
        for criterion in goal.criteria {
            var line = "  \(criterion.id) [\(criterion.checkTag)] \(criterion.text)"
            if lastUnmet.contains(criterion.id) {
                line += " — not met at the last check"
            } else if !criterion.evidence.isEmpty {
                line += " — evidence cited: \(criterion.evidence.suffix(3).joined(separator: ", "))"
            }
            lines.append(line)
        }
        if !goal.constraints.isEmpty {
            lines.append("Constraints: " + goal.constraints.joined(separator: "; "))
        }
        if let budget = budgetLine(goal) {
            lines.append("Budget: \(budget).")
        }
        if let verdict = goal.lastVerdict {
            // A judge's reason is another model's reading of the transcript:
            // quoted, so the goal section never speaks it in Juno's voice.
            lines.append("Last check: \(verdictWords(verdict.kind))"
                + (verdict.reason.isEmpty ? "." : " — \(RuntimeContinuation.quoted(verdict.reason, limit: GoalVerdictEvent.maximumReasonCharacters))"))
        }
        switch goal.status {
        case .active:
            lines.append("Work toward this goal. Juno checks it each time you finish; finishing does not complete it.")
        case .paused:
            lines.append("This goal is paused. Do not work toward it unless the reader asks.")
        case .needsYou:
            lines.append("This goal is waiting on the reader: \(goal.statusReason ?? "they need to decide something").")
        case .budgetReached:
            lines.append("This goal has used its budget. Do not continue it unless the reader asks.")
        case .achieved:
            lines.append("This goal is met. Its record stays as it is.")
        case .impossible:
            lines.append("This goal was judged impossible: \(goal.statusReason.map { RuntimeContinuation.quoted($0, limit: 300) } ?? "no reason given").")
        case .cleared:
            break
        }
        return lines.joined(separator: "\n")
    }

    /// The `<goal>` section's fingerprint: what the goal *says*, not how much
    /// of the budget it has used, so the section is re-sent when the goal or
    /// its last check changes rather than on every turn.
    public static func fingerprint(_ goal: GoalRun?) -> String {
        guard let goal, goal.status != .cleared else { return "none" }
        let criteria = goal.criteria.map { "\($0.id)|\($0.text)|\($0.checkTag)|\($0.evidence.count)" }
        return [
            goal.id, goal.objective, goal.status.rawValue, goal.statusReason ?? "",
            criteria.joined(separator: ";"), goal.constraints.joined(separator: ";"),
            goal.budget.sentence ?? "unlimited",
            goal.lastVerdict.map { "\($0.kind.rawValue)|\($0.reason)|\($0.at.timeIntervalSince1970)" } ?? "",
        ].joined(separator: "\u{1F}")
    }

    /// "38 of 240 minutes, 7 of 60 turns, $1.12 of $20".
    public static func budgetLine(_ goal: GoalRun) -> String? {
        var parts: [String] = []
        if let minutes = goal.budget.minutes {
            parts.append("\(Int(goal.usage.minutes.rounded())) of \(minutes) minutes")
        }
        if let turns = goal.budget.turns {
            parts.append("\(goal.usage.turns) of \(turns) turns")
        }
        if let tokens = goal.budget.tokens {
            parts.append("\((goal.usage.tokens ?? 0).formatted()) of \(tokens.formatted()) tokens")
        }
        if let cost = goal.budget.costUSD {
            parts.append("\(Budget.dollars(goal.usage.costUSD ?? 0)) of \(Budget.dollars(cost))")
        }
        return parts.isEmpty ? nil : parts.joined(separator: ", ")
    }

    static func verdictWords(_ kind: GoalVerdictKind) -> String {
        switch kind {
        case .met: "met"
        case .notMet: "not met"
        case .gateBlocked: "not yet, evidence missing"
        case .impossible: "judged impossible"
        }
    }
}

/// `get_goal`: the session's goal, criteria and evidence.
public struct GetGoalTool: CodeTool {
    private let store: CodeSessionStore

    public init(store: CodeSessionStore) {
        self.store = store
    }

    public let name = "get_goal"
    public let description = """
        Read the session's goal: its objective, criteria and how each is checked, the evidence \
        cited for them, constraints, budget and the last check. The <goal> section of the \
        session state carries the same, as of when it was sent.
        """
    public var inputSchema: JSONValue {
        ["type": "object", "properties": [:]]
    }

    public func assessRisk(input _: JSONValue) -> ActionRisk { .read }
    public func summary(input _: JSONValue) -> String { "Read the goal" }

    public func execute(input _: JSONValue, context: ToolContext) async throws -> ToolResult {
        let goal = await store.currentGoalRun(for: context.sessionID)
        return ToolResult(content: GoalText.section(goal))
    }
}

/// `propose_goal`: suggests a goal. Nothing starts until the reader presses
/// Start on the card it shows.
public struct ProposeGoalTool: CodeTool {
    private let store: CodeSessionStore

    public init(store: CodeSessionStore) {
        self.store = store
    }

    public let name = "propose_goal"
    public let description = """
        Suggest a goal to the reader when their request will take many turns: an objective and \
        up to 8 checkable criteria. Juno shows it as a card with Start; nothing starts, and \
        nothing about permissions changes, until the reader presses Start.
        """
    public var inputSchema: JSONValue {
        [
            "type": "object",
            "properties": [
                "objective": ["type": "string", "maxLength": .number(Double(GoalRun.maximumObjectiveCharacters))],
                "criteria": [
                    "type": "array",
                    "items": ["type": "string"],
                    "maxItems": .number(Double(GoalRun.maximumCriteria)),
                ],
            ],
            "required": ["objective"],
        ]
    }

    public func assessRisk(input _: JSONValue) -> ActionRisk { .read }
    public func summary(input _: JSONValue) -> String { "Suggest a goal" }

    public func precheck(input: JSONValue) -> ToolError? {
        guard let objective = input["objective"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines),
              !objective.isEmpty
        else {
            return .invalidInput(message: "objective is required.")
        }
        return nil
    }

    public func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        let objective = input["objective"]?.stringValue ?? ""
        let texts = (input["criteria"]?.arrayValue ?? [])
            .compactMap { $0.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .prefix(GoalRun.maximumCriteria)
        let criteria = texts.enumerated().map {
            GoalCriterion(id: "c\($0.offset + 1)", text: String($0.element.prefix(300)))
        }
        let proposal = GoalRun(
            objective: objective,
            criteria: criteria,
            status: .paused,
            statusReason: "Proposed; waiting for the reader to press Start",
            origin: .proposedByModel
        )
        try await store.proposeGoal(proposal, for: context.sessionID)
        return ToolResult(content: "Proposed the goal. The reader sees it as a card; it starts only when they press Start, so carry on with the request as asked.")
    }
}

/// `update_goal`: cite evidence for a criterion, say the goal is blocked, or
/// ask Juno to check it now.
public struct GoalUpdateTool: CodeTool {
    private enum Action: String {
        case citeEvidence = "cite_evidence"
        case blocked
        case claimAchieved = "claim_achieved"
    }

    private let store: CodeSessionStore

    public init(store: CodeSessionStore) {
        self.store = store
    }

    public let name = "update_goal"
    public let description = """
        Work with the active goal. cite_evidence attaches evidence to a criterion: a ledger id \
        from a check Juno recorded, or path:line for a judged criterion. blocked says the goal \
        cannot be met and why; the run ends and the reader is told. claim_achieved asks Juno to \
        check the goal now; it does not complete anything, so end your turn with your report \
        after calling it. You cannot complete, start or change a goal yourself.
        """
    public var inputSchema: JSONValue {
        [
            "type": "object",
            "properties": [
                "action": ["type": "string", "enum": ["cite_evidence", "blocked", "claim_achieved"]],
                "criterion": ["type": "string"],
                "evidence": ["type": "string", "description": "A ledger id, or path:line for judged criteria."],
                "reason": ["type": "string", "maxLength": 600],
            ],
            "required": ["action"],
        ]
    }

    public func assessRisk(input _: JSONValue) -> ActionRisk { .read }

    public func summary(input: JSONValue) -> String {
        switch Action(rawValue: input["action"]?.stringValue ?? "") {
        case .citeEvidence: "Cite evidence for \(input["criterion"]?.stringValue ?? "a criterion")"
        case .blocked: "Say the goal is blocked"
        case .claimAchieved: "Ask Juno to check the goal"
        case nil: "Update the goal"
        }
    }

    public func precheck(input: JSONValue) -> ToolError? {
        guard let action = Action(rawValue: input["action"]?.stringValue ?? "") else {
            return .invalidInput(message: "action must be cite_evidence, blocked or claim_achieved.")
        }
        switch action {
        case .citeEvidence:
            guard Self.text(input["criterion"]) != nil, Self.text(input["evidence"]) != nil else {
                return .invalidInput(message: "cite_evidence needs criterion and evidence.")
            }
        case .blocked:
            guard Self.text(input["reason"]) != nil else {
                return .invalidInput(message: "blocked needs a reason.")
            }
        case .claimAchieved:
            break
        }
        return nil
    }

    public func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        guard let action = Action(rawValue: input["action"]?.stringValue ?? "") else {
            throw ToolError.invalidInput(message: "Unknown action.")
        }
        guard let goal = await store.currentGoalRun(for: context.sessionID), goal.isActive else {
            return ToolResult(content: "There is no active goal. Carry on with the request as asked.", isError: true)
        }
        switch action {
        case .citeEvidence:
            let criterionID = Self.text(input["criterion"]) ?? ""
            let evidence = String((Self.text(input["evidence"]) ?? "").prefix(300))
            guard goal.criterion(criterionID) != nil else {
                return ToolResult(
                    content: "No criterion \(criterionID). The goal's criteria are \(goal.criteria.map(\.id).joined(separator: ", ")).",
                    isError: true
                )
            }
            try await store.updateCurrentGoal(for: context.sessionID, record: .silent) { current in
                guard let index = current.criteria.firstIndex(where: { $0.id == criterionID }) else { return }
                if !current.criteria[index].evidence.contains(evidence) {
                    current.criteria[index].evidence.append(evidence)
                }
            }
            return ToolResult(content: "Cited \(evidence) for \(criterionID). Juno still checks the goal itself when you finish.")
        case .blocked:
            let reason = String((Self.text(input["reason"]) ?? "").prefix(600))
            // Recorded as this call's side effect, which is also how the
            // loop knows the run ends blocked.
            let updated = try await store.updateCurrentGoal(for: context.sessionID, record: .silent) { current in
                try current.transition(to: .needsYou, reason: "Blocked: \(reason)")
            }
            return ToolResult(
                content: "The goal is marked blocked and the reader will be told. Stop here.",
                sideEffects: updated.map { [.goalStatus($0.statusEvent)] } ?? [],
                endsRun: "Blocked: \(reason)"
            )
        case .claimAchieved:
            return ToolResult(content: "Juno will check the goal against its criteria when you end this turn. End it now with your report.")
        }
    }

    private static func text(_ value: JSONValue?) -> String? {
        guard let text = value?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else {
            return nil
        }
        return text
    }
}

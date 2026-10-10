import Foundation

/// One turn of a thread: what the user asked, the work log, and the answer
/// (DESIGN §5.1, §5.4).
public struct CodeV2Turn: Identifiable, Equatable, Sendable {
    public var id: String
    public var ordinal: Int
    /// The message that opened the turn, plus any steered into it.
    public var userMessages: [CodeV2.UserMessage]
    /// Everything the agents did, in order: the "work log" that folds.
    public var steps: [CodeV2.TurnItem]
    /// The assistant's last message in the turn. Never folded away.
    public var answer: CodeV2.AssistantMessage?
    /// Subagent fan-outs, rendered as one agent tree per turn.
    public var subagents: [CodeV2.Subagent]
    /// Computer-use frames, rendered as one filmstrip per turn.
    public var computerActions: [CodeV2.ComputerAction]
    /// The checkpoint the turn ended on, if any.
    public var checkpoint: CodeV2.Checkpoint?
    public var isRunning: Bool
    public var startedAt: Date?
    public var endedAt: Date?

    /// "Worked for 4m 12s"; nil while running or for a turn without timing.
    public var durationSeconds: Int? {
        guard !isRunning, let startedAt, let endedAt else { return nil }
        return max(0, Int(endedAt.timeIntervalSince(startedAt).rounded()))
    }

    /// A turn with an error or an unresolved request cannot fold (§5.4), nor
    /// can one still running.
    public var canFold: Bool {
        guard !isRunning, !steps.isEmpty else { return false }
        return !steps.contains { item in
            switch item {
            case .error: true
            case let .approvalRequest(request): request.status == .pending
            case let .userInputRequest(request): request.status == .pending
            default: false
            }
        }
    }

    /// The files changed in this turn, merged by path, for the receipt.
    public var changedFiles: [CodeV2.FileChangeEntry] {
        var order: [String] = []
        var merged: [String: CodeV2.FileChangeEntry] = [:]
        for case let .fileChange(change) in steps where change.status != .declined && change.status != .failed {
            for entry in change.changes {
                if var existing = merged[entry.path] {
                    existing.additions = (existing.additions ?? 0) + (entry.additions ?? 0)
                    existing.deletions = (existing.deletions ?? 0) + (entry.deletions ?? 0)
                    if let diff = entry.diff { existing.diff = [existing.diff, diff].compactMap { $0 }.joined(separator: "\n") }
                    merged[entry.path] = existing
                } else {
                    order.append(entry.path)
                    merged[entry.path] = entry
                }
            }
        }
        return order.compactMap { merged[$0] }
    }

    public var additions: Int { changedFiles.reduce(0) { $0 + ($1.additions ?? 0) } }
    public var deletions: Int { changedFiles.reduce(0) { $0 + ($1.deletions ?? 0) } }
}

public enum CodeV2TurnFolding {
    /// Groups a flat item list into turns. A turn opens at each user message
    /// that was sent (not steered), and every later item belongs to it until
    /// the next one. Items carrying a `turnId` that names an earlier turn stay
    /// with that turn.
    public static func turns(from items: [CodeV2.TurnItem], activeTurnId: String? = nil) -> [CodeV2Turn] {
        var turns: [CodeV2Turn] = []
        var indexByTurnId: [String: Int] = [:]

        func open(id: String, message: CodeV2.UserMessage?, at date: Date?) {
            turns.append(CodeV2Turn(
                id: id, ordinal: turns.count + 1, userMessages: message.map { [$0] } ?? [],
                steps: [], answer: nil, subagents: [], computerActions: [], checkpoint: nil,
                isRunning: false, startedAt: date, endedAt: date
            ))
        }

        for item in items {
            let date = item.createdDate
            if case let .userMessage(message) = item {
                if message.delivery == .steer, !turns.isEmpty {
                    turns[turns.count - 1].userMessages.append(message)
                    continue
                }
                let id = message.turnId ?? message.id
                open(id: id, message: message, at: date)
                indexByTurnId[id] = turns.count - 1
                continue
            }
            var target = turns.count - 1
            if let turnId = item.turnId, let known = indexByTurnId[turnId] {
                target = known
            } else if let turnId = item.turnId, target < 0 || (turns[target].userMessages.isEmpty && turns[target].id != turnId) {
                open(id: turnId, message: nil, at: date)
                target = turns.count - 1
                indexByTurnId[turnId] = target
            } else if target < 0 {
                open(id: item.turnId ?? "turn-0", message: nil, at: date)
                target = 0
            }
            if let turnId = item.turnId, indexByTurnId[turnId] == nil { indexByTurnId[turnId] = target }

            switch item {
            case let .assistantMessage(message) where message.agentId == nil:
                // The latest top-level message is the answer; an earlier one
                // becomes part of the work log (narration between tool calls).
                if let previous = turns[target].answer {
                    turns[target].steps.append(.assistantMessage(previous))
                }
                turns[target].answer = message
            case let .assistantMessage(message) where message.agentId != nil:
                // A child's own narration belongs to the agent tree, not the
                // lead's work log.
                break
            case let .subagent(child):
                if let index = turns[target].subagents.firstIndex(where: { $0.agentId == child.agentId }) {
                    turns[target].subagents[index] = child
                } else {
                    turns[target].subagents.append(child)
                }
            case let .computerAction(action):
                turns[target].computerActions.append(action)
            case let .checkpoint(checkpoint):
                turns[target].checkpoint = checkpoint
            default:
                turns[target].steps.append(item)
            }
            if let date {
                if turns[target].startedAt == nil { turns[target].startedAt = date }
                if let end = turns[target].endedAt { turns[target].endedAt = max(end, date) } else { turns[target].endedAt = date }
            }
        }

        if let activeTurnId, let index = indexByTurnId[activeTurnId] {
            turns[index].isRunning = true
        } else if activeTurnId != nil, !turns.isEmpty {
            turns[turns.count - 1].isRunning = true
        }
        return turns
    }

    /// Approvals and questions still waiting for the user, oldest first.
    public static func pendingRequests(in items: [CodeV2.TurnItem]) -> [CodeV2.TurnItem] {
        items.filter { item in
            switch item {
            case let .approvalRequest(request): request.status == .pending
            case let .userInputRequest(request): request.status == .pending
            default: false
            }
        }
    }

    /// The live todo list (latest), for the one-line pin above the composer.
    public static func liveTodos(in items: [CodeV2.TurnItem]) -> CodeV2.TodoList? {
        for item in items.reversed() {
            if case let .todoList(list) = item { return list }
        }
        return nil
    }

    /// "Worked for 4m 12s" / "Worked for 38s".
    public static func durationLabel(seconds: Int) -> String {
        "Worked for " + CodeV2Formatting.duration(seconds: seconds)
    }
}

// MARK: - Step rows

/// What one step row prints (DESIGN §5.1): a glyph, a verb in full ink, an
/// object in mono, and a right-aligned count or elapsed time.
public struct CodeV2StepRow: Equatable, Sendable, Identifiable {
    public enum Glyph: String, Equatable, Sendable {
        case reasoning, plan, edit, terminal, search, web, approval, interrupt, notice, error
        case compaction, handoff, question, file, message
    }

    public enum State: Equatable, Sendable { case done, running, failed, waiting }

    public var id: String
    public var glyph: Glyph
    public var verb: String
    public var object: String?
    /// Plain words after the object ("11 results", "and 5 more").
    public var detail: String?
    public var additions: Int?
    public var deletions: Int?
    public var trailing: String?
    public var state: State
    /// Up to three output lines under a command row.
    public var outputTail: [String]
    /// The verb reads in the destructive ink ("Failed (exit 1)").
    public var isFailure: Bool { state == .failed }

    /// - Parameter nextDate: when the item after this one began, which is when
    ///   a reasoning block ended ("Thought for 14s").
    public static func make(_ item: CodeV2.TurnItem, nextDate: Date? = nil, now: Date = Date()) -> CodeV2StepRow? {
        switch item {
        case let .reasoning(reasoning):
            let seconds: Int? = {
                guard !reasoning.streaming, let start = item.createdDate, let end = nextDate else { return nil }
                return max(1, Int(end.timeIntervalSince(start).rounded()))
            }()
            return CodeV2StepRow(
                id: reasoning.id, glyph: .reasoning,
                verb: reasoning.streaming ? "Thinking" : (seconds.map { "Thought for \(CodeV2Formatting.duration(seconds: $0))" } ?? "Thought"),
                object: nil, detail: nil, trailing: nil,
                state: reasoning.streaming ? .running : .done, outputTail: []
            )
        case let .plan(plan):
            let count = plan.steps?.count ?? 0
            return CodeV2StepRow(
                id: plan.id, glyph: .plan, verb: plan.awaitingApproval == true ? "Proposed a plan" : "Planned",
                object: nil, detail: count > 0 ? "\(count) \(count == 1 ? "task" : "tasks")" : nil,
                trailing: nil, state: plan.awaitingApproval == true ? .waiting : .done, outputTail: []
            )
        case let .todoList(list):
            let done = list.todos.filter { $0.status == .completed }.count
            return CodeV2StepRow(
                id: list.id, glyph: .plan, verb: "Updated the plan", object: nil,
                detail: "\(done) of \(list.todos.count) done", trailing: nil,
                state: done == list.todos.count ? .done : .running, outputTail: []
            )
        case let .fileChange(change):
            let first = change.changes.first
            let more = change.changes.count - 1
            let verb: String
            switch (change.status, first?.change) {
            case (.running, _), (.pending, _): verb = "Editing"
            case (.declined, _): verb = "Declined edit to"
            case (.failed, _): verb = "Could not edit"
            case (_, .add): verb = "Created"
            case (_, .delete): verb = "Deleted"
            case (_, .rename): verb = "Renamed"
            default: verb = "Edited"
            }
            return CodeV2StepRow(
                id: change.id, glyph: .edit, verb: verb, object: first?.path,
                detail: more > 0 ? "and \(more) more" : nil,
                additions: change.changes.reduce(0) { $0 + ($1.additions ?? 0) },
                deletions: change.changes.reduce(0) { $0 + ($1.deletions ?? 0) },
                trailing: nil, state: rowState(change.status), outputTail: []
            )
        case let .commandExecution(command):
            let state = rowState(command.status, exitCode: command.exitCode)
            var verb = state == .running ? "Running" : "Ran"
            if state == .failed { verb = command.exitCode.map { "Failed (exit \($0))" } ?? "Failed" }
            if command.status == .declined { verb = "Declined" }
            let elapsed: String? = {
                if let ms = command.durationMs { return CodeV2Formatting.duration(seconds: ms / 1000) }
                if state == .running, let start = item.createdDate {
                    return CodeV2Formatting.clock(seconds: Int(now.timeIntervalSince(start)))
                }
                return nil
            }()
            return CodeV2StepRow(
                id: command.id, glyph: .terminal, verb: verb, object: command.command, detail: nil,
                trailing: elapsed, state: state,
                outputTail: CodeV2Formatting.tail(command.output, lines: 3)
            )
        case let .search(search):
            return CodeV2StepRow(
                id: search.id, glyph: .search, verb: search.status == .running ? "Searching" : "Searched",
                object: search.query, detail: search.matches.map { "\($0) \($0 == 1 ? "result" : "results")" },
                trailing: nil, state: rowState(search.status), outputTail: []
            )
        case let .webSearch(search):
            return CodeV2StepRow(
                id: search.id, glyph: .web, verb: search.status == .running ? "Searching the web" : "Searched the web",
                object: search.query, detail: search.results.map { "\($0.count) results" },
                trailing: nil, state: rowState(search.status), outputTail: []
            )
        case let .approvalRequest(request):
            guard request.status != .pending else { return nil }
            let verb: String
            switch request.decision {
            case .accept: verb = "Allowed once"
            case .acceptForSession: verb = "Allowed for this session"
            case .decline, .cancel: verb = "Denied"
            case nil: verb = request.status == .expired ? "Approval expired" : "Resolved"
            }
            return CodeV2StepRow(
                id: request.id, glyph: .approval, verb: verb, object: request.detail ?? request.summary,
                detail: nil, trailing: nil, state: .done, outputTail: []
            )
        case let .userInputRequest(request):
            guard request.status != .pending else { return nil }
            return CodeV2StepRow(
                id: request.id, glyph: .question,
                verb: request.status == .answered ? "Answered" : "Skipped a question",
                object: nil, detail: request.questions.first?.prompt, trailing: nil, state: .done, outputTail: []
            )
        case let .interrupt(interrupt):
            let verb: String
            switch interrupt.reason {
            case .user: verb = "Stopped by you"
            case .limit: verb = "Paused: plan limit"
            case .budget: verb = "Stopped at the run budget"
            case .error: verb = "Stopped after an error"
            }
            return CodeV2StepRow(
                id: interrupt.id, glyph: .interrupt, verb: verb, object: nil, detail: interrupt.message,
                trailing: nil, state: .done, outputTail: []
            )
        case let .handoff(handoff):
            return CodeV2StepRow(
                id: handoff.id, glyph: .handoff, verb: "Handed off to", object: nil,
                detail: CodeV2Formatting.modelName(handoff.to.model), trailing: nil, state: .done, outputTail: []
            )
        case let .assistantMessage(message):
            // Narration between tool calls, folded into the log as one line.
            let line = message.text.split(separator: "\n").first.map(String.init) ?? message.text
            return CodeV2StepRow(
                id: message.id, glyph: .message, verb: line, object: nil, detail: nil, trailing: nil,
                state: message.streaming ? .running : .done, outputTail: []
            )
        default:
            return nil
        }
    }

    static func rowState(_ status: CodeV2.ItemStatus, exitCode: Int? = nil) -> State {
        switch status {
        case .pending, .running: .running
        case .failed: .failed
        case .completed: (exitCode ?? 0) == 0 ? .done : .failed
        case .declined, .interrupted: .done
        }
    }

    public init(
        id: String, glyph: Glyph, verb: String, object: String?, detail: String?,
        additions: Int? = nil, deletions: Int? = nil, trailing: String?, state: State, outputTail: [String]
    ) {
        self.id = id
        self.glyph = glyph
        self.verb = verb
        self.object = object
        self.detail = detail
        self.additions = additions
        self.deletions = deletions
        self.trailing = trailing
        self.state = state
        self.outputTail = outputTail
    }
}

// MARK: - Formatting

public enum CodeV2Formatting {
    /// "2m 41s", "38s", "1h 4m".
    public static func duration(seconds: Int) -> String {
        let s = max(0, seconds)
        if s < 60 { return "\(s)s" }
        if s < 3600 {
            let rest = s % 60
            return rest == 0 ? "\(s / 60)m" : "\(s / 60)m " + String(format: "%02d", rest) + "s"
        }
        return "\(s / 3600)h \((s % 3600) / 60)m"
    }

    /// A ticking clock: "0:41", "12:03".
    public static func clock(seconds: Int) -> String {
        let s = max(0, seconds)
        return "\(s / 60):" + String(format: "%02d", s % 60)
    }

    /// The last `lines` non-empty lines of an output.
    public static func tail(_ output: String?, lines: Int) -> [String] {
        guard let output, !output.isEmpty else { return [] }
        let all = output.split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
        return Array(all.suffix(lines))
    }

    /// "claude-opus-5-5" → "Claude Opus 5.5", "anthropic:claude-sonnet-5-5" →
    /// "Claude Sonnet 5.5", "gpt-6.1-sol" → "GPT-6.1 Sol". A fallback for ids
    /// the catalogue did not label.
    public static func modelName(_ id: String) -> String {
        let bare = id.split(separator: ":").last.map(String.init) ?? id
        var words: [String] = []
        let parts = bare.split(separator: "-").map(String.init)
        var index = 0
        while index < parts.count {
            let part = parts[index]
            if let number = Int(part), index + 1 < parts.count, Int(parts[index + 1]) != nil,
               let last = words.last, Int(last) == nil, !last.contains(".") {
                words.append("\(number).\(parts[index + 1])")
                index += 2
                continue
            }
            if part.lowercased().hasPrefix("gpt") {
                words.append(part.uppercased())
            } else if part.first?.isNumber == true {
                words.append(part)
            } else {
                words.append(part.prefix(1).uppercased() + part.dropFirst())
            }
            index += 1
        }
        // GPT joins its version with a hyphen ("GPT-6.1").
        if words.first == "GPT", words.count > 1 {
            words[0] = "GPT-" + words[1]
            words.remove(at: 1)
        }
        return words.joined(separator: " ")
    }

    /// "16:40" from an ISO timestamp, in the user's time zone.
    public static func clockTime(iso: String, timeZone: TimeZone = .current) -> String? {
        guard let date = CodeV2Dates.parse(iso) else { return nil }
        let formatter = DateFormatter()
        formatter.timeZone = timeZone
        formatter.locale = Locale(identifier: "en_GB")
        formatter.dateFormat = "HH:mm"
        return formatter.string(from: date)
    }
}

public enum CodeV2Dates {
    public static func parse(_ iso: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: iso) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: iso)
    }

    public static func string(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
}

public extension CodeV2.TurnItem {
    var createdAt: String? {
        switch self {
        case let .userMessage(v): v.createdAt
        case let .assistantMessage(v): v.createdAt
        case let .reasoning(v): v.createdAt
        case let .plan(v): v.createdAt
        case let .todoList(v): v.createdAt
        case let .userInputRequest(v): v.createdAt
        case let .fileChange(v): v.createdAt
        case let .commandExecution(v): v.createdAt
        case let .search(v): v.createdAt
        case let .webSearch(v): v.createdAt
        case let .approvalRequest(v): v.createdAt
        case let .checkpoint(v): v.createdAt
        case let .interrupt(v): v.createdAt
        case let .systemNotice(v): v.createdAt
        case let .error(v): v.createdAt
        case let .compaction(v): v.createdAt
        case let .handoff(v): v.createdAt
        case let .subagent(v): v.createdAt
        case let .computerAction(v): v.createdAt
        case let .conversationMessage(v): v.createdAt
        case .unknown: nil
        }
    }

    var createdDate: Date? { createdAt.flatMap(CodeV2Dates.parse) }

    var turnId: String? {
        switch self {
        case let .userMessage(v): v.turnId
        case let .assistantMessage(v): v.turnId
        case let .reasoning(v): v.turnId
        case let .plan(v): v.turnId
        case let .todoList(v): v.turnId
        case let .userInputRequest(v): v.turnId
        case let .fileChange(v): v.turnId
        case let .commandExecution(v): v.turnId
        case let .search(v): v.turnId
        case let .webSearch(v): v.turnId
        case let .approvalRequest(v): v.turnId
        case let .checkpoint(v): v.turnId
        case let .interrupt(v): v.turnId
        case let .systemNotice(v): v.turnId
        case let .error(v): v.turnId
        case let .compaction(v): v.turnId
        case let .handoff(v): v.turnId
        case let .subagent(v): v.turnId
        case let .computerAction(v): v.turnId
        case let .conversationMessage(v): v.turnId
        case .unknown: nil
        }
    }
}


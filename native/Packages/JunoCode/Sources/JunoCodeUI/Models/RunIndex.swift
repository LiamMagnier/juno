import Foundation
import JunoCodeCore
import JunoCodeRuntime

// The Runs list's model: every session with a run or a goal, grouped by what
// it needs from the reader, in words (CODE_AGENT_SPEC §5.1). Pure values and
// functions, so the grouping, the sentences and the actions are reachable
// from tests; `WorkbenchModel` feeds it and `StudioRunsList` draws it.
//
// Owned by Lane E (review, ship, sessions and away).

/// What a run needs from the reader: the Runs list's groups, in order.
public enum RunGroup: String, CaseIterable, Hashable, Sendable {
    case needsYou
    case working
    case readyForReview
    case done
    case failed
    case interrupted

    /// The group's heading, before its count.
    public var title: String {
        switch self {
        case .needsYou: "Needs you"
        case .working: "Working"
        case .readyForReview: "Ready for review"
        case .done: "Done"
        case .failed: "Failed"
        case .interrupted: "Interrupted"
        }
    }
}

/// What the reader can do from a row without opening the session.
public enum RunRowAction: String, Hashable, Sendable {
    /// Allow the pending action once. Never "Always allow": the rule that
    /// writes is read in the session, where it can be seen whole.
    case allowOnce
    case decline
    /// A text field that answers the pending question.
    case reply
    /// Another block of steps or budget, then carry on with no new message.
    case keepGoing
    /// Carry on a run Juno quit in the middle of.
    case resume
    /// Try the failed turn again, with no duplicate message.
    case retry
}

/// One session in the Runs list.
public struct RunIndexEntry: Identifiable, Hashable, Sendable {
    public let sessionID: CodeSessionID
    public let title: String
    public let project: String
    public let group: RunGroup
    /// One sentence from its end reason or its live state: "Waiting for you to
    /// allow `npm install`", "Checking: `swift test`", "Done · checked with
    /// `swift test` · 3 files".
    public let sentence: String
    public let endReason: RunEndReason?
    /// The approval Allow once and Decline answer, with the digest they are
    /// bound to.
    public let approval: ApprovalRequest?
    /// The question Reply answers.
    public let question: QuestionRequest?
    public let actions: [RunRowAction]
    public let updatedAt: Date

    public var id: CodeSessionID { sessionID }

    public init(
        sessionID: CodeSessionID,
        title: String,
        project: String,
        group: RunGroup,
        sentence: String,
        endReason: RunEndReason? = nil,
        approval: ApprovalRequest? = nil,
        question: QuestionRequest? = nil,
        actions: [RunRowAction] = [],
        updatedAt: Date
    ) {
        self.sessionID = sessionID
        self.title = title
        self.project = project
        self.group = group
        self.sentence = sentence
        self.endReason = endReason
        self.approval = approval
        self.question = question
        self.actions = actions
        self.updatedAt = updatedAt
    }
}

/// One group of the Runs list. The heading carries the count in words, never
/// a badge.
public struct RunIndexSection: Identifiable, Hashable, Sendable {
    public let group: RunGroup
    public let entries: [RunIndexEntry]

    public var id: RunGroup { group }

    /// "Needs you (2)".
    public var heading: String { "\(group.title) (\(entries.count))" }
}

/// A run's last recorded outcome, and when it was recorded.
public struct RecordedRunOutcome: Hashable, Codable, Sendable {
    public let outcome: RunOutcomeEvent
    public let recordedAt: Date

    public init(outcome: RunOutcomeEvent, recordedAt: Date) {
        self.outcome = outcome
        self.recordedAt = recordedAt
    }
}

/// Everything the index knows about one session.
public struct RunFacts: Sendable {
    public let session: CodeSession
    public let project: String
    /// The last `run.outcome` the session recorded.
    public let outcome: RecordedRunOutcome?
    /// The approval waiting on the reader, if any.
    public let approval: ApprovalRequest?
    /// The question waiting on the reader, if any.
    public let question: QuestionRequest?
    /// What the running turn is doing now, in words.
    public let activity: String?
    /// The goal's last status, when it has one.
    public let goalStatus: GoalStatusEvent?
    /// Files the session changed, from its transcript summary, for a session
    /// that ended before outcomes were recorded.
    public let filesChanged: Int?
    /// When the reader last opened the session.
    public let viewedAt: Date?

    public init(
        session: CodeSession,
        project: String,
        outcome: RecordedRunOutcome? = nil,
        approval: ApprovalRequest? = nil,
        question: QuestionRequest? = nil,
        activity: String? = nil,
        goalStatus: GoalStatusEvent? = nil,
        filesChanged: Int? = nil,
        viewedAt: Date? = nil
    ) {
        self.session = session
        self.project = project
        self.outcome = outcome
        self.approval = approval
        self.question = question
        self.activity = activity
        self.goalStatus = goalStatus
        self.filesChanged = filesChanged
        self.viewedAt = viewedAt
    }
}

public enum RunIndex {
    /// How long a finished or failed run stays listed.
    public static let recentWindow: TimeInterval = 24 * 60 * 60
    /// How long a finished run with unread changes waits in Ready for review.
    public static let reviewWindow: TimeInterval = 7 * 24 * 60 * 60

    /// The Runs list: each non-empty group in order, newest first within.
    public static func sections(from facts: [RunFacts], now: Date = Date()) -> [RunIndexSection] {
        let entries = facts.compactMap { entry(for: $0, now: now) }
        return RunGroup.allCases.compactMap { group in
            let members = entries
                .filter { $0.group == group }
                .sorted { $0.updatedAt > $1.updatedAt }
            return members.isEmpty ? nil : RunIndexSection(group: group, entries: members)
        }
    }

    /// Whether a session ended because Juno quit while it ran.
    public static func isInterrupted(_ session: CodeSession) -> Bool {
        session.status == .failed && session.lastErrorSummary == CodeSessionStore.interruptionMessage
    }

    /// One session's row, or nil when it has nothing to say: it never ran,
    /// or it finished long enough ago to have left the list.
    public static func entry(for facts: RunFacts, now: Date = Date()) -> RunIndexEntry? {
        let session = facts.session
        func row(
            _ group: RunGroup,
            _ sentence: String,
            reason: RunEndReason? = nil,
            actions: [RunRowAction] = [],
            approval: ApprovalRequest? = nil,
            question: QuestionRequest? = nil
        ) -> RunIndexEntry {
            RunIndexEntry(
                sessionID: session.id,
                title: session.title,
                project: facts.project,
                group: group,
                sentence: sentence,
                endReason: reason,
                approval: approval,
                question: question,
                actions: actions,
                updatedAt: session.updatedAt
            )
        }

        if isInterrupted(session) {
            return row(.interrupted, "Alevr quit while this was running", reason: .interrupted, actions: [.resume])
        }
        if let approval = facts.approval {
            // A screen card is allowed on the card itself, which shows the
            // frame with the target marked and keeps the grant sheet's
            // choices (CU-07): the row declines, or opens the session.
            let atTheCardOnly = ComputerUseToolName.allowedOnlyAtTheMac.contains(approval.toolName)
            return row(
                .needsYou,
                "Waiting for you to allow \(approvalSubject(approval))",
                reason: .needsYou,
                actions: atTheCardOnly ? [.decline] : [.allowOnce, .decline],
                approval: approval
            )
        }
        if let question = facts.question {
            let asked = question.questions.first?.question ?? "a question"
            return row(.needsYou, "Asking: \(asked)", reason: .needsYou, actions: [.reply], question: question)
        }
        if session.hasPendingApproval || session.status == .waitingForApproval {
            return row(.needsYou, "Waiting for your approval", reason: .needsYou)
        }
        if session.status.isActive {
            return row(.working, facts.activity ?? "Working")
        }
        if let goal = facts.goalStatus, goal.status == .needsYou || goal.status == .budgetReached {
            let sentence = goal.reason ?? (goal.status == .budgetReached
                ? "The goal used its budget. Keep going?"
                : "The goal is waiting for you")
            return row(.needsYou, sentence, reason: goal.status == .budgetReached ? .budget : .needsYou,
                       actions: goal.status == .budgetReached ? [.keepGoing] : [])
        }

        let age = now.timeIntervalSince(session.updatedAt)
        if let recorded = facts.outcome {
            let outcome = recorded.outcome
            let reason = outcome.endReason
            let sentence = endSentence(outcome)
            switch reason {
            case .doneChecked, .doneUnchecked:
                let unread = facts.viewedAt.map { $0 < recorded.recordedAt } ?? true
                if outcome.filesChanged > 0, unread, age < reviewWindow {
                    return row(.readyForReview, sentence, reason: reason)
                }
                return age < recentWindow ? row(.done, sentence, reason: reason) : nil
            case .checksFailing, .blocked, .needsYou, .stepLimit, .budget, .stalled:
                return row(.needsYou, sentence, reason: reason, actions: reason.offersKeepGoing ? [.keepGoing] : [])
            case .waitingOnBackground:
                return row(.working, sentence, reason: reason)
            case .error:
                return age < recentWindow ? row(.failed, sentence, reason: reason, actions: [.retry]) : nil
            case .stopped:
                return age < recentWindow ? row(.done, sentence, reason: reason) : nil
            case .interrupted:
                return row(.interrupted, sentence, reason: reason, actions: [.resume])
            }
        }

        // A run that ended before outcomes were recorded: its status.
        switch session.status {
        case .completed:
            let files = facts.filesChanged ?? 0
            let unread = facts.viewedAt.map { $0 < session.updatedAt } ?? true
            let sentence = files > 0 ? "Done · \(plural(files, "file")) changed" : "Done"
            if files > 0, unread, age < reviewWindow {
                return row(.readyForReview, sentence, reason: .doneUnchecked)
            }
            return age < recentWindow ? row(.done, sentence, reason: .doneUnchecked) : nil
        case .failed:
            guard age < recentWindow else { return nil }
            let detail = session.lastErrorSummary.map { "Stopped with an error: \($0)" } ?? "Stopped with an error"
            return row(.failed, detail, reason: .error, actions: [.retry])
        case .cancelled:
            return age < recentWindow ? row(.done, "Stopped", reason: .stopped) : nil
        case .idle, .planning, .running, .waitingForApproval, .waitingForProvider, .degraded, .stopping:
            return nil
        }
    }

    /// The exact thing an approval is about, in code voice when it is a
    /// command: "`npm install`".
    public static func approvalSubject(_ approval: ApprovalRequest) -> String {
        let summary = approval.summary.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !summary.isEmpty else { return "`\(approval.toolName)`" }
        // The command tools' summaries name the command: say just the command.
        for prefix in ["Run tests: ", "Run: "] where summary.hasPrefix(prefix) {
            let command = summary.dropFirst(prefix.count).trimmingCharacters(in: .whitespaces)
            return command.contains("`") ? command : "`\(command)`"
        }
        // "Write notes.txt" reads as "allow write notes.txt".
        guard let first = summary.first, !summary.hasPrefix("`") else { return summary }
        return first.lowercased() + summary.dropFirst()
    }

    /// The sentence for a run that ended, from its outcome: the divider's own
    /// words where the runtime wrote them, else the §1.3 table's.
    public static func endSentence(_ outcome: RunOutcomeEvent) -> String {
        let files = outcome.filesChanged > 0 ? " · \(plural(outcome.filesChanged, "file"))" : ""
        switch outcome.endReason {
        case .doneChecked:
            let first = outcome.checks.first(where: \.passed)?.label
            return "Done · " + (first.map { "checked with `\($0)`" } ?? "checked") + files
        case .doneUnchecked:
            return "Done · not checked" + files
        case .checksFailing:
            if let failing = outcome.checks.first(where: { !$0.passed })?.label {
                return "`\(failing)` still fails"
            }
            return outcome.verification ?? "A check still fails"
        case .blocked:
            return "Blocked: " + (outcome.summary.isEmpty ? "it needs a decision" : outcome.summary)
        case .needsYou:
            return outcome.verification ?? "Waiting for you"
        case .stepLimit:
            return outcome.verification ?? "Stopped at the step limit. Keep going?"
        case .budget:
            return outcome.verification ?? "Used its budget. Keep going?"
        case .stalled:
            return "Stopped: no progress in the last two tries"
        case .waitingOnBackground:
            return outcome.verification ?? "Waiting for background work to finish"
        case .stopped:
            return "Stopped"
        case .interrupted:
            return "Alevr quit while this was running"
        case .error:
            return outcome.summary.isEmpty ? "Stopped with an error" : outcome.summary
        }
    }

    /// What the running turn is doing, in words, from the controller's
    /// projection: "Checking: `swift test`".
    public static func activitySentence(_ state: TaskExecutionState) -> String? {
        switch state {
        case let .verifying(command?):
            "Checking: `\(command)`"
        case .verifying(nil):
            "Checking its work"
        case let .executing(summary):
            summary.isEmpty ? "Working" : summary
        case .planning:
            "Planning"
        case let .awaitingApproval(_, summary, _):
            "Waiting for you to allow \(summary)"
        case .idle, .completed, .failed, .cancelled:
            nil
        }
    }

    /// "2 working, 1 waiting for you": the menu bar's line about the runs.
    public static func summaryLine(_ sections: [RunIndexSection]) -> String? {
        let working = sections.first { $0.group == .working }?.entries.count ?? 0
        let waiting = sections.first { $0.group == .needsYou }?.entries.count ?? 0
        var parts: [String] = []
        if working > 0 { parts.append("\(working) working") }
        if waiting > 0 { parts.append("\(waiting) waiting for you") }
        return parts.isEmpty ? nil : parts.joined(separator: ", ")
    }

    static func plural(_ count: Int, _ noun: String) -> String {
        count == 1 ? "1 \(noun)" : "\(count) \(noun)s"
    }
}

// MARK: - Quitting with runs in flight

/// What quitting does while runs are working (§1.12). Pure, so the decision
/// is tested without an app.
public enum QuitGuard {
    public enum Decision: Equatable, Sendable {
        /// Nothing is working: quit at once.
        case quit
        /// Ask first, with Keep working as the default button.
        case ask(message: String, detail: String)
    }

    /// - Parameters:
    ///   - activeRuns: how many sessions are working or waiting on the reader
    ///     with a run still open.
    ///   - systemIsPoweringOff: the Mac is logging out, restarting or shutting
    ///     down. Nobody is there to answer, and a question would cancel the
    ///     restart; the runs come back interrupted, with Resume.
    public static func decision(activeRuns: Int, systemIsPoweringOff: Bool = false) -> Decision {
        guard activeRuns > 0, !systemIsPoweringOff else { return .quit }
        let message = activeRuns == 1
            ? "1 run is working. Quit and stop it?"
            : "\(activeRuns) runs are working. Quit and stop them?"
        return .ask(
            message: message,
            detail: "Alevr can resume a stopped run when you open it again: it carries on from where it stopped."
        )
    }

    /// Whether a staged update may be installed as the app quits. Never with
    /// runs working: the install replaces the app under them.
    public static func installsStagedUpdate(activeRuns: Int) -> Bool {
        activeRuns == 0
    }

    /// Juno keeps running with its last window closed: runs, notifications
    /// and the menu bar extra outlive the window.
    public static let terminatesAfterLastWindowClosed = false
}

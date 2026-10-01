import Foundation
import JunoCodeCore
import JunoCodeRuntime

/// What the Runs list knows about every session, kept from the store's event
/// stream rather than from any controller (CODE_AGENT_SPEC §5.1).
///
/// A controller stops hearing its session's events when the window detaches
/// it, which is exactly when the reader has looked away; the workbench's own
/// store observer hears every session for as long as it lives. So pending
/// approvals and questions, the running step, and each run's last outcome are
/// folded here from `approvalRequested`, `questionRequested`, `toolStarted`,
/// `runOutcome` and their kin.
///
/// The outcomes, goal statuses, last completions, read marks, archive and
/// pull request links are saved (`run-index.json` beside the sessions), so
/// the list is right at launch without reading a transcript. What a run is
/// waiting on is not: a relaunch interrupts every run, and the store marks it
/// so.
struct RunTracker: Codable, Equatable {
    var outcomes: [String: RecordedRunOutcome] = [:]
    var goalStatuses: [String: GoalStatusEvent] = [:]
    var completions: [String: RunCompletedEvent] = [:]
    var viewedAt: [String: Date] = [:]
    var archived: Set<String> = []
    /// The pull request each session opened or was linked to, for search and
    /// the CI watch.
    var pullRequests: [String: String] = [:]

    // Live state, never saved.
    var approvals: [String: [ApprovalRequest]] = [:]
    var questions: [String: [QuestionRequest]] = [:]
    var activity: [String: String] = [:]
    var proposed: [String: String] = [:]

    private enum CodingKeys: String, CodingKey {
        case outcomes, goalStatuses, completions, viewedAt, archived, pullRequests
    }

    init() {}

    init(from decoder: any Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        outcomes = try values.decodeIfPresent([String: RecordedRunOutcome].self, forKey: .outcomes) ?? [:]
        goalStatuses = try values.decodeIfPresent([String: GoalStatusEvent].self, forKey: .goalStatuses) ?? [:]
        completions = try values.decodeIfPresent([String: RunCompletedEvent].self, forKey: .completions) ?? [:]
        viewedAt = try values.decodeIfPresent([String: Date].self, forKey: .viewedAt) ?? [:]
        archived = try values.decodeIfPresent(Set<String>.self, forKey: .archived) ?? []
        pullRequests = try values.decodeIfPresent([String: String].self, forKey: .pullRequests) ?? [:]
    }

    /// Folds one event in. Returns whether anything saved changed.
    @discardableResult
    mutating func apply(_ event: SessionEvent) -> Bool {
        let id = event.sessionID.value
        switch event.payload {
        case let .approvalRequested(request):
            approvals[id, default: []].removeAll { $0.id == request.id }
            approvals[id, default: []].append(request)
        case let .approvalResolved(resolved):
            approvals[id]?.removeAll { $0.id == resolved.approvalID }
        case let .questionRequested(request):
            questions[id, default: []].removeAll { $0.id == request.id }
            questions[id, default: []].append(request)
        case let .questionResolved(resolved):
            questions[id]?.removeAll { $0.id == resolved.requestID }
        case let .toolProposed(call):
            proposed[call.toolCallID] = Self.activitySentence(call)
        case let .toolStarted(started):
            activity[id] = proposed[started.toolCallID]
        case let .toolCompleted(completed):
            proposed.removeValue(forKey: completed.toolCallID)
            activity.removeValue(forKey: id)
        case let .statusChanged(change) where !change.status.isActive:
            // A run that ended answers nothing more: its pending calls were
            // decided or denied with it.
            approvals.removeValue(forKey: id)
            questions.removeValue(forKey: id)
            activity.removeValue(forKey: id)
        case .userPrompt:
            // A new run: the last one's ending no longer describes the session.
            outcomes.removeValue(forKey: id)
            return true
        case let .runOutcome(outcome):
            outcomes[id] = RecordedRunOutcome(outcome: outcome, recordedAt: event.timestamp)
            return true
        case let .runCompleted(completed):
            completions[id] = completed
            return true
        case let .goalStatus(status):
            goalStatuses[id] = status
            return true
        case .transcriptRewound:
            outcomes.removeValue(forKey: id)
            completions.removeValue(forKey: id)
            approvals.removeValue(forKey: id)
            questions.removeValue(forKey: id)
            return true
        default:
            break
        }
        return false
    }

    /// What a running call is doing, in words: "Checking: `swift test`" for
    /// a check, "Running `npm install`" for a command, else its summary.
    static func activitySentence(_ call: ToolProposedEvent) -> String {
        let command = call.input["command"]?.stringValue
            ?? call.input["commands"]?.arrayValue?.compactMap(\.stringValue).joined(separator: ", ")
        switch call.toolName {
        case "run_tests", "run_checks":
            return command.map { "Checking: `\($0)`" } ?? "Checking its work"
        case "run_command", "shell", "shell_start":
            return command.map { "Running `\($0)`" } ?? call.summary
        default:
            return call.summary
        }
    }

    /// Forgets a deleted session.
    mutating func forget(_ id: CodeSessionID) {
        let key = id.value
        outcomes.removeValue(forKey: key)
        goalStatuses.removeValue(forKey: key)
        completions.removeValue(forKey: key)
        viewedAt.removeValue(forKey: key)
        archived.remove(key)
        pullRequests.removeValue(forKey: key)
        approvals.removeValue(forKey: key)
        questions.removeValue(forKey: key)
        activity.removeValue(forKey: key)
    }

    func facts(for session: CodeSession, project: String) -> RunFacts {
        let key = session.id.value
        return RunFacts(
            session: session,
            project: project,
            outcome: outcomes[key],
            approval: approvals[key]?.first,
            question: questions[key]?.first,
            activity: activity[key],
            goalStatus: goalStatuses[key],
            filesChanged: completions[key]?.filesChanged,
            viewedAt: viewedAt[key]
        )
    }

    // MARK: Persistence

    static func load(from url: URL) -> RunTracker {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return (try? Data(contentsOf: url)).flatMap { try? decoder.decode(RunTracker.self, from: $0) } ?? RunTracker()
    }

    func save(to url: URL) {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(self) else { return }
        try? FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try? data.write(to: url, options: .atomic)
    }
}

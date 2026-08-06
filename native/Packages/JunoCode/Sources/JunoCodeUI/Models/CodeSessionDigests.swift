import Foundation
import JunoCodeCore

/// Pure derivations over one session's transcript.
///
/// The runtime records what happened as ordered events and nothing else: there is
/// no sub-agent table and no index from a test result to the output it produced.
/// Deriving both from the transcript — rather than keeping a parallel set of
/// counters that could disagree with it — is what makes the Activity and Console
/// surfaces incapable of showing a state the session never reached.
///
/// That still holds for sub-agents now that they stream a lifecycle event: the
/// events are the record, and the panel is a fold over them. What the event
/// removed is the *guessing* — a running agent used to have no recorded state at
/// all, so the surface had to describe the delegating tool call and call it the
/// agent.

// MARK: - Sub-agents

/// One delegated sub-agent, reconstructed from the *delegating* session's
/// transcript.
///
/// The runtime writes a `subagentUpdated` event on every transition, so a row
/// exists — with a name, a status and a start time — from the moment the agent
/// is queued rather than only once the delegating call returns. That is what
/// makes an Active list possible at all.
///
/// Transcripts recorded before that event existed are still readable. There the
/// only trace of a delegation is the `delegate_task` tool call plus the
/// `Sub-agent session: <id>` line the tool used to return, and a run derived
/// from those carries what they can say: an outcome, a duration for the call,
/// and no start time. Nothing is invented to fill the difference — `startedAt`
/// stays nil and the row shows the recorded call duration instead of a live
/// timer.
public struct SubagentRun: Identifiable, Sendable, Equatable {
    public var id: String { agentID }
    public let agentID: String
    /// The `delegate_task` call that asked for this agent. Several agents can
    /// share one, which is what a concurrent delegation looks like.
    public let toolCallID: String
    public let title: String
    public let task: String
    /// Nil only for a legacy transcript whose call named no role.
    public let role: AgentRole?
    public let executionMode: SubagentExecutionMode
    public let status: SubagentStatus
    public let currentActivity: String
    /// The agent's own session, once it has one.
    public let childSessionID: CodeSessionID?
    /// The agent's written result.
    public let summary: String?
    public let error: String?
    public let inputTokens: Int?
    public let outputTokens: Int?
    public let startedAt: Date?
    public let completedAt: Date?
    /// When the delegating call was proposed. Always known, and the anchor for
    /// ordering, because it is the one timestamp every run has.
    public let proposedAt: Date
    /// The delegating call's own duration, for legacy transcripts that recorded
    /// nothing finer.
    public let recordedDurationSeconds: Double?

    public var isActive: Bool { !status.isTerminal }

    /// How long the agent worked, once that is a settled number.
    ///
    /// Measured between the agent's own start and finish where both were
    /// recorded; otherwise the delegating call's recorded duration, which for a
    /// single-agent legacy call is the same span. Nil while it is still
    /// running — a live counter is the row's job, not this property's, because
    /// a value derived from `Date()` would be stale the moment it was read.
    public var durationSeconds: Double? {
        if let startedAt, let completedAt {
            return completedAt.timeIntervalSince(startedAt)
        }
        return status.isTerminal ? recordedDurationSeconds : nil
    }
}

public enum SubagentDigest {
    public static let toolName = "delegate_task"
    /// The prefix `DelegateTaskTool` used to write as the first line of its
    /// result, back when it was the only link between a delegation and its
    /// sub-agent's session. Kept solely to read those transcripts: new runs
    /// carry the identifier in `SubagentUpdateEvent.childSessionID`, which is a
    /// field rather than a sentence.
    static let sessionMarker = "Sub-agent session:"

    /// Every delegation in this transcript, oldest call first.
    public static func runs(in events: [SessionEvent]) -> [SubagentRun] {
        var builders: [String: Builder] = [:]
        // The placeholder standing in for a call that has not yet published any
        // agent of its own, keyed by tool call. It is replaced — not merged —
        // the moment real agents appear, because one call can produce several
        // and a merged placeholder would become a phantom extra row.
        var placeholders: [String: String] = [:]
        var callsWithAgents: Set<String> = []
        var proposals: [String: (input: JSONValue, summary: String, at: Date)] = [:]
        var sequence = 0

        for event in events {
            switch event.payload {
            case let .toolProposed(proposed) where proposed.toolName == toolName:
                proposals[proposed.toolCallID] = (
                    proposed.input, proposed.summary, event.timestamp
                )
                placeholders[proposed.toolCallID] = proposed.toolCallID
                builders[proposed.toolCallID] = Builder(
                    placeholderFor: proposed,
                    at: event.timestamp,
                    sequence: sequence
                )
                sequence += 1

            case let .toolStarted(started):
                if let key = placeholders[started.toolCallID] {
                    builders[key]?.status = .running
                }

            case let .subagentUpdated(update):
                callsWithAgents.insert(update.toolCallID)
                if let key = placeholders.removeValue(forKey: update.toolCallID) {
                    builders.removeValue(forKey: key)
                }
                if builders[update.agentID] == nil {
                    builders[update.agentID] = Builder(
                        update,
                        proposedAt: proposals[update.toolCallID]?.at ?? event.timestamp,
                        sequence: sequence
                    )
                    sequence += 1
                } else {
                    builders[update.agentID]?.apply(update)
                }

            case let .toolCompleted(completed):
                if let key = placeholders[completed.toolCallID] {
                    builders[key]?.finish(
                        completed,
                        proposal: proposals[completed.toolCallID]
                    )
                } else if callsWithAgents.contains(completed.toolCallID) {
                    // The call has returned, so nothing of its is still running.
                    // An agent left non-terminal here lost its process — the app
                    // was quit or the run crashed — and saying "interrupted" is
                    // the honest reading of a record that simply stops.
                    let stranded = builders.values
                        .filter { $0.toolCallID == completed.toolCallID && !$0.status.isTerminal }
                        .map(\.agentID)
                    for id in stranded {
                        builders[id]?.interrupt(at: event.timestamp)
                    }
                }

            default:
                break
            }
        }

        return builders.values
            .sorted { left, right in
                left.proposedAt == right.proposedAt
                    ? left.sequence < right.sequence
                    : left.proposedAt < right.proposedAt
            }
            .map { $0.build() }
    }

    /// The child session id carried in a legacy `delegate_task` result summary,
    /// or `nil` when the call was denied, cancelled or failed before creating
    /// one.
    public static func childSessionID(in resultSummary: String) -> CodeSessionID? {
        guard let range = resultSummary.range(of: sessionMarker) else { return nil }
        let value = resultSummary[range.upperBound...]
            .drop(while: \.isWhitespace)
            .prefix(while: { !$0.isWhitespace })
        guard !value.isEmpty else { return nil }
        return CodeSessionID(value: String(value))
    }

    /// A legacy `delegate_task` result with its correlation marker removed.
    ///
    /// The tool used to write `Sub-agent session: <id>` as the first line and
    /// the child's answer beneath it. The identifier is a field on the run now,
    /// so reprinting it inside the result text would be noise. Returns nil when
    /// nothing is left, which is the case for a call denied before it produced
    /// anything.
    static func resultBody(_ summary: String) -> String? {
        var lines = summary.split(separator: "\n", omittingEmptySubsequences: false)
        if let first = lines.first,
           first.trimmingCharacters(in: .whitespaces).hasPrefix(sessionMarker)
        {
            lines.removeFirst()
        }
        let body = lines
            .joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return body.isEmpty ? nil : body
    }

    /// One run under construction. Mutable so a stream of updates for the same
    /// agent collapses into one row instead of one row per transition.
    private struct Builder {
        let agentID: String
        let toolCallID: String
        var title: String
        var task: String
        var role: AgentRole?
        var executionMode: SubagentExecutionMode
        var status: SubagentStatus
        var currentActivity = ""
        var childSessionID: CodeSessionID?
        var summary: String?
        var error: String?
        var inputTokens: Int?
        var outputTokens: Int?
        var startedAt: Date?
        var completedAt: Date?
        let proposedAt: Date
        var recordedDurationSeconds: Double?
        let sequence: Int

        init(placeholderFor proposed: ToolProposedEvent, at timestamp: Date, sequence: Int) {
            let input = proposed.input
            let task = input["task"]?.stringValue ?? proposed.summary
            let requested = input["title"]?.stringValue?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let source = requested.flatMap { $0.isEmpty ? nil : $0 }
                ?? (task.split(separator: "\n").first.map(String.init) ?? task)
            self.agentID = proposed.toolCallID
            self.toolCallID = proposed.toolCallID
            self.title = String(source.prefix(80))
            self.task = task
            self.role = input["role"]?.stringValue.flatMap(AgentRole.init(rawValue:))
            self.executionMode = .readOnly
            self.status = .queued
            self.proposedAt = timestamp
            self.sequence = sequence
        }

        init(_ update: SubagentUpdateEvent, proposedAt: Date, sequence: Int) {
            self.agentID = update.agentID
            self.toolCallID = update.toolCallID
            self.title = update.title
            self.task = update.task
            self.role = update.role
            self.executionMode = update.executionMode
            self.status = update.status
            self.proposedAt = proposedAt
            self.sequence = sequence
            apply(update)
        }

        /// Later fields never overwrite earlier ones with nothing: a terminal
        /// update carries no `currentActivity`, and the child session id is
        /// published once when the session is created and not repeated.
        mutating func apply(_ update: SubagentUpdateEvent) {
            title = update.title
            task = update.task
            role = update.role
            executionMode = update.executionMode
            status = update.status
            currentActivity = update.currentActivity
            if let id = update.childSessionID { childSessionID = id }
            if let started = update.startedAt { startedAt = started }
            if let completed = update.completedAt { completedAt = completed }
            if let tokens = update.inputTokens { inputTokens = tokens }
            if let tokens = update.outputTokens { outputTokens = tokens }
            if let text = update.summary { summary = text }
            error = update.error ?? error
        }

        /// A legacy call's outcome, read off the delegating tool call itself.
        mutating func finish(
            _ completed: ToolCompletedEvent,
            proposal: (input: JSONValue, summary: String, at: Date)?
        ) {
            status =
                switch completed.status {
                case .succeeded: .completed
                case .failed: .failed
                // Neither has an equivalent in the shared vocabulary, and both
                // mean the same thing to a reader: it did not run. The reason is
                // kept as the error rather than folded into a status word.
                case .denied, .cancelled: .cancelled
                }
            recordedDurationSeconds = completed.durationSeconds
            // An ordering key, not a measurement: the recorded duration runs
            // from authorization rather than from the proposal, so this lands
            // slightly late whenever the call waited for an approval. It is only
            // ever used to sort the Done list, and `durationSeconds` reads the
            // recorded value rather than this difference.
            completedAt = proposal.map { $0.at.addingTimeInterval(completed.durationSeconds) }
            childSessionID = SubagentDigest.childSessionID(in: completed.resultSummary)
            let body = SubagentDigest.resultBody(completed.resultSummary)
            if completed.status == .succeeded {
                summary = body
            } else {
                error = body ?? completed.resultSummary
            }
        }

        mutating func interrupt(at timestamp: Date) {
            status = .interrupted
            completedAt = completedAt ?? timestamp
            error = error ?? "The run ended before this sub-agent finished."
        }

        func build() -> SubagentRun {
            SubagentRun(
                agentID: agentID,
                toolCallID: toolCallID,
                title: title,
                task: task,
                role: role,
                executionMode: executionMode,
                status: status,
                currentActivity: currentActivity,
                childSessionID: childSessionID,
                summary: summary,
                error: error,
                inputTokens: inputTokens,
                outputTokens: outputTokens,
                startedAt: startedAt,
                completedAt: completedAt,
                proposedAt: proposedAt,
                recordedDurationSeconds: recordedDurationSeconds
            )
        }
    }
}

/// One sub-agent session as the store holds it: its real status, its result, and
/// the tool calls it made. Loaded on demand — a child's transcript is a separate
/// session and is not mirrored into the parent's event list.
public struct SubagentDetail: Sendable, Equatable {
    public struct Step: Identifiable, Sendable, Equatable {
        public var id: String { toolCallID }
        public let toolCallID: String
        public let summary: String
        public let status: ToolCompletionStatus?
    }

    public let session: CodeSession
    public let answer: String?
    public let steps: [Step]

    public init(session: CodeSession, events: [SessionEvent]) {
        self.session = session
        var answer: String?
        var order: [String] = []
        var summaries: [String: String] = [:]
        var statuses: [String: ToolCompletionStatus] = [:]
        for event in events {
            switch event.payload {
            case let .assistantMessage(message):
                answer = message.text
            case let .toolProposed(proposed):
                order.append(proposed.toolCallID)
                summaries[proposed.toolCallID] = proposed.summary
            case let .toolCompleted(completed):
                statuses[completed.toolCallID] = completed.status
            default:
                break
            }
        }
        self.answer = answer
        self.steps = order.compactMap { id in
            guard let summary = summaries[id] else { return nil }
            return Step(toolCallID: id, summary: summary, status: statuses[id])
        }
    }
}

// MARK: - Test runs

// MARK: - In-flight tools

public enum CodeToolDigest {
    /// The tool calls that have started and not yet completed.
    ///
    /// Derived rather than counted, for the reason stated at the top of this
    /// file: a parallel counter can disagree with the transcript, and the
    /// transcript is what the reader is looking at. A call is in flight when a
    /// `toolStarted` has no matching `toolCompleted` — which is also how a run
    /// interrupted by a crash or a stop reads, correctly, as no longer running
    /// once its completion event lands.
    public static func runningToolCallIDs(in events: [SessionEvent]) -> Set<String> {
        var running: Set<String> = []
        for event in events {
            switch event.payload {
            case let .toolStarted(started):
                running.insert(started.toolCallID)
            case let .toolCompleted(completed):
                running.remove(completed.toolCallID)
            default:
                break
            }
        }
        return running
    }
}

public enum CodeTestDigest {
    /// The most recent test run, with the tool call that produced it.
    ///
    /// `TestRunCompletedEvent` carries no tool-call identifier, so the only
    /// honest correlation is position: the runtime appends a tool's side effects
    /// while that call is still open, so the run belongs to whichever call had
    /// started and not yet completed.
    public static func lastTestRun(
        in events: [SessionEvent]
    ) -> (run: TestRunCompletedEvent, toolCallID: String?)? {
        var openToolCallID: String?
        var result: (run: TestRunCompletedEvent, toolCallID: String?)?
        for event in events {
            switch event.payload {
            case let .toolStarted(started):
                openToolCallID = started.toolCallID
            case let .toolCompleted(completed):
                if openToolCallID == completed.toolCallID {
                    openToolCallID = nil
                }
            case let .testRunCompleted(run):
                result = (run, openToolCallID)
            default:
                break
            }
        }
        return result
    }
}

// MARK: - Controller conveniences

public extension SessionController {
    /// Delegated sub-agents in this session, derived from the transcript.
    ///
    /// An agent whose session is over cannot still be working, whatever the last
    /// event about it said. That gap is real: quitting the app mid-delegation
    /// leaves the last recorded update at `running`, and without this the panel
    /// would show an Active row with a timer ticking for a process that no
    /// longer exists. The transcript is not rewritten to say so — the reading
    /// is, which keeps the record honest and the panel honest at the same time.
    var subagents: [SubagentRun] {
        let runs = SubagentDigest.runs(in: events)
        guard !session.status.isActive else { return runs }
        return runs.map { run in
            guard !run.status.isTerminal else { return run }
            return SubagentRun(
                agentID: run.agentID,
                toolCallID: run.toolCallID,
                title: run.title,
                task: run.task,
                role: run.role,
                executionMode: run.executionMode,
                status: .interrupted,
                currentActivity: "",
                childSessionID: run.childSessionID,
                summary: run.summary,
                error: run.error ?? "The run ended before this sub-agent finished.",
                inputTokens: run.inputTokens,
                outputTokens: run.outputTokens,
                startedAt: run.startedAt,
                completedAt: run.completedAt ?? session.updatedAt,
                proposedAt: run.proposedAt,
                recordedDurationSeconds: run.recordedDurationSeconds
            )
        }
    }

}

public extension SubagentDigest {
    /// The still-working agents, newest first — the panel's "Active · N".
    ///
    /// Taken as a split of an already-folded list rather than as two more folds
    /// over the transcript: `runs(in:)` walks every event in the session, and a
    /// pane that asked for "the active ones" and "the finished ones" separately
    /// would walk it three times per redraw of a view that redraws on every
    /// event.
    static func active(in runs: [SubagentRun]) -> [SubagentRun] {
        Array(runs.filter(\.isActive).reversed())
    }

    /// The finished ones, most recently finished first.
    static func finished(in runs: [SubagentRun]) -> [SubagentRun] {
        runs
            .filter { $0.status.isTerminal }
            .sorted {
                ($0.completedAt ?? $0.proposedAt) > ($1.completedAt ?? $1.proposedAt)
            }
    }
}

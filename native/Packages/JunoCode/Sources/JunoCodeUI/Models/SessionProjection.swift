import Foundation
import Observation
import JunoCodeCore
import JunoCodeRuntime

/// One canonical tool name and how often a narrative group called it.
public struct ToolTally: Hashable, Sendable {
    public let name: String
    public var count: Int

    public init(name: String, count: Int = 1) {
        self.name = name
        self.count = count
    }
}

/// One collapsed work-narrative group: a run of consecutive tool activity
/// between two conversational events, summarized into a human sentence.
///
/// Groups are derived from the transcript, not maintained in parallel with it:
/// `eventIDs` links every group back to the exact transcript events it
/// summarizes, so expanding a group can render those original events through
/// the ordinary row renderer and nothing is paraphrased twice. The identifier
/// is the first event's own id, which keeps it stable both while the group
/// grows as work streams in and when the projection is rebuilt from the store
/// — a live group must not remount on every event.
public struct ActivityNarrativeGroup: Identifiable, Sendable, Equatable {
    public let id: String
    public var title: String
    public var detailSummary: String
    public var status: GroupStatus
    public var eventIDs: [String]
    /// Calls per canonical tool name, in first-seen order.
    public var toolCounts: [ToolTally]
    public var filesTouched: Set<String>
    public var linesAdded: Int
    public var linesRemoved: Int
    public var startedAt: Date
    public var completedAt: Date?
    /// Every tool call the group folded, in the order it was proposed, with the
    /// state each reached. This is the expanded view's whole content: the
    /// collapsed row is a sentence about these records, and opening it shows
    /// the records themselves rather than a second paraphrase.
    public var toolCallRecords: [ToolCallRecord]

    public enum GroupStatus: String, Sendable, Hashable {
        case running
        case completed
        case interrupted
    }

    /// One tool call, as the work log reports it.
    public struct ToolCallRecord: Identifiable, Sendable, Equatable {
        public enum ToolStatus: String, Sendable, Hashable {
            case proposed
            case running
            case succeeded
            case failed
            case denied
            case cancelled
        }

        /// The tool call identifier the runtime assigned.
        public let id: String
        public let toolName: String
        /// The proposal's one-line summary — "Read Sources/App.swift".
        public var summary: String
        public var status: ToolStatus
        public var durationSeconds: Double?
        /// The completion's result line, when the tool reported one.
        public var resultSummary: String?
        /// Streamed output, bounded to what a collapsed log needs to show.
        public var outputLines: [String]
        public var startedAt: Date

        public static let maximumOutputLines = 40

        public init(
            id: String,
            toolName: String,
            summary: String,
            status: ToolStatus = .proposed,
            durationSeconds: Double? = nil,
            resultSummary: String? = nil,
            outputLines: [String] = [],
            startedAt: Date
        ) {
            self.id = id
            self.toolName = toolName
            self.summary = summary
            self.status = status
            self.durationSeconds = durationSeconds
            self.resultSummary = resultSummary
            self.outputLines = outputLines
            self.startedAt = startedAt
        }
    }

    init(id: String, startedAt: Date) {
        self.id = id
        self.title = "Working"
        self.detailSummary = ""
        self.status = .running
        self.eventIDs = []
        self.toolCounts = []
        self.filesTouched = []
        self.linesAdded = 0
        self.linesRemoved = 0
        self.startedAt = startedAt
        self.completedAt = nil
        self.toolCallRecords = []
    }

    /// Whether the group has anything to show when opened.
    public var hasDetail: Bool { !toolCallRecords.isEmpty }

    /// The elapsed wall time, once the group has closed.
    public var durationSeconds: Double? {
        completedAt.map { $0.timeIntervalSince(startedAt) }
    }
}

/// Reduces append-only runtime events into the small presentation state the
/// session surface reads: what the task is doing right now, and the collapsed
/// work narrative between messages.
///
/// This is deliberately all it owns. Approvals, tracked changes, console
/// lines, and the session record are projected by the coordinator's own
/// projections; a second copy here would be state that can drift.
@Observable
@MainActor
public final class SessionProjection {
    public private(set) var executionState: TaskExecutionState = .idle
    public private(set) var narrativeGroups: [ActivityNarrativeGroup] = []
    /// The most recent non-recoverable error, kept so a failure can name its
    /// cause rather than a generic message.
    public private(set) var lastError: CodeExecutionError?
    /// The most recent verification verdict the transcript reported.
    public private(set) var verificationOutcome: VerificationOutcome?

    /// Files changed since the last user instruction — input to the honest
    /// completion evaluation.
    private var filesChangedPaths: Set<String> = []
    private var lastTestRun: TestRunCompletedEvent?
    /// Canonical tool names in the order this group first proposed them.
    private var lastProposedToolName = ""

    public init() {}

    /// Rebuilds the projection from a whole transcript. Used on session load
    /// and whenever the coordinator replays its events; must agree exactly
    /// with `apply(event:)`.
    public func reduce(events: [SessionEvent]) {
        executionState = .idle
        narrativeGroups = []
        lastError = nil
        verificationOutcome = nil
        filesChangedPaths = []
        lastTestRun = nil
        lastProposedToolName = ""
        for event in events {
            apply(event: event)
        }
    }

    /// Folds one transcript event into the projection.
    public func apply(event: SessionEvent) {
        switch event.payload {
        case let .statusChanged(change):
            applyStatus(change.status)

        case .userPrompt, .userInstruction:
            filesChangedPaths = []
            closeActiveGroup(status: .completed)
            executionState = .executing(summary: "Starting…")

        case .userInstructionApplied, .sessionCreated, .turnConfiguration:
            break

        case .assistantMessage:
            closeActiveGroup(status: .completed)
            executionState = .executing(summary: "Writing response…")

        case .reasoningSummary:
            // Reasoning precedes tool work; let the next tool event open the
            // group rather than splitting every reasoning line off.
            if case .idle = executionState {
                executionState = .executing(summary: "Thinking…")
            }

        case let .toolProposed(proposed):
            lastProposedToolName = proposed.toolName
            let index = openGroup(at: event)
            record(tool: proposed.toolName, in: index)
            narrativeGroups[index].toolCallRecords.append(
                ActivityNarrativeGroup.ToolCallRecord(
                    id: proposed.toolCallID,
                    toolName: proposed.toolName,
                    summary: proposed.summary,
                    startedAt: event.timestamp
                )
            )
            narrativeGroups[index].detailSummary = proposed.summary
            executionState = .executing(summary: "Preparing \(proposed.toolName)…")

        case let .toolStarted(started):
            let index = openGroup(at: event)
            let name = lastProposedToolName
            updateRecord(started.toolCallID, in: index) { record in
                record.status = .running
                record.startedAt = event.timestamp
            }
            narrativeGroups[index].detailSummary = "Running \(name)…"
            executionState = .executing(summary: "Running \(name)…")

        case let .toolCompleted(completed):
            let index = openGroup(at: event)
            updateRecord(completed.toolCallID, in: index) { record in
                record.status = Self.recordStatus(completed.status)
                record.durationSeconds = completed.durationSeconds
                record.resultSummary = completed.resultSummary.isEmpty ? nil : completed.resultSummary
            }
            narrativeGroups[index].detailSummary = completed.resultSummary
            refreshSummary(index)
            executionState = .executing(summary: narrativeGroups[index].title)

        case let .fileChanged(change):
            filesChangedPaths.insert(change.path.value)
            let index = openGroup(at: event)
            narrativeGroups[index].filesTouched.insert(change.path.value)
            narrativeGroups[index].linesAdded += change.linesAdded
            narrativeGroups[index].linesRemoved += change.linesRemoved
            refreshSummary(index)
            executionState = .executing(summary: narrativeGroups[index].title)

        case let .toolOutput(output):
            // Folded into the call's own record, bounded, so an opened group can
            // show a command's tail without the transcript context re-walking
            // the event list.
            guard let index = narrativeGroups.indices.last,
                  narrativeGroups[index].status == .running
            else { break }
            updateRecord(output.toolCallID, in: index) { record in
                let lines = output.text
                    .split(separator: "\n", omittingEmptySubsequences: true)
                    .map(String.init)
                record.outputLines.append(contentsOf: lines)
                if record.outputLines.count > ActivityNarrativeGroup.ToolCallRecord.maximumOutputLines {
                    record.outputLines.removeFirst(
                        record.outputLines.count
                            - ActivityNarrativeGroup.ToolCallRecord.maximumOutputLines
                    )
                }
            }

        case .compaction:
            // A fold of the model context. It is a row of its own in the
            // transcript and says nothing about what the agent is doing.
            closeActiveGroup(status: .completed)

        case let .approvalRequested(request):
            closeActiveGroup(status: .completed)
            executionState = .awaitingApproval(
                approvalID: request.id,
                summary: request.summary,
                risk: request.risk
            )

        case let .approvalResolved(resolved):
            if case let .awaitingApproval(id, _, _) = executionState, id == resolved.approvalID {
                executionState = .executing(summary: "Resuming…")
            }

        case .goalUpdated:
            closeActiveGroup(status: .completed)
            executionState = .executing(summary: "Updating task plan…")

        case let .subagentUpdated(subagent):
            // Sub-agent cards render from the transcript itself and stay
            // inspectable there; the narrative only notes delegated work.
            closeActiveGroup(status: .completed)
            if subagent.status.isTerminal {
                executionState = .executing(summary: "Delegated work finished")
            } else {
                executionState = .executing(summary: "Delegated: \(subagent.title)")
            }

        case let .testRunCompleted(run):
            lastTestRun = run
            closeActiveGroup(status: .completed)
            if run.passed {
                verificationOutcome = .passed(
                    summary: run.testsRun.map {
                        "\($0) test\($0 == 1 ? "" : "s") passed."
                    } ?? "Verification command passed."
                )
            } else {
                let failures = run.failures ?? 1
                verificationOutcome = .failedVerification(
                    reason: "\(failures) test failure\(failures == 1 ? "" : "s")."
                )
            }
            executionState = .executing(summary: run.passed ? "Verification passed" : "Verification failed")

        case let .errorOccurred(error):
            guard !error.isRecoverable else { break }
            // A recoverable error is transient (retry, fallback); the run goes
            // on. A terminal one is the honest failure the surface shows.
            lastError = CodeExecutionError(
                category: .unknown,
                message: error.message,
                isRecoverable: false,
                recommendedAction: .retry
            )
            closeActiveGroup(status: .interrupted)
            executionState = .failed(error: lastError!)

        case .runCompleted:
            closeActiveGroup(status: .completed)
            let evaluated = VerificationEngine.evaluateTaskOutcome(
                goal: nil,
                lastTestRun: lastTestRun,
                filesChangedCount: filesChangedPaths.count
            )
            // The transcript's explicit test verdict outranks the structural
            // evaluation; the evaluation fills the no-test-ran gaps honestly.
            if verificationOutcome == nil {
                verificationOutcome = evaluated
            }
        }
    }

    // MARK: - State transitions

    private func applyStatus(_ status: SessionStatus) {
        switch status {
        case .idle:
            executionState = .idle
            closeActiveGroup(status: .completed)
        case .planning:
            executionState = .executing(summary: "Planning…")
        case .running:
            // AwaitingApproval and the failed/cancelled states outrank a
            // generic "running": the status event lands alongside the more
            // specific one and must not clobber it.
            switch executionState {
            case .awaitingApproval, .failed, .cancelled:
                break
            case .executing:
                break
            case .idle, .planning, .verifying, .completed:
                executionState = .executing(summary: "Working…")
            }
        case .waitingForApproval, .waitingForProvider, .degraded, .stopping:
            break
        case .completed:
            closeActiveGroup(status: .completed)
            executionState = .completed(
                outcome: verificationOutcome
                    ?? (filesChangedPaths.isEmpty
                        ? .passed(summary: "Run completed.")
                        : .unverified(reason: "Edits were made without recorded verification."))
            )
        case .failed:
            closeActiveGroup(status: .interrupted)
            executionState = .failed(
                error: lastError
                    ?? CodeExecutionError(
                        category: .unknown,
                        message: "Execution failed.",
                        isRecoverable: true,
                        recommendedAction: .retry
                    )
            )
        case .cancelled:
            closeActiveGroup(status: .interrupted)
            executionState = .cancelled
        }
    }

    // MARK: - Narrative groups

    /// The index of the group a tool event belongs to, opening a fresh group
    /// when the previous one was closed by a conversational event. Mutations
    /// go through the returned index — groups are value types, and a copied
    /// row would silently drop every update.
    private func openGroup(at event: SessionEvent) -> Int {
        if let index = narrativeGroups.indices.last,
           narrativeGroups[index].status == .running
        {
            if !narrativeGroups[index].eventIDs.contains(event.id) {
                narrativeGroups[index].eventIDs.append(event.id)
            }
            return index
        }
        let group = ActivityNarrativeGroup(id: "narrative-\(event.id)", startedAt: event.timestamp)
        narrativeGroups.append(group)
        let index = narrativeGroups.count - 1
        narrativeGroups[index].eventIDs = [event.id]
        return index
    }

    private func updateRecord(
        _ toolCallID: String,
        in index: Int,
        _ change: (inout ActivityNarrativeGroup.ToolCallRecord) -> Void
    ) {
        guard let position = narrativeGroups[index].toolCallRecords
            .firstIndex(where: { $0.id == toolCallID })
        else { return }
        change(&narrativeGroups[index].toolCallRecords[position])
    }

    private static func recordStatus(
        _ status: ToolCompletionStatus
    ) -> ActivityNarrativeGroup.ToolCallRecord.ToolStatus {
        switch status {
        case .succeeded: .succeeded
        case .failed: .failed
        case .denied: .denied
        case .cancelled: .cancelled
        }
    }

    private func record(tool name: String, in index: Int) {
        if let position = narrativeGroups[index].toolCounts.firstIndex(where: { $0.name == name }) {
            narrativeGroups[index].toolCounts[position].count += 1
        } else {
            narrativeGroups[index].toolCounts.append(ToolTally(name: name))
        }
        refreshSummary(index)
    }

    private func closeActiveGroup(status: ActivityNarrativeGroup.GroupStatus) {
        guard let index = narrativeGroups.indices.last,
              narrativeGroups[index].status == .running
        else { return }
        narrativeGroups[index].status = status
        narrativeGroups[index].completedAt = Date()
        // A call still open when the group closes was interrupted with it.
        for position in narrativeGroups[index].toolCallRecords.indices
        where narrativeGroups[index].toolCallRecords[position].status == .proposed
            || narrativeGroups[index].toolCallRecords[position].status == .running
        {
            narrativeGroups[index].toolCallRecords[position].status =
                status == .interrupted ? .cancelled : .succeeded
        }
        refreshSummary(index)
    }

    private func refreshSummary(_ index: Int) {
        let group = narrativeGroups[index]
        var parts: [String] = []
        let files = group.filesTouched.count
        if files > 0 {
            parts.append("\(files) file\(files == 1 ? "" : "s")")
            if group.linesAdded > 0 || group.linesRemoved > 0 {
                parts.append("+\(group.linesAdded) −\(group.linesRemoved)")
            }
        }
        let calls = group.toolCounts.reduce(0) { $0 + $1.count }
        if calls > 0, files == 0 {
            parts.append("\(calls) step\(calls == 1 ? "" : "s")")
        }
        if let completedAt = group.completedAt {
            let seconds = Int(completedAt.timeIntervalSince(group.startedAt))
            if seconds >= 1 {
                parts.append("\(seconds)s")
            }
        }
        narrativeGroups[index].detailSummary = parts.joined(separator: " · ")
        narrativeGroups[index].title = Self.title(for: group.toolCounts)
    }

    /// Titles a group from the mix of tools it ran, using the canonical
    /// registry names the events carry.
    ///
    /// The sentence describes the work, not the machinery — "Read 4 files · ran
    /// 2 commands · edited 3 files" — and it is built from counts so the row
    /// stays honest as calls land: a group that has read one file says so, and
    /// grows into a longer sentence rather than starting with a vague verb.
    static func title(for toolCounts: [ToolTally]) -> String {
        var clauses: [String] = []
        func count(_ names: Set<String>) -> Int {
            toolCounts.filter { names.contains($0.name) }.reduce(0) { $0 + $1.count }
        }
        let reads = count(["read_file", "list_directory", "glob", "grep", "find_files", "git_status", "git_diff", "git_log", "web_search", "web_fetch"])
        let edits = count(["create_file", "write_file", "apply_patch", "delete_file", "move_file"])
        let commands = count(["run_command"])
        let tests = count(["run_tests"])
        let delegations = count(["delegate_task"])
        let known = reads + edits + commands + tests + delegations
        let other = toolCounts.reduce(0) { $0 + $1.count } - known

        if reads > 0 { clauses.append("read \(reads) \(reads == 1 ? "file" : "files")") }
        if commands > 0 { clauses.append("ran \(commands) \(commands == 1 ? "command" : "commands")") }
        if tests > 0 { clauses.append("ran \(tests == 1 ? "the tests" : "\(tests) test runs")") }
        if edits > 0 { clauses.append("edited \(edits) \(edits == 1 ? "file" : "files")") }
        if delegations > 0 { clauses.append("delegated \(delegations) \(delegations == 1 ? "task" : "tasks")") }
        if other > 0 { clauses.append("used \(other) \(other == 1 ? "tool" : "tools")") }

        guard let first = clauses.first else { return "Working" }
        let sentence = ([first.prefix(1).uppercased() + first.dropFirst()] + clauses.dropFirst())
            .joined(separator: " · ")
        return sentence
    }
}

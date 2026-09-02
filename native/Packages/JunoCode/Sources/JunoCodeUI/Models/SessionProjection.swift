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

    public enum GroupStatus: String, Sendable, Hashable {
        case running
        case completed
        case interrupted
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
            narrativeGroups[index].detailSummary = proposed.summary
            executionState = .executing(summary: "Preparing \(proposed.toolName)…")

        case let .toolStarted(started):
            let index = openGroup(at: event)
            let name = lastProposedToolName
            narrativeGroups[index].detailSummary = "Running \(name)…"
            executionState = .executing(summary: "Running \(name)…")

        case let .toolCompleted(completed):
            let index = openGroup(at: event)
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

        case .toolOutput:
            // Folded into its own tool row by the transcript context; not a
            // narrative event.
            break

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
    /// registry names the events carry. The sentence describes the work, not
    /// the machinery: reads and searches are investigation, writes are
    /// modification, tests and builds are verification.
    private static func title(for toolCounts: [ToolTally]) -> String {
        let names = Set(toolCounts.map(\.name))
        let writes = names.intersection(["create_file", "write_file", "apply_patch", "delete_file", "move_file"])
        let tests = names.contains("run_tests")
        let commands = names.contains("run_command")
        let reads = names.intersection(["read_file", "list_directory", "glob", "grep", "find_files"])
        let gitReads = names.intersection(["git_status", "git_diff", "git_log"])

        if !writes.isEmpty { return "Modified files" }
        if tests { return "Ran verification" }
        if commands { return "Ran commands" }
        if !reads.isEmpty || !gitReads.isEmpty { return "Investigated workspace" }
        return toolCounts.isEmpty ? "Working" : "Worked in workspace"
    }
}

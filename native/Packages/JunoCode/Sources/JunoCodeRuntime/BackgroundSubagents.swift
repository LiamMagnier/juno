import Foundation
import JunoCodeCore

/// The sub-agents a session started with `background: true` (CODE_AGENT_SPEC
/// §5.2), which run on while the parent keeps working.
///
/// One per session. `delegate_task` launches into it and returns the ids at
/// once; `await_subagents`, `inspect_subagent` and `cancel_subagent` read and
/// stop them; the stop check waits while any still runs (§1.4 rule 2); and
/// the session's Stop cancels them all. Each child keeps its own transcript
/// and its own approvals, exactly as a foreground one does — running in the
/// background changes when the parent hears back, never what a child may do.
public actor BackgroundSubagentRegistry {
    public struct Entry: Equatable, Sendable {
        public let id: String
        public let title: String
        /// The agent it was started as, when one was named.
        public let agent: String?
        public internal(set) var status: SubagentStatus
        public internal(set) var childSessionID: CodeSessionID?
        public internal(set) var answer: String?
        public let startedAt: Date
        public internal(set) var completedAt: Date?

        public var isFinished: Bool {
            switch status {
            case .completed, .failed, .cancelled, .interrupted: true
            case .queued, .preparing, .running, .waitingForApproval: false
            }
        }

        /// One line for a tool result: what it is and how it stands.
        public var line: String {
            let named = agent.map { " (\($0))" } ?? ""
            return "\(id)\(named) — \(title): \(status.rawValue)"
        }
    }

    /// How long one background child may run before it is stopped: long
    /// enough for real work, short enough that a stuck one cannot hold the
    /// session's stop check forever.
    public static let budget: Duration = .seconds(30 * 60)

    private var entries: [String: Entry] = [:]
    private var order: [String] = []
    private var tasks: [String: Task<Void, Never>] = [:]

    public init() {}

    /// Registers a child and starts `work`, which reports its outcome.
    public func launch(
        id: String,
        title: String,
        agent: String?,
        work: @escaping @Sendable () async -> (status: SubagentStatus, answer: String)
    ) {
        entries[id] = Entry(
            id: id,
            title: title,
            agent: agent,
            status: .queued,
            startedAt: Date()
        )
        order.append(id)
        tasks[id] = Task { [weak self] in
            let outcome = await work()
            await self?.finish(id: id, status: outcome.status, answer: outcome.answer)
        }
    }

    /// Records progress a running child reports.
    public func update(id: String, status: SubagentStatus? = nil, childSessionID: CodeSessionID? = nil) {
        guard var entry = entries[id], !entry.isFinished else { return }
        if let status { entry.status = status }
        if let childSessionID { entry.childSessionID = childSessionID }
        entries[id] = entry
    }

    private func finish(id: String, status: SubagentStatus, answer: String) {
        guard var entry = entries[id] else { return }
        // A cancel already said how it ended.
        if !entry.isFinished {
            entry.status = status
        }
        entry.answer = answer
        entry.completedAt = Date()
        entries[id] = entry
        tasks[id] = nil
    }

    public func entry(_ id: String) -> Entry? { entries[id] }

    /// Every child, in the order they were started.
    public func all() -> [Entry] { order.compactMap { entries[$0] } }

    /// Whether any child is still working: the stop check's question.
    public var hasRunning: Bool { entries.values.contains { !$0.isFinished } }

    /// Stops one child. False for an id this session never started, or one
    /// that already finished.
    @discardableResult
    public func cancel(_ id: String) -> Bool {
        guard var entry = entries[id], !entry.isFinished else { return false }
        entry.status = .cancelled
        entries[id] = entry
        tasks[id]?.cancel()
        return true
    }

    /// Stops every child: the session's Stop.
    public func cancelAll() {
        for id in order { cancel(id) }
    }

    /// Waits until every named child has finished, or `timeout` passes, and
    /// returns them as they stand. Unknown ids are left out.
    public func waitFor(_ ids: [String], timeout: Duration) async -> [Entry] {
        let deadline = ContinuousClock.now.advanced(by: timeout)
        while ContinuousClock.now < deadline, !Task.isCancelled {
            if ids.allSatisfy({ entries[$0]?.isFinished ?? true }) { break }
            try? await Task.sleep(for: .milliseconds(200))
        }
        return ids.compactMap { entries[$0] }
    }
}

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

    /// At most this many children work at once. Each is a model loop with
    /// its own spend, and a write-capable one a Git worktree on disk; without
    /// a ceiling a model that kept delegating in the background could start
    /// them without end. One call can start this many.
    public static let maximumRunning = 4
    /// At most this many in one session, finished ones included: the ids,
    /// answers and child transcripts all stay for the session's life.
    public static let maximumPerSession = 16

    private var entries: [String: Entry] = [:]
    private var order: [String] = []
    private var tasks: [String: Task<Void, Never>] = [:]

    public init() {}

    /// One child to reserve a place for.
    public struct Reservation: Sendable {
        public let id: String
        public let title: String
        public let agent: String?

        public init(id: String, title: String, agent: String?) {
            self.id = id
            self.title = title
            self.agent = agent
        }
    }

    /// Reserves places for every child in `children`, all or none, and
    /// returns nil; or returns why there is no room, in words for the model.
    /// Reserved children are listed as queued until ``start(id:work:)``.
    ///
    /// One step on the actor, so two delegations racing in one tool batch
    /// cannot both see the same free places.
    public func reserve(_ children: [Reservation]) -> String? {
        let running = entries.values.filter { !$0.isFinished }.count
        if let duplicate = children.first(where: { entries[$0.id] != nil }) {
            return "A background sub-agent already has the id \(duplicate.id)."
        }
        if running + children.count > Self.maximumRunning {
            return "At most \(Self.maximumRunning) background sub-agents run at once and \(running) "
                + "\(running == 1 ? "is" : "are") running. Wait for them with await_subagents, "
                + "or stop one with cancel_subagent, before starting more."
        }
        if order.count + children.count > Self.maximumPerSession {
            return "This session has started \(order.count) background sub-agents, and it may start at most "
                + "\(Self.maximumPerSession). Do the rest yourself or in the foreground."
        }
        for child in children {
            entries[child.id] = Entry(
                id: child.id,
                title: child.title,
                agent: child.agent,
                status: .queued,
                startedAt: Date()
            )
            order.append(child.id)
        }
        return nil
    }

    /// Starts a reserved child's `work`, which reports its outcome. Nothing
    /// starts for an id that was never reserved or was already cancelled.
    public func start(
        id: String,
        work: @escaping @Sendable () async -> (status: SubagentStatus, answer: String)
    ) {
        guard let entry = entries[id], !entry.isFinished, tasks[id] == nil else { return }
        tasks[id] = Task { [weak self] in
            let outcome = await work()
            await self?.finish(id: id, status: outcome.status, answer: outcome.answer)
        }
    }

    /// Reserves and starts one child: ``reserve(_:)`` then ``start(id:work:)``.
    /// Returns why it could not start, or nil.
    @discardableResult
    public func launch(
        id: String,
        title: String,
        agent: String?,
        work: @escaping @Sendable () async -> (status: SubagentStatus, answer: String)
    ) -> String? {
        if let problem = reserve([Reservation(id: id, title: title, agent: agent)]) {
            return problem
        }
        start(id: id, work: work)
        return nil
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

import Foundation
import JunoCodeCore

/// The live controls for child agents that are currently executing.
///
/// A delegated agent is intentionally not a second conversation, but it still
/// owns a real permission coordinator and a real orchestrator. Keeping those
/// two capabilities in one short-lived registry lets the parent UI stop a
/// child or resolve one of its approvals without manufacturing a second
/// session controller or weakening the child's policy.
///
/// Entries exist only while the child is running. A missing entry therefore
/// means "the child is no longer controllable", not "try to reconstruct a
/// capability from the transcript".
public actor SubagentControlRegistry {
    private struct Entry: Sendable {
        let parentSessionID: CodeSessionID
        let permissions: PermissionCoordinator
        let orchestrator: AgentOrchestrator
    }

    private var entries: [CodeSessionID: Entry] = [:]

    public init() {}

    public func register(
        childSessionID: CodeSessionID,
        parentSessionID: CodeSessionID,
        permissions: PermissionCoordinator,
        orchestrator: AgentOrchestrator
    ) {
        entries[childSessionID] = Entry(
            parentSessionID: parentSessionID,
            permissions: permissions,
            orchestrator: orchestrator
        )
    }

    public func unregister(childSessionID: CodeSessionID) {
        entries.removeValue(forKey: childSessionID)
    }

    public func pendingApprovals(for childSessionID: CodeSessionID) async -> [ApprovalRequest] {
        guard let entry = entries[childSessionID] else { return [] }
        return await entry.permissions.pendingApprovals
    }

    /// Read controls only through the parent that delegated the child. Session
    /// ids are not authority: this prevents a stale inspector or future remote
    /// client from resolving an unrelated child's approval by guessing its id.
    public func pendingApprovals(
        for childSessionID: CodeSessionID, ownedBy parentSessionID: CodeSessionID
    ) async -> [ApprovalRequest] {
        guard let entry = entries[childSessionID], entry.parentSessionID == parentSessionID else { return [] }
        return await entry.permissions.pendingApprovals
    }

    public func resolve(
        childSessionID: CodeSessionID,
        approvalID: String,
        decision: ApprovalDecision
    ) async {
        guard let entry = entries[childSessionID] else { return }
        await entry.permissions.resolve(approvalID: approvalID, decision: decision)
    }

    public func sweepExpiredApprovals(for childSessionID: CodeSessionID) async {
        guard let entry = entries[childSessionID] else { return }
        await entry.permissions.sweepExpired()
    }

    /// Stop is idempotent. The child orchestrator denies its pending approvals
    /// before awaiting its run task, so the parent never remains blocked on a
    /// child approval after the reader presses Stop.
    public func stop(childSessionID: CodeSessionID) async {
        guard let entry = entries[childSessionID] else { return }
        await entry.orchestrator.stop()
    }

    @discardableResult
    public func stop(
        childSessionID: CodeSessionID, ownedBy parentSessionID: CodeSessionID
    ) async -> Bool {
        guard let entry = entries[childSessionID], entry.parentSessionID == parentSessionID else { return false }
        await entry.orchestrator.stop()
        return true
    }

    public func hasControl(for childSessionID: CodeSessionID) -> Bool {
        entries[childSessionID] != nil
    }

    /// Lowers every running child of the parent to at most `mode`, never
    /// raising one: what the reader lowering the parent's mode, or leaving
    /// Code for Ask or Plan, does to the work it delegated. A background
    /// child outlives the turn that started it, and must not keep authority
    /// its parent no longer has. Lowering revokes the child's pending
    /// approvals, as it does the parent's.
    public func capModes(ownedBy parentSessionID: CodeSessionID, at mode: PermissionMode) async {
        for entry in entries.values where entry.parentSessionID == parentSessionID {
            let current = await entry.permissions.permissionMode
            let capped = current.capped(at: mode)
            if capped != current { await entry.permissions.setMode(capped) }
        }
    }
}

// MARK: - Background sub-agents (CODE_AGENT_SPEC §5.2)

/// Children started with `delegate_task`'s `background: true`: no turn waits
/// on them, so they are kept here, by the parent that started them, until it
/// awaits, inspects or cancels them. The stop check reads `hasRunning` to
/// wait for them rather than finish (§1.4 rule 2).
///
/// A child is reachable only through its own parent: an id from another
/// session answers nothing, as with `SubagentControlRegistry`.
public actor BackgroundSubagents {
    public static let shared = BackgroundSubagents()

    /// One child as the parent sees it.
    public struct Snapshot: Hashable, Sendable {
        public let id: String
        public let title: String
        public let status: SubagentStatus
        /// Its final answer, once it has one.
        public let answer: String?
        public let startedAt: Date
        public let finishedAt: Date?
    }

    private struct Entry {
        let parentSessionID: CodeSessionID
        let title: String
        let task: Task<(SubagentStatus, String), Never>
        var status: SubagentStatus = .running
        var answer: String?
        let startedAt: Date
        var finishedAt: Date?
    }

    private var entries: [String: Entry] = [:]
    private var order: [String] = []
    private var stopWatchers: [CodeSessionID: UUID] = [:]

    /// How many of one parent's children may work at once. Each is a model
    /// run of its own, and a write child a worktree, so a model that keeps
    /// starting them must collect or stop some first.
    public static let maximumRunningPerParent = 4
    /// How many children one parent may start in all, finished ones
    /// included. The running cap alone let a model that collects or stops
    /// its children start four more, and four more, without end: each one a
    /// model run with its own spend, a write one a worktree on disk (Lane F's
    /// bound, kept when the integration chose this runtime over Lane F's).
    public static let maximumStartedPerParent = 16
    /// How many finished children a parent keeps for `await_subagents` and
    /// `inspect_subagent`; older ones are forgotten (their transcripts stay).
    public static let maximumFinishedPerParent = 32

    public init() {}

    /// Slots promised to calls that are about to start children.
    private var reserved: [CodeSessionID: Int] = [:]
    /// How many children each parent has started, forgotten ones included.
    private var started: [CodeSessionID: Int] = [:]

    /// How many more children the parent may start now: within both the
    /// running cap and what is left of the session's total.
    public func capacity(parentSessionID: CodeSessionID) -> Int {
        let running = entries.values.filter { $0.parentSessionID == parentSessionID && $0.finishedAt == nil }.count
        let held = reserved[parentSessionID, default: 0]
        let now = Self.maximumRunningPerParent - running - held
        let left = Self.maximumStartedPerParent - started[parentSessionID, default: 0] - held
        return max(0, min(now, left))
    }

    /// How many children the parent has started so far.
    public func startedCount(parentSessionID: CodeSessionID) -> Int {
        started[parentSessionID, default: 0]
    }

    /// Holds `count` slots for children about to start, all or none, so two
    /// calls running side by side cannot both take the last ones. Each
    /// `start` uses one.
    public func reserve(_ count: Int, parentSessionID: CodeSessionID) -> Bool {
        guard count <= capacity(parentSessionID: parentSessionID) else { return false }
        reserved[parentSessionID, default: 0] += count
        return true
    }

    /// Why `count` more children cannot start now, in words for the model, or
    /// nil when they can (and their slots are then held, as ``reserve(_:parentSessionID:)``).
    public func reserveOrRefuse(_ count: Int, parentSessionID: CodeSessionID) -> String? {
        if reserve(count, parentSessionID: parentSessionID) { return nil }
        let total = started[parentSessionID, default: 0] + reserved[parentSessionID, default: 0]
        if total + count > Self.maximumStartedPerParent {
            return "This session has started \(total) background sub-agents, and it may start at most "
                + "\(Self.maximumStartedPerParent). Do the rest yourself or delegate it in the foreground."
        }
        let limit = Self.maximumRunningPerParent
        let busy = limit - capacity(parentSessionID: parentSessionID)
        return "At most \(limit) background sub-agents can work at once, and \(busy) already are. "
            + "Collect results with await_subagents or stop one with cancel_subagent first."
    }

    /// Starts `work` as a child of `parentSessionID`.
    public func start(
        id: String,
        parentSessionID: CodeSessionID,
        title: String,
        work: @escaping @Sendable () async -> (SubagentStatus, String)
    ) {
        if let held = reserved[parentSessionID], held > 0 {
            reserved[parentSessionID] = held > 1 ? held - 1 : nil
        }
        started[parentSessionID, default: 0] += 1
        let task = Task { await work() }
        entries[id] = Entry(parentSessionID: parentSessionID, title: title, task: task, startedAt: Date())
        order.append(id)
        Task { [weak self] in
            let (status, answer) = await task.value
            await self?.finish(id: id, status: status, answer: answer)
        }
    }

    private func finish(id: String, status: SubagentStatus, answer: String) {
        guard var entry = entries[id] else { return }
        entry.status = entry.status == .cancelled ? .cancelled : status
        entry.answer = answer
        entry.finishedAt = Date()
        entries[id] = entry
        forgetOldFinished(parentSessionID: entry.parentSessionID)
    }

    /// Keeps a parent's newest finished children only.
    private func forgetOldFinished(parentSessionID: CodeSessionID) {
        let finished = order.filter { id in
            guard let entry = entries[id] else { return false }
            return entry.parentSessionID == parentSessionID && entry.finishedAt != nil
        }
        let excess = finished.count - Self.maximumFinishedPerParent
        guard excess > 0 else { return }
        let forgotten = Set(finished.prefix(excess))
        for id in forgotten { entries.removeValue(forKey: id) }
        order.removeAll { forgotten.contains($0) }
    }

    public func snapshot(id: String, parentSessionID: CodeSessionID) -> Snapshot? {
        guard let entry = entries[id], entry.parentSessionID == parentSessionID else { return nil }
        return Self.snapshot(id: id, entry)
    }

    /// The parent's children, oldest first.
    public func snapshots(parentSessionID: CodeSessionID) -> [Snapshot] {
        order.compactMap { id in
            guard let entry = entries[id], entry.parentSessionID == parentSessionID else { return nil }
            return Self.snapshot(id: id, entry)
        }
    }

    /// Whether any child of the parent is still working.
    public func hasRunning(parentSessionID: CodeSessionID) -> Bool {
        entries.values.contains { $0.parentSessionID == parentSessionID && $0.finishedAt == nil }
    }

    /// Waits until every named child has finished or `timeout` passes, and
    /// answers where each one is.
    public func wait(
        ids: [String],
        parentSessionID: CodeSessionID,
        timeout: Duration
    ) async -> [Snapshot] {
        // Polled rather than awaited: awaiting a child's task cannot be
        // given up on when the timeout passes, and a wait that outlives its
        // timeout is a turn the reader cannot get back. The actor is free
        // between polls, so children finish into it meanwhile.
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        func allFinished() -> Bool {
            ids.allSatisfy { id in
                guard let entry = entries[id], entry.parentSessionID == parentSessionID else { return true }
                return entry.finishedAt != nil
            }
        }
        while !allFinished(), clock.now < deadline, !Task.isCancelled {
            try? await Task.sleep(for: .milliseconds(50))
        }
        return ids.compactMap { snapshot(id: $0, parentSessionID: parentSessionID) }
    }

    /// Stops one child. Answers false for an id the parent does not own.
    @discardableResult
    public func cancel(id: String, parentSessionID: CodeSessionID) -> Bool {
        guard var entry = entries[id], entry.parentSessionID == parentSessionID else { return false }
        if entry.finishedAt == nil {
            entry.status = .cancelled
            entries[id] = entry
            entry.task.cancel()
        }
        return true
    }

    /// Stops every child of the parent: what Stop on the parent does.
    public func cancelAll(parentSessionID: CodeSessionID) {
        for (id, entry) in entries where entry.parentSessionID == parentSessionID && entry.finishedAt == nil {
            cancel(id: id, parentSessionID: parentSessionID)
        }
    }

    /// Cancels the parent's children when the reader stops the parent.
    public func cancelOnStop(parentSessionID: CodeSessionID, store: CodeSessionStore) async {
        guard stopWatchers[parentSessionID] == nil else { return }
        let token = await store.addObserver { [weak self] update in
            guard case let .sessionChanged(session) = update, session.id == parentSessionID,
                  session.status == .stopping || session.status == .cancelled
            else { return }
            Task { await self?.cancelAll(parentSessionID: parentSessionID) }
        }
        stopWatchers[parentSessionID] = token
    }

    private static func snapshot(id: String, _ entry: Entry) -> Snapshot {
        Snapshot(
            id: id,
            title: entry.title,
            status: entry.status,
            answer: entry.answer,
            startedAt: entry.startedAt,
            finishedAt: entry.finishedAt
        )
    }
}

/// The parent's controls over its background children.
public enum SubagentControlTools {
    public static func all(
        parentSessionID _: CodeSessionID,
        background: BackgroundSubagents = .shared
    ) -> [any CodeTool] {
        [
            AwaitSubagentsTool(background: background),
            InspectSubagentTool(background: background),
            CancelSubagentTool(background: background),
        ]
    }

    static func describe(_ snapshot: BackgroundSubagents.Snapshot, full: Bool) -> String {
        var text = "## \(snapshot.title) (\(snapshot.id)): \(snapshot.status.rawValue)"
        if let answer = snapshot.answer {
            let body = full || answer.utf8.count <= 16 * 1_024 ? answer : String(answer.prefix(16 * 1_024)) + "\n…"
            text += "\n" + body
        } else {
            text += "\nStill working."
        }
        return text
    }
}

/// `await_subagents {ids, timeout_s}`.
public struct AwaitSubagentsTool: CodeTool {
    private let background: BackgroundSubagents
    public static let maximumTimeoutSeconds = 600.0

    public init(background: BackgroundSubagents = .shared) {
        self.background = background
    }

    public let name = "await_subagents"
    public let description = """
        Wait for sub-agents started with delegate_task background: true, and \
        return each one's result. Without ids, waits for all of this \
        session's background sub-agents. Returns early with the ones still \
        working when timeout_s (default 120, at most 600) passes.
        """
    public var inputSchema: JSONValue {
        [
            "type": "object",
            "properties": [
                "ids": ["type": "array", "items": ["type": "string"]],
                "timeout_s": ["type": "number"],
            ],
        ]
    }

    public func assessRisk(input _: JSONValue) -> ActionRisk { .read }
    public func summary(input _: JSONValue) -> String { "Wait for sub-agents" }

    public func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        var ids = input["ids"]?.arrayValue?.compactMap(\.stringValue) ?? []
        if ids.isEmpty {
            ids = await background.snapshots(parentSessionID: context.sessionID).map(\.id)
        }
        guard !ids.isEmpty else {
            return ToolResult(content: "No background sub-agents were started in this session.")
        }
        let seconds = min(max(input["timeout_s"]?.numberValue ?? 120, 1), Self.maximumTimeoutSeconds)
        let snapshots = await background.wait(ids: ids, parentSessionID: context.sessionID, timeout: .seconds(seconds))
        try Task.checkCancellation()
        let unknown = ids.filter { id in !snapshots.contains { $0.id == id } }
        let running = snapshots.filter { $0.finishedAt == nil }.count
        var lines = ["\(snapshots.count - running) of \(snapshots.count) finished."]
        lines += snapshots.map { SubagentControlTools.describe($0, full: false) }
        if !unknown.isEmpty { lines.append("Unknown ids: " + unknown.joined(separator: ", ")) }
        return ToolResult(content: lines.joined(separator: "\n\n"), isError: snapshots.isEmpty)
    }
}

/// `inspect_subagent {id}`.
public struct InspectSubagentTool: CodeTool {
    private let background: BackgroundSubagents

    public init(background: BackgroundSubagents = .shared) {
        self.background = background
    }

    public let name = "inspect_subagent"
    public let description = "Where one background sub-agent is, and its result when it has finished."
    public var inputSchema: JSONValue {
        ["type": "object", "properties": ["id": ["type": "string"]], "required": ["id"]]
    }

    public func assessRisk(input _: JSONValue) -> ActionRisk { .read }
    public func summary(input: JSONValue) -> String { "Inspect sub-agent \(input["id"]?.stringValue ?? "")" }

    public func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        let id = input["id"]?.stringValue ?? ""
        guard let snapshot = await background.snapshot(id: id, parentSessionID: context.sessionID) else {
            return ToolResult(content: "No background sub-agent \(id) in this session.", isError: true)
        }
        return ToolResult(content: SubagentControlTools.describe(snapshot, full: true))
    }
}

/// `cancel_subagent {id}`.
public struct CancelSubagentTool: CodeTool {
    private let background: BackgroundSubagents

    public init(background: BackgroundSubagents = .shared) {
        self.background = background
    }

    public let name = "cancel_subagent"
    public let description = "Stop one background sub-agent. Its work so far stays in its own transcript."
    public var inputSchema: JSONValue {
        ["type": "object", "properties": ["id": ["type": "string"]], "required": ["id"]]
    }

    public func assessRisk(input _: JSONValue) -> ActionRisk { .read }
    public func summary(input: JSONValue) -> String { "Stop sub-agent \(input["id"]?.stringValue ?? "")" }

    public func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        let id = input["id"]?.stringValue ?? ""
        guard await background.cancel(id: id, parentSessionID: context.sessionID) else {
            return ToolResult(content: "No background sub-agent \(id) in this session.", isError: true)
        }
        return ToolResult(content: "Stopped sub-agent \(id).")
    }
}

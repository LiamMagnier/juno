import Foundation

/// Who is using the screen.
public struct ScreenControlHolder: Hashable, Codable, Sendable {
    public enum Kind: String, Hashable, Codable, Sendable {
        /// A Juno Code session.
        case codeSession
        /// A Juno Work task.
        case workTask
        /// A subscription agent (Claude, Codex, an ACP agent) driving the Mac
        /// through the env server's Alevr MCP server (Code v2 SPEC §3.12).
        case connectedAgent

        /// The cross-process record's kind.
        var fileKind: DesktopLockFile.Record.Kind {
            switch self {
            case .codeSession: .codeSession
            case .workTask: .workTask
            case .connectedAgent: .envServer
            }
        }
    }

    /// Stable per claimant: a session id or a Work run id.
    public var id: String
    public var kind: Kind
    /// What it is doing, in the reader's words: the session or task title.
    public var title: String
    /// The app it is driving now, once it has one.
    public var appName: String?
    /// The conversation it belongs to, when that differs from `id`: a
    /// connected agent's env-server thread (its subagents share it).
    public var threadID: String?

    public init(id: String, kind: Kind, title: String, appName: String? = nil, threadID: String? = nil) {
        self.id = id
        self.kind = kind
        self.title = title
        self.appName = appName
        self.threadID = threadID
    }

    /// The conversation to open, and the one "is this me?" compares.
    public var conversationID: String { threadID ?? id }

    /// "Alevr is using TextEdit for ‘Fix the export sheet’".
    public var sentence: String {
        let what = appName.map { "Alevr is using \($0)" } ?? "Alevr is already using apps"
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            switch kind {
            case .workTask: return what + " for a Work task"
            case .connectedAgent: return what + " for a connected agent"
            case .codeSession: return what + " in another session"
            }
        }
        return "\(what) for ‘\(trimmed)’"
    }

    /// "‘Fix the export sheet’", or what it is when it has no title.
    public var name: String {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { return "‘\(trimmed)’" }
        switch kind {
        case .workTask: return "A Work task"
        case .connectedAgent: return "Another conversation"
        case .codeSession: return "Another session"
        }
    }

    /// Work tasks drive the shared pointer and keyboard; nothing runs beside them.
    var drivesWholeScreen: Bool { kind == .workTask }
}

/// One live hold, for the Screen tab and the menu bar.
public struct ScreenControlHold: Hashable, Sendable {
    public var holder: ScreenControlHolder
    /// The app it owns now (its current target), by bundle id, lowercased.
    public var bundleID: String?
    /// It has the whole display (takeover) or is a Work task: nothing else may act.
    public var exclusive: Bool
    public var lastActive: Date

    public init(holder: ScreenControlHolder, bundleID: String? = nil, exclusive: Bool = false, lastActive: Date = Date()) {
        self.holder = holder
        self.bundleID = bundleID
        self.exclusive = exclusive
        self.lastActive = lastActive
    }

    /// Whether this hold is in the way of an action on `app` (a bundle id
    /// or a name). Nil `app`: any app.
    public func blocks(app: String?) -> Bool {
        if exclusive { return true }
        guard let app = app?.lowercased(), !app.isEmpty else { return bundleID != nil || holder.appName != nil }
        return bundleID == app || holder.appName?.lowercased() == app
    }
}

/// The proof a claimant holds the lock. Only the lock makes them.
public struct ScreenControlClaim: Hashable, Sendable {
    public let holderID: String
    fileprivate let generation: UInt64
}

/// Why everything stopped.
public enum ScreenControlStopReason: String, Hashable, Codable, Sendable {
    /// The Stop button in a session.
    case stopButton
    /// Esc, anywhere.
    case escapeKey
    /// "Stop Juno using apps" in the menu bar.
    case menuBar
    /// The app is quitting, or the account signed out.
    case appQuit
    /// The reader gave this conversation's app to another one (Take over),
    /// or it sat idle while another conversation needed that app.
    case handedOff

    public var sentence: String {
        switch self {
        case .stopButton: "You pressed Stop."
        case .escapeKey: "You pressed Esc."
        case .menuBar: "You stopped Alevr from the menu bar."
        case .appQuit: "Alevr is closing."
        case .handedOff: "Another conversation took over this app."
        }
    }
}

/// The app-wide arbiter of who may drive what (CODE_AGENT_SPEC §3.2, CU-09,
/// Code v2 SPEC §3.12).
///
/// Many conversations may use computer use at once. Each owns the one app
/// it is working in (its target): a second conversation reaching for that
/// app is refused with a sentence naming the first, and can be given it with
/// Take over. Different apps run side by side, because background input goes
/// to each app's own process (Accessibility first, then events posted to its
/// pid) and never moves the reader's pointer. Two things are exclusive: a
/// Work task (it drives the shared pointer) and a session in takeover (it
/// has the whole display).
///
/// Nothing outlives its owner. A hold lives in this process's memory, so a
/// relaunch starts empty; a release, a stop, a session's end or the turn's
/// end lets it go; and a hold that has been quiet for ``idleLimit`` with no
/// call in flight is reclaimed the moment someone else needs its app.
///
/// One record in ``DesktopLockFile`` stands for this whole process while it
/// holds anything, so a second copy of the app (a development build beside
/// the release) stays off the pointer. Its pid and heartbeat make it die with
/// the process.
public actor ScreenControlLock {
    struct Entry {
        var holder: ScreenControlHolder
        var generation: UInt64
        var bundleID: String?
        var exclusive: Bool
        var lastActive: Date
        var inFlight: Int
        var hold: ScreenControlHold {
            ScreenControlHold(holder: holder, bundleID: bundleID, exclusive: exclusive || holder.drivesWholeScreen, lastActive: lastActive)
        }
    }

    private var entries: [String: Entry] = [:]
    /// Holder ids, oldest claim first: the last is "the" holder for the
    /// single-holder surfaces (caption, menu bar).
    private var order: [String] = []
    private var generation: UInt64 = 0
    private var stopListeners: [UUID: @Sendable (ScreenControlStopReason) -> Void] = [:]
    private var holderListeners: [UUID: @Sendable (ScreenControlHolder?) -> Void] = [:]
    private var holdsListeners: [UUID: @Sendable ([ScreenControlHold]) -> Void] = [:]
    private var evictionListeners: [UUID: @Sendable (String, ScreenControlStopReason) -> Void] = [:]
    /// The cross-process record other processes (another copy of the app)
    /// check before they touch the pointer. Nil in tests and wherever only
    /// this process drives the screen.
    private let file: DesktopLockFile?
    private var heartbeatTask: Task<Void, Never>?
    private var holdingFile = false
    private let heartbeatInterval: Duration
    private let now: @Sendable () -> Date
    /// How long a hold may sit with no call before another conversation that
    /// needs its app may reclaim it.
    public let idleLimit: TimeInterval

    public static let defaultIdleLimit: TimeInterval = 60

    public init(
        file: DesktopLockFile? = nil,
        heartbeatInterval: Duration = .seconds(5),
        idleLimit: TimeInterval = ScreenControlLock.defaultIdleLimit,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.file = file
        self.heartbeatInterval = heartbeatInterval
        self.idleLimit = idleLimit
        self.now = now
    }

    /// This process's id in the cross-process record.
    nonisolated var processHolderID: String {
        "alevr-app:\(file?.pid ?? ProcessInfo.processInfo.processIdentifier)"
    }

    /// The most recent live holder, for the single-holder surfaces.
    public var currentHolder: ScreenControlHolder? {
        order.last.flatMap { entries[$0]?.holder }
    }

    /// Every live hold, oldest first.
    public var holds: [ScreenControlHold] {
        order.compactMap { entries[$0]?.hold }
    }

    public func hold(for holderID: String) -> ScreenControlHold? {
        entries[holderID]?.hold
    }

    // MARK: - Claims

    /// Starts a holder, or refuses naming whoever must run alone (a Work task,
    /// a takeover). The same claimant claiming again keeps its hold.
    public func claim(_ claimant: ScreenControlHolder) throws -> ScreenControlClaim {
        if var entry = entries[claimant.id] {
            entry.holder.kind = claimant.kind
            entry.holder.title = claimant.title
            if claimant.threadID != nil { entry.holder.threadID = claimant.threadID }
            if let app = claimant.appName { entry.holder.appName = app }
            entry.lastActive = now()
            entries[claimant.id] = entry
            notify()
            return ScreenControlClaim(holderID: claimant.id, generation: entry.generation)
        }
        let blockers = entries.values.filter { other in
            other.holder.id != claimant.id
                && (claimant.drivesWholeScreen || other.exclusive || other.holder.drivesWholeScreen)
        }
        try clearOrRefuse(blockers) { ScreenControlError.lockHeld(holder: $0.holder.sentence) }
        if let file, !holdingFile {
            switch file.acquire(holderID: processHolderID, kind: claimant.kind.fileKind, title: claimant.title, app: claimant.appName) {
            case .acquired:
                holdingFile = true
            case let .held(by: record):
                throw ScreenControlError.lockHeld(holder: record.sentence)
            case .contended:
                throw ScreenControlError.lockHeld(holder: "Another copy of Alevr is taking the desktop right now")
            }
        }
        generation &+= 1
        entries[claimant.id] = Entry(
            holder: claimant, generation: generation, bundleID: nil, exclusive: false, lastActive: now(), inFlight: 0
        )
        order.removeAll { $0 == claimant.id }
        order.append(claimant.id)
        notify()
        return ScreenControlClaim(holderID: claimant.id, generation: generation)
    }

    /// Makes `holderID` the owner of one app (its new target), letting go of
    /// the app it had. Refuses naming the conversation that owns it, unless
    /// that hold is stale (idle past ``idleLimit`` with nothing in flight),
    /// in which case it is reclaimed.
    public func claimApp(bundleID: String, name: String, for holderID: String) throws {
        guard var entry = entries[holderID] else { return }
        let key = bundleID.lowercased()
        let blockers = entries.values.filter { other in
            other.holder.id != holderID && (other.bundleID == key || other.exclusive || other.holder.drivesWholeScreen)
        }
        try clearOrRefuse(blockers) { other in
            if other.exclusive || other.holder.drivesWholeScreen { return ScreenControlError.lockHeld(holder: other.holder.sentence) }
            return ScreenControlError.appBusy(app: name, holder: other.holder.name)
        }
        entry = entries[holderID] ?? entry
        entry.bundleID = key
        entry.holder.appName = name
        entry.lastActive = now()
        entries[holderID] = entry
        notify()
    }

    /// The whole display for one holder (takeover), or back to its one app.
    public func setExclusive(_ exclusive: Bool, for holderID: String) throws {
        guard entries[holderID] != nil else { return }
        if exclusive {
            let others = entries.values.filter { $0.holder.id != holderID }
            try clearOrRefuse(others) { ScreenControlError.lockHeld(holder: $0.holder.sentence) }
        }
        entries[holderID]?.exclusive = exclusive
        entries[holderID]?.lastActive = now()
        notify()
    }

    /// Stale blockers go (their owners are told); a live one refuses.
    private func clearOrRefuse(_ blockers: [Entry], refusal: (Entry) -> ScreenControlError) throws {
        for blocker in blockers where isStale(blocker) {
            remove(blocker.holder.id, eviction: .handedOff)
        }
        if let live = blockers.first(where: { entries[$0.holder.id] != nil }) {
            throw refusal(live)
        }
    }

    /// Idle past the limit with no call in flight. Work tasks end with their
    /// run, never by idling.
    func isStale(_ entry: Entry) -> Bool {
        guard entry.inFlight == 0, !entry.holder.drivesWholeScreen else { return false }
        return now().timeIntervalSince(entry.lastActive) > idleLimit
    }

    /// Whether a claim is still the live one.
    public func isValid(_ claim: ScreenControlClaim) -> Bool {
        entries[claim.holderID]?.generation == claim.generation
    }

    /// Activity: every action and every bridged call keeps a hold fresh.
    public func touch(_ holderID: String) {
        entries[holderID]?.lastActive = now()
    }

    /// A call is running for this holder (an approval card may be waiting):
    /// never stale meanwhile.
    public func beginCall(_ holderID: String) {
        entries[holderID]?.inFlight += 1
        entries[holderID]?.lastActive = now()
    }

    public func endCall(_ holderID: String) {
        guard let count = entries[holderID]?.inFlight else { return }
        entries[holderID]?.inFlight = max(0, count - 1)
        entries[holderID]?.lastActive = now()
    }

    // MARK: - Letting go

    /// Lets go. A claim from before a stop or a release does nothing.
    public func release(_ claim: ScreenControlClaim) {
        guard isValid(claim) else { return }
        remove(claim.holderID, eviction: nil)
    }

    /// Lets go for a holder by id, whatever claim it last had.
    public func release(holderID: String) {
        guard entries[holderID] != nil else { return }
        remove(holderID, eviction: nil)
    }

    /// The reader's Take over: another conversation's hold ends now and its
    /// owner is told why on its next call.
    public func evict(holderID: String) {
        guard entries[holderID] != nil else { return }
        remove(holderID, eviction: .handedOff)
    }

    /// Every hold of one conversation (a thread and its subagents).
    public func evict(conversationID: String) {
        for entry in entries.values where entry.holder.conversationID == conversationID {
            remove(entry.holder.id, eviction: .handedOff)
        }
    }

    /// The app the holder is now in, for the refusal sentence and the
    /// presence caption. Nil also gives the app up.
    public func setApp(_ appName: String?, for holderID: String) {
        guard entries[holderID] != nil else { return }
        entries[holderID]?.holder.appName = appName
        if appName == nil { entries[holderID]?.bundleID = nil }
        notify()
    }

    /// The one stop: releases every hold and tells every listener (every
    /// Code session and every Work task) to stop too.
    public func stopAll(reason: ScreenControlStopReason) {
        entries = [:]
        order = []
        generation &+= 1
        notify()
        for listener in stopListeners.values { listener(reason) }
    }

    private func remove(_ holderID: String, eviction: ScreenControlStopReason?) {
        entries[holderID] = nil
        order.removeAll { $0 == holderID }
        generation &+= 1
        notify()
        if let eviction {
            for listener in evictionListeners.values { listener(holderID, eviction) }
        }
    }

    // MARK: - Listeners

    @discardableResult
    public func addStopListener(_ listener: @escaping @Sendable (ScreenControlStopReason) -> Void) -> UUID {
        let id = UUID()
        stopListeners[id] = listener
        return id
    }

    @discardableResult
    public func addHolderListener(_ listener: @escaping @Sendable (ScreenControlHolder?) -> Void) -> UUID {
        let id = UUID()
        holderListeners[id] = listener
        listener(currentHolder)
        return id
    }

    /// Every change to the set of holds (the Screen tab's waiting line).
    @discardableResult
    public func addHoldsListener(_ listener: @escaping @Sendable ([ScreenControlHold]) -> Void) -> UUID {
        let id = UUID()
        holdsListeners[id] = listener
        listener(holds)
        return id
    }

    /// One holder lost its hold to another conversation.
    @discardableResult
    public func addEvictionListener(_ listener: @escaping @Sendable (String, ScreenControlStopReason) -> Void) -> UUID {
        let id = UUID()
        evictionListeners[id] = listener
        return id
    }

    public func removeListener(_ id: UUID) {
        stopListeners[id] = nil
        holderListeners[id] = nil
        holdsListeners[id] = nil
        evictionListeners[id] = nil
    }

    /// The holds as an async sequence, current value first.
    public nonisolated func holdUpdates() -> AsyncStream<[ScreenControlHold]> {
        AsyncStream { continuation in
            Task {
                let id = await self.addHoldsListener { continuation.yield($0) }
                continuation.onTermination = { _ in Task { await self.removeListener(id) } }
            }
        }
    }

    // MARK: - The cross-process record

    /// Keeps this process's record fresh while it holds anything, and lets
    /// it go when nothing is held.
    private func syncFile() {
        guard let file else { return }
        if let latest = currentHolder {
            if holdingFile {
                file.heartbeat(holderID: processHolderID, app: latest.appName)
            }
            guard heartbeatTask == nil else { return }
            let interval = heartbeatInterval
            heartbeatTask = Task { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(for: interval)
                    guard !Task.isCancelled else { return }
                    await self?.beat()
                }
            }
        } else {
            heartbeatTask?.cancel()
            heartbeatTask = nil
            if holdingFile { file.release(holderID: processHolderID) }
            holdingFile = false
        }
    }

    private func beat() {
        guard let file, holdingFile, let latest = currentHolder else { return }
        if !file.heartbeat(holderID: processHolderID, app: latest.appName) {
            // Someone removed our record (it went stale while the Mac slept):
            // take it back if it is free, so the other copy still sees us.
            switch file.acquire(holderID: processHolderID, kind: latest.kind.fileKind, title: latest.title, app: latest.appName) {
            case .acquired:
                holdingFile = true
            case .held, .contended:
                // Another copy of the app holds the desktop now. Driving on
                // would put two agents on one screen: stop here.
                holdingFile = false
                stopAll(reason: .handedOff)
            }
        }
    }

    private func notify() {
        syncFile()
        let snapshot = currentHolder
        for listener in holderListeners.values { listener(snapshot) }
        let all = holds
        for listener in holdsListeners.values { listener(all) }
    }
}

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

    public init(id: String, kind: Kind, title: String, appName: String? = nil) {
        self.id = id
        self.kind = kind
        self.title = title
        self.appName = appName
    }

    /// "Juno is using TextEdit for 'Fix the export sheet'".
    public var sentence: String {
        let what = appName.map { "Juno is using \($0)" } ?? "Juno is already using apps"
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

    public var sentence: String {
        switch self {
        case .stopButton: "You pressed Stop."
        case .escapeKey: "You pressed Esc."
        case .menuBar: "You stopped Juno from the menu bar."
        case .appQuit: "Juno is closing."
        }
    }
}

/// One lock for the whole app: every Code workspace and every Work task
/// (CODE_AGENT_SPEC §3.2, CU-09).
///
/// It used to be one coordinator per workspace, and Work ran its own stack,
/// so two workspaces and a phone-dispatched task could drive the same mouse
/// at once and a Stop stopped one of them. Now a second claimant is refused
/// with a sentence naming the first, and one stop releases everything.
public actor ScreenControlLock {
    private var holder: ScreenControlHolder?
    private var generation: UInt64 = 0
    private var stopListeners: [UUID: @Sendable (ScreenControlStopReason) -> Void] = [:]
    private var holderListeners: [UUID: @Sendable (ScreenControlHolder?) -> Void] = [:]
    /// The cross-process record other processes (the env server, another
    /// copy of the app) check before they touch the pointer. Nil in tests
    /// and wherever only this process drives the screen.
    private let file: DesktopLockFile?
    private var heartbeatTask: Task<Void, Never>?
    private var lastFileHolder: String?
    private let heartbeatInterval: Duration

    public init(file: DesktopLockFile? = nil, heartbeatInterval: Duration = .seconds(5)) {
        self.file = file
        self.heartbeatInterval = heartbeatInterval
    }

    public var currentHolder: ScreenControlHolder? { holder }

    /// Takes the lock, or refuses naming who has it. The same claimant
    /// claiming again keeps its lock (and gets a fresh claim).
    public func claim(_ claimant: ScreenControlHolder) throws -> ScreenControlClaim {
        if let holder, holder.id != claimant.id {
            throw ScreenControlError.lockHeld(holder: holder.sentence)
        }
        if let file {
            switch file.acquire(holderID: claimant.id, kind: claimant.kind.fileKind, title: claimant.title, app: claimant.appName ?? holder?.appName) {
            case .acquired:
                break
            case let .held(by: record):
                throw ScreenControlError.lockHeld(holder: record.sentence)
            case .contended:
                throw ScreenControlError.lockHeld(holder: "Another session is taking the desktop right now")
            }
        }
        if holder == nil { generation &+= 1 }
        var next = claimant
        if next.appName == nil { next.appName = holder?.appName }
        holder = next
        notifyHolder()
        return ScreenControlClaim(holderID: claimant.id, generation: generation)
    }

    /// Whether a claim is still the live one.
    public func isValid(_ claim: ScreenControlClaim) -> Bool {
        holder?.id == claim.holderID && claim.generation == generation
    }

    /// Lets go. A claim from before a stop or another holder does nothing.
    public func release(_ claim: ScreenControlClaim) {
        guard isValid(claim) else { return }
        holder = nil
        generation &+= 1
        notifyHolder()
    }

    /// Lets go for a holder by id, whatever claim it last had.
    public func release(holderID: String) {
        guard holder?.id == holderID else { return }
        holder = nil
        generation &+= 1
        notifyHolder()
    }

    /// The app the holder is now in, for the refusal sentence and the
    /// presence caption.
    public func setApp(_ appName: String?, for holderID: String) {
        guard holder?.id == holderID else { return }
        holder?.appName = appName
        notifyHolder()
    }

    /// The one stop: releases the lock and tells every listener — every
    /// Code session and every Work task — to stop too.
    public func stopAll(reason: ScreenControlStopReason) {
        holder = nil
        generation &+= 1
        notifyHolder()
        for listener in stopListeners.values { listener(reason) }
    }

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
        listener(holder)
        return id
    }

    public func removeListener(_ id: UUID) {
        stopListeners[id] = nil
        holderListeners[id] = nil
    }

    /// Keeps the file's heartbeat fresh while someone here holds the lock,
    /// and lets the file go when nobody does.
    private func syncFile(previous: String?) {
        guard let file else { return }
        if let previous, previous != holder?.id { file.release(holderID: previous) }
        if let holder {
            file.heartbeat(holderID: holder.id, app: holder.appName)
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
        }
    }

    private func beat() {
        guard let file, let holder else { return }
        file.heartbeat(holderID: holder.id, app: holder.appName)
    }

    private func notifyHolder() {
        syncFile(previous: lastFileHolder)
        lastFileHolder = holder?.id
        let snapshot = holder
        for listener in holderListeners.values { listener(snapshot) }
    }
}

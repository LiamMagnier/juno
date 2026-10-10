import Foundation
import JunoCodeCore

// The remote's pure state for one Mac: its session list with live states,
// every session the phone follows (snapshot + cursor, through the Mac's own
// CodeV2SessionReducer, so the phone applies events exactly as the Mac does),
// the global stream (terminal output, provider updates) and its cursor.

/// How a session reads in the list: words, never a badge.
public enum CodeLinkSessionStatus: Equatable, Sendable {
    case needsYou
    case working
    case limited
    case failed
    case idle

    public init(state: CodeV2.SessionState, hasPendingRequest: Bool = false) {
        if hasPendingRequest || state == .waiting { self = .needsYou; return }
        switch state {
        case .running: self = .working
        case .limited: self = .limited
        case .error: self = .failed
        case .idle, .waiting: self = .idle
        }
    }

    public var words: String {
        switch self {
        case .needsYou: "Needs you"
        case .working: "Working"
        case .limited: "Paused at its limit"
        case .failed: "Stopped with an error"
        case .idle: "Ready"
        }
    }

    /// Coral is kept for these two: something is happening, or it waits on you.
    public var isLive: Bool { self == .needsYou || self == .working }

    /// Needs you first, then working, then the rest.
    var rank: Int {
        switch self {
        case .needsYou: 0
        case .working: 1
        default: 2
        }
    }
}

/// One Mac's remote state. A value: tests drive it with envelopes.
public struct CodeLinkRemoteState: Equatable, Sendable {
    /// What the list shows, by session id.
    public private(set) var sessions: [String: CodeV2.SessionSummary] = [:]
    /// Sessions the phone follows (opened here), by id.
    public private(set) var threads: [String: CodeV2SessionState] = [:]
    /// The global stream's cursor (-1 before anything).
    public private(set) var globalCursor = -1
    /// Terminal screens by id, from `terminal.output`.
    public private(set) var terminals: [String: CodeV2TerminalScreen] = [:]
    public private(set) var exitedTerminals: [String: Int?] = [:]
    /// Provider instances updated on the global stream.
    public private(set) var providerUpdates: [String: CodeV2.ProviderInstance] = [:]

    public init() {}

    /// What the caller must do after applying a batch.
    public enum Effect: Equatable, Sendable {
        /// A sequence gap: `session.open {sessionId, cwd, afterSequence}`.
        case reopen(sessionId: String, cwd: String, afterSequence: Int?)
    }

    // MARK: Session list

    /// Replaces the list with `session.list`, keeping what live events said
    /// about a session when they are newer than the list's row.
    public mutating func setSessions(_ list: [CodeV2.SessionSummary]) {
        var next: [String: CodeV2.SessionSummary] = [:]
        for var summary in list {
            if let thread = threads[summary.id], let cursor = thread.cursor, cursor >= summary.lastSequence {
                summary.state = thread.snapshot.state
                summary.title = thread.snapshot.title ?? summary.title
                summary.lastSequence = cursor
                if let known = sessions[summary.id], Self.date(known.updatedAt) > Self.date(summary.updatedAt) {
                    summary.updatedAt = known.updatedAt
                }
            }
            next[summary.id] = summary
        }
        // A session followed here but missing from the list (just created) stays.
        for (id, existing) in sessions where next[id] == nil && threads[id] != nil {
            next[id] = existing
        }
        sessions = next
    }

    public func status(of sessionID: String) -> CodeLinkSessionStatus {
        if let thread = threads[sessionID] {
            return CodeLinkSessionStatus(
                state: thread.snapshot.state,
                hasPendingRequest: !CodeV2TurnFolding.pendingRequests(in: thread.snapshot.items).isEmpty
            )
        }
        return CodeLinkSessionStatus(state: sessions[sessionID]?.state ?? .idle)
    }

    /// Needs you first, then working, then newest first.
    public var orderedSessions: [CodeV2.SessionSummary] {
        sessions.values.sorted { a, b in
            let ra = status(of: a.id).rank, rb = status(of: b.id).rank
            if ra != rb { return ra < rb }
            if a.updatedAt != b.updatedAt { return Self.date(a.updatedAt) > Self.date(b.updatedAt) }
            return a.id < b.id
        }
    }

    static func date(_ iso: String) -> Date { CodeV2Dates.parse(iso) ?? .distantPast }

    // MARK: Following

    /// Starts following a session; the first poll asks from cursor -1.
    public mutating func follow(_ summary: CodeV2.SessionSummary) {
        sessions[summary.id] = sessions[summary.id] ?? summary
        guard threads[summary.id] == nil else { return }
        threads[summary.id] = CodeV2SessionState(snapshot: CodeV2.SessionSnapshot(
            id: summary.id, cwd: summary.cwd, title: summary.title, selection: summary.selection, state: summary.state
        ))
    }

    public mutating func unfollow(_ sessionID: String) {
        threads[sessionID] = nil
    }

    /// The poll's cursors: each followed session's last applied sequence, -1 before its snapshot.
    public var cursors: [String: Int] {
        threads.mapValues { $0.cursor ?? -1 }
    }

    // MARK: Events

    /// Applies a poll's events in order. Duplicates and stale snapshots are
    /// dropped by `CodeV2.classify`; a gap stops that session's batch (the
    /// rest would be gaps too) and asks for one re-open.
    @discardableResult
    public mutating func apply(_ envelopes: [CodeV2.ServerEventEnvelope], now: Date = Date()) -> [Effect] {
        var effects: [Effect] = []
        var gapped = Set<String>()
        for envelope in envelopes {
            if envelope.stream == .global || envelope.sessionId == nil {
                applyGlobal(envelope)
                continue
            }
            guard let id = envelope.sessionId, !gapped.contains(id), var thread = threads[id] else { continue }
            switch CodeV2SessionReducer.apply(envelope, to: &thread) {
            case .none:
                threads[id] = thread
                touch(id, from: thread, at: envelope.at)
            case let .reopen(afterSequence):
                gapped.insert(id)
                effects.append(.reopen(sessionId: id, cwd: thread.snapshot.cwd, afterSequence: afterSequence))
            }
        }
        return effects
    }

    private mutating func applyGlobal(_ envelope: CodeV2.ServerEventEnvelope) {
        guard envelope.sequence > globalCursor else { return }
        globalCursor = envelope.sequence
        switch envelope.event {
        case let .terminalOutput(terminalId, data):
            var screen = terminals[terminalId] ?? CodeV2TerminalScreen()
            screen.feed(data)
            terminals[terminalId] = screen
        case let .terminalExited(terminalId, exitCode):
            exitedTerminals[terminalId] = exitCode
        case let .providerUpdated(instance):
            providerUpdates[instance.id] = instance
        default:
            break
        }
    }

    /// The list row follows the live thread.
    private mutating func touch(_ id: String, from thread: CodeV2SessionState, at: String) {
        guard var summary = sessions[id] else { return }
        summary.state = thread.snapshot.state
        if let title = thread.snapshot.title, !title.isEmpty { summary.title = title }
        summary.selection = thread.snapshot.selection
        if let cursor = thread.cursor { summary.lastSequence = max(summary.lastSequence, cursor) }
        if Self.date(at) > Self.date(summary.updatedAt) { summary.updatedAt = at }
        sessions[id] = summary
    }

    /// A terminal the phone opened starts with an empty screen.
    public mutating func openedTerminal(_ terminalId: String) {
        if terminals[terminalId] == nil { terminals[terminalId] = CodeV2TerminalScreen() }
        exitedTerminals[terminalId] = nil
    }

    /// Resets everything (switching Mac, signing out).
    public mutating func reset() { self = CodeLinkRemoteState() }
}

import Foundation
import JunoCore
import JunoDesignSystem

/// The status each chat's row carries, from the account's task list: the web's
/// `conversation-status.ts` joined the way `useWorkRunsByConversation` joins
/// it for the sidebar.
///
/// Pure, so the rules the column and the Mac's signals depend on — which run
/// is a chat's, whether it is still the reader's business, whether it has
/// stopped for them — can be asserted without a window, a poll or a clock.
///
/// Every failure this guards against is a row that lies: a dot on a chat with
/// nothing running, no dot on one that stopped to ask a question, or a dot
/// taken from an older run than the one the reader would open.
public struct WorkRunsByConversation: Equatable, Sendable {
    /// What one chat's row says about its newest run.
    public struct Signal: Equatable, Sendable {
        public let conversationID: String
        /// The newest session in the chat, by `lastActivityAt`.
        public let session: WorkSessionSummary
        /// The status the row reports: the session's, as the caller reads it
        /// (the Mac corrects a run whose Mac has gone), or `waiting_approval`
        /// while a run on this Mac holds an approval the server has not heard
        /// of yet.
        public let status: JunoWorkStatus
        /// Still the reader's business: the row carries a dot.
        public let isOpen: Bool
        /// Stopped for the reader: the row sits in Needs you.
        public let needsYou: Bool

        public var tone: JunoStatusTone { JunoStatusTone(status) }
    }

    /// Every chat with a task, keyed by conversation id — open or not.
    public let signals: [String: Signal]

    public static let empty = WorkRunsByConversation(signals: [:])

    private init(signals: [String: Signal]) {
        self.signals = signals
    }

    /// - Parameters:
    ///   - sessions: the account's task list, in any order; a page is fine.
    ///   - status: how a session's status is read. Defaults to the raw wire
    ///     value, with anything unreadable taken as `interrupted` (terminal,
    ///     and claiming nothing about who decided, as the server's fallback).
    ///   - pendingLocalRunIDs: runs executing on this Mac that are holding an
    ///     approval for the reader. Such a run needs them now, before the
    ///     server's status catches up.
    public init(
        sessions: [WorkSessionSummary],
        status: (WorkSessionSummary) -> JunoWorkStatus = WorkRunsByConversation.reportedStatus,
        pendingLocalRunIDs: Set<String> = []
    ) {
        var signals: [String: Signal] = [:]
        for (conversationID, session) in Self.newestPerConversation(sessions) {
            var reported = status(session)
            var needsAttention = session.needsAttention
            if let runID = session.currentRunID, pendingLocalRunIDs.contains(runID) {
                needsAttention = true
                if !reported.needsAttention { reported = .waitingApproval }
            }
            signals[conversationID] = Signal(
                conversationID: conversationID,
                session: session,
                status: reported,
                isOpen: Self.isOpen(reported, needsAttention: needsAttention),
                needsYou: Self.needsYou(reported, needsAttention: needsAttention)
            )
        }
        self.init(signals: signals)
    }

    /// The row's signal while its run is open; nil once it has finished, so a
    /// chat that delegated something long ago is a chat again.
    public func openSignal(for conversationID: String) -> Signal? {
        guard let signal = signals[conversationID], signal.isOpen else { return nil }
        return signal
    }

    /// The chats whose newest run has stopped for the reader.
    public var needsYou: Set<String> {
        Set(signals.values.filter(\.needsYou).map(\.conversationID))
    }

    // MARK: - The web's rules

    /// A session's status as the wire says it.
    public static func reportedStatus(_ session: WorkSessionSummary) -> JunoWorkStatus {
        JunoWorkStatus(rawValue: session.status) ?? .interrupted
    }

    /// `workRunIsOpen`: needs attention (by flag or status) wins outright,
    /// even over a finished status — `host_offline` is over and still carries
    /// a decision. Otherwise any live status but `draft`, which was composed
    /// and never dispatched, so nothing is happening behind that row.
    public static func isOpen(_ status: JunoWorkStatus, needsAttention: Bool) -> Bool {
        if needsAttention || status.needsAttention { return true }
        if status.isTerminal { return false }
        return status != .draft
    }

    /// `workRunNeedsYou`: stopped for a person. Narrower than open — a running
    /// or paused task is open and needs nobody.
    public static func needsYou(_ status: JunoWorkStatus, needsAttention: Bool) -> Bool {
        needsAttention || status.needsAttention
    }

    /// `newestPerConversation`: the newest session per chat by
    /// `lastActivityAt`, whatever order the list came in. A session with no
    /// conversation has no row to light up and is dropped; on a tie the one
    /// listed first keeps the row, as the web's strict comparison does.
    public static func newestPerConversation(
        _ sessions: [WorkSessionSummary]
    ) -> [String: WorkSessionSummary] {
        var newest: [String: WorkSessionSummary] = [:]
        for session in sessions {
            guard let conversationID = session.conversationID, !conversationID.isEmpty else { continue }
            if let held = newest[conversationID], held.lastActivityAt >= session.lastActivityAt { continue }
            newest[conversationID] = session
        }
        return newest
    }
}

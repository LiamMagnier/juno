import Foundation
import JunoCodeCore
import JunoCodeLocal
import JunoScreenControl
import Observation

/// Approvals connected agents ask the reader for, outside a thread's own
/// event stream: computer use through the Mac bridge (may this agent use
/// apps, may it act now) and approvals from a subscription subagent that an
/// Alevr-engine thread started. They show as the Studio approval card: in
/// the composer of the thread they belong to when it is on screen, else as
/// one card over the window.
///
/// Nothing is ever approved by default. A request waits for the reader; if
/// no window can show it, the app is asked to bring one forward. Quitting
/// declines everything still waiting.
@MainActor
@Observable
public final class CodeV2ConnectedApprovals {
    public static let shared = CodeV2ConnectedApprovals()

    public struct Pending: Identifiable, Equatable, Sendable {
        public let id: UUID
        /// The env-server session the request belongs to, when known.
        public let sessionID: String?
        public let request: CodeV2.ApprovalRequest
        /// The target, cropped from the screen (computer actions only).
        public let crop: Data?
    }

    public private(set) var pending: [Pending] = []
    /// Threads whose composer is on screen now: their requests show inline.
    public private(set) var visibleSessions: [String: Int] = [:]
    /// Window-level cards attached (the root view's overlay).
    public private(set) var presenters = 0

    /// The app's way to bring a window forward when nothing can show a card.
    @ObservationIgnored public var summon: (@MainActor () -> Void)?
    @ObservationIgnored private var waiting: [UUID: CheckedContinuation<CodeV2.ApprovalDecision, Never>] = [:]

    public init() {}

    /// Asks the reader. Returns their decision; `.decline` when the app quits.
    public func ask(_ request: CodeV2.ApprovalRequest, sessionID: String?, crop: Data? = nil) async -> CodeV2.ApprovalDecision {
        let id = UUID()
        return await withCheckedContinuation { continuation in
            waiting[id] = continuation
            pending.append(Pending(id: id, sessionID: sessionID, request: request, crop: crop))
            if presenters == 0, sessionID.map({ visibleSessions[$0, default: 0] == 0 }) ?? true {
                summon?()
            }
        }
    }

    public func respond(_ id: UUID, _ decision: CodeV2.ApprovalDecision) {
        pending.removeAll { $0.id == id }
        waiting.removeValue(forKey: id)?.resume(returning: decision)
    }

    /// Requests a thread shows inline in its own composer.
    public func pending(forSession sessionID: String) -> [Pending] {
        pending.filter { $0.sessionID == sessionID }
    }

    /// Requests the window-level card shows: those no visible thread holds.
    public var unclaimed: [Pending] {
        pending.filter { item in
            guard let sessionID = item.sessionID else { return true }
            return visibleSessions[sessionID, default: 0] == 0
        }
    }

    public func showing(session sessionID: String) {
        visibleSessions[sessionID, default: 0] += 1
    }

    public func hiding(session sessionID: String) {
        let count = visibleSessions[sessionID, default: 0] - 1
        visibleSessions[sessionID] = count > 0 ? count : nil
    }

    public func attachPresenter() { presenters += 1 }
    public func detachPresenter() { presenters = max(0, presenters - 1) }

    /// Previews and snapshots: a request with nobody waiting on it.
    func preview(_ item: Pending) {
        pending.append(item)
    }

    /// On quit: every open question is answered no.
    public func declineAll() {
        for item in pending { respond(item.id, .decline) }
    }
}

/// How a subagent client hands its approvals to the reader.
public struct CodeV2ConnectedApprovalSink: Sendable {
    public let ask: @Sendable (_ request: CodeV2.ApprovalRequest, _ sessionID: String?) async -> CodeV2.ApprovalDecision

    public init(ask: @escaping @Sendable (_ request: CodeV2.ApprovalRequest, _ sessionID: String?) async -> CodeV2.ApprovalDecision) {
        self.ask = ask
    }

    /// The app's queue.
    public static let shared = CodeV2ConnectedApprovalSink { request, sessionID in
        await CodeV2ConnectedApprovals.shared.ask(request, sessionID: sessionID)
    }

    func ask(_ request: CodeV2.ApprovalRequest, agentLabel: String) async -> CodeV2.ApprovalDecision {
        var labelled = request
        if labelled.detail == nil { labelled.detail = agentLabel }
        return await ask(labelled, nil)
    }
}

// MARK: - The computer bridge's say

/// Computer use by connected agents (Claude through the user's own `claude`,
/// Codex, ACP agents), asked as Studio approval cards: may the agent use
/// apps at all, may it have an app, may it do this now.
public final class StudioComputerBridgeApprover: ComputerBridgeApproving, Sendable {
    private let approvals: @Sendable (_ request: CodeV2.ApprovalRequest, _ sessionID: String, _ crop: Data?) async -> CodeV2.ApprovalDecision

    public init(
        approvals: @escaping @Sendable (_ request: CodeV2.ApprovalRequest, _ sessionID: String, _ crop: Data?) async -> CodeV2.ApprovalDecision = { request, sessionID, crop in
            await CodeV2ConnectedApprovals.shared.ask(request, sessionID: sessionID, crop: crop)
        }
    ) {
        self.approvals = approvals
    }

    public func allowAgent(sessionID: String, title: String) async -> Bool {
        let request = Self.request(
            sessionID: sessionID,
            summary: "Use apps on this Mac",
            justification: "For ‘\(title)’. Alevr shows every step on screen, asks before anything it can't undo, and Esc stops it.",
            options: [.acceptForSession, .decline]
        )
        let decision = await approvals(request, sessionID, nil)
        return decision == .acceptForSession || decision == .accept
    }

    public func approve(_ detail: ScreenApprovalDetail, summary: String, sessionID: String) async -> Bool {
        let request: CodeV2.ApprovalRequest
        var crop: Data?
        switch detail {
        case let .grants(proposal):
            request = Self.request(
                sessionID: sessionID, summary: proposal.summary,
                justification: "You can take it back at any time from Settings › Screen control."
            )
        case let .action(prepared):
            crop = prepared.crop
            request = Self.request(
                sessionID: sessionID, summary: prepared.summary,
                justification: prepared.floor == nil
                    ? "It wants to do this now."
                    : "This can send, buy, delete or sign in, so Alevr always asks."
            )
        case .takeover:
            request = Self.request(sessionID: sessionID, summary: summary, justification: nil)
        }
        let decision = await approvals(request, sessionID, crop)
        return decision == .accept || decision == .acceptForSession
    }

    static func request(
        sessionID: String, summary: String, justification: String?,
        options: [CodeV2.ApprovalDecision] = [.accept, .decline]
    ) -> CodeV2.ApprovalRequest {
        let id = "bridge-" + UUID().uuidString.lowercased()
        return CodeV2.ApprovalRequest(
            id: id, createdAt: ISO8601DateFormatter().string(from: Date()), callId: id, requestId: id,
            action: .computer, summary: summary, justification: justification,
            detail: "A connected agent", options: options, status: .pending
        )
    }
}

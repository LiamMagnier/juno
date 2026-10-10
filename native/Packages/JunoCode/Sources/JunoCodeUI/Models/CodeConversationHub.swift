import Foundation
import JunoCodeBridge
import JunoCodeCore
import JunoCodeRuntime

/// Conversations messaging each other, for the Alevr engine on this Mac
/// (src/lib/cross-conversation on the web has the shared rules).
///
/// The one place the three tools reach: Alevr's backend through
/// `BackendCodeConversationClient`, configured by the app once the reader is
/// signed in. It also keeps, per session, the chain a message started (so a
/// reply is the next hop and an exchange ends at the cap) until the reader
/// speaks in that session again.
public final class CodeConversationHub: CodeConversationMessaging, @unchecked Sendable {
    public static let shared = CodeConversationHub()

    private let lock = NSLock()
    private var client: BackendCodeConversationClient?
    private var chains: [String: CodeConversationChain] = [:]
    /// Session titles, by id, for the sender's name on a message.
    private var titleLookup: (@MainActor (CodeSessionID) -> String?)?

    public init() {}

    /// Set at sign-in; nil at sign-out. Without a client the tools are not offered.
    public func configure(client: BackendCodeConversationClient?) {
        lock.withLock { self.client = client }
    }

    public func configure(titles: @escaping @MainActor (CodeSessionID) -> String?) {
        lock.withLock { self.titleLookup = titles }
    }

    public var isConfigured: Bool { lock.withLock { client != nil } }

    private func requireClient() throws -> BackendCodeConversationClient {
        guard let client = lock.withLock({ client }) else {
            throw CodeConversationRefusal("Sign in to Alevr on this Mac so this session can reach your other conversations.")
        }
        return client
    }

    // MARK: Chains

    public func chain(for sessionID: CodeSessionID) async -> CodeConversationChain? {
        lock.withLock { chains[sessionID.value] }
    }

    func setChain(_ chain: CodeConversationChain?, for sessionID: CodeSessionID) {
        lock.withLock { chains[sessionID.value] = chain }
    }

    /// The reader spoke in this session: any chain a message started is over.
    public func noteUserInput(_ sessionID: CodeSessionID) async {
        setChain(nil, for: sessionID)
        await CodeConversationTurnCounter.shared.reset(sessionID: sessionID)
    }

    // MARK: CodeConversationMessaging

    public func isEnabled(for sessionID: CodeSessionID) async -> Bool {
        await MainActor.run { CodeDefaults.shared.crossMessagesEnabled(forSession: sessionID.value) }
    }

    public func list(from sessionID: CodeSessionID, product: String?, project: String?, query: String?) async throws -> [CodeConversationSummary] {
        try await requireClient().list(from: sessionID, product: product, project: project, query: query)
    }

    public func read(from sessionID: CodeSessionID, id: String, lastN: Int) async throws -> (title: String, messages: [CodeConversationExcerptMessage]) {
        try await requireClient().read(from: sessionID, id: id, lastN: lastN)
    }

    public func send(
        from sessionID: CodeSessionID, to: String, message: String, notifyWhenIdle: Bool,
        chain: CodeConversationChain?, sentThisTurn: Int
    ) async throws -> CodeConversationSendResult {
        let client = try requireClient()
        let lookup = lock.withLock { titleLookup }
        let title = await MainActor.run { lookup?(sessionID) } ?? "Code session"
        return try await client.send(
            from: sessionID, title: title, to: to, message: message,
            notifyWhenIdle: notifyWhenIdle, chain: chain, sentThisTurn: sentThisTurn
        )
    }

    /// Reports what became of a message this Mac was handed (no-op unsigned).
    func report(linkID: String?, status: String, error: String? = nil) async {
        guard let linkID, let client = lock.withLock({ client }) else { return }
        await client.report(linkID: linkID, status: status, error: error)
    }
}

/// Sessions that received a message from another conversation the reader has
/// not opened since: the sidebar sets their title like any other unread row
/// (medium weight, no mark).
@MainActor
@Observable
public final class CodeCrossInbox {
    public static let shared = CodeCrossInbox()
    public private(set) var unread: Set<String> = []

    public init() {}

    public func arrived(_ sessionID: CodeSessionID) {
        unread.insert(sessionID.value)
    }

    public func viewed(_ sessionID: CodeSessionID) {
        unread.remove(sessionID.value)
    }

    public func isUnread(_ sessionID: CodeSessionID) -> Bool {
        unread.contains(sessionID.value)
    }
}

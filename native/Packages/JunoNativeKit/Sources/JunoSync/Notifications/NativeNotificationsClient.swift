import Foundation
import JunoAPI
import JunoAuth
import JunoCore

/// One row of the inbox (`ClientNotification` in `src/lib/notify/types.ts`):
/// who it is from, what happened, where it opens, and whether it was read.
public struct NativeNotification: Identifiable, Equatable, Sendable {
    public enum Priority: String, Sendable {
        case urgent, high, normal, low
    }

    /// The agent a notification is about, as the server sends it: its face
    /// in the avatar vocabulary's raw words, which the app reads back into a
    /// face (`JunoAgentAvatar(shape:tone:eyes:mark:seed:)`).
    public struct Agent: Equatable, Sendable {
        public let id: String
        public let name: String
        public let avatarShape: String?
        public let avatarTone: String?
        public let avatarEyes: String?
        public let avatarMark: String?

        public init(
            id: String, name: String,
            avatarShape: String? = nil, avatarTone: String? = nil,
            avatarEyes: String? = nil, avatarMark: String? = nil
        ) {
            self.id = id
            self.name = name
            self.avatarShape = avatarShape
            self.avatarTone = avatarTone
            self.avatarEyes = avatarEyes
            self.avatarMark = avatarMark
        }
    }

    public let id: String
    public let type: String
    public let title: String
    public let body: String
    public let priority: Priority
    public let actionable: Bool
    /// The relative in-app path it opens (`/chat/…`, `/agents/…`, `/work/…`),
    /// or nil for news that goes nowhere.
    public let href: String?
    public let agent: Agent?
    public var readAt: Date?
    public let createdAt: Date

    public init(
        id: String, type: String = "work", title: String, body: String = "",
        priority: Priority = .normal, actionable: Bool = false, href: String? = nil,
        agent: Agent? = nil, readAt: Date? = nil, createdAt: Date
    ) {
        self.id = id
        self.type = type
        self.title = title
        self.body = body
        self.priority = priority
        self.actionable = actionable
        self.href = href
        self.agent = agent
        self.readAt = readAt
        self.createdAt = createdAt
    }

    public var isUnread: Bool { readAt == nil }

    /// `isPressing`: urgent and high are the rows a person is being asked to
    /// act on (an approval, a question); everything else is news, and news in
    /// the accent would teach the accent to mean nothing.
    public var isPressing: Bool { priority == .urgent || priority == .high }
}

/// The sidebar dot's source: how many are unread, and whether any unread one
/// is pressing.
public struct NativeNotificationsCount: Equatable, Sendable {
    public var unreadCount: Int
    public var urgent: Bool

    public init(unreadCount: Int, urgent: Bool) {
        self.unreadCount = unreadCount
        self.urgent = urgent
    }
}

/// One page of the inbox, newest first.
public struct NativeNotificationsPage: Equatable, Sendable {
    public var notifications: [NativeNotification]
    /// The account's unread total, not this page's.
    public var unreadCount: Int
    /// Passed back as `before` for the page before; nil at the end.
    public var nextBefore: String?

    public init(notifications: [NativeNotification], unreadCount: Int, nextBefore: String?) {
        self.notifications = notifications
        self.unreadCount = unreadCount
        self.nextBefore = nextBefore
    }
}

public enum NativeNotificationsError: Error, Equatable, LocalizedError, Sendable {
    case invalidIdentifier
    case server(statusCode: Int, code: String?)
    case malformedResponse

    public var errorDescription: String? {
        switch self {
        case .invalidIdentifier: "Juno could not read that notification."
        case .server(let statusCode, let code): "Juno could not load notifications (\(code ?? String(statusCode)))."
        case .malformedResponse: "Juno returned notifications this app cannot read."
        }
    }
}

/// The inbox's four routes (`/api/notifications…`), over the native bearer.
///
/// Shared by both apps and wired on the Mac only for now: the phone reads its
/// pushes, and the web's inbox arrives there with its own design.
public struct NativeNotificationsClient: Sendable {
    /// The server's own ceiling on a page.
    public static let maximumPageSize = 50

    private let sender: any NativeAuthenticatedRequestSending

    public init(sender: any NativeAuthenticatedRequestSending) {
        self.sender = sender
    }

    /// `GET /api/notifications?limit=&before=&unread=true`.
    public func page(
        limit: Int = 20,
        before: String? = nil,
        unreadOnly: Bool = false,
        for accountID: AccountID
    ) async throws -> NativeNotificationsPage {
        var query = [URLQueryItem(name: "limit", value: String(max(1, min(limit, Self.maximumPageSize))))]
        if let before, !before.isEmpty { query.append(URLQueryItem(name: "before", value: before)) }
        if unreadOnly { query.append(URLQueryItem(name: "unread", value: "true")) }
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/notifications",
                method: .get,
                queryItems: query,
                headers: try HTTPHeaders(["accept": "application/json"])
            ),
            for: accountID
        )
        try requireSuccess(response)
        let wire: PageWire
        do {
            wire = try JSONDecoder().decode(PageWire.self, from: response.body)
        } catch {
            throw NativeNotificationsError.malformedResponse
        }
        return NativeNotificationsPage(
            // A row this build cannot read (no id, no date) is dropped, not
            // the page: one bad row from a newer server must not empty the
            // inbox.
            notifications: wire.notifications.compactMap(\.notification),
            unreadCount: max(0, wire.unreadCount),
            nextBefore: wire.nextBefore
        )
    }

    /// `GET /api/notifications/count`: cheap enough to poll.
    public func count(for accountID: AccountID) async throws -> NativeNotificationsCount {
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/notifications/count",
                method: .get,
                headers: try HTTPHeaders(["accept": "application/json"])
            ),
            for: accountID
        )
        try requireSuccess(response)
        do {
            let wire = try JSONDecoder().decode(CountWire.self, from: response.body)
            return NativeNotificationsCount(unreadCount: max(0, wire.unreadCount), urgent: wire.urgent)
        } catch {
            throw NativeNotificationsError.malformedResponse
        }
    }

    /// `PATCH /api/notifications/{id}`. Idempotent; a 404 is a row that is not
    /// this account's any more and is not worth an error.
    public func markRead(id: String, for accountID: AccountID) async throws {
        guard JunoNotificationRoute.isValidIdentifier(id) else {
            throw NativeNotificationsError.invalidIdentifier
        }
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/notifications/\(id)",
                method: .patch,
                headers: try HTTPHeaders(["accept": "application/json"])
            ),
            for: accountID
        )
        if response.statusCode == 404 { return }
        try requireSuccess(response)
    }

    /// `POST /api/notifications {action: "mark_all_read"}`.
    public func markAllRead(for accountID: AccountID) async throws {
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/notifications",
                method: .post,
                headers: try HTTPHeaders([
                    "accept": "application/json",
                    "content-type": "application/json",
                ]),
                body: Data(#"{"action":"mark_all_read"}"#.utf8)
            ),
            for: accountID
        )
        try requireSuccess(response)
    }

    private func requireSuccess(_ response: HTTPResponse) throws {
        guard !(200...299).contains(response.statusCode) else { return }
        let code = try? JSONDecoder().decode(NativeAPIErrorEnvelope.self, from: response.body).error.code
        throw NativeNotificationsError.server(statusCode: response.statusCode, code: code)
    }
}

// MARK: - Wire

private struct PageWire: Decodable {
    let notifications: [RowWire]
    let unreadCount: Int
    let nextBefore: String?
}

private struct CountWire: Decodable {
    let unreadCount: Int
    let urgent: Bool
}

private struct RowWire: Decodable {
    struct AgentWire: Decodable {
        struct AvatarWire: Decodable {
            let shape: String?
            let tone: String?
            let eyes: String?
            let mark: String?
        }

        let id: String
        let name: String
        let avatar: AvatarWire?
    }

    let id: String?
    let type: String?
    let title: String?
    let body: String?
    let priority: String?
    let actionable: Bool?
    let href: String?
    let agent: AgentWire?
    let readAt: String?
    let createdAt: String?

    var notification: NativeNotification? {
        guard let id, !id.isEmpty, let createdAt = Self.date(createdAt) else { return nil }
        return NativeNotification(
            id: id,
            type: type ?? "",
            title: title ?? "",
            body: body ?? "",
            priority: priority.flatMap(NativeNotification.Priority.init(rawValue:)) ?? .normal,
            actionable: actionable ?? false,
            href: href,
            agent: agent.map {
                NativeNotification.Agent(
                    id: $0.id, name: $0.name,
                    avatarShape: $0.avatar?.shape, avatarTone: $0.avatar?.tone,
                    avatarEyes: $0.avatar?.eyes, avatarMark: $0.avatar?.mark
                )
            },
            readAt: Self.date(readAt),
            createdAt: createdAt
        )
    }

    private static func date(_ value: String?) -> Date? {
        guard let value else { return nil }
        return JunoJSONValue.string(value).date
    }
}

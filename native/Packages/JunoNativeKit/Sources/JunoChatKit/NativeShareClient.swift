import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync

/// A public link to a conversation or an artifact.
public struct NativeShare: Identifiable, Equatable, Sendable {
    public let id: String
    /// `CHAT` or `ARTIFACT`, as the server names it.
    public let kind: String
    /// The unguessable token in the URL. Held because it identifies the link in
    /// a log or a support conversation without pasting the whole URL.
    public let token: String
    /// Built by the SERVER, never assembled here. A client that composed its own
    /// share URL would have to know the deployment's public origin, and would
    /// hand out a broken link the moment that changed.
    public let url: URL
    public let title: String?
    public let snapshotAt: Date?
    public let views: Int
    public let createdAt: Date?

    public init(
        id: String,
        kind: String,
        token: String,
        url: URL,
        title: String?,
        snapshotAt: Date?,
        views: Int,
        createdAt: Date?
    ) {
        self.id = id
        self.kind = kind
        self.token = token
        self.url = url
        self.title = title
        self.snapshotAt = snapshotAt
        self.views = views
        self.createdAt = createdAt
    }
}

/// Creates, lists and revokes public share links.
///
/// A SHARE IS A SNAPSHOT, and both apps have to say so where a reader can see it.
/// The server records `snapshotAt` when the link is made; later turns in the same
/// conversation are not published by it. That is the single fact a person most
/// needs before they send a link to somebody, and it is why the sheet says
/// "Anyone with the link can read this conversation as it is now."
public struct NativeShareClient: Sendable {
    private let sender: any NativeAuthenticatedRequestSending

    public init(sender: any NativeAuthenticatedRequestSending) {
        self.sender = sender
    }

    /// Creates a link, or returns the existing one — the route is idempotent per
    /// target, so tapping Share twice does not litter the account with links.
    public func share(conversationID: String, for accountID: AccountID) async throws -> NativeShare {
        let body = CreateWire(kind: "CHAT", conversationId: conversationID)
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/share",
                method: .post,
                headers: try HTTPHeaders([
                    "accept": "application/json",
                    "content-type": "application/json",
                ]),
                body: try JSONEncoder().encode(body)
            ),
            for: accountID
        )
        guard (200...299).contains(response.statusCode),
              let wire = try? JSONDecoder().decode(CreateResponseWire.self, from: response.body),
              let share = wire.share.model
        else { throw NativeShareError.failed }
        return share
    }

    public func shares(for accountID: AccountID) async -> [NativeShare] {
        guard
            let request = try? NativeBearerRequest(
                path: "/api/share",
                method: .get,
                headers: try HTTPHeaders(["accept": "application/json"])
            ),
            let response = try? await sender.send(request, for: accountID),
            (200...299).contains(response.statusCode),
            let wire = try? JSONDecoder().decode(ListResponseWire.self, from: response.body)
        else { return [] }
        return wire.shares.compactMap(\.model)
    }

    /// Revoking is the only half of sharing that is urgent — a link sent to the
    /// wrong person is a live document until this returns — so it throws rather
    /// than failing quietly the way creation's siblings do.
    public func revoke(shareID: String, for accountID: AccountID) async throws {
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/share/\(shareID)",
                method: .delete,
                headers: try HTTPHeaders(["accept": "application/json"])
            ),
            for: accountID
        )
        guard (200...299).contains(response.statusCode) else { throw NativeShareError.failed }
    }
}

public enum NativeShareError: Error, Equatable, Sendable {
    case failed
}

private struct CreateWire: Encodable {
    let kind: String
    let conversationId: String
}

private struct ShareWire: Decodable {
    let id: String
    let kind: String
    let token: String
    let url: String
    let title: String?
    let snapshotAt: String?
    let views: Int?
    let createdAt: String?

    var model: NativeShare? {
        guard let url = URL(string: url) else { return nil }
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        func date(_ raw: String?) -> Date? {
            guard let raw else { return nil }
            return iso.date(from: raw) ?? plain.date(from: raw)
        }
        return NativeShare(
            id: id,
            kind: kind,
            token: token,
            url: url,
            title: title,
            snapshotAt: date(snapshotAt),
            views: views ?? 0,
            createdAt: date(createdAt)
        )
    }
}

private struct CreateResponseWire: Decodable {
    let share: ShareWire
}

private struct ListResponseWire: Decodable {
    let shares: [ShareWire]

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        shares = ((try? container.decodeIfPresent([ShareWire].self, forKey: .shares)) ?? nil) ?? []
    }

    private enum CodingKeys: String, CodingKey { case shares }
}

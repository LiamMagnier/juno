import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync

/// One announcement, as `serializeAnnouncement` (`src/lib/announcements.ts`)
/// sends it: a model launch or a product note, with an optional visual and up
/// to two links.
public struct NativeAnnouncement: Equatable, Sendable, Identifiable {
    public let id: String
    public let title: String
    public let description: String
    public let imageURL: URL?
    public let videoURL: URL?
    /// A provider id (`anthropic`, `openai`, …) whose mark stands in for a picture.
    public let provider: String?
    public let modelName: String?
    public let newsLabel: String?
    public let newsHref: String?
    public let ctaLabel: String?
    public let ctaHref: String?

    public init(
        id: String,
        title: String,
        description: String,
        imageURL: URL? = nil,
        videoURL: URL? = nil,
        provider: String? = nil,
        modelName: String? = nil,
        newsLabel: String? = nil,
        newsHref: String? = nil,
        ctaLabel: String? = nil,
        ctaHref: String? = nil
    ) {
        self.id = id
        self.title = title
        self.description = description
        self.imageURL = imageURL
        self.videoURL = videoURL
        self.provider = provider
        self.modelName = modelName
        self.newsLabel = newsLabel
        self.newsHref = newsHref
        self.ctaLabel = ctaLabel
        self.ctaHref = ctaHref
    }

    /// Whether the call to action has both halves; the web shows it only then.
    public var hasCallToAction: Bool {
        !(ctaLabel ?? "").isEmpty && !(ctaHref ?? "").isEmpty
    }
}

/// `GET /api/announcements` and `POST /api/announcements/{id}/dismiss`. Both
/// accept the native bearer.
public struct NativeAnnouncementsClient: Sendable {
    private let sender: any NativeAuthenticatedRequestSending

    public init(sender: any NativeAuthenticatedRequestSending) {
        self.sender = sender
    }

    /// The announcement this account has not dismissed, or nil.
    public func current(for accountID: AccountID) async throws -> NativeAnnouncement? {
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/announcements",
                headers: try HTTPHeaders(["accept": "application/json"])
            ),
            for: accountID
        )
        if let error = NativeWebRouteError.from(response, fallback: "Juno could not load announcements.") {
            throw error
        }
        return try Self.decode(response.body)
    }

    /// Records the dismissal on the server. The caller keeps its own record
    /// too, so a failure here only means the web may show it once more.
    public func dismiss(id: String, for accountID: AccountID) async throws {
        guard Self.isValidIdentifier(id) else { return }
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/announcements/\(id)/dismiss",
                method: .post,
                headers: try HTTPHeaders(["accept": "application/json"])
            ),
            for: accountID
        )
        if let error = NativeWebRouteError.from(response, fallback: "Juno could not dismiss the announcement.") {
            throw error
        }
    }

    /// Reads `{ announcement: … | null }`. Public for fixtures.
    public static func decode(_ data: Data) throws -> NativeAnnouncement? {
        let wire = try JSONDecoder().decode(ResponseWire.self, from: data)
        guard let item = wire.announcement, isValidIdentifier(item.id) else { return nil }
        return NativeAnnouncement(
            id: item.id,
            title: item.title,
            description: item.description,
            imageURL: item.imageUrl.flatMap(Self.url),
            videoURL: item.videoUrl.flatMap(Self.url),
            provider: item.provider,
            modelName: item.modelName,
            newsLabel: item.newsLabel,
            newsHref: item.newsHref,
            ctaLabel: item.ctaLabel,
            ctaHref: item.ctaHref
        )
    }

    /// Only absolute `https` media is loaded; a relative path is the web's own
    /// asset, which the caller resolves against the server.
    private static func url(_ value: String) -> URL? {
        guard let url = URL(string: value), url.scheme == "https" || value.hasPrefix("/") else { return nil }
        return url
    }

    static func isValidIdentifier(_ id: String) -> Bool {
        !id.isEmpty && id.count <= 200
            && id.unicodeScalars.allSatisfy { CharacterSet.alphanumerics.contains($0) || $0 == "-" || $0 == "_" }
    }

    private struct ResponseWire: Decodable {
        struct Item: Decodable {
            let id: String
            let title: String
            let description: String
            let imageUrl: String?
            let videoUrl: String?
            let provider: String?
            let modelName: String?
            let newsLabel: String?
            let newsHref: String?
            let ctaLabel: String?
            let ctaHref: String?
        }

        let announcement: Item?
    }
}

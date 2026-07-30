import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import Observation

/// One file the account has already shared with Juno.
public struct NativeLibraryItem: Identifiable, Equatable, Sendable {
    public let id: String
    public let fileName: String
    public let mimeType: String
    public let size: Int
    /// `IMAGE` or `FILE`, as the server writes it.
    public let kind: String
    public let createdAt: Date

    public init(
        id: String,
        fileName: String,
        mimeType: String,
        size: Int,
        kind: String,
        createdAt: Date
    ) {
        self.id = id
        self.fileName = fileName
        self.mimeType = mimeType
        self.size = size
        self.kind = kind
        self.createdAt = createdAt
    }

    public var isImage: Bool { kind.uppercased() == "IMAGE" }
}

public enum NativeLibraryError: Error, Equatable, LocalizedError, Sendable {
    case malformedResponse
    case server(statusCode: Int, message: String)

    public var errorDescription: String? {
        switch self {
        case .malformedResponse: "Juno returned an invalid library response."
        case .server(_, let message): message
        }
    }
}

/// Reads the account's library and clones items into fresh attachments.
///
/// The clone is the whole reason this exists rather than "attach the id you
/// already have". An attachment row carries the message it belongs to, and the
/// send path only claims rows with no message — so re-sending the original id
/// would either fail or, worse, move the file off the message it is currently
/// part of. `POST /api/library/attach` makes a new row against the **same stored
/// object**: no re-upload, no second copy of the bytes, and the old message
/// keeps its file.
public struct NativeLibraryClient: Sendable {
    private let sender: any NativeAuthenticatedRequestSending

    public init(sender: any NativeAuthenticatedRequestSending) {
        self.sender = sender
    }

    public func items(for accountID: AccountID) async throws -> [NativeLibraryItem] {
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/library",
                headers: try HTTPHeaders(["accept": "application/json"])
            ),
            for: accountID
        )
        guard (200...299).contains(response.statusCode) else { throw failure(response) }
        guard let decoded = try? JSONDecoder().decode(ItemsWire.self, from: response.body) else {
            throw NativeLibraryError.malformedResponse
        }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        return decoded.items.map { wire in
            NativeLibraryItem(
                id: wire.id,
                fileName: wire.fileName,
                mimeType: wire.mimeType,
                size: wire.size,
                kind: wire.kind,
                createdAt: formatter.date(from: wire.createdAt)
                    ?? plain.date(from: wire.createdAt)
                    ?? .distantPast
            )
        }
    }

    /// Clones `ids` into unlinked attachments the composer can send.
    ///
    /// The route caps a batch at ten, which is also the composer's own ceiling,
    /// so a caller that respects `hasCapacity` can never trip it.
    public func attach(
        ids: [String],
        for accountID: AccountID
    ) async throws -> [NativeUploadedAttachment] {
        guard !ids.isEmpty else { return [] }
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/library/attach",
                method: .post,
                headers: try HTTPHeaders([
                    "accept": "application/json",
                    "content-type": "application/json",
                ]),
                body: try JSONEncoder().encode(AttachRequestWire(attachmentIds: ids))
            ),
            for: accountID
        )
        guard (200...299).contains(response.statusCode) else { throw failure(response) }
        guard let decoded = try? JSONDecoder().decode(
            AttachResponseWire.self, from: response.body
        ) else { throw NativeLibraryError.malformedResponse }
        return decoded.attachments.map {
            NativeUploadedAttachment(
                id: $0.id,
                fileName: $0.fileName,
                mimeType: $0.mimeType,
                size: $0.size,
                kind: $0.kind
            )
        }
    }

    private func failure(_ response: HTTPResponse) -> NativeLibraryError {
        let envelope = try? JSONDecoder().decode(
            NativeAPIErrorEnvelope.self, from: response.body
        )
        return .server(
            statusCode: response.statusCode,
            message: envelope?.error.message
                ?? "Juno could not read your library (\(response.statusCode))."
        )
    }
}

/// The library picker's state: what is in the library, what is selected, and
/// whether a clone is in flight.
@MainActor
@Observable
public final class NativeLibraryModel {
    public enum Filter: String, CaseIterable, Identifiable, Sendable {
        case all
        case images
        case files

        public var id: String { rawValue }

        public var title: String {
            switch self {
            case .all: "All"
            case .images: "Images"
            case .files: "Files"
            }
        }
    }

    public private(set) var items: [NativeLibraryItem] = []
    public private(set) var isLoading = false
    public private(set) var isAttaching = false
    public private(set) var lastErrorDescription: String?
    public var filter: Filter = .all
    public var selection: Set<String> = []

    private let client: NativeLibraryClient
    /// Resolves a chosen file's bytes so the picker can draw it.
    ///
    /// Optional because the library list itself does not need one — and because
    /// a picker that cannot resolve bytes still works, it just shows every card
    /// in its typed fallback instead of showing the file. That is the honest
    /// degradation: a missing thumbnail, not a missing picker.
    private let previewSource: (any NativeFilePreviewResolving)?
    private var accountID: AccountID?

    public init(
        client: NativeLibraryClient,
        previewSource: (any NativeFilePreviewResolving)? = nil
    ) {
        self.client = client
        self.previewSource = previewSource
    }

    public func start(for accountID: AccountID) {
        self.accountID = accountID
    }

    public func stop() {
        accountID = nil
        items = []
        selection = []
        lastErrorDescription = nil
    }

    public var visibleItems: [NativeLibraryItem] {
        switch filter {
        case .all: items
        case .images: items.filter(\.isImage)
        case .files: items.filter { !$0.isImage }
        }
    }

    /// Reloads from the server. Called every time the picker opens, as the web
    /// does — the library changes whenever any client sends a file.
    public func refresh() async {
        guard let accountID, !isLoading else { return }
        isLoading = true
        lastErrorDescription = nil
        defer { isLoading = false }
        do {
            items = try await client.items(for: accountID)
        } catch {
            lastErrorDescription = NativeFailureMessage.presentable(error)
        }
    }

    /// Where a file's bytes are, for a thumbnail.
    ///
    /// The same route ``NativeProjectModel/accessFile(id:)`` takes: the sync
    /// `attachment` entity, rehydrated for a fresh signed URL. Library rows and
    /// project files are the same attachments underneath, so resolving them two
    /// different ways would only be two things to keep in step.
    public func accessFile(id: String) async -> NativeProjectFileAccess? {
        guard let accountID, let previewSource else { return nil }
        return try? await previewSource.accessFile(id: id, for: accountID)
    }

    public func toggle(_ id: String, limit: Int) {
        if selection.contains(id) {
            selection.remove(id)
        } else if selection.count < limit {
            selection.insert(id)
        }
    }

    /// Clones the selection and returns the fresh attachments, or nil on failure
    /// — in which case ``lastErrorDescription`` carries the server's own words.
    public func attachSelection() async -> [NativeUploadedAttachment]? {
        guard let accountID, !selection.isEmpty, !isAttaching else { return nil }
        isAttaching = true
        lastErrorDescription = nil
        defer { isAttaching = false }
        // Selection order is not meaningful in a `Set`, so present them in the
        // order the library itself does — newest first, the order on screen.
        let ordered = items.map(\.id).filter { selection.contains($0) }
        do {
            let attached = try await client.attach(ids: ordered, for: accountID)
            selection = []
            return attached
        } catch {
            lastErrorDescription = NativeFailureMessage.presentable(error)
            return nil
        }
    }
}

private struct ItemsWire: Decodable {
    struct Item: Decodable {
        let id: String
        let fileName: String
        let mimeType: String
        let size: Int
        let kind: String
        let createdAt: String
    }
    let items: [Item]
}

private struct AttachRequestWire: Encodable {
    let attachmentIds: [String]
}

private struct AttachResponseWire: Decodable {
    struct Attachment: Decodable {
        let id: String
        let fileName: String
        let mimeType: String
        let size: Int
        let kind: String
    }
    let attachments: [Attachment]
}

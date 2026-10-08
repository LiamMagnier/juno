import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import Observation

// MARK: - Values

/// One row of an artifact's paged history (`GET /api/artifacts/[id]/versions`).
/// Bodies are not listed; one is fetched on demand with
/// ``NativeArtifactAPIClient/versionContent(id:version:for:)``.
public struct NativeArtifactVersionSummary: Identifiable, Equatable, Sendable {
    public let version: Int
    public let origin: NativeArtifactOrigin?
    public let createdAt: Date

    public var id: Int { version }

    public init(version: Int, origin: NativeArtifactOrigin?, createdAt: Date) {
        self.version = version
        self.origin = origin
        self.createdAt = createdAt
    }
}

/// One page of history, newest first. `nextBefore` is the cursor for the page
/// after it, nil once version 1 has been listed.
public struct NativeArtifactVersionPage: Equatable, Sendable {
    public let currentVersion: Int
    /// The design editor's unsealed working copy, which is not a version.
    public let draftVersion: Int?
    public let versions: [NativeArtifactVersionSummary]
    public let nextBefore: Int?
}

/// A file the download route answered: one source file, or a ZIP.
public struct NativeArtifactDownload: Equatable, Sendable {
    public let data: Data
    public let fileName: String
    public let contentType: String

    public init(data: Data, fileName: String, contentType: String) {
        self.data = data
        self.fileName = fileName
        self.contentType = contentType
    }
}

/// What "Download" asks for: this version as its source file, or a ZIP of it
/// with up to 100 earlier versions under `history/` (the web's "Download
/// with history").
public enum NativeArtifactDownloadFormat: Equatable, Sendable {
    case file
    case zipWithHistory
}

/// A copy the duplicate route made: the new artifact and its web address.
public struct NativeArtifactDuplicate: Equatable, Sendable {
    public let artifact: NativeArtifactDetail
    public let path: String
}

/// A row of Recently deleted (`GET /api/artifacts?deleted=1`).
public struct NativeDeletedArtifact: Identifiable, Equatable, Sendable {
    public let id: String
    public let identifier: String
    public let title: String
    /// Nil for a type this build does not know; the row still lists and
    /// restores, because restoring needs only the id.
    public let kind: NativeArtifactKind?
    public let type: String
    public let language: String?
    public let version: Int
    public let conversationID: String?
    public let conversationTitle: String?
    public let deletedAt: Date?
    /// The day the trash purge may remove it for good.
    public let purgeAt: Date?
    public let updatedAt: Date

    public init(
        id: String, identifier: String, title: String, kind: NativeArtifactKind?, type: String,
        language: String?, version: Int, conversationID: String?, conversationTitle: String?,
        deletedAt: Date?, purgeAt: Date?, updatedAt: Date
    ) {
        self.id = id
        self.identifier = identifier
        self.title = title
        self.kind = kind
        self.type = type
        self.language = language
        self.version = version
        self.conversationID = conversationID
        self.conversationTitle = conversationTitle
        self.deletedAt = deletedAt
        self.purgeAt = purgeAt
        self.updatedAt = updatedAt
    }
}

// MARK: - Routes

/// The lifecycle half of the artifact routes — the web's
/// `artifact-lifecycle-actions.tsx` and the Library's Recently deleted:
/// duplicate, download, paged history, one version's body, the trash list and
/// restore. Shapes mirror the route handlers under `src/app/api/artifacts`.
extension NativeArtifactAPIClient {
    /// `POST /api/artifacts/[id]/duplicate` `{version}` → 201 `{artifact, url}`.
    public func duplicate(
        id: String,
        version: Int?,
        for accountID: AccountID
    ) async throws -> NativeArtifactDuplicate {
        try requireIdentifier(id)
        var body: [String: Int] = [:]
        if let version {
            guard version > 0 else { throw NativeArtifactAPIError.invalidContent }
            body["version"] = version
        }
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/artifacts/\(id)/duplicate",
                method: .post,
                headers: try JSONHeaders.value(),
                body: try JSONEncoder().encode(body)
            ),
            for: accountID
        )
        try requireSuccess(response)
        let wire: DuplicateWire
        do { wire = try JSONDecoder().decode(DuplicateWire.self, from: response.body) }
        catch { throw NativeArtifactAPIError.malformedResponse }
        let detail = try decodeArtifact(response.body, expectedID: nil)
        guard detail.id != id, wire.url.hasPrefix("/") else { throw NativeArtifactAPIError.malformedResponse }
        return NativeArtifactDuplicate(artifact: detail, path: wire.url)
    }

    /// `GET /api/artifacts/[id]/download?version=n[&format=zip&history=1]`.
    public func download(
        id: String,
        version: Int?,
        format: NativeArtifactDownloadFormat,
        fallbackName: String,
        for accountID: AccountID
    ) async throws -> NativeArtifactDownload {
        try requireIdentifier(id)
        var query: [URLQueryItem] = []
        if let version {
            guard version > 0 else { throw NativeArtifactAPIError.invalidContent }
            query.append(URLQueryItem(name: "version", value: String(version)))
        }
        if format == .zipWithHistory {
            query.append(URLQueryItem(name: "format", value: "zip"))
            query.append(URLQueryItem(name: "history", value: "1"))
        }
        let response = try await sender.send(
            try NativeBearerRequest(path: "/api/artifacts/\(id)/download", queryItems: query),
            for: accountID
        )
        try requireSuccess(response)
        let contentType = response.headers["content-type"] ?? "application/octet-stream"
        let named = Self.fileName(fromDisposition: response.headers["content-disposition"])
        let fallback = format == .zipWithHistory
            ? safeFileName(title: fallbackName, extension: "zip")
            : fallbackName
        return NativeArtifactDownload(data: response.body, fileName: named ?? fallback, contentType: contentType)
    }

    /// `GET /api/artifacts/[id]/versions?limit=&before=`, newest first.
    public func versionPage(
        id: String,
        before: Int? = nil,
        limit: Int = 50,
        for accountID: AccountID
    ) async throws -> NativeArtifactVersionPage {
        try requireIdentifier(id)
        var query = [URLQueryItem(name: "limit", value: String(min(100, max(1, limit))))]
        if let before {
            guard before > 0 else { throw NativeArtifactAPIError.invalidContent }
            query.append(URLQueryItem(name: "before", value: String(before)))
        }
        let response = try await sender.send(
            try NativeBearerRequest(path: "/api/artifacts/\(id)/versions", queryItems: query),
            for: accountID
        )
        try requireSuccess(response)
        let wire: VersionPageWire
        do { wire = try JSONDecoder().decode(VersionPageWire.self, from: response.body) }
        catch { throw NativeArtifactAPIError.malformedResponse }
        let versions = try wire.versions.map { row -> NativeArtifactVersionSummary in
            guard row.version > 0, let date = parseDate(row.createdAt) else {
                throw NativeArtifactAPIError.malformedResponse
            }
            return NativeArtifactVersionSummary(
                version: row.version,
                origin: row.origin.flatMap(NativeArtifactOrigin.init(rawValue:)),
                createdAt: date
            )
        }
        return NativeArtifactVersionPage(
            currentVersion: wire.currentVersion,
            draftVersion: wire.draft?.version,
            versions: versions,
            nextBefore: wire.nextBefore
        )
    }

    /// `GET /api/artifacts/[id]/versions/[version]` → `{version: {…, content}}`.
    public func versionContent(
        id: String,
        version: Int,
        for accountID: AccountID
    ) async throws -> NativeArtifactVersion {
        try requireIdentifier(id)
        guard version > 0 else { throw NativeArtifactAPIError.invalidContent }
        let response = try await sender.send(
            try NativeBearerRequest(path: "/api/artifacts/\(id)/versions/\(version)"),
            for: accountID
        )
        try requireSuccess(response)
        let wire: VersionBodyWire
        do { wire = try JSONDecoder().decode(VersionBodyWire.self, from: response.body) }
        catch { throw NativeArtifactAPIError.malformedResponse }
        guard wire.version.version == version, let date = parseDate(wire.version.createdAt) else {
            throw NativeArtifactAPIError.malformedResponse
        }
        return NativeArtifactVersion(
            id: "\(id)#\(version)",
            version: version,
            content: wire.version.content,
            origin: wire.version.origin.flatMap(NativeArtifactOrigin.init(rawValue:)),
            createdAt: date
        )
    }

    /// `GET /api/artifacts?deleted=1`, newest deletion first.
    public func recentlyDeleted(for accountID: AccountID) async throws -> [NativeDeletedArtifact] {
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/artifacts",
                queryItems: [URLQueryItem(name: "deleted", value: "1")]
            ),
            for: accountID
        )
        try requireSuccess(response)
        let wire: DeletedListWire
        do { wire = try JSONDecoder().decode(DeletedListWire.self, from: response.body) }
        catch { throw NativeArtifactAPIError.malformedResponse }
        return wire.items.compactMap { item in
            guard !item.id.isEmpty, let updatedAt = parseDate(item.updatedAt) else { return nil }
            return NativeDeletedArtifact(
                id: item.id,
                identifier: item.identifier,
                title: item.title,
                kind: NativeArtifactKind(rawValue: item.type.uppercased()),
                type: item.type,
                language: item.language,
                version: item.version,
                conversationID: item.conversationId,
                conversationTitle: item.conversationTitle,
                deletedAt: item.deletedAt.flatMap(parseDate),
                purgeAt: item.purgeAt.flatMap(parseDate),
                updatedAt: updatedAt
            )
        }
    }

    /// `POST /api/artifacts/[id]/restore` → `{artifact}`. Idempotent.
    public func restoreDeleted(id: String, for accountID: AccountID) async throws -> NativeArtifactDetail {
        try requireIdentifier(id)
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/artifacts/\(id)/restore",
                method: .post,
                headers: try HTTPHeaders(["accept": "application/json"])
            ),
            for: accountID
        )
        try requireSuccess(response)
        return try decodeArtifact(response.body, expectedID: id)
    }

    /// The file name a `Content-Disposition` names: the RFC 5987 `filename*`
    /// first (the route writes the real, non-ASCII name there), then the
    /// ASCII `filename`. Path separators are never kept.
    static func fileName(fromDisposition header: String?) -> String? {
        guard let header else { return nil }
        let parts = header.split(separator: ";").map { $0.trimmingCharacters(in: .whitespaces) }
        var extended: String?
        var plain: String?
        for part in parts {
            let lower = part.lowercased()
            if lower.hasPrefix("filename*=") {
                let value = String(part.dropFirst("filename*=".count))
                if let quote = value.range(of: "''") {
                    extended = String(value[quote.upperBound...]).removingPercentEncoding
                }
            } else if lower.hasPrefix("filename=") {
                var value = String(part.dropFirst("filename=".count))
                if value.hasPrefix("\""), value.hasSuffix("\""), value.count >= 2 {
                    value = String(value.dropFirst().dropLast())
                }
                plain = value
            }
        }
        guard let chosen = (extended ?? plain)?
            .replacingOccurrences(of: "/", with: " ")
            .replacingOccurrences(of: "\\", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !chosen.isEmpty
        else { return nil }
        return chosen
    }
}

private struct DuplicateWire: Decodable {
    let url: String
}

private struct VersionPageWire: Decodable {
    struct Row: Decodable {
        let version: Int
        let origin: String?
        let createdAt: String
    }
    struct Draft: Decodable { let version: Int }
    let currentVersion: Int
    let draft: Draft?
    let versions: [Row]
    let nextBefore: Int?
}

private struct VersionBodyWire: Decodable {
    struct Body: Decodable {
        let version: Int
        let origin: String?
        let content: String
        let createdAt: String
    }
    let version: Body
}

private struct DeletedListWire: Decodable {
    struct Item: Decodable {
        let id: String
        let identifier: String
        let title: String
        let type: String
        let language: String?
        let version: Int
        let conversationId: String?
        let conversationTitle: String?
        let deletedAt: String?
        let purgeAt: String?
        let updatedAt: String
    }
    let items: [Item]
}

// MARK: - Paged history

/// Version history, a page at a time — the web's "Version history…" dialog.
/// Opening a version's body is ``loadContent(of:)``.
@MainActor
@Observable
public final class NativeArtifactHistory {
    public enum Phase: Equatable, Sendable {
        case idle, loading, ready, failed
    }

    public let artifactID: String
    public private(set) var phase: Phase = .idle
    public private(set) var entries: [NativeArtifactVersionSummary] = []
    public private(set) var currentVersion: Int?
    public private(set) var nextBefore: Int?
    public private(set) var isLoadingMore = false
    public private(set) var errorDescription: String?

    public var hasMore: Bool { nextBefore != nil }

    private let client: NativeArtifactAPIClient
    private let accountID: AccountID
    private let pageSize: Int

    public init(artifactID: String, client: NativeArtifactAPIClient, accountID: AccountID, pageSize: Int = 50) {
        self.artifactID = artifactID
        self.client = client
        self.accountID = accountID
        self.pageSize = pageSize
    }

    /// The newest page, replacing whatever was listed.
    public func load() async {
        phase = .loading
        errorDescription = nil
        do {
            let page = try await client.versionPage(id: artifactID, limit: pageSize, for: accountID)
            entries = page.versions
            currentVersion = page.currentVersion
            nextBefore = page.nextBefore
            phase = .ready
        } catch {
            errorDescription = NativeFailureMessage.presentable(error)
            phase = .failed
        }
    }

    /// The page below the oldest listed version.
    public func loadMore() async {
        guard let before = nextBefore, !isLoadingMore else { return }
        isLoadingMore = true
        defer { isLoadingMore = false }
        do {
            let page = try await client.versionPage(id: artifactID, before: before, limit: pageSize, for: accountID)
            let known = Set(entries.map(\.version))
            entries.append(contentsOf: page.versions.filter { !known.contains($0.version) })
            nextBefore = page.nextBefore
            errorDescription = nil
        } catch {
            errorDescription = NativeFailureMessage.presentable(error)
        }
    }

    /// One version's body.
    public func loadContent(of version: Int) async -> NativeArtifactVersion? {
        do {
            return try await client.versionContent(id: artifactID, version: version, for: accountID)
        } catch {
            errorDescription = NativeFailureMessage.presentable(error)
            return nil
        }
    }
}

// MARK: - Recently deleted

/// Recently deleted artifacts and their restore — the Library's trash half
/// for made things (`/api/artifacts?deleted=1`, `/restore`).
@MainActor
@Observable
public final class NativeRecentlyDeletedArtifacts {
    public enum Phase: Equatable, Sendable {
        case idle, loading, ready, failed
    }

    public private(set) var phase: Phase = .idle
    public private(set) var items: [NativeDeletedArtifact] = []
    public private(set) var restoring: Set<String> = []
    public private(set) var errorDescription: String?

    private let client: NativeArtifactAPIClient
    private let accountID: AccountID
    private let restored: @MainActor (NativeArtifactDetail) async -> Void

    /// - Parameter restored: runs after a restore lands, so the owner can pull
    ///   the artifact back in through sync.
    public init(
        client: NativeArtifactAPIClient,
        accountID: AccountID,
        restored: @escaping @MainActor (NativeArtifactDetail) async -> Void = { _ in }
    ) {
        self.client = client
        self.accountID = accountID
        self.restored = restored
    }

    public func load() async {
        if items.isEmpty { phase = .loading }
        errorDescription = nil
        do {
            items = try await client.recentlyDeleted(for: accountID)
            phase = .ready
        } catch {
            errorDescription = NativeFailureMessage.presentable(error)
            phase = .failed
        }
    }

    /// Brings one back. Returns whether it landed; on success it leaves the list.
    @discardableResult
    public func restore(id: String) async -> Bool {
        guard !restoring.contains(id) else { return false }
        restoring.insert(id)
        defer { restoring.remove(id) }
        do {
            let detail = try await client.restoreDeleted(id: id, for: accountID)
            items.removeAll { $0.id == id }
            errorDescription = nil
            await restored(detail)
            return true
        } catch {
            errorDescription = NativeFailureMessage.presentable(error)
            return false
        }
    }
}

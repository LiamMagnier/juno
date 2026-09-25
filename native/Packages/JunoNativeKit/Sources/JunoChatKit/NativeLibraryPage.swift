import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import Observation

// MARK: - The query and the page

/// What the Library page asks `GET /api/library` for — the web's
/// `LibraryQuery` (`src/components/library/use-library.ts`).
public struct NativeLibraryQuery: Equatable, Sendable {
    public enum Kind: String, CaseIterable, Sendable {
        case all
        case image = "IMAGE"
        case file = "FILE"
    }

    /// The server's four orders (`library-query.ts` `ORDER_BY`).
    public enum Sort: String, CaseIterable, Sendable {
        case newest, oldest, name, size
    }

    /// Already debounced by the model; the raw field would fetch per keystroke.
    public var q: String
    public var kind: Kind
    public var sort: Sort
    /// The Recently deleted view.
    public var deleted: Bool

    public init(q: String = "", kind: Kind = .all, sort: Sort = .newest, deleted: Bool = false) {
        self.q = q
        self.kind = kind
        self.sort = sort
        self.deleted = deleted
    }

    /// Rows per request; the next page loads as the list's end comes into view.
    public static let pageSize = 60

    /// `?limit=&sort=[&q=][&kind=][&includeDeleted=true][&cursor=]`, as the
    /// web's `requestUrl` builds it.
    public func queryItems(cursor: String? = nil) -> [URLQueryItem] {
        var items = [
            URLQueryItem(name: "limit", value: String(Self.pageSize)),
            URLQueryItem(name: "sort", value: sort.rawValue),
        ]
        let trimmed = q.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { items.append(URLQueryItem(name: "q", value: trimmed)) }
        if kind != .all { items.append(URLQueryItem(name: "kind", value: kind.rawValue)) }
        if deleted { items.append(URLQueryItem(name: "includeDeleted", value: "true")) }
        if let cursor { items.append(URLQueryItem(name: "cursor", value: cursor)) }
        return items
    }

    /// Whether a row belongs in this view — the route's `where`, restated for
    /// the rows the client places itself (an Undo, a finished upload).
    public func matches(_ item: NativeLibraryItem) -> Bool {
        if kind != .all, item.kind.uppercased() != kind.rawValue { return false }
        let needle = q.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return needle.isEmpty || item.fileName.lowercased().contains(needle)
    }
}

/// The per-kind counts the first page carries.
public struct NativeLibraryCounts: Equatable, Sendable {
    public var all: Int
    public var images: Int
    public var files: Int

    public init(all: Int, images: Int, files: Int) {
        self.all = all
        self.images = images
        self.files = files
    }
}

/// The account's storage, as the first page reports it.
public struct NativeLibraryStorage: Equatable, Sendable {
    public var usedBytes: Int
    public var quotaBytes: Int
    public var remainingBytes: Int

    public init(usedBytes: Int, quotaBytes: Int, remainingBytes: Int) {
        self.usedBytes = usedBytes
        self.quotaBytes = quotaBytes
        self.remainingBytes = remainingBytes
    }
}

/// One answer from `GET /api/library`.
public struct NativeLibraryPage: Equatable, Sendable {
    public var items: [NativeLibraryItem]
    public var nextCursor: String?
    /// Only on the first page.
    public var counts: NativeLibraryCounts?
    public var total: Int?
    public var storage: NativeLibraryStorage?

    public init(
        items: [NativeLibraryItem],
        nextCursor: String? = nil,
        counts: NativeLibraryCounts? = nil,
        total: Int? = nil,
        storage: NativeLibraryStorage? = nil
    ) {
        self.items = items
        self.nextCursor = nextCursor
        self.counts = counts
        self.total = total
        self.storage = storage
    }

    /// Tolerant: unknown fields are ignored, an item missing a required field
    /// is dropped rather than failing the page, and an unknown `kind` is kept
    /// as the server wrote it. Nil only when the body is not an object with an
    /// `items` array.
    public static func decode(_ body: Data) -> NativeLibraryPage? {
        guard let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
            let rows = object["items"] as? [Any]
        else { return nil }
        let items = rows.compactMap { ($0 as? [String: Any]).flatMap(item(from:)) }
        var counts: NativeLibraryCounts?
        if let raw = object["counts"] as? [String: Any] {
            counts = NativeLibraryCounts(
                all: int(raw["all"]) ?? 0,
                images: int(raw["IMAGE"]) ?? 0,
                files: int(raw["FILE"]) ?? 0
            )
        }
        var storage: NativeLibraryStorage?
        if let raw = object["storage"] as? [String: Any], let used = int(raw["usedBytes"]), let quota = int(raw["quotaBytes"]) {
            storage = NativeLibraryStorage(
                usedBytes: used,
                quotaBytes: quota,
                remainingBytes: int(raw["remainingBytes"]) ?? max(0, quota - used)
            )
        }
        return NativeLibraryPage(
            items: items,
            nextCursor: object["nextCursor"] as? String,
            counts: counts,
            total: int(object["total"]),
            storage: storage
        )
    }

    static func item(from raw: [String: Any]) -> NativeLibraryItem? {
        guard let id = raw["id"] as? String, !id.isEmpty,
            let fileName = raw["fileName"] as? String
        else { return nil }
        var knowledge: NativeLibraryKnowledge?
        if let k = raw["knowledge"] as? [String: Any], let state = k["state"] as? String {
            knowledge = NativeLibraryKnowledge(
                state: state,
                error: k["error"] as? String,
                blockCount: int(k["blockCount"]),
                pageCount: int(k["pageCount"]),
                documentID: (k["documentId"] as? String) ?? (raw["documentId"] as? String)
            )
        }
        return NativeLibraryItem(
            id: id,
            fileName: fileName,
            mimeType: raw["mimeType"] as? String ?? "application/octet-stream",
            size: int(raw["size"]) ?? 0,
            kind: raw["kind"] as? String ?? "FILE",
            createdAt: date(raw["createdAt"]) ?? .distantPast,
            url: raw["url"] as? String,
            conversationID: raw["conversationId"] as? String,
            version: int(raw["version"]) ?? 1,
            versionCount: int(raw["versionCount"]) ?? 1,
            origin: raw["origin"] as? String,
            parserState: raw["parserState"] as? String,
            deletedAt: date(raw["deletedAt"]),
            inUse: (raw["inUse"] as? String).flatMap(NativeLibraryUse.init(rawValue:)),
            keptIn: (raw["keptIn"] as? String).flatMap(NativeLibraryUse.init(rawValue:)),
            knowledge: knowledge
        )
    }

    static func int(_ value: Any?) -> Int? {
        switch value {
        case let number as NSNumber: number.intValue
        case let text as String: Int(text)
        default: nil
        }
    }

    static func date(_ value: Any?) -> Date? {
        guard let text = value as? String else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }
}

/// One earlier version of a file (`GET /api/attachments/{id}/versions`).
public struct NativeLibraryVersion: Identifiable, Equatable, Sendable {
    public let version: Int
    public let current: Bool
    public let fileName: String
    public let size: Int
    public let createdAt: Date

    public var id: Int { version }

    public init(version: Int, current: Bool, fileName: String, size: Int, createdAt: Date) {
        self.version = version
        self.current = current
        self.fileName = fileName
        self.size = size
        self.createdAt = createdAt
    }
}

/// What a delete's toast says — the web's `removalNotice` (`REMOVAL_COPY`,
/// `library-types.ts`), told the way the delete will land.
public struct NativeLibraryRemovalNotice: Equatable, Sendable {
    public let title: String
    public let detail: String?

    public static func `for`(_ targets: [NativeLibraryItem]) -> NativeLibraryRemovalNotice {
        let kept = targets.compactMap(\.inUse)
        guard !kept.isEmpty else { return NativeLibraryRemovalNotice(title: "Moved to Recently deleted", detail: nil) }
        if targets.count == 1 {
            return NativeLibraryRemovalNotice(
                title: "Removed from your library",
                detail: kept[0] == .chat ? "It stays in the chat that uses it." : "It stays in the project that uses it."
            )
        }
        let same = kept.count == targets.count && kept.allSatisfy { $0 == kept[0] }
        let detail = same
            ? (kept[0] == .chat ? "They stay in the chats that use them." : "They stay in the projects that use them.")
            : "Chats and projects keep the files they use."
        return NativeLibraryRemovalNotice(title: "Removed from your library", detail: detail)
    }
}

// MARK: - The client

extension NativeLibraryClient {
    /// `GET /api/library?…` for one page of a query.
    public func page(
        _ query: NativeLibraryQuery,
        cursor: String? = nil,
        for accountID: AccountID
    ) async throws -> NativeLibraryPage {
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/library",
                queryItems: query.queryItems(cursor: cursor),
                headers: try HTTPHeaders(["accept": "application/json"])
            ),
            for: accountID
        )
        guard (200...299).contains(response.statusCode) else { throw failure(response) }
        guard let page = NativeLibraryPage.decode(response.body) else { throw NativeLibraryError.malformedResponse }
        return page
    }

    /// `DELETE /api/library/{id}`: a file a chat or project uses only leaves
    /// the Library; one nothing uses is deleted. Both land in Recently deleted.
    public func remove(id: String, for accountID: AccountID) async throws {
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/library/\(try Self.segment(id))",
                method: .delete,
                headers: try HTTPHeaders(["accept": "application/json"])
            ),
            for: accountID
        )
        guard (200...299).contains(response.statusCode) else { throw failure(response) }
    }

    /// `POST /api/attachments/{id}/restore`. A 404 is "no deleted file with
    /// that id": restored already, so it is not a failure.
    public func restore(id: String, for accountID: AccountID) async throws {
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/attachments/\(try Self.segment(id))/restore",
                method: .post,
                headers: try HTTPHeaders(["accept": "application/json"])
            ),
            for: accountID
        )
        guard (200...299).contains(response.statusCode) || response.statusCode == 404 else { throw failure(response) }
    }

    /// `PATCH /api/attachments/{id}` {fileName}; the server's name back.
    public func rename(id: String, fileName: String, for accountID: AccountID) async throws -> String {
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/attachments/\(try Self.segment(id))",
                method: .patch,
                headers: try HTTPHeaders(["accept": "application/json", "content-type": "application/json"]),
                body: try JSONSerialization.data(withJSONObject: ["fileName": fileName])
            ),
            for: accountID
        )
        guard (200...299).contains(response.statusCode) else { throw failure(response) }
        let object = try? JSONSerialization.jsonObject(with: response.body) as? [String: Any]
        return (object?["fileName"] as? String) ?? fileName
    }

    /// `GET /api/attachments/{id}/versions`: the current one, then the prior.
    public func versions(id: String, for accountID: AccountID) async throws -> [NativeLibraryVersion] {
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/attachments/\(try Self.segment(id))/versions",
                headers: try HTTPHeaders(["accept": "application/json"])
            ),
            for: accountID
        )
        guard (200...299).contains(response.statusCode) else { throw failure(response) }
        guard let object = try? JSONSerialization.jsonObject(with: response.body) as? [String: Any],
            let rows = object["versions"] as? [[String: Any]]
        else { throw NativeLibraryError.malformedResponse }
        return rows.compactMap { row in
            guard let version = NativeLibraryPage.int(row["version"]) else { return nil }
            return NativeLibraryVersion(
                version: version,
                current: row["current"] as? Bool ?? false,
                fileName: row["fileName"] as? String ?? "",
                size: NativeLibraryPage.int(row["size"]) ?? 0,
                createdAt: NativeLibraryPage.date(row["createdAt"]) ?? .distantPast
            )
        }
    }

    /// `POST /api/attachments/{id}/versions/{v}/restore`.
    public func restoreVersion(id: String, version: Int, for accountID: AccountID) async throws {
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/attachments/\(try Self.segment(id))/versions/\(version)/restore",
                method: .post,
                headers: try HTTPHeaders(["accept": "application/json"])
            ),
            for: accountID
        )
        guard (200...299).contains(response.statusCode) else { throw failure(response) }
    }

    /// One path segment: server-minted, no slash.
    static func segment(_ id: String) throws -> String {
        guard !id.isEmpty, id.count <= 200, !id.contains("/"), !id.contains("?"), !id.contains("#") else {
            throw NativeLibraryError.malformedResponse
        }
        return id
    }
}

// MARK: - The page model

/// A file on its way up (the web's `LibraryUpload`). It has no server id yet.
public struct NativeLibraryUpload: Identifiable, Equatable, Sendable {
    public enum Status: Equatable, Sendable {
        case uploading
        case failed(String, retryable: Bool)
    }

    public let id: UUID
    public let fileName: String
    public let size: Int
    public let isImage: Bool
    public var status: Status

    public init(id: UUID = UUID(), fileName: String, size: Int, isImage: Bool, status: Status = .uploading) {
        self.id = id
        self.fileName = fileName
        self.size = size
        self.isImage = isImage
        self.status = status
    }
}

/// Something the page should say in its toast host, in the web's words.
public enum NativeLibraryEvent: Equatable, Sendable {
    case deleteFailed(count: Int)
    case undoFailed
    case restored
    case restoreFailed(count: Int)
    case renameFailed(String)
    case loadMoreFailed
    case uploaded(hiddenByFilters: Bool)
    case uploadFailed(String)
    case versionRestored
    case versionRestoreFailed
}

/// The Library page's data and every change to it — the web's `useLibrary`.
///
/// Changes are **optimistic**: a delete takes the rows away in the frame it
/// was asked for and offers Undo, because a Library delete is a soft delete
/// with a restore endpoint behind it. Undo waits for the deletes to land, as
/// the web's does; a restore sent ahead of its delete finds nothing to
/// restore. A failure puts the rows back and says so.
@MainActor
@Observable
public final class NativeLibraryPageModel {
    public private(set) var query = NativeLibraryQuery()
    /// Nil while the first page of a new view is loading.
    public private(set) var items: [NativeLibraryItem]?
    public private(set) var counts: NativeLibraryCounts?
    public private(set) var total: Int?
    public private(set) var storage: NativeLibraryStorage?
    public private(set) var nextCursor: String?
    public private(set) var failed = false
    /// A new query is in flight while the previous answer stays on screen.
    public private(set) var pending = false
    public private(set) var loadingMore = false
    public private(set) var uploads: [NativeLibraryUpload] = []
    /// The last thing worth a toast; the page posts it and clears it.
    public private(set) var event: NativeLibraryEvent?

    /// The search field's text. The query follows it 200ms later.
    public var searchText = "" {
        didSet { scheduleSearch() }
    }

    public var hasMore: Bool { nextCursor != nil }

    private let client: NativeLibraryClient?
    private let uploader: NativeAttachmentAPIClient?
    private var accountID: AccountID?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var searchTask: Task<Void, Never>?
    @ObservationIgnored private var pendingUploadData: [UUID: (Data, String)] = [:]

    public init(client: NativeLibraryClient?, uploader: NativeAttachmentAPIClient? = nil) {
        self.client = client
        self.uploader = uploader
    }

    /// A model that never asks the network: the snapshot harness's and the
    /// tests' fixed states.
    public static func fixture(
        items: [NativeLibraryItem]?,
        counts: NativeLibraryCounts? = nil,
        storage: NativeLibraryStorage? = nil,
        query: NativeLibraryQuery = NativeLibraryQuery(),
        failed: Bool = false,
        uploads: [NativeLibraryUpload] = []
    ) -> NativeLibraryPageModel {
        let model = NativeLibraryPageModel(client: nil)
        model.items = items
        model.counts = counts
        model.total = counts?.all
        model.storage = storage
        model.query = query
        model.searchText = query.q
        model.failed = failed
        model.uploads = uploads
        model.searchTask?.cancel()
        return model
    }

    public func start(for accountID: AccountID) {
        self.accountID = accountID
    }

    public func stop() {
        accountID = nil
        items = nil
        counts = nil
        storage = nil
        uploads = []
    }

    public func clearEvent() { event = nil }

    // MARK: Query

    public func setKind(_ kind: NativeLibraryQuery.Kind) { update { $0.kind = kind } }
    public func setSort(_ sort: NativeLibraryQuery.Sort) { update { $0.sort = sort } }

    /// The Recently deleted view, or back to the files.
    public func setDeleted(_ deleted: Bool) {
        guard deleted != query.deleted else { return }
        // A different list, not a refinement: back to the skeleton.
        items = nil
        update { $0.deleted = deleted }
    }

    /// Clear filters: the search and the kind.
    public func clearFilters() {
        searchText = ""
        searchTask?.cancel()
        update {
            $0.q = ""
            $0.kind = .all
        }
    }

    private func update(_ change: (inout NativeLibraryQuery) -> Void) {
        var next = query
        change(&next)
        guard next != query else { return }
        query = next
        Task { await reload() }
    }

    private func scheduleSearch() {
        searchTask?.cancel()
        let text = searchText
        searchTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(200))
            guard !Task.isCancelled else { return }
            self?.update { $0.q = text }
        }
    }

    // MARK: Loading

    public func reload() async {
        guard let client, let accountID else { return }
        generation += 1
        let id = generation
        pending = true
        failed = false
        do {
            let page = try await client.page(query, for: accountID)
            guard id == generation else { return }
            items = page.items
            nextCursor = page.nextCursor
            counts = page.counts
            total = page.total
            if let storage = page.storage { self.storage = storage }
        } catch {
            guard id == generation else { return }
            failed = true
        }
        if id == generation { pending = false }
    }

    public func loadMore() async {
        guard let client, let accountID, let cursor = nextCursor, !loadingMore else { return }
        let from = generation
        loadingMore = true
        defer { loadingMore = false }
        do {
            let page = try await client.page(query, cursor: cursor, for: accountID)
            guard from == generation else { return }
            let seen = Set((items ?? []).map(\.id))
            items = (items ?? []) + page.items.filter { !seen.contains($0.id) }
            nextCursor = page.nextCursor
        } catch {
            if from == generation { event = .loadMoreFailed }
        }
    }

    // MARK: Rows

    /// Counts follow the rows: the segmented control never disagrees with
    /// the list.
    private func adjustCounts(_ rows: [NativeLibraryItem], sign: Int) {
        guard !rows.isEmpty else { return }
        if let total { self.total = max(0, total + sign * rows.count) }
        let hits = rows.filter { NativeLibraryQuery(q: query.q).matches($0) }
        guard !hits.isEmpty, var counts else { return }
        counts.all = max(0, counts.all + sign * hits.count)
        counts.images = max(0, counts.images + sign * hits.filter(\.isImage).count)
        counts.files = max(0, counts.files + sign * hits.filter { !$0.isImage }.count)
        self.counts = counts
    }

    private func removeRows(_ rows: [NativeLibraryItem]) {
        let onScreen = Set((items ?? []).map(\.id))
        let present = rows.filter { onScreen.contains($0.id) }
        guard !present.isEmpty else { return }
        let ids = Set(present.map(\.id))
        items = items?.filter { !ids.contains($0.id) }
        adjustCounts(present, sign: -1)
    }

    private func insertRows(_ rows: [NativeLibraryItem]) {
        let onScreen = Set((items ?? []).map(\.id))
        adjustCounts(rows.filter { !onScreen.contains($0.id) }, sign: 1)
        let visible = rows.filter { query.matches($0) }
        guard !visible.isEmpty, let current = items else { return }
        items = Self.insertSorted(current, visible, sort: query.sort, hasMore: nextCursor != nil)
    }

    /// Rows now live in the library or in Recently deleted on the server:
    /// into the list if that is the view on screen, out of it otherwise.
    private func place(_ rows: [NativeLibraryItem], inDeleted: Bool) {
        if query.deleted == inDeleted { insertRows(rows) } else { removeRows(rows) }
    }

    /// Merge rows into an already-sorted list without re-sorting it (the
    /// web's `insertSorted`): each goes in front of the first item it sorts
    /// before; a row past the end of a partial list waits for its page.
    public static func insertSorted(
        _ list: [NativeLibraryItem],
        _ rows: [NativeLibraryItem],
        sort: NativeLibraryQuery.Sort,
        hasMore: Bool
    ) -> [NativeLibraryItem] {
        guard !rows.isEmpty else { return list }
        let incoming = Set(rows.map(\.id))
        var next = list.filter { !incoming.contains($0.id) }
        for row in rows.sorted(by: { precedes($0, $1, sort) }) {
            if let at = next.firstIndex(where: { precedes(row, $0, sort) }) {
                next.insert(row, at: at)
            } else if !hasMore {
                next.append(row)
            }
        }
        return next
    }

    /// The server's orders (`compareItems`).
    static func precedes(_ a: NativeLibraryItem, _ b: NativeLibraryItem, _ sort: NativeLibraryQuery.Sort) -> Bool {
        switch sort {
        case .newest: a.createdAt != b.createdAt ? a.createdAt > b.createdAt : a.id > b.id
        case .oldest: a.createdAt != b.createdAt ? a.createdAt < b.createdAt : a.id < b.id
        case .name:
            switch a.fileName.localizedStandardCompare(b.fileName) {
            case .orderedAscending: true
            case .orderedDescending: false
            case .orderedSame: a.id < b.id
            }
        case .size: a.size != b.size ? a.size > b.size : a.id > b.id
        }
    }

    // MARK: Actions

    /// A delete in flight, for its toast's Undo.
    public struct Deletion: Sendable {
        public let notice: NativeLibraryRemovalNotice
        let targets: [NativeLibraryItem]
        let settled: Task<[String: Bool], Never>
    }

    /// Moves files to Recently deleted, optimistically. The page posts the
    /// returned notice with Undo; failures come back as an ``event``.
    public func delete(_ targets: [NativeLibraryItem]) -> Deletion {
        removeRows(targets)
        let client = client
        let accountID = accountID
        let settled = Task { () -> [String: Bool] in
            guard let client, let accountID else { return Dictionary(uniqueKeysWithValues: targets.map { ($0.id, true) }) }
            var outcome: [String: Bool] = [:]
            await withTaskGroup(of: (String, Bool).self) { group in
                for target in targets {
                    group.addTask {
                        do {
                            try await client.remove(id: target.id, for: accountID)
                            return (target.id, true)
                        } catch {
                            return (target.id, false)
                        }
                    }
                }
                for await (id, ok) in group { outcome[id] = ok }
            }
            return outcome
        }
        let deletion = Deletion(notice: .for(targets), targets: targets, settled: settled)
        Task {
            let outcome = await settled.value
            let failed = targets.filter { outcome[$0.id] == false }
            guard !failed.isEmpty else { return }
            place(failed, inDeleted: false)
            event = .deleteFailed(count: failed.count)
        }
        return deletion
    }

    /// Undo a delete: waits for the deletes to land, puts the rows back, and
    /// restores them. Restores that fail go back to Recently deleted.
    public func undo(_ deletion: Deletion) async {
        let outcome = await deletion.settled.value
        let landed = deletion.targets.filter { outcome[$0.id] == true }
        guard !landed.isEmpty else { return }
        place(landed, inDeleted: false)
        let failed = await restoreEach(landed)
        if !failed.isEmpty {
            place(failed, inDeleted: true)
            event = .undoFailed
        }
    }

    /// Brings files back from Recently deleted.
    public func restore(_ targets: [NativeLibraryItem]) async {
        guard !targets.isEmpty else { return }
        removeRows(targets)
        let failed = await restoreEach(targets)
        if failed.isEmpty {
            event = .restored
        } else {
            place(failed, inDeleted: true)
            event = .restoreFailed(count: failed.count)
        }
    }

    private func restoreEach(_ targets: [NativeLibraryItem]) async -> [NativeLibraryItem] {
        guard let client, let accountID else { return [] }
        var failed: [NativeLibraryItem] = []
        await withTaskGroup(of: NativeLibraryItem?.self) { group in
            for target in targets {
                group.addTask {
                    do {
                        try await client.restore(id: target.id, for: accountID)
                        return nil
                    } catch {
                        return target
                    }
                }
            }
            for await item in group { if let item { failed.append(item) } }
        }
        return failed
    }

    /// Renames a file; true when the new name was saved.
    @discardableResult
    public func rename(_ target: NativeLibraryItem, to name: String) async -> Bool {
        guard let client, let accountID else { return false }
        do {
            let saved = try await client.rename(id: target.id, fileName: name, for: accountID)
            items = items?.map { item in
                guard item.id == target.id else { return item }
                var copy = item
                copy.fileName = saved
                return copy
            }
            return true
        } catch {
            let message = (error as? LocalizedError)?.errorDescription
            event = .renameFailed(message?.isEmpty == false ? message! : "Couldn’t rename that file.")
            return false
        }
    }

    public func versions(of target: NativeLibraryItem) async throws -> [NativeLibraryVersion] {
        guard let client, let accountID else { return [] }
        return try await client.versions(id: target.id, for: accountID)
    }

    public func restoreVersion(_ version: Int, of target: NativeLibraryItem) async -> Bool {
        guard let client, let accountID else { return false }
        do {
            try await client.restoreVersion(id: target.id, version: version, for: accountID)
            event = .versionRestored
            await reload()
            return true
        } catch {
            event = .versionRestoreFailed
            return false
        }
    }

    // MARK: Uploads

    /// Uploads files read from disk, each as its own row with its status.
    public func upload(_ files: [(data: Data, fileName: String, mimeType: String)]) {
        for file in files {
            let row = NativeLibraryUpload(
                fileName: file.fileName,
                size: file.data.count,
                isImage: file.mimeType.hasPrefix("image/")
            )
            uploads.append(row)
            pendingUploadData[row.id] = (file.data, file.mimeType)
            Task { await send(row.id) }
        }
    }

    public func retryUpload(_ id: UUID) {
        guard let index = uploads.firstIndex(where: { $0.id == id }) else { return }
        uploads[index].status = .uploading
        Task { await send(id) }
    }

    public func dismissUpload(_ id: UUID) {
        uploads.removeAll { $0.id == id }
        pendingUploadData[id] = nil
    }

    private func send(_ id: UUID) async {
        guard let row = uploads.first(where: { $0.id == id }), let (data, mimeType) = pendingUploadData[id] else { return }
        guard let uploader, let accountID else {
            mark(id, failed: "Juno isn’t signed in.", retryable: false)
            return
        }
        do {
            let uploaded = try await uploader.upload(
                data: data,
                fileName: row.fileName,
                mimeType: mimeType,
                conversationID: nil,
                idempotencyKey: id.uuidString.lowercased(),
                for: accountID
            )
            uploads.removeAll { $0.id == id }
            pendingUploadData[id] = nil
            let item = NativeLibraryItem(
                id: uploaded.id,
                fileName: uploaded.fileName,
                mimeType: uploaded.mimeType,
                size: uploaded.size,
                kind: uploaded.kind,
                createdAt: Date(),
                url: uploaded.url,
                origin: "upload",
                parserState: "queued"
            )
            if var storage {
                storage.usedBytes += item.size
                storage.remainingBytes = max(0, storage.remainingBytes - item.size)
                self.storage = storage
            }
            guard !query.deleted else { return }
            insertRows([item])
            event = .uploaded(hiddenByFilters: !query.matches(item))
        } catch {
            let message = (error as? LocalizedError)?.errorDescription ?? "Upload failed."
            var retryable = true
            if let attachmentError = error as? NativeAttachmentAPIError, case .fileTooLarge = attachmentError {
                retryable = false
            }
            mark(id, failed: message, retryable: retryable)
            event = .uploadFailed(row.fileName)
        }
    }

    private func mark(_ id: UUID, failed message: String, retryable: Bool) {
        guard let index = uploads.firstIndex(where: { $0.id == id }) else { return }
        uploads[index].status = .failed(message, retryable: retryable)
    }
}

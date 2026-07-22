import Foundation
import JunoCore
import JunoSearch
import JunoStorage
import Observation

public enum NativeSearchResultKind: String, CaseIterable, Equatable, Sendable {
    case conversation
    case message
    case project
    case file
    case artifact
    case memory
}

public struct NativeSearchResult: Identifiable, Equatable, Sendable {
    public let kind: NativeSearchResultKind
    public let entityID: String
    /// The conversation a message or artifact result opens into.
    public let conversationID: String?
    public let title: String
    public let snippet: String
    public let score: Int
    public let updatedAt: Date

    public var id: String { "\(kind.rawValue)/\(entityID)" }

    public init(
        kind: NativeSearchResultKind,
        entityID: String,
        conversationID: String?,
        title: String,
        snippet: String,
        score: Int,
        updatedAt: Date
    ) {
        self.kind = kind
        self.entityID = entityID
        self.conversationID = conversationID
        self.title = title
        self.snippet = snippet
        self.score = score
        self.updatedAt = updatedAt
    }
}

/// Query-time search over the encrypted account database.
///
/// Every query decodes the synchronized records straight from the encrypted
/// repository snapshot and scores them through the JunoSearch contract in a
/// throwaway in-memory index. Nothing searchable is ever persisted in
/// plaintext: the encrypted SQLite store remains the only durable copy, so
/// account wipe and isolation guarantees carry over unchanged.
public actor NativeSearchStore<Repository: AccountScopedRepository> {
    private let repository: Repository

    public init(repository: Repository) {
        self.repository = repository
    }

    public func search(
        accountID: StorageAccountID,
        query: String,
        limit: Int = 60
    ) async throws -> [NativeSearchResult] {
        guard limit > 0,
            !SearchNormalizer.tokens(in: query).isEmpty
        else { return [] }

        let snapshot = try await repository.snapshot(for: accountID)
        var conversationTitles: [String: String] = [:]
        for record in snapshot.records.values
        where record.key.namespace == "conversation" && !record.isTombstone {
            guard let payload = record.payload,
                let wire = try? JSONDecoder().decode(
                    SearchConversationWire.self, from: payload
                )
            else { continue }
            conversationTitles[wire.id] = wire.title
        }

        var candidates: [RecordKey: Candidate] = [:]
        for record in snapshot.records.values where !record.isTombstone {
            // A record this build cannot decode simply is not searchable; the
            // owning surface stays responsible for surfacing corruption.
            guard let candidate = candidate(
                for: record,
                conversationTitles: conversationTitles
            ) else { continue }
            candidates[record.key] = candidate
        }

        let index = InMemoryLocalSearchIndex()
        let documents = candidates.compactMap { key, candidate -> SearchIndexUpdate? in
            let searchable = [candidate.title, candidate.body] + candidate.keywords
            guard searchable.contains(where: {
                !SearchNormalizer.tokens(in: $0).isEmpty
            }) else { return nil }
            return .upsert(SearchDocument(
                accountID: accountID,
                key: key,
                title: candidate.title,
                body: candidate.body,
                keywords: candidate.keywords,
                updatedAt: candidate.updatedAt
            ))
        }
        try await index.apply(documents)

        let matches = await index.search(
            accountID: accountID,
            query: query,
            limit: limit
        )
        return matches.compactMap { match in
            guard let candidate = candidates[match.key] else { return nil }
            return NativeSearchResult(
                kind: candidate.kind,
                entityID: match.key.id,
                conversationID: candidate.conversationID,
                title: candidate.title,
                snippet: match.snippet,
                score: match.score,
                updatedAt: match.updatedAt
            )
        }
    }

    private struct Candidate {
        let kind: NativeSearchResultKind
        let conversationID: String?
        let title: String
        let body: String
        let keywords: [String]
        let updatedAt: Date
    }

    private func candidate(
        for record: StoredRecord,
        conversationTitles: [String: String]
    ) -> Candidate? {
        guard let payload = record.payload else { return nil }
        switch record.key.namespace {
        case "conversation":
            guard let wire = try? JSONDecoder().decode(
                SearchConversationWire.self, from: payload
            ), wire.id == record.key.id, wire.kind != "code" else { return nil }
            return Candidate(
                kind: .conversation,
                conversationID: wire.id,
                title: wire.title,
                body: "",
                keywords: wire.pinned == true ? ["pinned"] : [],
                updatedAt: parseDate(wire.lastMessageAt ?? wire.updatedAt)
            )
        case "message":
            guard let wire = try? JSONDecoder().decode(
                SearchMessageWire.self, from: payload
            ), wire.id == record.key.id, !wire.content.isEmpty else { return nil }
            return Candidate(
                kind: .message,
                conversationID: wire.conversationId,
                title: conversationTitles[wire.conversationId] ?? "Conversation",
                body: wire.content,
                keywords: [],
                updatedAt: parseDate(wire.createdAt)
            )
        case "project":
            guard let wire = try? JSONDecoder().decode(
                SearchProjectWire.self, from: payload
            ), wire.id == record.key.id else { return nil }
            return Candidate(
                kind: .project,
                conversationID: nil,
                title: wire.name,
                body: wire.instructions ?? "",
                keywords: [],
                updatedAt: parseDate(wire.updatedAt ?? wire.createdAt)
            )
        case "attachment":
            guard let wire = try? JSONDecoder().decode(
                SearchAttachmentWire.self, from: payload
            ), wire.id == record.key.id else { return nil }
            return Candidate(
                kind: .file,
                conversationID: wire.conversationId,
                title: wire.fileName,
                body: "",
                keywords: [wire.mimeType ?? "", wire.kind ?? ""].filter { !$0.isEmpty },
                updatedAt: parseDate(wire.createdAt)
            )
        case "artifact":
            guard let wire = try? JSONDecoder().decode(
                SearchArtifactWire.self, from: payload
            ), wire.id == record.key.id else { return nil }
            return Candidate(
                kind: .artifact,
                conversationID: wire.conversationId,
                title: wire.title,
                body: "",
                keywords: [wire.type ?? "", wire.language ?? ""].filter { !$0.isEmpty },
                updatedAt: parseDate(wire.updatedAt ?? wire.createdAt)
            )
        case "memory":
            guard let wire = try? JSONDecoder().decode(
                SearchMemoryWire.self, from: payload
            ), wire.id == record.key.id, !wire.content.isEmpty else { return nil }
            return Candidate(
                kind: .memory,
                conversationID: nil,
                title: "Memory",
                body: wire.content,
                keywords: [],
                updatedAt: parseDate(wire.updatedAt ?? wire.createdAt)
            )
        default:
            return nil
        }
    }

    private func parseDate(_ value: String?) -> Date {
        guard let value else { return Date(timeIntervalSince1970: 0) }
        let precise = ISO8601DateFormatter()
        precise.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = precise.date(from: value) { return date }
        let ordinary = ISO8601DateFormatter()
        ordinary.formatOptions = [.withInternetDateTime]
        return ordinary.date(from: value) ?? Date(timeIntervalSince1970: 0)
    }
}

@MainActor
@Observable
public final class NativeSearchModel<Repository: AccountScopedRepository> {
    public enum Phase: Equatable, Sendable {
        case idle
        case searching
        case ready
        case failed
    }

    public private(set) var phase: Phase = .idle
    public private(set) var query = ""
    public private(set) var results: [NativeSearchResult] = []
    public private(set) var lastErrorDescription: String?

    private let store: NativeSearchStore<Repository>
    private let debounce: Duration
    private var accountID: AccountID?
    private var searchTask: Task<Void, Never>?
    private var lastSynchronizationGeneration = -1

    public init(repository: Repository, debounce: Duration = .milliseconds(180)) {
        store = NativeSearchStore(repository: repository)
        self.debounce = debounce
    }

    public var groupedResults: [(kind: NativeSearchResultKind, results: [NativeSearchResult])] {
        NativeSearchResultKind.allCases.compactMap { kind in
            let matching = results.filter { $0.kind == kind }
            return matching.isEmpty ? nil : (kind, matching)
        }
    }

    public func start(for accountID: AccountID) {
        guard self.accountID != accountID else { return }
        stop()
        self.accountID = accountID
        phase = .idle
    }

    public func stop() {
        searchTask?.cancel()
        searchTask = nil
        accountID = nil
        query = ""
        results = []
        lastErrorDescription = nil
        phase = .idle
    }

    public func synchronizationDidAdvance(to generation: Int) {
        guard generation != lastSynchronizationGeneration else { return }
        lastSynchronizationGeneration = generation
        guard !query.isEmpty else { return }
        setQuery(query, debounced: false)
    }

    public func setQuery(_ value: String, debounced: Bool = true) {
        query = value
        searchTask?.cancel()
        guard let accountID else { return }
        guard !SearchNormalizer.tokens(in: value).isEmpty else {
            results = []
            phase = .idle
            lastErrorDescription = nil
            searchTask = nil
            return
        }
        phase = .searching
        let debounce = debounced ? debounce : .zero
        searchTask = Task { [store, debounce] in
            if debounce > .zero {
                try? await Task.sleep(for: debounce)
            }
            guard !Task.isCancelled else { return }
            do {
                let found = try await store.search(
                    accountID: StorageAccountID(accountID.rawValue),
                    query: value
                )
                guard !Task.isCancelled, self.accountID == accountID,
                    self.query == value
                else { return }
                results = found
                lastErrorDescription = nil
                phase = .ready
            } catch {
                guard !Task.isCancelled, self.accountID == accountID,
                    self.query == value
                else { return }
                lastErrorDescription = error.localizedDescription
                phase = .failed
            }
        }
    }
}

private struct SearchConversationWire: Decodable {
    let id: String
    let title: String
    let kind: String?
    let pinned: Bool?
    let updatedAt: String?
    let lastMessageAt: String?
}

private struct SearchMessageWire: Decodable {
    let id: String
    let conversationId: String
    let content: String
    let createdAt: String?
}

private struct SearchProjectWire: Decodable {
    let id: String
    let name: String
    let instructions: String?
    let createdAt: String?
    let updatedAt: String?
}

private struct SearchAttachmentWire: Decodable {
    let id: String
    let conversationId: String?
    let fileName: String
    let mimeType: String?
    let kind: String?
    let createdAt: String?
}

private struct SearchArtifactWire: Decodable {
    let id: String
    let conversationId: String?
    let title: String
    let type: String?
    let language: String?
    let createdAt: String?
    let updatedAt: String?
}

private struct SearchMemoryWire: Decodable {
    let id: String
    let content: String
    let createdAt: String?
    let updatedAt: String?
}

import Foundation
import JunoStorage

public struct SearchDocument: Equatable, Sendable {
    public let accountID: StorageAccountID
    public let key: RecordKey
    public let title: String
    public let body: String
    public let keywords: [String]
    public let updatedAt: Date

    public init(
        accountID: StorageAccountID,
        key: RecordKey,
        title: String,
        body: String,
        keywords: [String] = [],
        updatedAt: Date
    ) {
        self.accountID = accountID
        self.key = key
        self.title = title
        self.body = body
        self.keywords = keywords
        self.updatedAt = updatedAt
    }
}

public enum SearchIndexUpdate: Equatable, Sendable {
    case upsert(SearchDocument)
    case remove(accountID: StorageAccountID, key: RecordKey)
}

public struct LocalSearchResult: Equatable, Sendable {
    public let key: RecordKey
    public let title: String
    public let snippet: String
    public let score: Int
    public let matchedTerms: [String]
    public let updatedAt: Date

    public init(
        key: RecordKey,
        title: String,
        snippet: String,
        score: Int,
        matchedTerms: [String],
        updatedAt: Date
    ) {
        self.key = key
        self.title = title
        self.snippet = snippet
        self.score = score
        self.matchedTerms = matchedTerms
        self.updatedAt = updatedAt
    }
}

public enum LocalSearchError: Error, Equatable, Sendable {
    case invalidAccountID
    case invalidRecordKey(RecordKey)
    case noSearchableContent(RecordKey)
}

/// Pure Unicode normalization shared by all local search adapters.
public enum SearchNormalizer {
    public static func normalizedText(_ value: String) -> String {
        tokens(in: value).joined(separator: " ")
    }

    public static func tokens(in value: String) -> [String] {
        let folded = value.folding(
            options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive],
            locale: Locale(identifier: "en_US_POSIX")
        )

        var separated = ""
        separated.reserveCapacity(folded.utf8.count)
        for scalar in folded.unicodeScalars {
            if CharacterSet.alphanumerics.contains(scalar) {
                separated.unicodeScalars.append(scalar)
            } else {
                separated.append(" ")
            }
        }

        return separated
            .split(whereSeparator: \Character.isWhitespace)
            .map(String.init)
    }
}

public protocol LocalSearchIndexing: Sendable {
    func apply(_ updates: [SearchIndexUpdate]) async throws
    func search(accountID: StorageAccountID, query: String, limit: Int) async -> [LocalSearchResult]
    func wipe(accountID: StorageAccountID) async
}

/// Plaintext in-memory index intended only for deterministic tests and previews.
///
/// Production apps must inject a protected account-scoped index and wipe it on
/// logout, revocation, account switch, deletion, or explicit cleaning. This
/// actor intentionally has no JSON, UserDefaults, or filesystem fallback.
public actor InMemoryLocalSearchIndex: LocalSearchIndexing {
    private struct IndexedDocument: Sendable {
        let source: SearchDocument
        let titleTokens: Set<String>
        let bodyTokens: Set<String>
        let keywordTokens: Set<String>
        let normalizedTitle: String
        let normalizedBody: String
    }

    private var accounts: [StorageAccountID: [RecordKey: IndexedDocument]] = [:]

    public init() {}

    public func apply(_ updates: [SearchIndexUpdate]) throws {
        // Validate the whole batch first so a bad document cannot leave a
        // partially updated index.
        for update in updates {
            switch update {
            case let .upsert(document):
                try validate(document)
            case let .remove(accountID, key):
                try validate(accountID: accountID, key: key)
            }
        }

        for update in updates {
            switch update {
            case let .upsert(document):
                var partition = accounts[document.accountID] ?? [:]
                partition[document.key] = index(document)
                accounts[document.accountID] = partition

            case let .remove(accountID, key):
                guard var partition = accounts[accountID] else { continue }
                partition.removeValue(forKey: key)
                accounts[accountID] = partition.isEmpty ? nil : partition
            }
        }
    }

    public func search(
        accountID: StorageAccountID,
        query: String,
        limit: Int
    ) -> [LocalSearchResult] {
        guard limit > 0 else { return [] }
        let terms = uniqueTokens(SearchNormalizer.tokens(in: query))
        guard !terms.isEmpty else { return [] }

        let phrase = terms.joined(separator: " ")
        let partition = accounts[accountID] ?? [:]
        var results: [LocalSearchResult] = []

        for indexed in partition.values {
            var totalScore = 0
            var matchedTerms: [String] = []

            for term in terms {
                let termScore = score(
                    term: term,
                    title: indexed.titleTokens,
                    keywords: indexed.keywordTokens,
                    body: indexed.bodyTokens
                )
                guard termScore > 0 else {
                    matchedTerms.removeAll(keepingCapacity: true)
                    totalScore = 0
                    break
                }
                totalScore += termScore
                matchedTerms.append(term)
            }

            guard matchedTerms.count == terms.count else { continue }
            if terms.count > 1, indexed.normalizedTitle.contains(phrase) {
                totalScore += 8
            } else if terms.count > 1, indexed.normalizedBody.contains(phrase) {
                totalScore += 3
            }

            results.append(
                LocalSearchResult(
                    key: indexed.source.key,
                    title: indexed.source.title,
                    snippet: snippet(for: indexed.source),
                    score: totalScore,
                    matchedTerms: matchedTerms,
                    updatedAt: indexed.source.updatedAt
                )
            )
        }

        return results
            .sorted(by: resultOrder)
            .prefix(limit)
            .map { $0 }
    }

    public func wipe(accountID: StorageAccountID) {
        accounts.removeValue(forKey: accountID)
    }

    public func documentCount(accountID: StorageAccountID) -> Int {
        accounts[accountID]?.count ?? 0
    }

    private func validate(_ document: SearchDocument) throws {
        try validate(accountID: document.accountID, key: document.key)
        let allContent = [document.title, document.body] + document.keywords
        guard allContent.contains(where: { !SearchNormalizer.tokens(in: $0).isEmpty }) else {
            throw LocalSearchError.noSearchableContent(document.key)
        }
    }

    private func validate(accountID: StorageAccountID, key: RecordKey) throws {
        guard !accountID.rawValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw LocalSearchError.invalidAccountID
        }
        guard !key.namespace.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !key.id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else {
            throw LocalSearchError.invalidRecordKey(key)
        }
    }

    private func index(_ document: SearchDocument) -> IndexedDocument {
        let titleTokens = SearchNormalizer.tokens(in: document.title)
        let bodyTokens = SearchNormalizer.tokens(in: document.body)
        let keywordTokens = document.keywords.flatMap(SearchNormalizer.tokens(in:))
        return IndexedDocument(
            source: document,
            titleTokens: Set(titleTokens),
            bodyTokens: Set(bodyTokens),
            keywordTokens: Set(keywordTokens),
            normalizedTitle: titleTokens.joined(separator: " "),
            normalizedBody: bodyTokens.joined(separator: " ")
        )
    }

    private func uniqueTokens(_ tokens: [String]) -> [String] {
        var seen = Set<String>()
        return tokens.filter { seen.insert($0).inserted }
    }

    private func score(
        term: String,
        title: Set<String>,
        keywords: Set<String>,
        body: Set<String>
    ) -> Int {
        if title.contains(term) { return 10 }
        if title.contains(where: { $0.hasPrefix(term) }) { return 7 }
        if keywords.contains(term) { return 6 }
        if keywords.contains(where: { $0.hasPrefix(term) }) { return 4 }
        if body.contains(term) { return 3 }
        if body.contains(where: { $0.hasPrefix(term) }) { return 1 }
        return 0
    }

    private func snippet(for document: SearchDocument) -> String {
        let source = document.body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !source.isEmpty else { return document.title }
        let prefix = String(source.prefix(160))
        return prefix.count == source.count ? prefix : prefix + "…"
    }

    private func resultOrder(_ lhs: LocalSearchResult, _ rhs: LocalSearchResult) -> Bool {
        if lhs.score != rhs.score { return lhs.score > rhs.score }
        if lhs.updatedAt != rhs.updatedAt { return lhs.updatedAt > rhs.updatedAt }
        if lhs.key.namespace != rhs.key.namespace {
            return lhs.key.namespace < rhs.key.namespace
        }
        return lhs.key.id < rhs.key.id
    }
}

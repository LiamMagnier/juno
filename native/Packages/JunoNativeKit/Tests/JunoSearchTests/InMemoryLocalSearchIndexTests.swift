import Foundation
import XCTest
@testable import JunoSearch
@testable import JunoStorage

final class InMemoryLocalSearchIndexTests: XCTestCase {
    private let accountA = StorageAccountID("account-a")
    private let accountB = StorageAccountID("account-b")
    private let now = Date(timeIntervalSince1970: 1_700_000_000)

    func testNormalizationIsCaseDiacriticWidthAndPunctuationInsensitive() async throws {
        let index = InMemoryLocalSearchIndex()
        let document = makeDocument(
            id: "one",
            title: "Résumé：Ｃａｆé",
            body: "Architecture notes"
        )
        try await index.apply([.upsert(document)])

        let results = await index.search(
            accountID: accountA,
            query: "RESUME cafe",
            limit: 10
        )
        XCTAssertEqual(results.map(\.key), [document.key])
        XCTAssertEqual(results.single?.matchedTerms, ["resume", "cafe"])
    }

    func testSearchUsesANDSemanticsAndRanksTitleAboveBody() async throws {
        let index = InMemoryLocalSearchIndex()
        let titleMatch = makeDocument(
            id: "title",
            title: "Swift concurrency guide",
            body: "Actors"
        )
        let bodyMatch = makeDocument(
            id: "body",
            title: "Concurrency guide",
            body: "Swift actors"
        )
        let partialMatch = makeDocument(
            id: "partial",
            title: "Swift guide",
            body: "No second term"
        )
        try await index.apply([
            .upsert(bodyMatch),
            .upsert(partialMatch),
            .upsert(titleMatch),
        ])

        let results = await index.search(
            accountID: accountA,
            query: "swift concurrency",
            limit: 10
        )
        XCTAssertEqual(results.map(\.key), [titleMatch.key, bodyMatch.key])
        XCTAssertGreaterThan(try XCTUnwrap(results.first?.score), try XCTUnwrap(results.last?.score))
    }

    func testAccountIsolationRemoveAndWipeNeverCrossPartitions() async throws {
        let index = InMemoryLocalSearchIndex()
        let first = makeDocument(id: "shared", title: "Secret alpha", body: "")
        let second = makeDocument(
            id: "shared",
            title: "Secret beta",
            body: "",
            accountID: accountB
        )
        try await index.apply([.upsert(first), .upsert(second)])

        let accountAResults = await index.search(accountID: accountA, query: "secret", limit: 10)
        let accountBResults = await index.search(accountID: accountB, query: "secret", limit: 10)
        XCTAssertEqual(accountAResults.map(\.title), ["Secret alpha"])
        XCTAssertEqual(accountBResults.map(\.title), ["Secret beta"])

        try await index.apply([.remove(accountID: accountA, key: first.key)])
        let removed = await index.search(accountID: accountA, query: "secret", limit: 10)
        let stillPresent = await index.search(accountID: accountB, query: "secret", limit: 10)
        XCTAssertTrue(removed.isEmpty)
        XCTAssertEqual(stillPresent.map(\.title), ["Secret beta"])

        await index.wipe(accountID: accountB)
        let wiped = await index.search(accountID: accountB, query: "secret", limit: 10)
        XCTAssertTrue(wiped.isEmpty)
    }

    func testInvalidBatchDoesNotPartiallyMutateIndex() async throws {
        let index = InMemoryLocalSearchIndex()
        let valid = makeDocument(id: "valid", title: "Valid document", body: "")
        let invalid = SearchDocument(
            accountID: accountA,
            key: RecordKey(namespace: "messages", id: "invalid"),
            title: "...",
            body: "---",
            updatedAt: now
        )

        do {
            try await index.apply([.upsert(valid), .upsert(invalid)])
            XCTFail("Expected the batch to be rejected")
        } catch {
            XCTAssertEqual(
                error as? LocalSearchError,
                .noSearchableContent(invalid.key)
            )
        }

        let count = await index.documentCount(accountID: accountA)
        XCTAssertEqual(count, 0)
    }

    func testPrefixMatchingAndLimitAreDeterministic() async throws {
        let index = InMemoryLocalSearchIndex()
        let older = makeDocument(
            id: "older",
            title: "Synchronization",
            body: "",
            updatedAt: now
        )
        let newer = makeDocument(
            id: "newer",
            title: "Synchronizer",
            body: "",
            updatedAt: now.addingTimeInterval(1)
        )
        try await index.apply([.upsert(older), .upsert(newer)])

        let results = await index.search(accountID: accountA, query: "sync", limit: 1)
        XCTAssertEqual(results.map(\.key), [newer.key])
    }

    private func makeDocument(
        id: String,
        title: String,
        body: String,
        accountID: StorageAccountID? = nil,
        updatedAt: Date? = nil
    ) -> SearchDocument {
        SearchDocument(
            accountID: accountID ?? accountA,
            key: RecordKey(namespace: "messages", id: id),
            title: title,
            body: body,
            updatedAt: updatedAt ?? now
        )
    }
}

private extension Array {
    var single: Element? { count == 1 ? self[0] : nil }
}

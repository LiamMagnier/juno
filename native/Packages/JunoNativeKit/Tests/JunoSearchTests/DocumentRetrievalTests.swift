import Foundation
import XCTest

@testable import JunoSearch
@testable import JunoStorage

/// Retrieval decides what a model is allowed to read before it answers. These
/// tests are about the two ways that goes wrong: ranking the wrong passage, and
/// returning something for a question the corpus cannot answer.
final class DocumentRetrievalTests: XCTestCase {
    private let accountA = StorageAccountID("account-a")
    private let accountB = StorageAccountID("account-b")

    // MARK: - Lexical ranking

    /// BM25's whole job: the passage that answers the question outranks the one
    /// that merely mentions its words.
    func testTheAnsweringPassageOutranksAPassingMention() {
        let ranker = HybridDocumentRanker(chunks: [
            chunk("mention", "The refund policy is discussed elsewhere in this handbook."),
            chunk(
                "answer",
                "Refunds are issued within 14 days of the request, to the original payment method."
            ),
            chunk("unrelated", "The office kitchen is restocked on Mondays."),
        ])

        let passages = ranker.rank(query: "how long do refunds take", limit: 3)

        XCTAssertEqual(passages.first?.chunk.id, "answer")
        XCTAssertFalse(
            passages.contains { $0.chunk.id == "unrelated" },
            "a passage sharing no query term must not be retrieved"
        )
    }

    /// The semantics difference from `InMemoryLocalSearchIndex`, which requires
    /// every term. A question is a sentence; most of its words are in no chunk,
    /// and requiring all of them retrieves nothing at all.
    func testPartialMatchesAreRetrievedUnlikeTheStrictRecordIndex() async throws {
        let text = "Quarterly revenue grew twelve percent."
        let ranker = HybridDocumentRanker(chunks: [chunk("one", text)])

        let passages = ranker.rank(query: "what happened to quarterly revenue", limit: 5)
        XCTAssertEqual(passages.count, 1)

        // The same corpus, through the record index that Juno search uses: no
        // hit, because "what" and "happened" are absent. Both behaviours are
        // right for their own question — this asserts they really do differ.
        let index = InMemoryLocalSearchIndex()
        try await index.apply([
            .upsert(
                SearchDocument(
                    chunk: RetrievableChunk(id: "one", sourceName: "doc.md", text: text),
                    accountID: accountA,
                    updatedAt: Date(timeIntervalSince1970: 0)
                )
            ),
        ])
        let strict = await index.search(
            accountID: accountA,
            query: "what happened to quarterly revenue",
            limit: 5
        )
        XCTAssertTrue(strict.isEmpty)
    }

    /// Term saturation. Without it, a chunk that says "invoice" forty times
    /// outranks the chunk that answers the question about invoices.
    func testRepeatingATermSaturatesRatherThanAccumulating() {
        let spam = String(repeating: "invoice ", count: 60)
        let ranker = HybridDocumentRanker(chunks: [
            chunk("spam", spam),
            chunk("answer", "An invoice is due 30 days after issue."),
        ])

        let passages = ranker.rank(query: "when is an invoice due", limit: 2)
        XCTAssertEqual(passages.first?.chunk.id, "answer")
    }

    /// Retrieval with no floor always returns `limit` passages, including for a
    /// question the corpus says nothing about — and a model handed irrelevant
    /// text under a heading that says "sources" will cite it.
    func testAQuestionTheCorpusCannotAnswerRetrievesNothing() {
        let ranker = HybridDocumentRanker(chunks: [
            chunk("a", "The office kitchen is restocked on Mondays."),
            chunk("b", "Parking permits renew in March."),
        ])

        XCTAssertTrue(ranker.rank(query: "photosynthesis chlorophyll", limit: 5).isEmpty)
    }

    /// A retrieval that returns different passages for the same query on the
    /// same corpus is unreproducible for whoever reports the bug.
    func testRankingIsDeterministicIncludingTies() {
        let chunks = (1 ... 6).map { chunk("chunk-\($0)", "Identical text about ledgers.") }
        let first = HybridDocumentRanker(chunks: chunks).rank(query: "ledgers", limit: 4)
        let second = HybridDocumentRanker(chunks: chunks.reversed()).rank(
            query: "ledgers",
            limit: 4
        )

        XCTAssertEqual(first.map(\.chunk.id), second.map(\.chunk.id))
        XCTAssertEqual(first.map(\.chunk.id), ["chunk-1", "chunk-2", "chunk-3", "chunk-4"])
    }

    // MARK: - Hybrid

    /// Absent ≠ zero. With no embedder there is no vector opinion at all, and a
    /// `0.0` there reads as "the vector side looked and found nothing".
    func testTheSemanticScoreIsAbsentWithoutAnEmbedderAndPresentWithOne() {
        let chunks = [chunk("one", "Deferred revenue is recognised over the contract term.")]

        let lexical = HybridDocumentRanker(chunks: chunks)
            .rank(query: "deferred revenue", limit: 1)
        XCTAssertNil(lexical.first?.semanticScore)

        let hybrid = HybridDocumentRanker(chunks: chunks, embedder: HashingTextEmbedder())
            .rank(query: "deferred revenue", limit: 1)
        XCTAssertNotNil(hybrid.first?.semanticScore)
    }

    /// The signal the vector half adds over a bag of words: word order.
    func testTheVectorHalfSeesPhraseOrderThatBM25CannotSee() throws {
        let embedder = HashingTextEmbedder()
        let ordered = embedder.embed("revenue growth")
        let reversed = embedder.embed("growth revenue")

        let similarity = try XCTUnwrap(cosineSimilarity(ordered, reversed))
        XCTAssertLessThan(similarity, 0.999)
        XCTAssertGreaterThan(similarity, 0.4, "the unigrams still match")
    }

    /// `Hasher` is seeded per process, so an index built in one launch would
    /// score differently in the next and a persisted vector would be
    /// meaningless — silently, because the numbers still look like numbers.
    /// Pinning the constant is what makes that regression a test failure.
    func testTheEmbeddingHashIsProcessStableNotSeededPerLaunch() {
        XCTAssertEqual(HashingTextEmbedder.fnv1a(""), 0xCBF2_9CE4_8422_2325)
        XCTAssertEqual(HashingTextEmbedder.fnv1a("a"), 0xAF63_DC4C_8601_EC8C)

        let embedder = HashingTextEmbedder()
        XCTAssertEqual(embedder.embed("stable text"), embedder.embed("stable text"))
    }

    /// A zero vector has no direction, so it has no cosine. Returning 0 would
    /// make "no opinion" indistinguishable from "confidently orthogonal".
    func testCosineOfADirectionlessVectorIsAbsentRatherThanZero() {
        XCTAssertNil(cosineSimilarity([0, 0, 0], [1, 2, 3]))
        XCTAssertNil(cosineSimilarity([], []))
        XCTAssertNil(cosineSimilarity([1, 2], [1, 2, 3]))
        XCTAssertEqual(try XCTUnwrap(cosineSimilarity([1, 0], [1, 0])), 1, accuracy: 0.0001)
    }

    func testAnEmptyCorpusScoresNothingRatherThanProducingNaNs() {
        let index = BM25Index(chunks: [])
        XCTAssertTrue(index.scores(for: "anything").isEmpty)
        XCTAssertTrue(HybridDocumentRanker(chunks: []).rank(query: "anything", limit: 5).isEmpty)
    }

    // MARK: - Account partitioning

    /// One person's documents must never be retrievable into another person's
    /// prompt, and `wipe` has to work on logout, revocation, and account switch.
    func testDocumentsNeverCrossAccountsAndWipeIsTotal() async {
        let index = DocumentRetrievalIndex()
        await index.insert(
            [chunk("a", "Acme merger terms and conditions.", source: "acme.pdf")],
            accountID: accountA
        )
        await index.insert(
            [chunk("b", "Globex merger terms and conditions.", source: "globex.pdf")],
            accountID: accountB
        )

        let fromA = await index.retrieve(query: "merger terms", accountID: accountA, limit: 5)
        let fromB = await index.retrieve(query: "merger terms", accountID: accountB, limit: 5)
        XCTAssertEqual(fromA.map(\.chunk.sourceName), ["acme.pdf"])
        XCTAssertEqual(fromB.map(\.chunk.sourceName), ["globex.pdf"])

        await index.wipe(accountID: accountA)
        let wiped = await index.retrieve(query: "merger terms", accountID: accountA, limit: 5)
        let survivor = await index.retrieve(query: "merger terms", accountID: accountB, limit: 5)
        XCTAssertTrue(wiped.isEmpty)
        XCTAssertEqual(survivor.count, 1)
    }

    /// Re-importing a file must replace its chunks, not add a second copy that
    /// competes with the first for the same query.
    func testReIngestingAFileReplacesItsChunks() async throws {
        let index = DocumentRetrievalIndex()
        let pipeline = DocumentIngestionPipeline()
        let data = Data("# Policy\n\nRefunds within fourteen days.\n".utf8)

        for _ in 0 ..< 3 {
            let document = try pipeline.ingest(data: data, fileName: "policy.md")
            await index.insert(document.chunks.map(RetrievableChunk.init), accountID: accountA)
        }

        let count = await index.chunkCount(accountID: accountA)
        XCTAssertEqual(count, 1)
    }

    // MARK: - Ingestion → retrieval

    /// The end-to-end promise: a chunk retrieved from a real file still knows
    /// which page it came from, so the citation under it is true.
    func testARetrievedPassageStillKnowsWhereItCameFrom() {
        let pipeline = DocumentIngestionPipeline(
            options: TextChunkingOptions(maximumCharacters: 400, overlapCharacters: 40)
        )
        let segments = [
            DocumentSegment(text: "Unrelated preamble about the office.", pageNumber: 1),
            DocumentSegment(
                text: "Deferred revenue is recognised over the contract term.",
                pageNumber: 7,
                section: "Accounting policies"
            ),
        ]
        let chunks = pipeline.chunks(
            from: segments,
            sourceName: "Annual Report.pdf",
            format: .pdf
        ).map(RetrievableChunk.init)

        let passages = HybridDocumentRanker(chunks: chunks)
            .rank(query: "deferred revenue recognition", limit: 1)

        XCTAssertEqual(passages.first?.chunk.pageNumber, 7)
        XCTAssertEqual(
            passages.first?.chunk.locator,
            "Annual Report.pdf, page 7 — Accounting policies"
        )
    }

    // MARK: - Helpers

    private func chunk(
        _ id: String,
        _ text: String,
        source: String = "doc.md"
    ) -> RetrievableChunk {
        RetrievableChunk(id: id, sourceName: source, text: text)
    }
}

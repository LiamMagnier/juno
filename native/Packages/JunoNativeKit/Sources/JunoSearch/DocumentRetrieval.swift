import Foundation
import JunoStorage

/// A chunk in a form the retriever can rank.
///
/// Separate from `DocumentChunk` because retrieval also has to rank things that
/// were never a file — a conversation excerpt, a memory, a fetched web page —
/// and because a chunk arriving from the ingestion pipeline should not be the
/// only shape this index accepts. `init(_ chunk:)` bridges the common case.
public struct RetrievableChunk: Equatable, Sendable, Identifiable {
    public let id: String
    /// What a citation would name, e.g. `Q3 Report.pdf`.
    public let sourceName: String
    public let text: String
    /// Where inside the source, when the source has a "where". Nil is a real
    /// answer, and it is the answer for formats with no pages.
    public let pageNumber: Int?
    public let section: String?
    /// nil when the source carries no timestamp. Never `Date()` and never
    /// `.distantPast`: both would let recency ranking act on a fact nobody
    /// stated.
    public let updatedAt: Date?

    public init(
        id: String,
        sourceName: String,
        text: String,
        pageNumber: Int? = nil,
        section: String? = nil,
        updatedAt: Date? = nil
    ) {
        self.id = id
        self.sourceName = sourceName
        self.text = text
        self.pageNumber = pageNumber
        self.section = section
        self.updatedAt = updatedAt
    }

    public init(_ chunk: DocumentChunk) {
        self.init(
            id: chunk.id,
            sourceName: chunk.metadata.sourceName,
            text: chunk.text,
            pageNumber: chunk.metadata.pageNumber,
            section: chunk.metadata.section,
            updatedAt: nil
        )
    }

    /// The human-readable locator that goes under a citation marker.
    public var locator: String {
        var locator = sourceName
        if let pageNumber { locator += ", page \(pageNumber)" }
        if let section, !section.isEmpty { locator += " — \(section)" }
        return locator
    }
}

public extension SearchDocument {
    /// Bridges a retrievable chunk into the existing lexical index.
    ///
    /// Present so a caller that already runs `InMemoryLocalSearchIndex` for
    /// account-wide search can feed it document chunks without a second
    /// tokenizer, a second normaliser, or a second notion of what a document is.
    /// The two indexes answer different questions — that one finds *records*
    /// with strict AND semantics, this one finds *passages* to put in a prompt —
    /// but they read text the same way.
    init(chunk: RetrievableChunk, accountID: StorageAccountID, updatedAt: Date) {
        self.init(
            accountID: accountID,
            key: RecordKey(namespace: "document-chunk", id: chunk.id),
            title: chunk.sourceName,
            body: chunk.text,
            keywords: [chunk.section].compactMap { $0 },
            updatedAt: chunk.updatedAt ?? updatedAt
        )
    }
}

// MARK: - Embeddings

/// The seam a real embedding model plugs into.
///
/// Kept as a protocol rather than a concrete type because the only honest local
/// default (below) is not a semantic model, and code that consumes retrieval
/// results must not be written as though it were.
public protocol TextEmbedding: Sendable {
    var dimension: Int { get }
    func embed(_ text: String) -> [Double]
}

/// A deterministic, offline, dependency-free vector encoder.
///
/// **This is not a semantic model, and nothing here should describe it as one.**
/// It is the hashing trick over unigrams and adjacent bigrams: two texts are
/// close when they share words and word pairs, not when they share meaning.
/// "car" and "automobile" are orthogonal under it. It exists so that hybrid
/// retrieval has a working second signal — phrase-order sensitivity that BM25's
/// bag of words does not have — on a device with no model loaded, and so that
/// tests of the fusion arithmetic are deterministic.
///
/// The hash is FNV-1a rather than Swift's `Hasher` on purpose: `Hasher` is
/// seeded per process, so an index built in one launch would score differently
/// in the next, and a persisted vector would be meaningless. That failure is
/// silent — the numbers still look like numbers.
public struct HashingTextEmbedder: TextEmbedding {
    public let dimension: Int

    public init(dimension: Int = 512) {
        self.dimension = max(16, dimension)
    }

    public func embed(_ text: String) -> [Double] {
        let tokens = SearchNormalizer.tokens(in: text)
        guard !tokens.isEmpty else { return Array(repeating: 0, count: dimension) }

        var vector = [Double](repeating: 0, count: dimension)
        func accumulate(_ feature: String, weight: Double) {
            let hash = Self.fnv1a(feature)
            let bucket = Int(hash % UInt64(dimension))
            // The sign bit spreads collisions instead of piling them up: two
            // unrelated features landing in the same bucket cancel as often as
            // they reinforce, which keeps a collision from reading as a match.
            let sign: Double = (hash & 0x8000_0000_0000_0000) == 0 ? 1 : -1
            vector[bucket] += sign * weight
        }

        for token in tokens { accumulate(token, weight: 1) }
        for pair in zip(tokens, tokens.dropFirst()) {
            // Bigrams are the only thing here BM25 cannot already see, so they
            // carry most of the weight this encoder adds.
            accumulate("\(pair.0)\u{1F}\(pair.1)", weight: 1.5)
        }

        let norm = (vector.reduce(0) { $0 + $1 * $1 }).squareRoot()
        guard norm > 0 else { return vector }
        return vector.map { $0 / norm }
    }

    static func fnv1a(_ value: String) -> UInt64 {
        var hash: UInt64 = 0xCBF2_9CE4_8422_2325
        for byte in value.utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 0x0000_0100_0000_01B3
        }
        return hash
    }
}

/// Cosine similarity of two vectors, or nil when either has no direction.
///
/// Nil rather than 0 for a zero vector. Zero is a legitimate similarity score
/// meaning "orthogonal"; an empty vector means "no opinion", and collapsing the
/// second into the first lets an unembeddable chunk look like a confidently bad
/// match instead of an abstention.
public func cosineSimilarity(_ lhs: [Double], _ rhs: [Double]) -> Double? {
    guard lhs.count == rhs.count, !lhs.isEmpty else { return nil }
    var dot = 0.0
    var lhsNorm = 0.0
    var rhsNorm = 0.0
    for index in lhs.indices {
        dot += lhs[index] * rhs[index]
        lhsNorm += lhs[index] * lhs[index]
        rhsNorm += rhs[index] * rhs[index]
    }
    guard lhsNorm > 0, rhsNorm > 0 else { return nil }
    return dot / (lhsNorm.squareRoot() * rhsNorm.squareRoot())
}

// MARK: - BM25

public struct BM25Parameters: Equatable, Sendable {
    /// Term-frequency saturation. Above this, repeating a word stops helping —
    /// which is what stops a chunk that says "invoice" forty times from
    /// outranking the chunk that answers the question about invoices.
    public var k1: Double
    /// Length normalisation. At 0 a long chunk is never penalised for its
    /// length; at 1 it is penalised in full proportion.
    public var b: Double

    public init(k1: Double = 1.2, b: Double = 0.75) {
        self.k1 = k1
        self.b = b
    }

    public static let `default` = BM25Parameters()
}

/// Okapi BM25 over the chunk corpus. Pure, and built once per corpus.
///
/// Note the semantics difference from `InMemoryLocalSearchIndex`, which requires
/// every query term to match. That is right for "find the conversation I mean",
/// where a result missing a term is the wrong record. It is wrong here: a
/// question is a sentence, most of its words are not in any chunk, and requiring
/// all of them retrieves nothing at all. So this scores partial matches and lets
/// IDF decide which terms mattered.
public struct BM25Index: Sendable {
    private struct Posting: Sendable {
        let chunkIndex: Int
        let frequency: Double
    }

    private let chunks: [RetrievableChunk]
    private let postings: [String: [Posting]]
    private let lengths: [Double]
    private let averageLength: Double
    private let parameters: BM25Parameters

    public init(chunks: [RetrievableChunk], parameters: BM25Parameters = .default) {
        self.chunks = chunks
        self.parameters = parameters

        var postings: [String: [Posting]] = [:]
        var lengths: [Double] = []
        lengths.reserveCapacity(chunks.count)

        for (index, chunk) in chunks.enumerated() {
            let tokens = SearchNormalizer.tokens(in: chunk.text)
                + SearchNormalizer.tokens(in: chunk.sourceName)
                + SearchNormalizer.tokens(in: chunk.section ?? "")
            lengths.append(Double(tokens.count))
            var frequencies: [String: Double] = [:]
            for token in tokens { frequencies[token, default: 0] += 1 }
            for (token, frequency) in frequencies {
                postings[token, default: []].append(
                    Posting(chunkIndex: index, frequency: frequency)
                )
            }
        }

        self.postings = postings
        self.lengths = lengths
        let total = lengths.reduce(0, +)
        // Guarded because an empty corpus divides by zero here, and the NaN it
        // produces sorts unpredictably rather than failing loudly.
        averageLength = lengths.isEmpty ? 0 : total / Double(lengths.count)
    }

    public var count: Int { chunks.count }

    /// Raw BM25 scores by chunk index. Chunks with no matching term are absent
    /// from the result rather than present with a zero, so a caller can tell
    /// "scored nothing" from "was never considered".
    public func scores(for query: String) -> [Int: Double] {
        guard !chunks.isEmpty, averageLength > 0 else { return [:] }
        let terms = SearchNormalizer.tokens(in: query)
        guard !terms.isEmpty else { return [:] }

        let corpusSize = Double(chunks.count)
        var scores: [Int: Double] = [:]
        var seenTerms = Set<String>()

        for term in terms where seenTerms.insert(term).inserted {
            guard let matches = postings[term], !matches.isEmpty else { continue }
            let documentFrequency = Double(matches.count)
            // The +1 inside the log keeps IDF non-negative. Without it a term
            // present in more than half the corpus scores negative, and a chunk
            // is then punished for containing a word the person asked about.
            let idf = log(
                1 + (corpusSize - documentFrequency + 0.5) / (documentFrequency + 0.5)
            )
            for match in matches {
                let length = lengths[match.chunkIndex]
                let denominator = match.frequency
                    + parameters.k1
                    * (1 - parameters.b + parameters.b * length / averageLength)
                guard denominator > 0 else { continue }
                scores[match.chunkIndex, default: 0] +=
                    idf * (match.frequency * (parameters.k1 + 1)) / denominator
            }
        }
        return scores
    }
}

// MARK: - Fusion

public struct RetrievalWeights: Equatable, Sendable {
    public var lexical: Double
    public var semantic: Double
    /// A hit must clear this share of the best hit's fused score to be returned.
    ///
    /// Retrieval with no floor always returns `limit` passages, including for a
    /// question the corpus says nothing about — and a model handed irrelevant
    /// context under a heading that says "sources" will cite it.
    public var minimumRelativeScore: Double

    public init(lexical: Double = 0.6, semantic: Double = 0.4, minimumRelativeScore: Double = 0.15) {
        self.lexical = max(0, lexical)
        self.semantic = max(0, semantic)
        self.minimumRelativeScore = min(max(0, minimumRelativeScore), 1)
    }

    public static let `default` = RetrievalWeights()
    /// Lexical only — the correct configuration when no embedding model is
    /// available, rather than pretending a missing signal scored zero.
    public static let lexicalOnly = RetrievalWeights(
        lexical: 1, semantic: 0, minimumRelativeScore: 0.15
    )
}

public struct RetrievedPassage: Equatable, Sendable {
    public let chunk: RetrievableChunk
    /// Fused score in [0, 1], relative to the best hit for this query. Not
    /// comparable across queries, and not a probability.
    public let score: Double
    public let lexicalScore: Double
    /// nil when no embedder was configured. Absent, not zero: zero would read as
    /// "the vector side looked and found nothing".
    public let semanticScore: Double?

    public init(
        chunk: RetrievableChunk,
        score: Double,
        lexicalScore: Double,
        semanticScore: Double?
    ) {
        self.chunk = chunk
        self.score = score
        self.lexicalScore = lexicalScore
        self.semanticScore = semanticScore
    }
}

/// Hybrid BM25 + cosine ranking. Pure, so the fusion arithmetic is testable
/// without an index, an actor, or a model.
///
/// Scores are min-normalised against the best hit of each signal before they are
/// mixed. Raw BM25 is unbounded and cosine is bounded to [-1, 1]; adding them
/// directly makes the weights meaningless, and whichever signal happens to have
/// the larger dynamic range on this corpus silently wins.
public struct HybridDocumentRanker: Sendable {
    private let chunks: [RetrievableChunk]
    private let bm25: BM25Index
    private let embedder: TextEmbedding?
    private let embeddings: [[Double]]
    private let weights: RetrievalWeights

    public init(
        chunks: [RetrievableChunk],
        embedder: TextEmbedding? = nil,
        parameters: BM25Parameters = .default,
        weights: RetrievalWeights? = nil
    ) {
        self.chunks = chunks
        bm25 = BM25Index(chunks: chunks, parameters: parameters)
        self.embedder = embedder
        embeddings = embedder.map { model in chunks.map { model.embed($0.text) } } ?? []
        // Defaulting the weights from the presence of an embedder rather than
        // making the caller keep the two in sync: a semantic weight with no
        // model behind it silently discounts every lexical score by 40%.
        self.weights = weights ?? (embedder == nil ? .lexicalOnly : .default)
    }

    public func rank(query: String, limit: Int) -> [RetrievedPassage] {
        guard limit > 0, !chunks.isEmpty else { return [] }
        guard !SearchNormalizer.tokens(in: query).isEmpty else { return [] }

        let lexical = bm25.scores(for: query)
        var semantic: [Int: Double] = [:]
        if let embedder, !embeddings.isEmpty {
            let queryVector = embedder.embed(query)
            for index in chunks.indices {
                guard let similarity = cosineSimilarity(queryVector, embeddings[index]),
                    similarity > 0
                else { continue }
                semantic[index] = similarity
            }
        }

        let lexicalBest = lexical.values.max() ?? 0
        let semanticBest = semantic.values.max() ?? 0
        // Only chunks at least one signal actually matched are candidates.
        let candidates = Set(lexical.keys).union(semantic.keys)
        guard !candidates.isEmpty else { return [] }

        var passages: [RetrievedPassage] = []
        for index in candidates {
            let lexicalNormalized = lexicalBest > 0 ? (lexical[index] ?? 0) / lexicalBest : 0
            let semanticNormalized = semanticBest > 0 ? (semantic[index] ?? 0) / semanticBest : 0
            let weightTotal = weights.lexical + (embedder == nil ? 0 : weights.semantic)
            guard weightTotal > 0 else { continue }
            let fused = (
                weights.lexical * lexicalNormalized
                    + (embedder == nil ? 0 : weights.semantic * semanticNormalized)
            ) / weightTotal
            passages.append(
                RetrievedPassage(
                    chunk: chunks[index],
                    score: fused,
                    lexicalScore: lexical[index] ?? 0,
                    semanticScore: embedder == nil ? nil : (semantic[index] ?? 0)
                )
            )
        }

        let best = passages.map(\.score).max() ?? 0
        let floor = best * weights.minimumRelativeScore
        return passages
            .filter { $0.score >= floor }
            .sorted(by: Self.order)
            .prefix(limit)
            .map { $0 }
    }

    /// Ties are broken by identifier, never left to dictionary order: a
    /// retrieval that returns different passages for the same query on the same
    /// corpus is untestable and unreproducible for the person reporting a bug.
    private static func order(_ lhs: RetrievedPassage, _ rhs: RetrievedPassage) -> Bool {
        if lhs.score != rhs.score { return lhs.score > rhs.score }
        return lhs.chunk.id < rhs.chunk.id
    }
}

// MARK: - Account-scoped index

/// The live retrieval index, partitioned by account.
///
/// Partitioned for the same reason `InMemoryLocalSearchIndex` is: one person's
/// documents must never be retrievable into another person's prompt, and `wipe`
/// has to be callable on logout, revocation, account switch, and deletion. Held
/// only in memory — nothing here writes plaintext document text to disk.
public actor DocumentRetrievalIndex {
    private var partitions: [StorageAccountID: [String: RetrievableChunk]] = [:]
    private let embedder: TextEmbedding?
    private let parameters: BM25Parameters
    private let weights: RetrievalWeights?

    public init(
        embedder: TextEmbedding? = nil,
        parameters: BM25Parameters = .default,
        weights: RetrievalWeights? = nil
    ) {
        self.embedder = embedder
        self.parameters = parameters
        self.weights = weights
    }

    /// Upserts by chunk id, so re-ingesting a file replaces its chunks rather
    /// than storing a second copy that competes with the first.
    public func insert(_ chunks: [RetrievableChunk], accountID: StorageAccountID) {
        guard !chunks.isEmpty else { return }
        var partition = partitions[accountID] ?? [:]
        for chunk in chunks where !SearchNormalizer.tokens(in: chunk.text).isEmpty {
            partition[chunk.id] = chunk
        }
        partitions[accountID] = partition
    }

    public func removeSource(named sourceName: String, accountID: StorageAccountID) {
        guard var partition = partitions[accountID] else { return }
        partition = partition.filter { $0.value.sourceName != sourceName }
        partitions[accountID] = partition.isEmpty ? nil : partition
    }

    public func wipe(accountID: StorageAccountID) {
        partitions.removeValue(forKey: accountID)
    }

    public func chunkCount(accountID: StorageAccountID) -> Int {
        partitions[accountID]?.count ?? 0
    }

    public func retrieve(
        query: String,
        accountID: StorageAccountID,
        limit: Int = 8
    ) -> [RetrievedPassage] {
        guard let partition = partitions[accountID], !partition.isEmpty else { return [] }
        // Sorted so the corpus order — and therefore every tie-break downstream
        // of it — does not depend on dictionary iteration order.
        let chunks = partition.values.sorted { $0.id < $1.id }
        let ranker = HybridDocumentRanker(
            chunks: chunks,
            embedder: embedder,
            parameters: parameters,
            weights: weights
        )
        return ranker.rank(query: query, limit: limit)
    }
}

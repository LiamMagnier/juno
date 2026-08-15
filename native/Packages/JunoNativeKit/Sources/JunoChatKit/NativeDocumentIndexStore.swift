import Foundation
import JunoCore
import JunoSearch
import JunoStorage
import JunoSync
import Observation
import UniformTypeIdentifiers

// MARK: - What a surface shows

/// One file this device has read into its local retrieval index.
///
/// Every field is either a fact the extractor observed or nil. In particular
/// ``pageCount`` is nil for a CSV rather than zero — a spreadsheet does not have
/// zero pages, it has no pages, and "0 pages" on a card is a claim about the file
/// that is simply untrue. ``usedOpticalCharacterRecognition`` travels with the
/// document for the same reason `IngestedDocument` reports it: text recovered by
/// OCR is a transcription with transcription errors in it, and a surface quoting
/// it back to someone should be able to say so.
public struct NativeIndexedDocument: Identifiable, Equatable, Sendable {
    /// The file name, which is also the identity the retrieval index uses.
    ///
    /// Chunk ids are `"<name>#<position>"`, so two files with the same name are
    /// one document as far as the index is concerned. That is deliberate — it is
    /// what makes re-importing an edited file replace its chunks instead of
    /// doubling them — and it is why importing a *different* file that happens to
    /// share a name replaces the first. The surfaces say "replaced", not "added".
    public var id: String { sourceName }
    public let sourceName: String
    public let format: IngestibleDocumentFormat
    public let chunkCount: Int
    /// Pages, or nil for a format that has none. Never zero.
    public let pageCount: Int?
    public let usedOpticalCharacterRecognition: Bool
    /// When this device read it. A local fact about this index, not a claim about
    /// the file's own modification date, which nothing here has looked at.
    public let indexedAt: Date

    public init(
        sourceName: String,
        format: IngestibleDocumentFormat,
        chunkCount: Int,
        pageCount: Int?,
        usedOpticalCharacterRecognition: Bool,
        indexedAt: Date
    ) {
        self.sourceName = sourceName
        self.format = format
        self.chunkCount = chunkCount
        self.pageCount = pageCount
        self.usedOpticalCharacterRecognition = usedOpticalCharacterRecognition
        self.indexedAt = indexedAt
    }
}

/// One retrieved passage, flattened for display.
///
/// A projection of `RetrievedPassage` rather than the thing itself, so a screen
/// can render a hit without importing `JunoSearch` and without reaching through
/// two levels of retrieval vocabulary (`passage.chunk.metadata.pageNumber`) to
/// print a line of text. The `locator` is composed by the retrieval layer, which
/// is the only place that knows which positional facts are actually known — an
/// invented "page 1" under a citation is the failure this indirection preserves
/// the guard against.
public struct NativeDocumentPassage: Identifiable, Equatable, Sendable {
    public let id: String
    public let sourceName: String
    /// e.g. `Q3 Report.pdf, page 4 — Revenue`. Contains only the parts that are
    /// known about this passage's position.
    public let locator: String
    public let text: String
    /// Fused score in [0, 1] relative to the best hit *for this query*. Not
    /// comparable across queries and not a probability, so surfaces show it as a
    /// rank order rather than as a percentage of anything.
    public let score: Double

    public init(id: String, sourceName: String, locator: String, text: String, score: Double) {
        self.id = id
        self.sourceName = sourceName
        self.locator = locator
        self.text = text
        self.score = score
    }

    init(_ passage: RetrievedPassage) {
        self.init(
            id: passage.chunk.id,
            sourceName: passage.chunk.sourceName,
            locator: passage.chunk.locator,
            text: passage.chunk.text,
            score: passage.score
        )
    }
}

// MARK: - The store

/// The user-facing entry point to ``DocumentIngestionPipeline``: pick a file,
/// read it into chunks, put the chunks in the account's retrieval index, and ask
/// the index questions.
///
/// **Why this type exists at all.** The three halves of local document search
/// each live in a different module — extraction and chunking in `JunoStorage`,
/// ranking and the account-partitioned index in `JunoSearch`, and the screens in
/// the two app targets — and only `JunoChatKit` can see all three. Without one
/// place holding the pipeline and the index together, every surface that wanted
/// to import a file would have to compose them itself, and the second one to do
/// it would get the ordering subtly wrong: the `removeSource` before `insert`
/// below is not obvious, and skipping it leaves stale passages behind.
///
/// **Nothing here is written to disk.** `DocumentRetrievalIndex` holds chunks in
/// memory only, and this store adds no persistence of its own, so the plaintext
/// of someone's contract or medical letter never leaves the process. The cost is
/// that the index is empty at every launch, which is stated on screen rather than
/// hidden — an index that silently forgot last week's import would be worse than
/// one that says it starts empty.
///
/// **Partitioned by account, and wiped on sign-out.** Same rule the rest of the
/// app follows: one person's documents must never be retrievable into another
/// person's prompt. ``stop()`` wipes the partition it was serving rather than
/// merely dropping the reference to it.
@MainActor
@Observable
public final class NativeDocumentIndexModel {
    /// What the index holds, newest import first.
    public private(set) var documents: [NativeIndexedDocument] = []
    /// The file currently being read, or nil.
    ///
    /// The name rather than a `Bool`, because a PDF with OCR can take several
    /// seconds and "Reading Contract.pdf…" is the difference between a progress
    /// spinner that means something and one that only means "wait".
    public private(set) var ingestingFileName: String?
    public private(set) var lastErrorDescription: String?
    public private(set) var query = ""
    public private(set) var passages: [NativeDocumentPassage] = []
    public private(set) var isSearching = false

    @ObservationIgnored
    private let pipeline: DocumentIngestionPipeline
    @ObservationIgnored
    private let index: DocumentRetrievalIndex
    @ObservationIgnored
    private let resultLimit: Int
    @ObservationIgnored
    private var accountID: AccountID?
    @ObservationIgnored
    private var searchTask: Task<Void, Never>?

    /// - Parameter index: defaults to a hybrid index over ``HashingTextEmbedder``.
    ///   That encoder is **not** a semantic model and is not described as one
    ///   anywhere the reader can see: it is the hashing trick over unigrams and
    ///   bigrams, so it notices repeated phrasing that BM25's bag of words cannot
    ///   and notices nothing at all about meaning. It is used rather than
    ///   `RetrievalWeights.lexicalOnly` because the phrase-order signal is real
    ///   and free; it must not be used as grounds for telling anyone their
    ///   documents are searched by meaning.
    public init(
        pipeline: DocumentIngestionPipeline = DocumentIngestionPipeline(),
        index: DocumentRetrievalIndex = DocumentRetrievalIndex(embedder: HashingTextEmbedder()),
        resultLimit: Int = 8
    ) {
        self.pipeline = pipeline
        self.index = index
        self.resultLimit = max(1, resultLimit)
    }

    /// The document types the system open panel should offer.
    ///
    /// Derived from what ``IngestibleDocumentFormat`` can actually read, so a
    /// panel can never hand back a file the pipeline will refuse. A type the
    /// running OS does not declare is dropped rather than forced: an unresolvable
    /// identifier in this list makes the whole panel refuse every file.
    public static var readableContentTypes: [UTType] {
        var types: [UTType] = [.pdf, .commaSeparatedText, .plainText]
        if let docx = UTType("org.openxmlformats.wordprocessingml.document") {
            types.append(docx)
        }
        if let markdown = UTType(filenameExtension: "md") {
            types.append(markdown)
        }
        return types
    }

    /// True once an account is signed in. Surfaces hide the import control rather
    /// than disabling it when this is false — there is nowhere to put a document.
    public var isReady: Bool { accountID != nil }

    public var isIngesting: Bool { ingestingFileName != nil }

    /// Every chunk currently retrievable, across all documents.
    public var chunkCount: Int {
        documents.reduce(0) { $0 + $1.chunkCount }
    }

    public func start(for accountID: AccountID) {
        guard self.accountID != accountID else { return }
        stop()
        self.accountID = accountID
    }

    /// Forgets everything and wipes the partition that was being served.
    ///
    /// The wipe is fired as a task rather than awaited because sign-out is
    /// synchronous everywhere else in the shell. It is safe to let it land late:
    /// it names the partition it is clearing, so a different account signing in
    /// during the same run loop turn cannot have its own chunks removed.
    public func stop() {
        searchTask?.cancel()
        searchTask = nil
        let previous = accountID
        accountID = nil
        documents = []
        passages = []
        query = ""
        isSearching = false
        lastErrorDescription = nil
        guard let previous else { return }
        let index = index
        Task { await index.wipe(accountID: StorageAccountID(previous.rawValue)) }
    }

    public func clearError() {
        lastErrorDescription = nil
    }

    // MARK: Importing

    /// Reads a file the person chose and adds it to the index.
    ///
    /// Both the read and the extraction run off the main actor: a scanned PDF
    /// goes through Vision, which takes seconds per page, and doing that on the
    /// main actor freezes the window for the whole import.
    public func ingest(contentsOf url: URL) async {
        await ingest(source: .url(url), fileName: url.lastPathComponent)
    }

    /// Adds bytes the caller already has — a download, a paste, an attachment
    /// whose contents were fetched — under the name they should be cited by.
    public func ingest(data: Data, fileName: String) async {
        await ingest(source: .data(data), fileName: fileName)
    }

    /// Removes one document's chunks. The passages update immediately, so a hit
    /// quoting a file that was just removed cannot stay on screen.
    public func remove(_ document: NativeIndexedDocument) async {
        guard let accountID else { return }
        await index.removeSource(
            named: document.sourceName,
            accountID: StorageAccountID(accountID.rawValue)
        )
        guard self.accountID == accountID else { return }
        documents.removeAll { $0.sourceName == document.sourceName }
        refreshResults()
    }

    // MARK: Searching

    public func setQuery(_ value: String) {
        guard query != value else { return }
        query = value
        refreshResults()
    }

    // MARK: - Internals

    /// Where the bytes come from. A single enum so the read, the extraction and
    /// the security-scope handling all happen inside one detached task instead of
    /// being duplicated once per entry point.
    private enum Source: Sendable {
        case url(URL)
        case data(Data)
    }

    /// Deliberately not `Result<_, any Error>`: an error existential is not
    /// `Sendable`, so the failure crosses the actor boundary as the sentence it
    /// will be shown as.
    private enum Outcome: Sendable {
        case ingested(IngestedDocument)
        case failed(String)
    }

    private func ingest(source: Source, fileName: String) async {
        guard ingestingFileName == nil else { return }
        guard let accountID else {
            lastErrorDescription = "Sign in before adding a document to this device’s index."
            return
        }
        ingestingFileName = fileName
        lastErrorDescription = nil
        defer { ingestingFileName = nil }

        let pipeline = pipeline
        let outcome = await Task.detached(priority: .userInitiated) { () -> Outcome in
            do {
                let data: Data
                switch source {
                case let .data(bytes):
                    data = bytes
                case let .url(url):
                    // A file chosen through the system open panel arrives inside
                    // a security scope the sandbox grants for this URL alone.
                    // Without the claim, reading it fails with a permission error
                    // that reads like a corrupt file; the balancing release
                    // matters just as much, because the grants are a finite
                    // resource and a leaked one is never returned.
                    let scoped = url.startAccessingSecurityScopedResource()
                    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                    data = try Data(contentsOf: url, options: [.mappedIfSafe])
                }
                return .ingested(try pipeline.ingest(data: data, fileName: fileName))
            } catch {
                return .failed(NativeFailureMessage.presentable(error))
            }
        }.value

        switch outcome {
        case let .failed(message):
            lastErrorDescription = message
        case let .ingested(document):
            await store(document, accountID: accountID)
        }
    }

    private func store(_ document: IngestedDocument, accountID: AccountID) async {
        // Checked before the write, not after: an import that finished while
        // someone was signing out must not put chunks back into a partition
        // `stop()` has already wiped.
        guard self.accountID == accountID else { return }
        let storageID = StorageAccountID(accountID.rawValue)

        // Removing first is what makes a re-import a *replacement*. Chunk ids are
        // position-derived, so importing a shortened file overwrites the first N
        // chunks and leaves everything past N in place — passages quoting text
        // the document no longer contains, ranked alongside text it does.
        await index.removeSource(named: document.sourceName, accountID: storageID)
        await index.insert(document.chunks.map(RetrievableChunk.init), accountID: storageID)
        guard self.accountID == accountID else { return }

        let entry = NativeIndexedDocument(
            sourceName: document.sourceName,
            format: document.format,
            chunkCount: document.chunks.count,
            pageCount: document.pageCount,
            usedOpticalCharacterRecognition: document.usedOpticalCharacterRecognition,
            indexedAt: Date()
        )
        documents.removeAll { $0.sourceName == entry.sourceName }
        documents.insert(entry, at: 0)
        refreshResults()
    }

    private func refreshResults() {
        searchTask?.cancel()
        searchTask = nil
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let accountID, !trimmed.isEmpty, !documents.isEmpty else {
            // Not an empty result *set* — there was no question asked, or nothing
            // to ask it of. Surfaces distinguish the two, so neither renders as
            // "no matches" over a corpus that was never searched.
            passages = []
            isSearching = false
            return
        }
        isSearching = true
        let index = index
        let limit = resultLimit
        let storageID = StorageAccountID(accountID.rawValue)
        searchTask = Task { [weak self] in
            let found = await index.retrieve(query: trimmed, accountID: storageID, limit: limit)
            guard !Task.isCancelled, let self, self.accountID == accountID,
                self.query.trimmingCharacters(in: .whitespacesAndNewlines) == trimmed
            else { return }
            passages = found.map(NativeDocumentPassage.init)
            isSearching = false
        }
    }
}

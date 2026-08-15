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

    /// Ranks the corpus for one question and hands the hits straight back,
    /// without disturbing anything a screen is currently showing.
    ///
    /// **Why this is not `setQuery` followed by reading ``passages``.** Those two
    /// are the *search field's* state. A chat send that drove them would wipe
    /// whatever the reader had typed into the Library's search box, and would
    /// then leave the chat's hits sitting in the Library's result list as though
    /// somebody had searched for them there. This shares the index and nothing
    /// else, which is what lets a turn be grounded while a search is open.
    ///
    /// An empty array is the answer for every ordinary "nothing to say" case —
    /// signed out, nothing indexed, a blank question, no chunk matched — and
    /// none of them is an error. A send is the worst possible moment to put a
    /// failure notice in front of someone for the absence of a document they
    /// never claimed to have.
    ///
    /// - Parameter limit: how many passages at most. Defaults to the store's own
    ///   ``resultLimit``; a caller with a character budget should ask for fewer
    ///   rather than retrieve eight and discard five.
    public func passages(matching query: String, limit: Int? = nil) async -> [NativeDocumentPassage] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let accountID, !trimmed.isEmpty, !documents.isEmpty else { return [] }
        let found = await index.retrieve(
            query: trimmed,
            accountID: StorageAccountID(accountID.rawValue),
            limit: max(1, limit ?? resultLimit)
        )
        // Re-checked *after* the await, for the same reason `store(_:accountID:)`
        // checks before its write: someone can sign out or switch accounts while
        // the rank is running, and handing one person's passages to the other
        // person's prompt is the exact failure the partitioning exists to stop.
        guard self.accountID == accountID else { return [] }
        return found.map(NativeDocumentPassage.init)
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

// MARK: - Putting passages in front of a model

/// One chat turn, rewritten to carry the passages that back it.
///
/// **How the passages actually reach the model, and why it is this way.**
/// `/api/chat` composes the system prompt server-side, and
/// ``NativeChatGenerationRequest`` carries no free-text context field of any
/// kind — the request names a conversation and the server reads that
/// conversation's history. The only text this client controls end to end is the
/// body of the user message it appends. So grounding is done by extending that
/// message, and ``promptForModel`` is what gets sent, stored, and shown.
///
/// That consequence is the design rather than a compromise. Whatever the model
/// is shown is exactly what the transcript shows, so a reader can always scroll
/// up and audit which sentences of which of their files left the Mac. A private
/// side-channel would have been the same feature with the evidence deleted, and
/// "Juno quietly attached four paragraphs of your medical letter" is not a thing
/// anybody should have to take on trust.
///
/// **Markers are assigned last, and only to passages that survived the budget.**
/// This is the invariant the whole type exists to hold. Number the hits first,
/// then drop the ones that do not fit, and `[3]` names nothing while still
/// reading to the model as an ordinary citation — a fabricated source with a
/// real-looking marker. ``cited`` is therefore definitive: `cited[0]` is `[1]`,
/// `cited.count` is the largest marker that exists, and a surface resolving a
/// marker back to a file must read it from here rather than re-running the
/// retrieval and hoping the ranking came out the same.
public struct NativeDocumentGrounding: Equatable, Sendable {
    /// The passages that were given a marker, in marker order.
    ///
    /// Their ``NativeDocumentPassage/text`` is the *excerpt as sent*, not the
    /// whole chunk: a truncated quote and the passage it came from are different
    /// strings, and a reader auditing what was sent has to be shown the one that
    /// was actually sent.
    public let cited: [NativeDocumentPassage]
    /// The text to send as the user turn.
    ///
    /// Byte-identical to the reader's own prompt when ``cited`` is empty. An
    /// ungrounded turn must not carry a heading announcing context that is not
    /// there — a model handed "Context from my documents:" over nothing will
    /// still try to honour it.
    public let promptForModel: String

    public var isGrounded: Bool { !cited.isEmpty }

    /// The documents the markers point into, in marker order and de-duplicated.
    /// Two passages from one PDF are one document, which is what a note above
    /// the composer should say.
    public var citedSourceNames: [String] {
        var seen = Set<String>()
        return cited.map(\.sourceName).filter { seen.insert($0).inserted }
    }

    /// A turn nothing was attached to. The only way to build one where `cited`
    /// is empty, so "not grounded" cannot be spelled two ways.
    public init(ungrounded prompt: String) {
        cited = []
        promptForModel = prompt
    }

    private init(cited: [NativeDocumentPassage], promptForModel: String) {
        self.cited = cited
        self.promptForModel = promptForModel
    }

    // MARK: Budget

    /// How many passages one turn may carry.
    ///
    /// Four rather than the index's default eight. These excerpts are prepended
    /// to every question in a conversation the server also replays history for,
    /// and eight chunks at the chunker's 1,200-character ceiling is most of ten
    /// thousand characters of other people's prose in front of a one-line
    /// question — which is how a model ends up answering about the context
    /// instead of about what was asked.
    public static let maximumPassages = 4
    /// The longest a single excerpt may be before it is cut.
    public static let maximumPassageCharacters = 1_200
    /// The ceiling on the whole appended block, locators and instructions
    /// included.
    ///
    /// Below `maximumPassages × maximumPassageCharacters` on purpose, so this is
    /// a rail that actually fires rather than arithmetic that can never bind:
    /// four chunks at the chunker's full ceiling is 4,800 characters of somebody
    /// else's prose in front of a one-line question, and the turn after it, and
    /// the turn after that. Four *short* passages fit; four long ones do not, and
    /// the ones that do not fit are dropped before any marker is handed out.
    public static let maximumBlockCharacters = 4_000

    /// Builds the turn to send from the reader's prompt and the passages
    /// retrieval returned, in rank order.
    ///
    /// Passages are taken in order until the budget is spent, and the **first**
    /// one that does not fit ends the block rather than being skipped over in
    /// favour of a shorter, lower-ranked one. That keeps what is sent a prefix of
    /// the ranking, which is the only version of this a reader can predict and a
    /// test can pin down.
    public static func ground(
        prompt: String,
        in passages: [NativeDocumentPassage]
    ) -> NativeDocumentGrounding {
        var cited: [NativeDocumentPassage] = []
        var remaining = maximumBlockCharacters - preamble.count - closingReserve

        for passage in passages.prefix(maximumPassages) {
            let excerpt = Self.excerpt(passage.text)
            // An excerpt that came out empty is a passage with nothing quotable
            // in it. Numbering it would produce a marker over a blank quote,
            // which is a citation to nothing.
            guard !excerpt.isEmpty else { continue }
            // `+ 8` for the marker, the brackets and the blank lines around the
            // entry — deliberately over-counted rather than measured, because the
            // ceiling is a safety rail and an exact fit is worth nothing.
            let cost = excerpt.count + passage.locator.count + 8
            guard cost <= remaining else { break }
            remaining -= cost
            cited.append(
                NativeDocumentPassage(
                    id: passage.id,
                    sourceName: passage.sourceName,
                    locator: passage.locator,
                    text: excerpt,
                    score: passage.score
                )
            )
        }

        guard !cited.isEmpty else { return NativeDocumentGrounding(ungrounded: prompt) }

        var block = preamble
        for (offset, passage) in cited.enumerated() {
            block += "\n\n[\(offset + 1)] \(passage.locator)\n\(passage.text)"
        }
        block += "\n\n" + closing(count: cited.count)

        // The reader's own words first, then the material. The other order reads
        // better to a model and worse to a person: this string is also the
        // message bubble in the transcript, and a bubble that opens with two
        // pages of a PDF has buried the question its owner actually asked.
        let question = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        return NativeDocumentGrounding(
            cited: cited,
            promptForModel: question.isEmpty ? block : "\(question)\n\n\(block)"
        )
    }

    // MARK: The wording

    private static let preamble = """
    ---
    Excerpts retrieved from documents held on my own device, quoted verbatim:
    """

    /// What the closing instruction costs, reserved before any passage is
    /// measured. Computed from the longest form it can take — the count is
    /// interpolated into it — so the budget cannot be overspent by a block that
    /// happened to number into two digits.
    private static let closingReserve = closing(count: maximumPassages).count + 4

    /// The instruction that turns excerpts into citable sources.
    ///
    /// It names the exact range of markers that exist. Without the range a model
    /// handed two excerpts will still occasionally produce a `[3]`, and a `[3]`
    /// under an answer is indistinguishable to a reader from a real source they
    /// could go and check.
    private static func closing(count: Int) -> String {
        let range = count == 1 ? "[1]" : "[1] to [\(count)]"
        return """
        Cite an excerpt with its marker — \(range), and no other number — only \
        where that excerpt actually supports what you just said. If they do not \
        answer the question, say so and answer without them rather than \
        attributing anything to these files that they do not contain.
        """
    }

    /// Cuts an excerpt to length at a word boundary.
    ///
    /// Mid-word truncation invents words ("the settleme…"), and a quote is being
    /// presented as verbatim. The ellipsis stays so the model — and the reader
    /// auditing the bubble — can see the quote is a fragment of something longer.
    static func excerpt(_ text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count > maximumPassageCharacters else { return trimmed }
        let head = trimmed.prefix(maximumPassageCharacters)
        guard let lastSpace = head.lastIndex(where: { $0.isWhitespace }) else {
            return head + "…"
        }
        return head[head.startIndex..<lastSpace] + "…"
    }
}

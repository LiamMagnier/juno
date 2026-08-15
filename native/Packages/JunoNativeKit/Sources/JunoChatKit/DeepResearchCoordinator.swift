import Foundation
import JunoSearch
import JunoSync

/// What the loop wants done next. Produced by the machine, executed by the
/// coordinator, and never the other way around.
public enum DeepResearchCommand: Equatable, Sendable {
    case decompose(question: String, maximumQueries: Int)
    case search(queries: [String], round: Int)
    case read(hits: [ResearchSearchHit])
    case analyzeGaps(round: Int)
    case synthesize
    case stop(DeepResearchStopReason)
}

/// What actually happened. Fed back into the machine.
public enum DeepResearchInput: Equatable, Sendable {
    case decomposed([String])
    case searchCompleted(query: String, hits: [ResearchSearchHit])
    case searchFailed(query: String, reason: String)
    case pageRead(ResearchPage)
    case pageFailed(url: URL, reason: String)
    case gapsIdentified([String])
    case synthesized(String)
    case failed(String)
    case cancelled
}

/// The research loop as a pure value.
///
/// Everything that decides *what happens next* — when a round ends, when the
/// budget is spent, which queries are worth running, which page earns a citation
/// number, whether there is enough evidence to write anything at all — lives
/// here, in a type with no network, no clock, no actor, and no model behind it.
/// The coordinator below is a thin executor: it turns a `DeepResearchCommand`
/// into calls on injected protocols and feeds the results back as
/// `DeepResearchInput`.
///
/// The split is not stylistic. A research loop's bugs are almost all ordering
/// bugs — a round that never ends, a query that runs twice, a page counted
/// against the budget after the budget closed, a citation number handed out for
/// a fetch that failed — and none of those are testable if the state lives
/// inside the same code that awaits the network.
public struct DeepResearchMachine: Sendable {
    public let question: String
    public let limits: DeepResearchLimits

    public private(set) var phase: DeepResearchPhase = .planning
    /// 0 until planning finishes, then 1-based. Not 1 from the start: before a
    /// query exists there is no round, and reporting "round 1 of 3" during
    /// planning describes work that has not begun.
    public private(set) var round = 0
    public private(set) var pendingQueries: [String] = []
    public private(set) var executedQueries: [String] = []
    public private(set) var pendingHits: [ResearchSearchHit] = []
    public private(set) var notes: [ResearchNote] = []
    /// The single source of citation numbers. Nothing else in this type mints
    /// one, so a `[n]` cannot exist without a page behind it.
    public private(set) var registry = CitationRegistry()
    public private(set) var report: DeepResearchReport?
    public private(set) var stopReason: DeepResearchStopReason?

    private var readURLs: Set<String> = []
    private var queuedURLs: Set<String> = []
    private var normalizedExecutedQueries: Set<String> = []

    public init(question: String, limits: DeepResearchLimits = .default) {
        self.question = question
        self.limits = limits
    }

    public var pagesRead: Int { notes.count }
    public var isFinished: Bool { phase == .completed || phase == .stopped }

    public func nextCommand() -> DeepResearchCommand {
        switch phase {
        case .planning:
            .decompose(question: question, maximumQueries: limits.queriesPerRound)
        case .searching:
            .search(queries: pendingQueries, round: round)
        case .reading:
            .read(hits: pendingHits)
        case .gapAnalysis:
            .analyzeGaps(round: round)
        case .synthesizing:
            .synthesize
        case .completed, .stopped:
            .stop(stopReason ?? .completed)
        }
    }

    /// Applies one outcome and returns everything the surface should be told.
    ///
    /// Inputs that do not match the current phase are ignored rather than
    /// applied. A late `searchCompleted` arriving after the round already closed
    /// is a real possibility with a fan-out, and applying it would reopen a
    /// finished round.
    @discardableResult
    public mutating func ingest(_ input: DeepResearchInput) -> [DeepResearchProgress] {
        guard !isFinished || input == .cancelled else { return [] }

        switch input {
        case let .decomposed(queries):
            return applyDecomposed(queries)
        case let .searchCompleted(query, hits):
            return applySearchResult(query: query, hits: hits, failure: nil)
        case let .searchFailed(query, reason):
            return applySearchResult(query: query, hits: [], failure: reason)
        case let .pageRead(page):
            return applyPageRead(page)
        case let .pageFailed(url, reason):
            return applyPageFailure(url: url, reason: reason)
        case let .gapsIdentified(queries):
            return applyGaps(queries)
        case let .synthesized(markdown):
            return applySynthesis(markdown)
        case let .failed(reason):
            return terminate(.failed(reason))
        case .cancelled:
            guard !isFinished else { return [] }
            return terminate(.cancelled)
        }
    }

    // MARK: - Transitions

    private mutating func applyDecomposed(_ queries: [String]) -> [DeepResearchProgress] {
        guard phase == .planning else { return [] }
        var planned = normalize(queries)
        if planned.isEmpty {
            // The question itself is a legitimate query, and falling back to it
            // is not a guess about intent — it is the literal thing the person
            // asked. Only when that is empty too is there nothing to run.
            planned = normalize([question])
        }
        guard !planned.isEmpty else { return terminate(.noQueriesPlanned) }

        round = 1
        pendingQueries = planned
        phase = .searching
        return [
            .plannedQueries(planned, round: round),
            .phase(.searching),
        ]
    }

    private mutating func applySearchResult(
        query: String,
        hits: [ResearchSearchHit],
        failure: String?
    ) -> [DeepResearchProgress] {
        guard phase == .searching,
            let index = pendingQueries.firstIndex(of: query)
        else { return [] }

        pendingQueries.remove(at: index)
        executedQueries.append(query)
        normalizedExecutedQueries.insert(Self.normalizedKey(query))

        var progress: [DeepResearchProgress] = []
        if let failure {
            progress.append(.searchFailed(query: query, reason: failure))
        } else {
            var accepted = 0
            for hit in hits where accepted < limits.hitsPerQuery {
                // A URL already read, or already queued by another query in the
                // same fan-out, must not be fetched twice: it would consume the
                // page budget twice and register as two citations for one page.
                let key = Self.normalizedURL(hit.url)
                guard !readURLs.contains(key), queuedURLs.insert(key).inserted else { continue }
                pendingHits.append(hit)
                accepted += 1
            }
            progress.append(.searchFinished(query: query, hitCount: accepted))
        }

        guard pendingQueries.isEmpty else { return progress }
        return progress + finishSearchRound()
    }

    private mutating func finishSearchRound() -> [DeepResearchProgress] {
        let remainingBudget = max(0, limits.maximumPages - notes.count)
        if pendingHits.count > remainingBudget {
            // Trimmed here rather than while reading, so the budget is enforced
            // before any fetch starts and the reported plan matches the work.
            for dropped in pendingHits.dropFirst(remainingBudget) {
                queuedURLs.remove(Self.normalizedURL(dropped.url))
            }
            pendingHits = Array(pendingHits.prefix(remainingBudget))
        }

        guard !pendingHits.isEmpty else { return advanceAfterReading() }
        phase = .reading
        return [.phase(.reading)]
    }

    private mutating func applyPageRead(_ page: ResearchPage) -> [DeepResearchProgress] {
        guard phase == .reading else { return [] }
        let key = Self.normalizedURL(page.url)
        guard let index = pendingHits.firstIndex(where: {
            Self.normalizedURL($0.url) == key
        }) else { return [] }
        let hit = pendingHits.remove(at: index)
        queuedURLs.remove(key)

        let text = page.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            // A page that fetched but yielded no text is not a source. Giving it
            // a citation number would let the report cite a blank page.
            var progress: [DeepResearchProgress] = [
                .pageFailed(url: page.url, reason: "The page had no readable text."),
            ]
            if pendingHits.isEmpty { progress += advanceAfterReading() }
            return progress
        }

        readURLs.insert(key)
        let title = page.title.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolved = title.isEmpty ? hit.title : title
        let number = registry.register(
            title: resolved,
            url: page.url,
            locator: page.url.host ?? page.url.absoluteString,
            snippet: CitationRegistry.snippet(from: text)
        )
        notes.append(
            ResearchNote(
                citation: number,
                title: resolved,
                url: page.url,
                excerpt: String(text.prefix(limits.excerptCharacters))
            )
        )

        var progress: [DeepResearchProgress] = [
            .pageRead(
                title: resolved,
                url: page.url,
                citation: number,
                pagesRead: notes.count
            ),
            .citationsAccumulated(registry.count),
        ]
        if pendingHits.isEmpty { progress += advanceAfterReading() }
        return progress
    }

    private mutating func applyPageFailure(
        url: URL,
        reason: String
    ) -> [DeepResearchProgress] {
        guard phase == .reading else { return [] }
        let key = Self.normalizedURL(url)
        guard let index = pendingHits.firstIndex(where: {
            Self.normalizedURL($0.url) == key
        }) else { return [] }
        pendingHits.remove(at: index)
        queuedURLs.remove(key)

        var progress: [DeepResearchProgress] = [.pageFailed(url: url, reason: reason)]
        if pendingHits.isEmpty { progress += advanceAfterReading() }
        return progress
    }

    private mutating func advanceAfterReading() -> [DeepResearchProgress] {
        // Both ceilings are checked before another round is opened, because a
        // round that opens with no budget left runs searches whose results can
        // never be read.
        guard notes.count < limits.maximumPages, round < limits.maximumRounds else {
            return finishOrStop()
        }
        phase = .gapAnalysis
        return [.phase(.gapAnalysis)]
    }

    private mutating func applyGaps(_ queries: [String]) -> [DeepResearchProgress] {
        guard phase == .gapAnalysis else { return [] }
        let planned = normalize(queries)
        guard !planned.isEmpty else { return finishOrStop() }

        round += 1
        pendingQueries = planned
        phase = .searching
        return [
            .gapsIdentified(planned, round: round),
            .plannedQueries(planned, round: round),
            .phase(.searching),
        ]
    }

    private mutating func finishOrStop() -> [DeepResearchProgress] {
        // The rule that makes this a research loop rather than a slow chat turn:
        // with nothing read, there is nothing to write. Synthesizing here would
        // produce a confident, uncited essay in the visual language of a
        // researched report, which is the single most misleading thing this
        // feature could do.
        guard !notes.isEmpty else { return terminate(.noSourcesFound) }
        phase = .synthesizing
        return [.phase(.synthesizing)]
    }

    private mutating func applySynthesis(_ markdown: String) -> [DeepResearchProgress] {
        guard phase == .synthesizing else { return [] }
        let rendered = registry.rendered(markdown)
        let finished = DeepResearchReport(
            question: question,
            markdown: rendered,
            // Every registered citation is a page that was really fetched and
            // really had text, so all of them belong on the source list even if
            // the writer referenced only some. The marker filter above is about
            // what the prose may claim, not about what was read.
            citations: registry.citations,
            roundsRun: round,
            pagesRead: notes.count
        )
        report = finished
        phase = .completed
        stopReason = .completed
        return [
            .report(finished),
            .phase(.completed),
            .stopped(.completed),
        ]
    }

    private mutating func terminate(
        _ reason: DeepResearchStopReason
    ) -> [DeepResearchProgress] {
        phase = reason == .completed ? .completed : .stopped
        stopReason = reason
        return [.phase(phase), .stopped(reason)]
    }

    // MARK: - Query hygiene

    /// Trims, de-duplicates, drops anything already run, and caps the round.
    ///
    /// Dropping already-run queries is what stops the loop from spinning: a gap
    /// analyzer handed the same corpus twice tends to propose the same query
    /// twice, and re-running it burns a round to arrive at the same corpus.
    private func normalize(_ queries: [String]) -> [String] {
        var seen = Set(normalizedExecutedQueries)
        seen.formUnion(pendingQueries.map(Self.normalizedKey))
        var result: [String] = []
        for query in queries {
            let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { continue }
            let key = Self.normalizedKey(trimmed)
            guard !key.isEmpty, seen.insert(key).inserted else { continue }
            result.append(trimmed)
            if result.count == limits.queriesPerRound { break }
        }
        return result
    }

    private static func normalizedKey(_ query: String) -> String {
        SearchNormalizer.tokens(in: query).joined(separator: " ")
    }

    /// Two URLs that differ only by fragment are the same page, and fetching
    /// both spends the budget twice for one document.
    private static func normalizedURL(_ url: URL) -> String {
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        components?.fragment = nil
        return (components?.url?.absoluteString ?? url.absoluteString).lowercased()
    }
}

/// Drives `DeepResearchMachine` against injected capabilities, streaming
/// progress as it goes.
///
/// **Scope, stated plainly:** this is a *client-side* research loop over
/// capabilities the caller supplies — a local document index, an on-device
/// corpus, an offline cache. It is not, and must not become, a second
/// implementation of the server's deep research. That pipeline already exists:
/// native sends `deepResearch: true` and renders the `activity` events the
/// server streams back (see `NativeChatAPIClient` and `NativeSearchActivity`).
/// For that path, `DeepResearchActivityProjection` reports progress in the same
/// vocabulary as this type, so a surface renders both without knowing which one
/// produced the run.
public struct DeepResearchCoordinator: Sendable {
    private let planner: any ResearchQueryPlanning
    private let searcher: any ResearchSearching
    private let reader: any ResearchPageReading
    private let analyzer: any ResearchGapAnalyzing
    private let synthesizer: any ResearchSynthesizing
    private let limits: DeepResearchLimits

    public init(
        planner: any ResearchQueryPlanning,
        searcher: any ResearchSearching,
        reader: any ResearchPageReading,
        analyzer: any ResearchGapAnalyzing,
        synthesizer: any ResearchSynthesizing,
        limits: DeepResearchLimits = .default
    ) {
        self.planner = planner
        self.searcher = searcher
        self.reader = reader
        self.analyzer = analyzer
        self.synthesizer = synthesizer
        self.limits = limits
    }

    /// Runs the loop, streaming every step. The stream finishes after
    /// `.stopped`, and cancelling the consuming task cancels the run.
    public func stream(question: String) -> AsyncStream<DeepResearchProgress> {
        AsyncStream { continuation in
            let task = Task {
                await drive(question: question, continuation: continuation)
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// Convenience for callers that only want the outcome. The report is nil
    /// exactly when the run stopped without evidence — never nil for a run that
    /// completed.
    public func run(
        question: String
    ) async -> (report: DeepResearchReport?, stopReason: DeepResearchStopReason) {
        var report: DeepResearchReport?
        var stopReason: DeepResearchStopReason = .cancelled
        for await progress in stream(question: question) {
            switch progress {
            case let .report(value): report = value
            case let .stopped(reason): stopReason = reason
            default: continue
            }
        }
        return (report, stopReason)
    }

    // MARK: - Execution

    private func drive(
        question: String,
        continuation: AsyncStream<DeepResearchProgress>.Continuation
    ) async {
        var machine = DeepResearchMachine(question: question, limits: limits)
        continuation.yield(.phase(.planning))

        while true {
            if Task.isCancelled {
                for progress in machine.ingest(.cancelled) { continuation.yield(progress) }
                break
            }

            let command = machine.nextCommand()
            if case .stop = command { break }

            // The machine's accumulated notes are handed to the executor rather
            // than read by it: the executor never holds research state, so there
            // is exactly one place where "what we know so far" lives.
            let inputs = await execute(
                command,
                question: question,
                notes: machine.notes,
                continuation: continuation
            )
            for input in inputs {
                for progress in machine.ingest(input) { continuation.yield(progress) }
            }
        }
        continuation.finish()
    }

    /// Runs one command and returns the inputs it produced, in a deterministic
    /// order.
    ///
    /// Order matters even though the work is concurrent: results are collected
    /// by key and then replayed in the order the commands listed them, so two
    /// runs over the same stubs produce the same citation numbers. Feeding
    /// results back in completion order would make citation numbering depend on
    /// network timing, which is untestable and unreproducible in a bug report.
    private func execute(
        _ command: DeepResearchCommand,
        question: String,
        notes: [ResearchNote],
        continuation: AsyncStream<DeepResearchProgress>.Continuation
    ) async -> [DeepResearchInput] {
        switch command {
        case let .decompose(question, maximumQueries):
            do {
                let queries = try await planner.decompose(
                    question: question,
                    maximumQueries: maximumQueries
                )
                return [.decomposed(queries)]
            } catch {
                // Planning is the one step with no partial result to fall back
                // on, so its failure ends the run rather than degrading it.
                return [.failed(NativeFailureMessage.presentable(error))]
            }

        case let .search(queries, round):
            for query in queries {
                continuation.yield(.searchStarted(query: query, round: round))
            }
            let outcomes = await searchAll(queries)
            return queries.map { query in
                switch outcomes[query] {
                case let .hits(hits): .searchCompleted(query: query, hits: hits)
                case let .failure(reason): .searchFailed(query: query, reason: reason)
                case nil: .searchFailed(query: query, reason: "The search did not run.")
                }
            }

        case let .read(hits):
            let outcomes = await readAll(hits)
            return hits.map { hit in
                switch outcomes[hit.url.absoluteString] {
                case let .page(page): .pageRead(page)
                case let .failure(reason): .pageFailed(url: hit.url, reason: reason)
                case nil: .pageFailed(url: hit.url, reason: "The page was not read.")
                }
            }

        case let .analyzeGaps(round):
            do {
                let queries = try await analyzer.followUpQueries(
                    question: question,
                    notes: notes,
                    round: round,
                    maximumQueries: limits.queriesPerRound
                )
                return [.gapsIdentified(queries)]
            } catch {
                // A failed gap analysis is not a failed run: what has been read
                // so far is still worth writing up. Reported as "no gaps" so the
                // machine moves on to synthesis with the evidence it has.
                return [.gapsIdentified([])]
            }

        case .synthesize:
            do {
                let markdown = try await synthesizer.synthesize(
                    question: question,
                    notes: notes
                )
                return [.synthesized(markdown)]
            } catch {
                return [.failed(NativeFailureMessage.presentable(error))]
            }

        case .stop:
            // Unreachable: `drive` breaks on `.stop` before calling this. Kept
            // exhaustive rather than defaulted so adding a command is a compile
            // error here instead of a silently ignored branch.
            return []
        }
    }

    private enum SearchOutcome: Sendable {
        case hits([ResearchSearchHit])
        case failure(String)
    }

    private enum ReadOutcome: Sendable {
        case page(ResearchPage)
        case failure(String)
    }

    /// Fan-out with a ceiling on how many searches are in flight.
    ///
    /// Unbounded parallelism here is what turns a four-query round into forty
    /// simultaneous requests once the gap analyzer gets ambitious, which reads
    /// as rate limiting to the provider and as a hang to the person waiting.
    private func searchAll(_ queries: [String]) async -> [String: SearchOutcome] {
        guard !queries.isEmpty else { return [:] }
        return await withTaskGroup(
            of: (String, SearchOutcome).self
        ) { group -> [String: SearchOutcome] in
            var results: [String: SearchOutcome] = [:]
            var next = 0
            let ceiling = min(limits.maximumConcurrentSearches, queries.count)

            func addTask(_ query: String) {
                group.addTask {
                    do {
                        return (query, .hits(try await searcher.search(query: query)))
                    } catch {
                        return (query, .failure(NativeFailureMessage.presentable(error)))
                    }
                }
            }

            while next < ceiling {
                addTask(queries[next])
                next += 1
            }
            while let (query, outcome) = await group.next() {
                results[query] = outcome
                if next < queries.count {
                    addTask(queries[next])
                    next += 1
                }
            }
            return results
        }
    }

    private func readAll(_ hits: [ResearchSearchHit]) async -> [String: ReadOutcome] {
        guard !hits.isEmpty else { return [:] }
        return await withTaskGroup(
            of: (String, ReadOutcome).self
        ) { group -> [String: ReadOutcome] in
            var results: [String: ReadOutcome] = [:]
            var next = 0
            let ceiling = min(limits.maximumConcurrentReads, hits.count)

            func addTask(_ hit: ResearchSearchHit) {
                group.addTask {
                    do {
                        return (hit.url.absoluteString, .page(try await reader.read(hit)))
                    } catch {
                        return (
                            hit.url.absoluteString,
                            .failure(NativeFailureMessage.presentable(error))
                        )
                    }
                }
            }

            while next < ceiling {
                addTask(hits[next])
                next += 1
            }
            while let (url, outcome) = await group.next() {
                results[url] = outcome
                if next < hits.count {
                    addTask(hits[next])
                    next += 1
                }
            }
            return results
        }
    }
}

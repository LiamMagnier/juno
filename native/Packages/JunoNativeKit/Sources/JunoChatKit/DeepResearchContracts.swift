import Foundation
import JunoSearch

// MARK: - What the loop works with

public struct ResearchSearchHit: Equatable, Sendable {
    public let title: String
    public let url: URL
    public let snippet: String

    public init(title: String, url: URL, snippet: String) {
        self.title = title
        self.url = url
        self.snippet = snippet
    }
}

public struct ResearchPage: Equatable, Sendable {
    public let url: URL
    public let title: String
    /// The readable text of the page or document. Empty is a legitimate value —
    /// a page that fetched but yielded nothing — and the machine treats it as
    /// "read nothing" rather than as a source.
    public let text: String

    public init(url: URL, title: String, text: String) {
        self.url = url
        self.title = title
        self.text = text
    }
}

/// One page the loop read, tied to the citation number it was given.
///
/// The citation number is assigned at read time, not at synthesis time. That
/// ordering is the guarantee: by the time the synthesizer sees a note, `[n]` is
/// already backed by a page that was actually fetched, so there is no window in
/// which a number exists without a source behind it.
public struct ResearchNote: Equatable, Sendable {
    public let citation: Int
    public let title: String
    public let url: URL
    public let excerpt: String

    public init(citation: Int, title: String, url: URL, excerpt: String) {
        self.citation = citation
        self.title = title
        self.url = url
        self.excerpt = excerpt
    }
}

// MARK: - Injected capabilities

/// Turns a question into the queries that would answer it.
public protocol ResearchQueryPlanning: Sendable {
    func decompose(question: String, maximumQueries: Int) async throws -> [String]
}

/// Runs one query. Implementations may hit the network, a local index, or both.
public protocol ResearchSearching: Sendable {
    func search(query: String) async throws -> [ResearchSearchHit]
}

/// Fetches and extracts the readable content behind a hit.
public protocol ResearchPageReading: Sendable {
    func read(_ hit: ResearchSearchHit) async throws -> ResearchPage
}

/// Decides what the corpus still does not answer.
public protocol ResearchGapAnalyzing: Sendable {
    func followUpQueries(
        question: String,
        notes: [ResearchNote],
        round: Int,
        maximumQueries: Int
    ) async throws -> [String]
}

/// Writes the report. Must cite only the notes it was given; anything else it
/// writes is removed by `CitationRegistry.sanitized(_:)` before the report is
/// published, so a hallucinated marker cannot reach a reader.
public protocol ResearchSynthesizing: Sendable {
    func synthesize(question: String, notes: [ResearchNote]) async throws -> String
}

// MARK: - Budgets

public struct DeepResearchLimits: Equatable, Sendable {
    /// How many search→read→gap cycles may run. The loop stops here even if the
    /// gap analyzer keeps finding gaps — it always will, because "what is still
    /// missing" has no fixed point.
    public var maximumRounds: Int
    public var queriesPerRound: Int
    public var hitsPerQuery: Int
    /// Total pages across all rounds. A per-round cap alone lets a three-round
    /// run read three times what a one-round run does, which is how a "quick"
    /// research turn quietly becomes a two-minute one.
    public var maximumPages: Int
    public var maximumConcurrentSearches: Int
    public var maximumConcurrentReads: Int
    /// How much of each page reaches the synthesizer.
    public var excerptCharacters: Int

    public init(
        maximumRounds: Int = 3,
        queriesPerRound: Int = 4,
        hitsPerQuery: Int = 5,
        maximumPages: Int = 12,
        maximumConcurrentSearches: Int = 4,
        maximumConcurrentReads: Int = 4,
        excerptCharacters: Int = 2000
    ) {
        self.maximumRounds = max(1, maximumRounds)
        self.queriesPerRound = max(1, queriesPerRound)
        self.hitsPerQuery = max(1, hitsPerQuery)
        self.maximumPages = max(1, maximumPages)
        self.maximumConcurrentSearches = max(1, maximumConcurrentSearches)
        self.maximumConcurrentReads = max(1, maximumConcurrentReads)
        self.excerptCharacters = max(200, excerptCharacters)
    }

    public static let `default` = DeepResearchLimits()
}

// MARK: - Observable outcome

public enum DeepResearchPhase: String, Equatable, Sendable {
    case planning
    case searching
    case reading
    case gapAnalysis
    case synthesizing
    case completed
    case stopped
}

public enum DeepResearchStopReason: Equatable, Sendable {
    case completed
    /// Planning produced nothing usable and the question itself was not a
    /// usable query either.
    case noQueriesPlanned
    /// Every query ran and nothing was read. The loop deliberately does **not**
    /// synthesize here: a report with no sources is a model's unsupported guess
    /// wearing the presentation of research.
    case noSourcesFound
    case cancelled
    case failed(String)
}

public struct DeepResearchReport: Equatable, Sendable {
    public let question: String
    /// Sanitized and linked. Every `[n]` in here maps to `citations`.
    public let markdown: String
    /// The sources behind the report, numbered exactly as the markdown numbers
    /// them. Never renumbered after the fact.
    public let citations: [Citation]
    /// How many search→read→gap rounds ran, or nil when the run was not driven
    /// by this client and the number therefore cannot be observed.
    ///
    /// Optional rather than zero. A server-run report did not run zero rounds;
    /// this client simply cannot see how many it ran, and a `0` on screen states
    /// the opposite of that.
    public let roundsRun: Int?
    public let pagesRead: Int

    public init(
        question: String,
        markdown: String,
        citations: [Citation],
        roundsRun: Int?,
        pagesRead: Int
    ) {
        self.question = question
        self.markdown = markdown
        self.citations = citations
        self.roundsRun = roundsRun
        self.pagesRead = pagesRead
    }
}

/// Everything the loop reports while it works.
///
/// These exist because deep research runs for tens of seconds with nothing to
/// show: without a live account of which query is running and which pages have
/// been read, the surface is a spinner and the person cannot tell a working run
/// from a stuck one.
public enum DeepResearchProgress: Equatable, Sendable {
    case phase(DeepResearchPhase)
    case plannedQueries([String], round: Int)
    case searchStarted(query: String, round: Int)
    case searchFinished(query: String, hitCount: Int)
    /// One query failing is not the run failing — the other queries still ran.
    case searchFailed(query: String, reason: String)
    case pageRead(title: String, url: URL, citation: Int, pagesRead: Int)
    case pageFailed(url: URL, reason: String)
    case citationsAccumulated(Int)
    case gapsIdentified([String], round: Int)
    case report(DeepResearchReport)
    case stopped(DeepResearchStopReason)
}

import Foundation
import JunoSearch

/// One source the server reported reading.
public struct ServerResearchRead: Equatable, Sendable {
    public let title: String
    public let url: URL

    public init(title: String, url: URL) {
        self.title = title
        self.url = url
    }
}

extension DeepResearchPhase {
    /// The one word a surface puts on this phase.
    ///
    /// Here rather than in each client so the Mac and the phone cannot describe
    /// the same run differently — the projection exists to give both platforms
    /// one reading of the server's events, and two hand-written switch
    /// statements over the result would put the disagreement back one layer up.
    ///
    /// "Writing" rather than "Synthesizing" and "Checking gaps" rather than
    /// "Gap analysis": these are read by someone waiting, not by someone
    /// debugging the pipeline.
    public var displayName: String {
        switch self {
        case .planning: "Planning"
        case .searching: "Searching"
        case .reading: "Reading"
        case .gapAnalysis: "Checking gaps"
        case .synthesizing: "Writing"
        case .completed: "Done"
        case .stopped: "Stopped"
        }
    }
}

/// A server-run research turn, described in the same vocabulary as a local run.
public struct ServerResearchProgress: Equatable, Sendable {
    public let phase: DeepResearchPhase
    /// The query the run last actually searched for, or nil when it never
    /// reported one.
    ///
    /// Nil is the honest answer on the provider-tool search paths, where sources
    /// arrive from grounding metadata and the query the model typed never
    /// reaches us. A surface omits the label rather than inventing one.
    public let currentQuery: String?
    public let queriesRun: [String]
    public let pagesRead: [ServerResearchRead]
    /// Distinct sources read so far — the count a "12 sources" label should
    /// show. Note this is the *read* count; the final citation count comes from
    /// the `sources` chunk on the completed message.
    public let citationCount: Int
    /// Server warnings, most importantly the one emitted when research degrades
    /// to a plain chat turn. Surfacing this is not optional: without it the
    /// answer silently is not researched.
    public let warnings: [String]

    public init(
        phase: DeepResearchPhase,
        currentQuery: String?,
        queriesRun: [String],
        pagesRead: [ServerResearchRead],
        citationCount: Int,
        warnings: [String]
    ) {
        self.phase = phase
        self.currentQuery = currentQuery
        self.queriesRun = queriesRun
        self.pagesRead = pagesRead
        self.citationCount = citationCount
        self.warnings = warnings
    }

    /// The counts a waiting reader actually wants, in one line — or **nil when
    /// there is nothing yet to count**, so a surface omits the line rather than
    /// printing "0 searches · 0 sources" over a run that has only just started.
    /// Absent is not zero.
    ///
    /// "Sources" is the *read* count and is deliberately not called citations. A
    /// citation number is earned by a source that backs a marker in the finished
    /// report; printing this count under that word would promise a `[n]` for
    /// every page the server merely opened.
    ///
    /// Shared rather than formatted per platform for the same reason
    /// ``DeepResearchPhase/displayName`` is: two clients describing one run.
    public var countsSummary: String? {
        var parts: [String] = []
        if !queriesRun.isEmpty {
            parts.append("\(queriesRun.count) \(queriesRun.count == 1 ? "search" : "searches")")
        }
        if citationCount > 0 {
            parts.append("\(citationCount) \(citationCount == 1 ? "source" : "sources")")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

/// Reads the server's research turn through the same lens as a local one.
///
/// **Why this exists instead of a second research engine.** Deep research
/// already runs server-side: native sets `deepResearch: true` on the chat
/// request and the server streams `activity` events through the ordinary chat
/// stream, which `NativeChatAPIClient` decodes into `NativeChatActivity`.
/// Re-implementing that pipeline on the client would produce two engines with
/// different corpora, different budgets, and different answers to the same
/// question.
///
/// So this type is a *projection*, not an engine. It maps the events the server
/// already sends onto `DeepResearchPhase` and `CitationRegistry` — the same
/// types `DeepResearchCoordinator` produces for a local, offline run over
/// on-device documents — so one set of views renders both, and the citation
/// rules (a `[n]` marker only where a real source backs it) are enforced
/// identically on both paths.
///
/// The extraction of the query and the visited sites is delegated to
/// `NativeSearchActivity` rather than repeated here, because the website derives
/// the same two things from the same two events and the clients must not
/// disagree about what a run searched for.
public enum DeepResearchActivityProjection {
    /// The title the server uses for a real per-query search. "Preparing web
    /// search" is an intent, not a search, and counting it would inflate the
    /// number of queries a run reports.
    private static let searchingTitle = "Searching the web"

    public static func progress(from activity: [NativeChatActivity]) -> ServerResearchProgress {
        var queries: [String] = []
        var seenQueries = Set<String>()
        var warnings: [String] = []

        for item in activity {
            if item.kind == .search, item.title == searchingTitle,
                let detail = item.detail?.trimmingCharacters(in: .whitespacesAndNewlines),
                !detail.isEmpty, seenQueries.insert(detail).inserted {
                queries.append(detail)
            }
            if item.kind == .warning {
                let text = [item.title, item.detail ?? ""]
                    .filter { !$0.isEmpty }
                    .joined(separator: " — ")
                if !text.isEmpty { warnings.append(text) }
            }
        }

        let sites = NativeSearchActivity.sites(in: activity)
        let reads = sites.map { ServerResearchRead(title: $0.title, url: $0.url) }

        return ServerResearchProgress(
            phase: phase(from: activity),
            currentQuery: NativeSearchActivity.query(in: activity),
            queriesRun: queries,
            pagesRead: reads,
            citationCount: reads.count,
            warnings: warnings
        )
    }

    /// The phase the run is in, read only from events the server actually sent.
    ///
    /// Deliberately never guesses forward. A run that has searched but not yet
    /// visited anything is `.searching`, not `.reading`, even though reading is
    /// what comes next — a phase label that runs ahead of the work is how a
    /// stuck run looks healthy.
    public static func phase(from activity: [NativeChatActivity]) -> DeepResearchPhase {
        guard !activity.isEmpty else { return .planning }
        if activity.contains(where: { $0.kind == .done }) { return .completed }
        if activity.contains(where: { $0.kind == .write }) { return .synthesizing }
        if activity.contains(where: { $0.kind == .visit }) { return .reading }
        if activity.contains(where: { $0.kind == .search }) { return .searching }
        return .planning
    }

    /// Builds a citation registry from the sources the server attached to the
    /// completed message.
    ///
    /// The numbering is the position in this list, which is the numbering the
    /// server's own report uses. Registering them here — rather than trusting
    /// the markers in the text — is what makes
    /// `CitationRegistry.sanitized(_:)` able to strip a `[7]` from a report with
    /// six sources.
    public static func citations(from sources: [NativeChatSource]) -> CitationRegistry {
        var registry = CitationRegistry()
        for source in sources {
            registry.register(
                title: source.title,
                url: source.url,
                locator: source.url.host ?? source.url.absoluteString,
                snippet: source.snippet
            )
        }
        return registry
    }

    /// A server-produced report, put through the same citation rules as a local
    /// one: unmapped markers removed, mapped markers linked.
    public static func report(
        question: String,
        markdown: String,
        sources: [NativeChatSource],
        activity: [NativeChatActivity]
    ) -> DeepResearchReport {
        let registry = citations(from: sources)
        let projected = progress(from: activity)
        return DeepResearchReport(
            question: question,
            markdown: registry.rendered(markdown),
            citations: registry.citations,
            // Absent, not zero. The server does not report a round count, and
            // deriving one from the number of searches would state a fact about
            // its pipeline that this client cannot observe.
            roundsRun: nil,
            pagesRead: projected.pagesRead.count
        )
    }
}

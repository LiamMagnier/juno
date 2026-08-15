import Foundation
import JunoSearch
import XCTest

@testable import JunoChatKit

/// The coordinator's own contract is narrow: run what the machine asks for, feed
/// the results back in a deterministic order, and never let one failing step
/// take the run down with it. Every capability here is a stub — the loop has no
/// live network in tests, by construction.
final class DeepResearchCoordinatorTests: XCTestCase {
    func testAFullRunStreamsProgressAndProducesACitedReport() async throws {
        let coordinator = DeepResearchCoordinator(
            planner: StubPlanner(queries: ["refund window", "refund method"]),
            searcher: StubSearcher(results: [
                "refund window": [hit(1)],
                "refund method": [hit(2)],
            ]),
            reader: StubReader(),
            analyzer: StubAnalyzer(queries: [:]),
            synthesizer: StubSynthesizer(template: "Refunds take 14 days [1], by card [2]."),
            limits: DeepResearchLimits(maximumRounds: 1, queriesPerRound: 2, maximumPages: 4)
        )

        var progress: [DeepResearchProgress] = []
        for await item in coordinator.stream(question: "how do refunds work") {
            progress.append(item)
        }

        XCTAssertTrue(progress.contains(.searchStarted(query: "refund window", round: 1)))
        XCTAssertTrue(progress.contains(.searchFinished(query: "refund method", hitCount: 1)))
        XCTAssertTrue(progress.contains(.citationsAccumulated(2)))
        XCTAssertTrue(progress.contains(.stopped(.completed)))

        let report = progress.compactMap { item -> DeepResearchReport? in
            if case let .report(report) = item { return report }
            return nil
        }.last
        let unwrapped = try XCTUnwrap(report)
        XCTAssertEqual(unwrapped.citations.count, 2)
        XCTAssertEqual(unwrapped.pagesRead, 2)
        XCTAssertTrue(unwrapped.markdown.contains("[[1](https://example.com/page-1)]"))
    }

    /// The reason results are collected by key and replayed in command order:
    /// numbering that depends on which fetch happened to finish first is
    /// untestable and unreproducible in a bug report.
    func testCitationNumberingDoesNotDependOnWhichFetchFinishesFirst() async throws {
        // The second page is deliberately much faster than the first.
        let reader = StubReader(delays: [
            "https://example.com/page-1": .milliseconds(60),
            "https://example.com/page-2": .milliseconds(1),
        ])
        let coordinator = DeepResearchCoordinator(
            planner: StubPlanner(queries: ["one"]),
            searcher: StubSearcher(results: ["one": [hit(1), hit(2)]]),
            reader: reader,
            analyzer: StubAnalyzer(queries: [:]),
            synthesizer: StubSynthesizer(template: "Answer [1][2]."),
            limits: DeepResearchLimits(maximumRounds: 1, queriesPerRound: 1)
        )

        let (report, _) = await coordinator.run(question: "q")

        let unwrapped = try XCTUnwrap(report)
        XCTAssertEqual(
            unwrapped.citations.map(\.url?.absoluteString),
            ["https://example.com/page-1", "https://example.com/page-2"]
        )
    }

    /// One query failing is not the run failing — the other queries still ran,
    /// and their pages are still worth writing up.
    func testAFailingQueryDoesNotTakeTheRunDown() async {
        let coordinator = DeepResearchCoordinator(
            planner: StubPlanner(queries: ["good", "bad"]),
            searcher: StubSearcher(
                results: ["good": [hit(1)]],
                failures: ["bad"]
            ),
            reader: StubReader(),
            analyzer: StubAnalyzer(queries: [:]),
            synthesizer: StubSynthesizer(template: "Partial answer [1]."),
            limits: DeepResearchLimits(maximumRounds: 1, queriesPerRound: 2)
        )

        var sawFailure = false
        var report: DeepResearchReport?
        for await item in coordinator.stream(question: "q") {
            if case .searchFailed(query: "bad", _) = item { sawFailure = true }
            if case let .report(value) = item { report = value }
        }

        XCTAssertTrue(sawFailure)
        XCTAssertEqual(report?.citations.count, 1)
    }

    /// Planning is the one step with no partial result to fall back on.
    func testAFailedPlanEndsTheRunRatherThanSearchingBlind() async {
        let coordinator = DeepResearchCoordinator(
            planner: FailingPlanner(),
            searcher: StubSearcher(results: [:]),
            reader: StubReader(),
            analyzer: StubAnalyzer(queries: [:]),
            synthesizer: StubSynthesizer(template: ""),
            limits: .default
        )

        let (report, stopReason) = await coordinator.run(question: "q")

        XCTAssertNil(report)
        guard case .failed = stopReason else {
            return XCTFail("expected a failure stop reason, got \(stopReason)")
        }
    }

    /// A failed gap analysis is not a failed run: what has been read so far is
    /// still worth writing up.
    func testAFailedGapAnalysisStillProducesTheReport() async {
        let coordinator = DeepResearchCoordinator(
            planner: StubPlanner(queries: ["one"]),
            searcher: StubSearcher(results: ["one": [hit(1)]]),
            reader: StubReader(),
            analyzer: FailingAnalyzer(),
            synthesizer: StubSynthesizer(template: "Answer [1]."),
            limits: DeepResearchLimits(maximumRounds: 3, queriesPerRound: 1, maximumPages: 9)
        )

        let (report, stopReason) = await coordinator.run(question: "q")

        XCTAssertEqual(stopReason, .completed)
        XCTAssertEqual(report?.citations.count, 1)
    }

    /// Unbounded parallelism turns an ambitious round into forty simultaneous
    /// requests, which reads as rate limiting to the provider and as a hang to
    /// the person waiting.
    func testConcurrentSearchesAreCapped() async {
        let meter = ConcurrencyMeter()
        let queries = (1 ... 8).map { "query \($0)" }
        let coordinator = DeepResearchCoordinator(
            planner: StubPlanner(queries: queries),
            searcher: MeteredSearcher(meter: meter),
            reader: StubReader(),
            analyzer: StubAnalyzer(queries: [:]),
            synthesizer: StubSynthesizer(template: "Answer."),
            limits: DeepResearchLimits(
                maximumRounds: 1,
                queriesPerRound: 8,
                maximumConcurrentSearches: 3
            )
        )

        _ = await coordinator.run(question: "q")

        let peak = await meter.peak
        let total = await meter.total
        XCTAssertEqual(total, 8, "every query must still run")
        XCTAssertLessThanOrEqual(peak, 3)
        XCTAssertGreaterThan(peak, 1, "the fan-out must actually be concurrent")
    }

    // MARK: - Helpers

    private func hit(_ index: Int) -> ResearchSearchHit {
        ResearchSearchHit(
            title: "Result \(index)",
            url: URL(string: "https://example.com/page-\(index)")!,
            snippet: "Snippet \(index)"
        )
    }
}

// MARK: - Stubs

private struct StubPlanner: ResearchQueryPlanning {
    let queries: [String]
    func decompose(question _: String, maximumQueries _: Int) async throws -> [String] {
        queries
    }
}

private struct FailingPlanner: ResearchQueryPlanning {
    struct Failure: Error {}
    func decompose(question _: String, maximumQueries _: Int) async throws -> [String] {
        throw Failure()
    }
}

private struct StubSearcher: ResearchSearching {
    struct Failure: Error {}
    let results: [String: [ResearchSearchHit]]
    var failures: Set<String> = []

    func search(query: String) async throws -> [ResearchSearchHit] {
        if failures.contains(query) { throw Failure() }
        return results[query] ?? []
    }
}

private struct StubReader: ResearchPageReading {
    var delays: [String: Duration] = [:]

    func read(_ hit: ResearchSearchHit) async throws -> ResearchPage {
        if let delay = delays[hit.url.absoluteString] {
            try? await Task.sleep(for: delay)
        }
        return ResearchPage(
            url: hit.url,
            title: hit.title,
            text: "Readable body for \(hit.title) with enough content to count as a source."
        )
    }
}

private struct StubAnalyzer: ResearchGapAnalyzing {
    /// Keyed by round, so a test can say "round 1 finds a gap, round 2 does not".
    let queries: [Int: [String]]

    func followUpQueries(
        question _: String,
        notes _: [ResearchNote],
        round: Int,
        maximumQueries _: Int
    ) async throws -> [String] {
        queries[round] ?? []
    }
}

private struct FailingAnalyzer: ResearchGapAnalyzing {
    struct Failure: Error {}
    func followUpQueries(
        question _: String,
        notes _: [ResearchNote],
        round _: Int,
        maximumQueries _: Int
    ) async throws -> [String] {
        throw Failure()
    }
}

private struct StubSynthesizer: ResearchSynthesizing {
    let template: String
    func synthesize(question _: String, notes _: [ResearchNote]) async throws -> String {
        template
    }
}

private actor ConcurrencyMeter {
    private(set) var peak = 0
    private(set) var total = 0
    private var inFlight = 0

    func enter() {
        inFlight += 1
        total += 1
        peak = max(peak, inFlight)
    }

    func leave() { inFlight -= 1 }
}

private struct MeteredSearcher: ResearchSearching {
    let meter: ConcurrencyMeter

    func search(query _: String) async throws -> [ResearchSearchHit] {
        await meter.enter()
        try? await Task.sleep(for: .milliseconds(20))
        await meter.leave()
        return []
    }
}

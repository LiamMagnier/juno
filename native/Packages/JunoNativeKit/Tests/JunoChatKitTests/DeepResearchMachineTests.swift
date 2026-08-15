import Foundation
import JunoSearch
import XCTest

@testable import JunoChatKit

/// The research loop's bugs are ordering bugs — a round that never ends, a query
/// that runs twice, a page counted after the budget closed, a citation number
/// handed out for a fetch that failed. All of them are testable here precisely
/// because the machine is pure.
final class DeepResearchMachineTests: XCTestCase {
    private let limits = DeepResearchLimits(
        maximumRounds: 2,
        queriesPerRound: 2,
        hitsPerQuery: 2,
        maximumPages: 4
    )

    // MARK: - Progression

    func testTheLoopWalksPlanSearchReadGapSearchReadSynthesize() {
        var driver = Driver(question: "refund policy", limits: limits)

        driver.apply(.decomposed(["refund window", "refund method"]))
        driver.apply(.searchCompleted(query: "refund window", hits: [hit(1)]))
        driver.apply(.searchCompleted(query: "refund method", hits: [hit(2)]))
        driver.apply(.pageRead(page(1)))
        driver.apply(.pageRead(page(2)))
        driver.apply(.gapsIdentified(["refund exceptions"]))
        driver.apply(.searchCompleted(query: "refund exceptions", hits: [hit(3)]))
        driver.apply(.pageRead(page(3)))
        driver.apply(.synthesized("Refunds take 14 days [1][2][3]."))

        XCTAssertEqual(
            driver.phases,
            [
                .planning, .searching, .reading, .gapAnalysis,
                .searching, .reading, .synthesizing, .completed,
            ]
        )
        XCTAssertEqual(driver.machine.nextCommand(), .stop(.completed))
    }

    /// Reading only ends when the last outstanding page has reported, not when
    /// the first one does. Advancing early strands in-flight fetches whose
    /// results then arrive into a closed round.
    func testTheRoundEndsOnlyAfterEveryPageReports() {
        var driver = Driver(question: "q", limits: limits)
        driver.apply(.decomposed(["one"]))
        driver.apply(.searchCompleted(query: "one", hits: [hit(1), hit(2)]))

        XCTAssertEqual(driver.machine.phase, .reading)
        driver.apply(.pageRead(page(1)))
        XCTAssertEqual(driver.machine.phase, .reading, "one page is still outstanding")
        driver.apply(.pageFailed(url: url(2), reason: "timed out"))
        XCTAssertEqual(driver.machine.phase, .gapAnalysis)
    }

    /// A late result from a closed round must not reopen it.
    func testAResultArrivingAfterItsRoundClosedIsIgnored() {
        var driver = Driver(question: "q", limits: limits)
        driver.apply(.decomposed(["one"]))
        driver.apply(.searchCompleted(query: "one", hits: [hit(1)]))
        driver.apply(.pageRead(page(1)))

        let phaseBefore = driver.machine.phase
        let progress = driver.machine.ingest(
            .searchCompleted(query: "one", hits: [hit(9)])
        )

        XCTAssertTrue(progress.isEmpty)
        XCTAssertEqual(driver.machine.phase, phaseBefore)
        XCTAssertEqual(driver.machine.pagesRead, 1)
    }

    // MARK: - Evidence

    /// The rule that makes this a research loop rather than a slow chat turn.
    /// Synthesizing with nothing read produces a confident, uncited essay in the
    /// visual language of a researched report.
    func testARunThatReadNothingStopsInsteadOfWritingAnUncitedReport() {
        var driver = Driver(
            question: "q",
            limits: DeepResearchLimits(maximumRounds: 1, queriesPerRound: 2)
        )
        driver.apply(.decomposed(["one"]))
        driver.apply(.searchCompleted(query: "one", hits: []))

        XCTAssertEqual(driver.machine.phase, .stopped)
        XCTAssertEqual(driver.machine.stopReason, .noSourcesFound)
        XCTAssertNil(driver.machine.report)
        XCTAssertTrue(driver.progress.contains(.stopped(.noSourcesFound)))
    }

    /// With rounds left, an empty first round earns another try rather than
    /// giving up — the corpus may simply have been behind a different query. It
    /// is only after the follow-up produces nothing that the run stops without a
    /// report.
    func testAnEmptyFirstRoundGetsAFollowUpBeforeGivingUp() {
        var driver = Driver(question: "q", limits: limits)
        driver.apply(.decomposed(["one"]))
        driver.apply(.searchCompleted(query: "one", hits: []))
        XCTAssertEqual(driver.machine.phase, .gapAnalysis)

        driver.apply(.gapsIdentified(["two"]))
        driver.apply(.searchCompleted(query: "two", hits: []))

        XCTAssertEqual(driver.machine.stopReason, .noSourcesFound)
        XCTAssertNil(driver.machine.report)
    }

    /// A page that fetched but yielded no text is not a source. Numbering it
    /// would let the report cite a blank page.
    func testAPageWithNoTextGetsNoCitationNumber() {
        var driver = Driver(question: "q", limits: limits)
        driver.apply(.decomposed(["one"]))
        driver.apply(.searchCompleted(query: "one", hits: [hit(1), hit(2)]))
        driver.apply(.pageRead(ResearchPage(url: url(1), title: "Empty", text: "   \n ")))
        driver.apply(.pageRead(page(2)))

        XCTAssertEqual(driver.machine.registry.count, 1)
        XCTAssertEqual(driver.machine.notes.map(\.citation), [1])
        XCTAssertEqual(driver.machine.notes.first?.url, url(2))
        XCTAssertTrue(
            driver.progress.contains {
                if case let .pageFailed(failed, _) = $0 { return failed == url(1) }
                return false
            }
        )
    }

    /// Citation numbers are assigned at read time, in the order pages report, so
    /// `[n]` is backed by a fetched page before the synthesizer ever sees it.
    func testCitationNumbersFollowTheOrderPagesWereRead() {
        var driver = Driver(question: "q", limits: limits)
        driver.apply(.decomposed(["one"]))
        driver.apply(.searchCompleted(query: "one", hits: [hit(1), hit(2)]))
        driver.apply(.pageRead(page(2)))
        driver.apply(.pageRead(page(1)))

        XCTAssertEqual(driver.machine.notes.map(\.citation), [1, 2])
        XCTAssertEqual(driver.machine.notes.map(\.url), [url(2), url(1)])
    }

    // MARK: - Budgets

    /// A per-round cap alone lets a three-round run read three times what a
    /// one-round run does, which is how a quick research turn becomes a
    /// two-minute one.
    func testThePageBudgetIsGlobalAndTrimsBeforeAnyFetchStarts() {
        var driver = Driver(
            question: "q",
            limits: DeepResearchLimits(
                maximumRounds: 3,
                queriesPerRound: 2,
                hitsPerQuery: 5,
                maximumPages: 2
            )
        )
        driver.apply(.decomposed(["one"]))
        driver.apply(
            .searchCompleted(query: "one", hits: [hit(1), hit(2), hit(3), hit(4)])
        )

        guard case let .read(hits) = driver.machine.nextCommand() else {
            return XCTFail("expected a read command")
        }
        XCTAssertEqual(hits.count, 2, "the budget is enforced before fetching, not after")
    }

    /// Both ceilings close the loop; the gap analyzer will always find another
    /// gap, because "what is still missing" has no fixed point.
    func testTheRoundCeilingEndsTheLoopEvenWithGapsRemaining() {
        var driver = Driver(
            question: "q",
            limits: DeepResearchLimits(maximumRounds: 1, queriesPerRound: 2, maximumPages: 9)
        )
        driver.apply(.decomposed(["one"]))
        driver.apply(.searchCompleted(query: "one", hits: [hit(1)]))
        driver.apply(.pageRead(page(1)))

        XCTAssertEqual(driver.machine.phase, .synthesizing)
        XCTAssertEqual(driver.machine.round, 1)
    }

    func testOnlyAsManyHitsPerQueryAsTheBudgetAllowsAreQueued() {
        var driver = Driver(
            question: "q",
            limits: DeepResearchLimits(queriesPerRound: 2, hitsPerQuery: 2, maximumPages: 20)
        )
        driver.apply(.decomposed(["one"]))
        driver.apply(.searchCompleted(query: "one", hits: (1 ... 6).map(hit)))

        XCTAssertEqual(driver.machine.pendingHits.count, 2)
    }

    // MARK: - Query hygiene

    /// A gap analyzer handed the same corpus twice proposes the same query
    /// twice, and re-running it burns a round to arrive at the same corpus.
    func testAQueryIsNeverRunTwiceAcrossRounds() {
        var driver = Driver(question: "q", limits: limits)
        driver.apply(.decomposed(["Refund Window", "refund method"]))
        driver.apply(.searchCompleted(query: "Refund Window", hits: [hit(1)]))
        driver.apply(.searchCompleted(query: "refund method", hits: [hit(2)]))
        driver.apply(.pageRead(page(1)))
        driver.apply(.pageRead(page(2)))

        // Same queries back, differing only in case and punctuation.
        driver.apply(.gapsIdentified(["refund window!", "REFUND METHOD"]))

        XCTAssertEqual(driver.machine.phase, .synthesizing)
        XCTAssertEqual(driver.machine.executedQueries.count, 2)
    }

    /// Two queries in one round returning the same URL must fetch it once: twice
    /// spends the budget twice and registers two citations for one page.
    func testAURLFoundByTwoQueriesIsFetchedOnce() {
        var driver = Driver(question: "q", limits: limits)
        driver.apply(.decomposed(["one", "two"]))
        driver.apply(.searchCompleted(query: "one", hits: [hit(1)]))
        driver.apply(
            .searchCompleted(
                query: "two",
                hits: [
                    ResearchSearchHit(
                        title: "Same page",
                        url: URL(string: "https://example.com/page-1#section")!,
                        snippet: ""
                    ),
                ]
            )
        )

        XCTAssertEqual(driver.machine.pendingHits.count, 1)
    }

    /// The question itself is a legitimate query — not a guess about intent, but
    /// the literal thing the person asked.
    func testPlanningFallsBackToTheQuestionWhenDecompositionYieldsNothing() {
        var driver = Driver(question: "how do refunds work", limits: limits)
        driver.apply(.decomposed(["", "   "]))

        XCTAssertEqual(driver.machine.phase, .searching)
        XCTAssertEqual(driver.machine.pendingQueries, ["how do refunds work"])
    }

    func testAnEmptyQuestionWithNoQueriesStopsRatherThanSearchingForNothing() {
        var driver = Driver(question: "   ", limits: limits)
        driver.apply(.decomposed([]))

        XCTAssertEqual(driver.machine.stopReason, .noQueriesPlanned)
        XCTAssertNil(driver.machine.report)
    }

    // MARK: - Report

    /// The end of the chain the whole design exists for: a marker the writer
    /// invented never reaches the reader, and a real one becomes a link.
    func testTheReportStripsInventedMarkersAndLinksRealOnes() throws {
        var driver = Driver(
            question: "q",
            limits: DeepResearchLimits(maximumRounds: 1, queriesPerRound: 2)
        )
        driver.apply(.decomposed(["one"]))
        driver.apply(.searchCompleted(query: "one", hits: [hit(1)]))
        driver.apply(.pageRead(page(1)))
        driver.apply(.synthesized("Backed by evidence [1], and invented [7]."))

        let report = try XCTUnwrap(driver.machine.report)
        XCTAssertEqual(
            report.markdown,
            "Backed by evidence [[1](https://example.com/page-1)], and invented ."
        )
        XCTAssertEqual(report.citations.count, 1)
        XCTAssertEqual(report.pagesRead, 1)
        XCTAssertEqual(report.roundsRun, 1)
    }

    func testCancellationStopsTheRunWithoutAReport() {
        var driver = Driver(question: "q", limits: limits)
        driver.apply(.decomposed(["one"]))
        driver.apply(.cancelled)

        XCTAssertEqual(driver.machine.stopReason, .cancelled)
        XCTAssertNil(driver.machine.report)
        // And a finished machine ignores everything after it.
        XCTAssertTrue(driver.machine.ingest(.searchCompleted(query: "one", hits: [])).isEmpty)
    }

    // MARK: - Helpers

    private struct Driver {
        var machine: DeepResearchMachine
        var progress: [DeepResearchProgress] = []
        var phases: [DeepResearchPhase]

        init(question: String, limits: DeepResearchLimits) {
            machine = DeepResearchMachine(question: question, limits: limits)
            phases = [machine.phase]
        }

        mutating func apply(_ input: DeepResearchInput) {
            let emitted = machine.ingest(input)
            progress += emitted
            for item in emitted {
                if case let .phase(phase) = item { phases.append(phase) }
            }
        }
    }

    private func url(_ index: Int) -> URL {
        URL(string: "https://example.com/page-\(index)")!
    }

    private func hit(_ index: Int) -> ResearchSearchHit {
        ResearchSearchHit(title: "Result \(index)", url: url(index), snippet: "Snippet \(index)")
    }

    private func page(_ index: Int) -> ResearchPage {
        ResearchPage(
            url: url(index),
            title: "Page \(index)",
            text: "Body text for page \(index) with enough content to be a source."
        )
    }
}

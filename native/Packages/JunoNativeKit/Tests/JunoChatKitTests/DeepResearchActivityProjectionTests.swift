import Foundation
import JunoSearch
import XCTest

@testable import JunoChatKit

/// Deep research runs on the server; the client sends `deepResearch: true` and
/// renders the activity stream that comes back. These tests cover the
/// projection that describes that run in the same vocabulary as a local one —
/// including the part that matters most, which is that the server's report goes
/// through exactly the same citation rules.
final class DeepResearchActivityProjectionTests: XCTestCase {
    /// The phase must never run ahead of the events. A label that says "reading"
    /// before a single `visit` arrived makes a stuck run look healthy.
    func testThePhaseIsReadOnlyFromEventsThatActuallyArrived() {
        XCTAssertEqual(DeepResearchActivityProjection.phase(from: []), .planning)
        XCTAssertEqual(
            DeepResearchActivityProjection.phase(from: [activity(.context, "Planning")]),
            .planning
        )
        XCTAssertEqual(
            DeepResearchActivityProjection.phase(from: [
                activity(.context, "Planning"),
                activity(.search, "Searching the web", detail: "refunds"),
            ]),
            .searching
        )
        XCTAssertEqual(
            DeepResearchActivityProjection.phase(from: [
                activity(.search, "Searching the web", detail: "refunds"),
                activity(.visit, "Reading", url: "https://example.com"),
            ]),
            .reading
        )
        XCTAssertEqual(
            DeepResearchActivityProjection.phase(from: [
                activity(.visit, "Reading", url: "https://example.com"),
                activity(.write, "Writing"),
            ]),
            .synthesizing
        )
        XCTAssertEqual(
            DeepResearchActivityProjection.phase(from: [activity(.done, "Done")]),
            .completed
        )
    }

    /// "Preparing web search" is an intent, not a search. Counting it inflates
    /// the number of queries the run reports and carries no query to show.
    func testOnlyRealPerQuerySearchesCountAsQueries() {
        let progress = DeepResearchActivityProjection.progress(from: [
            activity(.search, "Preparing web search"),
            activity(.search, "Searching the web", detail: "refund window"),
            activity(.search, "Searching the web", detail: "refund method"),
            activity(.search, "Searching the web", detail: "refund window"),
        ])

        XCTAssertEqual(progress.queriesRun, ["refund window", "refund method"])
        XCTAssertEqual(progress.currentQuery, "refund window")
    }

    /// Nil is the honest answer on the provider-tool paths, where sources come
    /// from grounding metadata and the query the model typed never reaches us.
    func testARunWithNoReportedQueryHasNoQueryRatherThanAnInventedOne() {
        let progress = DeepResearchActivityProjection.progress(from: [
            activity(.visit, "Reading", url: "https://example.com/a"),
        ])

        XCTAssertNil(progress.currentQuery)
        XCTAssertTrue(progress.queriesRun.isEmpty)
        XCTAssertEqual(progress.pagesRead.count, 1)
    }

    /// The server emits this when research degrades to a plain chat turn.
    /// Without surfacing it the answer silently is not researched.
    func testDegradationWarningsAreSurfacedNotSwallowed() {
        let progress = DeepResearchActivityProjection.progress(from: [
            activity(.warning, "Research unavailable", detail: "Falling back to a plain answer"),
            activity(.write, "Writing"),
        ])

        XCTAssertEqual(
            progress.warnings,
            ["Research unavailable — Falling back to a plain answer"]
        )
    }

    /// The same guarantee as the local loop, on the server path: a marker the
    /// model invented is removed, and a real one becomes a link.
    func testTheServersReportIsHeldToTheSameCitationRules() {
        let sources = [
            NativeChatSource(
                title: "Refund policy",
                url: URL(string: "https://example.com/refunds")!,
                snippet: "Within 14 days."
            ),
            NativeChatSource(
                title: "Shipping",
                url: URL(string: "https://example.com/shipping")!,
                snippet: "Free above $50."
            ),
        ]

        let report = DeepResearchActivityProjection.report(
            question: "how do refunds work",
            markdown: "Refunds take 14 days [1], shipping is free [2], and [9] is invented.",
            sources: sources,
            activity: [
                activity(.search, "Searching the web", detail: "refunds"),
                activity(.visit, "Reading", url: "https://example.com/refunds"),
                activity(.visit, "Reading", url: "https://example.com/shipping"),
                activity(.done, "Done"),
            ]
        )

        XCTAssertEqual(
            report.markdown,
            "Refunds take 14 days [[1](https://example.com/refunds)], "
                + "shipping is free [[2](https://example.com/shipping)], and  is invented."
        )
        XCTAssertEqual(report.citations.count, 2)
        XCTAssertEqual(report.pagesRead, 2)
        // Absent, not zero: this client did not drive the rounds and cannot see
        // how many the server ran.
        XCTAssertNil(report.roundsRun)
    }

    private func activity(
        _ kind: NativeChatActivity.Kind,
        _ title: String,
        detail: String? = nil,
        url: String? = nil
    ) -> NativeChatActivity {
        NativeChatActivity(
            id: UUID().uuidString,
            kind: kind,
            title: title,
            detail: detail,
            url: url
        )
    }
}

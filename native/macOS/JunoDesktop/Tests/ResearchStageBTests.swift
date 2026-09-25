import Foundation
import JunoChatKit
import Testing

@testable import JunoDesktop

/// Research in chat, the rest of it (Phase 5 Stage B, B6): the recap's words,
/// the report window's document, and "Open at passage".
@MainActor
struct ResearchStageBTests {
    private let t0 = Date(timeIntervalSince1970: 1_790_000_000)

    private func run(report: String?, sources: Int = 3, read: Int = 2) -> NativeResearchRun {
        NativeResearchRun(
            id: "rr_1", goal: "Heat pumps for a 1930s semi", state: "completed", phase: .done,
            questions: [
                .init(id: "o1", question: "Warm in January?", status: "covered"),
                .init(id: "o2", question: "Cost after grants?", status: "partial"),
            ],
            createdAt: t0, finishedAt: t0.addingTimeInterval(11 * 60 + 38),
            sources: (0..<sources).map { index in
                .init(
                    id: "s\(index)", url: URL(string: "https://example.org/\(index)")!,
                    title: "Source \(index + 1)", read: index < read
                )
            },
            report: report
        )
    }

    // MARK: The recap

    @Test
    func theRecapSaysWhatItReadAndWhatItCost() {
        var finished = run(report: "Body")
        finished.costMicroUsd = 377_214
        #expect(ResearchRecapWords.provenance(finished) == "2 sources read · 3 found · 1/2 objectives answered")
        #expect(ResearchRecapWords.figures(finished) == "12 min · $0.38")
        let one = run(report: nil, sources: 1, read: 1)
        #expect(ResearchRecapWords.provenance(one).hasPrefix("1 source read · 1 found"))
        #expect(ResearchRecapWords.verdict("completed") == "Research complete")
        #expect(ResearchRecapWords.verdict("cancelled") == "Cancelled")
        #expect(ResearchRecapWords.verdict("failed") == "Stopped after an error")
        #expect(ResearchRecapWords.money(microUsd: 4_000) == "<$0.01")
        #expect(ResearchRecapWords.money(microUsd: 0) == "$0.00")
        #expect(ResearchRecapWords.duration(from: t0, to: t0.addingTimeInterval(0.4)) == "1s")
        #expect(ResearchRecapWords.duration(from: t0, to: t0.addingTimeInterval(2 * 3_600 + 5 * 60)) == "2h 5m")
    }

    // MARK: The report window

    @Test
    func theReportSplitsAtItsHeadingsOutsideCode() throws {
        let body = """
        Lead-in sentence.

        ## Bottom line

        Short answer [1].

        ```
        # not a heading
        ```

        ### Detail

        More.
        """
        let document = try #require(ResearchReportDocument(run: run(report: body)))
        #expect(document.sections.map(\.title) == ["", "Bottom line", "Detail"])
        #expect(document.headings.map(\.level) == [2, 3])
        #expect(document.sections[1].markdown.contains("# not a heading"))
        #expect(document.sources.count == 2, "numbered over the sources read")
    }

    @Test
    func theSubtitleFileNameAndExportFollowTheWeb() throws {
        let words = Array(repeating: "word", count: 441).joined(separator: " ")
        let report = #"<juno:artifact type="MARKDOWN" title="Heat pumps: a 1930s semi, costed">"# + words + "</juno:artifact>"
        let document = try #require(ResearchReportDocument(run: run(report: report)))
        #expect(document.title == "Heat pumps: a 1930s semi, costed")
        #expect(document.subtitle == "Research report · 441 words · ~3 min read · 2 sources read")
        #expect(document.fileName(on: t0) == "heat-pumps-a-1930s-semi-costed.md")
        let markdown = document.markdown(accessed: t0)
        #expect(markdown.contains("\n\n## Sources\n\n[1] Source 1 — https://example.org/0 (accessed 2026-09-21)"))
        #expect(!markdown.contains("Source 3"), "only the sources read are numbered")
    }

    @Test
    func aTitleWithNothingUsableFallsBackToTheDate() throws {
        var untitled = run(report: "Body")
        untitled.goal = "¿?"
        let document = try #require(ResearchReportDocument(run: untitled))
        #expect(document.fileName(on: t0) == "research-2026-09-21.md")
        #expect(ResearchReportDocument(run: run(report: nil)) == nil)
    }

    @Test
    func openAtPassageAddsATextFragmentOfTheFirstEightWords() throws {
        let url = try #require(ResearchCitationPopover.passageURL(
            URL(string: "https://example.org/guide#top")!,
            passage: "Rated output holds down to -15°C in most models, per the 2024 tests."
        ))
        #expect(url.absoluteString == "https://example.org/guide#:~:text=Rated%20output%20holds%20down%20to%20%2D15%C2%B0C%20in%20most")
        #expect(ResearchCitationPopover.passageURL(URL(string: "https://example.org")!, passage: "  ") == nil)
    }
}

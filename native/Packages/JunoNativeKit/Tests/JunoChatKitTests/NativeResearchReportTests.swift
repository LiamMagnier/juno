import Foundation
import Testing

@testable import JunoChatKit

/// The native Deep Research models: the report a reader opens, the field's
/// map, and the in-chat turn read as a run.
struct NativeResearchReportTests {
    private let start = Date(timeIntervalSince1970: 1_790_000_000)

    private func answer(_ report: String, prose: String = "Short answer [1].", sources: Int = 3) -> NativeChatMessage {
        NativeChatMessage(
            id: "a1", conversationID: "c1", clientID: nil, role: .assistant,
            content: prose + "\n\n<juno:artifact identifier=\"research-report\" type=\"MARKDOWN\" title=\"Research Report\">\n" + report + "\n</juno:artifact>",
            reasoning: nil, model: nil, createdAt: start, revision: 1,
            sources: (0..<sources).map {
                NativeChatSource(title: "Source \($0 + 1)", url: URL(string: "https://example.org/\($0)")!, snippet: "", cited: true)
            }
        )
    }

    @Test
    func anAnswerCarriesItsReport() throws {
        let report = try #require(NativeResearchReport(message: answer("# Heat pumps, costed\n\nLead [1].\n\n## Costs\n\nMore [2].\n\n### Grants\n\nYes [3]."), question: "Should I?"))
        #expect(report.title == "Heat pumps, costed", "a generic artifact title gives way to the report's own heading")
        #expect(report.sections.map(\.title) == ["", "Costs", "Grants"])
        #expect(report.sections[1].markdown == "More [2].", "the heading line is the section's title, not its body")
        #expect(report.headings.map(\.level) == [2, 3])
        #expect(report.lede == "Short answer [1].")
        #expect(report.question == "Should I?")
        #expect(report.citationCount == 3)
        #expect(report.id == "message:a1")
        #expect(report.metaLine.hasSuffix("· 1 min read · 3 sources"))
    }

    @Test
    func aStreamingReportIsNotYetOpenable() {
        var message = answer("## Partial")
        message.content = "Prose\n\n<juno:artifact identifier=\"research-report\" type=\"MARKDOWN\" title=\"T\">\n## Half"
        #expect(NativeResearchReport(message: message) == nil)
        #expect(NativeResearchReport(message: NativeChatMessage(
            id: "x", conversationID: "c", clientID: nil, role: .assistant, content: "No report.",
            reasoning: nil, model: nil, createdAt: start, revision: 1
        )) == nil)
    }

    @Test
    func theExportCarriesTheTitleAndNumberedSources() throws {
        let report = try #require(NativeResearchReport(message: answer("## Costs\n\nBody [1].")))
        let markdown = report.markdown(accessed: start)
        #expect(markdown.hasPrefix("# Research report\n\n"))
        #expect(markdown.contains("[2] Source 2 — https://example.org/1 (accessed 2026-09-21)"))
        #expect(report.fileName(on: start, extension: "pdf") == "research-report.pdf")
    }

    @Test
    func pdfBlocksNeverSplitAFenceOrATable() {
        let blocks = NativeResearchReport.blocks(of: "One.\n\n```\na\n\nb\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nTwo.")
        #expect(blocks.count == 4)
        #expect(blocks[1].contains("a\n\nb"))
    }

    @Test
    func aRunTheChatConfirmedIsNeverDrawnTwice() {
        var run = NativeResearchRun(id: "r", state: "investigating", phase: .searching)
        #expect(run.presentation == .row)
        run.confirmedBy = "auto"
        #expect(run.presentation == .none, "its answer row is the working view")
        run.confirmedBy = "user"
        #expect(run.presentation == .row)
    }

    @Test
    func citedNumbersReadEveryShape() {
        #expect(NativeResearchRun.citedNumbers(in: "a [1] b [2][3] c [1, 4] d [x] [2]") == [1, 2, 3, 4])
    }

    @Test
    func theFieldPlacesSourcesByHowFarTheyGot() {
        let inputs: [NativeResearchFieldModel.Input] = (0..<6).map { index in
            .init(
                id: "s\(index)", url: URL(string: "https://site\(index).org/page")!, title: "S\(index)",
                read: index < 4, citedIndex: index < 2 ? index + 1 : nil
            )
        }
        let field = NativeResearchFieldModel(sources: inputs, currentHost: "www.site3.org")
        #expect(field.nodes.map(\.id) == ["s0", "s1", "s2", "s3", "s4", "s5"], "discovery order, whatever the orbit")
        #expect(field.nodes.filter { $0.ring == 0 }.map(\.cited) == [1, 2])
        #expect(field.nodes.filter { $0.ring == 2 }.count == 2)
        #expect(field.current?.id == "s3")
        // A poll that promotes one source moves only that source.
        var promoted = inputs
        promoted[4] = .init(id: "s4", url: inputs[4].url, title: "S4", read: true)
        let next = NativeResearchFieldModel(sources: promoted, currentHost: "site3.org")
        #expect(next.nodes.first { $0.id == "s0" }?.degrees == field.nodes.first { $0.id == "s0" }?.degrees)
        #expect(next.nodes.first { $0.id == "s4" }?.ring == 1)
    }

    @Test
    func theInChatTurnKeepsTitlesQuestionsAndPhases() {
        let rows: [NativeChatActivity] = [
            .init(id: "p", kind: .reasoning, title: "Planned the research: 2 questions to answer", detail: "Compare the sources.", url: nil),
            .init(id: "w1", kind: .reasoning, title: "Sending a researcher", detail: "What does it cost?", url: nil),
            .init(id: "w2", kind: .reasoning, title: "Sending a researcher", detail: "Will it be warm?", url: nil),
            .init(id: "v", kind: .visit, title: "Reading source", detail: "Boiler Upgrade Scheme", url: "https://www.gov.uk/apply-boiler-upgrade-scheme"),
            .init(id: "r", kind: .reasoning, title: "Lead review: the evidence is ready", detail: nil, url: nil),
        ]
        let message = NativeChatMessage(
            id: "m", conversationID: "c", clientID: nil, role: .assistant, content: "", reasoning: nil, model: nil,
            createdAt: start, revision: 0, isPending: true, activity: rows, runStartedAt: start
        )
        let run = NativeResearchRun.inChat(message: message, live: true, question: "Heat pump?", now: start.addingTimeInterval(60))
        #expect(run.phase == .reviewing)
        #expect(run.goal == "Heat pump?")
        #expect(run.approach == "Compare the sources.")
        #expect(run.questions.map(\.question) == ["What does it cost?", "Will it be warm?"])
        #expect(run.questions.allSatisfy { $0.status == "investigated" })
        #expect(run.sources.first?.title == "Boiler Upgrade Scheme")
        #expect(run.steps.first?.line.text == "Review: the evidence is ready")
    }
}

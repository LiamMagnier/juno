import XCTest
@testable import JunoChatKit

/// The models line says which models worked, worded as the web says it.
final class NativeResearchModelsLineTests: XCTestCase {
    func testChosenModelThatRanEverything() {
        XCTAssertEqual(
            NativeResearchRun.modelsLine(lead: "Claude Opus 4.5", leadID: "opus", worker: "Claude Opus 4.5", workerID: "opus",
                                         workerNote: nil, chosen: true, done: true),
            "Ran on Claude Opus 4.5"
        )
    }

    func testChosenModelWithoutToolsSaysWhoSearchedAndWhy() {
        XCTAssertEqual(
            NativeResearchRun.modelsLine(lead: "GPT-5 Pro", leadID: "gpt-5-pro", worker: "Claude Haiku 4.5", workerID: "haiku",
                                         workerNote: "no_tools", chosen: true, done: false),
            "Running on GPT-5 Pro \u{00B7} Search by Claude Haiku 4.5 \u{00B7} GPT-5 Pro has no tool calling"
        )
    }

    func testAutoNamesBoth() {
        XCTAssertEqual(
            NativeResearchRun.modelsLine(lead: "Claude Fable 5.1", leadID: "fable", worker: "Claude Haiku 4.5", workerID: "haiku",
                                         workerNote: nil, chosen: false, done: false),
            "Led by Claude Fable 5.1 \u{00B7} Researchers on Claude Haiku 4.5"
        )
    }

    /// The server recalculates "Researched for" from the run and sends 0 when
    /// the run is gone; a zero says "Researched", never "Researched for 0s".
    func testResearchLeadHidesAMissingTime() {
        func view(workedMs: Int) -> NativeRunView {
            var row = NativeChatActivity(id: "r", kind: .context, title: "Research report", detail: nil, url: nil, createdAt: Date())
            row.fact = .research(.init(runID: "run", title: "Plans", workedMs: workedMs, cited: 45, read: 50, pages: 50,
                                       leadModel: "claude", state: "completed"))
            return NativeRunView.build(activity: [row], reasoning: nil)
        }
        XCTAssertEqual(NativeToolPresentation.summaryLead(view(workedMs: 0), workedMs: nil)?.text, "Researched")
        XCTAssertEqual(NativeToolPresentation.summaryLead(view(workedMs: 17 * 60_000), workedMs: nil)?.text, "Researched for 17m")
    }

    func testOlderRunsShowNothing() {
        XCTAssertNil(NativeResearchRun.modelsLine(lead: nil, leadID: nil, worker: nil, workerID: nil, workerNote: nil, chosen: false, done: true))
    }
}

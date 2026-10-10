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

    func testOlderRunsShowNothing() {
        XCTAssertNil(NativeResearchRun.modelsLine(lead: nil, leadID: nil, worker: nil, workerID: nil, workerNote: nil, chosen: false, done: true))
    }
}

import Foundation
import JunoCore
import XCTest

@testable import JunoWorkKit

/// An Orbit task that ran code, as the Mac and iPhone read its log
/// (TOOL_RUNTIME_DESIGN.md §6.12). The runner reuses the event kinds every
/// shipped build decodes (`tool_started`, `tool_finished`, `artifact_created`,
/// `degraded`) and adds `summary`, `runPhase` and `run` as payload keys
/// (src/lib/work/tool-run-events.ts). A failed or unknown run must never wear
/// the check mark a success does.
final class NativeWorkToolRunTests: XCTestCase {
    private func event(_ seq: Int, _ kind: JunoWorkEventKind, _ payload: [String: JunoJSONValue]) -> WorkEvent {
        WorkEvent(seq: seq, kind: kind.rawValue, payload: payload, agentID: nil, createdAt: Date(timeIntervalSince1970: 1_000 + Double(seq)))
    }

    func testARunsEndingIsSaidHonestly() {
        let entries = WorkEventLog.entries(in: [
            event(1, .toolStarted, ["callId": .string("c1"), "tool": .string("run_code"), "summary": .string("Running Python")]),
            event(2, .toolFinished, [
                "callId": .string("c1"), "tool": .string("run_code"), "isError": .bool(true),
                "summary": .string("Python failed · exit 1"), "runPhase": .string("failed"),
                "detail": .object(["summary": .string("KeyError: 'Region'")]),
                "run": .object(["exitCode": .number(1), "language": .string("python"), "futureKey": .array([])]),
            ]),
            event(3, .toolFinished, [
                "callId": .string("c2"), "tool": .string("run_code"), "isError": .bool(false),
                "summary": .string("Ran Python · 2.4s · 2 files"), "runPhase": .string("succeeded"),
            ]),
            event(4, .toolFinished, [
                "callId": .string("c3"), "tool": .string("run_code"), "isError": .bool(true),
                "summary": .string("Outcome unknown, the server restarted while this ran"), "runPhase": .string("outcome_unknown"),
            ]),
            event(5, .toolFinished, [
                "callId": .string("c4"), "tool": .string("run_code"), "isError": .bool(true),
                "summary": .string("Stopped"), "runPhase": .string("cancelled"),
            ]),
            event(6, .artifactCreated, ["artifact": .object(["title": .string("chart.png"), "kind": .string("image"), "origin": .string("tool_output")])]),
        ])
        XCTAssertEqual(entries[0].title, "Running Python")
        XCTAssertEqual(entries[1].title, "Python failed · exit 1")
        XCTAssertEqual(entries[1].detail, "KeyError: 'Region'")
        XCTAssertEqual(entries[1].mark, .problem)
        XCTAssertEqual(entries[1].tone, .bad)
        XCTAssertEqual(entries[2].mark, .check)
        XCTAssertEqual(entries[3].tone, .warning)
        XCTAssertEqual(entries[3].mark, .problem)
        XCTAssertEqual(entries[4].mark, .paused)
        XCTAssertEqual(entries[5].mark, .file)
    }

    func testRunToolsHaveWordsWhenNoSentenceArrives() {
        let vocabulary = JunoWorkVocabulary.self
        XCTAssertEqual(vocabulary.toolPresent("run_code"), "Running code")
        XCTAssertEqual(vocabulary.toolPast("code_interpreter"), "Ran code")
        XCTAssertEqual(vocabulary.toolPresent("use_skill"), "Reading a skill")
    }

    func testAnOlderRunnersToolFinishedKeepsItsOldShape() {
        let entries = WorkEventLog.entries(in: [
            event(1, .toolFinished, ["tool": .string("read_file"), "isError": .bool(false)]),
        ])
        XCTAssertEqual(entries.first?.mark, .check)
        XCTAssertEqual(entries.first?.title, "Read a file")
    }
}

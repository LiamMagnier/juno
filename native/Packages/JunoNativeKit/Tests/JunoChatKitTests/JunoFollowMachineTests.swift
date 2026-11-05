import CoreGraphics
import Foundation
import XCTest
@testable import JunoChatKit

/// The Swift half of reading-first follow, held to the shared fixture in
/// `contracts/chat/follow-machine.fixtures.json`, the same file
/// `tests/follow-machine.test.ts` runs the TypeScript against. Read by path, so
/// there is one table and no copy to drift.
final class JunoFollowMachineTests: XCTestCase {
    private static let fixtureURL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()  // …/JunoChatKitTests
        .deletingLastPathComponent()  // …/Tests
        .deletingLastPathComponent()  // …/JunoNativeKit
        .deletingLastPathComponent()  // …/Packages
        .deletingLastPathComponent()  // …/native
        .deletingLastPathComponent()  // the repository
        .appendingPathComponent("contracts/chat/follow-machine.fixtures.json")

    private func fixture() throws -> [String: Any] {
        let data = try Data(contentsOf: Self.fixtureURL)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func number(_ value: Any?) throws -> CGFloat {
        CGFloat(try XCTUnwrap(value as? NSNumber).doubleValue)
    }

    func testTheFixtureNamesExactlyTheMachinesStatesAndEvents() throws {
        let root = try fixture()
        XCTAssertEqual(root["states"] as? [String], JunoFollowState.allCases.map(\.rawValue))
        XCTAssertEqual(root["events"] as? [String], JunoFollowEvent.allCases.map(\.rawValue))
    }

    func testEveryStateAgainstEveryEventMatchesTheSharedTable() throws {
        let transitions = try XCTUnwrap(try fixture()["transitions"] as? [[String: String]])
        var seen = Set<String>()
        for row in transitions {
            let from = try XCTUnwrap(row["from"].flatMap(JunoFollowState.init(rawValue:)))
            let event = try XCTUnwrap(row["event"].flatMap(JunoFollowEvent.init(rawValue:)))
            let expected = try XCTUnwrap(row["to"].flatMap(JunoFollowState.init(rawValue:)))
            XCTAssertEqual(JunoFollowMachine.next(from, on: event), expected, "\(from) + \(event)")
            seen.insert("\(from)|\(event)")
        }
        XCTAssertEqual(seen.count, JunoFollowState.allCases.count * JunoFollowEvent.allCases.count)
    }

    func testOnlyFollowingAndPlacedMoveTheViewport() throws {
        let follows = try XCTUnwrap(try fixture()["follows"] as? [String: Bool])
        for state in JunoFollowState.allCases {
            XCTAssertEqual(JunoFollowMachine.followsEnd(state), follows[state.rawValue], state.rawValue)
        }
    }

    func testAnswerBedGeometryMatchesTheSharedCases() throws {
        let cases = try XCTUnwrap(try fixture()["bed"] as? [[String: Any]])
        XCTAssertFalse(cases.isEmpty)
        for item in cases {
            let name = item["name"] as? String ?? "?"
            let input = try XCTUnwrap(item["input"] as? [String: Any])
            let expected = try XCTUnwrap(item["expect"] as? [String: Any])
            let inset = try input["inset"].map { try number($0) } ?? JunoFollowMachine.pinInset
            let bed = JunoFollowMachine.answerBed(
                viewportHeight: try number(input["viewportHeight"]),
                turnTop: try number(input["turnTop"]),
                turnHeight: try number(input["turnHeight"]),
                contentEnd: try number(input["contentEnd"]),
                inset: inset
            )
            XCTAssertEqual(bed.height, try number(expected["height"]), name)
            XCTAssertEqual(bed.anchorTop, try number(expected["anchorTop"]), accuracy: 0.001, name)
            XCTAssertEqual(bed.overflow, expected["overflow"] as? Bool, name)
        }
    }

    func testTurnDetectionMatchesTheSharedCases() throws {
        let cases = try XCTUnwrap(try fixture()["startedTurn"] as? [[String: Any]])
        XCTAssertFalse(cases.isEmpty)
        for item in cases {
            let name = item["name"] as? String ?? "?"
            let previous = Set(try XCTUnwrap(item["previous"] as? [String]))
            let rows = try XCTUnwrap(item["rows"] as? [[String: Any]]).map { row in
                JunoFollowMachine.Row(
                    key: row["key"] as? String ?? "",
                    isQuestion: row["question"] as? Bool ?? false,
                    isStreaming: row["streaming"] as? Bool ?? false
                )
            }
            XCTAssertEqual(JunoFollowMachine.startedTurn(previousKeys: previous, rows: rows), item["expect"] as? String, name)
        }
    }

    func testPinnedTurnPlacesOnceThenHoldsWhenTheAnswerOverflows() {
        var pin = JunoPinnedTurn()
        XCTAssertTrue(pin.follows)
        XCTAssertFalse(pin.measure(viewportHeight: 800, turnFrame: nil, contentEnd: 1000), "nothing pinned")

        pin.startTurn(pinning: "u2")
        XCTAssertEqual(pin.state, .placed)
        let turn = CGRect(x: 0, y: 1200, width: 600, height: 80)
        XCTAssertFalse(pin.measure(viewportHeight: 800, turnFrame: nil, contentEnd: 1340), "waits for the question's frame")
        XCTAssertTrue(pin.measure(viewportHeight: 800, turnFrame: turn, contentEnd: 1340), "places on the first measurement")
        XCTAssertEqual(pin.bedHeight, 636)
        XCTAssertTrue(pin.follows)
        XCTAssertFalse(pin.measure(viewportHeight: 800, turnFrame: turn, contentEnd: 1700), "places once")
        XCTAssertEqual(pin.bedHeight, 276)

        _ = pin.measure(viewportHeight: 800, turnFrame: turn, contentEnd: 2100)
        XCTAssertEqual(pin.state, .reading)
        XCTAssertEqual(pin.bedHeight, 0)
        XCTAssertFalse(pin.follows, "an answer past the fold never pulls the viewport")

        pin.send(.nearEnd)
        XCTAssertTrue(pin.follows)
    }

    func testThePinInsetIsTheWebs() {
        // `PIN_INSET` in follow-machine.ts, `--space-6`.
        XCTAssertEqual(JunoFollowMachine.pinInset, 24)
    }

    func testScrollStateTellsTheBedFromContent() {
        // Resting on a pinned question with an empty bed below it: at the end,
        // and nothing to jump to.
        let placed = JunoTranscriptScrollState(
            contentOffsetY: 1176, containerHeight: 900, insetBottom: 100,
            contentHeight: 1976, bedHeight: 500, slop: 24
        )
        XCTAssertEqual(placed, JunoTranscriptScrollState(atEnd: true, contentBelow: false, viewportHeight: 800))
        // The answer ran past the fold: not at the end, content below.
        let reading = JunoTranscriptScrollState(
            contentOffsetY: 1176, containerHeight: 900, insetBottom: 100,
            contentHeight: 2400, bedHeight: 0, slop: 24
        )
        XCTAssertFalse(reading.atEnd)
        XCTAssertTrue(reading.contentBelow)
        // Scrolled up into a tall bed: away from the end, but no content below.
        let upInBed = JunoTranscriptScrollState(
            contentOffsetY: 1000, containerHeight: 900, insetBottom: 100,
            contentHeight: 1976, bedHeight: 500, slop: 24
        )
        XCTAssertFalse(upInBed.atEnd)
        XCTAssertFalse(upInBed.contentBelow)
    }

    func testPinnedTurnFollowsTheServersIdForTheSameQuestion() {
        var pin = JunoPinnedTurn()
        pin.startTurn(pinning: "local-user-1")
        pin.reconcile(ids: ["u1", "a1", "server-user-1", "local-assistant-1"], latestQuestionID: "server-user-1")
        XCTAssertEqual(pin.pinnedID, "server-user-1")
        pin.reset()
        XCTAssertNil(pin.pinnedID)
        XCTAssertEqual(pin.bedHeight, 0)
        XCTAssertEqual(pin.state, .following)
    }
}

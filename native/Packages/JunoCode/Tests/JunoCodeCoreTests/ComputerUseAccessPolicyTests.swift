import XCTest
@testable import JunoCodeCore

/// The screen ladder in Code v2 runtime-mode terms (SPEC §3.7, §3.12).
final class ComputerUseAccessPolicyTests: XCTestCase {
    func testTheLadder() {
        typealias P = ComputerUseAccessPolicy
        for mode in CodeV2.RuntimeMode.allCases {
            XCTAssertEqual(P.decide(mode: mode, isInput: false, hitsFloor: true, appAllowlisted: false), .allow, "looking never asks: \(mode)")
        }
        XCTAssertEqual(P.decide(mode: .readOnly, isInput: true, hitsFloor: false, appAllowlisted: true), .deny(P.readOnlySentence))
        XCTAssertEqual(P.decide(mode: .ask, isInput: true, hitsFloor: false, appAllowlisted: true), .ask, "Ask asks, allowlist or not")
        XCTAssertEqual(P.decide(mode: .autoEdit, isInput: true, hitsFloor: false, appAllowlisted: false), .ask)
        XCTAssertEqual(P.decide(mode: .autoEdit, isInput: true, hitsFloor: false, appAllowlisted: true), .allow)
        XCTAssertEqual(P.decide(mode: .auto, isInput: true, hitsFloor: false, appAllowlisted: true), .allow)
        XCTAssertEqual(P.decide(mode: .auto, isInput: true, hitsFloor: false, appAllowlisted: false), .ask)
        XCTAssertEqual(P.decide(mode: .full, isInput: true, hitsFloor: false, appAllowlisted: false), .allow)
        for mode in [CodeV2.RuntimeMode.ask, .autoEdit, .auto, .full] {
            XCTAssertEqual(P.decide(mode: mode, isInput: true, hitsFloor: true, appAllowlisted: true), .ask, "the floor always asks: \(mode)")
        }
    }

    func testItemsCarryTheRingAsAFractionOfTheScreenshot() throws {
        let item = ComputerActionItems.item(
            callID: "c1", action: .click, status: .completed, at: Date(timeIntervalSince1970: 1_791_489_600),
            app: "Pages", target: "“Export…” button", summary: "Clicked the “Export…” button in Pages.",
            screenshotRef: "alevr-shot://s/c1.jpg", framePoint: [683, 900], frameSize: (1366, 768), durationMs: 640
        )
        guard case let .computerAction(action) = item else { return XCTFail() }
        XCTAssertEqual(action.id, "ca_c1")
        XCTAssertEqual(action.createdAt, "2026-10-08T20:00:00.000Z")
        XCTAssertEqual(action.point, .init(x: 0.5, y: 1), "clamped into the frame")
        XCTAssertEqual(action.frameSize, .init(width: 1366, height: 768))
        let data = try JSONEncoder().encode(item)
        let raw = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(raw["kind"] as? String, "computer_action")
        XCTAssertEqual(raw["callId"] as? String, "c1")
        XCTAssertEqual(try JSONDecoder().decode(CodeV2.TurnItem.self, from: data), item)
        XCTAssertNil({ () -> CodeV2.ComputerAction.UnitPoint? in
            guard case let .computerAction(a) = ComputerActionItems.item(callID: "c", action: .key, status: .running, at: Date(), framePoint: [1, 1]) else { return nil }
            return a.point
        }(), "no frame size, no ring")
    }

    func testScreenshotRefsArePathSafe() {
        XCTAssertEqual(ComputerActionItems.screenshotRef(sessionID: "claude:t7", callID: "toolu_01", mediaType: "image/jpeg"), "alevr-shot://claude:t7/toolu_01.jpg")
        XCTAssertEqual(ComputerActionItems.screenshotRef(sessionID: "../x", callID: "a/b", mediaType: "image/png"), "alevr-shot://_x/a_b.png")
        XCTAssertEqual(ComputerActionItems.sanitize("..."), "_")
    }

    func testTheContractToolArgsDecodeFromTheWire() throws {
        let json = #"{"action":"drag","x":1,"y":2,"to_x":3,"to_y":4,"coordinate_space":"normalized_1000"}"#
        let args = try JSONDecoder().decode(CodeV2.ComputerToolArgs.self, from: Data(json.utf8))
        XCTAssertEqual(args.action, .drag)
        XCTAssertEqual(args.toX, 3)
        XCTAssertEqual(args.coordinateSpace, .normalized1000)
        XCTAssertEqual(CodeV2.computerToolName, "computer_use")
    }
}

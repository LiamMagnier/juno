import XCTest
@testable import JunoScreenControl

/// The global Esc and take-over decisions, without a tap (CU-10).
final class EmergencyStopTapTests: XCTestCase {
    typealias Logic = EmergencyStopTapLogic

    func testTheReadersEscStopsAndIsConsumed() {
        XCTAssertEqual(
            Logic.verdict(kind: .keyDown, keyCode: 53, sourceUserData: 0, escapeIsDown: false, watchesForReaderInput: false),
            .consumeAndStop
        )
        XCTAssertEqual(
            Logic.verdict(kind: .keyUp, keyCode: 53, sourceUserData: 0, escapeIsDown: true, watchesForReaderInput: false),
            .consume,
            "its release is swallowed too, so the app never sees half a key"
        )
    }

    func testAnEscJunoPostsReachesTheApp() {
        XCTAssertEqual(
            Logic.verdict(kind: .keyDown, keyCode: 53, sourceUserData: Logic.syntheticMarker, escapeIsDown: false, watchesForReaderInput: true),
            .pass
        )
    }

    func testOtherReaderInputPausesOnlyWhenWatched() {
        XCTAssertEqual(
            Logic.verdict(kind: .mouse, keyCode: 0, sourceUserData: 0, escapeIsDown: false, watchesForReaderInput: true),
            .readerInput
        )
        XCTAssertEqual(
            Logic.verdict(kind: .mouse, keyCode: 0, sourceUserData: 0, escapeIsDown: false, watchesForReaderInput: false),
            .pass
        )
        XCTAssertEqual(
            Logic.verdict(kind: .keyDown, keyCode: 0, sourceUserData: Logic.syntheticMarker, escapeIsDown: false, watchesForReaderInput: true),
            .pass,
            "Juno's own typing is not the reader taking over"
        )
    }
}

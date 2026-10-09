import XCTest
import JunoScreenControl
@testable import JunoCodeUI

@MainActor
final class ComputerActionOverlayModelTests: XCTestCase {
    private func cue(_ phase: ComputerActionCue.Phase, point: ScreenPoint? = ScreenPoint(x: 940, y: 635)) -> ComputerActionCue {
        ComputerActionCue(sessionID: "s1", label: "Click the “Save” button in TextEdit", point: point, appName: "TextEdit", phase: phase)
    }

    func testTheRingGoesWhereTheActionLandsInAppKitCoordinates() {
        let model = ComputerActionOverlayModel(feed: ComputerActionFeed(), linger: .seconds(60), mainDisplayHeight: { 982 })
        model.apply(cue(.acting))
        XCTAssertEqual(model.mark?.point, CGPoint(x: 940, y: 347), "flipped against the main display")
        XCTAssertEqual(model.mark?.live, true)
        XCTAssertEqual(model.mark?.label, "Click the “Save” button in TextEdit")
        model.apply(cue(.settled(succeeded: true)))
        XCTAssertEqual(model.mark?.live, false)
        XCTAssertEqual(model.mark?.succeeded, true)
        let first = model.mark?.serial
        model.apply(cue(.acting, point: nil))
        XCTAssertNil(model.mark?.point, "typing with no point shows the line alone")
        XCTAssertNotEqual(model.mark?.serial, first)
        model.apply(cue(.cleared))
        XCTAssertNil(model.mark, "Esc or Stop clears it at once")
    }

    func testItLingersAfterTheLastStepThenGoes() async throws {
        let model = ComputerActionOverlayModel(feed: ComputerActionFeed(), linger: .milliseconds(30), mainDisplayHeight: { 900 })
        model.apply(cue(.acting))
        model.apply(cue(.settled(succeeded: false)))
        XCTAssertNotNil(model.mark)
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertNil(model.mark)
    }

    func testANewActionKeepsTheOverlayUp() async throws {
        let model = ComputerActionOverlayModel(feed: ComputerActionFeed(), linger: .milliseconds(30), mainDisplayHeight: { 900 })
        model.apply(cue(.acting))
        model.apply(cue(.settled(succeeded: true)))
        model.apply(cue(.acting))
        try await Task.sleep(for: .milliseconds(120))
        XCTAssertEqual(model.mark?.live, true, "the earlier step's linger does not hide the running one")
    }

    func testItFollowsTheFeed() async throws {
        let feed = ComputerActionFeed()
        let model = ComputerActionOverlayModel(feed: feed, linger: .seconds(60), mainDisplayHeight: { 900 })
        model.start()
        feed.post(cue(.acting))
        for _ in 0..<50 where model.mark == nil { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(model.mark?.appName, "TextEdit")
        model.stop()
        XCTAssertNil(model.mark)
    }
}

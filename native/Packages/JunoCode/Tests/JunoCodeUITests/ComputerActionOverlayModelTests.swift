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
        XCTAssertEqual(model.mark?.point, CGPoint(x: 940, y: 347), "typing keeps the last known agent position")
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

    func testDefaultPreviewPersistsBetweenStepsAndDiscardsLateResultsAfterStop() async throws {
        let model = ComputerActionOverlayModel(feed: ComputerActionFeed(), mainDisplayHeight: { 900 })
        var observation = cue(.observing, point: nil)
        observation.thumbnail = Data([1, 2, 3])
        observation.windowFrame = ScreenRect(x: 100, y: 100, width: 600, height: 400)
        model.apply(observation)
        XCTAssertEqual(model.mark?.point, CGPoint(x: 400, y: 600))
        model.apply(cue(.acting))
        model.apply(cue(.settled(succeeded: true)))
        try await Task.sleep(for: .milliseconds(1_300))
        XCTAssertNotNil(model.mark, "the agent stays visible while thinking")
        XCTAssertEqual(model.mark?.thumbnail, observation.thumbnail)
        model.apply(cue(.cleared))
        model.apply(cue(.settled(succeeded: false)))
        XCTAssertNil(model.mark, "a suspended action cannot restore stopped content")
    }

    func testAnOlderSessionCannotSettleOrClearTheCurrentPreview() {
        let model = ComputerActionOverlayModel(feed: ComputerActionFeed(), mainDisplayHeight: { 1080 })
        model.apply(cue(.acting))
        var other = cue(.settled(succeeded: false))
        other.sessionID = "older"
        model.apply(other)
        XCTAssertEqual(model.mark?.live, true)
        other.phase = .cleared
        model.apply(other)
        XCTAssertNotNil(model.mark)
        model.apply(cue(.observing, point: nil))
        XCTAssertEqual(model.mark?.point, CGPoint(x: 940, y: 1080 - 635), "observation keeps the target")
    }

    func testReaderHandoffPreservesPreviewAndStopsTheLivePointer() {
        let model = ComputerActionOverlayModel(feed: ComputerActionFeed())
        model.apply(cue(.acting))
        let point = model.mark?.point
        model.apply(cue(.paused(true)))
        XCTAssertEqual(model.mark?.paused, true)
        XCTAssertEqual(model.mark?.live, false)
        XCTAssertEqual(model.mark?.point, point)
        model.apply(cue(.paused(false)))
        XCTAssertEqual(model.mark?.paused, false)
        model.apply(cue(.cleared))
        model.apply(cue(.paused(true)))
        XCTAssertNil(model.mark)
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

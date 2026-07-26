import XCTest

/// The jump-to-latest control.
///
/// It is a `ScrollViewProxy.scrollTo` inside an overlay on the transcript, and
/// every part of that is invisible to a unit test: whether the tap reaches the
/// button at all, and whether the scroll it asks for actually happens. The proof
/// used here is the control's own visibility rule — it exists only while the
/// reader is away from the bottom, so a working tap makes it disappear.
final class JunoMobileScrollToLatestUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "--juno-ui-preview",
            "--juno-preview-scenario", "longText",
            "--juno-preview-tab", "chat",
        ]
        app.launch()
        return app
    }

    @MainActor
    func testTappingJumpToLatestReturnsToTheBottom() {
        let app = launch()
        let transcript = app.scrollViews["juno.mobile.conversation-detail"].firstMatch
        XCTAssertTrue(transcript.waitForExistence(timeout: 20), app.debugDescription)

        let jump = app.descendants(matching: .any)["juno.mobile.chat-scroll-bottom"].firstMatch
        for _ in 0..<8 where !jump.exists {
            transcript.swipeDown()
        }
        XCTAssertTrue(
            jump.exists,
            "Jump-to-latest never appeared. On screen:\n\(app.debugDescription)"
        )
        XCTAssertTrue(jump.isHittable, "Jump-to-latest is on screen but not tappable")

        jump.tap()

        // Back at the bottom, the control's own rule removes it. Still on screen
        // after the animation means the tap did nothing.
        let gone = expectation(
            for: NSPredicate(format: "exists == false"),
            evaluatedWith: jump
        )
        XCTAssertEqual(
            XCTWaiter.wait(for: [gone], timeout: 6),
            .completed,
            "The transcript did not scroll to the bottom. On screen:\n\(app.debugDescription)"
        )
    }
}

import XCTest

/// The jump-to-latest control.
///
/// The proof asserted here is the **scroll**, not the button: the last answer's
/// action row lives at the very bottom of the transcript, so it is on screen
/// only when the transcript really is at the bottom. An earlier version of this
/// test watched the button disappear instead, and that is exactly the assertion
/// a control which hides itself optimistically can pass without scrolling
/// anything.
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

        // The bottom-most thing in the transcript: the last answer's action row.
        let footer = app.buttons["juno.mobile.message-copy"].firstMatch
        XCTAssertTrue(
            footer.waitForExistence(timeout: 10),
            "No action row to scroll back to. On screen:\n\(app.debugDescription)"
        )

        let jump = app.descendants(matching: .any)["juno.mobile.chat-scroll-bottom"].firstMatch
        for _ in 0..<8 where !jump.exists {
            transcript.swipeDown()
        }
        XCTAssertTrue(
            jump.exists,
            "Jump-to-latest never appeared. On screen:\n\(app.debugDescription)"
        )
        XCTAssertTrue(jump.isHittable, "Jump-to-latest is on screen but not tappable")
        // Scrolled away, so the row at the bottom is off screen. If this fails the
        // test never left the bottom and proves nothing.
        XCTAssertFalse(footer.isHittable, "Expected to be scrolled away from the bottom")

        add(screenshot(app, named: "before-tap"))
        jump.tap()

        let back = expectation(
            for: NSPredicate(format: "isHittable == true"),
            evaluatedWith: footer
        )
        let outcome = XCTWaiter.wait(for: [back], timeout: 6)
        add(screenshot(app, named: "after-tap"))
        XCTAssertEqual(
            outcome,
            .completed,
            "The transcript did not scroll to the bottom. On screen:\n\(app.debugDescription)"
        )
    }

    private func screenshot(_ app: XCUIApplication, named name: String) -> XCTAttachment {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        return attachment
    }
}

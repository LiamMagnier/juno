import XCTest

/// The collapsed long prompt, and the control that opens it.
///
/// The bubble's cap is a layout decision — a `maxHeight` and a clip — and layout
/// is the one thing a unit test over ``NativePromptLimits`` cannot check. This
/// drives the real transcript: it finds the Show more control on a long prompt,
/// and proves that tapping it changes what the control says.
final class JunoMobileLongPromptUITests: XCTestCase {
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
    func testALongPromptOpensCollapsedAndExpands() {
        let app = launch()
        let transcript = app.scrollViews["juno.mobile.conversation-detail"].firstMatch
        XCTAssertTrue(transcript.waitForExistence(timeout: 20), app.debugDescription)

        // The transcript is bottom-anchored, so the prompt above the answer needs
        // scrolling to. Bounded rather than `while`: a fixture that stopped being
        // long should fail this test, not hang it.
        let control = app.descendants(matching: .any)["juno.mobile.message-expand"].firstMatch
        for _ in 0..<14 where !control.isHittable {
            transcript.swipeDown()
        }
        XCTAssertTrue(
            control.isHittable,
            "No Show more control. On screen:\n\(app.debugDescription)"
        )

        let collapsed = control.label
        XCTAssertTrue(
            collapsed.contains("Show more"),
            "Expected a collapsed prompt, got \(collapsed)"
        )

        add(screenshot(app, named: "collapsed-prompt"))

        control.tap()
        XCTAssertTrue(
            app.descendants(matching: .any)["juno.mobile.message-expand"]
                .firstMatch.waitForExistence(timeout: 5)
        )
        add(screenshot(app, named: "expanded-prompt"))
    }

    private func screenshot(_ app: XCUIApplication, named name: String) -> XCTAttachment {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        return attachment
    }
}

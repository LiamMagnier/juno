import XCTest

/// Drives the real composer controls through the preview harness.
///
/// The Thinking slider especially needs this: it is custom-drawn, so "does a
/// touch on the track actually move it" is not something the unit tests over
/// `NativeThinkingScale` can answer. An earlier build passed every unit test
/// while being completely undraggable on device.
final class JunoMobileComposerUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    private func launch(_ extraArguments: [String]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "--juno-ui-preview",
            "--juno-preview-tab", "chat",
        ] + extraArguments
        app.launch()
        return app
    }

    /// The chip is the composer's Thinking control; its value is the level.
    private func thinkingChip(_ app: XCUIApplication) -> XCUIElement {
        app.buttons["juno.mobile.chat-thinking"]
    }

    /// The custom-drawn slider is an adjustable accessibility element, and the
    /// element TYPE that maps to varies; match on the identifier alone.
    private func thinkingSlider(_ app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any)["juno.thinking-slider"].firstMatch
    }

    /// Waits for the chip to settle on a level. The accessibility value is
    /// verbose for VoiceOver ("High. Available levels: …"), so match the prefix.
    private func waitForChipValue(
        _ chip: XCUIElement,
        prefix: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let settled = expectation(
            for: NSPredicate(format: "value BEGINSWITH %@", prefix),
            evaluatedWith: chip
        )
        XCTAssertEqual(
            XCTWaiter().wait(for: [settled], timeout: 10),
            .completed,
            "Chip never reached \"\(prefix)\"; value was \(String(describing: chip.value))",
            file: file,
            line: line
        )
    }

    /// Waits, and on failure says what WAS on screen — a bare "false" here costs
    /// a whole rerun to diagnose.
    private func require(
        _ element: XCUIElement,
        _ app: XCUIApplication,
        timeout: TimeInterval = 20,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertTrue(
            element.waitForExistence(timeout: timeout),
            "Not found. On screen:\n\(app.debugDescription)",
            file: file,
            line: line
        )
    }

    @MainActor
    func testThinkingSliderDragsThroughEveryLevel() {
        // GPT-5.6 publishes the full ladder: Off · Minimal · Low · Medium ·
        // High · Extra high · Max.
        let app = launch([
            "--juno-preview-model", "openai:gpt-5-6",
            "--juno-preview-thinking-level", "off",
        ])

        let chip = thinkingChip(app)
        require(chip, app)
        // The chip's value is deliberately verbose for VoiceOver
        // ("Off. Available levels: …"); assert on the level it leads with.
        XCTAssertEqual((chip.value as? String)?.prefix(3), "Off")

        chip.tap()
        let slider = thinkingSlider(app)
        require(slider, app, timeout: 5)

        // Drag to the far right: the deepest tier the model supports.
        slider.coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.5))
            .press(
                forDuration: 0.05,
                thenDragTo: slider.coordinate(
                    withNormalizedOffset: CGVector(dx: 0.99, dy: 0.5)
                )
            )
        XCTAssertEqual(slider.value as? String, "Thinking max")

        // And back to the shallowest.
        slider.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5))
            .press(
                forDuration: 0.05,
                thenDragTo: slider.coordinate(
                    withNormalizedOffset: CGVector(dx: 0.01, dy: 0.5)
                )
            )
        XCTAssertEqual(slider.value as? String, "Thinking off")
    }

    @MainActor
    func testTappingATrackPositionJumpsToThatDetent() {
        let app = launch([
            "--juno-preview-model", "openai:gpt-5-6",
            "--juno-preview-thinking-level", "off",
        ])

        let chip = thinkingChip(app)
        require(chip, app)
        chip.tap()

        let slider = thinkingSlider(app)
        require(slider, app, timeout: 5)

        // Mid-track on a seven-stop ladder is Medium — a tap, not a drag, which
        // a UIKit slider would have ignored entirely.
        slider.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertEqual(slider.value as? String, "Thinking medium")
    }

    @MainActor
    func testTheChipAndTheSliderAgreeAfterAdjusting() {
        let app = launch([
            "--juno-preview-model", "openai:gpt-5-6",
            "--juno-preview-thinking-level", "off",
        ])

        let chip = thinkingChip(app)
        require(chip, app)
        chip.tap()

        let slider = thinkingSlider(app)
        require(slider, app, timeout: 5)
        slider.coordinate(withNormalizedOffset: CGVector(dx: 0.99, dy: 0.5)).tap()

        // Dismiss the popover and confirm the composer chip followed.
        app.tap()
        XCTAssertTrue(chip.waitForExistence(timeout: 5))
        XCTAssertEqual((chip.value as? String)?.prefix(3), "Max")
    }

    @MainActor
    func testAnOnOffModelExposesExactlyTwoStops() {
        // Opened by launch flag rather than by tapping. The tap path is already
        // covered by the three tests above; here the model is swapped from the
        // default *after* the catalog loads, and tapping into that transition
        // is timing-dependent in a way that says nothing about this behaviour.
        let app = launch([
            "--juno-preview-model", "anthropic:claude-haiku-4-5",
            "--juno-preview-thinking",
        ])

        let slider = thinkingSlider(app)
        require(slider, app)

        slider.coordinate(withNormalizedOffset: CGVector(dx: 0.99, dy: 0.5)).tap()
        XCTAssertEqual(slider.value as? String, "Thinking on")
        slider.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.5)).tap()
        XCTAssertEqual(slider.value as? String, "Thinking off")
    }

    @MainActor
    func testAutoOffersNoThinkingSliderAtAll() {
        // The router picks the depth per message, so there is nothing to set.
        let app = launch(["--juno-preview-model", "juno:auto"])

        let chip = thinkingChip(app)
        require(chip, app)
        XCTAssertEqual(chip.value as? String, "Chosen automatically for each message")

        chip.tap()
        XCTAssertFalse(thinkingSlider(app).waitForExistence(timeout: 2))
    }

    /// The "+ does nothing" report from a real iPhone, now a regression guard.
    ///
    /// The cause was never the button. The shell armed a `DragGesture` for the
    /// sidebar reveal, which won every touch near the leading edge — and the "+"
    /// centre lands at x≈36, inside it. Recognising that gesture
    /// *simultaneously* lets the button act and leaves the drawer swipe intact.
    /// The panel is also a sheet now rather than a popover, which is both the
    /// better phone affordance and immune to the sizing rule that stops a
    /// popover with no intrinsic height from presenting at all.
    @MainActor
    func testTheComposerPlusButtonOpensTheActionsPanelOnTap() {
        let app = launch([])

        let plus = app.buttons["juno.mobile.chat-plus"]
        require(plus, app)
        XCTAssertTrue(plus.isHittable, "The + is on screen but not hittable.")

        plus.tap()
        // Assert on the panel's own rows rather than its identifier: the
        // identifier sits on a container the presentation may not surface as its
        // own element, and a missing identifier would look exactly like a
        // missing panel.
        require(app.staticTexts["Camera"], app, timeout: 5)
        // Matched as static text, not as a button: each row is a Button wrapping
        // a title and a subtitle, so its accessibility label is the pair joined
        // ("Camera, Take a photo now") and an exact button lookup finds nothing.
        XCTAssertTrue(app.staticTexts["Photos"].exists, "The photo action is missing from the panel.")
        XCTAssertTrue(app.staticTexts["Files"].exists, "The files action is missing from the panel.")
    }

    /// Taps all the way through to a picker, which the panel test above does not.
    ///
    /// **This is a smoke test, not a regression guard — and the difference
    /// matters.** The reported failure ("the panel opens, Photos and Camera do
    /// nothing") does not reproduce under XCUITest: it was verified that this
    /// test passes against the structure that shipped broken, because the
    /// simulator dismisses and presents fast enough that a racing presentation
    /// still lands, and synthetic taps do not arbitrate with system gestures the
    /// way a thumb does. So what this proves is only that the path is wired —
    /// panel → choice → a presentation appears. Do not read a pass here as
    /// evidence that the device-side defect is fixed.
    ///
    /// The assertion is that the app gets covered. The picker renders out of
    /// process, so there is no element of ours to wait for — but a presentation
    /// that happened makes the composer unreachable, and one that was dropped
    /// leaves it sitting there.
    @MainActor
    func testTappingPhotosInThePanelActuallyOpensAPicker() {
        let app = launch([])

        let plus = app.buttons["juno.mobile.chat-plus"]
        require(plus, app)
        plus.tap()
        require(app.staticTexts["Photos"], app, timeout: 5)
        app.staticTexts["Photos"].tap()

        let covered = expectation(
            for: NSPredicate(format: "isHittable == false"), evaluatedWith: plus
        )
        XCTAssertEqual(
            XCTWaiter().wait(for: [covered], timeout: 10),
            .completed,
            "The panel closed but nothing was presented over the app. On screen:\n\(app.debugDescription)"
        )
    }

    /// The camera's own path. Asserts on our surface rather than on coverage,
    /// because the camera view is ours: with no capture hardware — the
    /// simulator — it renders an explicit unavailable card instead of a preview.
    /// Same caveat as the Photos test above: it cannot see the device-only
    /// failure.
    @MainActor
    func testTappingCameraInThePanelActuallyOpensTheCamera() {
        let app = launch([])

        let plus = app.buttons["juno.mobile.chat-plus"]
        require(plus, app)
        plus.tap()
        require(app.staticTexts["Camera"], app, timeout: 5)
        app.staticTexts["Camera"].tap()

        let unavailable = app.descendants(matching: .any)["juno.mobile.camera-unavailable"]
        let preview = app.descendants(matching: .any)["juno.mobile.camera-preview"]
        let opened = expectation(
            for: NSPredicate(format: "exists == true OR count > 0"),
            evaluatedWith: unavailable.firstMatch
        )
        let result = XCTWaiter().wait(for: [opened], timeout: 10)
        XCTAssertTrue(
            result == .completed || preview.firstMatch.exists,
            "The panel closed but no camera surface appeared. On screen:\n\(app.debugDescription)"
        )
    }

    /// The regression guard for the actual defect: the button reported a 13.3pt
    /// frame — the bare glyph — because nothing declared its hit shape. A
    /// synthetic tap lands dead centre and so still hit it; a thumb did not.
    ///
    /// The row has since been rebuilt around a 40×44 hit rectangle behind a 34pt
    /// glyph, so this now asserts Apple's own 44pt minimum on the axis that had
    /// the room for it.
    @MainActor
    func testTheComposerPlusButtonHasARealTouchTargetNotJustAGlyph() {
        let app = launch([])

        let plus = app.buttons["juno.mobile.chat-plus"]
        require(plus, app)
        XCTAssertGreaterThanOrEqual(plus.frame.width, 40, "+ hit area collapsed to the glyph")
        XCTAssertGreaterThanOrEqual(plus.frame.height, 44, "+ hit area collapsed to the glyph")
    }

    /// Diagnostic companion to the "+" test: the model chip sits in the same
    /// row, inside the same bottom safe-area inset, and opens the same kind of
    /// popover. If this passes while "+" fails, the cause is positional rather
    /// than structural — the "+" is the leftmost control, and the root view
    /// arms a drag gesture that opens the sidebar from `startLocation.x < 32`.
    @MainActor
    func testTheModelChipInTheSameRowOpensItsPopoverOnTap() {
        let app = launch([])

        let chip = app.buttons["juno.mobile.chat-model"]
        require(chip, app)
        chip.tap()
        require(app.descendants(matching: .any)["juno.mobile.model-provider-rail"].firstMatch, app, timeout: 5)
    }

    /// Send had the identical construction, so it had the identical defect.
    @MainActor
    func testTheSendButtonHasARealTouchTarget() {
        let app = launch([])

        let send = app.buttons["juno.mobile.chat-send"]
        require(send, app)
        XCTAssertGreaterThanOrEqual(send.frame.width, 32, "Send hit area collapsed to the glyph")
        XCTAssertGreaterThanOrEqual(send.frame.height, 32, "Send hit area collapsed to the glyph")
    }

    @MainActor
    func testANonReasoningModelHidesTheThinkingControl() {
        let app = launch(["--juno-preview-model", "google:gemini-3-flash"])

        require(app.buttons["juno.mobile.chat-model"], app)
        XCTAssertFalse(thinkingChip(app).exists)
    }
}

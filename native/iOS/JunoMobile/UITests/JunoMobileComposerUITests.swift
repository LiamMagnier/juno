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

    /// A menu row, however this OS chooses to expose one. Menus have reported
    /// their rows as buttons and as static text across releases, and a lookup
    /// that guesses wrong fails identically to a menu that never opened.
    @MainActor
    private func requireMenuRow(
        _ app: XCUIApplication,
        _ label: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) -> XCUIElement {
        let button = app.buttons[label]
        if button.waitForExistence(timeout: 5) { return hittable(button) }
        let text = app.staticTexts[label]
        XCTAssertTrue(
            text.waitForExistence(timeout: 5),
            "No \"\(label)\" row in the menu. On screen:\n\(app.debugDescription)",
            file: file,
            line: line
        )
        return hittable(text)
    }

    /// A row exists as soon as the menu is built, which is before it has
    /// finished opening — and a tap in that window is swallowed. Waiting for
    /// hittability is what makes the menu tests reliable rather than usually
    /// fine.
    @MainActor
    private func hittable(_ element: XCUIElement) -> XCUIElement {
        _ = XCTWaiter().wait(
            for: [
                expectation(
                    for: NSPredicate(format: "isHittable == true"), evaluatedWith: element
                )
            ],
            timeout: 5
        )
        return element
    }

    /// The "+ does nothing" report from a real iPhone, now a regression guard.
    ///
    /// The cause was never the button. The shell armed a `DragGesture` for the
    /// sidebar reveal, which won every touch near the leading edge — and the "+"
    /// centre lands at x≈36, inside it. Recognising that gesture
    /// *simultaneously* lets the button act and leaves the drawer swipe intact.
    @MainActor
    func testTheComposerPlusButtonOpensTheAttachmentMenuOnTap() {
        let app = launch([])

        let plus = app.buttons["juno.mobile.chat-plus"]
        require(plus, app)
        XCTAssertTrue(plus.isHittable, "The + is on screen but not hittable.")

        plus.tap()
        _ = requireMenuRow(app, "Camera")
        XCTAssertTrue(app.descendants(matching: .any)["Photos"].firstMatch.exists)
        XCTAssertTrue(app.descendants(matching: .any)["Files"].firstMatch.exists)
        XCTAssertTrue(app.descendants(matching: .any)["From your library"].firstMatch.exists)
    }

    /// The Tools submenu — the website's second group, which this app did not
    /// have at all.
    ///
    /// Deep research especially: the flag was already plumbed the whole way
    /// through `NativeChatGenerationRequest` and the retry context, and there was
    /// no control anywhere in the app that could set it. A build that regresses
    /// this ships a feature nobody can reach, which is exactly the state this
    /// test exists to prevent.
    ///
    /// Matched on a prefix because the row states its own count — "Tools · 3"
    /// with web search, canvas and memory on, which is the harness's resting
    /// state.
    @MainActor
    private func openTools(_ app: XCUIApplication) {
        let tools = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH %@", "Tools"))
            .firstMatch
        XCTAssertTrue(
            tools.waitForExistence(timeout: 5),
            "No Tools row in the menu. On screen:\n\(app.debugDescription)"
        )
        hittable(tools).tap()
    }

    @MainActor
    func testThePlusMenuOffersTheWebsitesTools() {
        let app = launch([])

        let plus = app.buttons["juno.mobile.chat-plus"]
        require(plus, app)
        plus.tap()

        XCTAssertTrue(app.descendants(matching: .any)["Create a canvas"].firstMatch.exists)
        openTools(app)

        _ = requireMenuRow(app, "Deep research")
        XCTAssertTrue(app.descendants(matching: .any)["Web search"].firstMatch.exists)
        XCTAssertTrue(app.descendants(matching: .any)["Canvas & artifacts"].firstMatch.exists)
        XCTAssertTrue(app.descendants(matching: .any)["Memory"].firstMatch.exists)
    }

    /// Arming research marks the "+" itself.
    ///
    /// The dot is the only thing on screen that says the next message will cost a
    /// multi-minute research run, because the menu that set it is closed by then —
    /// and now that the switches live one level down, it is the only thing saying
    /// so at the top level either. Asserted through the accessibility label rather
    /// than by pixel: the label is what a VoiceOver reader gets, and if it is
    /// right the dot is drawn.
    @MainActor
    func testArmingDeepResearchMarksThePlusButton() {
        let app = launch([])

        let plus = app.buttons["juno.mobile.chat-plus"]
        require(plus, app)
        XCTAssertEqual(plus.label, "Add")

        plus.tap()
        openTools(app)
        requireMenuRow(app, "Deep research").tap()

        let armed = expectation(
            for: NSPredicate(format: "label BEGINSWITH %@", "Add — deep research"),
            evaluatedWith: plus
        )
        XCTAssertEqual(
            XCTWaiter().wait(for: [armed], timeout: 5),
            .completed,
            "The + never announced that research is armed. Label was \(plus.label)"
        )
    }

    /// The library picker opens from the menu and can be dismissed.
    ///
    /// The harness's canned library is empty, so this asserts on the picker's own
    /// chrome rather than on rows: what is being proved is that the row is wired
    /// to a presentation at all.
    @MainActor
    func testChoosingLibraryOpensThePicker() {
        let app = launch([])

        let plus = app.buttons["juno.mobile.chat-plus"]
        require(plus, app)
        plus.tap()
        requireMenuRow(app, "From your library").tap()

        require(app.buttons["juno.mobile.library-attach"], app, timeout: 10)
        XCTAssertFalse(
            plus.isHittable,
            "The library picker opened but the composer is still reachable beneath it."
        )
    }

    /// The headline behaviour, and the one the panel this replaced could not
    /// have: opening the menu is not a presentation, so the keyboard stays where
    /// it is and the composer does not move under the reader's thumb.
    @MainActor
    func testOpeningTheMenuLeavesTheKeyboardUp() throws {
        let app = launch(["--juno-preview-keyboard"])

        let plus = app.buttons["juno.mobile.chat-plus"]
        require(plus, app)
        guard app.keyboards.firstMatch.waitForExistence(timeout: 5) else {
            // The simulator is on a hardware keyboard; there is no software
            // keyboard to keep up, and asserting on one would be noise.
            throw XCTSkip("No software keyboard on this simulator.")
        }

        plus.tap()
        _ = requireMenuRow(app, "Camera")
        XCTAssertTrue(
            app.keyboards.firstMatch.exists,
            "Opening the attachment menu dismissed the keyboard."
        )
    }

    /// The other half of the gesture fix: scoping the drawer's open-swipe to the
    /// leading edge is what stopped it competing with the menu, and this is what
    /// proves the swipe still works.
    ///
    /// Asserts on the plate going inert rather than on a sidebar row appearing:
    /// the drawer is always in the hierarchy, behind the plate, so "the drawer
    /// exists" says nothing about whether it opened.
    @MainActor
    func testSwipingFromTheLeadingEdgeStillOpensTheDrawer() {
        let app = launch([])

        let plus = app.buttons["juno.mobile.chat-plus"]
        require(plus, app)
        XCTAssertTrue(plus.isHittable, "The composer is not reachable to begin with.")

        app.coordinate(withNormalizedOffset: CGVector(dx: 0.004, dy: 0.5))
            .press(
                forDuration: 0.05,
                thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.75, dy: 0.5))
            )

        let revealed = expectation(
            for: NSPredicate(format: "isHittable == false"), evaluatedWith: plus
        )
        XCTAssertEqual(
            XCTWaiter().wait(for: [revealed], timeout: 5),
            .completed,
            "The edge swipe did not open the drawer. On screen:\n\(app.debugDescription)"
        )
    }

    /// Taps all the way through to the photo panel.
    ///
    /// The grid inside it renders out of process, so there is no photo of ours
    /// to wait for — but the panel's own All Photos control is ours, and the
    /// composer being unreachable is what says the panel is over it rather than
    /// under it.
    @MainActor
    func testChoosingPhotosOpensThePhotoPanelOverTheComposer() {
        let app = launch([])

        let plus = app.buttons["juno.mobile.chat-plus"]
        require(plus, app)
        plus.tap()
        requireMenuRow(app, "Photos").tap()

        // Generous on purpose: the picker is an out-of-process extension and its
        // first launch on a cold simulator is seconds, not milliseconds.
        require(app.buttons["juno.mobile.photos-all"], app, timeout: 30)
        XCTAssertFalse(
            plus.isHittable,
            "The photo panel opened but the composer is still reachable beneath it."
        )
    }

    /// The camera's own path. Asserts on our surface rather than on coverage,
    /// because the camera panel is ours: with no capture hardware — the
    /// simulator — it renders an explicit unavailable card instead of a preview,
    /// and the panel itself is on screen either way.
    @MainActor
    func testChoosingCameraOpensTheCameraPanel() {
        let app = launch([])

        let plus = app.buttons["juno.mobile.chat-plus"]
        require(plus, app)
        plus.tap()
        requireMenuRow(app, "Camera").tap()

        // The close control, not a panel identifier: an identifier on the panel
        // would be inherited by everything inside it.
        require(app.buttons["juno.mobile.camera-close"], app, timeout: 10)
        // And the panel is over the composer, not under it.
        XCTAssertFalse(
            plus.isHittable,
            "The camera panel opened but the composer is still reachable beneath it."
        )
    }

    /// The camera panel is opened straight from a launch argument here — the tap
    /// path is covered above — so the close control is exercised without the
    /// menu's timing in the way.
    @MainActor
    func testTheCameraPanelClosesAndGivesTheComposerBack() {
        let app = launch(["--juno-preview-picker", "camera"])

        let close = app.buttons["juno.mobile.camera-close"]
        require(close, app)
        close.tap()

        let plus = app.buttons["juno.mobile.chat-plus"]
        let restored = expectation(
            for: NSPredicate(format: "isHittable == true"), evaluatedWith: plus
        )
        XCTAssertEqual(
            XCTWaiter().wait(for: [restored], timeout: 10),
            .completed,
            "Closing the camera did not give the composer back. On screen:\n\(app.debugDescription)"
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

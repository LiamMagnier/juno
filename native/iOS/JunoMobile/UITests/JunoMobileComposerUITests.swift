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

    /// The open dial: tapping the gauge turns the composer's control row into
    /// a track with one detent per level (ChatGPT's "thinking speed"). It is
    /// one adjustable accessibility element whose value is the level's name,
    /// and the element TYPE that maps to varies; match on the identifier alone.
    private func thinkingSlider(_ app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any)["juno.mobile.thinking-dial"].firstMatch
    }

    /// Waits for the chip to settle on a level. The value is the level's name
    /// ("Instant", "Medium", "Max"); matched on a prefix so a longer VoiceOver
    /// form would still read.
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
        // The gauge's value is the level it points at.
        XCTAssertEqual((chip.value as? String)?.prefix(7), "Instant")

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
        // The open dial folds back into the gauge a moment after the finger
        // lifts, so the level is read where it lands: on the gauge.
        waitForChipValue(chip, prefix: "Max")

        // And back to the shallowest.
        chip.tap()
        require(slider, app, timeout: 5)
        slider.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5))
            .press(
                forDuration: 0.05,
                thenDragTo: slider.coordinate(
                    withNormalizedOffset: CGVector(dx: 0.01, dy: 0.5)
                )
            )
        waitForChipValue(chip, prefix: "Instant")
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
        waitForChipValue(chip, prefix: "Medium")
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

        // The dial folds itself back into the gauge after the touch; the
        // gauge it folds into must point at the level the dial was left on.
        XCTAssertTrue(chip.waitForExistence(timeout: 5))
        waitForChipValue(chip, prefix: "Max")
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

        // The two ends of the track are the only two levels: on and off.
        slider.coordinate(withNormalizedOffset: CGVector(dx: 0.99, dy: 0.5)).tap()
        let chip = thinkingChip(app)
        waitForChipValue(chip, prefix: "Thinking")

        chip.tap()
        require(slider, app, timeout: 5)
        slider.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.5)).tap()
        waitForChipValue(chip, prefix: "Instant")
    }

    @MainActor
    func testAutoOffersNoThinkingSliderAtAll() {
        // The router picks the depth per message, so there is nothing to set.
        let app = launch(["--juno-preview-model", "juno:auto"])

        let chip = thinkingChip(app)
        require(chip, app)
        XCTAssertEqual(chip.value as? String, "Chosen automatically for each message")

        // With nothing to dial, the gauge offers the model instead.
        chip.tap()
        require(app.descendants(matching: .any)["juno.mobile.model-list"].firstMatch, app, timeout: 5)
        XCTAssertFalse(thinkingSlider(app).exists)
    }

    /// The whole capsule opens the picker, not just the word printed on it.
    ///
    /// The chip was untappable at its own centre. Liquid Glass is drawn by the
    /// system rather than by content of ours, so with no declared hit shape the
    /// only touchable parts of a 56pt capsule were the glyphs inside it — a live
    /// band about 13pt wide — and the chip's centre, pushed rightwards by the
    /// chevron, sat in the gap beside it. Three tests failed on `chip.tap()`
    /// while the control looked perfectly ordinary in a screenshot.
    ///
    /// Aimed at 85% across on purpose: that is over the chevron, in the dead
    /// zone, and a plain centre tap would not notice the defect coming back.
    @MainActor
    func testTappingTheThinkingChipOverItsChevronOpensThePicker() {
        let app = launch(["--juno-preview-model", "openai:gpt-5-6"])

        let chip = thinkingChip(app)
        require(chip, app)
        chip.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.5)).tap()
        require(thinkingSlider(app), app, timeout: 5)
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

    /// "More" — the panel's last row, a native menu with the standing
    /// preferences (canvas, memory, the project, Flash/Pro where the model has
    /// them). The research and web-search switches sit on the panel itself.
    @MainActor
    private func openMore(_ app: XCUIApplication) {
        let more = app.descendants(matching: .any)["juno.mobile.composer-tools"].firstMatch
        XCTAssertTrue(
            more.waitForExistence(timeout: 5),
            "No More row in the + panel. On screen:\n\(app.debugDescription)"
        )
        hittable(more).tap()
    }

    /// The website's tools, which this app did not have at all.
    ///
    /// Deep research especially: the flag was already plumbed the whole way
    /// through `NativeChatGenerationRequest` and the retry context, and there was
    /// no control anywhere in the app that could set it. A build that regresses
    /// this ships a feature nobody can reach, which is exactly the state this
    /// test exists to prevent.
    ///
    /// Since the glass "+" panel (round 2), Deep research and Web search are
    /// rows of the panel itself — ChatGPT's grouping — and the rarely-touched
    /// switches (Create a canvas, Canvas & artifacts, Memory) are under More.
    @MainActor
    func testThePlusMenuOffersTheWebsitesTools() {
        let app = launch([])

        let plus = app.buttons["juno.mobile.chat-plus"]
        require(plus, app)
        plus.tap()

        _ = requireMenuRow(app, "Deep research")
        XCTAssertTrue(app.descendants(matching: .any)["Web search"].firstMatch.exists)

        openMore(app)
        _ = requireMenuRow(app, "Create a canvas")
        XCTAssertTrue(app.descendants(matching: .any)["Canvas & artifacts"].firstMatch.exists)
        XCTAssertTrue(app.descendants(matching: .any)["Memory"].firstMatch.exists)
    }

    /// Arming research marks the "+" itself.
    ///
    /// The dot is the only thing on screen that says the next message will cost a
    /// multi-minute research run, because the panel that set it is closed by
    /// then. Asserted through the accessibility label rather than by pixel: the
    /// label is what a VoiceOver reader gets, and if it is right the dot is
    /// drawn.
    @MainActor
    func testArmingDeepResearchMarksThePlusButton() {
        let app = launch([])

        let plus = app.buttons["juno.mobile.chat-plus"]
        require(plus, app)
        XCTAssertEqual(plus.label, "Add")

        plus.tap()
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
    /// Asserts on the conversation card moving rather than on a sidebar row
    /// appearing: the drawer is always in the hierarchy, behind the card, so
    /// "the drawer exists" says nothing about whether it opened. The card is
    /// pushed, not covered — ChatGPT's drawer keeps a fifth of it in view as
    /// the way back — so the composer's "+" travels with it to the trailing
    /// side rather than leaving the screen.
    @MainActor
    func testSwipingFromTheLeadingEdgeStillOpensTheDrawer() {
        let app = launch([])

        let plus = app.buttons["juno.mobile.chat-plus"]
        require(plus, app)
        XCTAssertTrue(plus.isHittable, "The composer is not reachable to begin with.")
        let startX = plus.frame.minX
        let width = app.windows.firstMatch.frame.width

        app.coordinate(withNormalizedOffset: CGVector(dx: 0.004, dy: 0.5))
            .press(
                forDuration: 0.05,
                thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.75, dy: 0.5))
            )

        let revealed = expectation(
            for: NSPredicate { element, _ in
                guard let element = element as? XCUIElement else { return false }
                return element.frame.minX > startX + width * 0.5
            },
            evaluatedWith: plus
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

    /// The model is chosen from the Thinking panel, as on the Mac and the
    /// web: the dial opens the panel, and the model's name in it opens the
    /// catalogue. The "+" panel no longer carries a Model row.
    @MainActor
    func testTheThinkingPanelsModelNameOpensTheModelList() {
        let app = launch(["--juno-preview-model", "openai:gpt-5-6"])

        let chip = thinkingChip(app)
        require(chip, app)
        chip.tap()
        let models = app.descendants(matching: .any)["juno.mobile.thinking-models"].firstMatch
        require(models, app, timeout: 5)
        models.tap()
        require(app.descendants(matching: .any)["juno.mobile.model-list"].firstMatch, app, timeout: 5)
    }

    /// "+" carries what a message can take and the tools it can use — not the
    /// model, which lives on the Thinking panel.
    @MainActor
    func testThePlusPanelHasNoModelRow() {
        let app = launch([])

        let plus = app.buttons["juno.mobile.chat-plus"]
        require(plus, app)
        plus.tap()
        require(app.descendants(matching: .any)["juno.mobile.plus-panel"].firstMatch, app, timeout: 5)
        XCTAssertFalse(app.descendants(matching: .any)["juno.mobile.composer-model"].firstMatch.exists)
    }

    /// The primary action owns one slot. On an empty chat that slot is the
    /// website's voice affordance; once a draft or attachment exists it
    /// becomes Send. Both states must keep Apple's minimum hit rectangle.
    @MainActor
    func testThePrimaryActionHasARealTouchTarget() {
        let app = launch([])

        let send = app.buttons["juno.mobile.chat-send"]
        let voice = app.buttons["juno.mobile.chat-voice"]
        let action = send.waitForExistence(timeout: 5) ? send : voice
        require(action, app)
        XCTAssertGreaterThanOrEqual(action.frame.width, 32, "Primary action hit area collapsed to the glyph")
        XCTAssertGreaterThanOrEqual(action.frame.height, 32, "Primary action hit area collapsed to the glyph")
    }

    /// A model that cannot think has nothing to dial. The gauge stays in the
    /// row — the composer lost its model chip, so the gauge is the composer's
    /// one model control — and a tap on it offers the model list instead of a
    /// slider.
    @MainActor
    func testANonReasoningModelsDialOffersTheModelInsteadOfASlider() {
        let app = launch(["--juno-preview-model", "google:gemini-3-flash"])

        let chip = thinkingChip(app)
        require(chip, app)
        chip.tap()

        require(app.descendants(matching: .any)["juno.mobile.model-list"].firstMatch, app, timeout: 5)
        XCTAssertFalse(thinkingSlider(app).exists, "A model without levels offered a thinking slider.")
    }
}

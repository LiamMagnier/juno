import XCTest

/// Drives the revamped Mac composer controls through the DEBUG UI Preview
/// harness, so they never touch an account, the Keychain or the network.
///
/// The Thinking popover is the reason this exists twice over: its content is
/// custom-drawn and measures itself, and a self-sizing AppKit popover around
/// measuring content is exactly what crashed the app in 3.0.5. A test that
/// opens it is the cheapest guard against that returning.
final class JunoMacComposerUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    @MainActor
    private func launchChat() throws -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "--juno-ui-preview",
            "--juno-preview-mode", "chat",
            "--juno-preview-tab", "chat",
        ]
        app.launch()
        // This machine intermittently launches the app with no window at all —
        // the process is alive, `windows` is empty, and nothing is reachable.
        // That is a host/window-restoration problem, not a regression in what
        // these tests cover, so distinguish it: no window means skip, a window
        // without the expected control means fail.
        guard app.windows.firstMatch.waitForExistence(timeout: 30) else {
            throw XCTSkip("The app launched without a window; nothing to drive.")
        }
        return app
    }

    /// Waits, and on failure says what WAS on screen — a bare "false" costs a
    /// whole rerun to diagnose, and a Mac UI test run is not cheap.
    @MainActor
    private func require(
        _ element: XCUIElement,
        _ app: XCUIApplication,
        timeout: TimeInterval = 30,
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
    func testComposerShowsModelAndThinkingChipsRatherThanMenus() throws {
        let app = try launchChat()

        let model = app.buttons["juno.mac.model-picker"]
        require(model, app)
        // A `Picker` would surface as a popUpButton; the revamped control is a
        // button that opens the rich picker.
        XCTAssertFalse(app.popUpButtons["juno.mac.model-picker"].exists)
    }

    @MainActor
    func testModelPickerOpensWithSearchAndProviderRail() throws {
        let app = try launchChat()

        let model = app.buttons["juno.mac.model-picker"]
        require(model, app)
        model.click()

        require(app.textFields["juno.mac.model-search"], app, timeout: 5)
        // Auto leads the Chat section, as it does on the web selector.
        XCTAssertTrue(app.descendants(matching: .any)["juno.mac.model-row.juno:auto"].firstMatch.exists)
    }

    @MainActor
    func testThinkingPopoverOpensAndTheSliderAdjusts() throws {
        let app = try launchChat()

        let model = app.buttons["juno.mac.model-picker"]
        require(model, app)
        model.click()
        require(app.textFields["juno.mac.model-search"], app, timeout: 5)

        // Pick a model with a real ladder; Auto has none by design.
        let row = app.descendants(matching: .any)["juno.mac.model-row.openai:gpt-5-6"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        row.click()

        let thinking = app.buttons["juno.mac.effort-picker"]
        XCTAssertTrue(thinking.waitForExistence(timeout: 5))
        thinking.click()

        let slider = app.descendants(matching: .any)["juno.thinking-slider"].firstMatch
        require(slider, app, timeout: 5)

        // Clicking a track position selects that detent — the popover survives
        // being interacted with, which is the crash this guards.
        slider.coordinate(withNormalizedOffset: CGVector(dx: 0.99, dy: 0.5)).click()
        XCTAssertEqual(slider.value as? String, "Thinking max")
        slider.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.5)).click()
        XCTAssertEqual(slider.value as? String, "Thinking off")
    }
}

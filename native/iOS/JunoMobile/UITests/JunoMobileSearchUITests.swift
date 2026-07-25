import XCTest

/// Drives global search for real.
///
/// The reported defect was "search doesn't work", and it had two halves that only
/// a running app shows. The field was placed with
/// `.searchable(placement: .navigationBarDrawer(displayMode: .always))`, which
/// iOS 26 ignores — the system put it in the *bottom* toolbar, so the screen
/// appeared to have no search field at all. And matching was exact-token-or-prefix,
/// so a mid-word fragment returned nothing even when the field was found.
final class JunoMobileSearchUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--juno-ui-preview", "--juno-preview-tab", "search"]
        app.launch()
        return app
    }

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

    private func field(_ app: XCUIApplication) -> XCUIElement {
        app.textFields["juno.mobile.search-field"]
    }

    /// The field lives in the bottom inset, where the composer's does — thumb
    /// height on a phone this size. It must be genuinely on screen and hittable
    /// there, which is what `.searchable`'s own placement stopped guaranteeing.
    @MainActor
    func testTheSearchFieldIsVisibleAtTheBottom() {
        let app = launch()
        let search = field(app)
        require(search, app)
        XCTAssertTrue(search.isHittable, "The search field is present but not hittable.")

        let screen = app.windows.firstMatch.frame
        XCTAssertGreaterThan(
            search.frame.midY,
            screen.height * 0.5,
            """
            The search field is at y=\(search.frame.midY) of a \(screen.height)pt \
            screen — it is meant to sit in the bottom inset.
            """
        )
        XCTAssertLessThan(
            search.frame.maxY, screen.height,
            "The search field has been pushed off the bottom of the screen."
        )
    }

    /// Typing must actually return results. This is the end-to-end proof: the
    /// model is started, the corpus decrypts, and the index matches.
    @MainActor
    func testTypingReturnsResults() {
        let app = launch()
        let search = field(app)
        require(search, app)
        search.tap()
        search.typeText("quasar")

        let results = app.descendants(matching: .any)["juno.mobile.search-results"].firstMatch
        require(results, app, timeout: 15)
        XCTAssertTrue(
            app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'uasar'"))
                .firstMatch.exists,
            "Results appeared but none mention the query. On screen:\n\(app.debugDescription)"
        )
    }

    /// The retrieval fix: a fragment from the MIDDLE of a word has to match.
    @MainActor
    func testAMidWordFragmentReturnsResults() {
        let app = launch()
        let search = field(app)
        require(search, app)
        search.tap()
        search.typeText("uasar")

        require(
            app.descendants(matching: .any)["juno.mobile.search-results"].firstMatch,
            app,
            timeout: 15
        )
    }

    /// Clearing puts the screen back to its resting state rather than leaving a
    /// stale result list under an empty field.
    @MainActor
    func testClearingResetsTheScreen() {
        let app = launch()
        let search = field(app)
        require(search, app)
        search.tap()
        search.typeText("quasar")
        require(
            app.descendants(matching: .any)["juno.mobile.search-results"].firstMatch,
            app,
            timeout: 15
        )

        let clear = app.buttons["juno.mobile.search-clear"]
        require(clear, app, timeout: 5)
        // Asserted separately from the tap: the field sits in the bottom inset now,
        // so "the button exists" and "the button is reachable above the keyboard"
        // are different claims and only one of them is about clearing.
        XCTAssertTrue(
            clear.isHittable,
            "The clear button is on screen but not reachable — the keyboard is over it."
        )
        clear.tap()

        let gone = expectation(
            for: NSPredicate(format: "exists == false"),
            evaluatedWith: app.descendants(matching: .any)["juno.mobile.search-results"].firstMatch
        )
        XCTAssertEqual(
            XCTWaiter().wait(for: [gone], timeout: 5),
            .completed,
            "Clearing the query left the results on screen."
        )
    }
}

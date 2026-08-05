import XCTest

/// Drives the project and artifact detail screens, which are only reachable by
/// tapping through a list — so nothing about their rebuild is observable without
/// running the app.
///
/// Both screens were the last stock-SwiftUI holdouts: an `.insetGrouped` `List`
/// and a `.segmented` `Picker` over a coral text button. These tests pin the
/// pieces that replaced them, and — more importantly — pin the *reason*: a
/// project's instructions must not be able to push its conversations and files off
/// the screen again.
final class JunoMobileWorkspaceScreensUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    private func launch(tab: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--juno-ui-preview", "--juno-preview-tab", tab]
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

    // MARK: - Project detail

    /// Opens the first project. The fixture project carries real instructions, so
    /// the clamp and its toggle are both exercised.
    private func openFirstProject(_ app: XCUIApplication) {
        require(app.descendants(matching: .any)["juno.mobile.project-list"].firstMatch, app)
        let card = app.buttons.containing(
            NSPredicate(format: "label CONTAINS %@", "Astro research")
        ).firstMatch
        require(card, app)
        card.tap()
        require(app.descendants(matching: .any)["juno.mobile.project-instructions"].firstMatch, app)
    }

    @MainActor
    func testProjectDetailShowsInstructionsConversationsAndFiles() {
        let app = launch(tab: "projects")
        openFirstProject(app)

        // All three sections are on the screen at once — the whole point of
        // clamping the instructions rather than letting them run.
        for section in ["Instructions", "Conversations", "Files"] {
            XCTAssertTrue(
                app.staticTexts[section].exists,
                "\"\(section)\" is not on the project screen. On screen:\n\(app.debugDescription)"
            )
        }
    }

    /// The regression this screen exists to prevent: instructions long enough to
    /// bury everything else must arrive clamped, with the full text one tap away.
    @MainActor
    func testLongProjectInstructionsStartClampedAndCanBeExpanded() {
        let app = launch(tab: "projects")
        openFirstProject(app)

        let toggle = app.buttons["juno.mobile.clamped-toggle"]
        // No skip: the fixture instructions typeset to 405pt against a 145pt
        // clamp, so the control must be there. Skipping here is what hid the
        // measurement being broken through two earlier attempts.
        require(toggle, app, timeout: 10)

        let files = app.staticTexts["Files"]
        let filesBefore = files.frame.minY
        toggle.tap()

        // Expanding pushes the later sections DOWN — which is what proves the
        // clamp was really holding the text back rather than truncating it away.
        //
        // A block predicate, not `NSPredicate(format: "frame.origin.y > …")`.
        // `frame` crosses into KVC as an opaque `NSValue`, which answers to no
        // `origin` key, so the format-string version can never evaluate true —
        // it timed out here for a run while the screen underneath was expanding
        // by 259pt exactly as intended.
        let expanded = expectation(
            for: NSPredicate { element, _ in
                guard let element = element as? XCUIElement else { return false }
                return element.frame.minY > filesBefore
            },
            evaluatedWith: files
        )
        XCTAssertEqual(
            XCTWaiter().wait(for: [expanded], timeout: 5),
            .completed,
            "Show all did not reveal any more instruction text."
        )
    }

    /// Star and the menu share one Liquid Glass capsule, as the chat header's
    /// pair does — adjacency in the toolbar is what produces it, and only the
    /// laid-out frames can confirm it.
    @MainActor
    func testProjectHeaderPairsStarWithTheMenuInOneCapsule() {
        let app = launch(tab: "projects")
        openFirstProject(app)

        let star = app.buttons["juno.mobile.project-star"]
        let menu = app.buttons["juno.mobile.project-menu"]
        require(star, app, timeout: 5)
        require(menu, app, timeout: 5)

        XCTAssertLessThan(star.frame.maxX, menu.frame.minX + 1)
        XCTAssertLessThan(
            menu.frame.minX - star.frame.maxX, 24,
            "Star and the menu are too far apart to be sharing one capsule."
        )
        XCTAssertEqual(star.frame.midY, menu.frame.midY, accuracy: 2)
    }

    // MARK: - Artifact detail

    /// The fixture artifact is an HTML one, so it is a kind that *can* render —
    /// which is what puts the Preview/Source switch on screen.
    @MainActor
    func testArtifactDetailShowsTheViewSwitchAndItsMetaChips() {
        let app = launch(tab: "artifacts")
        require(app.descendants(matching: .any)["juno.mobile.artifact-list"].firstMatch, app)

        let card = app.buttons.containing(
            NSPredicate(format: "label CONTAINS %@", "Quasar brightness chart")
        ).firstMatch
        require(card, app)
        card.tap()

        require(app.buttons["juno.mobile.artifact-menu"], app, timeout: 10)

        // Preview/Source is our own switch now, not a `.segmented` Picker: it
        // reports as two selectable buttons inside one labelled container.
        require(
            app.descendants(matching: .any)["juno.mobile.artifact-view-mode"].firstMatch,
            app,
            timeout: 5
        )
        XCTAssertTrue(app.buttons["Preview"].exists, "The view switch lost its Preview option.")
        XCTAssertTrue(app.buttons["Source"].exists, "The view switch lost its Source option.")

        // The chips carry the facts the old header put in a coral text button and
        // a bare Picker: where it came from, what it is, and which version.
        XCTAssertTrue(
            app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "Quasar observations"))
                .firstMatch.exists
                || app.staticTexts["HTML"].exists,
            "The artifact header lost its metadata chips. On screen:\n\(app.debugDescription)"
        )

        // And the switch actually switches.
        app.buttons["Source"].tap()
        XCTAssertTrue(
            app.buttons["Source"].isSelected,
            "Tapping Source did not select it."
        )
    }
}

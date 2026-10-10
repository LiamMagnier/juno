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
        // The tile combines name, pin state and counts into one accessible
        // label ("Astro research, Pinned · 1 chat · …"), so match the label on
        // any element type.
        let card = app.descendants(matching: .any).matching(
            NSPredicate(format: "label BEGINSWITH %@", "Astro research,")
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
        for section in ["Instructions", "Chats", "Files"] {
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

        // The section's identifier ("juno.mobile.project-instructions") is
        // propagated over the toggle's own `juno.mobile.clamped-toggle`, so
        // the control is found by what it says.
        func toggle(_ label: String) -> XCUIElement {
            app.buttons.matching(
                NSPredicate(format: "label == %@", label)
            ).firstMatch
        }
        let showAll = toggle("Show all")
        // The page puts the cover, Folders, Chats and Files first and the
        // instructions below them, so scroll down to them. Bounded rather
        // than `while`: a page that stopped scrolling should fail this test,
        // not hang it.
        for _ in 0..<6 where !(showAll.exists && showAll.isHittable) {
            app.swipeUp()
        }
        // No skip: the fixture instructions typeset to 405pt against a 145pt
        // clamp, so the control must be there. Skipping here is what hid the
        // measurement being broken through two earlier attempts.
        require(showAll, app, timeout: 10)

        // The toggle sits under the text in the same card, so it is what an
        // expansion pushes down.
        let toggleBefore = showAll.frame.minY
        showAll.tap()

        // Expanding pushes the toggle — now "Show less" — DOWN, which is what
        // proves the clamp was really holding the text back rather than
        // truncating it away.
        //
        // A block predicate, not `NSPredicate(format: "frame.origin.y > …")`.
        // `frame` crosses into KVC as an opaque `NSValue`, which answers to no
        // `origin` key, so the format-string version can never evaluate true —
        // it timed out here for a run while the screen underneath was expanding
        // by 259pt exactly as intended.
        let expanded = expectation(
            for: NSPredicate { element, _ in
                guard let element = element as? XCUIElement, element.exists else { return false }
                return element.frame.minY > toggleBefore + 20
            },
            evaluatedWith: toggle("Show less")
        )
        XCTAssertEqual(
            XCTWaiter().wait(for: [expanded], timeout: 5),
            .completed,
            "Show all did not reveal any more instruction text."
        )
    }

    /// Pin and the menu share one Liquid Glass capsule, as the chat header's
    /// pair does — adjacency in the toolbar is what produces it, and only the
    /// laid-out frames can confirm it.
    @MainActor
    func testProjectHeaderPairsPinWithTheMenuInOneCapsule() {
        let app = launch(tab: "projects")
        openFirstProject(app)

        let pin = app.buttons["juno.mobile.project-pin"]
        let menu = app.buttons["juno.mobile.project-menu"]
        require(pin, app, timeout: 5)
        require(menu, app, timeout: 5)

        XCTAssertLessThan(pin.frame.maxX, menu.frame.minX + 1)
        XCTAssertLessThan(
            menu.frame.minX - pin.frame.maxX, 24,
            "Pin and the menu are too far apart to be sharing one capsule."
        )
        XCTAssertEqual(pin.frame.midY, menu.frame.midY, accuracy: 2)
    }

    // MARK: - Library

    /// The Library opens on the grid of previews, with the type filter and the
    /// List / Grid switch as controls on the page — and List is one tap away.
    @MainActor
    func testLibraryOpensAsAGridAndSwitchesToAList() {
        let app = launch(tab: "library")
        require(app.descendants(matching: .any)["juno.mobile.file-list"].firstMatch, app)
        require(app.descendants(matching: .any)["juno.mobile.library-filter"].firstMatch, app, timeout: 5)
        let list = app.buttons.matching(NSPredicate(format: "label == %@", "List")).firstMatch
        require(list, app, timeout: 5)
        list.tap()
        XCTAssertTrue(
            list.waitForExistence(timeout: 2) && list.isSelected,
            "List did not become the selected view. On screen:\n\(app.debugDescription)"
        )
        // Back to the default for the next run: the choice is remembered.
        app.buttons.matching(NSPredicate(format: "label == %@", "Grid")).firstMatch.tap()
    }

    /// A folder opens as its own page with the path above its name, from a
    /// tile on its project's page.
    @MainActor
    func testFolderOpensAsItsOwnPageWithBreadcrumbs() {
        let app = launch(tab: "projects")
        openFirstProject(app)
        let folder = app.descendants(matching: .any)["juno.mobile.project-folder-proj-1-obs"].firstMatch
        require(folder, app, timeout: 10)
        folder.tap()
        require(app.descendants(matching: .any)["juno.mobile.project-breadcrumbs"].firstMatch, app, timeout: 10)
    }

    // MARK: - Artifact detail

    /// The fixture artifact is an HTML one, so it is a kind that *can* render —
    /// which is what puts the Preview/Source switch on screen.
    @MainActor
    func testArtifactDetailShowsTheViewSwitchAndItsActions() {
        let app = launch(tab: "artifacts")
        require(app.descendants(matching: .any)["juno.mobile.artifact-list"].firstMatch, app)

        let card = app.buttons.containing(
            NSPredicate(format: "label CONTAINS %@", "Quasar brightness chart")
        ).firstMatch
        require(card, app)
        card.tap()

        // The artifact's menu, or the system's overflow "More" that folds it in
        // when Version and Share already fill a narrow bar.
        let menu = app.buttons["juno.mobile.artifact-menu"]
        let overflow = app.buttons["OverflowBarButtonItem"]
        XCTAssertTrue(
            menu.waitForExistence(timeout: 10) || overflow.waitForExistence(timeout: 2),
            "Neither the artifact menu nor the bar's overflow is on screen."
        )

        // Preview/Source is the system segmented control again (round 2): it
        // reports as two selectable buttons inside one identified container.
        require(
            app.descendants(matching: .any)["juno.mobile.artifact-view-mode"].firstMatch,
            app,
            timeout: 5
        )
        XCTAssertTrue(app.buttons["Preview"].exists, "The view switch lost its Preview option.")
        XCTAssertTrue(app.buttons["Source"].exists, "The view switch lost its Source option.")

        // The page states where it came from in its actions menu ("Open Chat")
        // and its kind in the navigation bar's secondary line on the sheet.
        XCTAssertTrue(
            menu.exists || overflow.exists,
            "The artifact page lost its actions menu. On screen:\n\(app.debugDescription)"
        )

        // And the switch actually switches.
        app.buttons["Source"].tap()
        XCTAssertTrue(
            app.buttons["Source"].isSelected,
            "Tapping Source did not select it."
        )
    }
}

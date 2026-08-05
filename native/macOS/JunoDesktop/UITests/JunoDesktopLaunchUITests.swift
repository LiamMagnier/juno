import XCTest

@MainActor
final class JunoDesktopLaunchUITests: XCTestCase {
    func testLaunchesToAnHonestAuthenticationSurface() {
        let app = XCUIApplication()
        app.launch()
        openMainWindowIfNeeded(in: app)

        XCTAssertTrue(
            app.buttons["Sign in to Juno"].waitForExistence(timeout: 12)
                || app.descendants(matching: .any)
                    .matching(NSPredicate(format: "label == %@", "Preparing Juno…"))
                    .firstMatch.exists
                || app.textFields["Message Juno"].exists
                || app.buttons["Account and settings"].exists
                || app.textFields["juno.code.launch-prompt"].exists
                || app.textFields["juno.code.composer.field"].exists
                || app.buttons["juno.code.add-project"].exists
        )
    }

    func testPreviewLaunchesIntoTheRealAuthenticatedChatShell() {
        let app = XCUIApplication()
        app.launchArguments = [
            "-ApplePersistenceIgnoreState", "YES",
            "--juno-ui-preview",
            "--juno-preview-scenario", "normal",
            "--juno-preview-size", "1240x800",
        ]
        app.launch()
        openMainWindowIfNeeded(in: app)

        XCTAssertTrue(app.buttons.matching(labelBeginsWith("New chat")).firstMatch
            .waitForExistence(timeout: 12))
        XCTAssertTrue(app.textFields["Message Juno"].exists)
        XCTAssertTrue(
            app.descendants(matching: .any)["juno.product-brand.chat"]
                .waitForExistence(timeout: 5)
        )
    }

    func testPreviewCanLaunchDirectlyIntoCode() {
        let app = XCUIApplication()
        app.launchArguments = [
            "-ApplePersistenceIgnoreState", "YES",
            "--juno-ui-preview",
            "--juno-preview-tab", "code",
            "--juno-preview-size", "1240x800",
        ]
        app.launch()
        openMainWindowIfNeeded(in: app)

        XCTAssertTrue(
            app.textFields["juno.code.launch-prompt"]
                .waitForExistence(timeout: 12)
        )
        // SwiftUI `Menu` is exposed as `XCUIElementTypeMenuButton` on macOS.
        XCTAssertTrue(app.menuButtons["juno.code.launch-target"].exists)
        XCTAssertTrue(app.menuButtons["juno.code.launch-contract"].exists)
        XCTAssertTrue(app.buttons["juno.code.launch-model"].exists)
        XCTAssertTrue(app.buttons["juno.code.composer.voice"].exists)
        XCTAssertTrue(app.buttons["juno.code.composer.dictate"].exists)
        XCTAssertTrue(
            app.descendants(matching: .any)["juno.product-brand.code"]
                .waitForExistence(timeout: 5)
        )
        XCTAssertTrue(app.buttons["juno.code.inspector.toggle"].exists)
        XCTAssertTrue(app.buttons["juno.code.console.toggle"].exists)
        XCTAssertTrue(app.buttons["juno.code.review.toggle"].exists)
    }

    func testCodeSidebarUsesTheNativeSourceListBelowTheToolbar() {
        let app = XCUIApplication()
        app.launchArguments = [
            "-ApplePersistenceIgnoreState", "YES",
            "--juno-ui-preview",
            "--juno-preview-tab", "code",
            "--juno-preview-size", "1240x800",
        ]
        app.launch()
        openMainWindowIfNeeded(in: app)

        let productSwitch = app.descendants(matching: .any)["Juno product"]
        XCTAssertTrue(productSwitch.waitForExistence(timeout: 12))
        XCTAssertTrue(
            app.descendants(matching: .any)["juno.product-brand.code"].exists
        )
        let addProject = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label == %@", "Add project…"))
            .firstMatch
        XCTAssertTrue(addProject.exists)
        XCTAssertLessThan(
            productSwitch.frame.minX,
            addProject.frame.maxX,
            """
            The Chat / Code switch belongs at the top of the sidebar, over the \
            column it switches — not in the detail toolbar.
            """
        )
        XCTAssertFalse(app.buttons["juno.code.new-chat"].exists)
        XCTAssertFalse(app.buttons["juno.code.sidebar-search"].exists)

        let projectMenu = app.menuButtons["juno.code.project-menu.ws-preview-juno"]
        XCTAssertTrue(projectMenu.exists)
        projectMenu.click()

        let deleteProject = app.menuItems["Delete Project…"]
        XCTAssertTrue(deleteProject.waitForExistence(timeout: 3))
        deleteProject.click()

        // SwiftUI presents macOS alerts as document-modal sheets.
        let confirmation = app.sheets.firstMatch
        XCTAssertTrue(confirmation.waitForExistence(timeout: 3))
        XCTAssertTrue(
            confirmation.staticTexts
                .matching(NSPredicate(format: "value CONTAINS[c] %@", "files stay"))
                .firstMatch.exists
        )
        confirmation.buttons["Cancel"].click()

    }

    func testCodeLocalSessionAndInspectorStayInteractive() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--juno-ui-preview",
            "--juno-preview-tab", "code",
            "--juno-preview-code-session",
            "--juno-preview-inspector",
            "--juno-preview-size", "1240x800",
        ]
        app.launch()
        openMainWindowIfNeeded(in: app)

        XCTAssertTrue(app.textFields["juno.code.composer.field"].waitForExistence(timeout: 12))
        XCTAssertTrue(app.buttons["juno.code.composer.voice"].exists)
        XCTAssertTrue(app.buttons["juno.code.composer.dictate"].exists)
        XCTAssertTrue(app.menuButtons["juno.code.session-tools"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["juno.code.inspector.toggle"].exists)
        XCTAssertTrue(app.buttons["juno.code.console.toggle"].exists)
        XCTAssertTrue(app.buttons["juno.code.review.toggle"].exists)
        XCTAssertTrue(
            app.descendants(matching: .any)["juno.code.inspector.pane"]
                .waitForExistence(timeout: 5)
        )
        XCTAssertTrue(
            app.descendants(matching: .any)["juno.code.goal.bar"]
                .waitForExistence(timeout: 5)
        )
        let goalDetails = app.buttons["juno.code.goal.details"]
        XCTAssertTrue(goalDetails.exists)
        goalDetails.click()
        XCTAssertTrue(
            app.descendants(matching: .any)["juno.code.goal.popover"]
                .waitForExistence(timeout: 5)
        )
        XCTAssertTrue(app.descendants(matching: .any)["juno.code.changes"].exists)
        XCTAssertTrue(app.exists)
    }

    func testProjectsOpenOnTheIndexAndCanStartAScopedChatInsideAProject() {
        let app = XCUIApplication()
        app.launchArguments = [
            "-ApplePersistenceIgnoreState", "YES",
            "--juno-ui-preview",
            "--juno-preview-tab", "projects",
            "--juno-preview-size", "1240x800",
        ]
        app.launch()
        openMainWindowIfNeeded(in: app)

        // The index, not a project: the destination used to auto-open whichever
        // project sorted first, which put the reader inside one project with no
        // route back to the list.
        assertShowingProjectIndex(app)

        openProject(app)
        XCTAssertTrue(app.buttons["All projects"].exists)
        XCTAssertTrue(app.menuButtons["Project detail actions"].exists)

        let composer = app.textFields["Message Juno"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["juno.desktop.chat-model"].exists)
        XCTAssertTrue(app.buttons["New chat in project"].exists)

        composer.click()
        composer.typeText("Outline the next observation")
        let send = app.buttons["Send message"]
        XCTAssertTrue(send.waitForExistence(timeout: 5))
        send.click()
        XCTAssertTrue(
            app.textFields["Message Juno"].waitForExistence(timeout: 8),
            "Sending from a project must open the real project-scoped transcript."
        )
    }

    /// The bug this screen shipped with: the index was reachable only from
    /// *inside* a project, and the boolean that got you there was reset by the
    /// destination switch — so leaving Projects and coming back always landed on
    /// a project again.
    func testProjectsReturnToTheIndexAfterVisitingAProjectAndLeaving() {
        let app = XCUIApplication()
        app.launchArguments = [
            "-ApplePersistenceIgnoreState", "YES",
            "--juno-ui-preview",
            "--juno-preview-tab", "projects",
            "--juno-preview-size", "1240x800",
        ]
        app.launch()
        openMainWindowIfNeeded(in: app)

        assertShowingProjectIndex(app)

        openProject(app)
        let backToIndex = app.buttons["All projects"]
        XCTAssertTrue(backToIndex.waitForExistence(timeout: 5))
        backToIndex.click()
        assertShowingProjectIndex(app)

        // Into a project, then out of Projects entirely, then back.
        openProject(app)
        XCTAssertTrue(app.buttons["All projects"].waitForExistence(timeout: 5))

        clickSidebarDestination("Library", in: app)
        XCTAssertTrue(
            app.buttons["All projects"].waitForNonExistence(timeout: 5),
            "Leaving Projects must leave the project detail behind."
        )

        clickSidebarDestination("Projects", in: app)
        assertShowingProjectIndex(app)
    }

    /// The index is showing, and no project detail is.
    ///
    /// Asserted on the cards and the search field rather than on the container's
    /// identifier: a plain SwiftUI stack does not reliably surface as an element,
    /// and a card that exists only on the index is the honest proof of where we are.
    private func assertShowingProjectIndex(
        _ app: XCUIApplication,
        line: UInt = #line
    ) {
        XCTAssertTrue(
            app.buttons["juno.project-card.proj-1"].waitForExistence(timeout: 12),
            "Clicking Projects must land on the index of every project.",
            line: line
        )
        XCTAssertTrue(app.textFields["Projects search"].exists, line: line)
        XCTAssertFalse(
            app.buttons["All projects"].exists,
            "The index is the root — it has nothing to go back to.",
            line: line
        )
        XCTAssertFalse(app.buttons["New chat in project"].exists, line: line)
    }

    /// Opens the seeded "Astro research" project from the index.
    private func openProject(_ app: XCUIApplication, line: UInt = #line) {
        let card = app.buttons["juno.project-card.proj-1"]
        XCTAssertTrue(card.waitForExistence(timeout: 5), line: line)
        card.click()
        XCTAssertTrue(
            app.buttons["New chat in project"].waitForExistence(timeout: 5),
            "A card must open that project's own page.",
            line: line
        )
    }

    /// Clicks a destination row in the window's navigation column.
    ///
    /// Matched by label rather than by identifier because the sidebar's rows are
    /// plain `Label`s. Each call site picks a label that is unambiguous *while the
    /// current screen is showing*, so the row is the only thing carrying it.
    private func clickSidebarDestination(
        _ label: String,
        in app: XCUIApplication,
        line: UInt = #line
    ) {
        let row = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label == %@", label))
            .firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 5), "No sidebar row for \(label)", line: line)
        row.click()
    }

    func testArtifactsOpenAsAPreviewLibraryThenNavigateToADocument() {
        let app = XCUIApplication()
        app.launchArguments = [
            "-ApplePersistenceIgnoreState", "YES",
            "--juno-ui-preview",
            "--juno-preview-tab", "artifacts",
            "--juno-preview-size", "1240x800",
        ]
        app.launch()
        openMainWindowIfNeeded(in: app)

        XCTAssertTrue(
            app.descendants(matching: .any)["juno.artifact-library-grid"]
                .waitForExistence(timeout: 12)
        )
        XCTAssertFalse(app.descendants(matching: .any)["juno.artifact-document"].exists)

        let artifact = app.buttons["juno.artifact-card.art-1"]
        XCTAssertTrue(artifact.exists)
        artifact.click()

        XCTAssertTrue(
            app.descendants(matching: .any)["juno.artifact-document"]
                .waitForExistence(timeout: 5)
        )
        XCTAssertTrue(app.descendants(matching: .any)["juno.artifact-view-mode"].exists)
        XCTAssertTrue(app.menuButtons["juno.artifact-actions"].exists)
        XCTAssertTrue(app.buttons["juno.artifact-history"].exists)

        app.buttons["juno.artifact-library"].click()
        XCTAssertTrue(
            app.descendants(matching: .any)["juno.artifact-library-grid"]
                .waitForExistence(timeout: 5)
        )
    }

    func testChatModelSelectorExposesProviderCatalog() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--juno-ui-preview",
            "--juno-preview-model-selector",
            "--juno-preview-size", "1240x800",
        ]
        app.launch()
        openMainWindowIfNeeded(in: app)

        XCTAssertTrue(app.textFields.firstMatch.waitForExistence(timeout: 12))
        XCTAssertTrue(app.buttons.matching(labelBeginsWith("Anthropic")).firstMatch.exists)
        XCTAssertTrue(app.buttons.matching(labelBeginsWith("OpenAI")).firstMatch.exists)
        XCTAssertTrue(app.buttons.matching(labelBeginsWith("Google")).firstMatch.exists)
        XCTAssertTrue(
            app.buttons.matching(labelContains("Claude Opus 4.8")).firstMatch.exists
        )
    }

    private func labelBeginsWith(_ value: String) -> NSPredicate {
        NSPredicate(format: "label BEGINSWITH %@", value)
    }

    private func labelContains(_ value: String) -> NSPredicate {
        NSPredicate(format: "label CONTAINS %@", value)
    }

    /// macOS can legitimately restore an app with no windows after its last
    /// window was closed. Juno keeps the native ⌘N recovery command available in
    /// that state; the UI test exercises the same path a person would.
    private func openMainWindowIfNeeded(in app: XCUIApplication) {
        guard !app.windows.firstMatch.waitForExistence(timeout: 2) else { return }
        app.typeKey("n", modifierFlags: [.command])
        XCTAssertTrue(app.windows.firstMatch.waitForExistence(timeout: 5))
    }
}

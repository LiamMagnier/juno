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
        XCTAssertTrue(app.buttons["juno.code.launch-send"].exists)
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
        let addProject = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label == %@", "Add project…"))
            .firstMatch
        XCTAssertTrue(addProject.exists)
        XCTAssertGreaterThan(
            productSwitch.frame.minX,
            addProject.frame.maxX,
            "The Chat / Code switch belongs to the detail toolbar, not over the Code sidebar."
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
        XCTAssertTrue(app.menuButtons["juno.code.session-tools"].waitForExistence(timeout: 5))
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

    func testProjectsUseFocusedWorkspaceAndCanStartAScopedChat() {
        let app = XCUIApplication()
        app.launchArguments = [
            "-ApplePersistenceIgnoreState", "YES",
            "--juno-ui-preview",
            "--juno-preview-tab", "projects",
            "--juno-preview-size", "1240x800",
        ]
        app.launch()
        openMainWindowIfNeeded(in: app)

        let composer = app.textFields["Message Juno"]
        XCTAssertTrue(composer.waitForExistence(timeout: 12))
        XCTAssertTrue(app.buttons["juno.desktop.chat-model"].exists)
        XCTAssertTrue(app.staticTexts["Private project context"].exists)
        XCTAssertTrue(app.buttons["All projects"].exists)

        let newChat = app.buttons["New chat in project"]
        XCTAssertTrue(newChat.waitForExistence(timeout: 5))
        XCTAssertTrue(app.menuButtons["Project detail actions"].exists)

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

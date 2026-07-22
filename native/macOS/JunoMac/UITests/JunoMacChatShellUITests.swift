import XCTest

/// Structural tests for the authenticated shell, driven through the DEBUG UI
/// Preview harness so they never touch an account, the Keychain, the network or
/// production data.
///
/// These assert the *product architecture* the shell is supposed to have — Chat
/// is the default destination, the sidebar is the single source list, the
/// inspector is opt-in — rather than pixel positions, so they keep their value
/// across visual revisions.
final class JunoMacChatShellUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    @MainActor
    private func launchPreview(
        scenario: String = "normal",
        tab: String = "chat",
        dark: Bool = false
    ) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "--juno-ui-preview",
            "--juno-preview-scenario", scenario,
            "--juno-preview-tab", tab,
        ]
        if dark { app.launchArguments.append("--juno-preview-dark") }
        app.launch()
        return app
    }

    /// Captures the window for visual review. Screenshots are attached to the
    /// result bundle rather than written to the repository, so a QA pass leaves
    /// no files behind to be committed by accident.
    @MainActor
    private func attachScreenshot(_ app: XCUIApplication, named name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    @MainActor
    func testChatIsTheDefaultDestinationAfterAuthentication() {
        let app = launchPreview()
        // The chat surface must be on screen without any navigation: this is
        // the regression that made the product open on Juno Code.
        XCTAssertTrue(
            app.descendants(matching: .any)["juno.mac.conversation-detail"]
                .waitForExistence(timeout: 20),
            "Chat must be the destination the authenticated shell opens on"
        )
        attachScreenshot(app, named: "chat-default-light")
    }

    @MainActor
    func testSidebarExposesEveryProductDestinationAndNewChat() {
        let app = launchPreview()
        let sidebar = app.descendants(matching: .any)["juno.mac.sidebar"]
        XCTAssertTrue(sidebar.waitForExistence(timeout: 20))

        XCTAssertTrue(
            app.descendants(matching: .any)["juno.mac.sidebar.new-chat"].exists,
            "New Chat must be reachable from the sidebar"
        )
        for destination in ["search", "projects", "library", "artifacts", "code"] {
            XCTAssertTrue(
                app.descendants(matching: .any)["juno.mac.sidebar.\(destination)"].exists,
                "\(destination) must be a primary sidebar destination"
            )
        }
        XCTAssertTrue(
            app.descendants(matching: .any)["juno.mac.sidebar.settings"].exists,
            "Settings must be pinned in the sidebar footer"
        )
        XCTAssertTrue(
            app.descendants(matching: .any)["juno.mac.sync-status"].exists,
            "Synchronization state must be visible in the shell"
        )
        attachScreenshot(app, named: "sidebar")
    }

    @MainActor
    func testComposerAndItsControlsArePresent() {
        let app = launchPreview()
        XCTAssertTrue(
            app.descendants(matching: .any)["juno.mac.chat-composer"]
                .waitForExistence(timeout: 20),
            "The composer must be reachable without scrolling or navigation"
        )
        XCTAssertTrue(app.descendants(matching: .any)["juno.mac.chat-send"].exists)
        attachScreenshot(app, named: "composer")
    }

    @MainActor
    func testInspectorIsClosedByDefaultAndOpensFromTheToolbar() {
        let app = launchPreview()
        let toggle = app.descendants(matching: .any)["juno.mac.inspector-toggle"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 20))
        // Opt-in: the inspector must not steal width from the transcript until
        // the reader asks for it.
        XCTAssertFalse(
            app.descendants(matching: .any)["juno.mac.chat-inspector"].exists,
            "The inspector must start closed"
        )
        toggle.click()
        XCTAssertTrue(
            app.descendants(matching: .any)["juno.mac.chat-inspector"]
                .waitForExistence(timeout: 5),
            "The toolbar toggle must open the inspector"
        )
        attachScreenshot(app, named: "inspector-open")
    }

    @MainActor
    func testDarkAppearanceRenders() {
        let app = launchPreview(dark: true)
        XCTAssertTrue(
            app.descendants(matching: .any)["juno.mac.conversation-detail"]
                .waitForExistence(timeout: 20)
        )
        attachScreenshot(app, named: "chat-default-dark")
    }

    @MainActor
    func testEmptyStateRendersWithoutAConversation() {
        let app = launchPreview(scenario: "empty")
        // Either the empty transcript or the no-selection state is acceptable;
        // what must never happen is a blank window.
        let detail = app.descendants(matching: .any)["juno.mac.conversation-detail"]
        let sidebar = app.descendants(matching: .any)["juno.mac.sidebar"]
        XCTAssertTrue(
            sidebar.waitForExistence(timeout: 20) || detail.exists,
            "The empty scenario must still render the shell"
        )
        attachScreenshot(app, named: "chat-empty")
    }
}

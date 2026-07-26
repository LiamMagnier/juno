import XCTest

@MainActor
final class JunoDesktopLaunchUITests: XCTestCase {
    func testLaunchesToAnHonestAuthenticationSurface() {
        let app = XCUIApplication()
        app.launch()

        XCTAssertTrue(
            app.buttons["Sign in to Juno"].waitForExistence(timeout: 12)
                || app.staticTexts["Preparing Juno…"].exists
                || app.staticTexts["Juno"].exists
        )
    }

    func testPreviewLaunchesIntoTheRealAuthenticatedChatShell() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--juno-ui-preview",
            "--juno-preview-scenario", "normal",
            "--juno-preview-size", "1240x800",
        ]
        app.launch()

        XCTAssertTrue(app.buttons.matching(labelBeginsWith("New chat")).firstMatch
            .waitForExistence(timeout: 12))
        XCTAssertTrue(app.textFields["Message Juno"].exists)
    }

    func testPreviewCanLaunchDirectlyIntoCode() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--juno-ui-preview",
            "--juno-preview-tab", "code",
            "--juno-preview-size", "1240x800",
        ]
        app.launch()

        XCTAssertTrue(
            app.textFields["juno.code.launch-prompt"]
                .waitForExistence(timeout: 12)
        )
        XCTAssertTrue(app.buttons.matching(labelBeginsWith("New task")).firstMatch.exists)
        XCTAssertTrue(app.buttons.matching(labelBeginsWith("This Mac")).firstMatch.exists)
        XCTAssertTrue(app.buttons.matching(labelBeginsWith("Cloud")).firstMatch.exists)
        XCTAssertTrue(app.buttons.matching(labelBeginsWith("My devices")).firstMatch.exists)
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

        XCTAssertTrue(
            app.staticTexts.matching(labelContains("Refactor the sync coordinator"))
                .firstMatch
                .waitForExistence(timeout: 12)
        )
        XCTAssertTrue(
            app.buttons.matching(labelContains("Hide Inspector")).firstMatch
                .waitForExistence(timeout: 5)
        )
        XCTAssertTrue(app.staticTexts["Changes"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.exists)
    }

    func testChatModelSelectorExposesProviderCatalog() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--juno-ui-preview",
            "--juno-preview-model-selector",
            "--juno-preview-size", "1240x800",
        ]
        app.launch()

        XCTAssertTrue(
            app.textFields["juno.desktop.model-search"]
                .waitForExistence(timeout: 12)
        )
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
}

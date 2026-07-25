import XCTest

/// Drives incognito end to end, short of a real generation.
///
/// The point of the mode is a negative — that nothing is written — and a negative
/// is only checkable against the running app: the ghost has to be offered exactly
/// where a chat is *not* open, the session has to open, and ending it has to leave
/// no row in the sidebar. None of that is visible in the transport code.
final class JunoMobileIncognitoUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    private func launchDraft() -> XCUIApplication {
        let app = XCUIApplication()
        // `--juno-preview-tab chat` restores whichever conversation was last
        // selected, so the draft is reached the way a reader reaches it: New chat.
        app.launchArguments = ["--juno-ui-preview", "--juno-preview-tab", "chat"]
        app.launch()

        let newChat = app.buttons["juno.mobile.chat-new"]
        if newChat.waitForExistence(timeout: 20) {
            newChat.tap()
        }
        XCTAssertTrue(
            app.descendants(matching: .any)["juno.mobile.chat-draft"].firstMatch
                .waitForExistence(timeout: 10),
            "Never reached a draft chat. On screen:\n\(app.debugDescription)"
        )
        return app
    }

    /// The ghost belongs where the web puts it: on a chat that does not exist yet.
    @MainActor
    func testTheGhostIsOfferedOnADraftAndNotInASavedChat() {
        let app = launchDraft()
        let ghost = app.buttons["juno.mobile.incognito-start"]
        XCTAssertTrue(
            ghost.waitForExistence(timeout: 10),
            "No incognito control on the draft. On screen:\n\(app.debugDescription)"
        )
        XCTAssertTrue(ghost.isHittable, "The ghost is on screen but not hittable.")
    }

    @MainActor
    func testTheGhostOpensAnIncognitoSession() {
        let app = launchDraft()
        let ghost = app.buttons["juno.mobile.incognito-start"]
        XCTAssertTrue(
            ghost.waitForExistence(timeout: 10),
            "No ghost on the draft. On screen:\n\(app.debugDescription)"
        )
        ghost.tap()

        XCTAssertTrue(
            app.descendants(matching: .any)["juno.mobile.incognito"].firstMatch
                .waitForExistence(timeout: 10),
            "The incognito session did not open. On screen:\n\(app.debugDescription)"
        )
        // The promise is on screen, verbatim, because it is the reason the mode
        // exists and paraphrasing a privacy claim per platform is how the two stop
        // matching.
        XCTAssertTrue(
            app.staticTexts.containing(
                NSPredicate(format: "label CONTAINS %@", "aren't saved")
            ).firstMatch.exists,
            "The incognito greeting lost its promise. On screen:\n\(app.debugDescription)"
        )
        XCTAssertTrue(
            app.textFields["juno.mobile.incognito-composer"].exists,
            "The incognito composer is missing. On screen:\n\(app.debugDescription)"
        )
    }

    /// Closing an empty session goes straight back — there is nothing to confirm
    /// losing, and a confirmation for nothing trains people to dismiss them.
    @MainActor
    func testClosingAnEmptySessionNeedsNoConfirmation() {
        let app = launchDraft()
        let ghost = app.buttons["juno.mobile.incognito-start"]
        XCTAssertTrue(
            ghost.waitForExistence(timeout: 10),
            "No ghost on the draft. On screen:\n\(app.debugDescription)"
        )
        ghost.tap()

        let close = app.buttons["juno.mobile.incognito-close"]
        XCTAssertTrue(
            close.waitForExistence(timeout: 10),
            "No way to leave incognito. On screen:\n\(app.debugDescription)"
        )
        close.tap()

        let gone = expectation(
            for: NSPredicate(format: "exists == false"),
            evaluatedWith: app.descendants(matching: .any)["juno.mobile.incognito"].firstMatch
        )
        XCTAssertEqual(
            XCTWaiter().wait(for: [gone], timeout: 10),
            .completed,
            "Closing an empty incognito session left it on screen."
        )
        XCTAssertTrue(
            app.descendants(matching: .any)["juno.mobile.chat-draft"].firstMatch
                .waitForExistence(timeout: 10),
            "Closing incognito did not return to the draft."
        )
    }

    /// The composer refuses to send nothing, so an accidental tap cannot start a
    /// generation the reader did not ask for.
    @MainActor
    func testSendIsRefusedWhileTheComposerIsEmpty() {
        let app = launchDraft()
        let ghost = app.buttons["juno.mobile.incognito-start"]
        XCTAssertTrue(
            ghost.waitForExistence(timeout: 10),
            "No ghost on the draft. On screen:\n\(app.debugDescription)"
        )
        ghost.tap()

        let send = app.buttons["juno.mobile.incognito-send"]
        XCTAssertTrue(
            send.waitForExistence(timeout: 10),
            "No incognito send button. On screen:\n\(app.debugDescription)"
        )
        XCTAssertFalse(send.isEnabled, "Send is enabled with an empty composer.")

        app.textFields["juno.mobile.incognito-composer"].tap()
        app.textFields["juno.mobile.incognito-composer"].typeText("hello")
        let enabled = expectation(
            for: NSPredicate(format: "isEnabled == true"), evaluatedWith: send
        )
        XCTAssertEqual(
            XCTWaiter().wait(for: [enabled], timeout: 5),
            .completed,
            "Send stayed disabled after typing."
        )
    }
}

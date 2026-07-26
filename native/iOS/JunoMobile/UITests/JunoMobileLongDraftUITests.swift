import XCTest

/// The composer's answer to a very long draft: offer to send it as a file.
///
/// The threshold itself is unit-tested over `NativePromptLimits`. What only a
/// running app can show is that the offer appears at all, and that taking it
/// actually moves the draft out of the field and into an attachment — the step
/// that used to leave the composer with an empty prompt and a dead Send button.
final class JunoMobileLongDraftUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "--juno-ui-preview",
            "--juno-preview-tab", "chat",
        ]
        app.launch()
        return app
    }

    @MainActor
    func testALongDraftIsOfferedAsAFile() {
        let app = launch()
        let composer = app.descendants(matching: .any)["juno.mobile.chat-composer"].firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 20), app.debugDescription)
        composer.tap()

        // Over the threshold by *lines* rather than by characters. Both count —
        // `isLongDraft` is `> 1,500 characters || > 30 lines` — and this one is
        // 62 keystrokes instead of 1,501: XCUITest types through the keyboard,
        // one key at a time, so the character route is minutes of test time to
        // prove the same thing.
        composer.typeText(String(repeating: "a\n", count: 31))

        let attach = app.buttons["juno.mobile.chat-attach-draft"].firstMatch
        XCTAssertTrue(
            attach.waitForExistence(timeout: 10),
            "No attach-as-file offer. On screen:\n\(app.debugDescription)"
        )

        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "attach-as-file-offer"
        attachment.lifetime = .keepAlways
        add(attachment)

        attach.tap()

        // The draft leaves the field and becomes a staged file.
        XCTAssertTrue(
            app.descendants(matching: .any)["juno.mobile.composer-attachments"]
                .firstMatch.waitForExistence(timeout: 10),
            "The draft did not become an attachment. On screen:\n\(app.debugDescription)"
        )
        XCTAssertFalse(attach.exists, "The offer outlived the draft it was offering")
    }
}

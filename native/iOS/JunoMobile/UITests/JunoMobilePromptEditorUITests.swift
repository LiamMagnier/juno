import XCTest

/// The full-screen editor for a long prompt.
///
/// `JunoMobilePromptEditorOffer` is unit-tested; what only the running app
/// can show is that the expand control appears once the field is at its cap,
/// that it opens the draft full screen with the same text, and that Done
/// brings the text back to the composer.
final class JunoMobilePromptEditorUITests: XCTestCase {
  override func setUpWithError() throws {
    continueAfterFailure = false
  }

  @MainActor
  func testALongPromptOpensFullScreenAndComesBack() {
    let app = XCUIApplication()
    app.launchArguments = ["--juno-ui-preview", "--juno-preview-tab", "chat"]
    app.launch()

    let composer = app.descendants(matching: .any)["juno.mobile.chat-composer"].firstMatch
    XCTAssertTrue(composer.waitForExistence(timeout: 20), app.debugDescription)
    composer.tap()

    let expand = app.buttons["juno.mobile.prompt-editor.open"].firstMatch
    XCTAssertFalse(expand.exists, "Offered before the field reached its cap")

    // Six written lines reach the cap without waiting on wrapping.
    composer.typeText((1...6).map { "Line \($0)" }.joined(separator: "\n"))
    XCTAssertTrue(expand.waitForExistence(timeout: 10), "No expand control. On screen:\n\(app.debugDescription)")
    expand.tap()

    let editor = app.textViews["juno.mobile.prompt-editor"].firstMatch
    XCTAssertTrue(editor.waitForExistence(timeout: 10), "The editor did not open. On screen:\n\(app.debugDescription)")
    XCTAssertTrue((editor.value as? String)?.contains("Line 6") == true, "The editor lost the draft")

    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = "prompt-editor"
    attachment.lifetime = .keepAlways
    add(attachment)

    editor.typeText("\nAdded full screen")
    app.buttons["juno.mobile.prompt-editor.done"].firstMatch.tap()

    XCTAssertTrue(editor.waitForNonExistence(timeout: 10), "Done did not close the editor")
    XCTAssertTrue((composer.value as? String)?.contains("Added full screen") == true, "The edit did not come back")
  }
}

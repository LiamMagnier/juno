import XCTest

/// The shell's keyboard shortcuts, driven through a hardware-keyboard event.
///
/// The commands live in the scene's menu bar and read the shell's actions
/// through a focused scene value, so the only proof they reach the shell is a
/// key press in a running app.
final class JunoMobileKeyboardUITests: XCTestCase {
  override func setUpWithError() throws {
    continueAfterFailure = false
  }

  private func launchConversation() -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["--juno-ui-preview", "--juno-preview-tab", "chat"]
    app.launch()
    XCTAssertTrue(
      app.descendants(matching: .any)["juno.mobile.conversation-detail"].firstMatch
        .waitForExistence(timeout: 20),
      "The fixture conversation did not open. On screen:\n\(app.debugDescription)"
    )
    return app
  }

  @MainActor
  func testCommandNStartsANewChat() {
    let app = launchConversation()
    app.typeKey("n", modifierFlags: .command)
    XCTAssertTrue(
      app.descendants(matching: .any)["juno.mobile.chat-draft"].firstMatch
        .waitForExistence(timeout: 10),
      "Command-N did not open a draft. On screen:\n\(app.debugDescription)"
    )
  }

  @MainActor
  func testShiftCommandNStartsAnIncognitoChat() {
    let app = launchConversation()
    app.typeKey("n", modifierFlags: [.command, .shift])
    XCTAssertTrue(
      app.buttons["juno.mobile.incognito"].waitForExistence(timeout: 10),
      "Shift-Command-N did not open incognito. On screen:\n\(app.debugDescription)"
    )
    // The not-saved promise is the private chat's intro (round 2 folded the
    // separate note into it).
    XCTAssertTrue(
      app.descendants(matching: .any)["juno.mobile.incognito-intro"].firstMatch.exists,
      "Incognito opened without its not-saved note."
    )
  }
}

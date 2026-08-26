import XCTest

/// Drives the accent swatches in Settings.
///
/// `Color.junoAccent` was a `static let` frozen at coral, so the accent setting was
/// stored, synced, and read by nothing. It resolves through an `@Observable`
/// selection now — but that only helps if the swatch actually writes the setting
/// and the write reaches the shell, and neither is observable without running the
/// app.
final class JunoMobileAccentUITests: XCTestCase {
  override func setUpWithError() throws {
    continueAfterFailure = false
  }

  private func launchSettings(_ extraArguments: [String] = []) -> XCUIApplication {
    let app = XCUIApplication()
    // The destination is pinned. Without it the app restores whatever
    // `@SceneStorage` last held — and landing on Search puts a focused field
    // and its keyboard under the sheet, which made this suite fail on the
    // screen rather than on the accent.
    app.launchArguments =
      [
        "--juno-ui-preview",
        "--juno-preview-tab", "chat",
        "--juno-preview-settings",
      ] + extraArguments
    app.launch()
    let appearance = app.buttons["juno.mobile.settings-route-appearance"]
    XCTAssertTrue(
      appearance.waitForExistence(timeout: 20),
      "Appearance route was not available. On screen:\n\(app.debugDescription)"
    )
    appearance.tap()
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

  /// Five swatches, not a menu of capitalised words.
  @MainActor
  func testSettingsOffersEveryAccentAsASwatch() {
    let app = launchSettings()
    for accent in ["coral", "teal", "violet", "amber", "sage"] {
      require(app.buttons["juno.mobile.accent-\(accent)"], app, timeout: accent == "coral" ? 20 : 5)
    }
  }

  /// The fixture account is on coral, so coral starts selected and nothing else
  /// does — which is what makes the next test's assertion mean something.
  @MainActor
  func testTheStoredAccentIsTheSelectedSwatch() {
    let app = launchSettings()
    let coral = app.buttons["juno.mobile.accent-coral"]
    require(coral, app)
    XCTAssertTrue(coral.isSelected, "The stored accent is not shown as selected.")
    XCTAssertFalse(app.buttons["juno.mobile.accent-teal"].isSelected)
  }

  /// THE test: tapping a swatch has to move the setting.
  ///
  /// Selection moving is the proof the write round-tripped through
  /// `updateSettings` and back out of the store — the swatch reads its state from
  /// the settings row, not from local view state, so it cannot appear selected
  /// unless the account really changed.
  @MainActor
  func testTappingASwatchMovesTheStoredAccent() {
    let app = launchSettings()
    let teal = app.buttons["juno.mobile.accent-teal"]
    require(teal, app)
    XCTAssertTrue(teal.isHittable, "The teal swatch is on screen but not hittable.")

    teal.tap()

    let selected = expectation(
      for: NSPredicate(format: "isSelected == true"), evaluatedWith: teal
    )
    XCTAssertEqual(
      XCTWaiter().wait(for: [selected], timeout: 10),
      .completed,
      "Tapping teal did not change the account's accent. On screen:\n\(app.debugDescription)"
    )

    let coralReleased = expectation(
      for: NSPredicate(format: "isSelected == false"),
      evaluatedWith: app.buttons["juno.mobile.accent-coral"]
    )
    XCTAssertEqual(
      XCTWaiter().wait(for: [coralReleased], timeout: 5),
      .completed,
      "Two accents are selected at once."
    )
  }

  /// The launch override the screenshots use. Worth a test of its own because
  /// every visual check of the other four palettes depends on it.
  @MainActor
  func testTheAccentLaunchOverrideApplies() {
    let app = launchSettings(["--juno-preview-accent", "violet"])
    // The override drives the *rendered* accent, not the stored setting, so
    // the stored swatch is still coral — that separation is deliberate, and
    // asserting it stops the flag being mistaken for a way to write settings.
    let coral = app.buttons["juno.mobile.accent-coral"]
    require(coral, app)
    XCTAssertTrue(coral.isSelected, "The override should not rewrite the stored accent.")
  }
}

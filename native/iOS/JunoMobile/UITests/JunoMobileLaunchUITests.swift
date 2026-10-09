import XCTest

final class JunoMobileLaunchUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    /// A signed-out launch reaches the real sign-in gate.
    ///
    /// The first launch on a device shows the welcome pages before sign-in
    /// (`juno.mobile.onboarding.seen` is device storage, so a fresh simulator
    /// sees them, a rerun does not). The welcome is one accessibility
    /// container whose identifier SwiftUI propagates to its controls, so Skip
    /// is found by its label. Either way the reader must end on sign-in.
    @MainActor
    func testLaunchShowsRealSignInGate() {
        let app = XCUIApplication()
        app.launch()

        let signIn = app.buttons["juno.mobile.sign-in"]
        let skip = app.buttons.matching(
            NSPredicate(
                format: "label == %@ AND (identifier == %@ OR identifier == %@)",
                "Skip", "juno.mobile.welcome-skip", "juno.mobile.welcome"
            )
        ).firstMatch
        if !signIn.waitForExistence(timeout: 5), skip.waitForExistence(timeout: 15) {
            skip.tap()
        }

        XCTAssertTrue(
            signIn.waitForExistence(timeout: 10),
            "No sign-in gate. On screen:\n\(app.debugDescription)"
        )
    }
}

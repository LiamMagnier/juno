import XCTest

final class JunoMacLaunchUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    @MainActor
    func testLaunchShowsRealSignInGate() {
        let app = XCUIApplication()
        app.launch()

        XCTAssertTrue(
            app.buttons["juno.mac.sign-in"].waitForExistence(timeout: 5)
        )
    }
}

import XCTest

final class JunoMobileLaunchUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    @MainActor
    func testLaunchShowsRealSignInGate() {
        let app = XCUIApplication()
        app.launch()

        XCTAssertTrue(
            app.buttons["juno.mobile.sign-in"].waitForExistence(timeout: 5)
        )
    }
}

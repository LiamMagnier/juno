import XCTest

final class JunoMacLaunchUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testLaunchShowsNativeSidebarAndDetail() {
        let app = XCUIApplication()
        app.launch()

        XCTAssertTrue(
            app.descendants(matching: .any)["juno.mac.sidebar"].firstMatch.waitForExistence(timeout: 5)
        )
        XCTAssertTrue(
            app.descendants(matching: .any)["juno.mac.detail"].firstMatch.waitForExistence(timeout: 5)
        )
    }
}

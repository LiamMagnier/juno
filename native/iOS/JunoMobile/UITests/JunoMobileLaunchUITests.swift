import XCTest

final class JunoMobileLaunchUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testLaunchShowsNativeNavigation() {
        let app = XCUIApplication()
        app.launch()

        let sidebar = app.descendants(matching: .any)["juno.mobile.sidebar"].firstMatch
        let detail = app.descendants(matching: .any)["juno.mobile.detail"].firstMatch
        XCTAssertTrue(sidebar.waitForExistence(timeout: 5) || detail.waitForExistence(timeout: 5))
    }
}

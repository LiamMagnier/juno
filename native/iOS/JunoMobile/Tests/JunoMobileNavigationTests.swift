import XCTest
@testable import JunoMobile

final class JunoMobileNavigationTests: XCTestCase {
    func testNavigationIdentifiersAreStableAndUnique() {
        let identifiers = JunoMobileSection.allCases.map(\.id)

        XCTAssertEqual(identifiers.count, 7)
        XCTAssertEqual(Set(identifiers).count, identifiers.count)
        XCTAssertEqual(identifiers.first, "chat")
        XCTAssertEqual(identifiers.last, "settings")
    }

    /// Code is offered because its backend now exists: the relay routes under
    /// `/api/code/devices/**` shipped, `CodeRemoteBrowserModel` drives the
    /// phone's side of them, and the screen lists the account's real hosts and
    /// sessions. Tasks and Connections stay absent until the same is true of
    /// them — no navigation leads nowhere.
    func testCodeIsOfferedAndUnbuiltDestinationsAreNot() {
        let identifiers = Set(JunoMobileSection.allCases.map(\.id))

        XCTAssertTrue(identifiers.contains("code"))
        for absent in ["codeCloud", "tasks", "connections"] {
            XCTAssertFalse(identifiers.contains(absent))
        }
    }

    func testEverySectionAppearsInExactlyOneSidebarGroup() {
        let grouped = JunoMobileSection.Group.allCases.flatMap(\.sections)

        XCTAssertEqual(Set(grouped), Set(JunoMobileSection.allCases))
        XCTAssertEqual(grouped.count, JunoMobileSection.allCases.count)
    }
}

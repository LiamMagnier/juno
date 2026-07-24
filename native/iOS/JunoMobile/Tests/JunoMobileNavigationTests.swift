import XCTest
@testable import JunoMobile

final class JunoMobileNavigationTests: XCTestCase {
    func testNavigationIdentifiersAreStableAndUnique() {
        let identifiers = JunoMobileSection.allCases.map(\.id)

        XCTAssertEqual(identifiers.count, 9)
        XCTAssertEqual(Set(identifiers).count, identifiers.count)
        XCTAssertEqual(identifiers.first, "chat")
        XCTAssertEqual(identifiers.last, "settings")
    }

    /// Juno Code, Tasks and Connections used to be absent because their backends
    /// had no native client. They have one now — `/api/code/*`, `/api/tasks` and
    /// `/api/connectors` are all bearer-capable — so each is a real destination
    /// and this test guards that they stay reachable.
    func testTheServerBackedDestinationsAreOffered() {
        let identifiers = Set(JunoMobileSection.allCases.map(\.id))

        for expected in ["code", "tasks", "connections"] {
            XCTAssertTrue(identifiers.contains(expected), "\(expected) is not navigable")
        }
    }

    /// The drawer lists every destination except the three that have their own
    /// control: chat *is* the conversation list, search is the header button,
    /// settings is the footer avatar.
    func testTheDrawerListsEveryDestinationWithoutItsOwnControl() {
        let drawer = Set(JunoMobileSection.drawerDestinations)
        let expected = Set(JunoMobileSection.allCases).subtracting([.chat, .search, .settings])

        XCTAssertEqual(drawer, expected)
        XCTAssertEqual(
            JunoMobileSection.drawerDestinations.count, drawer.count, "a destination is listed twice"
        )
    }

    func testEverySectionAppearsInExactlyOneSidebarGroup() {
        let grouped = JunoMobileSection.Group.allCases.flatMap(\.sections)

        XCTAssertEqual(Set(grouped), Set(JunoMobileSection.allCases))
        XCTAssertEqual(grouped.count, JunoMobileSection.allCases.count)
    }
}

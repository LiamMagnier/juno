import XCTest
@testable import JunoMobile

final class JunoMobileNavigationTests: XCTestCase {
    func testNavigationIdentifiersAreStableAndUnique() {
        let identifiers = JunoMobileSection.allCases.map(\.id)

        XCTAssertEqual(identifiers.count, 6)
        XCTAssertEqual(Set(identifiers).count, identifiers.count)
        XCTAssertEqual(identifiers.first, "chat")
        XCTAssertEqual(identifiers.last, "settings")
    }

    /// Juno Code Cloud/Remote, Tasks and Connections are deliberately absent
    /// until their backends exist (GAP-021) — no navigation leads nowhere.
    func testUnbuiltDestinationsAreNotOffered() {
        let identifiers = Set(JunoMobileSection.allCases.map(\.id))

        for absent in ["codeCloud", "codeRemote", "tasks", "connections"] {
            XCTAssertFalse(identifiers.contains(absent))
        }
    }

    func testEverySectionAppearsInExactlyOneSidebarGroup() {
        let grouped = JunoMobileSection.Group.allCases.flatMap(\.sections)

        XCTAssertEqual(Set(grouped), Set(JunoMobileSection.allCases))
        XCTAssertEqual(grouped.count, JunoMobileSection.allCases.count)
    }
}

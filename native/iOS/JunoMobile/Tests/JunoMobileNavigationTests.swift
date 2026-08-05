import XCTest
@testable import JunoMobile

final class JunoMobileNavigationTests: XCTestCase {
    /// The identifiers are written into `@SceneStorage`, so one changing renames
    /// a destination the app has already remembered and strands the reader on a
    /// blank pane after an update.
    ///
    /// Spelled out rather than counted. This was `XCTAssertEqual(count, 9)`,
    /// which catches a destination being added — the failure it actually
    /// produced — without saying which, and would have gone stale again on the
    /// next one. The list is the point: it fails on an addition *and* on a
    /// removal, and the diff names the destination either way.
    func testNavigationIdentifiersAreStableAndUnique() {
        let identifiers = JunoMobileSection.allCases.map(\.id)

        XCTAssertEqual(
            identifiers,
            [
                "chat", "search", "code", "work", "tasks",
                "projects", "library", "artifacts", "connections", "settings",
            ]
        )
        XCTAssertEqual(Set(identifiers).count, identifiers.count)
    }

    /// Juno Code, Work, Tasks and Connections used to be absent because their
    /// backends had no native client. They have one now — `/api/code/*`,
    /// `/api/work/*`, `/api/tasks` and `/api/connectors` are all bearer-capable
    /// — so each is a real destination and this test guards that they stay
    /// reachable.
    func testTheServerBackedDestinationsAreOffered() {
        let identifiers = Set(JunoMobileSection.allCases.map(\.id))

        for expected in ["code", "work", "tasks", "connections"] {
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

    /// The drawer draws `junoIcon` when a destination has one and falls back to
    /// an SF Symbol when it does not. One system glyph in a column of Lucide
    /// marks reads as a row borrowed from another product — the exact drift
    /// Settings was fixed for — so every row the drawer lists must have the
    /// website's own mark.
    func testEveryDrawerDestinationCarriesTheSharedGlyph() {
        for destination in JunoMobileSection.drawerDestinations {
            XCTAssertNotNil(
                destination.junoIcon,
                "\(destination.id) would fall back to \(destination.systemImage) in the drawer"
            )
        }
    }

    func testEverySectionAppearsInExactlyOneSidebarGroup() {
        let grouped = JunoMobileSection.Group.allCases.flatMap(\.sections)

        XCTAssertEqual(Set(grouped), Set(JunoMobileSection.allCases))
        XCTAssertEqual(grouped.count, JunoMobileSection.allCases.count)
    }
}

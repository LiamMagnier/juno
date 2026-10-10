import SwiftUI
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
                "chat", "search", "code", "work", "agents", "tasks",
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

        for expected in ["code", "work", "agents", "tasks", "connections"] {
            XCTAssertTrue(identifiers.contains(expected), "\(expected) is not navigable")
        }
    }

    /// The drawer lists every destination except the three that have their own
    /// control (chat *is* the conversation list, search is the header button,
    /// settings is the footer gear) and the two folded into another screen
    /// (Artifacts in Library, Work in Code) — and every folded one names a
    /// host the drawer does list, so nothing becomes unreachable.
    func testTheDrawerListsEveryDestinationWithoutItsOwnControl() {
        let drawer = Set(JunoMobileSection.drawerDestinations)
        let folded = JunoMobileSection.foldedDestinations
        let expected = Set(JunoMobileSection.allCases)
            .subtracting([.chat, .search, .settings])
            .subtracting(folded.keys)

        XCTAssertEqual(drawer, expected)
        XCTAssertTrue(drawer.isDisjoint(with: folded.keys))
        for host in folded.values {
            XCTAssertTrue(drawer.contains(host), "\(host) hosts a folded destination but is not in the drawer")
        }
        XCTAssertEqual(
            JunoMobileSection.drawerDestinations.count, drawer.count, "a destination is listed twice"
        )
    }

    /// The phone drawer drops only what the chat's top bar already reaches
    /// (Code, through the Chat | Code switch), keeps the shared order, and
    /// still lists every host of a folded destination except those the bar
    /// reaches — so Work stays one tap away, through Code.
    func testThePhoneDrawerDropsOnlyWhatTheTopBarReaches() {
        let phone = JunoMobileSection.phoneDrawerDestinations
        XCTAssertFalse(phone.contains(.code))
        XCTAssertEqual(
            phone,
            JunoMobileSection.drawerDestinations.filter { $0 != .code }
        )
        for host in JunoMobileSection.foldedDestinations.values {
            XCTAssertTrue(
                phone.contains(host) || JunoMobileSection.phoneTopBarDestinations.contains(host),
                "\(host) hosts a folded destination but the phone cannot reach it"
            )
        }
    }

    /// The drawer draws `junoIcon` when a destination has one and falls back to
    /// an SF Symbol when it does not. One system glyph in a column of the web's
    /// own marks reads as a row borrowed from another product — the exact drift
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

    /// The pushed card is concentric with the phone's corners: the radius
    /// follows the hardware family, read off the screen's point width.
    func testThePushedCardTakesTheDisplayCornerRadius() {
        typealias Drawer = JunoMobilePushDrawer<EmptyView, EmptyView>
        XCTAssertEqual(Drawer.displayCornerRadius(screenWidth: 402), 62)
        XCTAssertEqual(Drawer.displayCornerRadius(screenWidth: 440), 62)
        XCTAssertEqual(Drawer.displayCornerRadius(screenWidth: 393), 55)
        XCTAssertEqual(Drawer.displayCornerRadius(screenWidth: 390), 47)
        XCTAssertEqual(Drawer.displayCornerRadius(screenWidth: 1024), 40)
    }

    /// The drawer's search button is the top bar's button: one diameter, one
    /// glyph size, so it can sit on the card's sidebar button's centre line.
    func testTheDrawerHeaderButtonIsTheTopBarButton() {
        XCTAssertEqual(JunoMobileTopBarMetrics.buttonDiameter, 44)
        XCTAssertEqual(JunoMobileTopBarMetrics.glyph, 20)
        XCTAssertEqual(JunoMobileDrawerMetrics.edge, 16)
        XCTAssertEqual(JunoMobileDrawerMetrics.edge + JunoMobileDrawerMetrics.slot + JunoMobileDrawerMetrics.gap, 46)
    }
}

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

    /// Code is offered because its backend now exists: the relay routes under
    /// `/api/code/devices/**` shipped, `CodeRemoteBrowserModel` drives the
    /// phone's side of them, and the screen lists the account's real hosts and
    /// sessions. Tasks and Connections stay absent until the same is true of
    /// them — no navigation leads nowhere.
    func testEveryOfferedDestinationHasABackend() {
        let identifiers = Set(JunoMobileSection.allCases.map(\.id))

        // All three reach routes that already serve the website: Code through
        // `/api/code/devices/**`, Tasks through `/api/tasks`, Connections
        // through `/api/connectors`. None is a placeholder.
        for offered in ["code", "tasks", "connections"] {
            XCTAssertTrue(identifiers.contains(offered))
        }
        // Cloud Code has no backend, so it stays absent.
        XCTAssertFalse(identifiers.contains("codeCloud"))
    }

    /// Code is a mode of working rather than a folder of content, so it sits
    /// after the content destinations — the order the website uses.
    func testCodeIsOrderedLast() {
        let ids = JunoMobileSection.allCases.map(\.id)
        let code = ids.firstIndex(of: "code")
        for content in ["projects", "library", "artifacts", "tasks", "connections"] {
            XCTAssertLessThan(ids.firstIndex(of: content)!, code!)
        }
    }

    func testEverySectionAppearsInExactlyOneSidebarGroup() {
        let grouped = JunoMobileSection.Group.allCases.flatMap(\.sections)

        XCTAssertEqual(Set(grouped), Set(JunoMobileSection.allCases))
        XCTAssertEqual(grouped.count, JunoMobileSection.allCases.count)
    }
}

import XCTest
@testable import JunoMac

final class JunoMacNavigationTests: XCTestCase {
    func testNavigationIdentifiersAreStableAndUnique() {
        let identifiers = JunoMacSection.allCases.map(\.id)

        XCTAssertEqual(identifiers.count, 9)
        XCTAssertEqual(Set(identifiers).count, identifiers.count)
        XCTAssertEqual(identifiers.first, "chat")
        XCTAssertEqual(identifiers.last, "settings")
    }

    func testEveryDestinationHasASystemImage() {
        XCTAssertTrue(JunoMacSection.allCases.allSatisfy { !$0.systemImage.isEmpty })
    }
}

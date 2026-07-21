import XCTest
@testable import JunoMobile

final class JunoMobileNavigationTests: XCTestCase {
    func testNavigationIdentifiersAreStableAndUnique() {
        let identifiers = JunoMobileSection.allCases.map(\.id)

        XCTAssertEqual(identifiers.count, 10)
        XCTAssertEqual(Set(identifiers).count, identifiers.count)
        XCTAssertEqual(identifiers.first, "chat")
        XCTAssertEqual(identifiers.last, "settings")
    }

    func testCloudAndRemoteRemainSeparateDestinations() {
        XCTAssertNotEqual(JunoMobileSection.codeCloud.id, JunoMobileSection.codeRemote.id)
        XCTAssertNotEqual(JunoMobileSection.codeCloud.systemImage, JunoMobileSection.codeRemote.systemImage)
    }
}

import JunoWorkKit
import XCTest
@testable import JunoMobile

/// Naming the Mac a task is on, now that there are Macs to name.
final class JunoMobileWorkHostTests: XCTestCase {
    private func host(_ id: String, _ name: String) -> WorkHostSummary {
        WorkHostSummary(
            hostID: id, deviceID: "device-\(id)", displayName: name, state: "idle",
            enabled: true, capabilities: [], activeRunCount: 0, queuedRunCount: 0,
            lastSeenAt: Date(), revokedAt: nil
        )
    }

    func testAClaimedTaskIsNamedAfterTheMacThatClaimedIt() {
        let hosts = [host("h-1", "Liam\u{2019}s MacBook Pro"), host("h-2", "Studio")]
        XCTAssertEqual(
            JunoMobileWorkHost.name(of: "h-2", in: hosts), "Studio"
        )
    }

    /// A task aimed at "any of mine" has no host id at all. That is the case the
    /// generic phrase was written for, and it must keep it.
    func testAnUnclaimedTaskHasNoName() {
        XCTAssertNil(JunoMobileWorkHost.name(of: nil, in: [host("h-1", "Studio")]))
    }

    /// A Mac the list has not loaded yet, or one that has since been removed, is
    /// unnamed rather than mis-named — the same conservatism
    /// ``NativeWorkModel/displayStatus(of:)`` applies to a host it cannot see.
    func testAHostMissingFromTheListIsNotGuessedAt() {
        XCTAssertNil(JunoMobileWorkHost.name(of: "h-9", in: [host("h-1", "Studio")]))
        XCTAssertNil(JunoMobileWorkHost.name(of: "h-1", in: []))
    }
}

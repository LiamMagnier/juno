import XCTest
@testable import JunoAuth

@MainActor
final class WebAuthenticationResumeLatchTests: XCTestCase {
    func testFirstClaimSucceeds() {
        XCTAssertTrue(WebAuthenticationResumeLatch().claim())
    }

    func testSecondClaimFails() {
        let latch = WebAuthenticationResumeLatch()
        XCTAssertTrue(latch.claim())
        XCTAssertFalse(latch.claim())
    }

    /// The real shape of the hazard: `ASWebAuthenticationSession.start()` can
    /// deliver a completion inline and *then* return false, so both the
    /// completion path and the start-failure path race to resume. Exactly one
    /// must win, whichever arrives first.
    func testOnlyOneOfManyClaimantsWins() {
        let latch = WebAuthenticationResumeLatch()
        let winners = (0..<50).filter { _ in latch.claim() }
        XCTAssertEqual(winners.count, 1)
    }

    func testEachLatchIsIndependent() {
        let first = WebAuthenticationResumeLatch()
        let second = WebAuthenticationResumeLatch()
        XCTAssertTrue(first.claim())
        XCTAssertTrue(second.claim(), "a used latch must not affect a fresh one")
    }
}

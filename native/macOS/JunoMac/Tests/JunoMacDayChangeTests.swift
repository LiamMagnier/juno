import Combine
import Foundation
import XCTest
@testable import JunoMac

final class JunoMacDayChangeTests: XCTestCase {
    /// The sidebar's buckets are measured from an injected `now`, so every event
    /// that moves the current calendar day has to be a refresh signal: midnight,
    /// the clock being set, and the zone changing under an autoupdating
    /// calendar.
    func testWatchesEveryEventThatMovesTheCurrentDay() {
        XCTAssertEqual(
            Set(JunoMacDayChange.notificationNames),
            [.NSCalendarDayChanged, .NSSystemClockDidChange, .NSSystemTimeZoneDidChange]
        )
    }

    /// Each signal has to produce a *fresh* read — a publisher that replayed the
    /// date it was created with would leave the buckets exactly as stale as the
    /// one clock read it was meant to replace.
    func testEachSignalDeliversAFreshDateOnTheMainThread() throws {
        for name in JunoMacDayChange.notificationNames {
            let center = NotificationCenter()
            let received = expectation(description: "\(name.rawValue) refreshes the clock")
            var delivered: Date?
            var onMainThread = false

            let subscription = JunoMacDayChange.publisher(center: center).sink { now in
                delivered = now
                onMainThread = Thread.isMainThread
                received.fulfill()
            }
            defer { subscription.cancel() }

            let before = Date()
            center.post(name: name, object: nil)
            wait(for: [received], timeout: 2)

            XCTAssertGreaterThanOrEqual(
                try XCTUnwrap(delivered, "\(name.rawValue) produced no date"),
                before,
                "\(name.rawValue) replayed a stale clock read"
            )
            // `@State` is main-actor isolated, and NSCalendarDayChanged carries
            // no promise about the thread it is posted on.
            XCTAssertTrue(onMainThread, "\(name.rawValue) was delivered off the main thread")
        }
    }

    /// Nothing should reach the view until an actual day-moving event fires;
    /// otherwise the subscription would be the per-redraw clock read the
    /// sidebar deliberately avoids.
    func testStaysSilentUntilOneOfThoseEventsFires() {
        let center = NotificationCenter()
        var deliveries = 0
        let subscription = JunoMacDayChange.publisher(center: center).sink { _ in deliveries += 1 }
        defer { subscription.cancel() }

        center.post(name: Notification.Name("juno.tests.unrelated"), object: nil)
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))

        XCTAssertEqual(deliveries, 0)
    }
}

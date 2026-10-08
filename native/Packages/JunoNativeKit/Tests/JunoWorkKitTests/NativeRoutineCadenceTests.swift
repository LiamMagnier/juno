import Foundation
import JunoCore
import XCTest

@testable import JunoWorkKit

/// The simple routine editor's clock, to and from the stored trigger set.
final class NativeRoutineCadenceTests: XCTestCase {
    func testEachKindWritesTheWebsConfigKeysAndReadsBack() {
        let weekly = NativeRoutineCadence(kind: .weekly, hour: 7, minute: 30, weekday: 5)
        let trigger = weekly.trigger(id: "t1")
        XCTAssertEqual(trigger.id, "t1")
        XCTAssertEqual(trigger.kind, "weekly")
        XCTAssertEqual(trigger.config, ["hour": .number(7), "minute": .number(30), "weekday": .number(5)])
        XCTAssertEqual(NativeRoutineCadence(triggers: [trigger]), weekly)
        XCTAssertEqual(weekly.sentence, "Every Friday at 07:30")

        let hourly = NativeRoutineCadence(kind: .hourly, minute: 15).trigger()
        XCTAssertEqual(hourly.config, ["minute": .number(15)])
        XCTAssertEqual(NativeRoutineCadence(triggers: [hourly])?.sentence, "Every hour at 15 past")

        let monthly = NativeRoutineCadence(kind: .monthly, hour: 9, minute: 0, monthday: 31).trigger()
        XCTAssertEqual(monthly.config["monthday"], .number(31))
        XCTAssertNil(monthly.config["weekday"])
        XCTAssertEqual(NativeRoutineCadence(kind: .weekdays, hour: 8).sentence, "Every weekday at 08:00")
    }

    func testAnythingButOneEnabledClockTriggerHasNoCadence() {
        XCTAssertNil(NativeRoutineCadence(triggers: []))
        XCTAssertNil(NativeRoutineCadence(triggers: [NativeWorkScheduleTriggerDraft(kind: "email_filter")]))
        XCTAssertNil(NativeRoutineCadence(triggers: [NativeWorkScheduleTriggerDraft(kind: "cron", config: ["expression": .string("0 9 * * *")])]))
        XCTAssertNil(NativeRoutineCadence(triggers: [NativeWorkScheduleTriggerDraft(kind: "daily", enabled: false)]))
        let daily = NativeRoutineCadence().trigger()
        XCTAssertNil(NativeRoutineCadence(triggers: [daily, daily]))
    }

    func testValuesAreClampedToTheClock() {
        let cadence = NativeRoutineCadence(kind: .daily, hour: 30, minute: -4, weekday: 9, monthday: 0)
        XCTAssertEqual(cadence.hour, 23)
        XCTAssertEqual(cadence.minute, 0)
        XCTAssertEqual(cadence.weekday, 6)
        XCTAssertEqual(cadence.monthday, 1)
    }
}

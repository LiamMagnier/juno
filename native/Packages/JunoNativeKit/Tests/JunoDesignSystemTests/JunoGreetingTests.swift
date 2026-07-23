import XCTest
@testable import JunoDesignSystem

/// Guards the port of the website's greeting table. The value of these tests is
/// that they encode the *web's* rules, so a native tweak that quietly diverges
/// from the site fails here rather than shipping.
final class JunoGreetingTests: XCTestCase {
    func testBucketsCoverEveryHourOfTheDayExactlyOnce() {
        for hour in 0..<24 {
            let matches = JunoGreeting.buckets.filter { hour >= $0.from && hour < $0.to }
            XCTAssertEqual(matches.count, 1, "hour \(hour) matched \(matches.count) buckets")
        }
    }

    func testBucketsAreContiguousFromMidnightToMidnight() {
        XCTAssertEqual(JunoGreeting.buckets.first?.from, 0)
        XCTAssertEqual(JunoGreeting.buckets.last?.to, 24)
        for (earlier, later) in zip(JunoGreeting.buckets, JunoGreeting.buckets.dropFirst()) {
            XCTAssertEqual(earlier.to, later.from, "gap or overlap at \(earlier.to)")
        }
    }

    func testBoundaryHoursLandInTheWebsitesBucket() {
        // The exact edges the half-open ranges turn on.
        XCTAssertEqual(JunoGreeting.bucket(forHour: 0).phrases.first, "Moonlight chat")
        XCTAssertEqual(JunoGreeting.bucket(forHour: 4).phrases.first, "Moonlight chat")
        XCTAssertEqual(JunoGreeting.bucket(forHour: 5).phrases.first, "Rise and shine")
        XCTAssertEqual(JunoGreeting.bucket(forHour: 7).phrases.first, "Good morning")
        XCTAssertEqual(JunoGreeting.bucket(forHour: 11).phrases.first, "Good morning")
        XCTAssertEqual(JunoGreeting.bucket(forHour: 12).phrases.first, "Good afternoon")
        XCTAssertEqual(JunoGreeting.bucket(forHour: 18).phrases.first, "Good evening")
        XCTAssertEqual(JunoGreeting.bucket(forHour: 22).phrases.first, "Good evening")
        XCTAssertEqual(JunoGreeting.bucket(forHour: 23).phrases.last, "Night owl")
    }

    func testOutOfRangeHourFallsBackToMorningRatherThanEmpty() {
        // Mirrors the web's `?? TIME_GREETINGS[2]`.
        XCTAssertEqual(JunoGreeting.bucket(forHour: 24).phrases.first, "Good morning")
        XCTAssertEqual(JunoGreeting.bucket(forHour: -1).phrases.first, "Good morning")
        XCTAssertFalse(JunoGreeting.phrase(forHour: 99, varied: false).isEmpty)
    }

    func testDeterministicPhraseIsStableForScreenshots() {
        for hour in 0..<24 {
            let a = JunoGreeting.phrase(forHour: hour, varied: false)
            let b = JunoGreeting.phrase(forHour: hour, varied: false)
            XCTAssertEqual(a, b)
            XCTAssertFalse(a.isEmpty)
        }
    }

    func testDeterministicPhraseMatchesTheWebsitesIndexRule() {
        // The web uses `h % bucket.phrases.length` when not randomising.
        // 9am: morning bucket has 5 phrases, 9 % 5 == 4.
        XCTAssertEqual(JunoGreeting.phrase(forHour: 9, varied: false), "Rise and grind")
        // 3am: night bucket has 6 phrases, 3 % 6 == 3.
        XCTAssertEqual(JunoGreeting.phrase(forHour: 3, varied: false), "The world's asleep")
    }

    func testVariedPhraseAlwaysComesFromTheHoursOwnBucket() {
        for hour in 0..<24 {
            let allowed = Set(JunoGreeting.bucket(forHour: hour).phrases)
            for _ in 0..<50 {
                XCTAssertTrue(allowed.contains(JunoGreeting.phrase(forHour: hour, varied: true)))
            }
        }
    }

    func testFirstNameMatchesTheWebsitesSplit() {
        XCTAssertEqual(JunoGreeting.firstName(from: "Liam Magnier"), "Liam")
        XCTAssertEqual(JunoGreeting.firstName(from: "Liam"), "Liam")
        XCTAssertNil(JunoGreeting.firstName(from: nil))
        XCTAssertNil(JunoGreeting.firstName(from: ""))
        XCTAssertNil(JunoGreeting.firstName(from: "   "))
    }

    func testPhraseAtDateUsesTheGivenCalendarsHour() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Paris")!
        var components = DateComponents()
        components.year = 2026; components.month = 7; components.day = 22
        components.hour = 9; components.minute = 30
        let morning = calendar.date(from: components)!
        XCTAssertTrue(
            Set(JunoGreeting.bucket(forHour: 9).phrases)
                .contains(JunoGreeting.phrase(at: morning, calendar: calendar))
        )
    }
}

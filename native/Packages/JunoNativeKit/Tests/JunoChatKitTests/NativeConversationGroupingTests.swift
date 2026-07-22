import XCTest
@testable import JunoChatKit

final class NativeConversationGroupingTests: XCTestCase {
    /// A fixed calendar and clock so bucket boundaries are exact rather than
    /// dependent on when the suite happens to run.
    private var calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        return calendar
    }()

    private lazy var now: Date = calendar.date(
        from: DateComponents(year: 2026, month: 7, day: 22, hour: 12)
    )!

    private func conversation(
        id: String,
        daysAgo: Double = 0,
        hoursAgo: Double = 0,
        pinned: Bool = false,
        archived: Bool = false
    ) -> NativeConversation {
        let date = now.addingTimeInterval(-(daysAgo * 86_400 + hoursAgo * 3_600))
        return NativeConversation(
            id: id,
            title: id,
            model: "claude-opus-4-8",
            pinned: pinned,
            archivedAt: archived ? date : nil,
            createdAt: date,
            updatedAt: date,
            lastMessageAt: date,
            revision: 1
        )
    }

    private func groups(_ conversations: [NativeConversation]) -> [NativeConversationGroup] {
        NativeConversationGrouping.groups(for: conversations, now: now, calendar: calendar)
    }

    func testEmptyInputProducesNoGroups() {
        XCTAssertTrue(groups([]).isEmpty)
    }

    func testEmptyBucketsAreDropped() {
        // Only today has a conversation, so exactly one group comes back.
        let result = groups([conversation(id: "a")])
        XCTAssertEqual(result.map(\.bucket), [.today])
    }

    func testBucketBoundaries() {
        let result = groups([
            conversation(id: "today", hoursAgo: 2),
            conversation(id: "yesterday", daysAgo: 1),
            conversation(id: "week", daysAgo: 5),
            conversation(id: "month", daysAgo: 20),
            conversation(id: "ancient", daysAgo: 400),
        ])
        XCTAssertEqual(
            result.map(\.bucket),
            [.today, .yesterday, .previous7Days, .previous30Days, .older]
        )
    }

    func testSevenAndThirtyDayEdgesFallInTheInclusiveBucket() {
        let result = groups([
            conversation(id: "sevenDays", daysAgo: 7),
            conversation(id: "eightDays", daysAgo: 8),
            conversation(id: "thirtyDays", daysAgo: 30),
            conversation(id: "thirtyOneDays", daysAgo: 31),
        ])
        let byID = Dictionary(
            uniqueKeysWithValues: result.flatMap { group in
                group.conversations.map { ($0.id, group.bucket) }
            }
        )
        XCTAssertEqual(byID["sevenDays"], .previous7Days)
        XCTAssertEqual(byID["eightDays"], .previous30Days)
        XCTAssertEqual(byID["thirtyDays"], .previous30Days)
        XCTAssertEqual(byID["thirtyOneDays"], .older)
    }

    func testPinnedOutranksRecency() {
        let result = groups([conversation(id: "old", daysAgo: 400, pinned: true)])
        XCTAssertEqual(result.map(\.bucket), [.pinned])
    }

    func testArchivedOutranksPinned() {
        // Archiving must always remove a row from the live list, even if the
        // conversation was pinned before it was archived.
        let result = groups([conversation(id: "a", pinned: true, archived: true)])
        XCTAssertEqual(result.map(\.bucket), [.archived])
    }

    func testGroupsAppearInDeclarationOrder() {
        let result = groups([
            conversation(id: "ancient", daysAgo: 400),
            conversation(id: "archived", archived: true),
            conversation(id: "today"),
            conversation(id: "pinned", daysAgo: 3, pinned: true),
        ])
        XCTAssertEqual(result.map(\.bucket), [.pinned, .today, .older, .archived])
    }

    func testConversationsWithinABucketAreNewestFirst() {
        let result = groups([
            conversation(id: "b", hoursAgo: 5),
            conversation(id: "a", hoursAgo: 1),
            conversation(id: "c", hoursAgo: 9),
        ])
        XCTAssertEqual(result.first?.conversations.map(\.id), ["a", "b", "c"])
    }

    func testEqualTimestampsSortStablyByIdentifier() {
        let result = groups([
            conversation(id: "zulu", hoursAgo: 3),
            conversation(id: "alpha", hoursAgo: 3),
        ])
        XCTAssertEqual(result.first?.conversations.map(\.id), ["alpha", "zulu"])
    }

    func testFutureTimestampsBucketAsToday() {
        // Clock skew between a phone and a Mac routinely produces these; they
        // must not fall through to `.older`.
        let future = NativeConversation(
            id: "skewed",
            title: "skewed",
            model: "m",
            pinned: false,
            archivedAt: nil,
            createdAt: now,
            updatedAt: now,
            lastMessageAt: now.addingTimeInterval(86_400 * 3),
            revision: 1
        )
        XCTAssertEqual(groups([future]).map(\.bucket), [.today])
    }

    func testEveryConversationLandsInExactlyOneGroup() {
        let input = (0..<40).map { conversation(id: "c\($0)", daysAgo: Double($0) * 3) }
        let result = groups(input)
        let ids = result.flatMap { $0.conversations.map(\.id) }
        XCTAssertEqual(ids.count, input.count)
        XCTAssertEqual(Set(ids), Set(input.map(\.id)))
    }
}

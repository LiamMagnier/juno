import XCTest
@testable import JunoCore

final class JunoRecentActivityTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 10_000)

    func testMergeKeepsPinnedItemsFirstAndUsesStableTieBreakers() {
        let pinned = JunoRecentItem(
            sourceID: "chat-2",
            kind: .chat,
            title: "Pinned",
            updatedAt: now.addingTimeInterval(-100),
            pinned: true
        )
        let newer = JunoRecentItem(
            sourceID: "work-1",
            kind: .work,
            title: "Newer",
            updatedAt: now
        )
        let sameTimeA = JunoRecentItem(
            sourceID: "code-a",
            kind: .code,
            title: "A",
            updatedAt: now.addingTimeInterval(-10)
        )
        let sameTimeB = JunoRecentItem(
            sourceID: "code-b",
            kind: .code,
            title: "B",
            updatedAt: now.addingTimeInterval(-10)
        )

        let merged = JunoRecentActivity.merge(
            [[sameTimeB, pinned], [newer, sameTimeA]],
            limit: 10
        )

        XCTAssertEqual(merged.map(\.id), ["chat:chat-2", "work:work-1", "code:code-a", "code:code-b"])
    }

    func testAttentionAndRunningAreDisjoint() {
        let approval = JunoRecentItem(
            sourceID: "code-1",
            kind: .code,
            title: "Review",
            updatedAt: now,
            status: "awaiting_approval"
        )
        let running = JunoRecentItem(
            sourceID: "work-1",
            kind: .work,
            title: "Running",
            updatedAt: now,
            status: "running"
        )

        XCTAssertTrue(JunoRecentActivity.matches(approval, filter: .needsAttention))
        XCTAssertFalse(JunoRecentActivity.matches(approval, filter: .running))
        XCTAssertTrue(JunoRecentActivity.matches(running, filter: .running))
        XCTAssertFalse(JunoRecentActivity.matches(running, filter: .needsAttention))
    }

    func testFailuresExcludeCancelledAndCompleted() {
        let failed = JunoRecentItem(
            sourceID: "work-1", kind: .work, title: "Failed", updatedAt: now, status: "failed"
        )
        let cancelled = JunoRecentItem(
            sourceID: "code-1", kind: .code, title: "Cancelled", updatedAt: now, status: "cancelled"
        )
        let completed = JunoRecentItem(
            sourceID: "chat-1", kind: .chat, title: "Done", updatedAt: now, status: "completed"
        )

        XCTAssertTrue(JunoRecentActivity.matches(failed, filter: .failed))
        XCTAssertFalse(JunoRecentActivity.matches(cancelled, filter: .failed))
        XCTAssertFalse(JunoRecentActivity.matches(completed, filter: .failed))
    }

    func testFailedCodeTaskCanSurfaceInAttentionRail() {
        let failed = JunoRecentItem(
            sourceID: "code-1",
            kind: .code,
            title: "Build failed",
            updatedAt: now,
            status: "failed",
            needsAttention: true
        )

        XCTAssertTrue(JunoRecentActivity.matches(failed, filter: .needsAttention))
        XCTAssertEqual(
            JunoRecentActivity.attentionItems(from: [failed]).map(\.sourceID),
            ["code-1"]
        )
    }

    func testPerSourceLimitIsBoundedAndAttentionIsSorted() {
        XCTAssertEqual(JunoRecentActivity.perSourceLimit(-1), 1)
        XCTAssertEqual(JunoRecentActivity.perSourceLimit(50), 50)
        XCTAssertEqual(JunoRecentActivity.perSourceLimit(500), 200)

        let older = JunoRecentItem(
            sourceID: "work-old", kind: .work, title: "Old", updatedAt: now.addingTimeInterval(-10), needsAttention: true
        )
        let newer = JunoRecentItem(
            sourceID: "work-new", kind: .work, title: "New", updatedAt: now, needsAttention: true
        )
        XCTAssertEqual(
            JunoRecentActivity.attentionItems(from: [older, newer]).map(\.sourceID),
            ["work-new", "work-old"]
        )
    }
}

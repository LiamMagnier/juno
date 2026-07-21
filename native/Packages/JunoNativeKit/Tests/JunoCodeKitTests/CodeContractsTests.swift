import XCTest
@testable import JunoCodeKit

final class CodeContractsTests: XCTestCase {
    func testWorkspaceRelativePathRejectsTraversalAndAbsolutePaths() {
        XCTAssertThrowsError(try WorkspaceRelativePath("../Secrets.txt"))
        XCTAssertThrowsError(try WorkspaceRelativePath("Sources/../Secrets.txt"))
        XCTAssertThrowsError(try WorkspaceRelativePath("/tmp/secret"))
        XCTAssertThrowsError(try WorkspaceRelativePath("C:\\secret"))
        XCTAssertNoThrow(try WorkspaceRelativePath("Sources/Juno/App.swift"))
    }

    func testApprovalIsBoundToDigestAndExpiry() throws {
        let expected = try ActionDigest(String(repeating: "a", count: 64))
        let other = try ActionDigest(String(repeating: "b", count: 64))
        let expiry = Date(timeIntervalSince1970: 1_000)
        let approval = CodeApprovalRequest(
            id: "approval_1",
            actionDigest: expected,
            summary: "Apply one reviewed patch",
            expiresAt: expiry
        )
        XCTAssertTrue(approval.authorizes(expected, at: Date(timeIntervalSince1970: 999)))
        XCTAssertFalse(approval.authorizes(other, at: Date(timeIntervalSince1970: 999)))
        XCTAssertFalse(approval.authorizes(expected, at: expiry))
    }

    func testRemoteTimelineRejectsGapsAndIgnoresDuplicates() throws {
        let now = Date(timeIntervalSince1970: 100)
        var timeline = CodeRemoteTimeline()
        let first = CodeRemoteEvent(sequence: 20, occurredAt: now, payload: .phase(.running))
        XCTAssertEqual(try timeline.apply(first), .applied)
        XCTAssertEqual(try timeline.apply(first), .duplicate)
        XCTAssertThrowsError(
            try timeline.apply(
                CodeRemoteEvent(sequence: 22, occurredAt: now, payload: .progress("late"))
            )
        ) {
            XCTAssertEqual(
                $0 as? CodeRemoteTimelineError,
                .sequenceGap(expected: 21, received: 22)
            )
        }
        XCTAssertEqual(timeline.lastSequence, 20)
    }
}

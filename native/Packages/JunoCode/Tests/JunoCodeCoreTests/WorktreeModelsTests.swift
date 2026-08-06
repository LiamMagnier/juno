import Foundation
import XCTest
@testable import JunoCodeCore

final class WorktreeModelsTests: XCTestCase {
    func testLifecycleTransitionsAndCodableRoundTrip() throws {
        let timestamp = Date(timeIntervalSince1970: 1_700_000_000)
        let active = WorktreeMetadata(
            id: "worktree-1",
            rootPath: "/workspace/.juno/worktrees/task",
            branch: "feature/task",
            baseRevision: "deadbeef",
            owner: .juno,
            lifecycle: .active,
            createdAt: timestamp,
            updatedAt: timestamp
        )
        let finalized = try active.transitioning(to: .finalized, at: timestamp.addingTimeInterval(1))
        let applied = try finalized.transitioning(to: .applied, at: timestamp.addingTimeInterval(2))
        let removing = try applied.transitioning(to: .removing, at: timestamp.addingTimeInterval(3))
        let removed = try removing.transitioning(to: .removed, at: timestamp.addingTimeInterval(4))

        XCTAssertEqual(removed.lifecycle, .removed)
        XCTAssertThrowsError(try removed.transitioning(to: .active)) { error in
            XCTAssertEqual(
                error as? WorktreeLifecycleError,
                .invalidTransition(from: .removed, to: .active)
            )
        }

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let roundTripped = try decoder.decode(
            WorktreeMetadata.self,
            from: encoder.encode(removed)
        )
        XCTAssertEqual(roundTripped, removed)
        XCTAssertEqual(roundTripped.owner, .juno)
    }
}

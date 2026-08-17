import Foundation
import XCTest
@testable import JunoCodeCore

final class GoalModelsTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_700_000_000)

    func testProgressAndCodableRoundTripPreserveOrderedGoal() throws {
        let goal = SessionGoal(
            id: "goal-1",
            objective: "Ship durable Goal Mode",
            lifecycle: .blocked,
            steps: [
                GoalStep(
                    id: "step-1",
                    title: "Implement models",
                    status: .completed,
                    createdAt: start,
                    updatedAt: start.addingTimeInterval(10),
                    completedAt: start.addingTimeInterval(10)
                ),
                GoalStep(
                    id: "step-2",
                    title: "Run strict tests",
                    status: .blocked,
                    createdAt: start,
                    updatedAt: start.addingTimeInterval(20)
                ),
                GoalStep(
                    id: "step-3",
                    title: "Ship",
                    createdAt: start
                ),
            ],
            verificationEvidence: [
                GoalVerificationEvidence(
                    id: "evidence-1",
                    summary: "Core tests passed",
                    source: "swift test --filter Goal",
                    recordedAt: start.addingTimeInterval(30)
                )
            ],
            createdAt: start,
            updatedAt: start.addingTimeInterval(30)
        )

        XCTAssertEqual(goal.steps.map(\.id), ["step-1", "step-2", "step-3"])
        XCTAssertEqual(goal.progress.completedSteps, 1)
        XCTAssertEqual(goal.progress.blockedSteps, 1)
        XCTAssertEqual(goal.progress.totalSteps, 3)
        XCTAssertEqual(goal.progress.fractionCompleted, 1.0 / 3.0, accuracy: 0.000_001)

        let data = try JSONEncoder().encode(goal)
        XCTAssertEqual(try JSONDecoder().decode(SessionGoal.self, from: data), goal)
    }

    func testOldSessionWithoutGoalStillDecodes() throws {
        let session = CodeSession(
            id: CodeSessionID(value: "session-1"),
            workspaceID: WorkspaceID(value: "workspace-1"),
            title: "Existing session",
            configuration: AgentConfiguration(modelID: "test-model"),
            createdAt: start,
            updatedAt: start
        )
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let encoded = try encoder.encode(session)
        var object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: encoded) as? [String: Any]
        )
        object.removeValue(forKey: "goal")
        let legacyData = try JSONSerialization.data(withJSONObject: object)

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let decoded = try decoder.decode(CodeSession.self, from: legacyData)
        XCTAssertNil(decoded.goal)
        XCTAssertEqual(decoded.id, session.id)
    }

    func testStateMachineFailsClosedUntilStepsAndEvidenceAreComplete() throws {
        var goal = SessionGoal(
            objective: "Finish safely",
            steps: [
                GoalStep(id: "step-1", title: "Implement", createdAt: start),
                GoalStep(id: "step-2", title: "Verify", createdAt: start),
            ],
            createdAt: start
        )

        XCTAssertThrowsError(
            try goal.apply(.setLifecycle(.completed), at: start.addingTimeInterval(1))
        ) { error in
            XCTAssertEqual(error as? GoalStateError, .completionRequiresAllSteps)
        }
        // Direct transition from pending to completed is now supported
        try goal.apply(
            .setStepStatus(id: "step-1", status: .completed),
            at: start.addingTimeInterval(2)
        )
        XCTAssertEqual(goal.steps[0].status, .completed)
        try goal.apply(
            .setStepStatus(id: "step-2", status: .inProgress),
            at: start.addingTimeInterval(5)
        )
        try goal.apply(
            .setStepStatus(id: "step-2", status: .completed),
            at: start.addingTimeInterval(6)
        )

        XCTAssertThrowsError(
            try goal.apply(.setLifecycle(.completed), at: start.addingTimeInterval(7))
        ) { error in
            XCTAssertEqual(
                error as? GoalStateError,
                .completionRequiresVerificationEvidence
            )
        }

        try goal.apply(
            .addVerificationEvidence(
                summary: "Strict tests passed",
                source: "swift test"
            ),
            at: start.addingTimeInterval(8)
        )
        try goal.apply(.setLifecycle(.completed), at: start.addingTimeInterval(9))

        XCTAssertEqual(goal.lifecycle, .completed)
        XCTAssertEqual(goal.completedAt, start.addingTimeInterval(9))
        XCTAssertThrowsError(
            try goal.apply(
                .addStep(title: "Erase the finish line"),
                at: start.addingTimeInterval(10)
            )
        ) { error in
            XCTAssertEqual(error as? GoalStateError, .completedGoalIsImmutable)
        }
    }

    func testPausedAndBlockedGoalsRequireResumeBeforeContentMutations() throws {
        let guardedMutations: [GoalMutation] = [
            .setObjective("Changed while inactive"),
            .addStep(title: "Unexpected step"),
            .setStepStatus(id: "step-1", status: .inProgress),
            .addVerificationEvidence(summary: "Untrusted claim", source: "model"),
        ]

        for lifecycle in [GoalLifecycle.paused, .blocked] {
            for (offset, mutation) in guardedMutations.enumerated() {
                var goal = SessionGoal(
                    objective: "Preserve inactive goal",
                    lifecycle: lifecycle,
                    steps: [
                        GoalStep(id: "step-1", title: "Resume first", createdAt: start),
                    ],
                    createdAt: start
                )

                XCTAssertThrowsError(
                    try goal.apply(
                        mutation,
                        at: start.addingTimeInterval(Double(offset + 1))
                    )
                ) { error in
                    XCTAssertEqual(
                        error as? GoalStateError,
                        .inactiveGoalRequiresResume(lifecycle: lifecycle)
                    )
                }
                XCTAssertEqual(goal.lifecycle, lifecycle)
                XCTAssertEqual(goal.objective, "Preserve inactive goal")
                XCTAssertEqual(goal.steps.count, 1)
                XCTAssertTrue(goal.verificationEvidence.isEmpty)
            }

            var resumableGoal = SessionGoal(
                objective: "Resume safely",
                lifecycle: lifecycle,
                steps: [
                    GoalStep(id: "step-1", title: "Resume first", createdAt: start),
                ],
                createdAt: start
            )
            try resumableGoal.apply(
                .setLifecycle(.active),
                at: start.addingTimeInterval(10)
            )
            try resumableGoal.apply(
                .setObjective("Resumed safely"),
                at: start.addingTimeInterval(11)
            )
            XCTAssertEqual(resumableGoal.lifecycle, .active)
            XCTAssertEqual(resumableGoal.objective, "Resumed safely")
        }
    }

    func testGoalUpdateEventRoundTrips() throws {
        let goal = SessionGoal(
            id: "goal-1",
            objective: "Verify event persistence",
            steps: [
                GoalStep(id: "step-1", title: "Round trip", createdAt: start),
            ],
            createdAt: start
        )
        let event = SessionEvent(
            id: "event-1",
            sessionID: CodeSessionID(value: "session-1"),
            sequence: 3,
            timestamp: start,
            payload: .goalUpdated(GoalUpdatedEvent(kind: .created, goal: goal))
        )

        let data = try JSONEncoder().encode(event)
        XCTAssertEqual(try JSONDecoder().decode(SessionEvent.self, from: data), event)
    }

    func testGoalStepTransitionMatrixAndInvalidTransitions() throws {
        var step = GoalStep(id: "s1", title: "Step 1", status: .pending, createdAt: start)

        // 1. Pending transitions
        XCTAssertTrue(step.status.canTransition(to: .inProgress))
        XCTAssertTrue(step.status.canTransition(to: .blocked))
        XCTAssertFalse(step.status.canTransition(to: .completed)) // Direct on step is false; handled by higher-level goal normalization

        // Direct step.transition to .completed throws
        XCTAssertThrowsError(try step.transition(to: .completed, at: start)) { error in
            XCTAssertEqual(
                error as? GoalStateError,
                .invalidStepTransition(stepID: "s1", from: .pending, to: .completed)
            )
        }

        // Transition pending -> inProgress
        try step.transition(to: .inProgress, at: start.addingTimeInterval(1))
        XCTAssertEqual(step.status, .inProgress)

        // 2. InProgress transitions
        XCTAssertTrue(step.status.canTransition(to: .completed))
        XCTAssertTrue(step.status.canTransition(to: .blocked))
        XCTAssertTrue(step.status.canTransition(to: .pending))

        // Transition inProgress -> completed
        try step.transition(to: .completed, at: start.addingTimeInterval(2))
        XCTAssertEqual(step.status, .completed)
        XCTAssertNotNil(step.completedAt)

        // 3. Completed transitions: only reopen (inProgress) is allowed
        XCTAssertTrue(step.status.canTransition(to: .inProgress))
        XCTAssertFalse(step.status.canTransition(to: .pending))
        XCTAssertFalse(step.status.canTransition(to: .blocked))

        XCTAssertThrowsError(try step.transition(to: .pending, at: start.addingTimeInterval(3))) { error in
            XCTAssertEqual(
                error as? GoalStateError,
                .invalidStepTransition(stepID: "s1", from: .completed, to: .pending)
            )
        }
        XCTAssertThrowsError(try step.transition(to: .blocked, at: start.addingTimeInterval(3))) { error in
            XCTAssertEqual(
                error as? GoalStateError,
                .invalidStepTransition(stepID: "s1", from: .completed, to: .blocked)
            )
        }

        // Reopen completed -> inProgress
        try step.transition(to: .inProgress, at: start.addingTimeInterval(4))
        XCTAssertEqual(step.status, .inProgress)
        XCTAssertNil(step.completedAt)

        // Transition inProgress -> blocked
        try step.transition(to: .blocked, at: start.addingTimeInterval(5))
        XCTAssertEqual(step.status, .blocked)

        // 4. Blocked transitions: cannot jump directly to completed
        XCTAssertTrue(step.status.canTransition(to: .inProgress))
        XCTAssertTrue(step.status.canTransition(to: .pending))
        XCTAssertFalse(step.status.canTransition(to: .completed))

        XCTAssertThrowsError(try step.transition(to: .completed, at: start.addingTimeInterval(6))) { error in
            XCTAssertEqual(
                error as? GoalStateError,
                .invalidStepTransition(stepID: "s1", from: .blocked, to: .completed)
            )
        }

        // Higher-level goal normalization verifies pending -> completed succeeds
        var goal = SessionGoal(
            objective: "Normalize pending",
            steps: [GoalStep(id: "s1", title: "Step 1", status: .pending, createdAt: start)],
            createdAt: start
        )
        try goal.apply(.setStepStatus(id: "s1", status: .completed), at: start.addingTimeInterval(7))
        XCTAssertEqual(goal.steps[0].status, .completed)
        XCTAssertNotNil(goal.steps[0].completedAt)
    }
}

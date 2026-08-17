import Foundation
import XCTest
import JunoCodeCore
@testable import JunoCodeRuntime

final class GoalModeRuntimeTests: XCTestCase {
    private func temporaryStoreURL() throws -> URL {
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("juno-code-goal-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func createSession(in store: CodeSessionStore) async throws -> CodeSession {
        try await store.createSession(
            workspaceID: WorkspaceID(value: "workspace-1"),
            workspaceName: "Goal workspace",
            title: "Goal session",
            configuration: AgentConfiguration(
                modelID: "test-model",
                permissionMode: .fullAccess
            ),
            gitBranch: "main"
        )
    }

    func testStorePersistsGoalAndAppendOnlyUpdateEvents() async throws {
        let directory = try temporaryStoreURL()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = CodeSessionStore(directoryURL: directory)
        let session = try await createSession(in: store)
        let start = Date(timeIntervalSince1970: 1_700_000_000)

        var goal = try await store.createGoal(
            sessionID: session.id,
            objective: "  Ship verified Goal Mode  ",
            steps: [" Implement ", " Verify "],
            at: start
        )
        XCTAssertEqual(goal.objective, "Ship verified Goal Mode")
        XCTAssertEqual(goal.steps.map(\.title), ["Implement", "Verify"])
        let firstStepID = goal.steps[0].id
        let secondStepID = goal.steps[1].id

        goal = try await store.updateGoal(
            sessionID: session.id,
            mutation: .setStepStatus(id: firstStepID, status: .inProgress),
            at: start.addingTimeInterval(1)
        )
        goal = try await store.updateGoal(
            sessionID: session.id,
            mutation: .setStepStatus(id: firstStepID, status: .completed),
            at: start.addingTimeInterval(2)
        )
        goal = try await store.updateGoal(
            sessionID: session.id,
            mutation: .setStepStatus(id: secondStepID, status: .inProgress),
            at: start.addingTimeInterval(3)
        )
        goal = try await store.updateGoal(
            sessionID: session.id,
            mutation: .setStepStatus(id: secondStepID, status: .completed),
            at: start.addingTimeInterval(4)
        )
        goal = try await store.updateGoal(
            sessionID: session.id,
            mutation: .addVerificationEvidence(
                summary: "Strict tests passed",
                source: "swift test --filter Goal"
            ),
            at: start.addingTimeInterval(5)
        )
        goal = try await store.updateGoal(
            sessionID: session.id,
            mutation: .setLifecycle(.completed),
            at: start.addingTimeInterval(6)
        )

        XCTAssertEqual(goal.lifecycle, .completed)
        XCTAssertEqual(goal.progress.completedSteps, 2)
        XCTAssertEqual(goal.verificationEvidence.count, 1)

        let goalUpdates = await store.events(for: session.id).compactMap { event in
            if case let .goalUpdated(update) = event.payload {
                return update
            }
            return nil
        }
        XCTAssertEqual(
            goalUpdates.map(\.kind),
            [
                .created,
                .stepStatusChanged,
                .stepStatusChanged,
                .stepStatusChanged,
                .stepStatusChanged,
                .verificationAdded,
                .lifecycleChanged,
            ]
        )
        XCTAssertEqual(goalUpdates.last?.goal.lifecycle, .completed)

        let reloaded = CodeSessionStore(directoryURL: directory)
        let restoredSession = try await reloaded.session(id: session.id)
        let restoredGoal = try await reloaded.goal(for: session.id)
        let restoredEvents = await reloaded.events(for: session.id)
        let originalEvents = await store.events(for: session.id)
        XCTAssertEqual(restoredSession.goal, goal)
        XCTAssertEqual(restoredGoal, goal)
        XCTAssertEqual(restoredEvents, originalEvents)
    }

    func testUpdateGoalToolRejectsPrematureCompletionAndPreservesState() async throws {
        let directory = try temporaryStoreURL()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = CodeSessionStore(directoryURL: directory)
        let session = try await createSession(in: store)
        let goalTool = UpdateGoalTool(store: store)
        let registry = ToolRegistry(tools: [goalTool])
        let permissions = PermissionCoordinator(sessionID: session.id, mode: .fullAccess)
        let context = ToolContext(
            sessionID: session.id,
            toolCallID: "goal-call",
            emitOutput: { _, _ in }
        )
        let schema = goalTool.inputSchema.canonicalJSONString()
        XCTAssertFalse(schema.contains("add_verification"))
        XCTAssertFalse(schema.contains("evidence_source"))

        let created = try await registry.invoke(
            toolName: "update_goal",
            input: [
                "action": "create",
                "objective": "Finish only after verification",
                "steps": ["Implement runtime"],
            ],
            context: context,
            permissions: permissions
        )
        XCTAssertTrue(created.content.contains(#""lifecycle":"active""#))
        let goalAfterCreation = try await store.goal(for: session.id)
        let stepID = try XCTUnwrap(goalAfterCreation?.steps.first?.id)

        do {
            _ = try await registry.invoke(
                toolName: "update_goal",
                input: [
                    "action": "set_lifecycle",
                    "lifecycle": "completed",
                ],
                context: context,
                permissions: permissions
            )
            XCTFail("Expected completion to fail while a step is pending.")
        } catch let error as ToolError {
            XCTAssertEqual(
                error,
                .invalidInput(
                    message: GoalStateError.completionRequiresAllSteps.message
                )
            )
        }
        let goalAfterPendingRejection = try await store.goal(for: session.id)
        XCTAssertEqual(goalAfterPendingRejection?.lifecycle, .active)

        _ = try await registry.invoke(
            toolName: "update_goal",
            input: [
                "action": "set_step_status",
                "step_id": .string(stepID),
                "step_status": "inProgress",
            ],
            context: context,
            permissions: permissions
        )
        _ = try await registry.invoke(
            toolName: "update_goal",
            input: [
                "action": "set_step_status",
                "step_id": .string(stepID),
                "step_status": "completed",
            ],
            context: context,
            permissions: permissions
        )

        do {
            _ = try await registry.invoke(
                toolName: "update_goal",
                input: [
                    "action": "set_lifecycle",
                    "lifecycle": "completed",
                ],
                context: context,
                permissions: permissions
            )
            XCTFail("Expected completion to fail without verification evidence.")
        } catch let error as ToolError {
            XCTAssertEqual(
                error,
                .invalidInput(
                    message: GoalStateError.completionRequiresVerificationEvidence.message
                )
            )
        }
        let goalAfterEvidenceRejection = try await store.goal(for: session.id)
        XCTAssertEqual(goalAfterEvidenceRejection?.lifecycle, .active)

        do {
            _ = try await registry.invoke(
                toolName: "update_goal",
                input: [
                    "action": "add_verification",
                ],
                context: context,
                permissions: permissions
            )
            XCTFail("Expected the model-callable tool to reject self-attested evidence.")
        } catch let error as ToolError {
            XCTAssertEqual(
                error,
                .invalidInput(
                    message: "action must be create, set_objective, set_lifecycle, add_step, or set_step_status."
                )
            )
        }

        _ = try await store.updateGoal(
            sessionID: session.id,
            mutation: .addVerificationEvidence(
                summary: "Focused Goal Mode tests passed",
                source: "swift test --filter Goal"
            )
        )
        let completed = try await registry.invoke(
            toolName: "update_goal",
            input: [
                "action": "set_lifecycle",
                "lifecycle": "completed",
            ],
            context: context,
            permissions: permissions
        )

        XCTAssertTrue(completed.content.contains(#""lifecycle":"completed""#))
        let finalGoal = try await store.goal(for: session.id)
        XCTAssertEqual(finalGoal?.lifecycle, .completed)
        let goalUpdateCount = await store.events(for: session.id).filter {
            if case .goalUpdated = $0.payload { return true }
            return false
        }.count
        XCTAssertEqual(
            goalUpdateCount,
            5,
            "Rejected updates must not be appended to the durable audit trail."
        )
    }

    func testConversationPersistenceStripsEphemeralScreenshotBytes() async throws {
        let directory = try temporaryStoreURL()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = CodeSessionStore(directoryURL: directory)
        let session = try await createSession(in: store)
        let screenshotBytes = Data([0xDE, 0xAD, 0xBE, 0xEF])

        try await store.saveConversation(
            sessionID: session.id,
            messages: [
                .user("Inspect the current screen"),
                .toolResultWithImages(
                    id: "screenshot-call",
                    content: "Screenshot captured.",
                    isError: false,
                    images: [
                        ModelImage(
                            mediaType: "image/jpeg",
                            data: screenshotBytes,
                            detail: .high
                        ),
                    ]
                ),
                .assistant("The composer is visible."),
            ]
        )

        let restored = await store.loadConversation(sessionID: session.id)
        XCTAssertEqual(
            restored,
            [
                .user("Inspect the current screen"),
                .toolResult(
                    id: "screenshot-call",
                    content: """
                    Screenshot captured.
                    [Ephemeral image omitted; capture a fresh screenshot if needed.]
                    """,
                    isError: false
                ),
                .assistant("The composer is visible."),
            ]
        )

        let persistedURL = directory
            .appendingPathComponent("sessions")
            .appendingPathComponent(session.id.value)
            .appendingPathComponent("conversation.json")
        let persistedText = try String(contentsOf: persistedURL, encoding: .utf8)
        XCTAssertFalse(persistedText.contains(screenshotBytes.base64EncodedString()))
        XCTAssertFalse(persistedText.contains("toolResultWithImages"))
    }

    func testDirectPendingToCompletedTransitionAndReopen() async throws {
        let directory = try temporaryStoreURL()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = CodeSessionStore(directoryURL: directory)
        let session = try await createSession(in: store)
        let now = Date()

        var goal = try await store.createGoal(
            sessionID: session.id,
            objective: "Direct completion normalization",
            steps: ["Step 1", "Step 2"],
            at: now
        )
        let step1ID = goal.steps[0].id
        let step2ID = goal.steps[1].id

        // Direct transition from pending to completed must succeed
        goal = try await store.updateGoal(
            sessionID: session.id,
            mutation: .setStepStatus(id: step1ID, status: .completed),
            at: now.addingTimeInterval(1)
        )
        XCTAssertEqual(goal.steps[0].status, .completed)
        XCTAssertNotNil(goal.steps[0].completedAt)

        // Reopen step 1 back to inProgress
        goal = try await store.updateGoal(
            sessionID: session.id,
            mutation: .setStepStatus(id: step1ID, status: .inProgress),
            at: now.addingTimeInterval(2)
        )
        XCTAssertEqual(goal.steps[0].status, .inProgress)
        XCTAssertNil(goal.steps[0].completedAt)

        // Mark blocked
        goal = try await store.updateGoal(
            sessionID: session.id,
            mutation: .setStepStatus(id: step2ID, status: .blocked),
            at: now.addingTimeInterval(3)
        )
        XCTAssertEqual(goal.steps[1].status, .blocked)

        // Blocked cannot jump directly to completed
        do {
            _ = try await store.updateGoal(
                sessionID: session.id,
                mutation: .setStepStatus(id: step2ID, status: .completed),
                at: now.addingTimeInterval(4)
            )
            XCTFail("Blocked step should not transition directly to completed")
        } catch {
            // Expected invalid transition error
        }

        // Unblock to inProgress then complete
        goal = try await store.updateGoal(
            sessionID: session.id,
            mutation: .setStepStatus(id: step2ID, status: .inProgress),
            at: now.addingTimeInterval(5)
        )
        goal = try await store.updateGoal(
            sessionID: session.id,
            mutation: .setStepStatus(id: step2ID, status: .completed),
            at: now.addingTimeInterval(6)
        )
        XCTAssertEqual(goal.steps[1].status, .completed)
    }
}


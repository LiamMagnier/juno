import Foundation
import JunoCodeCore

/// Maintains the durable completion contract for the current session.
///
/// The tool only exposes validated state-machine mutations. In particular,
/// `set_lifecycle: completed` fails closed unless every step is complete and
/// the trusted runtime has already recorded verification evidence.
public struct UpdateGoalTool: CodeTool {
    private enum Action: String {
        case create
        case setObjective = "set_objective"
        case setLifecycle = "set_lifecycle"
        case addStep = "add_step"
        case setStepStatus = "set_step_status"
    }

    private let store: CodeSessionStore

    public init(store: CodeSessionStore) {
        self.store = store
    }

    public let name = "update_goal"
    public let description = """
        Create or update the current session's durable goal, ordered steps, \
        and lifecycle. Verification evidence is recorded only from trusted \
        runtime results. Complete a goal only after all steps are completed \
        and verification evidence has been recorded.
        """

    public var inputSchema: JSONValue {
        [
            "type": "object",
            "properties": [
                "action": [
                    "type": "string",
                    "enum": [
                        "create",
                        "set_objective",
                        "set_lifecycle",
                        "add_step",
                        "set_step_status",
                    ],
                ],
                "objective": ["type": "string"],
                "steps": [
                    "type": "array",
                    "items": ["type": "string"],
                ],
                "lifecycle": [
                    "type": "string",
                    "enum": ["active", "paused", "blocked", "completed"],
                ],
                "step_id": ["type": "string"],
                "step_title": ["type": "string"],
                "step_status": [
                    "type": "string",
                    "enum": ["pending", "inProgress", "completed", "blocked"],
                ],
            ],
            "required": ["action"],
        ]
    }

    public func assessRisk(input: JSONValue) -> ActionRisk { .write }

    public func summary(input: JSONValue) -> String {
        switch Action(rawValue: input["action"]?.stringValue ?? "") {
        case .create:
            return "Create the session goal"
        case .setObjective:
            return "Update the goal objective"
        case .setLifecycle:
            return "Set goal lifecycle to \(input["lifecycle"]?.stringValue ?? "unknown")"
        case .addStep:
            return "Add a goal step"
        case .setStepStatus:
            return "Set goal step to \(input["step_status"]?.stringValue ?? "unknown")"
        case nil:
            return "Update the session goal"
        }
    }

    public func precheck(input: JSONValue) -> ToolError? {
        guard let rawAction = input["action"]?.stringValue,
              let action = Action(rawValue: rawAction)
        else {
            return .invalidInput(
                message: "action must be create, set_objective, set_lifecycle, add_step, or set_step_status."
            )
        }

        switch action {
        case .create:
            guard Self.nonEmptyString(input["objective"]) != nil else {
                return .invalidInput(message: "objective is required for create.")
            }
            guard let values = input["steps"]?.arrayValue, !values.isEmpty else {
                return .invalidInput(message: "steps must contain at least one ordered step.")
            }
            guard values.allSatisfy({ Self.nonEmptyString($0) != nil }) else {
                return .invalidInput(message: "Every step must be a non-empty string.")
            }

        case .setObjective:
            guard Self.nonEmptyString(input["objective"]) != nil else {
                return .invalidInput(message: "objective is required for set_objective.")
            }

        case .setLifecycle:
            guard let value = input["lifecycle"]?.stringValue,
                  GoalLifecycle(rawValue: value) != nil
            else {
                return .invalidInput(
                    message: "lifecycle must be active, paused, blocked, or completed."
                )
            }

        case .addStep:
            guard Self.nonEmptyString(input["step_title"]) != nil else {
                return .invalidInput(message: "step_title is required for add_step.")
            }

        case .setStepStatus:
            guard Self.nonEmptyString(input["step_id"]) != nil else {
                return .invalidInput(message: "step_id is required for set_step_status.")
            }
            guard let value = input["step_status"]?.stringValue,
                  GoalStepStatus(rawValue: value) != nil
            else {
                return .invalidInput(
                    message: "step_status must be pending, inProgress, completed, or blocked."
                )
            }

        }
        return nil
    }

    public func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        if let refusal = precheck(input: input) {
            throw refusal
        }
        guard let rawAction = input["action"]?.stringValue,
              let action = Action(rawValue: rawAction)
        else {
            throw ToolError.invalidInput(message: "Invalid goal action.")
        }

        do {
            let goal: SessionGoal
            switch action {
            case .create:
                let objective = Self.nonEmptyString(input["objective"])!
                let steps = input["steps"]!.arrayValue!.map {
                    Self.nonEmptyString($0)!
                }
                goal = try await store.createGoal(
                    sessionID: context.sessionID,
                    objective: objective,
                    steps: steps
                )

            case .setObjective:
                goal = try await store.updateGoal(
                    sessionID: context.sessionID,
                    mutation: .setObjective(Self.nonEmptyString(input["objective"])!)
                )

            case .setLifecycle:
                let lifecycle = GoalLifecycle(rawValue: input["lifecycle"]!.stringValue!)!
                goal = try await store.updateGoal(
                    sessionID: context.sessionID,
                    mutation: .setLifecycle(lifecycle)
                )

            case .addStep:
                goal = try await store.updateGoal(
                    sessionID: context.sessionID,
                    mutation: .addStep(title: Self.nonEmptyString(input["step_title"])!)
                )

            case .setStepStatus:
                let status = GoalStepStatus(rawValue: input["step_status"]!.stringValue!)!
                goal = try await store.updateGoal(
                    sessionID: context.sessionID,
                    mutation: .setStepStatus(
                        id: Self.nonEmptyString(input["step_id"])!,
                        status: status
                    )
                )

            }
            return ToolResult(content: Self.resultJSON(for: goal))
        } catch let error as GoalStateError {
            throw ToolError.invalidInput(message: error.message)
        } catch let error as SessionStoreError {
            switch error {
            case .goalAlreadyExists:
                throw ToolError.invalidInput(
                    message: "This session already has a goal; update it instead of replacing it."
                )
            case .goalNotFound:
                throw ToolError.invalidInput(
                    message: "This session has no goal. Use action=create first."
                )
            case let .sessionNotFound(id):
                throw ToolError.executionFailed(message: "Session '\(id)' was not found.")
            case let .persistenceFailed(message):
                throw ToolError.executionFailed(
                    message: "Could not persist the goal: \(message)"
                )
            }
        } catch is CancellationError {
            throw ToolError.cancelled
        } catch let error as ToolError {
            throw error
        } catch {
            throw ToolError.executionFailed(message: String(describing: error))
        }
    }

    private static func nonEmptyString(_ value: JSONValue?) -> String? {
        guard let normalized = value?.stringValue?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !normalized.isEmpty
        else {
            return nil
        }
        return normalized
    }

    private static func resultJSON(for goal: SessionGoal) -> String {
        let steps = goal.steps.map { step in
            JSONValue.object([
                "id": .string(step.id),
                "title": .string(step.title),
                "status": .string(step.status.rawValue),
            ])
        }
        let evidence = goal.verificationEvidence.map { item in
            var fields: [String: JSONValue] = [
                "id": .string(item.id),
                "summary": .string(item.summary),
            ]
            if let source = item.source {
                fields["source"] = .string(source)
            }
            return JSONValue.object(fields)
        }
        let progress = goal.progress
        return JSONValue.object([
            "goal_id": .string(goal.id),
            "objective": .string(goal.objective),
            "lifecycle": .string(goal.lifecycle.rawValue),
            "progress": .object([
                "completed_steps": .number(Double(progress.completedSteps)),
                "blocked_steps": .number(Double(progress.blockedSteps)),
                "total_steps": .number(Double(progress.totalSteps)),
                "fraction_completed": .number(progress.fractionCompleted),
            ]),
            "steps": .array(steps),
            "verification_evidence": .array(evidence),
        ]).canonicalJSONString()
    }
}

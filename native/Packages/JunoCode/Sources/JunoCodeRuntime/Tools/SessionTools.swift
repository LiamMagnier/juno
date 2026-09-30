import Foundation
import JunoCodeCore

/// The agent's working checklist. It changes no file and starts nothing, so
/// it runs in every mode without asking.
public struct TodoWriteTool: CodeTool {
    public static let maximumItems = 50

    public init() {}

    public let name = "todo_write"
    public let description = """
        Keep a checklist of the steps of a multi-step task, shown to the reader \
        as you work. Send the WHOLE list every time — it replaces the previous \
        one. Each item has an id, content (imperative: "Add the migration"), a \
        status (pending, in_progress, completed) and optionally activeForm \
        (what is shown while it runs: "Adding the migration").

        Use it for work with three or more steps, or when the reader gives you \
        several things to do. Keep exactly one item in_progress while you \
        work, mark each completed as soon as it is done, and add items you \
        discover along the way. Skip it for a single quick change. It is a \
        progress list, not a record of verification: say what you checked in \
        your answer.
        """
    public var inputSchema: JSONValue {
        [
            "type": "object",
            "properties": [
                "todos": [
                    "type": "array",
                    "items": [
                        "type": "object",
                        "properties": [
                            "id": ["type": "string"],
                            "content": ["type": "string"],
                            "status": ["type": "string", "enum": ["pending", "in_progress", "completed"]],
                            "activeForm": ["type": "string"],
                        ],
                        "required": ["id", "content", "status"],
                    ],
                ],
            ],
            "required": ["todos"],
        ]
    }

    public func assessRisk(input: JSONValue) -> ActionRisk { .read }

    public func summary(input: JSONValue) -> String {
        let count = input["todos"]?.arrayValue?.count ?? 0
        return "Update the checklist (\(count) item\(count == 1 ? "" : "s"))"
    }

    public func precheck(input: JSONValue) -> ToolError? {
        do {
            _ = try Self.items(from: input)
            return nil
        } catch let error as ToolError {
            return error
        } catch {
            return .invalidInput(message: String(describing: error))
        }
    }

    static func items(from input: JSONValue) throws -> [TodoItem] {
        guard let raw = input["todos"]?.arrayValue else {
            throw ToolError.invalidInput(message: "'todos' must be an array of items.")
        }
        guard raw.count <= maximumItems else {
            throw ToolError.invalidInput(message: "At most \(maximumItems) items.")
        }
        var seen = Set<String>()
        return try raw.enumerated().map { index, item in
            let id = item["id"]?.stringValue?.trimmingCharacters(in: .whitespaces) ?? String(index + 1)
            guard let content = item["content"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !content.isEmpty
            else {
                throw ToolError.invalidInput(message: "Item \(index + 1) needs non-empty content.")
            }
            guard let statusText = item["status"]?.stringValue, let status = TodoStatus(rawValue: statusText) else {
                throw ToolError.invalidInput(
                    message: "Item \(index + 1): status is pending, in_progress or completed."
                )
            }
            guard !id.isEmpty, seen.insert(id).inserted else {
                throw ToolError.invalidInput(message: "Item ids must be unique and non-empty (\"\(id)\").")
            }
            let active = item["activeForm"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
            return TodoItem(
                id: id,
                content: String(content.prefix(500)),
                status: status,
                activeForm: active?.isEmpty == false ? String(active!.prefix(500)) : nil
            )
        }
    }

    public func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        let items = try Self.items(from: input)
        let event = TodoListEvent(items: items)
        var summary = items.isEmpty
            ? "Checklist cleared."
            : "Checklist updated: \(event.completedCount) of \(items.count) done."
        let running = items.filter { $0.status == .inProgress }
        if let current = running.first {
            summary += " In progress: \(current.activeForm ?? current.content)."
        }
        if running.count > 1 {
            summary += " Note: \(running.count) items are in_progress; keep one at a time."
        }
        return ToolResult(content: summary, sideEffects: [.todosUpdated(event)])
    }
}

/// Asks the reader one to four multiple-choice questions and waits for the
/// answer. The answer is information for the agent, never a permission.
public struct AskUserTool: CodeTool {
    private let questions: QuestionCoordinator

    public init(questions: QuestionCoordinator) {
        self.questions = questions
    }

    public let name = "ask_user"
    public let description = """
        Ask the reader something only they can decide — a preference, a \
        choice between approaches, a missing requirement — and wait for the \
        answer. One to four questions, each with two to four options (a short \
        label and an optional description); the reader can always write their \
        own answer instead. Set multiSelect when several options can apply. \
        Put the option you recommend first and say so in its description.

        Do not ask about things you can find out by reading the code, and do \
        not ask for permission to act: the permission system asks for that. \
        An answer is not an approval of any action.
        """
    public var inputSchema: JSONValue {
        [
            "type": "object",
            "properties": [
                "questions": [
                    "type": "array",
                    "items": [
                        "type": "object",
                        "properties": [
                            "question": ["type": "string"],
                            "header": ["type": "string", "description": "A few words naming the question"],
                            "options": [
                                "type": "array",
                                "items": [
                                    "type": "object",
                                    "properties": [
                                        "label": ["type": "string"],
                                        "description": ["type": "string"],
                                    ],
                                    "required": ["label"],
                                ],
                            ],
                            "multiSelect": ["type": "boolean"],
                        ],
                        "required": ["question", "options"],
                    ],
                ],
            ],
            "required": ["questions"],
        ]
    }

    public func assessRisk(input: JSONValue) -> ActionRisk { .read }

    public func summary(input: JSONValue) -> String {
        let first = input["questions"]?.arrayValue?.first?["question"]?.stringValue ?? "a question"
        return "Ask: \(first)"
    }

    public func precheck(input: JSONValue) -> ToolError? {
        do {
            _ = try Self.questions(from: input)
            return nil
        } catch let error as ToolError {
            return error
        } catch {
            return .invalidInput(message: String(describing: error))
        }
    }

    static func questions(from input: JSONValue) throws -> [UserQuestion] {
        guard let raw = input["questions"]?.arrayValue, (1...4).contains(raw.count) else {
            throw ToolError.invalidInput(message: "Ask one to four questions.")
        }
        return try raw.enumerated().map { index, item in
            guard let text = item["question"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !text.isEmpty
            else {
                throw ToolError.invalidInput(message: "Question \(index + 1) is empty.")
            }
            guard let rawOptions = item["options"]?.arrayValue, (2...4).contains(rawOptions.count) else {
                throw ToolError.invalidInput(message: "Question \(index + 1) needs two to four options.")
            }
            var labels = Set<String>()
            let options = try rawOptions.map { option -> UserQuestionOption in
                guard let label = option["label"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines),
                      !label.isEmpty
                else {
                    throw ToolError.invalidInput(message: "Question \(index + 1) has an option without a label.")
                }
                guard labels.insert(label.lowercased()).inserted else {
                    throw ToolError.invalidInput(message: "Question \(index + 1) offers \"\(label)\" twice.")
                }
                let detail = option["description"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
                return UserQuestionOption(label: label, description: detail?.isEmpty == false ? detail : nil)
            }
            let header = item["header"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
            return UserQuestion(
                id: "q\(index + 1)",
                question: text,
                header: header?.isEmpty == false ? header : nil,
                options: options,
                allowsMultipleSelection: item["multiSelect"]?.boolValue ?? false
            )
        }
    }

    public func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        let asked = try Self.questions(from: input)
        let resolution = await questions.ask(asked, toolCallID: context.toolCallID)
        switch resolution {
        case let .answered(answers):
            let byID = Dictionary(answers.map { ($0.questionID, $0) }, uniquingKeysWith: { first, _ in first })
            let lines = asked.map { question -> String in
                guard let answer = byID[question.id] else {
                    return "\(question.question)\n→ (no answer)"
                }
                var parts: [String] = []
                if !answer.selectedOptions.isEmpty {
                    parts.append(answer.selectedOptions.joined(separator: ", "))
                }
                if let text = answer.text {
                    parts.append(answer.selectedOptions.isEmpty ? "\"\(text)\"" : "and wrote: \"\(text)\"")
                }
                return "\(question.question)\n→ \(parts.joined(separator: " "))"
            }
            return ToolResult(content: "The reader answered:\n\n" + lines.joined(separator: "\n\n"))
        case .declined:
            return ToolResult(
                content: "The reader chose not to answer. Go on with your best judgement and say what you assumed, or ask differently if you cannot."
            )
        case .expired:
            return ToolResult(
                content: "No answer came within \(Int(QuestionCoordinator.timeToLiveSeconds / 60)) minutes. Go on with your best judgement and say what you assumed.",
                isError: true
            )
        case .cancelled:
            throw ToolError.cancelled
        }
    }
}

/// Plan mode's handoff: the plan goes to the reader, who approves it into a
/// Code turn at the permission level they choose, or sends it back.
public struct ExitPlanTool: CodeTool {
    private let questions: QuestionCoordinator

    public init(questions: QuestionCoordinator) {
        self.questions = questions
    }

    public static let maximumPlanCharacters = 40_000

    public let name = "exit_plan"
    public let description = """
        Present your finished plan for the reader to approve. Call it once, \
        when the plan is complete: the ordered steps, the files each touches, \
        risks, and how the result will be verified, in Markdown.

        If the reader approves, this planning turn ends and Juno switches to \
        Code at the permission level they choose, then implements the plan in \
        a new turn. If they want changes, you get their feedback: revise and \
        call exit_plan again. Do not use it to ask questions (use ask_user) or \
        outside Plan mode.
        """
    public var inputSchema: JSONValue {
        [
            "type": "object",
            "properties": [
                "plan": ["type": "string", "description": "The plan, in Markdown"],
            ],
            "required": ["plan"],
        ]
    }

    public func assessRisk(input: JSONValue) -> ActionRisk { .read }

    public func summary(input: JSONValue) -> String { "Present the plan for approval" }

    public func precheck(input: JSONValue) -> ToolError? {
        guard let plan = input["plan"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines),
              !plan.isEmpty
        else {
            return .invalidInput(message: "The plan is empty.")
        }
        guard plan.count <= Self.maximumPlanCharacters else {
            return .invalidInput(message: "Keep the plan under \(Self.maximumPlanCharacters) characters.")
        }
        return nil
    }

    public func execute(input: JSONValue, context: ToolContext) async throws -> ToolResult {
        guard let plan = input["plan"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines),
              !plan.isEmpty
        else {
            throw ToolError.invalidInput(message: "The plan is empty.")
        }
        switch await questions.submitPlan(plan, toolCallID: context.toolCallID) {
        case let .approved(mode):
            return ToolResult(
                content: "The reader approved the plan. This planning turn ends here; Juno switches to Code (\(Self.modeName(mode))) and implements the plan in the next turn. Do not reply further.",
                endsRun: "Plan approved"
            )
        case let .keepPlanning(feedback):
            let note = feedback.map { "The reader wants changes:\n\n\($0)\n\n" } ?? "The reader wants to keep planning. "
            return ToolResult(content: note + "Revise the plan, then call exit_plan again when it is ready.")
        case .expired:
            return ToolResult(
                content: "The plan was not approved within \(Int(QuestionCoordinator.timeToLiveSeconds / 60)) minutes. Summarise it in your reply so the reader can act on it later.",
                isError: true
            )
        case .cancelled:
            throw ToolError.cancelled
        }
    }

    static func modeName(_ mode: PermissionMode) -> String {
        switch mode {
        case .readOnly: "read-only"
        case .askBeforeChanges: "asking before every edit and command"
        case .workspaceWrite: "editing files freely, asking before commands"
        case .fullAccess: "full access"
        }
    }
}

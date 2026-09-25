import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync

/// Turning a task that worked into a skill — the web's `capture-skill.tsx`
/// drafting rules, and the one call that saves it.
///
/// **It is a draft, not an automation.** Juno proposes a name, a one-line
/// description and instructions built from the steps the run actually took;
/// the reader edits them and presses a button. Nothing is created, enabled or
/// made auto-selectable without that press.
public enum WorkSkillDraft {
    /// The web's `MAX_SKILL_SLUG_CHARS`.
    public static let maximumSlugCharacters = 64

    /// Whether a run is worth offering to capture: completed, with at least
    /// two plan steps done. A failed run's steps record something that did not
    /// work, and a one-step task is a sentence, not a skill.
    public static func canCapture(status: JunoWorkStatus, plan: [WorkEventLog.PlanStep]) -> Bool {
        status == .completed && plan.filter { $0.state == .done }.count >= 2
    }

    /// `draftName`: the task's title when it has a real one, otherwise the
    /// goal, shortened. Never the whole goal.
    public static func name(title: String, goal: String) -> String {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty, trimmed.lowercased() != "untitled task" {
            return trimmed.count > 60
                ? String(trimmed.prefix(60)).trimmingTrailingWhitespace() : trimmed
        }
        let flat = collapseWhitespace(goal)
        return flat.count > 60 ? String(flat.prefix(57)).trimmingTrailingWhitespace() + "…" : flat
    }

    /// `draftDescription`: the goal's first sentence, at most 180 characters —
    /// the line a future goal is matched against, so it reads like the job
    /// rather than like this run of it.
    public static func description(goal: String) -> String {
        let flat = collapseWhitespace(goal)
        let first = firstSentence(flat)
        return first.count > 180 ? String(first.prefix(177)) + "…" : first
    }

    /// `draftInstructions`: the goal, the steps it finished, numbered, and at
    /// most six things it needed to do last time.
    public static func instructions(
        goal: String, plan: [WorkEventLog.PlanStep], performed: WorkEventLog.PerformedActions
    ) -> String {
        var lines = [goal.trimmingCharacters(in: .whitespacesAndNewlines), "", "Steps:"]
        for (index, step) in plan.filter({ $0.state == .done }).enumerated() {
            lines.append("\(index + 1). \(step.title)")
        }
        if !performed.actions.isEmpty {
            lines.append("")
            lines.append("Last time this needed to:")
            for action in performed.actions.prefix(6) {
                lines.append("- \(action.summary)")
            }
        }
        return lines.joined(separator: "\n")
    }

    /// `skillSlugFromName`: lowercase letters and digits joined by single
    /// hyphens, at most 64 characters, or nil when nothing usable survives.
    public static func slug(fromName name: String) -> String? {
        var slug = ""
        var pendingHyphen = false
        for character in name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
            if character.isASCII, character.isLetter || character.isNumber {
                if pendingHyphen, !slug.isEmpty { slug.append("-") }
                pendingHyphen = false
                slug.append(character)
            } else {
                pendingHyphen = true
            }
        }
        guard !slug.isEmpty else { return nil }
        var truncated = String(slug.prefix(maximumSlugCharacters))
        while truncated.hasSuffix("-") { truncated.removeLast() }
        return truncated.isEmpty ? nil : truncated
    }

    /// The hint under Name.
    public static func slugHint(_ slug: String?) -> String {
        slug.map { "You will type /\($0) to use it." }
            ?? "Give it a name with at least one letter or number in it."
    }

    private static func collapseWhitespace(_ text: String) -> String {
        text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }

    /// Up to and including the first `.`, `!` or `?` that a space follows.
    private static func firstSentence(_ text: String) -> String {
        var index = text.startIndex
        while index < text.endIndex {
            let next = text.index(after: index)
            if ".!?".contains(text[index]), next < text.endIndex, text[next].isWhitespace {
                return String(text[...index])
            }
            index = next
        }
        return text
    }

    // MARK: Copy (the web's, verbatim)

    public static let sheetTitle = "Save this task as a skill"
    public static let sheetDescription = "Juno has drafted this from the steps it actually took. Change anything you like — it is saved exactly as it reads here, and nothing runs until you ask for it by name."
    public static let descriptionHint = "One line. This is what Juno reads when deciding whether a future task is this job, so describe the job rather than this particular run of it."
    public static let rejected = "Juno wouldn’t accept that. Check the name and try again — nothing was created."
    public static let unreachable = "Couldn’t reach Juno to save this. Nothing was created."
    /// A 409 or 429 that carried no sentence of its own (`refusal` in
    /// `work-transport.tsx`).
    public static let blockedWithoutReason = "Juno cannot run this right now and did not say why. Try again in a moment."
}

private extension String {
    func trimmingTrailingWhitespace() -> String {
        var copy = self
        while let last = copy.last, last.isWhitespace { copy.removeLast() }
        return copy
    }
}

/// Saves a skill (`POST /api/work/skills`) — the capture sheet's one call,
/// and the Skills page's when it is built.
public struct NativeWorkSkillsClient: Sendable {
    public struct Created: Equatable, Sendable {
        public let id: String
        public let slug: String
    }

    /// What a save came to, in the three ways the web tells apart.
    public enum Outcome: Equatable, Sendable {
        case created(Created)
        /// The server refused with a sentence the reader can act on (409/429).
        case blocked(String)
        /// A 400: this client sent something the route will not take.
        case rejected
        /// Anything else: the network, the server, a sign-in.
        case unreachable

        /// The sentence to show under the fields, for anything but success.
        public var message: String? {
            switch self {
            case .created: nil
            case .blocked(let sentence): sentence
            case .rejected: WorkSkillDraft.rejected
            case .unreachable: WorkSkillDraft.unreachable
            }
        }
    }

    private let sender: any NativeAuthenticatedRequestSending

    public init(sender: any NativeAuthenticatedRequestSending) {
        self.sender = sender
    }

    /// Creates a skill from the reader's own words. `origin` is `authored` —
    /// these are their instructions from their own run, reviewed by them —
    /// and `autoSelect` is never on: automatic selection is a decision the
    /// author makes afterwards, once the skill can be read back.
    public func createSkill(
        name: String, description: String, instructions: String,
        projectID: String?, for accountID: AccountID
    ) async -> Outcome {
        var body: [String: JunoJSONValue] = [
            "name": .string(name),
            "description": .string(description),
            "instructions": .string(instructions),
            "origin": .string("authored"),
            "autoSelect": .bool(false),
        ]
        if let projectID, !projectID.isEmpty { body["projectId"] = .string(projectID) }
        let response: HTTPResponse
        do {
            response = try await sender.send(
                try NativeBearerRequest(
                    path: "/api/work/skills",
                    method: .post,
                    headers: try HTTPHeaders([
                        "accept": "application/json", "content-type": "application/json",
                    ]),
                    body: try JSONEncoder().encode(JunoJSONValue.object(body))
                ),
                for: accountID
            )
        } catch {
            return .unreachable
        }
        return Self.outcome(statusCode: response.statusCode, body: response.body)
    }

    /// The route's answer, as the web's `refusal` reads it.
    static func outcome(statusCode: Int, body: Data) -> Outcome {
        let root: [String: JunoJSONValue]? = {
            guard let value = try? JSONDecoder().decode(JunoJSONValue.self, from: body),
                case .object(let object) = value
            else { return nil }
            return object
        }()
        if (200...299).contains(statusCode) {
            guard case .object(let skill)? = root?["skill"],
                let id = skill["id"]?.stringValue, let slug = skill["slug"]?.stringValue
            else { return .unreachable }
            return .created(Created(id: id, slug: slug))
        }
        if statusCode == 409 || statusCode == 429 {
            let message = root?["message"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
            return .blocked(message.flatMap { $0.isEmpty ? nil : $0 } ?? WorkSkillDraft.blockedWithoutReason)
        }
        return statusCode == 400 ? .rejected : .unreachable
    }
}

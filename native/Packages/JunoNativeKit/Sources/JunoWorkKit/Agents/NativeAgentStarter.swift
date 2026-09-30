import Foundation
import JunoDesignSystem

/// Starting an agent from one sentence, and saying what the team is doing:
/// the rules of the web's Agents home (`agents-home.tsx`), as pure functions
/// both apps and a test can share.
///
/// A new agent starts from a job described in words. Its name and face are
/// chosen here, before it exists, so the face beside the field is the face the
/// agent will have; then `POST /api/agents` creates it with the job as its
/// starter message, and its thread opens and sets it up in conversation.
public enum NativeAgentStarter {
    /// What the empty field cycles through. Never chips: the field is the page.
    public static let examples = [
        "Keep my inbox at zero and draft the replies I should send",
        "Every Monday, brief me on what my competitors shipped",
        "Watch flights to Tokyo in March and tell me when fares drop",
        "Prepare my week every Sunday evening: calendar, deadlines, travel",
    ]

    /// How long each example stays before the next one, in seconds.
    public static let exampleInterval: TimeInterval = 4.2

    /// The names a new agent can be given. `NAMES`.
    public static let names = ["Nova", "Pip", "Orion", "Wren", "Juno", "Sol", "Ivy", "Kit", "Remy", "Tess", "Arlo", "Nell"]

    /// The one line under the field.
    public static let promise = "It asks before sending, paying or deleting anything."

    /// A face nobody on the team has yet: the least-used tone, a shape nobody
    /// wears, and eyes from the salt. `nextFace`.
    public static func nextFace(team: [NativeAgent], salt: Int) -> JunoAgentAvatar {
        var used: [JunoAgentTone: Int] = [:]
        for agent in team { used[agent.avatar.tone, default: 0] += 1 }
        let fewest = JunoAgentTone.allCases.map { used[$0] ?? 0 }.min() ?? 0
        let quiet = JunoAgentTone.allCases.filter { (used[$0] ?? 0) == fewest }
        let unworn = JunoAgentShape.allCases.filter { shape in !team.contains { $0.avatar.shape == shape } }
        return JunoAgentAvatar(
            shape: pick(unworn.isEmpty ? JunoAgentShape.allCases : unworn, salt * 7 + team.count),
            tone: pick(quiet, salt * 3 + 1),
            eyes: pick(JunoAgentEyes.allCases, salt + team.count * 5),
            mark: JunoAgentMark.none
        )
    }

    /// A name nobody on the team has. `nextName`.
    public static func nextName(team: [NativeAgent], salt: Int) -> String {
        let free = names.filter { name in !team.contains { $0.name == name } }
        return pick(free.isEmpty ? names : free, salt)
    }

    /// The request that starts an agent on `job`: the blank starting point,
    /// the chosen name and face, the job as its first message, and the key
    /// that makes a retry land on the same agent. `agentStarterInput(custom)`
    /// plus the four fields the home adds.
    public static func draft(
        job: String,
        name: String,
        avatar: JunoAgentAvatar,
        creationKey: String
    ) -> NativeAgentDraft {
        let custom = NativeAgentTemplate.named("custom") ?? NativeAgentTemplate.all[0]
        var draft = NativeAgentDraft.conversationStarter(custom)
        draft.name = name
        draft.avatar = avatar
        draft.creationKey = creationKey
        draft.starterMessage = job.trimmingCharacters(in: .whitespacesAndNewlines)
        return draft
    }

    /// "Mira needs you. Scout is working." Only what is happening, in plain
    /// words; "Everyone is caught up." when nothing is. `TeamSentence`.
    public static func teamSentence(_ agents: [NativeAgent]) -> String {
        let waiting = agents.filter(\.needsPerson)
        let busy = agents.filter { $0.state == .working || $0.state == .thinking }
        var parts: [String] = []
        if !waiting.isEmpty {
            parts.append("\(names(of: waiting)) \(waiting.count == 1 ? "needs" : "need") you.")
        }
        if !busy.isEmpty {
            parts.append("\(names(of: busy)) \(busy.count == 1 ? "is" : "are") working.")
        }
        return parts.isEmpty ? "Everyone is caught up." : parts.joined(separator: " ")
    }

    /// The team in the order a person scans it: waiting on you first, then
    /// busy, then done, idle and asleep; pinned ahead within each; then the
    /// order they were hired in. `sortRosterAgents`.
    public static func sorted(_ agents: [NativeAgent]) -> [NativeAgent] {
        agents.enumerated()
            .sorted { lhs, rhs in
                let left = rank(lhs.element.state)
                let right = rank(rhs.element.state)
                if left != right { return left < right }
                if lhs.element.isPinned != rhs.element.isPinned { return lhs.element.isPinned }
                if lhs.element.sortOrder != rhs.element.sortOrder {
                    return lhs.element.sortOrder < rhs.element.sortOrder
                }
                return lhs.offset < rhs.offset
            }
            .map(\.element)
    }

    /// The quiet line under a card's sentence: what the sentence does not
    /// say. When it last did something, what it does next, or how to resume.
    public static func footnote(for agent: NativeAgent, now: Date = Date()) -> String? {
        if let task = agent.task {
            if let at = task.lastActivityAt { return "Active \(NativeAgentFormat.ago(at, now: now))" }
            return nil
        }
        if let next = agent.nextRoutine, agent.state != .idle, let at = next.nextRunAt {
            return "Next: \(next.name), \(NativeAgentFormat.upcoming(at, now: now))"
        }
        if agent.isPaused { return "Resume it from the menu" }
        return nil
    }

    /// `RANK` in agents-home.tsx.
    static func rank(_ state: JunoAgentState) -> Int {
        switch state {
        case .waiting, .blocked: 0
        case .working, .thinking: 1
        case .done: 2
        case .idle, .listening: 3
        case .sleeping: 4
        }
    }

    private static func names(of list: [NativeAgent]) -> String {
        switch list.count {
        case 1: list[0].name
        case 2: "\(list[0].name) and \(list[1].name)"
        default: "\(list[0].name) and \(list.count - 1) others"
        }
    }

    private static func pick<T>(_ list: [T], _ n: Int) -> T {
        list[abs(n) % list.count]
    }
}

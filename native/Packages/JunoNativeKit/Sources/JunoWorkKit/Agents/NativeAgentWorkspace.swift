import Foundation
import JunoDesignSystem

public enum NativeAgentControlCopy {
    public static let pauseLabel = "Pause future work"
    public static let resumeLabel = "Resume agent"
    public static let pauseHint = "Pauses routines and new work. Stop an active task from its chat."
    public static let resumeHint = "Allows new work and restores routines paused with this agent."
    public static let paused = "Paused for new work. Stop active tasks from their chats."
    public static let resumed = "Ready for new work."
}

public struct NativeAgentSetupStep: Identifiable, Sendable {
    public let id: String
    public let title: String
    public let detail: String

    public static let all: [NativeAgentSetupStep] = [
        .init(id: "job", title: "Start with one useful task", detail: "Describe a clear outcome, or choose a starter below."),
        .init(id: "workspace", title: "Choose where it works", detail: "Select cloud tools or a connected Mac in the composer."),
        .init(id: "control", title: "Stay in control", detail: "Review requests and results in your agent’s chat."),
    ]
}

/// The web roster's query and filters, shared by iPhone and Mac.
public enum NativeAgentRosterFilter: String, CaseIterable, Identifiable, Sendable {
    case all, working, attention, paused

    public var id: String { rawValue }
    public var title: String {
        switch self {
        case .all: "All agents"
        case .working: "Working"
        case .attention: "Needs you"
        case .paused: "Paused"
        }
    }

    public func matches(_ agent: NativeAgent) -> Bool {
        switch self {
        case .all: true
        case .working: !agent.isPaused && (agent.state == .working || agent.state == .thinking)
        case .attention: agent.needsPerson
        case .paused: agent.isPaused
        }
    }

    public func apply(to agents: [NativeAgent], query: String) -> [NativeAgent] {
        let words = query.lowercased().split(whereSeparator: \.isWhitespace)
        return agents.filter { agent in
            guard matches(agent) else { return false }
            let text = [agent.name, agent.role, agent.task?.title ?? ""].joined(separator: " ").lowercased()
            return words.allSatisfy { text.contains($0) }
        }
    }
}

public struct NativeAgentJobSuggestion: Identifiable, Equatable, Sendable {
    public let id: UUID
    public let prompt: String

    public init(prompt: String) {
        id = UUID()
        self.prompt = prompt
    }
}

public struct NativeOrbitCapability: Identifiable, Sendable {
    public let id: String
    public let title: String
    public let detail: String
    public let icon: JunoIcon
    public let prompt: String

    /// These populate a draft. They never create an agent or grant a tool permission.
    public static let all: [NativeOrbitCapability] = [
        .init(id: "research", title: "Research & browse", detail: "Find sources. Bring back answers.", icon: .research, prompt: "Research topics for me, compare reliable sources, and prepare clear reports with citations."),
        .init(id: "computer", title: "Use a Linux computer", detail: "A desktop for hands-on work.", icon: .monitor, prompt: "Help me set up your Linux computer, then use the browser, terminal, and files to carry out tasks. Ask me what to work on first."),
        .init(id: "create", title: "Write & create", detail: "Turn an idea into a finished draft.", icon: .image, prompt: "Help me write and create polished documents, presentations, images, and other content. Ask about my first project and the tools available."),
        .init(id: "code", title: "Build & run code", detail: "Go from a problem to a working result.", icon: .terminal, prompt: "Help me build software, run code, diagnose errors, and verify the result. Ask me about the project and execution environment first."),
        .init(id: "schedule", title: "Work on a schedule", detail: "Keep recurring work moving.", icon: .clock, prompt: "Help me set up a recurring routine. Ask what I want done, how often, and my timezone before scheduling it."),
        .init(id: "apps", title: "Connect your apps", detail: "Work with the tools you already use.", icon: .connections, prompt: "Help me work across my connected apps. First check which connections are available and help me choose a useful workflow."),
    ]
}

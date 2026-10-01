import Foundation
import JunoCodeCore
import JunoCodeLocal
import JunoCodeRuntime

// The slash verbs Lane F left for the other lanes to take over (CODE_AGENT_SPEC
// §6.6, `SlashCommandRoutes`), bound at integration:
//
// - `/goal` is Lane A's goal model: the start card, Pause, Resume, the sheet
//   and Clear act on the session's `GoalRun`, never the step-based goal the
//   fallback wrote (two goals would disagree about the session's contract).
// - `/fork` is Lane E's fork from the session's workbench (any message, or a
//   worktree of its own from the session menu); the conversation-only copy
//   stays the fallback where no workbench holds the session.
//
// `/verify` keeps Lane F's handler, which runs each check through `run_tests`
// and the session's approvals; its commands now come from Lane B's recipe
// (`SessionController+Commands.commandCheckCommands`). `/review` keeps Lane
// F's handler, which hands the diff to Lane B's built-in `reviewer`.
//
// A route changes what a verb does, never whether it is allowed: every one
// goes through the same controller paths, approvals included.

extension SessionController {
    /// Installs the routes once per session.
    func installLaneRoutes() {
        guard commands.routes.goal == nil else { return }
        commands.routes.goal = { [weak self] intent, _, _ in
            guard let self else { return }
            await self.goal.perform(GoalCommand(intent))
        }
        commands.routes.fork = { [weak self] prompt, host, _ in
            guard let self else { return }
            if let problem = await self.forkFromCommand(prompt: prompt) {
                host.commandNotice(problem)
            }
        }
    }

    /// `/fork [prompt]`: Lane E's fork of the whole conversation into a new
    /// session, opened, with `prompt` waiting in its composer.
    func forkFromCommand(prompt: String?) async -> String? {
        guard reviewQueue.sessionActions != nil else {
            return await commandFork(prompt: prompt)
        }
        guard let fork = await fork(throughTurn: nil, inNewWorktree: false) else {
            return reviewQueue.message ?? "Could not fork the session."
        }
        if let prompt, !prompt.isEmpty {
            PendingForkPrompts.shared.set(prompt, for: fork.id)
        }
        NotificationCenter.default.post(name: .junoCodeOpenSession, object: fork.id)
        transientError = "Forked into “\(fork.title)”."
        return nil
    }
}

extension GoalCommand {
    /// The goal model's command for a parsed `/goal`.
    init(_ intent: SlashCommandIntent.Goal) {
        switch intent {
        case let .set(objective): self = .set(objective: objective)
        case .show: self = .showSheet
        case .pause: self = .pause
        case .resume: self = .resume
        case .edit: self = .edit
        case .clear: self = .clear
        }
    }
}

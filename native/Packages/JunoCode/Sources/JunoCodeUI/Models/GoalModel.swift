import Foundation
import Observation
import JunoCodeCore

/// What the reader can ask of a goal: `/goal <objective>`, `/goal` (the
/// sheet), `/goal pause`, `/goal resume`, `/goal edit`, `/goal clear` and its
/// aliases `stop`, `off` and `cancel` (§2.8).
public enum GoalCommand: Equatable, Sendable {
    case set(objective: String)
    case showSheet
    case pause
    case resume
    case edit
    case clear

    /// The command `/goal <argument>` stands for.
    public static func parse(_ argument: String) -> GoalCommand {
        let trimmed = argument.trimmingCharacters(in: .whitespacesAndNewlines)
        switch trimmed.lowercased() {
        case "": return .showSheet
        case "pause": return .pause
        case "resume", "continue": return .resume
        case "edit": return .edit
        case "clear", "stop", "off", "cancel": return .clear
        default: return .set(objective: trimmed)
        }
    }
}

/// What the goal model asks the session to do. `SessionController` is the
/// host; tests can stand in for it.
@MainActor
public protocol GoalModelHost: AnyObject {
    /// Drafts the start card for `objective`: criteria from the judge's
    /// model, the default budget, and the checks a grant could cover.
    func draftGoal(objective: String, origin: GoalOrigin) async -> GoalDraft
    /// Starts the goal Start was pressed on, then its first turn.
    func startGoal(_ draft: GoalDraft) async throws
    func pauseGoal() async throws
    /// Resume, or Keep going after a budget: the goal is active and the
    /// session carries on.
    func resumeGoal() async throws
    func editGoal(_ draft: GoalDraft) async throws
    func clearGoal() async throws
    func dismissGoalProposal() async
    func reloadGoals() async -> GoalFile
}

/// A session's goal as the reader sees it: the progress row above the
/// composer, the goal sheet and the start card read it, and `/goal` and its
/// subcommands act through it (CODE_AGENT_SPEC §2).
///
/// Owned by Lane A (loop, stop check and goal).
@MainActor
@Observable
public final class GoalModel {
    /// The current goal, as stored.
    public private(set) var current: GoalRun?
    /// A goal the model suggested and the reader has not started.
    public private(set) var proposal: GoalRun?
    /// Past goals, newest last.
    public private(set) var history: [GoalRun] = []
    /// The start card, while it is showing: drafted from `/goal <objective>`,
    /// a model proposal, or Edit.
    public var draft: GoalDraft?
    /// Whether the start card is editing the current goal rather than
    /// starting one.
    public private(set) var draftEditsCurrent = false
    /// The criteria are being drafted.
    public private(set) var isDrafting = false
    public var isSheetPresented = false
    /// Why the last action did not happen, in words.
    public var errorMessage: String?
    /// Whether a run is working right now: the row glows only then.
    public var isWorking = false

    @ObservationIgnored weak var host: (any GoalModelHost)?

    /// Whether Start replaces a goal that is still open; the start card says
    /// so ("Replace the current goal?") and the old one moves to history.
    public var startReplacesCurrent: Bool {
        guard draft != nil, !draftEditsCurrent, let current else { return false }
        return !current.status.isFinal
    }

    public init() {}

    /// Installs what the store holds.
    public func apply(_ file: GoalFile) {
        current = file.current?.status == .cleared ? nil : file.current
        proposal = file.proposal
        history = file.history
        if draft == nil, let proposal, !draftEditsCurrent {
            draft = GoalDraft(
                objective: proposal.objective,
                criteria: proposal.criteria,
                constraints: proposal.constraints,
                budget: proposal.budget,
                origin: .proposedByModel
            )
        }
    }

    /// Reads the store again.
    public func refresh() async {
        guard let host else { return }
        apply(await host.reloadGoals())
    }

    // MARK: - Commands

    /// Runs `/goal <argument>`. Typing it is the reader's approval of the
    /// goal itself, so no approval card follows; the start card asks only
    /// for the one click that starts it.
    public func perform(_ command: GoalCommand) async {
        errorMessage = nil
        guard let host else { return }
        do {
            switch command {
            case let .set(objective):
                // Replacing an open goal is the start card's question
                // (`startReplacesCurrent`), never a silent swap.
                await beginDraft(objective: objective, origin: .reader, host: host)
            case .showSheet:
                isSheetPresented = true
            case .pause:
                guard current != nil else { return note("There is no goal to pause.") }
                try await host.pauseGoal()
            case .resume:
                guard current != nil else { return note("There is no goal to resume.") }
                try await host.resumeGoal()
            case .edit:
                guard let current else { return note("There is no goal to edit.") }
                draftEditsCurrent = true
                draft = GoalDraft(
                    objective: current.objective,
                    criteria: current.criteria,
                    constraints: current.constraints,
                    budget: current.budget,
                    origin: current.origin
                )
            case .clear:
                guard current != nil else { return note("There is no goal to clear.") }
                try await host.clearGoal()
                draft = nil
            }
        } catch let error as GoalTransitionError {
            errorMessage = error.message
        } catch {
            errorMessage = "Could not change the goal: \(error.localizedDescription)"
        }
        await refresh()
    }

    /// Start (or Save, when editing) on the start card.
    public func confirmDraft() async {
        guard let host, let draft else { return }
        errorMessage = nil
        do {
            if draftEditsCurrent {
                try await host.editGoal(draft)
            } else {
                try await host.startGoal(draft)
            }
            self.draft = nil
            draftEditsCurrent = false
        } catch let error as GoalTransitionError {
            errorMessage = error.message
        } catch {
            errorMessage = "Could not start the goal: \(error.localizedDescription)"
        }
        await refresh()
    }

    /// Dismiss on the start card: nothing starts.
    public func cancelDraft() async {
        let wasProposal = draft?.origin == .proposedByModel && !draftEditsCurrent
        draft = nil
        draftEditsCurrent = false
        errorMessage = nil
        if wasProposal {
            await host?.dismissGoalProposal()
            await refresh()
        }
    }

    private func beginDraft(objective: String, origin: GoalOrigin, host: any GoalModelHost) async {
        draftEditsCurrent = false
        draft = GoalDraft(objective: objective, origin: origin)
        isDrafting = true
        let drafted = await host.draftGoal(objective: objective, origin: origin)
        isDrafting = false
        // The reader may have dismissed the card while the criteria were
        // being drafted.
        if draft?.objective == objective {
            draft = drafted
        }
    }

    private func note(_ message: String) {
        errorMessage = message
    }

    // MARK: - What the row says

    /// The progress row's words, or nil when there is no goal to show.
    public var row: GoalRowContent? {
        guard let current else { return nil }
        return GoalRowContent(goal: current)
    }
}

/// The progress row above the composer, in words (§2.8):
///
/// > **Goal** Make the settings menu open on click · 2 of 3 criteria · 38 min · turn 7 · $1.12
/// > Checking: c2 has no Preview evidence yet            Pause · Edit · Clear
public struct GoalRowContent: Equatable, Sendable {
    public enum Action: String, Equatable, Sendable {
        case pause = "Pause"
        case resume = "Resume"
        case keepGoing = "Keep going"
        case edit = "Edit"
        case clear = "Clear"
    }

    /// "Make the settings menu open on click and keyboard".
    public var objective: String
    /// "2 of 3 criteria · 38 min · turn 7 · $1.12", or the achieved summary.
    public var facts: String
    /// The second line: what the goal is doing or waiting for.
    public var detail: String?
    public var actions: [Action]
    public var status: GoalStatus

    public init(goal: GoalRun) {
        objective = goal.objective
        status = goal.status
        let met = Self.metCount(goal)
        var facts: [String] = []
        let minutes = Int(goal.usage.minutes.rounded())
        switch goal.status {
        case .achieved:
            facts.append("Goal met in \(minutes) min")
            facts.append("\(goal.usage.turns) turn\(goal.usage.turns == 1 ? "" : "s")")
            if let cost = goal.usage.costUSD { facts.append(Budget.dollars(cost)) }
        default:
            facts.append("\(met) of \(goal.criteria.count) criteria")
            facts.append("\(minutes) min")
            facts.append("turn \(goal.usage.turns)")
            if let cost = goal.usage.costUSD { facts.append(Budget.dollars(cost)) }
        }
        self.facts = facts.joined(separator: " · ")

        switch goal.status {
        case .active:
            detail = goal.lastVerdict.map { verdict in
                verdict.kind == .met ? "Checked: met" : "Checking: \(verdict.reason)"
            }
            actions = [.pause, .edit, .clear]
        case .paused:
            detail = goal.statusReason ?? "Paused"
            actions = [.resume, .edit, .clear]
        case .needsYou:
            detail = goal.statusReason ?? "Waiting for you"
            actions = [.resume, .edit, .clear]
        case .budgetReached:
            detail = goal.statusReason ?? "Used its budget"
            actions = [.keepGoing, .edit, .clear]
        case .achieved:
            detail = nil
            actions = [.clear]
        case .impossible:
            detail = "Cannot be met: \(goal.statusReason ?? goal.lastVerdict?.reason ?? "the judge said so")"
            actions = [.edit, .clear]
        case .cleared:
            detail = nil
            actions = []
        }
    }

    /// Criteria the last verdict did not name as unmet, once a check ran.
    static func metCount(_ goal: GoalRun) -> Int {
        guard let verdict = goal.lastVerdict else { return 0 }
        if verdict.kind == .met || goal.status == .achieved { return goal.criteria.count }
        let unmet = Set(verdict.unmetCriteria)
        guard !unmet.isEmpty else { return 0 }
        return goal.criteria.filter { !unmet.contains($0.id) }.count
    }
}

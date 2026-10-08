import Foundation
import JunoCodeCore

/// The Orchestrate popover's model (DESIGN §5.11; SPEC §3.4, §4).
///
/// A draft the UI edits — preset, worker count, per-role model, budget — and
/// turns into the contract's ``CodeV2/RoleRouting`` when a run starts. The
/// estimate is honest about what it is: a model-based estimate (labelled
/// "estimate") unless the caller has a median of recent runs.
public struct CodeV2RoleDraft: Equatable, Sendable {
    public var preset: CodeV2.RolePreset
    public var lead: CodeV2.ModelSelection
    public var workerCount: Int
    public var worker: CodeV2.ModelSelection
    public var reviewer: CodeV2.ModelSelection?
    public var explorer: CodeV2.ModelSelection?
    public var utility: CodeV2.ModelSelection?
    /// Best of N: one selection per candidate, 2…4.
    public var candidates: [CodeV2.ModelSelection]
    /// Hard stop on Alevr / BYOK spend per run, USD. Nil = no budget.
    public var budgetUsd: Double?

    public static let workerRange = 1...6
    public static let candidateRange = 2...4
    public static let defaultBudgetUsd = 4.0

    public init(
        preset: CodeV2.RolePreset = .solo,
        lead: CodeV2.ModelSelection,
        workerCount: Int = 3,
        worker: CodeV2.ModelSelection? = nil,
        reviewer: CodeV2.ModelSelection? = nil,
        explorer: CodeV2.ModelSelection? = nil,
        utility: CodeV2.ModelSelection? = nil,
        candidates: [CodeV2.ModelSelection]? = nil,
        budgetUsd: Double? = defaultBudgetUsd
    ) {
        self.preset = preset
        self.lead = lead
        self.workerCount = workerCount
        self.worker = worker ?? lead
        self.reviewer = reviewer
        self.explorer = explorer
        self.utility = utility
        self.candidates = candidates ?? [lead, lead, lead]
        self.budgetUsd = budgetUsd
    }

    /// Reads a routing back into a draft (a thread reopened, a web change).
    public init(routing: CodeV2.RoleRouting) {
        self.init(
            preset: routing.preset,
            lead: routing.orchestrator,
            workerCount: max(1, routing.workers?.count ?? 3),
            worker: routing.workers?.first,
            reviewer: routing.reviewer,
            explorer: routing.explorer,
            utility: routing.compaction,
            candidates: routing.preset == .bestOfN ? routing.workers : nil,
            budgetUsd: routing.budget?.maxUsd
        )
    }

    // MARK: Editing

    public mutating func setWorkers(_ count: Int) {
        workerCount = min(Self.workerRange.upperBound, max(Self.workerRange.lowerBound, count))
    }

    public mutating func setCandidateCount(_ count: Int) {
        let target = min(Self.candidateRange.upperBound, max(Self.candidateRange.lowerBound, count))
        while candidates.count < target { candidates.append(candidates.last ?? lead) }
        if candidates.count > target { candidates.removeLast(candidates.count - target) }
    }

    /// Solo follows the composer's own model.
    public mutating func setLead(_ selection: CodeV2.ModelSelection) {
        lead = selection
    }

    // MARK: Output

    public var routing: CodeV2.RoleRouting {
        let budget = budgetUsd.map { CodeV2.RunBudget(maxUsd: $0) }
        switch preset {
        case .solo:
            return CodeV2.RoleRouting(orchestrator: lead, compaction: utility, preset: .solo, budget: budget)
        case .leadWorkers:
            return CodeV2.RoleRouting(
                orchestrator: lead,
                workers: Array(repeating: worker, count: workerCount),
                reviewer: reviewer,
                explorer: explorer,
                compaction: utility,
                preset: .leadWorkers,
                budget: budget
            )
        case .bestOfN:
            return CodeV2.RoleRouting(
                orchestrator: lead, workers: candidates, compaction: utility, preset: .bestOfN, budget: budget
            )
        }
    }

    /// The composer control's label: "Solo", "Lead + 3", "Best of 3".
    public var label: String {
        switch preset {
        case .solo: "Solo"
        case .leadWorkers: "Lead + \(workerCount)"
        case .bestOfN: "Best of \(candidates.count)"
        }
    }

    /// The one plain sentence under the preset (DESIGN §5.11).
    public var explanation: String {
        switch preset {
        case .solo:
            "One agent plans and does the work. Subagents still run when it asks for them."
        case .leadWorkers:
            "The lead plans and delegates. Workers run in parallel, each on its own branch of the plan."
                + (reviewer == nil ? "" : " The reviewer reads every diff before you do.")
        case .bestOfN:
            "One prompt goes to \(candidates.count) models at once. Each runs in its own worktree. You pick one; the others are deleted."
        }
    }

    /// Every role's selection, for estimates and the subscription note.
    public var allSelections: [CodeV2.ModelSelection] {
        switch preset {
        case .solo: [lead]
        case .leadWorkers:
            [lead] + Array(repeating: worker, count: workerCount) + [reviewer, explorer].compactMap { $0 }
        case .bestOfN: candidates
        }
    }
}

/// Run cost estimates for a role draft.
public enum CodeV2RunEstimate {
    /// Token shape of a typical run per role, used when there is no history:
    /// the lead reads the most, workers do most of the output.
    public struct Shape: Equatable, Sendable {
        public var input: Int
        public var output: Int
        public init(input: Int, output: Int) {
            self.input = input
            self.output = output
        }
    }

    public static let leadShape = Shape(input: 160_000, output: 8_000)
    public static let workerShape = Shape(input: 90_000, output: 12_000)
    public static let reviewerShape = Shape(input: 60_000, output: 3_000)
    public static let explorerShape = Shape(input: 50_000, output: 2_000)

    /// Alevr / BYOK dollars for one run. Subscription roles cost nothing here
    /// (they count against the vendor plan, not the budget). `rate` answers
    /// a selection's default tier, or nil when unknown (counted as zero).
    public static func dollars(
        for draft: CodeV2RoleDraft,
        rate: (CodeV2.ModelSelection) -> CodeV2.ContextTier?,
        billsInDollars: (CodeV2.ModelSelection) -> Bool
    ) -> Double {
        func cost(_ selection: CodeV2.ModelSelection, _ shape: Shape) -> Double {
            guard billsInDollars(selection), let tier = rate(selection) else { return 0 }
            return (Double(shape.input) * tier.inputPerMTok + Double(shape.output) * tier.outputPerMTok) / 1_000_000
        }
        switch draft.preset {
        case .solo:
            return cost(draft.lead, leadShape)
        case .leadWorkers:
            var total = cost(draft.lead, leadShape) + Double(draft.workerCount) * cost(draft.worker, workerShape)
            if let reviewer = draft.reviewer { total += cost(reviewer, reviewerShape) * Double(draft.workerCount) }
            if let explorer = draft.explorer { total += cost(explorer, explorerShape) }
            return total
        case .bestOfN:
            return draft.candidates.reduce(0) { $0 + cost($1, leadShape) }
        }
    }

    /// The subscription note under the budget, naming the plans involved, or
    /// nil when every role bills in dollars.
    public static func subscriptionNote(vendorNames: [String]) -> String? {
        let names = Array(NSOrderedSet(array: vendorNames)) as? [String] ?? vendorNames
        guard !names.isEmpty else { return nil }
        let list: String
        switch names.count {
        case 1: list = names[0]
        case 2: list = names[0] + " and " + names[1]
        default: list = names.dropLast().joined(separator: ", ") + " and " + names.last!
        }
        return "Subscription roles count against your \(list) \(names.count == 1 ? "plan" : "plans"), not this budget."
    }
}

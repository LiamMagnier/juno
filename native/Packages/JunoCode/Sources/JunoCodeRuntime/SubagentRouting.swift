import Foundation
import JunoCodeCore

// Role routing and the shared run budget for the Mac engine's sub-agents
// (Alevr Code v2 SPEC §3.3–3.4, §4). The same rules as the cloud runner's
// `runner/agent-core/src/harness/routing.ts` and `budget.ts`, so a session
// routed in the composer behaves the same on either runtime.

/// What a host hands back for one model selection: a client that can serve
/// it, and the model id exactly as that client expects it.
public struct ResolvedSubagentProvider: Sendable {
    public let client: any AgentModelClient
    public let modelID: String
    /// The selected context tier's prices, for the run budget. Nil when the
    /// host does not price this selection (its spend counts in tokens only).
    public let tier: CodeV2.ContextTier?
    /// False when the calls are not billed to Alevr: a BYOK key, the user's
    /// own subscription. Such calls still count against a token budget.
    public let billable: Bool

    public init(
        client: any AgentModelClient,
        modelID: String,
        tier: CodeV2.ContextTier? = nil,
        billable: Bool = true
    ) {
        self.client = client
        self.modelID = modelID
        self.tier = tier
        self.billable = billable
    }
}

/// Turns a selection into a client, or nil when its provider instance is
/// unknown or not ready here.
public typealias SubagentProviderResolver = @Sendable (CodeV2.ModelSelection) -> ResolvedSubagentProvider?

/// Where one child runs.
public struct SubagentRoute: Sendable {
    public let client: any AgentModelClient
    public let modelID: String
    /// The routing entry this route came from, nil when the child inherits.
    public let selection: CodeV2.ModelSelection?
    public let reasoningEffort: ReasoningEffort?
    /// The context window the child is given, from the selection's tier.
    public let contextTokens: Int?
    public let tier: CodeV2.ContextTier?
    public let billable: Bool
    /// A plain-language note when the request could not be honoured as asked.
    public let note: String?
}

/// The session's role routing as the Mac engine reads it.
public struct SubagentRouting: Sendable {
    public var routing: CodeV2.RoleRouting?
    /// How a selection on another provider instance becomes a client. Without
    /// one, only selections the parent's own client can serve are honoured.
    public var resolver: SubagentProviderResolver?

    public init(routing: CodeV2.RoleRouting?, resolver: SubagentProviderResolver? = nil) {
        self.routing = routing
        self.resolver = resolver
    }

    /// The contract role a delegated task reports as. A named agent decides
    /// first (`explorer` explores, `reviewer` and `verifier` review); then the
    /// legacy task role.
    public static func contractRole(agentName: String?, role: AgentRole) -> CodeV2.AgentRole {
        switch agentName?.lowercased() {
        case "explorer"?: return .explorer
        case "reviewer"?, "verifier"?: return .reviewer
        default: break
        }
        return role == .reviewer ? .reviewer : .worker
    }

    /// The routing entry a role reads, round-robin over the workers.
    public static func selection(
        in routing: CodeV2.RoleRouting?,
        for role: CodeV2.AgentRole,
        ordinal: Int = 0
    ) -> CodeV2.ModelSelection? {
        guard let routing else { return nil }
        let workers = routing.workers ?? []
        let worker = workers.isEmpty ? nil : workers[abs(ordinal) % workers.count]
        switch role {
        case .explorer: return routing.explorer ?? worker
        case .reviewer: return routing.reviewer ?? routing.orchestrator
        case .compaction: return routing.compaction
        case .orchestrator: return routing.orchestrator
        case .worker: return worker
        }
    }

    /// The engine's six thinking depths from the contract's seven: `none`
    /// (Instant) sends no thinking parameter at all.
    public static func reasoningEffort(_ effort: CodeV2.EffortLevel?) -> ReasoningEffort? {
        guard let effort, effort != .none else { return nil }
        return ReasoningEffort(rawValue: effort.rawValue)
    }

    /// `provider:model` split; a bare id has no provider.
    static func split(_ model: String) -> (provider: String?, model: String) {
        guard let colon = model.firstIndex(of: ":"), colon != model.startIndex else { return (nil, model) }
        return (String(model[..<colon]), String(model[model.index(after: colon)...]))
    }

    /// Where one child runs.
    ///
    /// Order: an explicit model from the call wins (an agent definition's
    /// model is passed the same way); then the routing entry for the child's
    /// role; then the parent. A selection nobody here can serve falls back to
    /// the parent's model and says so, rather than failing the child.
    public func route(
        requestedModelID: String?,
        requestedEffort: ReasoningEffort?,
        role: CodeV2.AgentRole,
        ordinal: Int,
        parentClient: any AgentModelClient,
        parentModelID: String,
        parentEffort: ReasoningEffort?
    ) -> SubagentRoute {
        func inherit(note: String? = nil) -> SubagentRoute {
            SubagentRoute(
                client: parentClient,
                modelID: parentModelID,
                selection: nil,
                reasoningEffort: requestedEffort ?? parentEffort,
                contextTokens: nil,
                tier: nil,
                billable: true,
                note: note
            )
        }
        if let requested = requestedModelID?.trimmingCharacters(in: .whitespacesAndNewlines), !requested.isEmpty {
            if ["inherit", "same", "default", "auto", "parent"].contains(requested.lowercased()) {
                return inherit()
            }
            // An explicit id on the parent's own instance: the parent's client
            // serves it, as it always has.
            let instanceID = routing?.orchestrator.instanceId ?? "alevr"
            let selection = CodeV2.ModelSelection(instanceId: instanceID, model: requested)
            if let resolver, let resolved = resolver(selection) {
                return SubagentRoute(
                    client: resolved.client,
                    modelID: resolved.modelID,
                    selection: selection,
                    reasoningEffort: requestedEffort ?? parentEffort,
                    contextTokens: nil,
                    tier: resolved.tier,
                    billable: resolved.billable,
                    note: nil
                )
            }
            return SubagentRoute(
                client: parentClient,
                modelID: requested,
                selection: nil,
                reasoningEffort: requestedEffort ?? parentEffort,
                contextTokens: nil,
                tier: nil,
                billable: true,
                note: nil
            )
        }
        guard let selection = Self.selection(in: routing, for: role, ordinal: ordinal) else {
            return inherit()
        }
        let effort = requestedEffort ?? Self.reasoningEffort(selection.effort) ?? parentEffort
        if let resolver, let resolved = resolver(selection) {
            return SubagentRoute(
                client: resolved.client,
                modelID: resolved.modelID,
                selection: selection,
                reasoningEffort: effort,
                contextTokens: selection.contextTokens,
                tier: resolved.tier,
                billable: resolved.billable,
                note: nil
            )
        }
        // No resolver for it: the parent's client can still run a selection
        // on the parent's own instance, or a bare model of the parent's lab.
        let sameInstance = selection.instanceId == routing?.orchestrator.instanceId
        let wanted = Self.split(selection.model)
        let parentLab = Self.split(parentModelID).provider
        let sameLab = wanted.provider == nil || parentLab == nil || wanted.provider == parentLab
        if resolver == nil || sameInstance, sameLab {
            return SubagentRoute(
                client: parentClient,
                modelID: selection.model,
                selection: selection,
                reasoningEffort: effort,
                contextTokens: selection.contextTokens,
                tier: nil,
                billable: true,
                note: nil
            )
        }
        return inherit(
            note: "\(selection.model) (\(selection.instanceId)) is not available here, so this agent runs on \(parentModelID)."
        )
    }
}

// MARK: - The run budget

/// A hard token and cost budget shared by every child of a run.
///
/// Every call a child makes is charged here as it is reported; once a limit is
/// reached the ledger is exhausted for good, new children are refused and
/// running ones are stopped. A call already in flight when the line is crossed
/// still lands, so a run overshoots by at most one call per running child, and
/// the ledger reports the true total either way.
public actor RunBudgetLedger {
    public struct Snapshot: Equatable, Sendable {
        public let tokens: Int
        public let costUSD: Double
        public let maxTokens: Int?
        public let maxUSD: Double?
        public let exhaustedReason: String?
        public var isExhausted: Bool { exhaustedReason != nil }
    }

    public let limits: CodeV2.RunBudget
    private var tokens = 0
    private var costUSD = 0.0
    private var reason: String?
    private var listeners: [UUID: @Sendable (String) -> Void] = [:]

    public init(limits: CodeV2.RunBudget) {
        self.limits = limits
    }

    /// Nil when there is nothing to enforce.
    public static func make(for routing: CodeV2.RoleRouting?) -> RunBudgetLedger? {
        guard let budget = routing?.budget, budget.maxTokens != nil || budget.maxUsd != nil else { return nil }
        return RunBudgetLedger(limits: budget)
    }

    /// Why no more work may start, or nil while the budget lasts.
    public var exhaustedReason: String? { reason }

    public func snapshot() -> Snapshot {
        Snapshot(
            tokens: tokens,
            costUSD: (costUSD * 1_000_000).rounded() / 1_000_000,
            maxTokens: limits.maxTokens,
            maxUSD: limits.maxUsd,
            exhaustedReason: reason
        )
    }

    /// The dollars one call costs at `tier`'s prices.
    public static func cost(
        inputTokens: Int, outputTokens: Int, cacheReadTokens: Int, tier: CodeV2.ContextTier
    ) -> Double {
        let cached = min(max(0, cacheReadTokens), max(0, inputTokens))
        let fresh = max(0, inputTokens) - cached
        let cachedRate = tier.cachedInputPerMTok ?? tier.inputPerMTok
        return (Double(fresh) * tier.inputPerMTok + Double(cached) * cachedRate
            + Double(max(0, outputTokens)) * tier.outputPerMTok) / 1_000_000
    }

    /// Records one call. Answers true when the budget is now exhausted.
    @discardableResult
    public func charge(
        inputTokens: Int,
        outputTokens: Int,
        cacheReadTokens: Int = 0,
        tier: CodeV2.ContextTier? = nil,
        billable: Bool = true
    ) -> Bool {
        tokens += max(0, inputTokens) + max(0, outputTokens)
        if billable, let tier {
            costUSD += Self.cost(
                inputTokens: inputTokens, outputTokens: outputTokens, cacheReadTokens: cacheReadTokens, tier: tier
            )
        }
        if reason == nil {
            if let maxTokens = limits.maxTokens, tokens >= maxTokens {
                reason = "the run's token budget (\(maxTokens.formatted(.number.locale(Locale(identifier: "en_US")))) tokens) was reached"
            } else if let maxUSD = limits.maxUsd, costUSD >= maxUSD {
                reason = "the run's cost budget ($\(String(format: "%.2f", maxUSD))) was reached"
            }
            if let reason {
                for listener in listeners.values { listener(reason) }
            }
        }
        return reason != nil
    }

    /// Told once, when the budget runs out. Answers a token for ``removeListener(_:)``.
    public func onExhausted(_ listener: @escaping @Sendable (String) -> Void) -> UUID {
        let id = UUID()
        if let reason {
            listener(reason)
        } else {
            listeners[id] = listener
        }
        return id
    }

    public func removeListener(_ id: UUID) {
        listeners.removeValue(forKey: id)
    }
}

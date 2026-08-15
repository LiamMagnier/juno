import Foundation

/// What a turn is actually asking for, in the only terms a router can act on.
///
/// Deliberately about the WORK, not about a model: "this is a title" is a fact
/// the caller knows for certain, while "this needs Haiku" is a decision that
/// depends on the catalog the account can see today. Keeping the enum on the
/// work side is what lets the routing table change without every call site
/// changing with it.
public enum NativeChatTaskClass: String, CaseIterable, Equatable, Sendable {
    /// Naming a conversation from its first turn.
    case conversationTitle
    /// Condensing something already written.
    case summary
    /// A short factual exchange with no tools and no code.
    case simpleQuestion
    /// Follow-up suggestions, quick rewrites, classification.
    case lightweightAssist
    /// Writing, reading or debugging code.
    case coding
    /// A turn expected to call tools more than once before answering.
    case multiStepTools
    /// Long-form reasoning, analysis, planning.
    case complexReasoning
    /// The default when the caller genuinely cannot say.
    case general
}

/// The two service levels Juno routes between.
public enum NativeModelTier: String, CaseIterable, Equatable, Sendable {
    /// Cheap and quick: titles, summaries, simple questions.
    case fast
    /// Slower and stronger: code, tools, sustained reasoning.
    case deep
}

/// How the router should behave, as the reader configured it.
public enum NativeModelRoutingPreference: Equatable, Sendable {
    /// Pick per turn from the task class.
    case automatic
    /// Always use this model. The reader chose it and the router must not
    /// second-guess them — a lock that silently re-routed would make the
    /// picker a suggestion box.
    case manualLock(modelID: String)

    public var isAutomatic: Bool {
        if case .automatic = self { return true }
        return false
    }
}

/// What the composer knows about a turn at the moment Send is pressed.
///
/// Only facts already on screen — no lookahead, no extra request. A router that
/// had to ask a model what kind of turn this is would pay for a model call to
/// decide which model to call.
public struct NativeComposerSignals: Equatable, Sendable {
    public let prompt: String
    public let hasAttachments: Bool
    public let deepResearch: Bool
    public let webSearch: Bool
    public let connectorCount: Int

    public init(
        prompt: String,
        hasAttachments: Bool = false,
        deepResearch: Bool = false,
        webSearch: Bool = false,
        connectorCount: Int = 0
    ) {
        self.prompt = prompt
        self.hasAttachments = hasAttachments
        self.deepResearch = deepResearch
        self.webSearch = webSearch
        self.connectorCount = connectorCount
    }
}

/// Guesses what a composed turn is for.
///
/// **Biased towards `.deep` on purpose, and the bias is the design.** Every rule
/// below either proves a turn is disposable or gives up and says `.general`,
/// which the default policy routes deep. Guessing "simple" wrongly downgrades an
/// answer the reader is relying on, and they cannot see why it got worse;
/// guessing "complex" wrongly costs a fraction of a cent. Those two errors are
/// not worth trading against each other symmetrically.
public enum NativeChatTaskClassifier {
    /// Fences, or the shape of a shell/diff/stack-trace paste.
    private static let codeMarkers = ["```", "func ", "class ", "def ", "import ",
                                      "SELECT ", "npm ", "git ", "=>", "();"]

    /// Above this, a prompt is doing more than asking a quick question.
    private static let shortPromptCharacterCeiling = 160

    public static func classify(_ signals: NativeComposerSignals) -> NativeChatTaskClass {
        // Any tool axis means at least one extra round trip before an answer —
        // exactly the case the deep tier exists for.
        if signals.deepResearch || signals.webSearch || signals.connectorCount > 0 {
            return .multiStepTools
        }
        let prompt = signals.prompt
        if codeMarkers.contains(where: { prompt.localizedCaseInsensitiveContains($0) }) {
            return .coding
        }
        // An attachment is a document to reason over, not a quick question, and
        // the fast tier is the wrong place to read someone's contract.
        if signals.hasAttachments { return .general }

        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        // Multi-line means structure — a list, a spec, a pasted block.
        guard !trimmed.contains("\n"),
              trimmed.count <= shortPromptCharacterCeiling
        else { return .general }

        return .simpleQuestion
    }
}

/// Maps work onto a tier. Separate protocol so the table is mockable and so a
/// server-published policy can replace the built-in one without touching the
/// selection logic below.
public protocol NativeModelTierResolving: Sendable {
    func tier(for task: NativeChatTaskClass) -> NativeModelTier
}

/// The built-in table.
///
/// The split follows COST OF BEING WRONG, not raw difficulty. A bad title is
/// re-rolled in a second; a bad refactor is discovered three files later. So
/// anything whose output the reader will build on goes deep even when it looks
/// small, and only the genuinely disposable work goes fast.
public struct NativeDefaultModelTierPolicy: NativeModelTierResolving {
    public init() {}

    public func tier(for task: NativeChatTaskClass) -> NativeModelTier {
        switch task {
        case .conversationTitle, .summary, .simpleQuestion, .lightweightAssist:
            return .fast
        case .coding, .multiStepTools, .complexReasoning:
            return .deep
        case .general:
            // The unknown case goes deep. Routing an unclassified turn to the
            // fast tier optimises the bill at the reader's expense, and the
            // reader is the one who cannot see why the answer got worse.
            return .deep
        }
    }
}

/// What the router decided, and why.
///
/// The reason travels with the choice so the UI can explain a swap. A model
/// that changes under the reader without explanation is the single most
/// distrusted behaviour an auto-router has.
public struct NativeModelRoutingDecision: Equatable, Sendable {
    public enum Reason: Equatable, Sendable {
        /// The reader locked this model.
        case manualLock
        /// Routed by task class.
        case automatic(task: NativeChatTaskClass, tier: NativeModelTier)
        /// The requested tier had no available model, so the other tier served.
        case tierUnavailable(requested: NativeModelTier, served: NativeModelTier)
        /// Nothing in the catalog could serve; the caller's fallback is used.
        case fallback
    }

    public let modelID: String
    public let reason: Reason

    public init(modelID: String, reason: Reason) {
        self.modelID = modelID
        self.reason = reason
    }

    /// True when the router picked something other than what the reader last
    /// saw selected — the condition worth surfacing in the composer.
    public func isSwap(from selected: String?) -> Bool {
        guard let selected else { return false }
        return selected != modelID
    }
}

/// Chooses a model for a turn from the catalog the account can actually call.
///
/// Note this is the CLIENT's router and is a different thing from the server's
/// `Auto` model: Auto is one catalog entry that routes inside a single request,
/// after Juno has already been paid for a chat turn. This router chooses which
/// entry to request in the first place, which is the only place a client can
/// avoid sending a title-generation turn to a reasoning model.
public struct ModelTierRouter: Sendable {
    /// The published speed grade a model must reach to count as fast-tier.
    ///
    /// Without a floor, "fast tier" degrades into "whichever model is least
    /// slow", and a catalog containing only a reasoning model would route a
    /// conversation title to it while reporting the turn as fast-tier — the
    /// tier label would be describing the sort order rather than the service
    /// level, and ``NativeModelRoutingDecision/Reason/tierUnavailable`` could
    /// never occur.
    ///
    /// 6 on the server's 1–10 scale: above the midpoint, so a model in the
    /// slower half is never mistaken for a cheap one. A catalog with nothing
    /// this quick genuinely has no fast tier, and the router says so.
    public static let fastTierMinimumSpeed = 6

    private let policy: any NativeModelTierResolving

    public init(policy: any NativeModelTierResolving = NativeDefaultModelTierPolicy()) {
        self.policy = policy
    }

    /// Picks a model.
    ///
    /// - Parameters:
    ///   - task: what the turn is for.
    ///   - preference: automatic, or a reader-chosen lock.
    ///   - catalog: models as the server published them for this account.
    ///   - fallback: used only when nothing in the catalog is selectable. Kept
    ///     as a parameter rather than a hardcoded id so this type never names a
    ///     model — the catalog is the only source of those.
    public func route(
        task: NativeChatTaskClass,
        preference: NativeModelRoutingPreference,
        catalog: NativeChatModelCatalog,
        fallback: String
    ) -> NativeModelRoutingDecision {
        // A lock is honoured verbatim, and deliberately WITHOUT checking the
        // catalog. If the reader's model has gone unavailable the server's own
        // error names it, which is a better failure than the client silently
        // substituting a different model behind an explicit choice.
        if case .manualLock(let modelID) = preference {
            return NativeModelRoutingDecision(modelID: modelID, reason: .manualLock)
        }

        let wanted = policy.tier(for: task)
        if let match = bestModel(for: wanted, in: catalog) {
            return NativeModelRoutingDecision(
                modelID: match.id,
                reason: .automatic(task: task, tier: wanted)
            )
        }

        // The wanted tier is empty for this account — a free plan with no fast
        // models, say. Serving from the other tier is better than failing, but
        // it is recorded as a substitution so the UI can say so.
        let other: NativeModelTier = wanted == .fast ? .deep : .fast
        if let match = bestModel(for: other, in: catalog) {
            return NativeModelRoutingDecision(
                modelID: match.id,
                reason: .tierUnavailable(requested: wanted, served: other)
            )
        }

        return NativeModelRoutingDecision(modelID: fallback, reason: .fallback)
    }

    /// Routes from a bare model list.
    ///
    /// The conversation model publishes `[NativeChatModelOption]`, not the
    /// manifest wrapper. Without this overload every call site would have to
    /// invent a `manifestVersion`, a `contractDigest` and a `generatedAt` purely
    /// to satisfy a parameter the routing never reads — three fabricated values
    /// standing in for provenance the client does not have.
    public func route(
        task: NativeChatTaskClass,
        preference: NativeModelRoutingPreference,
        models: [NativeChatModelOption],
        fallback: String
    ) -> NativeModelRoutingDecision {
        route(
            task: task,
            preference: preference,
            catalog: NativeChatModelCatalog(
                manifestVersion: "",
                contractDigest: "",
                generatedAt: .distantPast,
                models: models
            ),
            fallback: fallback
        )
    }

    /// The models this account may actually send to, in the tier's preferred
    /// order. Exposed for the settings screen, which shows the reader what
    /// automatic routing would pick before they trust it.
    public func candidates(
        for tier: NativeModelTier,
        in catalog: NativeChatModelCatalog
    ) -> [NativeChatModelOption] {
        let selectable = catalog.models.filter { $0.isAvailable && $0.modality == "chat" }
        switch tier {
        case .fast:
            // Fastest first, cheapest as the tiebreak.
            //
            // Two exclusions, for the same underlying reason. `grades` is nil
            // for Auto — a router, not a model — so Auto cannot be shown to be
            // quick and may route to anything, including the expensive model
            // this tier exists to avoid. And a graded model below
            // `fastTierMinimumSpeed` is simply not fast, however short the
            // remaining list gets: an empty fast tier is a true statement about
            // the catalog, while a slow model wearing the fast label is not.
            return selectable
                .filter { ($0.grades?.speed ?? 0) >= Self.fastTierMinimumSpeed }
                .sorted { lhs, rhs in
                    let lspeed = lhs.grades?.speed ?? 0
                    let rspeed = rhs.grades?.speed ?? 0
                    if lspeed != rspeed { return lspeed > rspeed }
                    return inputRate(lhs) < inputRate(rhs)
                }
        case .deep:
            // Most capable first. Auto is allowed here and sorts by its absent
            // grade last, so a real reasoning model always outranks it.
            return selectable.sorted { lhs, rhs in
                let lhsScore = lhs.grades?.intelligence ?? 0
                let rhsScore = rhs.grades?.intelligence ?? 0
                if lhsScore != rhsScore { return lhsScore > rhsScore }
                return inputRate(lhs) < inputRate(rhs)
            }
        }
    }

    private func bestModel(
        for tier: NativeModelTier,
        in catalog: NativeChatModelCatalog
    ) -> NativeChatModelOption? {
        candidates(for: tier, in: catalog).first
    }

    /// Sorts unpriced models last rather than treating them as free, which
    /// would make an unpriced entry win every cheapest-first tiebreak.
    private func inputRate(_ model: NativeChatModelOption) -> Double {
        model.pricing?.inputPerMillion ?? .greatestFiniteMagnitude
    }
}

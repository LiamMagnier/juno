import Foundation
import JunoCodeCore
import JunoCodeRuntime

// What `/context` and `/cost` show (CODE_AGENT_SPEC §5.4, §5.5).
//
// Juno does not tokenize: the provider reports how large the last prompt was,
// and that number is the meter's. The breakdown estimates each part from its
// text, then scales the estimates so the parts add up to exactly the number
// the provider reported — the parts are a share of a real total, never a
// second, disagreeing total.

/// The context window by part, summing to the meter's total.
public struct ContextBreakdown: Equatable, Sendable {
    public enum Part: String, CaseIterable, Sendable {
        case system
        case tools
        case instructions
        case skills
        case sessionState
        case conversation
        case images
        case toolResults

        public var label: String {
            switch self {
            case .system: "System prompt"
            case .tools: "Tool definitions"
            case .instructions: "Instruction files"
            case .skills: "Skills index"
            case .sessionState: "Session state"
            case .conversation: "Conversation"
            case .images: "Images"
            case .toolResults: "Tool results"
            }
        }
    }

    public struct Row: Equatable, Sendable, Identifiable {
        public let part: Part
        public let tokens: Int
        public var id: String { part.rawValue }
    }

    /// One row per part with anything in it, largest first.
    public let rows: [Row]
    /// What the provider reported for the last prompt, or the estimates'
    /// sum before the first turn reports.
    public let total: Int
    /// False when no turn has reported yet and every number is an estimate.
    public let isMeasured: Bool
    public let window: Int?
    /// The size at which Juno compacts, when auto-compaction is on.
    public let compactionThreshold: Int?
    /// Things the reader could do about it, in words.
    public let suggestions: [String]
    public let imageCount: Int

    /// Rough tokens for a piece of text: four characters to a token, the
    /// usual rule of thumb for English and code. Only ever a share of a
    /// measured total.
    public static func estimate(_ text: String) -> Int {
        (text.utf8.count + 3) / 4
    }

    /// An image's tokens when its size is unknown: a typical screenshot.
    public static let estimatedTokensPerImage = 1_600

    /// - Parameters:
    ///   - estimates: each part's estimated tokens.
    ///   - reportedTotal: the provider's figure for the last prompt.
    ///   - imageCount: images still in the context.
    public init(
        estimates: [Part: Int],
        reportedTotal: Int?,
        window: Int?,
        compactionFraction: Double?,
        imageCount: Int = 0
    ) {
        let positive = estimates.filter { $0.value > 0 }
        let estimatedSum = positive.values.reduce(0, +)
        let total = reportedTotal ?? estimatedSum
        self.total = total
        isMeasured = reportedTotal != nil
        self.window = window
        self.imageCount = imageCount
        compactionThreshold = window.flatMap { window in
            compactionFraction.map { Int(Double(window) * $0) }
        }
        let shares = Self.apportion(positive, to: total)
        rows = Part.allCases
            .compactMap { part in shares[part].map { Row(part: part, tokens: $0) } }
            .filter { $0.tokens > 0 }
            .sorted { $0.tokens == $1.tokens ? $0.part.rawValue < $1.part.rawValue : $0.tokens > $1.tokens }

        var suggestions: [String] = []
        let byPart = Dictionary(uniqueKeysWithValues: rows.map { ($0.part, $0.tokens) })
        if let images = byPart[.images], images >= 5_000, imageCount > 0 {
            suggestions.append("\(imageCount == 1 ? "1 image holds" : "\(imageCount) images hold") \(StudioFormat.tokens(images)) tokens. /compact drops them.")
        }
        if let results = byPart[.toolResults], total > 0, Double(results) / Double(total) > 0.4 {
            suggestions.append("Tool results are \(Int(Double(results) / Double(total) * 100))% of the context. /compact keeps what matters from them.")
        }
        if let threshold = compactionThreshold, threshold > 0, total >= Int(Double(threshold) * 0.85) {
            suggestions.append("Juno compacts at \(StudioFormat.tokens(threshold)) tokens; this session is close.")
        }
        self.suggestions = suggestions
    }

    /// Scales `estimates` to sum to exactly `total`: each part gets its
    /// share rounded down, and the tokens rounding left over go to the parts
    /// with the largest remainders (Hamilton's method), so no part moves by
    /// more than one token from its exact share.
    static func apportion(_ estimates: [Part: Int], to total: Int) -> [Part: Int] {
        let sum = estimates.values.reduce(0, +)
        guard sum > 0, total > 0 else { return [:] }
        var shares: [Part: Int] = [:]
        var remainders: [(Part, Double)] = []
        var given = 0
        for (part, estimate) in estimates {
            let exact = Double(estimate) * Double(total) / Double(sum)
            let floor = Int(exact.rounded(.down))
            shares[part] = floor
            given += floor
            remainders.append((part, exact - Double(floor)))
        }
        let ordered = remainders.sorted { $0.1 == $1.1 ? $0.0.rawValue < $1.0.rawValue : $0.1 > $1.1 }
        for index in 0..<(total - given) {
            shares[ordered[index % ordered.count].0, default: 0] += 1
        }
        return shares
    }
}

/// What a session has spent, by model and by who spent it.
public struct CostBreakdown: Equatable, Sendable {
    public struct ModelRow: Equatable, Sendable, Identifiable {
        public let modelID: String
        public let totals: ModelUsageTotals
        public let cost: Double?
        public var id: String { modelID }
    }

    public struct SpenderRow: Equatable, Sendable, Identifiable {
        public let label: String
        public let totals: ModelUsageTotals
        public let cost: Double?
        public var id: String { label }
    }

    public let total: ModelUsageTotals
    public let cost: Double?
    public let models: [ModelRow]
    /// The session's own turns, its sub-agents, and its side questions, apart.
    public let spenders: [SpenderRow]

    /// - Parameters:
    ///   - session: the session's ledger, sub-agents' calls included (the
    ///     store adds each child's spend to its parent).
    ///   - subagents: each sub-agent's own ledger, by title.
    public init(
        session: SessionUsageLedger,
        subagents: [(title: String, ledger: SessionUsageLedger)],
        pricing: (String) -> CodeUsagePricing?
    ) {
        total = session.total
        cost = session.estimatedCost(pricing: pricing)
        models = session.byModel
            .map { model, totals in
                ModelRow(
                    modelID: model,
                    totals: totals,
                    cost: pricing(model).map { $0.cost(of: totals) }
                )
            }
            .sorted { ($0.cost ?? 0, $0.totals.inputTokens) > ($1.cost ?? 0, $1.totals.inputTokens) }

        var children = SessionUsageLedger()
        for child in subagents { children.add(child.ledger) }
        var own = SessionUsageLedger()
        for (model, totals) in session.byModel {
            let theirs = children.byModel[model] ?? ModelUsageTotals()
            var mine = SessionUsageLedger()
            mine.addTotals(totals.subtracting(theirs), model: model)
            own.add(mine)
        }
        var spenders = [SpenderRow(label: "This session's turns", totals: own.total, cost: own.estimatedCost(pricing: pricing))]
        if !children.isEmpty {
            spenders.append(SpenderRow(
                label: subagents.count == 1 ? "1 sub-agent" : "\(subagents.count) sub-agents",
                totals: children.total,
                cost: children.estimatedCost(pricing: pricing)
            ))
        }
        self.spenders = spenders
    }
}

extension ModelUsageTotals {
    /// Totals with these counts. `ModelUsageTotals` keeps its fields to
    /// itself, so they go in through its stored form.
    static func make(input: Int, output: Int, cacheRead: Int, cacheWrite: Int, requests: Int) -> ModelUsageTotals {
        let stored: [String: Int] = [
            "inputTokens": max(0, input), "outputTokens": max(0, output),
            "cacheReadTokens": max(0, cacheRead), "cacheWriteTokens": max(0, cacheWrite),
            "requests": max(0, requests),
        ]
        let data = (try? JSONEncoder().encode(stored)) ?? Data()
        return (try? JSONDecoder().decode(ModelUsageTotals.self, from: data)) ?? ModelUsageTotals()
    }

    /// These totals less `other`'s, never below zero.
    func subtracting(_ other: ModelUsageTotals) -> ModelUsageTotals {
        .make(
            input: inputTokens - other.inputTokens,
            output: outputTokens - other.outputTokens,
            cacheRead: cacheReadTokens - other.cacheReadTokens,
            cacheWrite: cacheWriteTokens - other.cacheWriteTokens,
            requests: requests - other.requests
        )
    }
}

extension SessionUsageLedger {
    /// Adds `totals` under `model`, request count and all.
    mutating func addTotals(_ totals: ModelUsageTotals, model: String) {
        guard let data = try? JSONEncoder().encode(["byModel": [model: totals]]),
              let single = try? JSONDecoder().decode(SessionUsageLedger.self, from: data)
        else { return }
        add(single)
    }
}

// MARK: - Measuring a live session

extension SessionController {
    /// The context breakdown for this session as it stands.
    func contextBreakdown() async -> ContextBreakdown {
        var estimates: [ContextBreakdown.Part: Int] = [:]
        var imageCount = 0
        if let memo = currentSystemPrompt {
            estimates[.system] = ContextBreakdown.estimate(memo)
        }
        if let context {
            let tools = session.configuration.behavior == .code
                ? context.registry.allTools
                : context.registry.inspectionOnly().allTools
            estimates[.tools] = tools.reduce(0) { sum, tool in
                sum + ContextBreakdown.estimate(tool.name + tool.description + tool.inputSchema.canonicalJSONString())
            }
            var instructions = 0
            for file in await context.instructionFiles() {
                if let read = try? await context.files.read(file.path, limit: OutputLimit(maximumBytes: 256 * 1_024)) {
                    instructions += ContextBreakdown.estimate(read.content)
                }
            }
            // The instruction files ride inside the system prompt; counted
            // as their own part, not twice.
            if instructions > 0 {
                estimates[.instructions] = instructions
                if let system = estimates[.system] {
                    estimates[.system] = max(system - instructions, system / 4)
                }
            }
        }
        if let live {
            for message in await live.store.loadConversation(sessionID: sessionID) {
                switch message {
                case let .user(text):
                    if text.hasPrefix("<session_state") {
                        let skills = Self.section("skills", in: text)
                        estimates[.skills, default: 0] += ContextBreakdown.estimate(skills)
                        estimates[.sessionState, default: 0] += ContextBreakdown.estimate(text) - ContextBreakdown.estimate(skills)
                    } else {
                        estimates[.conversation, default: 0] += ContextBreakdown.estimate(text)
                    }
                case let .userWithImages(text, images):
                    estimates[.conversation, default: 0] += ContextBreakdown.estimate(text)
                    estimates[.images, default: 0] += images.count * ContextBreakdown.estimatedTokensPerImage
                    imageCount += images.count
                case let .assistant(text), let .assistantThinking(text, _):
                    estimates[.conversation, default: 0] += ContextBreakdown.estimate(text)
                case let .toolCall(_, name, input), let .toolCallWithExtra(_, name, input, _):
                    estimates[.conversation, default: 0] += ContextBreakdown.estimate(name + input.canonicalJSONString())
                case let .toolResult(_, content, _):
                    estimates[.toolResults, default: 0] += ContextBreakdown.estimate(content)
                case let .toolResultWithImages(_, content, _, images):
                    estimates[.toolResults, default: 0] += ContextBreakdown.estimate(content)
                    estimates[.images, default: 0] += images.count * ContextBreakdown.estimatedTokensPerImage
                    imageCount += images.count
                case .assistantRedactedThinking:
                    continue
                }
            }
        }
        return ContextBreakdown(
            estimates: estimates,
            reportedTotal: contextTokens,
            window: contextWindowTokens,
            compactionFraction: settings.autoCompact ? settings.compactThreshold : nil,
            imageCount: imageCount
        )
    }

    /// The cost breakdown for this session as it stands.
    func costBreakdown() async -> CostBreakdown {
        var subagents: [(title: String, ledger: SessionUsageLedger)] = []
        if let live {
            for child in await live.store.childSessions(of: sessionID) {
                let ledger = await live.store.usageLedger(for: child.id)
                if !ledger.isEmpty { subagents.append((child.title, ledger)) }
            }
        }
        return CostBreakdown(
            session: usageLedger,
            subagents: subagents,
            pricing: { [live] model in live?.modelPricing(model) }
        )
    }

    /// One `<name>…</name>` section of a session state block, or "".
    static func section(_ name: String, in text: String) -> String {
        guard let open = text.range(of: "<\(name)>"),
              let close = text.range(of: "</\(name)>", range: open.upperBound..<text.endIndex)
        else { return "" }
        return String(text[open.lowerBound..<close.upperBound])
    }
}

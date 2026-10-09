import Foundation

/// Context-window tiers, prices and the compaction point (Code v2 SPEC §3.5,
/// §4; DESIGN §5.7, §5.10).
///
/// The Swift twin of `src/lib/code-v2/context-tiers.ts` for the parts the Mac
/// renders: the label of a window ("272K", "1.05M"), the price delta of a tier
/// against the default one, the band a prompt actually bills at, and the
/// auto-compact threshold. Rates are never invented here: every number comes
/// from a ``CodeV2/ContextTier`` the catalogue sent.
public enum CodeV2ContextMath {
    /// Output reserve used when a model does not state its maximum output.
    public static let defaultOutputReserve = 32_000
    /// Headroom the harness keeps free for the system prompt and tools.
    public static let compactionHeadroom = 65_536
    /// Below this the "Lean" tier is not offered: the window is already small.
    public static let leanFloor = 200_000
    /// The Lean tier's window: same rates, earlier compaction.
    public static let leanWindow = 128_000

    // MARK: Labels

    /// "272K", "1M" (1,000,000 or 1,048,576), "1.05M", "256K" (262,144).
    /// Identical to `formatContextTokens` on the web.
    public static func label(tokens: Int) -> String {
        if tokens >= 1_000_000 {
            if tokens % 1_048_576 == 0 { return "\(tokens / 1_048_576)M" }
            return trim(Double(tokens) / 1_000_000) + "M"
        }
        if tokens >= 1_000 {
            if tokens % 1_000 == 0 { return "\(tokens / 1_000)K" }
            if tokens % 1_024 == 0 { return "\(tokens / 1_024)K" }
            return trim(Double(tokens) / 1_000) + "K"
        }
        return String(tokens)
    }

    /// A compact label for a running count: "184K", "1.2M", "940".
    public static func compactCount(_ tokens: Int) -> String {
        if tokens >= 1_000_000 { return trim1(Double(tokens) / 1_000_000) + "M" }
        if tokens >= 1_000 { return "\(Int((Double(tokens) / 1_000).rounded()))K" }
        return String(tokens)
    }

    /// "$2.00", "$0.15", "$12.40". Two decimals always: prices are compared.
    public static func dollars(_ value: Double) -> String {
        String(format: "$%.2f", value)
    }

    /// "≈ $0.37", or "< $0.01" for a turn that rounds to nothing.
    public static func estimate(_ value: Double) -> String {
        value > 0 && value < 0.005 ? "< $0.01" : "≈ " + dollars(value)
    }

    static func trim(_ value: Double) -> String {
        var text = String(format: "%.2f", value)
        while text.contains("."), text.hasSuffix("0") { text.removeLast() }
        if text.hasSuffix(".") { text.removeLast() }
        return text
    }

    static func trim1(_ value: Double) -> String {
        var text = String(format: "%.1f", value)
        if text.hasSuffix(".0") { text.removeLast(2) }
        return text
    }

    // MARK: Tiers

    /// Smallest first; the first tier is the model's default (cheapest band).
    public static func sorted(_ tiers: [CodeV2.ContextTier]) -> [CodeV2.ContextTier] {
        tiers.sorted { $0.tokens < $1.tokens }
    }

    /// The tier a selection names, or the default when it names none.
    public static func tier(for tokens: Int?, in tiers: [CodeV2.ContextTier]) -> CodeV2.ContextTier? {
        let ordered = sorted(tiers)
        guard let tokens else { return ordered.first }
        return ordered.first { $0.tokens == tokens } ?? ordered.first { $0.tokens >= tokens } ?? ordered.last
    }

    /// The smallest tier that fits `tokens` — the band a prompt bills at.
    public static func band(for tokens: Int, in tiers: [CodeV2.ContextTier]) -> CodeV2.ContextTier? {
        sorted(tiers).first { $0.tokens >= tokens }
    }

    public struct PriceDelta: Equatable, Sendable {
        public var inputMultiplier: Double
        public var outputMultiplier: Double
        /// "Same price", or "2× input, 1.5× output".
        public var label: String
        public var isSamePrice: Bool { inputMultiplier == 1 && outputMultiplier == 1 }
    }

    /// How `tier` is priced against `base` (normally the default tier).
    public static func priceDelta(_ tier: CodeV2.ContextTier, against base: CodeV2.ContextTier) -> PriceDelta {
        func ratio(_ a: Double, _ b: Double) -> Double {
            b > 0 ? (a / b * 1_000_000).rounded() / 1_000_000 : 1
        }
        let input = ratio(tier.inputPerMTok, base.inputPerMTok)
        let output = ratio(tier.outputPerMTok, base.outputPerMTok)
        var parts: [String] = []
        if input != 1 { parts.append(trim(input) + "× input") }
        if output != 1 { parts.append(trim(output) + "× output") }
        return PriceDelta(
            inputMultiplier: input,
            outputMultiplier: output,
            label: parts.isEmpty ? "Same price" : parts.joined(separator: ", ")
        )
    }

    /// The delta line under a tier row: "2× input and 1.5× output past 272K."
    public static func deltaSentence(_ tier: CodeV2.ContextTier, in tiers: [CodeV2.ContextTier]) -> String? {
        let ordered = sorted(tiers)
        guard let base = ordered.first, base.tokens != tier.tokens else { return nil }
        let delta = priceDelta(tier, against: base)
        guard !delta.isSamePrice else { return "Same rates, larger window." }
        var parts: [String] = []
        if delta.inputMultiplier != 1 { parts.append(trim(delta.inputMultiplier) + "× input") }
        if delta.outputMultiplier != 1 { parts.append(trim(delta.outputMultiplier) + "× output") }
        return parts.joined(separator: " and ") + " past " + label(tokens: base.tokens) + "."
    }

    /// "$2.00 in · $10.00 out per million tokens".
    public static func priceLine(_ tier: CodeV2.ContextTier, perMillionSuffix: Bool = true) -> String {
        dollars(tier.inputPerMTok) + " in · " + dollars(tier.outputPerMTok) + " out"
            + (perMillionSuffix ? " per million tokens" : "")
    }

    // MARK: Cost

    /// USD to send a thread of `threadTokens` once on `tier` plus
    /// `outputTokens`, or nil when the thread does not fit the window. A lab
    /// bills the band the prompt falls in, not the window chosen.
    public static func estimateCost(
        threadTokens: Int,
        tier: CodeV2.ContextTier,
        tiers: [CodeV2.ContextTier] = [],
        outputTokens: Int = 0,
        cachedInputTokens: Int = 0
    ) -> Double? {
        let input = max(0, threadTokens)
        guard input <= tier.tokens else { return nil }
        var billed = tier
        if let fit = band(for: input, in: tiers), fit.tokens <= tier.tokens { billed = fit }
        let cached = min(input, max(0, cachedInputTokens))
        let fresh = input - cached
        let cachedRate = billed.cachedInputPerMTok ?? billed.inputPerMTok
        let usd = (Double(fresh) * billed.inputPerMTok
            + Double(cached) * cachedRate
            + Double(max(0, outputTokens)) * billed.outputPerMTok) / 1_000_000
        return (usd * 1_000_000).rounded() / 1_000_000
    }

    // MARK: Compaction

    /// The auto-compact trigger: `floor(min(0.8·W, W − O − 65536))`, never
    /// below a quarter of the window (a tiny window with a large output
    /// reserve would otherwise compact on every turn).
    public static func autoCompactThreshold(window: Int, outputReserve: Int = defaultOutputReserve) -> Int {
        guard window > 0 else { return 0 }
        let byRatio = Int((0.8 * Double(window)).rounded(.down))
        let byHeadroom = window - outputReserve - compactionHeadroom
        return max(window / 4, min(byRatio, byHeadroom))
    }

    /// Fraction of the auto-compact threshold used, 0…1+.
    public static func pressure(used: Int, window: Int, outputReserve: Int = defaultOutputReserve) -> Double {
        let threshold = autoCompactThreshold(window: window, outputReserve: outputReserve)
        guard threshold > 0 else { return 0 }
        return Double(used) / Double(threshold)
    }

    /// The gauge turns coral past this share of the auto-compact threshold.
    public static let warningPressure = 0.8

    /// Whether a model gets the client-side Lean option (same rates, earlier
    /// compaction, cheaper turns): only where its default window is large.
    public static func offersLean(_ tiers: [CodeV2.ContextTier]) -> Bool {
        (sorted(tiers).first?.tokens ?? 0) > leanFloor
    }
}

// MARK: - Tier choices (the selector's rows)

/// One row of the context-window selector: a catalogue tier or the
/// client-side Lean option, with everything the row prints.
public struct CodeV2TierChoice: Identifiable, Equatable, Sendable {
    public enum Kind: Equatable, Sendable { case standard, long, lean }

    public var id: String { kind == .lean ? "lean" : "tier-\(tier.tokens)" }
    public var kind: Kind
    /// For Lean, the default tier whose rates it bills at.
    public var tier: CodeV2.ContextTier
    /// The window shown: Lean's is ``CodeV2ContextMath/leanWindow``.
    public var windowTokens: Int
    public var name: String
    public var priceLine: String
    public var deltaLine: String?
    public var compactsAt: Int
    /// "≈ $0.37" next turn; nil for subscriptions or when it does not fit.
    public var nextTurnEstimate: Double?
    /// The thread would not fit: picking this compacts first.
    public var compactsNow: Bool

    /// Builds the rows for a model's tiers. `threadTokens` is the thread so
    /// far; `expectedOutput` the model's median output per turn.
    public static func choices(
        tiers: [CodeV2.ContextTier],
        threadTokens: Int,
        expectedOutput: Int = 2_000,
        billsInDollars: Bool = true
    ) -> [CodeV2TierChoice] {
        let ordered = CodeV2ContextMath.sorted(tiers)
        guard let base = ordered.first else { return [] }
        var rows: [CodeV2TierChoice] = []
        for (index, tier) in ordered.enumerated() {
            let isLong = index > 0
            let threshold = CodeV2ContextMath.autoCompactThreshold(window: tier.tokens)
            var priceLine = CodeV2ContextMath.priceLine(tier, perMillionSuffix: !isLong)
            if isLong {
                priceLine = "Same rates up to " + CodeV2ContextMath.label(tokens: base.tokens) + ", then "
                    + CodeV2ContextMath.priceLine(tier, perMillionSuffix: false)
            }
            var delta = isLong
                ? CodeV2ContextMath.deltaSentence(tier, in: ordered)
                : "Compacts at " + CodeV2ContextMath.label(tokens: roundedK(threshold)) + "."
            if let note = tier.note, tier.unverified == true { delta = note + "." }
            rows.append(CodeV2TierChoice(
                kind: isLong ? .long : .standard,
                tier: tier,
                windowTokens: tier.tokens,
                name: isLong ? "Long" : "Standard",
                priceLine: priceLine,
                deltaLine: delta,
                compactsAt: threshold,
                nextTurnEstimate: billsInDollars
                    ? CodeV2ContextMath.estimateCost(
                        threadTokens: min(threadTokens, tier.tokens),
                        tier: tier, tiers: ordered, outputTokens: expectedOutput)
                    : nil,
                compactsNow: threadTokens > threshold
            ))
        }
        if CodeV2ContextMath.offersLean(ordered) {
            let window = CodeV2ContextMath.leanWindow
            let threshold = window * 4 / 5
            let fits = min(threadTokens, threshold)
            let compactsNow = threadTokens > threshold
            rows.append(CodeV2TierChoice(
                kind: .lean,
                tier: base,
                windowTokens: window,
                name: "Lean",
                priceLine: CodeV2ContextMath.priceLine(base, perMillionSuffix: false),
                deltaLine: compactsNow
                    ? "Compacts now, then every \(CodeV2ContextMath.label(tokens: roundedK(threshold)))."
                    : "Same rates, compacts at \(CodeV2ContextMath.label(tokens: roundedK(threshold))).",
                compactsAt: threshold,
                nextTurnEstimate: billsInDollars
                    ? CodeV2ContextMath.estimateCost(threadTokens: fits, tier: base, tiers: ordered, outputTokens: expectedOutput)
                    : nil,
                compactsNow: compactsNow
            ))
        }
        return rows
    }

    /// Rounds to whole thousands so a threshold reads "217K", not "217.6K".
    static func roundedK(_ tokens: Int) -> Int { (tokens / 1_000) * 1_000 }
}

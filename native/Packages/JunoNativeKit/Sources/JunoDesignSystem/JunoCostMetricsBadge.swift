import SwiftUI

/// What the badge draws, as plain numbers.
///
/// A value type in the DESIGN SYSTEM rather than the chat package because that
/// is the dependency direction: `JunoChatKit` depends on `JunoDesignSystem`, so
/// the badge cannot see `NativeSessionCostTotals` and must not try. The chat
/// package maps its totals onto this at the call site, which also keeps the
/// view previewable with no client, no session and no network.
///
/// Every count is a plain `Int` because they are known-only sums; the two
/// `reporting…` counts carry the honesty. See `NativeSessionCostTotals`.
public struct JunoCostMetrics: Equatable, Sendable {
    public let turns: Int
    public let inputTokens: Int
    public let outputTokens: Int
    public let cacheReadTokens: Int
    public let cacheWriteTokens: Int
    public let costUsd: Double
    /// How many turns reported a cache split. Zero means "no turn told us",
    /// which the badge renders as an absent row rather than as 0 cached tokens.
    public let turnsReportingCache: Int
    /// How many turns reported a cost. Fewer than `turns` makes the total a
    /// lower bound, drawn with a leading "≥".
    public let turnsReportingCost: Int

    public init(
        turns: Int,
        inputTokens: Int,
        outputTokens: Int,
        cacheReadTokens: Int,
        cacheWriteTokens: Int,
        costUsd: Double,
        turnsReportingCache: Int,
        turnsReportingCost: Int
    ) {
        self.turns = turns
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.cacheReadTokens = cacheReadTokens
        self.cacheWriteTokens = cacheWriteTokens
        self.costUsd = costUsd
        self.turnsReportingCache = turnsReportingCache
        self.turnsReportingCost = turnsReportingCost
    }

    public static let empty = JunoCostMetrics(
        turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
        cacheWriteTokens: 0, costUsd: 0, turnsReportingCache: 0, turnsReportingCost: 0
    )

    /// Nothing has been billed yet — the badge draws nothing at all rather than
    /// a row of zeroes above an empty conversation.
    public var isEmpty: Bool { turns == 0 }

    /// True when at least one turn never reported a cost, making the total a
    /// floor rather than a figure.
    public var isPartial: Bool { turnsReportingCost < turns }

    /// Whether any turn reported a prompt-cache split.
    public var hasCacheData: Bool { turnsReportingCache > 0 }

    /// Share of input served from cache, or nil when unknown.
    public var cacheHitRate: Double? {
        guard hasCacheData, inputTokens > 0 else { return nil }
        return min(1, Double(cacheReadTokens) / Double(inputTokens))
    }

    public var totalTokens: Int { inputTokens + outputTokens }
}

/// Formats token counts and dollars for a dense metadata line.
///
/// Its own type so the rounding is testable without a view: these are the rules
/// that decide whether a reader sees "$0.00" (which reads as free) or "<$0.01"
/// (which reads as cheap), and that distinction is the whole point of the badge.
public enum JunoCostFormatting {
    /// Compact token counts: 847, 12.4K, 1.8M.
    ///
    /// Truncated, never rounded up, so the number shown is always one the
    /// session has actually reached.
    public static func tokens(_ count: Int) -> String {
        let value = max(0, count)
        switch value {
        case 0..<1_000:
            return "\(value)"
        case 1_000..<1_000_000:
            let thousands = Double(value) / 1_000
            // One decimal below 10K where the digit carries information, none
            // above it where it is noise on a line this dense.
            return thousands < 10
                ? "\((thousands * 10).rounded(.down) / 10)K"
                : "\(Int(thousands.rounded(.down)))K"
        default:
            let millions = Double(value) / 1_000_000
            return "\((millions * 10).rounded(.down) / 10)M"
        }
    }

    /// Money, at the precision the amount deserves.
    ///
    /// A real but sub-cent amount becomes "<$0.01" rather than "$0.00": the
    /// session did cost something, and a badge that says $0.00 for a paid turn
    /// is simply wrong. Exact zero is the only thing allowed to print "$0.00".
    public static func cost(_ usd: Double, isPartial: Bool = false) -> String {
        let amount = max(0, usd)
        let prefix = isPartial ? "≥" : ""
        if amount == 0 { return "\(prefix)$0.00" }
        if amount < 0.01 { return "\(prefix)<$0.01" }
        if amount < 10 { return String(format: "\(prefix)$%.3f", amount) }
        return String(format: "\(prefix)$%.2f", amount)
    }

    /// A percentage with no decimals — the badge has no room for them.
    public static func percent(_ fraction: Double) -> String {
        "\(Int((min(1, max(0, fraction)) * 100).rounded()))%"
    }
}

/// A quiet, collapsible receipt for the current conversation.
///
/// Collapsed it is one line: total tokens and what they cost. Expanded it
/// breaks that into input, output and the prompt-cache split. It starts
/// collapsed and stays out of the way — this is provenance, not a feature, and
/// a reader who never opens it should only ever notice a small grey number.
///
/// The cache rows are drawn only when a turn actually reported them. Absent is
/// not zero: the split rides the live `done` frame, so a reloaded transcript
/// legitimately has none, and a row reading "0 cached" would assert a total
/// cache miss that never happened.
public struct JunoCostMetricsBadge: View {
    private let metrics: JunoCostMetrics
    @Binding private var isExpanded: Bool

    public init(metrics: JunoCostMetrics, isExpanded: Binding<Bool>) {
        self.metrics = metrics
        self._isExpanded = isExpanded
    }

    public var body: some View {
        if metrics.isEmpty {
            // Nothing billed yet. Drawing an empty receipt above a fresh
            // conversation is worse than drawing nothing.
            EmptyView()
        } else {
            VStack(alignment: .leading, spacing: JunoSpace.tight) {
                summaryRow
                if isExpanded { detailRows }
            }
            .padding(.horizontal, JunoSpace.snug)
            .padding(.vertical, JunoSpace.tight)
            .background(
                RoundedRectangle(cornerRadius: JunoRadius.chip, style: .continuous)
                    .fill(Color.junoMuted)
            )
            .animation(JunoMotion.fast, value: isExpanded)
        }
    }

    private var summaryRow: some View {
        Button {
            isExpanded.toggle()
        } label: {
            HStack(spacing: JunoSpace.tight) {
                Image(systemName: "circle.dotted.circle")
                    .imageScale(.small)
                Text(JunoCostFormatting.tokens(metrics.totalTokens))
                    .monospacedDigit()
                Text(JunoCostFormatting.cost(metrics.costUsd, isPartial: metrics.isPartial))
                    .monospacedDigit()
                Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                    .imageScale(.small)
            }
            .junoCaption()
            .junoSecondaryInk()
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilitySummary)
        .accessibilityHint(isExpanded ? "Collapses the session cost breakdown."
                                      : "Expands the session cost breakdown.")
    }

    private var detailRows: some View {
        VStack(alignment: .leading, spacing: 2) {
            row("Input", JunoCostFormatting.tokens(metrics.inputTokens))
            row("Output", JunoCostFormatting.tokens(metrics.outputTokens))
            if metrics.hasCacheData {
                if let rate = metrics.cacheHitRate {
                    row(
                        "Cached",
                        "\(JunoCostFormatting.tokens(metrics.cacheReadTokens)) · \(JunoCostFormatting.percent(rate))"
                    )
                } else {
                    row("Cached", JunoCostFormatting.tokens(metrics.cacheReadTokens))
                }
                if metrics.cacheWriteTokens > 0 {
                    row("Cache written", JunoCostFormatting.tokens(metrics.cacheWriteTokens))
                }
            }
            row("Turns", "\(metrics.turns)")
            if metrics.isPartial {
                // Says WHY the total carries a "≥" instead of leaving the
                // reader to wonder whether the number is broken.
                Text("Some turns reported no usage.")
                    .junoCaption()
                    .junoMetaInk()
                    .padding(.top, 2)
            }
        }
        .transition(.opacity)
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label)
            Spacer(minLength: JunoSpace.cozy)
            Text(value).monospacedDigit()
        }
        .junoCaption()
        .junoSecondaryInk()
        .accessibilityElement(children: .combine)
    }

    /// One spoken sentence rather than four drifting fragments — VoiceOver
    /// reads the collapsed badge as a receipt, which is what it is.
    private var accessibilitySummary: String {
        var parts = [
            "Session cost",
            JunoCostFormatting.cost(metrics.costUsd, isPartial: metrics.isPartial),
            "\(metrics.totalTokens) tokens across \(metrics.turns) turns",
        ]
        if let rate = metrics.cacheHitRate {
            parts.append("\(JunoCostFormatting.percent(rate)) of input served from cache")
        }
        if metrics.isPartial {
            parts.append("at least — some turns reported no usage")
        }
        return parts.joined(separator: ", ")
    }
}

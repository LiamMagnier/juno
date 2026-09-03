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

// `JunoCostFormatting` used to live here, hard-coding "$" through
// `String(format:)`. It moved to `JunoCostPresentation.swift` and became
// locale-pinned and `Decimal`-backed, so that this badge and the nine call
// sites that were writing `.formatted(.currency(code: "USD"))` — and therefore
// rendering `0,41 US$` on a French Mac — round money the same way.

/// A quiet receipt trigger for the current conversation.
///
/// The toolbar always stays one line: total tokens and what they cost. Pressing
/// it opens the breakdown in a native popover. Keeping the expanded rows out of
/// the toolbar is important on Liquid Glass: inline padding and an opaque chip
/// otherwise enlarge the shared material behind every neighbouring action.
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
            summaryRow
                .popover(
                    isPresented: $isExpanded,
                    attachmentAnchor: .rect(.bounds),
                    arrowEdge: .top
                ) {
                    VStack(alignment: .leading, spacing: JunoSpace.cozy) {
                        Text("Session usage")
                            .junoRowLabel()
                        detailRows
                    }
                    .padding(JunoSpace.regular)
                    .frame(width: 220)
                }
        }
    }

    private var summaryRow: some View {
        Button {
            isExpanded.toggle()
        } label: {
            HStack(spacing: JunoSpace.tight) {
                JunoIconView(.circleDot)
                    .imageScale(.small)
                Text(JunoCostFormatting.tokens(metrics.totalTokens))
                    .monospacedDigit()
                Text(JunoCostFormatting.cost(usd: metrics.costUsd, isPartial: metrics.isPartial))
                    .monospacedDigit()
                    .fontWeight(.medium)
                JunoIconView(isExpanded ? .chevronUp : .chevronDown)
                    .imageScale(.small)
            }
            .junoCaption()
            .junoSecondaryInk()
            // NSToolbar supplies the hit target and shared glass. Stating a
            // second 44-point target here made the whole toolbar group taller.
            .contentShape(Rectangle())
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
            // The one place the extra decimals belong. The collapsed line shows
            // cents because that is what a price is; a reader who opened the
            // receipt is asking the accountant's question instead.
            row(
                "Cost",
                JunoCostFormatting.cost(
                    usd: metrics.costUsd, isPartial: metrics.isPartial, precision: .exact
                )
            )
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
            // Spoken, not drawn: VoiceOver reads the drawn "≥" as "greater than
            // or equal to", or drops it, and neither is the sentence meant.
            JunoCostFormatting.spokenCost(
                JunoCostFormatting.usd(metrics.costUsd), isPartial: metrics.isPartial
            ),
            "\(metrics.totalTokens) tokens across \(metrics.turns) turns",
        ]
        if let rate = metrics.cacheHitRate {
            parts.append("\(JunoCostFormatting.percent(rate)) of input served from cache")
        }
        if metrics.isPartial {
            parts.append("some turns reported no usage")
        }
        return parts.joined(separator: ", ")
    }
}

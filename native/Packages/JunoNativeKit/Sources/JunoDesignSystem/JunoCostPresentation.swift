import Foundation
import SwiftUI

// Money, everywhere Juno shows it.
//
// **Why this file exists.** Nine call sites across the two apps wrote
// `amount.formatted(.currency(code: "USD"))`, which renders in the *reader's*
// locale. On a French-locale Mac a 41-cent run therefore displayed as
// `0,41 US$`, and on a German one as `0,41 $`. That is not a cosmetic slip: the
// amount is a US-dollar figure billed by the model provider and never
// converted, so localising its presentation asserts a conversion that did not
// happen. A price in a currency the app does not convert is written the way
// that currency is written.
//
// So the presentation is pinned to `en_US` and the arithmetic is `Decimal`.
// Everything that draws money goes through `JunoCostFormatting`; a bare
// `.formatted(.currency(...))` at a call site is a defect.

// MARK: - Formatting

/// Formats token counts and dollars for a dense metadata line.
///
/// Its own type so the rounding is testable without a view: these are the rules
/// that decide whether a reader sees "$0.00" (which reads as free) or "<$0.01"
/// (which reads as cheap), and that distinction is the whole point of showing
/// cost at all.
public enum JunoCostFormatting {
    /// How much of the true figure to draw.
    ///
    /// **The sub-cent rule, and why there are two of these.** Chat metadata used
    /// to print three decimals — `$0.021` under every answer. Three decimals is
    /// a developer artifact: nobody is billed a tenth of a cent, no invoice will
    /// ever show that digit, and a column of `$0.021 / $0.008 / $0.114` reads as
    /// instrumentation rather than as price. Money in product chrome is written
    /// in cents, full stop.
    ///
    /// But rounding a real charge to `$0.00` is a lie in the other direction, so
    /// ``display`` never does it: anything above zero and below a cent becomes
    /// `<$0.01`, which says "you were billed, and it was cheap" in five
    /// characters. Exact zero is the only value allowed to print `$0.00`.
    ///
    /// ``exact`` exists for the two places the extra digits genuinely inform —
    /// an expanded receipt and a copied figure — and nowhere else.
    public enum Precision: Sendable {
        /// Cents. What a person reads.
        case display
        /// Up to four decimals. What an accountant reconciles.
        case exact
    }

    /// The wire format is micro-USD integers, so `Decimal` division is exact
    /// where `Double` would already have introduced error before rounding.
    private static let microUSDPerUSD: Decimal = 1_000_000

    /// Pinned. See the note at the top of this file: this is a foreign-currency
    /// amount presented verbatim, not a localised price.
    private static let presentationLocale = Locale(identifier: "en_US")

    /// Money, at the precision the amount deserves.
    ///
    /// - Parameter isPartial: The total is a floor because some turns reported
    ///   no usage. Drawn as a leading "≥" rather than silently under-reporting.
    public static func cost(
        _ usd: Decimal,
        isPartial: Bool = false,
        precision: Precision = .display
    ) -> String {
        let amount = max(0, usd)
        let prefix = isPartial ? "≥" : ""

        if amount == 0 { return prefix + format(0, precision: .display) }
        let floor = smallestDrawable(at: precision)
        if amount < floor {
            return "\(prefix)<" + format(floor, precision: precision)
        }
        return prefix + format(amount, precision: precision)
    }

    /// The `Double` entry point, for call sites whose model already carries a
    /// `Double`. Prefer the `Decimal` or micro-USD forms where the value comes
    /// off the wire — they cannot lose a cent to binary rounding.
    ///
    /// Labelled rather than a second unlabelled overload: `Decimal` is
    /// `ExpressibleByFloatLiteral`, so `cost(0.41)` would otherwise be ambiguous
    /// at every call site that passes a literal.
    public static func cost(
        usd: Double,
        isPartial: Bool = false,
        precision: Precision = .display
    ) -> String {
        cost(self.usd(usd), isPartial: isPartial, precision: precision)
    }

    /// A `Double` dollar amount as an exact `Decimal`, for call sites that have
    /// to hand one to a view rather than format it here.
    ///
    /// `Decimal(_: Double)` carries the binary representation error straight
    /// into the decimal — `Decimal(0.0006)` is `0.00059999…`. Going through the
    /// shortest round-tripping description drops it, which matters only at the
    /// sub-cent boundary but matters absolutely there.
    public static func usd(_ value: Double) -> Decimal {
        guard value.isFinite else { return 0 }
        return Decimal(string: "\(value)") ?? Decimal(value)
    }

    /// The wire form. Costs arrive from the API as micro-USD integers.
    public static func cost(
        microUSD: Int,
        isPartial: Bool = false,
        precision: Precision = .display
    ) -> String {
        cost(Decimal(microUSD) / microUSDPerUSD, isPartial: isPartial, precision: precision)
    }

    /// A spent-of-budget pair — "$1.20 of $5.00" — formatted as one unit so the
    /// two halves cannot drift into different precisions.
    public static func costOfCeiling(_ spent: Decimal, ceiling: Decimal) -> String {
        "\(cost(spent)) of \(cost(ceiling))"
    }

    /// The same pair straight off the wire, which is how a Work run carries it
    /// (`costMicroUsd` / `maxCostMicroUsd`).
    public static func costOfCeiling(spentMicroUSD: Int, ceilingMicroUSD: Int) -> String {
        costOfCeiling(
            Decimal(spentMicroUSD) / microUSDPerUSD,
            ceiling: Decimal(ceilingMicroUSD) / microUSDPerUSD
        )
    }

    /// The smallest amount each precision can draw truthfully. Below it, a real
    /// charge would round to `$0.00`, so the "<" form is used instead: rounding
    /// a paid turn down to nothing is the one error neither precision may make.
    private static func smallestDrawable(at precision: Precision) -> Decimal {
        switch precision {
        case .display: return Decimal(string: "0.01")!
        case .exact: return Decimal(string: "0.0001")!
        }
    }

    private static func format(_ amount: Decimal, precision: Precision) -> String {
        let fractionLength: ClosedRange<Int> = precision == .display ? 2...2 : 2...4
        return amount.formatted(
            .currency(code: "USD")
                .locale(presentationLocale)
                .precision(.fractionLength(fractionLength))
                // Bankers' rounding is the `FormatStyle` default and would show
                // a 12.345 charge as $12.34. Round the way a bill rounds.
                .rounded(rule: .toNearestOrAwayFromZero)
        )
    }

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

    /// A percentage with no decimals — the badge has no room for them.
    public static func percent(_ fraction: Double) -> String {
        "\(Int((min(1, max(0, fraction)) * 100).rounded()))%"
    }

    /// How VoiceOver should say an amount.
    ///
    /// "≥" is spoken as "greater than or equal to", or skipped entirely, neither
    /// of which is the sentence the badge means. Spoken output says the words.
    public static func spokenCost(_ usd: Decimal, isPartial: Bool = false) -> String {
        let amount = cost(usd, isPartial: false)
        return isPartial ? "at least \(amount)" : amount
    }
}

// MARK: - The per-message metadata line

/// Which model wrote this, what it cost, and whether it is still arriving.
///
/// **Why this is a component and not three `Text`s at the call site.** This line
/// sits under every assistant message in the product, so it is the single most
/// repeated piece of chrome Juno draws — and it was the clearest "internal tool"
/// tell in the app, set in monospace like a log line (`Claude Sonnet 4.6 ·
/// $0.021`). Monospace is reserved for code, paths and terminal output; a model
/// name is a proper noun and a price is a price.
///
/// The rules it encodes:
///
/// - **Face.** SF Pro at ``SwiftUI/View/junoCaption()``, one rung under the
///   message body, in muted ink. It should be findable, not readable-first.
/// - **Figures.** `monospacedDigit()` on the amount only. That is tabular
///   *figures* within SF Pro, not a monospaced face: it stops the price
///   twitching sideways while a token count updates mid-stream, and it lines the
///   decimal points up down a scrolled transcript.
/// - **Hierarchy.** The cost carries medium weight at the same size and the same
///   ink as everything else on the line. Weight is enough to make it the thing
///   your eye lands on; a second colour or a larger size would make a receipt
///   shout over the answer it belongs to.
/// - **One reading.** The separators are drawn, not spaced — a single line with
///   interpuncts, so VoiceOver reads one sentence rather than three fragments.
public struct JunoMessageMetaLine: View {
    private let modelDisplayName: String?
    private let costUSD: Decimal?
    private let isCostPartial: Bool
    private let isStreaming: Bool

    public init(
        modelDisplayName: String?,
        costUSD: Decimal?,
        isCostPartial: Bool = false,
        isStreaming: Bool = false
    ) {
        self.modelDisplayName = modelDisplayName
        self.costUSD = costUSD
        self.isCostPartial = isCostPartial
        self.isStreaming = isStreaming
    }

    // A `Double?` convenience initialiser would be ambiguous against this one
    // at `costUSD: nil`. Call sites holding a `Double` write
    // `costUSD: message.costUSD.map(JunoCostFormatting.usd)`.

    public var body: some View {
        if modelDisplayName == nil, costUSD == nil, !isStreaming {
            // Nothing known about this message. An empty metadata line still
            // costs a line of vertical rhythm under every bubble.
            EmptyView()
        } else {
            line
                .junoSecondaryInk()
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(spokenLine)
        }
    }

    /// Built by concatenation rather than as an `HStack` so the whole line wraps
    /// on one line-breaking pass at large Dynamic Type sizes, instead of the
    /// price being pushed out of the window on its own.
    private var line: Text {
        var text = Text("")
        var needsSeparator = false

        if let modelDisplayName {
            text = text + Text(modelDisplayName).font(.junoCaption)
            needsSeparator = true
        }
        if let costUSD {
            if needsSeparator { text = text + separator }
            text = text
                + Text(JunoCostFormatting.cost(costUSD, isPartial: isCostPartial))
                    .font(.junoCaption.monospacedDigit())
                    .fontWeight(.medium)
            needsSeparator = true
        }
        if isStreaming {
            if needsSeparator { text = text + separator }
            text = text + Text("Streaming").font(.junoCaption)
        }
        return text
    }

    /// A hair of space either side of the interpunct, because the caption rung
    /// sets it tight enough to touch the digits next to it.
    private var separator: Text {
        Text(" · ").font(.junoCaption)
    }

    private var spokenLine: String {
        var parts: [String] = []
        if let modelDisplayName { parts.append(modelDisplayName) }
        if let costUSD {
            parts.append(JunoCostFormatting.spokenCost(costUSD, isPartial: isCostPartial))
        }
        if isStreaming { parts.append("still streaming") }
        return parts.joined(separator: ", ")
    }
}

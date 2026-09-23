import Foundation

/// The reply's receipt as the web writes it inside the More menu: tokens in and
/// out, then what the turn cost.
///
/// A port of `formatTokens` and `formatUsd` (`src/lib/utils.ts`) and of the line
/// `message-item.tsx` builds from them. It used to be a mono caption printed
/// under every answer; the web moved it one level down, into the menu's info
/// section, because no consumer chat product bills the reader per turn in the
/// reading column. Kept here, beside the message type, so the Mac's menu and
/// any later surface print the same string the web does.
public enum NativeMessageInfoFormat {
    /// `formatTokens`: 940 · 1.2K · 34K · 1.20M.
    ///
    /// Under 1,000 a rounded integer; under 10K one decimal and "K"; under 1M
    /// no decimals and "K"; otherwise two decimals and "M". Zero, negative and
    /// non-finite counts are "0", as on the web.
    public static func tokens(_ count: Double) -> String {
        guard count.isFinite, count > 0 else { return "0" }
        if count < 1_000 { return String(Int(count.rounded())) }
        if count < 1_000_000 {
            let thousands = count / 1_000
            return fixed(thousands, digits: count < 10_000 ? 1 : 0) + "K"
        }
        return fixed(count / 1_000_000, digits: 2) + "M"
    }

    public static func tokens(_ count: Int) -> String {
        tokens(Double(count))
    }

    /// `formatUsd`: <$0.0001 · $0.0032 · $0.123 · $1.23.
    ///
    /// Four decimals under a cent, three under a dollar, two above; anything
    /// that rounds to nothing at four places is "<$0.0001". Zero, negative and
    /// non-finite amounts are "$0".
    public static func usd(_ amount: Double) -> String {
        guard amount.isFinite, amount > 0 else { return "$0" }
        if amount < 0.0001 { return "<$0.0001" }
        if amount < 0.01 { return "$" + fixed(amount, digits: 4) }
        if amount < 1 { return "$" + fixed(amount, digits: 3) }
        return "$" + fixed(amount, digits: 2)
    }

    /// The whole receipt line, or nil when there is nothing to print.
    ///
    /// `"9.0K tokens (8.4K in · 612 out) · $0.021"`. The token half appears
    /// when either count is known — a missing side reads 0, as the web's `?? 0`
    /// does — and the cost half only when the turn cost something.
    public static func meta(
        promptTokens: Int?,
        completionTokens: Int?,
        costUSD: Double?
    ) -> String? {
        let hasUsage = promptTokens != nil || completionTokens != nil
        let hasCost = (costUSD ?? 0) > 0
        guard hasUsage || hasCost else { return nil }
        var line = ""
        if hasUsage {
            let input = promptTokens ?? 0
            let output = completionTokens ?? 0
            line = "\(tokens(input + output)) tokens (\(tokens(input)) in · \(tokens(output)) out)"
        }
        if hasCost, let costUSD {
            line += (hasUsage ? " · " : "") + usd(costUSD)
        }
        return line
    }

    /// JavaScript's `Number.prototype.toFixed` for a positive value.
    ///
    /// Not `String(format: "%.1f")`. Both round the double's *exact* binary
    /// value — which is why 9.95K reads "9.9K" on either, 9.95 being stored as
    /// 9.9499… — but they part at an exact tie: `toFixed` takes the larger
    /// neighbour (12,500 tokens is "13K"), where `printf` rounds half to even
    /// ("12K"). So the exact expansion is printed long and rounded here, half
    /// up.
    static func fixed(_ value: Double, digits: Int) -> String {
        let exact = String(format: "%.60f", locale: Locale(identifier: "en_US_POSIX"), value)
        guard let point = exact.firstIndex(of: ".") else { return exact }
        var whole = Array(exact[..<point])
        var fraction = Array(exact[exact.index(after: point)...])
        let next = fraction.count > digits ? fraction[digits] : "0"
        fraction = Array(fraction.prefix(digits))
        if next >= "5" {
            // Carry from the last kept digit leftwards, through the point.
            var carry = true
            for index in fraction.indices.reversed() where carry {
                if fraction[index] == "9" {
                    fraction[index] = "0"
                } else {
                    fraction[index] = Character(String(fraction[index].wholeNumberValue! + 1))
                    carry = false
                }
            }
            for index in whole.indices.reversed() where carry {
                if whole[index] == "9" {
                    whole[index] = "0"
                } else {
                    whole[index] = Character(String(whole[index].wholeNumberValue! + 1))
                    carry = false
                }
            }
            if carry { whole.insert("1", at: 0) }
        }
        return digits == 0 ? String(whole) : String(whole) + "." + String(fraction)
    }
}

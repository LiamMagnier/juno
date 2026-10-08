import Foundation

/// Number and date formatting for Live UI — the twin of `src/lib/live-ui/format.ts`.
///
/// `LiveCanonicalFormatter` is deterministic en-US so the Swift and TypeScript
/// evaluators can be held to the same fixture strings. `LivePlatformFormatter`
/// is what a reader sees: `NumberFormatter` in their own locale.
public enum LiveFormat: String, CaseIterable, Sendable {
    case number, integer, currency, percent, compact, date
}

public protocol LiveFormatting {
    func number(_ value: Double, format: LiveFormat, currency: String?, digits: Int?) -> String
    func date(_ iso: String) -> String
}

/// What an absent or failed value shows as.
public let liveNullText = "–"

/// Half away from zero, the one rounding rule both platforms implement.
public func liveRoundHalfAway(_ value: Double, _ digits: Double = 0) -> Double {
    let d = max(0, min(10, digits.rounded(.towardZero)))
    let f = pow(10, d)
    let sign: Double = value < 0 ? -1 : (value > 0 ? 1 : 0)
    let r = sign * (abs(value) * f + 0.5).rounded(.down) / f
    return r == 0 ? 0 : r
}

/// Integers plain, others to at most ten decimals with trailing zeros trimmed.
public func liveCanonicalNumberString(_ value: Double) -> String {
    guard value.isFinite else { return liveNullText }
    if value == 0 { return "0" }
    if abs(value) >= 1e15 { return String(format: "%.3e", value) }
    if value == value.rounded(.towardZero) { return String(Int64(value)) }
    var fixed = String(format: "%.10f", value)
    while fixed.hasSuffix("0") { fixed.removeLast() }
    if fixed.hasSuffix(".") { fixed.removeLast() }
    return fixed == "-0" ? "0" : fixed
}

public struct LiveCanonicalFormatter: LiveFormatting {
    public init() {}

    static let symbols: [String: String] = [
        "USD": "$", "EUR": "€", "GBP": "£", "JPY": "¥", "CNY": "CN¥", "INR": "₹",
        "CAD": "CA$", "AUD": "A$", "KRW": "₩", "BRL": "R$", "MXN": "MX$",
    ]
    static let zeroDecimal: Set<String> = ["JPY", "KRW"]

    static func group(_ digits: String) -> String {
        var out = ""
        for (index, character) in digits.reversed().enumerated() {
            if index > 0, index % 3 == 0 { out.append(",") }
            out.append(character)
        }
        return String(out.reversed())
    }

    static func fixedGrouped(_ value: Double, min minDigits: Int, max maxDigits: Int) -> String {
        let rounded = liveRoundHalfAway(value, Double(maxDigits))
        let negative = rounded < 0
        var text = String(format: "%.\(maxDigits)f", abs(rounded))
        if maxDigits > minDigits {
            let parts = text.split(separator: ".", omittingEmptySubsequences: false)
            var frac = parts.count > 1 ? String(parts[1]) : ""
            while frac.count > minDigits, frac.hasSuffix("0") { frac.removeLast() }
            text = frac.isEmpty ? String(parts[0]) : "\(parts[0]).\(frac)"
        }
        let parts = text.split(separator: ".", omittingEmptySubsequences: false)
        let body = parts.count > 1 ? "\(group(String(parts[0]))).\(parts[1])" : group(String(parts[0]))
        return negative ? "-\(body)" : body
    }

    static func clampDigits(_ digits: Int?, _ fallback: Int) -> Int {
        guard let digits else { return fallback }
        return max(0, min(6, digits))
    }

    public func number(_ value: Double, format: LiveFormat, currency: String?, digits: Int?) -> String {
        guard value.isFinite else { return liveNullText }
        switch format {
        case .integer:
            return Self.fixedGrouped(value, min: 0, max: 0)
        case .currency:
            let code = (currency ?? "USD").uppercased()
            let d = Self.clampDigits(digits, Self.zeroDecimal.contains(code) ? 0 : 2)
            let body = Self.fixedGrouped(abs(value), min: d, max: d)
            let symbol = Self.symbols[code] ?? "\(code) "
            let sign = liveRoundHalfAway(value, Double(d)) < 0 ? "-" : ""
            return "\(sign)\(symbol)\(body)"
        case .percent:
            return "\(Self.fixedGrouped(value * 100, min: 0, max: Self.clampDigits(digits, 1)))%"
        case .compact:
            let a = abs(value)
            let d = Self.clampDigits(digits, 1)
            let (div, suffix): (Double, String) =
                a >= 1e12 ? (1e12, "T") : a >= 1e9 ? (1e9, "B") : a >= 1e6 ? (1e6, "M") : a >= 1e3 ? (1e3, "K") : (1, "")
            return "\(Self.fixedGrouped(value / div, min: 0, max: d))\(suffix)"
        case .date:
            return liveNullText
        case .number:
            return Self.fixedGrouped(value, min: 0, max: Self.clampDigits(digits, 2))
        }
    }

    static let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

    public func date(_ iso: String) -> String {
        guard let parts = LiveDates.parse(iso) else { return liveNullText }
        return "\(Self.months[parts.month - 1]) \(parts.day), \(parts.year)"
    }
}

/// The reader's locale, through Foundation.
public struct LivePlatformFormatter: LiveFormatting {
    public let locale: Locale

    public init(locale: Locale = .current) {
        self.locale = locale
    }

    public func number(_ value: Double, format: LiveFormat, currency: String?, digits: Int?) -> String {
        guard value.isFinite else { return liveNullText }
        let f = NumberFormatter()
        f.locale = locale
        // Half away from zero, as the web's Intl does: €4.125 shows as €4.13 on both.
        f.roundingMode = .halfUp
        switch format {
        case .integer:
            f.numberStyle = .decimal
            f.maximumFractionDigits = 0
            return f.string(from: NSNumber(value: liveRoundHalfAway(value))) ?? liveNullText
        case .currency:
            f.numberStyle = .currency
            f.currencyCode = (currency ?? "USD").uppercased()
            if let digits {
                f.minimumFractionDigits = LiveCanonicalFormatter.clampDigits(digits, 2)
                f.maximumFractionDigits = LiveCanonicalFormatter.clampDigits(digits, 2)
            }
        case .percent:
            f.numberStyle = .percent
            f.maximumFractionDigits = LiveCanonicalFormatter.clampDigits(digits, 1)
        case .compact:
            // Foundation has no compact style on NumberFormatter; the canonical
            // suffixes with locale-aware digits are close enough and short.
            let a = abs(value)
            let (div, suffix): (Double, String) =
                a >= 1e12 ? (1e12, "T") : a >= 1e9 ? (1e9, "B") : a >= 1e6 ? (1e6, "M") : a >= 1e3 ? (1e3, "K") : (1, "")
            f.numberStyle = .decimal
            f.maximumFractionDigits = LiveCanonicalFormatter.clampDigits(digits, 1)
            return (f.string(from: NSNumber(value: value / div)) ?? liveNullText) + suffix
        case .date:
            return liveNullText
        case .number:
            f.numberStyle = .decimal
            f.maximumFractionDigits = LiveCanonicalFormatter.clampDigits(digits, 2)
        }
        return f.string(from: NSNumber(value: value)) ?? LiveCanonicalFormatter().number(value, format: format, currency: currency, digits: digits)
    }

    public func date(_ iso: String) -> String {
        guard let parts = LiveDates.parse(iso) else { return liveNullText }
        var components = DateComponents()
        components.year = parts.year
        components.month = parts.month
        components.day = parts.day
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .current
        guard let date = calendar.date(from: components) else { return LiveCanonicalFormatter().date(iso) }
        let f = DateFormatter()
        f.locale = locale
        f.timeZone = calendar.timeZone
        f.dateStyle = .medium
        return f.string(from: date)
    }
}

/// Civil-day arithmetic, identical to the TypeScript (Howard Hinnant's algorithms).
public enum LiveDates {
    public static func parse(_ text: String) -> (year: Int, month: Int, day: Int)? {
        let u = Array(text.utf8)
        guard u.count == 10, u[4] == 45, u[7] == 45 else { return nil }
        let digits = [0, 1, 2, 3, 5, 6, 8, 9]
        guard digits.allSatisfy({ u[$0] >= 48 && u[$0] <= 57 }) else { return nil }
        let num = { (r: Range<Int>) in r.reduce(0) { $0 * 10 + Int(u[$1] - 48) } }
        let year = num(0..<4), month = num(5..<7), day = num(8..<10)
        guard month >= 1, month <= 12, day >= 1 else { return nil }
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
        let dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
        guard day <= dim else { return nil }
        return (year, month, day)
    }

    static func floorDiv(_ a: Int, _ b: Int) -> Int {
        Int((Double(a) / Double(b)).rounded(.down))
    }

    public static func daysFromCivil(_ year: Int, _ month: Int, _ day: Int) -> Int {
        let y = month <= 2 ? year - 1 : year
        let era = floorDiv(y, 400)
        let yoe = y - era * 400
        let mp = (month + 9) % 12
        let doy = (153 * mp + 2) / 5 + day - 1
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        return era * 146_097 + doe - 719_468
    }

    public static func civilFromDays(_ z: Int) -> String {
        let zz = z + 719_468
        let era = floorDiv(zz, 146_097)
        let doe = zz - era * 146_097
        let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
        let mp = (5 * doy + 2) / 153
        let day = doy - (153 * mp + 2) / 5 + 1
        let month = mp < 10 ? mp + 3 : mp - 9
        let year = yoe + era * 400 + (month <= 2 ? 1 : 0)
        return String(format: "%04d-%02d-%02d", year, month, day)
    }
}

import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import Observation

/// `GET /api/profile/activity?tz=<IANA>`: the profile page's year of activity
/// (`src/lib/profile-activity.ts`, `ProfileActivity`).
///
/// Days are calendar keys ("2026-10-03") in the reader's zone, never instants,
/// exactly as the server sends them; ``NativeProfileDays`` does the arithmetic
/// on them through UTC midnight, where every day is 24 hours.
public struct NativeProfileActivity: Equatable, Sendable, Decodable {
    public struct Day: Equatable, Hashable, Sendable, Decodable {
        /// Local calendar date, YYYY-MM-DD.
        public let date: String
        public let tokens: Int

        public init(date: String, tokens: Int) {
            self.date = date
            self.tokens = tokens
        }

        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            date = try c.decode(String.self, forKey: .date)
            tokens = try c.decodeLenientInt(.tokens)
        }

        private enum CodingKeys: String, CodingKey { case date, tokens }
    }

    public struct LongestTask: Equatable, Sendable, Decodable {
        public let ms: Double
        /// `work` or `research`.
        public let kind: String

        public init(ms: Double, kind: String) {
            self.ms = ms
            self.kind = kind
        }
    }

    public struct Streak: Equatable, Sendable, Decodable {
        public let current: Int
        public let longest: Int

        public init(current: Int, longest: Int) {
            self.current = current
            self.longest = longest
        }
    }

    public struct Model: Equatable, Sendable, Decodable, Identifiable {
        /// Ledger id ("anthropic:claude-opus-5-5"), or "other" for the folded tail.
        public let model: String
        public let label: String
        /// The lab, for its mark; nil when the id names none the server knows.
        public let provider: String?
        public let tokens: Int
        public let requests: Int
        /// Share of all model tokens, 0...1.
        public let share: Double

        public var id: String { model }

        public init(model: String, label: String, provider: String?, tokens: Int, requests: Int, share: Double) {
            self.model = model
            self.label = label
            self.provider = provider
            self.tokens = tokens
            self.requests = requests
            self.share = share
        }

        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            model = try c.decode(String.self, forKey: .model)
            label = try c.decode(String.self, forKey: .label)
            provider = try c.decodeIfPresent(String.self, forKey: .provider)
            tokens = try c.decodeLenientInt(.tokens)
            requests = try c.decodeLenientInt(.requests)
            share = try c.decodeIfPresent(Double.self, forKey: .share) ?? 0
        }

        private enum CodingKeys: String, CodingKey { case model, label, provider, tokens, requests, share }
    }

    public let username: String?
    public let handle: String?
    public let timeZone: String
    public let today: String
    public let memberSince: String?
    public let lifetimeTokens: Int
    public let peakDay: Day?
    public let longestTask: LongestTask?
    public let streak: Streak
    public let activeDays: Int
    /// Active days inside the grid's window, ascending. Quiet days are absent.
    public let days: [Day]
    /// Ranked by tokens, the tail folded into one "Other" row.
    public let models: [Model]
    public let modelCount: Int

    public init(
        username: String? = nil,
        handle: String? = nil,
        timeZone: String,
        today: String,
        memberSince: String? = nil,
        lifetimeTokens: Int,
        peakDay: Day?,
        longestTask: LongestTask?,
        streak: Streak,
        activeDays: Int,
        days: [Day],
        models: [Model],
        modelCount: Int
    ) {
        self.username = username
        self.handle = handle
        self.timeZone = timeZone
        self.today = today
        self.memberSince = memberSince
        self.lifetimeTokens = lifetimeTokens
        self.peakDay = peakDay
        self.longestTask = longestTask
        self.streak = streak
        self.activeDays = activeDays
        self.days = days
        self.models = models
        self.modelCount = modelCount
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        username = try c.decodeIfPresent(String.self, forKey: .username)
        handle = try c.decodeIfPresent(String.self, forKey: .handle)
        timeZone = try c.decodeIfPresent(String.self, forKey: .timeZone) ?? "UTC"
        today = try c.decode(String.self, forKey: .today)
        memberSince = try c.decodeIfPresent(String.self, forKey: .memberSince)
        lifetimeTokens = try c.decodeLenientInt(.lifetimeTokens)
        peakDay = try c.decodeIfPresent(Day.self, forKey: .peakDay)
        longestTask = try c.decodeIfPresent(LongestTask.self, forKey: .longestTask)
        streak = try c.decodeIfPresent(Streak.self, forKey: .streak) ?? Streak(current: 0, longest: 0)
        activeDays = (try? c.decodeLenientInt(.activeDays)) ?? 0
        days = try c.decodeIfPresent([Day].self, forKey: .days) ?? []
        models = try c.decodeIfPresent([Model].self, forKey: .models) ?? []
        modelCount = (try? c.decodeLenientInt(.modelCount)) ?? models.count
    }

    private enum CodingKeys: String, CodingKey {
        case username, handle, timeZone, today, memberSince, lifetimeTokens, peakDay, longestTask
        case streak, activeDays, days, models, modelCount
    }

    public static func decode(_ data: Data) throws -> NativeProfileActivity {
        try JSONDecoder().decode(NativeProfileActivity.self, from: data)
    }

    /// Tokens across the grid's window (the web's "N tokens in the last year").
    public var yearTokens: Int { days.reduce(0) { $0 + $1.tokens } }
    public var isEmpty: Bool { lifetimeTokens == 0 }
}

extension KeyedDecodingContainer {
    /// A count the server sends as a JSON number: an integer, or a float that
    /// a SUM cast through `Number` may have produced.
    fileprivate func decodeLenientInt(_ key: Key) throws -> Int {
        if let value = try? decode(Int.self, forKey: key) { return value }
        if let value = try? decode(Double.self, forKey: key), value.isFinite { return Int(value.rounded()) }
        if (try? decodeNil(forKey: key)) == true || !contains(key) { return 0 }
        throw DecodingError.typeMismatch(Int.self, .init(codingPath: codingPath + [key], debugDescription: "not a number"))
    }
}

// MARK: - Day keys

/// Calendar-key arithmetic, as `profile-activity.ts` does it: through UTC
/// midnight of the date, so a key cannot drift across a daylight-saving change.
public enum NativeProfileDays {
    static let utc: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .gmt
        return calendar
    }()

    /// UTC midnight of a "YYYY-MM-DD" key.
    public static func date(_ key: String) -> Date? {
        let parts = key.split(separator: "-")
        guard parts.count == 3, let y = Int(parts[0]), let m = Int(parts[1]), let d = Int(parts[2]) else { return nil }
        return utc.date(from: DateComponents(year: y, month: m, day: d))
    }

    public static func key(_ date: Date) -> String {
        let c = utc.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 1970, c.month ?? 1, c.day ?? 1)
    }

    public static func addDays(_ key: String, _ n: Int) -> String {
        guard let date = date(key), let moved = utc.date(byAdding: .day, value: n, to: date) else { return key }
        return Self.key(moved)
    }

    /// Whole days from `a` to `b` (positive when `b` is later).
    public static func daysBetween(_ a: String, _ b: String) -> Int {
        guard let from = date(a), let to = date(b) else { return 0 }
        return Int((to.timeIntervalSince(from) / 86_400).rounded())
    }

    /// 0 = Monday … 6 = Sunday.
    public static func weekdayMondayFirst(_ key: String) -> Int {
        guard let date = date(key) else { return 0 }
        // Calendar weekday: 1 = Sunday … 7 = Saturday.
        return (utc.component(.weekday, from: date) + 5) % 7
    }

    /// Today's key in `timeZone`.
    public static func today(in timeZone: TimeZone, now: Date = Date()) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let c = calendar.dateComponents([.year, .month, .day], from: now)
        return String(format: "%04d-%02d-%02d", c.year ?? 1970, c.month ?? 1, c.day ?? 1)
    }
}

// MARK: - The chart's arithmetic

/// The pure half of the profile page (`profile-activity.ts`), ported so both
/// apps draw the same grid the web does: the week columns, the heat steps, the
/// weekly and cumulative views and the number formats.
public enum NativeProfileMath {
    public struct Cell: Equatable, Hashable, Sendable {
        public let date: String
        public let tokens: Int
    }

    /// One column of the grid: Monday to Sunday, nil for days after today.
    public typealias Week = [Cell?]

    public static let gridWeeks = 53

    /// `weeks` columns of seven days, Monday first, the last column holding today.
    public static func buildWeeks(_ days: [NativeProfileActivity.Day], today: String, weeks: Int = gridWeeks) -> [Week] {
        var byDate: [String: Int] = [:]
        for day in days { byDate[day.date] = day.tokens }
        let lastMonday = NativeProfileDays.addDays(today, -NativeProfileDays.weekdayMondayFirst(today))
        let firstMonday = NativeProfileDays.addDays(lastMonday, -7 * (weeks - 1))
        return (0..<weeks).map { w in
            (0..<7).map { d in
                let date = NativeProfileDays.addDays(firstMonday, w * 7 + d)
                return date > today ? nil : Cell(date: date, tokens: byDate[date] ?? 0)
            }
        }
    }

    /// The first day the grid draws.
    public static func gridStart(_ weeks: [Week]) -> String? {
        weeks.first?.compactMap { $0 }.first?.date
    }

    public struct MonthLabel: Equatable, Sendable {
        public let column: Int
        public let label: String
    }

    static let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

    /// Month names over the column holding the month's 1st; one closer than
    /// `minGap` columns to the previous is dropped (the leading partial month
    /// gives way to the first full one).
    public static func monthLabels(_ weeks: [Week], minGap: Int = 3) -> [MonthLabel] {
        var out: [MonthLabel] = []
        for (i, column) in weeks.enumerated() {
            var month: Int?
            if let first = column.compactMap({ $0 }).first(where: { $0.date.hasSuffix("-01") }) {
                month = Int(first.date.dropFirst(5).prefix(2)).map { $0 - 1 }
            } else if i == 0, let top = column.first ?? nil {
                month = Int(top.date.dropFirst(5).prefix(2)).map { $0 - 1 }
            }
            guard let month, months.indices.contains(month) else { continue }
            if let previous = out.last, i - previous.column < minGap {
                if previous.column == 0 { out.removeLast() } else { continue }
            }
            out.append(MonthLabel(column: i, label: months[month]))
        }
        return out
    }

    public struct WeekTotal: Equatable, Sendable {
        /// Monday of the week.
        public let start: String
        /// The last drawn day (today, for the current week).
        public let end: String
        public let tokens: Int
    }

    public static func weeklyTotals(_ weeks: [Week]) -> [WeekTotal] {
        weeks.map { column in
            let cells = column.compactMap { $0 }
            return WeekTotal(
                start: cells.first?.date ?? "",
                end: cells.last?.date ?? "",
                tokens: cells.reduce(0) { $0 + $1.tokens }
            )
        }
    }

    public struct CumulativePoint: Equatable, Sendable {
        public let date: String
        public let tokens: Int
        public let total: Int
    }

    /// One point per day from `start` through `today`, the total carried across quiet days.
    public static func cumulativeSeries(_ days: [NativeProfileActivity.Day], start: String, today: String) -> [CumulativePoint] {
        var byDate: [String: Int] = [:]
        for day in days { byDate[day.date] = day.tokens }
        let n = NativeProfileDays.daysBetween(start, today)
        guard n >= 0 else { return [] }
        var total = 0
        return (0...n).map { i in
            let date = NativeProfileDays.addDays(start, i)
            let tokens = byDate[date] ?? 0
            total += tokens
            return CumulativePoint(date: date, tokens: tokens, total: total)
        }
    }

    /// Cut points for heat levels 2, 3 and 4: the quartiles of the ACTIVE days,
    /// so one enormous day cannot flatten the rest into the faintest step.
    public static func heatThresholds(_ values: [Int]) -> (Double, Double, Double) {
        let active = values.filter { $0 > 0 }.sorted()
        guard !active.isEmpty else { return (.infinity, .infinity, .infinity) }
        func q(_ p: Double) -> Double {
            Double(active[min(active.count - 1, Int((p * Double(active.count)).rounded(.down)))])
        }
        return (q(0.25), q(0.5), q(0.75))
    }

    /// 0 for a quiet day, 1...4 by the thresholds.
    public static func heatLevel(_ value: Int, _ thresholds: (Double, Double, Double)) -> Int {
        let v = Double(value)
        if value <= 0 { return 0 }
        if v >= thresholds.2 { return 4 }
        if v >= thresholds.1 { return 3 }
        if v >= thresholds.0 { return 2 }
        return 1
    }

    /// Current and longest runs of consecutive active days; the current run may
    /// end yesterday (someone who has not opened the app today has not broken it).
    public static func streaks(_ activeDates: [String], today: String) -> NativeProfileActivity.Streak {
        let set = Set(activeDates)
        var longest = 0
        var run = 0
        var previous: String?
        for date in set.sorted() {
            run = previous.map { NativeProfileDays.daysBetween($0, date) == 1 } == true ? run + 1 : 1
            longest = max(longest, run)
            previous = date
        }
        var current = 0
        var cursor = set.contains(today) ? today : NativeProfileDays.addDays(today, -1)
        while set.contains(cursor) {
            current += 1
            cursor = NativeProfileDays.addDays(cursor, -1)
        }
        return .init(current: current, longest: longest)
    }

    // MARK: Formats

    /// 171.5M, 12.3K, 999, 1.2B: one decimal, a trailing ".0" dropped, a unit up at the rollover.
    public static func formatTokens(_ n: Int) -> String {
        let v = max(0, n)
        if v < 1000 { return String(v) }
        let units: [(Double, String)] = [(1e3, "K"), (1e6, "M"), (1e9, "B")]
        var i = v >= 1_000_000_000 ? 2 : v >= 1_000_000 ? 1 : 0
        var scaled = (Double(v) / units[i].0 * 10).rounded() / 10
        if scaled >= 1000, i < units.count - 1 {
            i += 1
            scaled = (Double(v) / units[i].0 * 10).rounded() / 10
        }
        return trimZero(scaled) + units[i].1
    }

    /// 1,234,567, where the exact count is the point.
    public static func formatTokensExact(_ n: Int, locale: Locale = .current) -> String {
        max(0, n).formatted(.number.locale(locale))
    }

    /// 42s, 38m, 1h 38m, 2h, 1d 4h.
    public static func formatDuration(ms: Double) -> String {
        let s = Int(max(0, (ms / 1000).rounded()))
        if s < 60 { return "\(s)s" }
        let m = s / 60
        if m < 60 { return "\(m)m" }
        let h = m / 60
        if h < 24 { return m % 60 != 0 ? "\(h)h \(m % 60)m" : "\(h)h" }
        let d = h / 24
        return h % 24 != 0 ? "\(d)d \(h % 24)h" : "\(d)d"
    }

    public static func formatDays(_ n: Int) -> String {
        n == 1 ? "1 day" : "\(n) days"
    }

    /// "37%", "<1%" for a sliver.
    public static func formatShare(_ share: Double) -> String {
        let pct = share * 100
        if pct > 0, pct < 1 { return "<1%" }
        return "\(Int(pct.rounded()))%"
    }

    /// "Thu, Oct 2, 2026", read as that calendar date (not shifted by any zone).
    public static func formatDayLong(_ key: String, locale: Locale = .current) -> String {
        guard let date = NativeProfileDays.date(key) else { return key }
        var style = Date.FormatStyle.dateTime.weekday(.abbreviated).month(.abbreviated).day().year().locale(locale)
        style.timeZone = NativeProfileDays.utc.timeZone
        return date.formatted(style)
    }

    /// "Oct 2".
    public static func formatDayShort(_ key: String, locale: Locale = .current) -> String {
        guard let date = NativeProfileDays.date(key) else { return key }
        var style = Date.FormatStyle.dateTime.month(.abbreviated).day().locale(locale)
        style.timeZone = NativeProfileDays.utc.timeZone
        return date.formatted(style)
    }

    private static func trimZero(_ x: Double) -> String {
        let text = String(format: "%.1f", x)
        return text.hasSuffix(".0") ? String(text.dropLast(2)) : text
    }
}

// MARK: - Client

/// Reads the profile's activity. Owner-scoped by the bearer token; `tz` is the
/// reader's IANA zone so a square on the grid is the reader's day.
public struct NativeProfileClient: Sendable {
    public static let activityPath = "/api/profile/activity"

    private let sender: any NativeAuthenticatedRequestSending

    public init(sender: any NativeAuthenticatedRequestSending) {
        self.sender = sender
    }

    public func activity(timeZone: String = TimeZone.current.identifier, for accountID: AccountID) async throws -> NativeProfileActivity {
        let response = try await sender.send(
            try NativeBearerRequest(
                path: Self.activityPath,
                method: .get,
                queryItems: [URLQueryItem(name: "tz", value: timeZone)],
                headers: try HTTPHeaders(["accept": "application/json"])
            ),
            for: accountID
        )
        if let error = NativeWebRouteError.from(response, fallback: "Couldn’t load your activity.") { throw error }
        do {
            return try NativeProfileActivity.decode(response.body)
        } catch {
            throw NativeWebRouteError(statusCode: response.statusCode, message: "Couldn’t load your activity.")
        }
    }
}

/// Daily squares, weekly bars, or the running total.
public enum NativeProfileChartKind: String, CaseIterable, Identifiable, Sendable {
    case daily, weekly, cumulative
    public var id: Self { self }
    public var label: String {
        switch self {
        case .daily: "Daily"
        case .weekly: "Weekly"
        case .cumulative: "Cumulative"
        }
    }
}

/// The profile screen's state: one read, a retry, and the chart's view.
@MainActor
@Observable
public final class NativeProfileModel {
    public enum State: Equatable {
        case loading
        case loaded(NativeProfileActivity)
        case failed(String)
    }

    public private(set) var state: State = .loading
    public var chart: NativeProfileChartKind = .daily

    private let client: NativeProfileClient?
    private let accountID: AccountID
    private let timeZone: String

    public init(client: NativeProfileClient?, accountID: AccountID, timeZone: String = TimeZone.current.identifier) {
        self.client = client
        self.accountID = accountID
        self.timeZone = timeZone
    }

    /// A model that already holds its activity (previews and snapshots).
    public init(activity: NativeProfileActivity, accountID: AccountID) {
        self.client = nil
        self.accountID = accountID
        self.timeZone = activity.timeZone
        self.state = .loaded(activity)
    }

    public var activity: NativeProfileActivity? {
        if case .loaded(let activity) = state { return activity }
        return nil
    }

    public func load() async {
        guard let client else {
            if activity == nil { state = .failed("Couldn’t load your activity.") }
            return
        }
        if activity == nil { state = .loading }
        do {
            state = .loaded(try await client.activity(timeZone: timeZone, for: accountID))
        } catch {
            // A refresh that fails keeps what is on screen.
            if activity == nil {
                state = .failed((error as? NativeWebRouteError)?.message ?? "Couldn’t load your activity.")
            }
        }
    }
}

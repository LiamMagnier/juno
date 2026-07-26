import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import SwiftUI

/// The decoded shape of `/api/profile/usage/breakdown`, and the pure derivations
/// the Usage screen draws from it.
///
/// Split from the view so the two pieces of real logic here — laying a run of
/// days out on a weekday grid, and choosing an intensity level for a day — can
/// be asserted directly. Both used to be the kind of arithmetic that is only
/// ever checked by looking at the screen and deciding it "looks about right".

// MARK: - Wire

struct NativeUsageBreakdownWire: Decodable {
    struct Range: Decodable {
        let startMs: Double
        let endMs: Double
        let days: Int
    }

    struct Totals: Decodable {
        let requests: Int
        let promptTokens: Int
        let completionTokens: Int
        let totalTokens: Int
        let costMicroUsd: Int
    }

    struct Surface: Decodable {
        let surface: String
        let requests: Int
        let promptTokens: Int
        let completionTokens: Int
        let totalTokens: Int
        let costMicroUsd: Int
    }

    struct Model: Decodable {
        let model: String
        let requests: Int
        let totalTokens: Int
        let costMicroUsd: Int
    }

    struct Day: Decodable {
        let dayMs: Double
        let requests: Int
        let totalTokens: Int
        let costMicroUsd: Int
    }

    struct Pace: Decodable {
        let lastHour: Int
        let last24h: Int
    }

    let range: Range
    let totals: Totals
    let surfaces: [Surface]
    let models: [Model]
    let daily: [Day]
    let activeDays: Int
    let currentStreakDays: Int
    let longestStreakDays: Int
    let pace: Pace
}

// MARK: - Range

/// How far back the Usage screen looks. Three windows, not a date picker: the
/// question this page answers is "how am I using Juno", and that is a question
/// about a habit rather than about a fortnight in March.
public enum NativeUsageRange: String, CaseIterable, Identifiable, Sendable {
    case month
    case quarter
    case year

    public var id: Self { self }

    public var days: Int {
        switch self {
        case .month: 30
        case .quarter: 90
        case .year: 365
        }
    }

    public var label: String {
        switch self {
        case .month: "30 days"
        case .quarter: "90 days"
        case .year: "12 months"
        }
    }

    public var subtitle: String {
        switch self {
        case .month: "last 30 days"
        case .quarter: "last 90 days"
        case .year: "last 12 months"
        }
    }
}

// MARK: - Domain

public struct NativeUsageTotals: Equatable, Sendable {
    public let requests: Int
    public let promptTokens: Int
    public let completionTokens: Int
    public let totalTokens: Int
    public let costMicroUsd: Int
}

public struct NativeUsageSurfaceTotals: Identifiable, Equatable, Sendable {
    public let surface: String
    public let requests: Int
    public let totalTokens: Int
    public let costMicroUsd: Int

    public init(surface: String, requests: Int, totalTokens: Int, costMicroUsd: Int) {
        self.surface = surface
        self.requests = requests
        self.totalTokens = totalTokens
        self.costMicroUsd = costMicroUsd
    }

    public var id: String { surface }

    /// The product's own name for the surface. An unrecognised `kind` — one a
    /// newer server records and this build does not know — is capitalised rather
    /// than dropped, so a new surface shows up as itself instead of vanishing
    /// from a total it contributed to.
    public var displayName: String {
        switch surface {
        case "chat": "Chat"
        case "code": "Code"
        case "task": "Tasks"
        case "image": "Images"
        case "video": "Video"
        case "voice": "Voice"
        default: surface.capitalized
        }
    }

    public var symbol: String {
        switch surface {
        case "chat": "bubble.left.and.bubble.right"
        case "code": "chevron.left.forwardslash.chevron.right"
        case "task": "clock"
        case "image": "photo"
        case "video": "film"
        case "voice": "waveform"
        default: "circle.dashed"
        }
    }
}

public struct NativeUsageModelTotals: Identifiable, Equatable, Sendable {
    public let model: String
    public let requests: Int
    public let totalTokens: Int
    public let costMicroUsd: Int

    public var id: String { model }
}

public struct NativeUsageDay: Equatable, Sendable {
    public let dayMs: Double
    public let requests: Int
    public let totalTokens: Int

    public init(dayMs: Double, requests: Int, totalTokens: Int) {
        self.dayMs = dayMs
        self.requests = requests
        self.totalTokens = totalTokens
    }
}

public struct NativeUsagePace: Equatable, Sendable {
    public let lastHour: Int
    public let last24h: Int
}

public struct NativeUsageBreakdown: Equatable, Sendable {
    public let startMs: Double
    public let endMs: Double
    public let totals: NativeUsageTotals
    public let surfaces: [NativeUsageSurfaceTotals]
    public let models: [NativeUsageModelTotals]
    public let daily: [NativeUsageDay]
    public let activeDays: Int
    public let currentStreakDays: Int
    public let longestStreakDays: Int
    public let pace: NativeUsagePace

    init(_ wire: NativeUsageBreakdownWire) {
        startMs = wire.range.startMs
        endMs = wire.range.endMs
        totals = NativeUsageTotals(
            requests: wire.totals.requests,
            promptTokens: wire.totals.promptTokens,
            completionTokens: wire.totals.completionTokens,
            totalTokens: wire.totals.totalTokens,
            costMicroUsd: wire.totals.costMicroUsd
        )
        surfaces = wire.surfaces.map {
            NativeUsageSurfaceTotals(
                surface: $0.surface,
                requests: $0.requests,
                totalTokens: $0.totalTokens,
                costMicroUsd: $0.costMicroUsd
            )
        }
        models = wire.models.map {
            NativeUsageModelTotals(
                model: $0.model,
                requests: $0.requests,
                totalTokens: $0.totalTokens,
                costMicroUsd: $0.costMicroUsd
            )
        }
        daily = wire.daily.map {
            NativeUsageDay(dayMs: $0.dayMs, requests: $0.requests, totalTokens: $0.totalTokens)
        }
        activeDays = wire.activeDays
        currentStreakDays = wire.currentStreakDays
        longestStreakDays = wire.longestStreakDays
        pace = NativeUsagePace(lastHour: wire.pace.lastHour, last24h: wire.pace.last24h)
    }

    public var busiestDay: NativeUsageDay? {
        daily.max { $0.requests < $1.requests }
    }

    /// The window laid out as a contribution grid: one cell per day, padded at
    /// the front so the first column starts on a Sunday.
    public var activityCells: [NativeUsageActivityCell] {
        NativeUsageActivityCell.grid(startMs: startMs, endMs: endMs, days: daily)
    }
}

// MARK: - Activity grid

/// One day in the contribution grid.
///
/// A cell knows only its day and its counts; the *level* is assigned across the
/// whole window, because an absolute scale would make a quiet month look
/// identical to a busy one on a different account.
public struct NativeUsageActivityCell: Identifiable, Equatable, Sendable {
    public let dayMs: Double
    public let requests: Int
    public let totalTokens: Int
    /// 0 = no activity, 1…4 = quartiles of the window's active days.
    public let level: Int
    /// A leading pad cell, present only so the first real day lands on its own
    /// weekday row. Drawn as empty space, never as a quiet day.
    public let isPadding: Bool

    public init(
        dayMs: Double,
        requests: Int,
        totalTokens: Int,
        level: Int,
        isPadding: Bool
    ) {
        self.dayMs = dayMs
        self.requests = requests
        self.totalTokens = totalTokens
        self.level = level
        self.isPadding = isPadding
    }

    public var id: Double { dayMs }

    public var fill: Color {
        isPadding ? .clear : Self.fill(forLevel: level)
    }

    public static func fill(forLevel level: Int) -> Color {
        switch level {
        case 1: Color.junoAccent.opacity(0.28)
        case 2: Color.junoAccent.opacity(0.50)
        case 3: Color.junoAccent.opacity(0.72)
        case 4: Color.junoAccent
        // Level 0 is the empty track, and it has to stay visible against the
        // card behind it — an invisible zero cell turns the grid into a
        // scattering of coloured squares with no calendar to read them against.
        default: Color.junoMuted
        }
    }

    public var summary: String {
        let date = Date(timeIntervalSince1970: dayMs / 1000)
        let day = date.formatted(
            Date.FormatStyle(date: .abbreviated, time: .omitted).locale(.autoupdatingCurrent)
        )
        guard requests > 0 else { return "\(day): no activity" }
        return "\(day): \(requests) request\(requests == 1 ? "" : "s"), \(NativeUsageFormat.tokens(totalTokens)) tokens"
    }

    /// Lay a window of days out as a Sunday-first grid.
    ///
    /// Days come back from the server only for dates that had activity, so the
    /// run is rebuilt here from `startMs` to the last day of the window and the
    /// quiet days are filled in — otherwise the grid would silently compress,
    /// putting cells on the wrong weekday and making a gap look like a weekend.
    ///
    /// All arithmetic is on the UTC day grid the server buckets on. `Calendar`
    /// is deliberately not used: its week rules are locale-dependent, and a grid
    /// whose column boundaries move with the reader's region would not line up
    /// with the day buckets in the same response.
    public static func grid(
        startMs: Double,
        endMs: Double,
        days: [NativeUsageDay]
    ) -> [NativeUsageActivityCell] {
        let dayMs = 86_400_000.0
        guard startMs > 0, endMs >= startMs else { return [] }

        let start = (startMs / dayMs).rounded(.down) * dayMs
        let end = (endMs / dayMs).rounded(.down) * dayMs
        // A year of daily cells is ~365; the bound only stops a malformed range
        // from allocating without limit.
        let span = Int(((end - start) / dayMs).rounded()) + 1
        guard span > 0, span <= 400 else { return [] }

        var counts: [Double: NativeUsageDay] = [:]
        for day in days {
            counts[(day.dayMs / dayMs).rounded(.down) * dayMs] = day
        }

        // Levels are quartiles over the window's *active* days, so the scale
        // adapts to how this account actually works. Ties go to the lower level.
        let active = days.map(\.requests).filter { $0 > 0 }.sorted()
        let thresholds = quartiles(of: active)

        // Epoch day 0 (1 Jan 1970) was a Thursday; Sunday-first columns need
        // that offset, and it is the only place the weekday convention is fixed.
        let epochDayOfStart = Int((start / dayMs).rounded())
        let leading = (epochDayOfStart + 4) % 7

        var cells: [NativeUsageActivityCell] = []
        cells.reserveCapacity(span + leading)
        for pad in 0..<leading {
            cells.append(
                NativeUsageActivityCell(
                    dayMs: start - Double(leading - pad) * dayMs,
                    requests: 0,
                    totalTokens: 0,
                    level: 0,
                    isPadding: true
                )
            )
        }
        for offset in 0..<span {
            let key = start + Double(offset) * dayMs
            let day = counts[key]
            let requests = day?.requests ?? 0
            cells.append(
                NativeUsageActivityCell(
                    dayMs: key,
                    requests: requests,
                    totalTokens: day?.totalTokens ?? 0,
                    level: level(for: requests, thresholds: thresholds),
                    isPadding: false
                )
            )
        }
        return cells
    }

    /// The three cut points between levels 1–4, from the sorted active counts.
    /// Fewer than four distinct values simply produce repeated thresholds, which
    /// collapses the scale rather than inventing gradations that are not there.
    public static func quartiles(of sortedActive: [Int]) -> (Int, Int, Int) {
        guard let last = sortedActive.last, !sortedActive.isEmpty else { return (1, 2, 3) }
        func percentile(_ p: Double) -> Int {
            let index = Int((Double(sortedActive.count - 1) * p).rounded())
            return sortedActive[max(0, min(sortedActive.count - 1, index))]
        }
        return (percentile(0.25), percentile(0.5), percentile(0.75) == last ? max(1, last - 1) : percentile(0.75))
    }

    public static func level(for requests: Int, thresholds: (Int, Int, Int)) -> Int {
        guard requests > 0 else { return 0 }
        if requests > thresholds.2 { return 4 }
        if requests > thresholds.1 { return 3 }
        if requests > thresholds.0 { return 2 }
        return 1
    }
}

// MARK: - Formatting

public enum NativeUsageFormat {
    /// Tokens at dashboard scale: 2.60B, 175M, 52.7K.
    ///
    /// Three significant figures rather than a fixed number of decimals, so the
    /// headline keeps roughly the same visual width as it grows through two
    /// orders of magnitude instead of jumping from "2.6B" to "952.3B".
    ///
    /// `locale` is a parameter only so the tests can pin one: these are
    /// user-facing numbers and the decimal separator has to follow the reader's
    /// region, which would otherwise make the assertions pass or fail depending
    /// on the machine they run on.
    public static func tokens(_ value: Int, locale: Locale = .autoupdatingCurrent) -> String {
        let magnitude = Double(value)
        switch magnitude {
        case 1_000_000_000...:
            return "\(significant(magnitude / 1_000_000_000, locale: locale))B"
        case 1_000_000...:
            return "\(significant(magnitude / 1_000_000, locale: locale))M"
        case 1_000...:
            return "\(significant(magnitude / 1_000, locale: locale))K"
        default:
            return value.formatted(.number.locale(locale))
        }
    }

    private static func significant(_ value: Double, locale: Locale) -> String {
        let decimals = value >= 100 ? 0 : (value >= 10 ? 1 : 2)
        return value.formatted(.number.precision(.fractionLength(decimals)).locale(locale))
    }

    /// A plain count with the locale's grouping separator.
    public static func count(_ value: Int, locale: Locale = .autoupdatingCurrent) -> String {
        value.formatted(.number.locale(locale))
    }

    public static func day(_ dayMs: Double) -> String {
        Date(timeIntervalSince1970: dayMs / 1000)
            .formatted(Date.FormatStyle(date: .abbreviated, time: .omitted))
    }

    /// The grid's month ruler reads in UTC, matching the cells beneath it.
    public static func month(_ cell: NativeUsageActivityCell) -> String {
        var style = Date.FormatStyle(date: .abbreviated, time: .omitted)
        style.timeZone = TimeZone(identifier: "UTC") ?? .gmt
        let text = Date(timeIntervalSince1970: cell.dayMs / 1000).formatted(style)
        // "3 Feb 2026" / "Feb 3, 2026" → "Feb", without a second formatter and
        // without assuming the locale puts the month first.
        return text
            .split(whereSeparator: { $0 == " " || $0 == "," })
            .first(where: { $0.contains(where: \.isLetter) })
            .map(String.init) ?? text
    }

    public static func isFirstOfMonth(_ cell: NativeUsageActivityCell) -> Bool {
        guard !cell.isPadding else { return false }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .gmt
        return calendar.component(.day, from: Date(timeIntervalSince1970: cell.dayMs / 1000)) == 1
    }
}

// MARK: - Plan meters

struct NativeUsagePlanWire: Decodable {
    struct Quota: Decodable {
        let plan: String
    }

    struct Window: Decodable {
        let pct: Double
        let resetsAtMs: Double?
    }

    struct Windows: Decodable {
        let session: Window
        let weekly: Window
    }

    struct Billing: Decodable {
        let renewsAtMs: Double?
        let cancelAtPeriodEnd: Bool
    }

    struct Spend: Decodable {
        let spentMicroUsd: Double
        let budgetMicroUsd: Double?
        let windows: Windows
        let billing: Billing
    }

    let quota: Quota
    let spend: Spend
}

public struct NativeUsagePlan: Equatable, Sendable {
    public struct Window: Equatable, Sendable {
        /// 0…1 of the window's allowance already spent.
        public let fraction: Double
        public let resetsAt: Date?
    }

    public let planID: String
    public let session: Window
    public let weekly: Window
    public let budgetMicroUsd: Double?
    public let renewsAt: Date?
    public let cancelAtPeriodEnd: Bool

    public var isUnlimited: Bool { budgetMicroUsd == nil }

    public var isBrowseOnly: Bool {
        guard let budgetMicroUsd else { return false }
        return budgetMicroUsd <= 0
    }

    public var planName: String {
        switch planID.uppercased() {
        case "FREE": "Free"
        case "PRO": "Pro"
        case "MAX": "Max x5"
        case "MAX20": "Max x20"
        case "OWNER": "Owner"
        default: planID
        }
    }

    public var renewalLabel: String {
        cancelAtPeriodEnd ? "Access ends" : "Budget renews"
    }

    init(_ wire: NativeUsagePlanWire) {
        planID = wire.quota.plan
        session = Window(
            fraction: wire.spend.windows.session.pct,
            resetsAt: Self.date(wire.spend.windows.session.resetsAtMs)
        )
        weekly = Window(
            fraction: wire.spend.windows.weekly.pct,
            resetsAt: Self.date(wire.spend.windows.weekly.resetsAtMs)
        )
        budgetMicroUsd = wire.spend.budgetMicroUsd
        renewsAt = Self.date(wire.spend.billing.renewsAtMs)
        cancelAtPeriodEnd = wire.spend.billing.cancelAtPeriodEnd
    }

    private static func date(_ value: Double?) -> Date? {
        guard let value, value > 0 else { return nil }
        return Date(timeIntervalSince1970: value / 1000)
    }
}

// MARK: - Client

public enum NativeUsageError: LocalizedError {
    case unavailable
    /// The account's server has no `/api/profile/usage/breakdown` route.
    ///
    /// A 404 here means the deployment predates the detailed-usage endpoint, not
    /// that anything is broken — the plan meters on the older route still work.
    /// Distinguishing it matters: treating "this server is older than the app"
    /// as a failure produced a screen that said Juno couldn't load the usage,
    /// when in fact there was nothing wrong to fix from the app's side.
    case notSupportedByServer
    case server(message: String)

    public var errorDescription: String? {
        switch self {
        case .unavailable:
            "Juno is not signed in to a server that can report usage."
        case .notSupportedByServer:
            "This Juno server doesn't report detailed usage yet. Your plan limits are shown below."
        case .server(let message):
            message
        }
    }
}

/// What one read of the usage routes produced.
///
/// Both halves are optional because they fail independently and for different
/// reasons: an older server has the meters but not the breakdown, and a signed-out
/// one has neither. A screen can render whatever arrived instead of being blanked
/// by the weakest link.
public struct NativeUsageSnapshot: Sendable {
    public let breakdown: NativeUsageBreakdown?
    public let plan: NativeUsagePlan?
    /// Why `breakdown` is absent, when it is.
    public let breakdownFailure: NativeUsageError?

    public init(
        breakdown: NativeUsageBreakdown?,
        plan: NativeUsagePlan?,
        breakdownFailure: NativeUsageError?
    ) {
        self.breakdown = breakdown
        self.plan = plan
        self.breakdownFailure = breakdownFailure
    }

    /// True when the only thing missing is the newer route — the case worth
    /// explaining rather than reporting as an error.
    public var isServerTooOld: Bool {
        if case .notSupportedByServer = breakdownFailure { return true }
        return false
    }
}

/// Reads the account's own usage.
///
/// Two routes on purpose — the plan meters are cheap and read on every settings
/// open, the breakdown scans a year of ledger rows — but every screen that shows
/// usage shows both, so ``load(range:for:)`` asks for both at once rather than
/// making the reader watch two spinners resolve in sequence.
///
/// Everything comes from `/api/profile/usage/breakdown`, which aggregates the
/// `ApiSpend` ledger — the same rows the budget gate reads before it lets a turn
/// start. That matters more than it sounds: a usage screen built from anything
/// else (message counts, conversation lengths, a local tally) can disagree with
/// the number that actually stops the user working, and a dashboard that
/// disagrees with the meter is worse than no dashboard.
public struct NativeUsageClient: Sendable {
    private let sender: any NativeAuthenticatedRequestSending

    public init(sender: any NativeAuthenticatedRequestSending) {
        self.sender = sender
    }

    /// Both halves, each reported on its own terms.
    ///
    /// Neither failure throws. The two routes fail for genuinely different
    /// reasons — a server older than the app has the meters but not the
    /// breakdown — and collapsing that into one thrown error is what produced a
    /// Usage screen showing "Juno could not load your usage" against a
    /// deployment where nothing was wrong and the plan limits were readable the
    /// whole time.
    public func load(
        range: NativeUsageRange,
        for accountID: AccountID
    ) async -> NativeUsageSnapshot {
        async let breakdownResult = fetch(
            NativeUsageBreakdownWire.self,
            path: "/api/profile/usage/breakdown",
            query: [URLQueryItem(name: "days", value: String(range.days))],
            for: accountID
        )
        async let planResult = fetch(
            NativeUsagePlanWire.self,
            path: "/api/profile/usage",
            query: [],
            for: accountID
        )

        var breakdown: NativeUsageBreakdown?
        var failure: NativeUsageError?
        do {
            breakdown = NativeUsageBreakdown(try await breakdownResult)
        } catch let error as NativeUsageError {
            failure = error
        } catch {
            failure = .server(message: error.localizedDescription)
        }

        return NativeUsageSnapshot(
            breakdown: breakdown,
            plan: (try? await planResult).map(NativeUsagePlan.init),
            breakdownFailure: failure
        )
    }

    private func fetch<Wire: Decodable>(
        _ type: Wire.Type,
        path: String,
        query: [URLQueryItem],
        for accountID: AccountID
    ) async throws -> Wire {
        let response = try await sender.send(
            try NativeBearerRequest(
                path: path,
                queryItems: query,
                headers: try HTTPHeaders(["accept": "application/json"])
            ),
            for: accountID
        )
        // 404 is "this route does not exist here", which for an app that ships
        // ahead of its backend means the server is older — not that the request
        // was wrong. Everything else is a real failure.
        if response.statusCode == 404 {
            throw NativeUsageError.notSupportedByServer
        }
        guard (200...299).contains(response.statusCode) else {
            let object = try? JSONSerialization.jsonObject(with: response.body) as? [String: Any]
            throw NativeUsageError.server(
                message: (object?["error"] as? String)
                    ?? "Juno could not load your usage (\(response.statusCode))."
            )
        }
        return try JSONDecoder().decode(Wire.self, from: response.body)
    }
}

import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoSync
import Observation

public enum NativeTaskCadence: String, CaseIterable, Identifiable, Sendable {
    case daily = "DAILY"
    case weekdays = "WEEKDAYS"
    case weekly = "WEEKLY"
    case monthly = "MONTHLY"

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .daily: String(localized: "tasks.cadence.daily")
        case .weekdays: String(localized: "tasks.cadence.weekdays")
        case .weekly: String(localized: "tasks.cadence.weekly")
        case .monthly: String(localized: "tasks.cadence.monthly")
        }
    }

    public var needsWeekday: Bool { self == .weekly }
    public var needsMonthday: Bool { self == .monthly }
}

/// The most recent execution of a task. `status` is the server's own vocabulary
/// (`running` · `done` · `error` · `budget`) rather than a native re-mapping, so
/// a status added on the server shows up as itself instead of vanishing.
public struct NativeTaskRun: Equatable, Sendable {
    public let id: String
    public let status: String
    public let errorDescription: String?
    public let costMicroUSD: Int
    public let startedAt: Date
    public let finishedAt: Date?

    public var isRunning: Bool { status == "running" }
    public var didFail: Bool { status == "error" || status == "budget" }
}

public struct NativeScheduledTask: Identifiable, Equatable, Sendable {
    public let id: String
    public var name: String
    public var prompt: String
    public var model: String
    public var modelName: String
    public var cadence: NativeTaskCadence
    public var hour: Int
    public var minute: Int
    /// 0 = Sunday, matching the server and `WEEKDAY_LABELS` on the web.
    public var weekday: Int?
    /// 1–28, so a monthly task lands inside every month.
    public var monthday: Int?
    public var timezone: String
    public var webSearch: Bool
    public var enabled: Bool
    public var lastRunAt: Date?
    public var nextRunAt: Date
    /// The chat the task writes its results into, once it has run at least once.
    public var conversationID: String?
    public var latestRun: NativeTaskRun?

    /// "Daily · 08:00", "Weekly · Mon 09:00", "Monthly · 15th 09:00" — the same
    /// sentence the web card shows, so the two clients describe one schedule the
    /// same way.
    public var scheduleDescription: String {
        let time = String(format: "%02d:%02d", hour, minute)
        let base: String
        switch cadence {
        case .daily: base = "\(NativeTaskCadence.daily.label) · \(time)"
        case .weekdays: base = "\(NativeTaskCadence.weekdays.label) · \(time)"
        case .weekly:
            base = "\(NativeTaskCadence.weekly.label) · \(Self.weekdayLabel(weekday ?? 1)) \(time)"
        case .monthly:
            base = "\(NativeTaskCadence.monthly.label) · \(Self.ordinal(monthday ?? 1)) \(time)"
        }
        return timezone == NativeScheduledTask.defaultTimezone ? base : "\(base) (\(timezone))"
    }

    public static let defaultTimezone = "Europe/Paris"

    public static func weekdayLabel(_ index: Int) -> String {
        let symbols = Calendar(identifier: .gregorian).shortWeekdaySymbols
        guard symbols.indices.contains(index) else { return symbols.first ?? "" }
        return symbols[index]
    }

    public static func ordinal(_ value: Int) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .ordinal
        return formatter.string(from: NSNumber(value: value)) ?? "\(value)"
    }
}

/// Everything needed to create or amend a task. One type for both because the
/// server's PATCH is a partial of its POST, and a second near-identical struct
/// is how the two drift.
public struct NativeScheduledTaskDraft: Equatable, Sendable {
    public var name: String
    public var prompt: String
    public var model: String
    public var cadence: NativeTaskCadence
    public var hour: Int
    public var minute: Int
    public var weekday: Int?
    public var monthday: Int?
    public var timezone: String
    public var webSearch: Bool

    public init(
        name: String = "",
        prompt: String = "",
        model: String = "",
        cadence: NativeTaskCadence = .daily,
        hour: Int = 8,
        minute: Int = 0,
        weekday: Int? = 1,
        monthday: Int? = 1,
        timezone: String = TimeZone.current.identifier,
        webSearch: Bool = true
    ) {
        self.name = name
        self.prompt = prompt
        self.model = model
        self.cadence = cadence
        self.hour = hour
        self.minute = minute
        self.weekday = weekday
        self.monthday = monthday
        self.timezone = timezone
        self.webSearch = webSearch
    }

    public init(task: NativeScheduledTask) {
        self.init(
            name: task.name,
            prompt: task.prompt,
            model: task.model,
            cadence: task.cadence,
            hour: task.hour,
            minute: task.minute,
            weekday: task.weekday ?? 1,
            monthday: task.monthday ?? 1,
            timezone: task.timezone,
            webSearch: task.webSearch
        )
    }

    public var isValid: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !model.isEmpty
    }
}

public enum NativeScheduledTaskError: Error, Equatable, LocalizedError, Sendable {
    case malformedResponse
    /// The account's plan allows no scheduled tasks, or it is already at its
    /// ceiling. Carries the server's own sentence — it names the actual limit.
    case planLimited(String)
    case server(statusCode: Int, message: String)

    public var errorDescription: String? {
        switch self {
        case .malformedResponse: String(localized: "tasks.error.malformed")
        case .planLimited(let message): message
        case .server(_, let message): message
        }
    }
}

/// The scheduled-tasks REST surface (`/api/tasks`), which is bearer-capable and
/// therefore usable from the phone unchanged.
public struct NativeScheduledTaskClient: Sendable {
    private let sender: any NativeAuthenticatedRequestSending

    public init(sender: any NativeAuthenticatedRequestSending) {
        self.sender = sender
    }

    public func list(
        for accountID: AccountID
    ) async throws -> (tasks: [NativeScheduledTask], limit: Int) {
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/tasks", headers: try HTTPHeaders(["accept": "application/json"])
            ),
            for: accountID
        )
        try requireSuccess(response)
        guard let wire = try? JSONDecoder().decode(ListWire.self, from: response.body)
        else { throw NativeScheduledTaskError.malformedResponse }
        return (wire.tasks.compactMap(Self.decode), wire.limit ?? 0)
    }

    public func create(
        _ draft: NativeScheduledTaskDraft, for accountID: AccountID
    ) async throws -> NativeScheduledTask {
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/tasks",
                method: .post,
                headers: try HTTPHeaders([
                    "accept": "application/json", "content-type": "application/json",
                ]),
                body: try JSONEncoder().encode(TaskBodyWire(draft: draft, enabled: nil))
            ),
            for: accountID
        )
        try requireSuccess(response)
        guard let wire = try? JSONDecoder().decode(SingleWire.self, from: response.body),
            let task = Self.decode(wire.task)
        else { throw NativeScheduledTaskError.malformedResponse }
        return task
    }

    /// Amends a task. `draft` is nil for an enable/disable flip, which is the one
    /// change the list itself makes.
    public func update(
        id: String,
        draft: NativeScheduledTaskDraft?,
        enabled: Bool?,
        for accountID: AccountID
    ) async throws -> NativeScheduledTask {
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/tasks/\(id)",
                method: .patch,
                headers: try HTTPHeaders([
                    "accept": "application/json", "content-type": "application/json",
                ]),
                body: try JSONEncoder().encode(TaskBodyWire(draft: draft, enabled: enabled))
            ),
            for: accountID
        )
        try requireSuccess(response)
        guard let wire = try? JSONDecoder().decode(SingleWire.self, from: response.body),
            let task = Self.decode(wire.task)
        else { throw NativeScheduledTaskError.malformedResponse }
        return task
    }

    public func delete(id: String, for accountID: AccountID) async throws {
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/tasks/\(id)",
                method: .delete,
                headers: try HTTPHeaders(["accept": "application/json"])
            ),
            for: accountID
        )
        try requireSuccess(response)
    }

    private func requireSuccess(_ response: HTTPResponse) throws {
        guard !(200...299).contains(response.statusCode) else { return }
        let wire = try? JSONDecoder().decode(ErrorWire.self, from: response.body)
        let message = wire?.message ?? wire?.error
            ?? String(format: String(localized: "tasks.error.status"), response.statusCode)
        // 403 from this route is always a plan ceiling, and it is the one failure
        // whose remedy is a purchase rather than a retry.
        if response.statusCode == 403 { throw NativeScheduledTaskError.planLimited(message) }
        throw NativeScheduledTaskError.server(statusCode: response.statusCode, message: message)
    }

    private static func decode(_ wire: TaskWire) -> NativeScheduledTask? {
        guard let cadence = NativeTaskCadence(rawValue: wire.cadence),
            let nextRunAt = NativeISO8601.date(from: wire.nextRunAt)
        else { return nil }
        return NativeScheduledTask(
            id: wire.id,
            name: wire.name,
            prompt: wire.prompt,
            model: wire.model,
            modelName: wire.modelName ?? wire.model,
            cadence: cadence,
            hour: wire.hour,
            minute: wire.minute,
            weekday: wire.weekday,
            monthday: wire.monthday,
            timezone: wire.timezone,
            webSearch: wire.webSearch,
            enabled: wire.enabled,
            lastRunAt: wire.lastRunAt.flatMap(NativeISO8601.date(from:)),
            nextRunAt: nextRunAt,
            conversationID: wire.conversationId,
            latestRun: wire.latestRun.flatMap { run in
                guard let startedAt = NativeISO8601.date(from: run.startedAt) else { return nil }
                return NativeTaskRun(
                    id: run.id,
                    status: run.status,
                    errorDescription: run.error,
                    costMicroUSD: run.costMicroUsd ?? 0,
                    startedAt: startedAt,
                    finishedAt: run.finishedAt.flatMap(NativeISO8601.date(from:))
                )
            }
        )
    }
}

/// The one ISO-8601 parser these REST surfaces share. The server emits
/// fractional seconds on some fields and not others, so both formats have to be
/// accepted or half the dates silently become nil.
public enum NativeISO8601 {
    public static func date(from value: String) -> Date? {
        let precise = ISO8601DateFormatter()
        precise.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = precise.date(from: value) { return date }
        let ordinary = ISO8601DateFormatter()
        ordinary.formatOptions = [.withInternetDateTime]
        return ordinary.date(from: value)
    }
}

// MARK: - Model

/// Drives the Tasks screen.
@MainActor
@Observable
public final class NativeScheduledTaskModel {
    public enum Phase: Equatable, Sendable {
        case idle
        case loading
        case ready
        case failed
    }

    public private(set) var phase: Phase = .idle
    public private(set) var tasks: [NativeScheduledTask] = []
    /// How many tasks the account's plan allows. Zero means the feature is not
    /// in the plan at all, which the screen states rather than hiding.
    public private(set) var limit = 0
    public private(set) var isMutating = false
    public private(set) var lastErrorDescription: String?

    public var isAtLimit: Bool { limit > 0 && tasks.count >= limit }
    public var isPlanLocked: Bool { phase == .ready && limit == 0 && tasks.isEmpty }

    private let client: NativeScheduledTaskClient
    private var accountID: AccountID?

    public init(client: NativeScheduledTaskClient) {
        self.client = client
    }

    public func start(for accountID: AccountID) async {
        guard self.accountID != accountID else {
            await refresh()
            return
        }
        stop()
        self.accountID = accountID
        phase = .loading
        await refresh()
    }

    public func stop() {
        accountID = nil
        tasks = []
        limit = 0
        lastErrorDescription = nil
        phase = .idle
    }

    public func refresh() async {
        guard let accountID else { return }
        do {
            let result = try await client.list(for: accountID)
            guard self.accountID == accountID else { return }
            tasks = result.tasks
            limit = result.limit
            lastErrorDescription = nil
            phase = .ready
        } catch {
            guard self.accountID == accountID else { return }
            lastErrorDescription = NativeFailureMessage.presentable(error)
            phase = tasks.isEmpty ? .failed : .ready
        }
    }

    @discardableResult
    public func create(_ draft: NativeScheduledTaskDraft) async -> Bool {
        guard let accountID else { return false }
        isMutating = true
        defer { isMutating = false }
        do {
            let task = try await client.create(draft, for: accountID)
            guard self.accountID == accountID else { return false }
            tasks.insert(task, at: 0)
            lastErrorDescription = nil
            return true
        } catch {
            guard self.accountID == accountID else { return false }
            lastErrorDescription = NativeFailureMessage.presentable(error)
            return false
        }
    }

    @discardableResult
    public func update(id: String, draft: NativeScheduledTaskDraft) async -> Bool {
        await apply(id: id, draft: draft, enabled: nil)
    }

    /// Flips a task on or off. Applied locally first — the switch has to move
    /// under the thumb — and rolled back if the server refuses.
    public func setEnabled(id: String, enabled: Bool) async {
        guard let index = tasks.firstIndex(where: { $0.id == id }) else { return }
        let previous = tasks[index].enabled
        tasks[index].enabled = enabled
        if await apply(id: id, draft: nil, enabled: enabled) { return }
        guard let index = tasks.firstIndex(where: { $0.id == id }) else { return }
        tasks[index].enabled = previous
    }

    public func delete(id: String) async {
        guard let accountID else { return }
        isMutating = true
        defer { isMutating = false }
        do {
            try await client.delete(id: id, for: accountID)
            guard self.accountID == accountID else { return }
            tasks.removeAll { $0.id == id }
            lastErrorDescription = nil
        } catch {
            guard self.accountID == accountID else { return }
            lastErrorDescription = NativeFailureMessage.presentable(error)
        }
    }

    @discardableResult
    private func apply(
        id: String, draft: NativeScheduledTaskDraft?, enabled: Bool?
    ) async -> Bool {
        guard let accountID else { return false }
        isMutating = true
        defer { isMutating = false }
        do {
            let updated = try await client.update(
                id: id, draft: draft, enabled: enabled, for: accountID
            )
            guard self.accountID == accountID else { return false }
            if let index = tasks.firstIndex(where: { $0.id == id }) {
                tasks[index] = updated
            }
            lastErrorDescription = nil
            return true
        } catch {
            guard self.accountID == accountID else { return false }
            lastErrorDescription = NativeFailureMessage.presentable(error)
            return false
        }
    }
}

// MARK: - Wire

private struct ListWire: Decodable {
    let tasks: [TaskWire]
    let limit: Int?
}

private struct SingleWire: Decodable {
    let task: TaskWire
}

private struct TaskWire: Decodable {
    struct Run: Decodable {
        let id: String
        let status: String
        let error: String?
        let costMicroUsd: Int?
        let startedAt: String
        let finishedAt: String?
    }

    let id: String
    let name: String
    let prompt: String
    let model: String
    let modelName: String?
    let cadence: String
    let hour: Int
    let minute: Int
    let weekday: Int?
    let monthday: Int?
    let timezone: String
    let webSearch: Bool
    let enabled: Bool
    let lastRunAt: String?
    let nextRunAt: String
    let conversationId: String?
    let latestRun: Run?
}

/// The create/patch body. Every field is optional so one type serves both: PATCH
/// must be able to send `{"enabled": false}` alone, and an encoder that always
/// wrote the schedule would silently reset a task on every toggle.
private struct TaskBodyWire: Encodable {
    let name: String?
    let prompt: String?
    let model: String?
    let cadence: String?
    let hour: Int?
    let minute: Int?
    let weekday: Int?
    let monthday: Int?
    let timezone: String?
    let webSearch: Bool?
    let enabled: Bool?

    init(draft: NativeScheduledTaskDraft?, enabled: Bool?) {
        name = draft?.name.trimmingCharacters(in: .whitespacesAndNewlines)
        prompt = draft?.prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        model = draft?.model
        cadence = draft?.cadence.rawValue
        hour = draft?.hour
        minute = draft?.minute
        // Sent only for the cadence that uses it: the server validates the
        // *merged* schedule, so posting a stale weekday alongside a switch to
        // MONTHLY is how a task ends up on a day nobody chose.
        weekday = draft?.cadence == .weekly ? draft?.weekday : nil
        monthday = draft?.cadence == .monthly ? draft?.monthday : nil
        timezone = draft?.timezone
        webSearch = draft?.webSearch
        self.enabled = enabled
    }
}

private struct ErrorWire: Decodable {
    let error: String?
    let message: String?
}

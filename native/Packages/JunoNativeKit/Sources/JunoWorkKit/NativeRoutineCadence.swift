import Foundation
import JunoCore

/// The one clock a simple routine editor offers — hourly, daily, weekdays,
/// weekly or monthly at a time — read from and written back to the trigger
/// set an automation stores (`work-triggers.tsx`'s clock kinds, with the
/// same config keys).
///
/// An automation whose triggers are anything else — several triggers, an
/// event, a one-off date, a cron line — has no cadence (`init(triggers:)` is
/// nil), and an editor that only knows cadences leaves its triggers alone.
public struct NativeRoutineCadence: Equatable, Sendable {
    public enum Kind: String, CaseIterable, Identifiable, Sendable {
        case hourly
        case daily
        case weekdays
        case weekly
        case monthly

        public var id: String { rawValue }

        public var label: String { NativeWorkScheduleCopy.triggerLabel(rawValue) }
    }

    public var kind: Kind
    /// 0–23; ignored hourly.
    public var hour: Int
    /// 0–59.
    public var minute: Int
    /// 0 = Sunday … 6 = Saturday; weekly only.
    public var weekday: Int
    /// 1–31; monthly only. The 31st means the last day of a short month.
    public var monthday: Int

    public init(kind: Kind = .daily, hour: Int = 9, minute: Int = 0, weekday: Int = 1, monthday: Int = 1) {
        self.kind = kind
        self.hour = min(23, max(0, hour))
        self.minute = min(59, max(0, minute))
        self.weekday = min(6, max(0, weekday))
        self.monthday = min(31, max(1, monthday))
    }

    /// The cadence a stored trigger set expresses, or nil when it is not
    /// exactly one enabled clock trigger of the five kinds.
    public init?(triggers: [NativeWorkScheduleTriggerDraft]) {
        guard triggers.count == 1, let trigger = triggers.first, trigger.enabled,
            let kind = Kind(rawValue: trigger.kind)
        else { return nil }
        func int(_ key: String, _ fallback: Int) -> Int {
            guard let value = trigger.config[key]?.numberValue, value.isFinite else { return fallback }
            return Int(value)
        }
        self.init(
            kind: kind,
            hour: int("hour", 9),
            minute: int("minute", 0),
            weekday: int("weekday", 1),
            monthday: int("monthday", 1)
        )
    }

    /// The trigger the server stores for this cadence. `id` keeps an edited
    /// trigger's identity, so its last-fired time survives the edit.
    public func trigger(id: String = UUID().uuidString) -> NativeWorkScheduleTriggerDraft {
        var config: [String: JunoJSONValue] = ["minute": .number(Double(minute))]
        switch kind {
        case .hourly:
            break
        case .daily, .weekdays:
            config["hour"] = .number(Double(hour))
        case .weekly:
            config["hour"] = .number(Double(hour))
            config["weekday"] = .number(Double(weekday))
        case .monthly:
            config["hour"] = .number(Double(hour))
            config["monthday"] = .number(Double(monthday))
        }
        return NativeWorkScheduleTriggerDraft(id: id, kind: kind.rawValue, config: config)
    }

    /// The schedule in words, as the automation pages say it.
    public var sentence: String {
        let draft = trigger(id: "cadence")
        return NativeWorkScheduleCopy.describe(draft)
    }
}

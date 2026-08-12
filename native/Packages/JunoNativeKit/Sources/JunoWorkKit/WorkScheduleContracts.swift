import Foundation
import JunoCore

/// The budget attached to a background Work schedule.
///
/// Zero means "use the account/runtime default", which is also how the relay
/// stores an omitted budget. Keeping the wire names in one value prevents the
/// native editor from accidentally sending a token budget while displaying a
/// cost budget (or vice versa).
public struct NativeWorkScheduleBudget: Equatable, Sendable {
    public var maxCostMicroUSD: Int
    public var maxTokens: Int
    public var maxRuntimeMilliseconds: Int

    public init(
        maxCostMicroUSD: Int = 0,
        maxTokens: Int = 0,
        maxRuntimeMilliseconds: Int = 0
    ) {
        self.maxCostMicroUSD = max(0, maxCostMicroUSD)
        self.maxTokens = max(0, maxTokens)
        self.maxRuntimeMilliseconds = max(0, maxRuntimeMilliseconds)
    }
}

/// A trigger as returned by `/api/work/schedules`.
///
/// `kind` is intentionally a String. A newer server may add a trigger before
/// this Mac ships an updated vocabulary; rendering that trigger as an
/// "advanced trigger" is safer than dropping it or pretending the schedule
/// has fewer ways to run than it really does.
public struct NativeWorkScheduleTrigger: Equatable, Sendable, Identifiable {
    public let id: String
    public let kind: String
    public let config: [String: JunoJSONValue]
    public let configVersion: Int
    public let enabled: Bool
    public let lastFiredAt: Date?
    public let dedupeWindowSeconds: Int

    public init(
        id: String,
        kind: String,
        config: [String: JunoJSONValue],
        configVersion: Int,
        enabled: Bool,
        lastFiredAt: Date?,
        dedupeWindowSeconds: Int
    ) {
        self.id = id
        self.kind = kind
        self.config = config
        self.configVersion = configVersion
        self.enabled = enabled
        self.lastFiredAt = lastFiredAt
        self.dedupeWindowSeconds = max(0, dedupeWindowSeconds)
    }
}

/// A trigger the native editor can submit as a full replacement set.
public struct NativeWorkScheduleTriggerDraft: Equatable, Sendable, Identifiable {
    public var id: String
    public var kind: String
    public var config: [String: JunoJSONValue]
    public var enabled: Bool
    public var dedupeWindowSeconds: Int?

    public init(
        id: String = UUID().uuidString,
        kind: String,
        config: [String: JunoJSONValue] = [:],
        enabled: Bool = true,
        dedupeWindowSeconds: Int? = nil
    ) {
        self.id = id
        self.kind = kind
        self.config = config
        self.enabled = enabled
        self.dedupeWindowSeconds = dedupeWindowSeconds
    }

    public init(trigger: NativeWorkScheduleTrigger) {
        self.init(
            id: trigger.id,
            kind: trigger.kind,
            config: trigger.config,
            enabled: trigger.enabled,
            dedupeWindowSeconds: trigger.dedupeWindowSeconds
        )
    }
}

/// One schedule as the relay presents it to an authenticated client.
public struct NativeWorkSchedule: Equatable, Sendable, Identifiable {
    public let id: String
    public let sessionID: String
    public let name: String
    public let enabled: Bool
    public let instructions: String
    public let instructionsVersion: Int
    /// Kept raw for forward compatibility with a server vocabulary addition.
    public let target: String
    public let hostID: String?
    public let timezone: String
    /// The native client preserves the whole object, including fields this
    /// build does not act on yet.
    public let runConfig: [String: JunoJSONValue]
    public let runConfigVersion: Int
    public let budget: NativeWorkScheduleBudget
    public let unattendedPolicy: String
    public let hostOfflinePolicy: String
    public let maxConcurrentRuns: Int
    public let notifyPolicy: String
    public let missedRunPolicy: String
    public let retryPolicy: JunoJSONValue
    public let lastRunAt: Date?
    public let nextRunAt: Date?
    public let legacyScheduledTaskID: String?
    public let createdAt: Date
    public let updatedAt: Date
    public let triggers: [NativeWorkScheduleTrigger]

    public var targetValue: JunoWorkTarget? { JunoWorkTarget(rawValue: target) }

    public var model: String? { runConfig["model"]?.stringValue }

    public var requiredCapabilities: [String] {
        guard case .array(let values)? = runConfig["requiredCapabilities"] else { return [] }
        return values.compactMap(\.stringValue)
    }

    public var hasUnknownTrigger: Bool {
        triggers.contains { !Self.knownTriggerKinds.contains($0.kind) }
    }

    public static let knownTriggerKinds: Set<String> = [
        "once", "hourly", "daily", "weekdays", "weekly", "monthly", "yearly", "cron",
        "email_filter", "calendar_window", "topic_monitor", "connector_event", "folder_change",
        "manual",
    ]

    public init(
        id: String,
        sessionID: String,
        name: String,
        enabled: Bool,
        instructions: String,
        instructionsVersion: Int,
        target: String,
        hostID: String?,
        timezone: String,
        runConfig: [String: JunoJSONValue],
        runConfigVersion: Int,
        budget: NativeWorkScheduleBudget,
        unattendedPolicy: String,
        hostOfflinePolicy: String,
        maxConcurrentRuns: Int,
        notifyPolicy: String,
        missedRunPolicy: String,
        retryPolicy: JunoJSONValue,
        lastRunAt: Date?,
        nextRunAt: Date?,
        legacyScheduledTaskID: String?,
        createdAt: Date,
        updatedAt: Date,
        triggers: [NativeWorkScheduleTrigger]
    ) {
        self.id = id
        self.sessionID = sessionID
        self.name = name
        self.enabled = enabled
        self.instructions = instructions
        self.instructionsVersion = instructionsVersion
        self.target = target
        self.hostID = hostID
        self.timezone = timezone
        self.runConfig = runConfig
        self.runConfigVersion = runConfigVersion
        self.budget = budget
        self.unattendedPolicy = unattendedPolicy
        self.hostOfflinePolicy = hostOfflinePolicy
        self.maxConcurrentRuns = max(1, maxConcurrentRuns)
        self.notifyPolicy = notifyPolicy
        self.missedRunPolicy = missedRunPolicy
        self.retryPolicy = retryPolicy
        self.lastRunAt = lastRunAt
        self.nextRunAt = nextRunAt
        self.legacyScheduledTaskID = legacyScheduledTaskID
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.triggers = triggers
    }

    public var draft: NativeWorkScheduleDraft {
        NativeWorkScheduleDraft(
            name: name,
            instructions: instructions,
            timezone: timezone,
            target: targetValue ?? .automatic,
            hostID: hostID,
            enabled: enabled,
            triggers: triggers.map(NativeWorkScheduleTriggerDraft.init(trigger:)),
            budget: budget,
            unattendedPolicy: unattendedPolicy,
            hostOfflinePolicy: hostOfflinePolicy,
            missedRunPolicy: missedRunPolicy,
            notifyPolicy: notifyPolicy,
            maxConcurrentRuns: maxConcurrentRuns,
            model: model,
            requiredCapabilities: requiredCapabilities
        )
    }
}

/// The full schedule body used by create and full-edit PATCH.
public struct NativeWorkScheduleDraft: Equatable, Sendable {
    public var name: String
    public var instructions: String
    public var timezone: String
    public var target: JunoWorkTarget
    public var hostID: String?
    public var enabled: Bool
    public var triggers: [NativeWorkScheduleTriggerDraft]
    public var budget: NativeWorkScheduleBudget
    public var unattendedPolicy: String
    public var hostOfflinePolicy: String
    public var missedRunPolicy: String
    public var notifyPolicy: String
    public var maxConcurrentRuns: Int
    public var model: String?
    public var requiredCapabilities: [String]

    public init(
        name: String = "",
        instructions: String = "",
        timezone: String = TimeZone.current.identifier,
        target: JunoWorkTarget = .automatic,
        hostID: String? = nil,
        enabled: Bool = true,
        triggers: [NativeWorkScheduleTriggerDraft] = [
            NativeWorkScheduleTriggerDraft(kind: "daily", config: ["hour": .number(9), "minute": .number(0)])
        ],
        budget: NativeWorkScheduleBudget = NativeWorkScheduleBudget(),
        unattendedPolicy: String = "pause_for_approval",
        hostOfflinePolicy: String = "skip",
        missedRunPolicy: String = "run_once",
        notifyPolicy: String = "on_attention",
        maxConcurrentRuns: Int = 1,
        model: String? = nil,
        requiredCapabilities: [String] = []
    ) {
        self.name = name
        self.instructions = instructions
        self.timezone = timezone
        self.target = target
        self.hostID = hostID
        self.enabled = enabled
        self.triggers = triggers
        self.budget = budget
        self.unattendedPolicy = unattendedPolicy
        self.hostOfflinePolicy = hostOfflinePolicy
        self.missedRunPolicy = missedRunPolicy
        self.notifyPolicy = notifyPolicy
        self.maxConcurrentRuns = min(5, max(1, maxConcurrentRuns))
        self.model = model
        self.requiredCapabilities = requiredCapabilities
    }

    public var isValid: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !instructions.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !timezone.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !triggers.isEmpty
            && (target != .local || hostID != nil)
    }
}

/// The compact run returned by a schedule's run-now and history routes.
public struct NativeWorkScheduleRun: Equatable, Sendable, Identifiable {
    public let id: String
    public let sessionID: String
    public let scheduleID: String?
    public let origin: String
    public let status: String
    public let requestedTarget: String
    public let effectiveTarget: String?
    public let hostID: String?
    public let createdAt: Date?
    public let startedAt: Date?
    public let finishedAt: Date?

    public init(
        id: String,
        sessionID: String,
        scheduleID: String?,
        origin: String,
        status: String,
        requestedTarget: String,
        effectiveTarget: String?,
        hostID: String?,
        createdAt: Date?,
        startedAt: Date?,
        finishedAt: Date?
    ) {
        self.id = id
        self.sessionID = sessionID
        self.scheduleID = scheduleID
        self.origin = origin
        self.status = status
        self.requestedTarget = requestedTarget
        self.effectiveTarget = effectiveTarget
        self.hostID = hostID
        self.createdAt = createdAt
        self.startedAt = startedAt
        self.finishedAt = finishedAt
    }
}

public struct NativeWorkScheduleSelection: Equatable, Sendable {
    public let target: String
    public let hostID: String?
    public let explanation: String?
    public let missing: [String]
    public let degradation: [String]

    public init(
        target: String,
        hostID: String?,
        explanation: String?,
        missing: [String],
        degradation: [String]
    ) {
        self.target = target
        self.hostID = hostID
        self.explanation = explanation
        self.missing = missing
        self.degradation = degradation
    }
}

public struct NativeWorkScheduleRunResult: Equatable, Sendable {
    public let run: NativeWorkScheduleRun
    public let selection: NativeWorkScheduleSelection
    public let nextRunAt: Date?
    public let replay: Bool

    public init(
        run: NativeWorkScheduleRun,
        selection: NativeWorkScheduleSelection,
        nextRunAt: Date?,
        replay: Bool
    ) {
        self.run = run
        self.selection = selection
        self.nextRunAt = nextRunAt
        self.replay = replay
    }
}

/// Human-facing schedule vocabulary. Unknown values are intentionally turned
/// into readable sentence case rather than being shown as API tokens.
public enum NativeWorkScheduleVocabulary {
    public static func trigger(_ kind: String) -> String {
        switch kind {
        case "once": return "Once"
        case "hourly": return "Every hour"
        case "daily": return "Every day"
        case "weekdays": return "Weekdays"
        case "weekly": return "Every week"
        case "monthly": return "Every month"
        case "yearly": return "Every year"
        case "cron": return "Custom clock"
        case "email_filter": return "Matching email"
        case "calendar_window": return "Calendar window"
        case "topic_monitor": return "Topic changes"
        case "connector_event": return "Connected app event"
        case "folder_change": return "Folder changes"
        case "manual": return "Manual"
        default: return sentenceCase(kind)
        }
    }

    public static func sentenceCase(_ token: String) -> String {
        let words = token
            .replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
            .split(separator: " ")
            .map(String.init)
        guard let first = words.first else { return token }
        return ([first.capitalized] + words.dropFirst()).joined(separator: " ")
    }
}

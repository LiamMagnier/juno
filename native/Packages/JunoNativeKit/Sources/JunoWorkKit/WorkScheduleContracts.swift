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
    /// `work` or `code` (`ClientWorkSchedule.runKind`). Kept raw, like
    /// `target`: a newer server may add a kind, and an unknown one must not
    /// read as a task automation this Mac could edit.
    public let runKind: String
    /// Whether a fire token has been issued for the "Something calls it"
    /// trigger. Only its hash is stored, so the token itself is never read back.
    public let hasFireToken: Bool
    public let fireTokenIssuedAt: Date?
    /// `owner/name` of a Code automation's repository, when its `codeConfig`
    /// names one.
    public let codeRepository: String?

    public var targetValue: JunoWorkTarget? { JunoWorkTarget(rawValue: target) }

    /// A Code automation: listed and runnable on the Mac, edited on the web
    /// (Phase 4 register #67).
    public var isCode: Bool { runKind == "code" }

    /// Whether the Mac's editor can change this automation: a task
    /// automation. A trigger of a kind this build does not know is kept as it
    /// is and saved back untouched, as the web's editor does.
    public var isEditableHere: Bool { runKind == "work" }

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
        "manual", "api",
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
        triggers: [NativeWorkScheduleTrigger],
        runKind: String = "work",
        hasFireToken: Bool = false,
        fireTokenIssuedAt: Date? = nil,
        codeRepository: String? = nil
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
        self.runKind = runKind
        self.hasFireToken = hasFireToken
        self.fireTokenIssuedAt = fireTokenIssuedAt
        self.codeRepository = codeRepository
    }

    /// The same schedule with its switch moved, everything else as it was.
    public func withEnabled(_ enabled: Bool) -> NativeWorkSchedule {
        NativeWorkSchedule(
            id: id, sessionID: sessionID, name: name, enabled: enabled,
            instructions: instructions, instructionsVersion: instructionsVersion,
            target: target, hostID: hostID, timezone: timezone,
            runConfig: runConfig, runConfigVersion: runConfigVersion, budget: budget,
            unattendedPolicy: unattendedPolicy, hostOfflinePolicy: hostOfflinePolicy,
            maxConcurrentRuns: maxConcurrentRuns, notifyPolicy: notifyPolicy,
            missedRunPolicy: missedRunPolicy, retryPolicy: retryPolicy,
            lastRunAt: lastRunAt, nextRunAt: nextRunAt,
            legacyScheduledTaskID: legacyScheduledTaskID,
            createdAt: createdAt, updatedAt: updatedAt, triggers: triggers,
            runKind: runKind, hasFireToken: hasFireToken,
            fireTokenIssuedAt: fireTokenIssuedAt, codeRepository: codeRepository
        )
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
    /// Which attempt of its session this run is, from 1.
    public let attempt: Int
    /// The scheduler's own sentence for a fire it did not run ("The Mac was
    /// away, so this fire was skipped."), when it wrote one.
    public let terminalDetail: String?

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
        finishedAt: Date?,
        attempt: Int = 1,
        terminalDetail: String? = nil
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
        self.attempt = max(1, attempt)
        self.terminalDetail = terminalDetail
    }
}

/// One Code run of a Code automation, as `serializeTask` sends it: each fire
/// is a session of its own with its own branch and pull request.
public struct NativeWorkScheduleCodeRun: Equatable, Sendable, Identifiable {
    public let id: String
    public let title: String
    /// The Code task's own status (`queued | running | awaiting_approval |
    /// done | cancelled | …`), mapped to a Work status by
    /// ``NativeWorkScheduleCopy/workStatus(forCodeTask:)``.
    public let status: String
    public let conversationID: String?
    public let pullRequestURL: String?
    public let branch: String?
    public let createdAt: Date?

    public init(
        id: String,
        title: String,
        status: String,
        conversationID: String?,
        pullRequestURL: String?,
        branch: String?,
        createdAt: Date?
    ) {
        self.id = id
        self.title = title
        self.status = status
        self.conversationID = conversationID
        self.pullRequestURL = pullRequestURL
        self.branch = branch
        self.createdAt = createdAt
    }
}

/// An automation's history as the runs route returns it: the Work runs and,
/// for a Code automation, the Code runs. Two shapes, kept apart until the page
/// interleaves them by time, as the web does.
public struct NativeWorkScheduleHistory: Equatable, Sendable {
    public let runs: [NativeWorkScheduleRun]
    public let codeRuns: [NativeWorkScheduleCodeRun]

    public init(runs: [NativeWorkScheduleRun], codeRuns: [NativeWorkScheduleCodeRun] = []) {
        self.runs = runs
        self.codeRuns = codeRuns
    }
}

/// The result of a change the server may say something about: the saved row,
/// and the server's own sentences about what happened to queued fires and to
/// the next fire (`scheduling`, `runs.explanation`), in that order.
public struct NativeWorkScheduleChange: Equatable, Sendable {
    public let schedule: NativeWorkSchedule
    public let notes: [String]

    public init(schedule: NativeWorkSchedule, notes: [String] = []) {
        self.schedule = schedule
        self.notes = notes
    }
}

/// The token something outside Juno fires an automation with. Returned once,
/// by the call that mints it: only its hash is stored.
public struct NativeWorkFireToken: Equatable, Sendable {
    public let token: String
    public let issuedAt: Date?
    public let url: String

    public init(token: String, issuedAt: Date?, url: String) {
        self.token = token
        self.issuedAt = issuedAt
        self.url = url
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

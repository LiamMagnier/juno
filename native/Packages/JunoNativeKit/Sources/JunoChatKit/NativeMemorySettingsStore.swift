import Foundation
import JunoAPI
import JunoAuth
import JunoCore
import JunoStorage
import JunoSync
import Observation

public enum NativeMemorySource: String, Codable, CaseIterable, Sendable {
    case automatic = "AUTO"
    case manual = "MANUAL"
}

public enum NativeMemoryKind: String, Codable, CaseIterable, Sendable {
    case fact = "FACT"
    case suppression = "SUPPRESSION"
}

public enum NativeThemePreference: String, Codable, CaseIterable, Sendable {
    case light = "LIGHT"
    case dark = "DARK"
    case system = "SYSTEM"
}

public struct NativeMemoryEntry: Identifiable, Equatable, Sendable {
    public let id: String
    public var content: String
    public let source: NativeMemorySource
    public let kind: NativeMemoryKind
    public let sourceReference: String?
    public let createdAt: Date
    public var updatedAt: Date
    public let revision: UInt64
    public var isPending: Bool

    public init(
        id: String,
        content: String,
        source: NativeMemorySource,
        kind: NativeMemoryKind,
        sourceReference: String?,
        createdAt: Date,
        updatedAt: Date,
        revision: UInt64,
        isPending: Bool = false
    ) {
        self.id = id
        self.content = content
        self.source = source
        self.kind = kind
        self.sourceReference = sourceReference
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.revision = revision
        self.isPending = isPending
    }
}

public struct NativeMemorySummary: Equatable, Sendable {
    public let content: String
    public let updatedAt: Date
    public let entryCount: Int

    public init(content: String, updatedAt: Date, entryCount: Int) {
        self.content = content
        self.updatedAt = updatedAt
        self.entryCount = entryCount
    }
}

public struct NativeAccountSettings: Equatable, Sendable {
    public let id: String
    public var theme: NativeThemePreference
    public var accent: String
    public var defaultModel: String
    public var customInstructions: String
    public var responseLanguage: String
    public var interfaceLocale: String
    public var personality: String
    public var memoryEnabled: Bool
    public var voiceID: String?
    public var favoriteModels: [String]
    public var emailBudgetAlerts: Bool
    public var emailWeeklyDigest: Bool
    /// Where background work derived from this account may be sent.
    public var backgroundProviderMode: BackgroundProviderMode
    /// The provider chosen under `.selectedProvider`; ignored by other modes.
    public var backgroundProviderSelected: String?
    // Phase 3 (Settings to web parity): the fields the v1 sync record does not
    // carry. Each is nil until something has said it — the sync record if a
    // later server adds it, or `GET /api/settings`, which the model overlays —
    // and a reader must treat nil as "not known yet", never as a default.
    /// What Juno calls you (`User.name`, written through `PATCH /api/settings`).
    public var name: String?
    /// Whether memory may read older chats on its own between sessions.
    public var memoryBackgroundLearning: Bool?
    /// The sensitive topics this account opts *into* remembering.
    public var memorySensitiveTopics: [String]?
    /// How much Juno asks before acting in a connected app.
    public var actionApprovalPolicy: String?
    /// Refuse every connector action, whatever the policy.
    public var lockdownMode: Bool?
    /// Connected apps turned off in Settings › Connectors.
    public var blockedConnectors: [String]?
    /// The account's own monthly ceiling in whole euros; nil is "the default".
    public var monthlySpendCapEur: Int?
    /// The one bypass of the ceiling. Read-only: no client can write it.
    public var spendCapDisabled: Bool?
    /// What Auto optimises for (`AUTO_PREFERENCES`); nil is "not known yet".
    /// See ``NativeAutoPreference``.
    public var autoPreference: String?
    /// Which labs Auto may choose (`AUTO_DATA_BOUNDARIES`); nil is "not known
    /// yet". See ``NativeAutoDataBoundary``.
    public var autoDataBoundary: String?
    public var updatedAt: Date
    public let revision: UInt64
    public var isPending: Bool

    public init(
        id: String,
        theme: NativeThemePreference,
        accent: String,
        defaultModel: String,
        customInstructions: String,
        responseLanguage: String,
        interfaceLocale: String,
        personality: String,
        memoryEnabled: Bool,
        voiceID: String?,
        favoriteModels: [String],
        emailBudgetAlerts: Bool,
        emailWeeklyDigest: Bool,
        backgroundProviderMode: BackgroundProviderMode = .default,
        backgroundProviderSelected: String? = nil,
        name: String? = nil,
        memoryBackgroundLearning: Bool? = nil,
        memorySensitiveTopics: [String]? = nil,
        actionApprovalPolicy: String? = nil,
        lockdownMode: Bool? = nil,
        blockedConnectors: [String]? = nil,
        monthlySpendCapEur: Int? = nil,
        spendCapDisabled: Bool? = nil,
        autoPreference: String? = nil,
        autoDataBoundary: String? = nil,
        updatedAt: Date,
        revision: UInt64,
        isPending: Bool = false
    ) {
        self.id = id
        self.theme = theme
        self.accent = accent
        self.defaultModel = defaultModel
        self.customInstructions = customInstructions
        self.responseLanguage = responseLanguage
        self.interfaceLocale = interfaceLocale
        self.personality = personality
        self.memoryEnabled = memoryEnabled
        self.voiceID = voiceID
        self.favoriteModels = favoriteModels
        self.emailBudgetAlerts = emailBudgetAlerts
        self.emailWeeklyDigest = emailWeeklyDigest
        self.backgroundProviderMode = backgroundProviderMode
        self.backgroundProviderSelected = backgroundProviderSelected
        self.name = name
        self.memoryBackgroundLearning = memoryBackgroundLearning
        self.memorySensitiveTopics = memorySensitiveTopics
        self.actionApprovalPolicy = actionApprovalPolicy
        self.lockdownMode = lockdownMode
        self.blockedConnectors = blockedConnectors
        self.monthlySpendCapEur = monthlySpendCapEur
        self.spendCapDisabled = spendCapDisabled
        self.autoPreference = autoPreference
        self.autoDataBoundary = autoDataBoundary
        self.updatedAt = updatedAt
        self.revision = revision
        self.isPending = isPending
    }
}

public struct NativeSettingsPatch: Equatable, Sendable {
    public var theme: NativeThemePreference?
    public var accent: String?
    public var defaultModel: String?
    public var customInstructions: String?
    public var responseLanguage: String?
    public var interfaceLocale: String?
    public var personality: String?
    public var memoryEnabled: Bool?
    public var favoriteModels: [String]?
    public var emailBudgetAlerts: Bool?
    public var emailWeeklyDigest: Bool?
    /// Where background work may be sent. See `BackgroundProviderMode`.
    public var backgroundProviderMode: BackgroundProviderMode?
    /// The read-aloud and voice-mode voice. `.some(nil)` clears it back to
    /// the server default; `.none` leaves it alone.
    public var voiceID: String??
    // Phase 3: written through `PATCH /api/settings`, not the sync outbox,
    // whose `settings.update` schema is strict and does not accept them.
    public var name: String?
    public var memoryBackgroundLearning: Bool?
    public var memorySensitiveTopics: [String]?
    public var actionApprovalPolicy: String?
    public var lockdownMode: Bool?
    public var blockedConnectors: [String]?
    /// The monthly ceiling. `.some(nil)` sends `null`, "back to the default";
    /// `.none` leaves it alone.
    public var monthlySpendCapEur: Int??
    /// What Auto optimises for; one of ``NativeAutoPreference/values``.
    public var autoPreference: String?
    /// Which labs Auto may choose; one of ``NativeAutoDataBoundary/values``.
    public var autoDataBoundary: String?

    public init(
        theme: NativeThemePreference? = nil,
        accent: String? = nil,
        defaultModel: String? = nil,
        customInstructions: String? = nil,
        responseLanguage: String? = nil,
        interfaceLocale: String? = nil,
        personality: String? = nil,
        memoryEnabled: Bool? = nil,
        favoriteModels: [String]? = nil,
        emailBudgetAlerts: Bool? = nil,
        emailWeeklyDigest: Bool? = nil,
        backgroundProviderMode: BackgroundProviderMode? = nil,
        voiceID: String?? = nil,
        name: String? = nil,
        memoryBackgroundLearning: Bool? = nil,
        memorySensitiveTopics: [String]? = nil,
        actionApprovalPolicy: String? = nil,
        lockdownMode: Bool? = nil,
        blockedConnectors: [String]? = nil,
        monthlySpendCapEur: Int?? = nil,
        autoPreference: String? = nil,
        autoDataBoundary: String? = nil
    ) {
        self.theme = theme
        self.accent = accent
        self.defaultModel = defaultModel
        self.customInstructions = customInstructions
        self.responseLanguage = responseLanguage
        self.interfaceLocale = interfaceLocale
        self.personality = personality
        self.memoryEnabled = memoryEnabled
        self.favoriteModels = favoriteModels
        self.emailBudgetAlerts = emailBudgetAlerts
        self.emailWeeklyDigest = emailWeeklyDigest
        self.backgroundProviderMode = backgroundProviderMode
        self.voiceID = voiceID
        self.name = name
        self.memoryBackgroundLearning = memoryBackgroundLearning
        self.memorySensitiveTopics = memorySensitiveTopics
        self.actionApprovalPolicy = actionApprovalPolicy
        self.lockdownMode = lockdownMode
        self.blockedConnectors = blockedConnectors
        self.monthlySpendCapEur = monthlySpendCapEur
        self.autoPreference = autoPreference
        self.autoDataBoundary = autoDataBoundary
    }

    /// `ACTION_PERMISSION_POLICIES` in `src/lib/action-approval.ts`, in order.
    public static let actionApprovalPolicies = [
        "always_ask", "ask_for_any_change", "ask_for_important_actions",
        "allow_selected_low_risk", "block",
    ]

    /// The fields the v1 sync mutation (`settings.update` in
    /// `src/lib/sync-mutations.ts`) accepts. Its schema is `.strict()`, so a
    /// patch carrying anything else is refused whole; the rest go through
    /// `PATCH /api/settings`, which accepts every field.
    public static let syncedFields: Set<String> = [
        "theme", "accent", "defaultModel", "customInstructions", "responseLanguage",
        "uiLocale", "personality", "memoryEnabled", "voiceId", "favoriteModels",
        "emailBudgetAlerts", "emailWeeklyDigest",
    ]

    /// The patch's fields by wire name, split by the route each must take.
    public var syncedFieldNames: Set<String> { Set(object.keys).intersection(Self.syncedFields) }
    public var directFieldNames: Set<String> { Set(object.keys).subtracting(Self.syncedFields) }

    fileprivate var object: [String: Any] {
        var result: [String: Any] = [:]
        if let theme { result["theme"] = theme.rawValue }
        if let accent { result["accent"] = accent }
        if let defaultModel { result["defaultModel"] = defaultModel }
        if let customInstructions { result["customInstructions"] = customInstructions }
        if let responseLanguage { result["responseLanguage"] = responseLanguage }
        if let interfaceLocale { result["uiLocale"] = interfaceLocale }
        if let personality { result["personality"] = personality }
        if let memoryEnabled { result["memoryEnabled"] = memoryEnabled }
        if let backgroundProviderMode {
            result["backgroundProviderMode"] = backgroundProviderMode.rawValue
        }
        if let favoriteModels { result["favoriteModels"] = favoriteModels }
        if let emailBudgetAlerts { result["emailBudgetAlerts"] = emailBudgetAlerts }
        if let emailWeeklyDigest { result["emailWeeklyDigest"] = emailWeeklyDigest }
        if let voiceID { result["voiceId"] = voiceID ?? NSNull() }
        if let name { result["name"] = name }
        if let memoryBackgroundLearning { result["memoryBackgroundLearning"] = memoryBackgroundLearning }
        if let memorySensitiveTopics { result["memorySensitiveTopics"] = memorySensitiveTopics }
        if let actionApprovalPolicy { result["actionApprovalPolicy"] = actionApprovalPolicy }
        if let lockdownMode { result["lockdownMode"] = lockdownMode }
        if let blockedConnectors { result["blockedConnectors"] = blockedConnectors }
        if let monthlySpendCapEur { result["monthlySpendCapEur"] = monthlySpendCapEur ?? NSNull() }
        if let autoPreference { result["autoPreference"] = autoPreference }
        if let autoDataBoundary { result["autoDataBoundary"] = autoDataBoundary }
        return result
    }

    /// The JSON body `PATCH /api/settings` takes for this patch's direct
    /// fields, or nil when it has none.
    public func directBody() throws -> Data? {
        let direct = object.filter { !Self.syncedFields.contains($0.key) }
        guard !direct.isEmpty else { return nil }
        return try JSONSerialization.data(withJSONObject: direct, options: [.sortedKeys])
    }
}

public struct NativeMemorySettingsSnapshot: Equatable, Sendable {
    public let memories: [NativeMemoryEntry]
    public let summary: NativeMemorySummary?
    public let settings: NativeAccountSettings?
    public let pendingMutationCount: Int
    public let conflictedMutationCount: Int

    public init(
        memories: [NativeMemoryEntry],
        summary: NativeMemorySummary?,
        settings: NativeAccountSettings?,
        pendingMutationCount: Int,
        conflictedMutationCount: Int
    ) {
        self.memories = memories
        self.summary = summary
        self.settings = settings
        self.pendingMutationCount = pendingMutationCount
        self.conflictedMutationCount = conflictedMutationCount
    }
}

public enum NativeMemorySettingsError: Error, Equatable, LocalizedError, Sendable {
    case corruptRecord(RecordKey)
    case invalidMutation
    case invalidMemory
    case invalidSettings
    case memoryNotFound(String)
    case settingsUnavailable
    case concurrentWriteLimitExceeded

    public var errorDescription: String? {
        switch self {
        case .corruptRecord:
            "Juno could not read the locally stored memory and settings data."
        case .invalidMutation:
            "Juno could not save this account change."
        case .invalidMemory:
            "Enter a memory between 1 and 20,000 characters."
        case .invalidSettings:
            "One or more settings values are invalid."
        case .memoryNotFound:
            "This memory is no longer available."
        case .settingsUnavailable:
            "Account settings have not finished synchronizing."
        case .concurrentWriteLimitExceeded:
            "Local memory changed repeatedly while Juno was saving it."
        }
    }
}

/// Projects memory and settings from the encrypted account database and layers
/// durable outbox mutations on top so offline edits are visible immediately.
public actor NativeMemorySettingsStore<Repository: AccountScopedRepository> {
    public static var summaryKey: RecordKey {
        RecordKey(namespace: "native_memory_summary", id: "summary")
    }

    private let repository: Repository
    private let outbox: any MutationOutboxRepository
    private let maximumTransactionAttempts: Int

    public init(
        repository: Repository,
        outbox: any MutationOutboxRepository,
        maximumTransactionAttempts: Int = 4
    ) {
        self.repository = repository
        self.outbox = outbox
        self.maximumTransactionAttempts = max(1, maximumTransactionAttempts)
    }

    public func load(accountID: StorageAccountID) async throws
        -> NativeMemorySettingsSnapshot
    {
        let snapshot = try await repository.snapshot(for: accountID)
        let mutations = try await outbox.mutations(accountID: accountID)
        var memories: [String: NativeMemoryEntry] = [:]
        var settings: NativeAccountSettings?
        var summary: NativeMemorySummary?

        for record in snapshot.records.values where !record.isTombstone {
            switch record.key.namespace {
            case "memory":
                let memory = try decodeMemory(record)
                memories[memory.id] = memory
            case "settings":
                guard settings == nil else {
                    throw NativeMemorySettingsError.corruptRecord(record.key)
                }
                settings = try decodeSettings(record)
            case "native_memory_summary" where record.key == Self.summaryKey:
                summary = try decodeSummary(record)
            default:
                break
            }
        }

        var pendingCount = 0
        var conflictCount = 0
        for mutation in mutations where Self.manages(mutation.draft.entity.namespace) {
            switch mutation.state {
            case .pending, .leased, .retryScheduled:
                pendingCount += 1
                try apply(mutation, memories: &memories, settings: &settings)
            case .conflicted:
                conflictCount += 1
            case .acknowledged, .discarded:
                break
            }
        }

        return NativeMemorySettingsSnapshot(
            memories: memories.values.sorted(by: memoryOrder),
            summary: summary,
            settings: settings,
            pendingMutationCount: pendingCount,
            conflictedMutationCount: conflictCount
        )
    }

    public func persistSummary(
        _ summary: NativeMemorySummary?,
        accountID: StorageAccountID
    ) async throws {
        for attempt in 0..<maximumTransactionAttempts {
            let snapshot = try await repository.snapshot(for: accountID)
            let operation: StorageOperation
            if let summary {
                let payload = try JSONEncoder().encode(CachedSummaryWire(
                    content: summary.content,
                    updatedAt: formatDate(summary.updatedAt),
                    entryCount: summary.entryCount
                ))
                let previous = snapshot.records[Self.summaryKey]?.revision ?? 0
                guard previous < UInt64.max else {
                    throw NativeMemorySettingsError.concurrentWriteLimitExceeded
                }
                operation = .upsert(StoredRecord(
                    accountID: accountID,
                    key: Self.summaryKey,
                    revision: previous + 1,
                    updatedAt: summary.updatedAt,
                    payload: payload
                ))
            } else {
                operation = .remove(Self.summaryKey)
            }
            do {
                _ = try await repository.apply(StorageTransaction(
                    accountID: accountID,
                    expectedStoreVersion: snapshot.version,
                    operations: [operation]
                ))
                return
            } catch AccountStorageError.versionConflict
                where attempt + 1 < maximumTransactionAttempts
            {
                continue
            } catch AccountStorageError.versionConflict {
                throw NativeMemorySettingsError.concurrentWriteLimitExceeded
            }
        }
        throw NativeMemorySettingsError.concurrentWriteLimitExceeded
    }

    public static func manages(_ namespace: String) -> Bool {
        namespace == "memory" || namespace == "settings"
    }

    private func decodeMemory(_ record: StoredRecord) throws -> NativeMemoryEntry {
        guard let payload = record.payload,
            let wire = try? JSONDecoder().decode(MemoryWire.self, from: payload),
            wire.id == record.key.id,
            let content = validMemory(wire.content),
            let source = NativeMemorySource(rawValue: wire.source),
            let kind = NativeMemoryKind(rawValue: wire.kind),
            let createdAt = parseDate(wire.createdAt),
            let updatedAt = parseDate(wire.updatedAt)
        else { throw NativeMemorySettingsError.corruptRecord(record.key) }
        return NativeMemoryEntry(
            id: wire.id,
            content: content,
            source: source,
            kind: kind,
            sourceReference: wire.sourceRef,
            createdAt: createdAt,
            updatedAt: updatedAt,
            revision: record.revision
        )
    }

    private func decodeSettings(_ record: StoredRecord) throws -> NativeAccountSettings {
        guard let payload = record.payload,
            let wire = try? JSONDecoder().decode(SettingsWire.self, from: payload),
            wire.id == record.key.id,
            let theme = NativeThemePreference(rawValue: wire.theme),
            Self.validString(wire.accent, maximum: 40, allowsEmpty: false),
            Self.validString(wire.defaultModel, maximum: 200, allowsEmpty: false),
            Self.validString(wire.customInstructions, maximum: 200_000, allowsEmpty: true),
            Self.validString(wire.responseLanguage, maximum: 80, allowsEmpty: false),
            Self.validString(wire.uiLocale, maximum: 40, allowsEmpty: false),
            Self.validString(wire.personality, maximum: 80, allowsEmpty: false),
            wire.voiceId.map({ Self.validString($0, maximum: 200, allowsEmpty: true) }) ?? true,
            Self.validFavorites(wire.favoriteModels),
            let updatedAt = parseDate(wire.updatedAt)
        else { throw NativeMemorySettingsError.corruptRecord(record.key) }
        return NativeAccountSettings(
            id: wire.id,
            theme: theme,
            accent: wire.accent,
            defaultModel: wire.defaultModel,
            customInstructions: wire.customInstructions,
            responseLanguage: wire.responseLanguage,
            interfaceLocale: wire.uiLocale,
            personality: wire.personality,
            memoryEnabled: wire.memoryEnabled,
            voiceID: wire.voiceId,
            favoriteModels: wire.favoriteModels,
            emailBudgetAlerts: wire.emailBudgetAlerts,
            emailWeeklyDigest: wire.emailWeeklyDigest,
            // An absent or unrecognised mode resolves to the privacy-preserving
            // default rather than failing the decode — a settings screen that
            // will not load is a worse outcome than one showing the safe value.
            backgroundProviderMode: BackgroundProviderMode(
                storedValue: wire.backgroundProviderMode
            ),
            backgroundProviderSelected: wire.backgroundProviderSelected,
            name: wire.name,
            memoryBackgroundLearning: wire.memoryBackgroundLearning,
            memorySensitiveTopics: wire.memorySensitiveTopics,
            actionApprovalPolicy: wire.actionApprovalPolicy,
            lockdownMode: wire.lockdownMode,
            blockedConnectors: wire.blockedConnectors,
            monthlySpendCapEur: wire.monthlySpendCapEur,
            spendCapDisabled: wire.spendCapDisabled,
            autoPreference: wire.autoPreference,
            autoDataBoundary: wire.autoDataBoundary,
            updatedAt: updatedAt,
            revision: record.revision
        )
    }

    private func decodeSummary(_ record: StoredRecord) throws -> NativeMemorySummary {
        guard let payload = record.payload,
            let wire = try? JSONDecoder().decode(CachedSummaryWire.self, from: payload),
            Self.validString(wire.content, maximum: 500_000, allowsEmpty: true),
            wire.entryCount >= 0,
            let updatedAt = parseDate(wire.updatedAt)
        else { throw NativeMemorySettingsError.corruptRecord(record.key) }
        return NativeMemorySummary(
            content: wire.content,
            updatedAt: updatedAt,
            entryCount: wire.entryCount
        )
    }

    private func apply(
        _ mutation: QueuedMutation,
        memories: inout [String: NativeMemoryEntry],
        settings: inout NativeAccountSettings?
    ) throws {
        guard let object = try JSONSerialization.jsonObject(
            with: mutation.draft.payload
        ) as? [String: Any], object["type"] as? String == mutation.draft.operation
        else { throw NativeMemorySettingsError.invalidMutation }

        switch mutation.draft.operation {
        case "memory.create":
            guard let clientID = object["clientEntityId"] as? String,
                clientID == mutation.draft.entity.id,
                let raw = object["content"] as? String,
                let content = validMemory(raw)
            else { throw NativeMemorySettingsError.invalidMutation }
            memories[clientID] = NativeMemoryEntry(
                id: clientID,
                content: content,
                source: .manual,
                kind: .fact,
                sourceReference: "native",
                createdAt: mutation.draft.createdAt,
                updatedAt: mutation.draft.createdAt,
                revision: 0,
                isPending: true
            )
        case "memory.update":
            guard let raw = object["content"] as? String,
                let content = validMemory(raw)
            else { throw NativeMemorySettingsError.invalidMutation }
            // The target may have been deleted on another device; the drainer
            // surfaces that as a conflict, so the overlay just skips it here.
            let id = mutation.draft.entity.id
            guard var memory = memories[id] else { break }
            memory.content = content
            memory.updatedAt = mutation.draft.createdAt
            memory.isPending = true
            memories[id] = memory
        case "memory.delete":
            memories.removeValue(forKey: mutation.draft.entity.id)
        case "settings.update":
            guard let patch = object["patch"] as? [String: Any] else {
                throw NativeMemorySettingsError.invalidMutation
            }
            guard var current = settings,
                current.id == mutation.draft.entity.id
            else { break }
            try Self.applySettingsPatch(patch, to: &current)
            current.updatedAt = mutation.draft.createdAt
            current.isPending = true
            settings = current
        default:
            throw NativeMemorySettingsError.invalidMutation
        }
    }

    /// Applies a raw settings patch. `nonisolated static` so callers outside the
    /// actor can reuse it — the model needs it to overlay a change the local record
    /// has not caught up with yet, and duplicating the field-by-field validation
    /// there is how the two would drift.
    nonisolated static func applySettingsPatch(
        _ patch: [String: Any],
        to settings: inout NativeAccountSettings
    ) throws {
        guard !patch.isEmpty else { throw NativeMemorySettingsError.invalidMutation }
        if let raw = patch["theme"] {
            guard let value = raw as? String,
                let theme = NativeThemePreference(rawValue: value)
            else { throw NativeMemorySettingsError.invalidMutation }
            settings.theme = theme
        }
        if let raw = patch["accent"] {
            guard let value = raw as? String,
                Self.validString(value, maximum: 40, allowsEmpty: false)
            else { throw NativeMemorySettingsError.invalidMutation }
            settings.accent = value
        }
        if let raw = patch["defaultModel"] {
            guard let value = raw as? String,
                Self.validString(value, maximum: 200, allowsEmpty: false)
            else { throw NativeMemorySettingsError.invalidMutation }
            settings.defaultModel = value
        }
        if let raw = patch["customInstructions"] {
            guard let value = raw as? String,
                Self.validString(value, maximum: 200_000, allowsEmpty: true)
            else { throw NativeMemorySettingsError.invalidMutation }
            settings.customInstructions = value
        }
        if let raw = patch["responseLanguage"] {
            guard let value = raw as? String,
                Self.validString(value, maximum: 80, allowsEmpty: false)
            else { throw NativeMemorySettingsError.invalidMutation }
            settings.responseLanguage = value
        }
        if let raw = patch["uiLocale"] {
            guard let value = raw as? String,
                Self.validString(value, maximum: 40, allowsEmpty: false)
            else { throw NativeMemorySettingsError.invalidMutation }
            settings.interfaceLocale = value
        }
        if let raw = patch["personality"] {
            guard let value = raw as? String,
                Self.validString(value, maximum: 80, allowsEmpty: false)
            else { throw NativeMemorySettingsError.invalidMutation }
            settings.personality = value
        }
        if let raw = patch["memoryEnabled"] {
            guard let value = raw as? Bool else {
                throw NativeMemorySettingsError.invalidMutation
            }
            settings.memoryEnabled = value
        }
        if let raw = patch["favoriteModels"] {
            guard let value = raw as? [String], Self.validFavorites(value) else {
                throw NativeMemorySettingsError.invalidMutation
            }
            settings.favoriteModels = value
        }
        if let raw = patch["emailBudgetAlerts"] {
            guard let value = raw as? Bool else {
                throw NativeMemorySettingsError.invalidMutation
            }
            settings.emailBudgetAlerts = value
        }
        if let raw = patch["emailWeeklyDigest"] {
            guard let value = raw as? Bool else {
                throw NativeMemorySettingsError.invalidMutation
            }
            settings.emailWeeklyDigest = value
        }
        if let raw = patch["voiceId"] {
            if raw is NSNull {
                settings.voiceID = nil
            } else {
                guard let value = raw as? String,
                    Self.validString(value, maximum: 200, allowsEmpty: true)
                else { throw NativeMemorySettingsError.invalidMutation }
                settings.voiceID = value.isEmpty ? nil : value
            }
        }
        try applyDirectFields(patch, to: &settings)
    }

    /// The Phase 3 fields, which only `PATCH /api/settings` writes and only
    /// `GET /api/settings` reads. Shared by the outbox overlay (a sync record
    /// that one day carries them) and the model's server overlay.
    nonisolated static func applyDirectFields(
        _ patch: [String: Any],
        to settings: inout NativeAccountSettings
    ) throws {
        if let raw = patch["backgroundProviderMode"] {
            guard let value = raw as? String else { throw NativeMemorySettingsError.invalidMutation }
            settings.backgroundProviderMode = BackgroundProviderMode(storedValue: value)
        }
        if let raw = patch["name"] {
            guard let value = raw as? String, value.count <= 80 else {
                throw NativeMemorySettingsError.invalidMutation
            }
            settings.name = value
        }
        if let raw = patch["memoryBackgroundLearning"] {
            guard let value = raw as? Bool else { throw NativeMemorySettingsError.invalidMutation }
            settings.memoryBackgroundLearning = value
        }
        if let raw = patch["memorySensitiveTopics"] {
            guard let value = raw as? [String], value.count <= 20 else {
                throw NativeMemorySettingsError.invalidMutation
            }
            settings.memorySensitiveTopics = value
        }
        if let raw = patch["actionApprovalPolicy"] {
            guard let value = raw as? String, !value.isEmpty, value.count <= 60 else {
                throw NativeMemorySettingsError.invalidMutation
            }
            settings.actionApprovalPolicy = value
        }
        if let raw = patch["lockdownMode"] {
            guard let value = raw as? Bool else { throw NativeMemorySettingsError.invalidMutation }
            settings.lockdownMode = value
        }
        if let raw = patch["blockedConnectors"] {
            guard let value = raw as? [String], value.count <= 200 else {
                throw NativeMemorySettingsError.invalidMutation
            }
            settings.blockedConnectors = value
        }
        if let raw = patch["monthlySpendCapEur"] {
            if raw is NSNull {
                settings.monthlySpendCapEur = nil
            } else {
                guard let value = raw as? Int, (0...100_000).contains(value) else {
                    throw NativeMemorySettingsError.invalidMutation
                }
                settings.monthlySpendCapEur = value
            }
        }
        if let raw = patch["spendCapDisabled"] {
            guard let value = raw as? Bool else { throw NativeMemorySettingsError.invalidMutation }
            settings.spendCapDisabled = value
        }
        if let raw = patch["autoPreference"] {
            guard let value = raw as? String, NativeAutoPreference.values.contains(value) else {
                throw NativeMemorySettingsError.invalidMutation
            }
            settings.autoPreference = value
        }
        if let raw = patch["autoDataBoundary"] {
            guard let value = raw as? String, NativeAutoDataBoundary.values.contains(value) else {
                throw NativeMemorySettingsError.invalidMutation
            }
            settings.autoDataBoundary = value
        }
    }

    private func validMemory(_ value: String) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= 20_000,
            Self.validString(trimmed, maximum: 20_000, allowsEmpty: false)
        else { return nil }
        return trimmed
    }

    nonisolated static func validFavorites(_ values: [String]) -> Bool {
        values.count <= 100
            && Set(values).count == values.count
            && values.allSatisfy {
                Self.validString($0, maximum: 200, allowsEmpty: false)
            }
    }

    nonisolated static func validString(
        _ value: String,
        maximum: Int,
        allowsEmpty: Bool
    ) -> Bool {
        (allowsEmpty || !value.isEmpty)
            && value.count <= maximum
            && !value.unicodeScalars.contains {
                CharacterSet.controlCharacters.contains($0)
                    && $0.value != 10 && $0.value != 9
            }
    }

    private func memoryOrder(_ lhs: NativeMemoryEntry, _ rhs: NativeMemoryEntry) -> Bool {
        if lhs.createdAt != rhs.createdAt { return lhs.createdAt > rhs.createdAt }
        return lhs.id < rhs.id
    }

    private func parseDate(_ value: String) -> Date? {
        let precise = ISO8601DateFormatter()
        precise.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = precise.date(from: value) { return date }
        let ordinary = ISO8601DateFormatter()
        ordinary.formatOptions = [.withInternetDateTime]
        return ordinary.date(from: value)
    }

    private func formatDate(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
}

public enum NativeMemoryAPIError: Error, Equatable, LocalizedError, Sendable {
    case malformedResponse
    case server(statusCode: Int, message: String, retryable: Bool)

    public var errorDescription: String? {
        switch self {
        case .malformedResponse:
            "Juno returned invalid memory data."
        case .server(_, let message, _):
            message
        }
    }
}

/// The summary and permanent reset are not sync entities, so they use the
/// existing owner-scoped memory route. Entry CRUD stays on durable v1 mutations.
public struct NativeMemoryAPIClient: Sendable {
    private let sender: any NativeAuthenticatedRequestSending

    public init(sender: any NativeAuthenticatedRequestSending) {
        self.sender = sender
    }

    public func summary(for accountID: AccountID) async throws -> NativeMemorySummary? {
        let response = try await sender.send(
            try NativeBearerRequest(path: "/api/memory"),
            for: accountID
        )
        try requireSuccess(response)
        let wire: MemoryResponseWire
        do { wire = try JSONDecoder().decode(MemoryResponseWire.self, from: response.body) }
        catch { throw NativeMemoryAPIError.malformedResponse }
        guard let summary = wire.summary else { return nil }
        guard summary.content.count <= 500_000, summary.entryCount >= 0,
            let updatedAt = parseDate(summary.updatedAt)
        else { throw NativeMemoryAPIError.malformedResponse }
        return NativeMemorySummary(
            content: summary.content,
            updatedAt: updatedAt,
            entryCount: summary.entryCount
        )
    }

    public func eraseAll(for accountID: AccountID) async throws {
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/memory",
                method: .delete,
                headers: HTTPHeaders(["accept": "application/json"])
            ),
            for: accountID
        )
        try requireSuccess(response)
        guard let object = try? JSONSerialization.jsonObject(with: response.body)
            as? [String: Any], object["ok"] as? Bool == true
        else { throw NativeMemoryAPIError.malformedResponse }
    }

    private func requireSuccess(_ response: HTTPResponse) throws {
        guard !(200...299).contains(response.statusCode) else { return }
        let object = try? JSONSerialization.jsonObject(with: response.body) as? [String: Any]
        let message = object?["message"] as? String
            ?? object?["error"] as? String
            ?? "Juno could not complete the memory request."
        throw NativeMemoryAPIError.server(
            statusCode: response.statusCode,
            message: message,
            retryable: response.statusCode == 408 || response.statusCode == 429
                || response.statusCode >= 500
        )
    }

    private func parseDate(_ value: String) -> Date? {
        let precise = ISO8601DateFormatter()
        precise.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = precise.date(from: value) { return date }
        let ordinary = ISO8601DateFormatter()
        ordinary.formatOptions = [.withInternetDateTime]
        return ordinary.date(from: value)
    }
}

@MainActor
@Observable
public final class NativeMemorySettingsModel<Repository: AccountScopedRepository> {
    public enum Phase: Equatable, Sendable {
        case idle
        case loading
        case ready
        case offline
        case failed
    }

    public private(set) var phase: Phase = .idle
    public private(set) var memories: [NativeMemoryEntry] = []
    public private(set) var summary: NativeMemorySummary?
    public private(set) var settings: NativeAccountSettings?
    public private(set) var pendingMutationCount = 0
    public private(set) var conflictedMutationCount = 0
    public private(set) var lastErrorDescription: String?
    public private(set) var isMutating = false
    public private(set) var isRefreshingSummary = false
    public private(set) var isErasing = false
    /// Where `GET /api/settings` stands — the read that supplies the fields the
    /// sync record does not carry (Phase 3).
    public private(set) var serverSettingsPhase: ServerSettingsPhase = .idle
    /// The live speech provider, from the same read; `.unknown` until it answers.
    public private(set) var ttsProvider: NativeTTSProviderStatus = .unknown

    public enum ServerSettingsPhase: Equatable, Sendable {
        case idle
        case loading
        case ready
        case failed
    }

    private let store: NativeMemorySettingsStore<Repository>
    private let serverClient: NativeServerSettingsClient
    /// The last `GET /api/settings` answer and every direct write since, as a
    /// raw patch laid over the sync record on each reload.
    private var serverOverlay: [String: Any] = [:]
    private let outbox: any MutationOutboxRepository
    private let drainer: NativeMutationDrainer<Repository>
    private let syncModel: NativeSyncModel<Repository>
    private let apiClient: NativeMemoryAPIClient
    private var accountID: AccountID?
    private var lastSynchronizationGeneration = -1
    private var isReconciling = false

    public init(
        repository: Repository,
        outbox: any MutationOutboxRepository,
        drainer: NativeMutationDrainer<Repository>,
        syncModel: NativeSyncModel<Repository>,
        sender: any NativeAuthenticatedRequestSending
    ) {
        store = NativeMemorySettingsStore(repository: repository, outbox: outbox)
        self.outbox = outbox
        self.drainer = drainer
        self.syncModel = syncModel
        apiClient = NativeMemoryAPIClient(sender: sender)
        serverClient = NativeServerSettingsClient(sender: sender)
    }

    public func start(for accountID: AccountID) async {
        guard self.accountID != accountID else {
            await refresh()
            return
        }
        stop()
        self.accountID = accountID
        phase = .loading
        await reload()
        await reconcilePendingMutations()
        await refreshSummary()
    }

    public func stop() {
        accountID = nil
        memories = []
        summary = nil
        settings = nil
        pendingMutationCount = 0
        conflictedMutationCount = 0
        acceptedSettings = [:]
        serverOverlay = [:]
        serverSettingsPhase = .idle
        ttsProvider = .unknown
        lastErrorDescription = nil
        isMutating = false
        isRefreshingSummary = false
        isErasing = false
        lastSynchronizationGeneration = -1
        phase = .idle
    }

    public func synchronizationDidAdvance(to generation: Int) async {
        guard generation != lastSynchronizationGeneration else { return }
        lastSynchronizationGeneration = generation
        await reconcilePendingMutations()
        await refreshSummary()
    }

    public func refresh() async {
        await syncModel.refresh()
        await reload()
        await reconcilePendingMutations()
        await refreshSummary()
    }

    public func reload() async {
        guard let accountID else { return }
        do {
            let snapshot = try await store.load(
                accountID: StorageAccountID(accountID.rawValue)
            )
            guard self.accountID == accountID else { return }
            memories = snapshot.memories
            summary = snapshot.summary
            settings = applyingAcceptedSettings(
                to: applyingServerOverlay(to: snapshot.settings),
                pendingMutations: snapshot.pendingMutationCount
            )
            pendingMutationCount = snapshot.pendingMutationCount
            conflictedMutationCount = snapshot.conflictedMutationCount
            lastErrorDescription = snapshot.conflictedMutationCount == 0
                ? nil : "An account change needs your attention."
            switch syncModel.phase {
            case .offline:
                phase = .offline
            case .failed:
                // Local data loaded, but synchronization is refusing. Reporting
                // `.ready` here is what let a hard protocol failure read as a
                // finished load with stale content and no explanation.
                phase = .failed
                if snapshot.conflictedMutationCount == 0 {
                    lastErrorDescription = syncModel.lastErrorDescription
                }
            case .idle, .synchronizing, .live:
                phase = .ready
            }
        } catch {
            guard self.accountID == accountID else { return }
            lastErrorDescription = NativeFailureMessage.presentable(error)
            phase = .failed
        }
    }

    public func createMemory(content: String) async {
        guard let accountID, let content = validMemory(content) else {
            lastErrorDescription = NativeMemorySettingsError.invalidMemory.localizedDescription
            return
        }
        let clientID = UUID().uuidString.lowercased()
        await enqueueAndDrain(
            operation: "memory.create",
            entity: RecordKey(namespace: "memory", id: clientID),
            object: [
                "type": "memory.create",
                "clientEntityId": clientID,
                "content": content,
            ],
            accountID: accountID
        )
    }

    public func updateMemory(id: String, content: String) async {
        guard let accountID, memories.contains(where: { $0.id == id }),
            let content = validMemory(content)
        else {
            lastErrorDescription = NativeMemorySettingsError.invalidMemory.localizedDescription
            return
        }
        await enqueueAndDrain(
            operation: "memory.update",
            entity: RecordKey(namespace: "memory", id: id),
            object: ["type": "memory.update", "entityId": id, "content": content],
            accountID: accountID
        )
    }

    public func deleteMemory(id: String) async {
        guard let accountID, memories.contains(where: { $0.id == id }) else {
            lastErrorDescription = NativeMemorySettingsError.memoryNotFound(id)
                .localizedDescription
            return
        }
        await enqueueAndDrain(
            operation: "memory.delete",
            entity: RecordKey(namespace: "memory", id: id),
            object: ["type": "memory.delete", "entityId": id],
            accountID: accountID
        )
    }

    /// Settings changes the server has accepted but the local record has not yet
    /// caught up with, keyed by field.
    ///
    /// Without this, every settings change *visually reverted*. The sequence is:
    /// enqueue → `reload()` shows the value via the pending-mutation overlay →
    /// drain **acknowledges** the mutation → the overlay stops applying → the next
    /// `reload()` reads the untouched local record and the old value comes back.
    /// The change was saved the whole time; only the screen disagreed, which is why
    /// the accent picker looked like it did nothing.
    ///
    /// Each entry is dropped the moment an incoming record already agrees with it,
    /// so this is self-healing rather than a second source of truth — and it cannot
    /// mask a server rejection, because a rejected mutation conflicts instead of
    /// being acknowledged.
    private var acceptedSettings: [String: Any] = [:]

    /// Overlays accepted-but-not-yet-durable settings onto an incoming snapshot.
    ///
    /// **`pendingMutations` is what makes the clearing rule correct.** The snapshot
    /// itself already overlays *pending* mutations, so while one is in flight the
    /// incoming record appears to carry the new value — and an earlier version of
    /// this read that as "the round trip finished" and dropped the entry. The drain
    /// then acknowledged the mutation, the pending overlay stopped applying, and
    /// with the entry already gone the old value came straight back. That is
    /// precisely the revert this exists to prevent, reintroduced by its own
    /// housekeeping.
    ///
    /// An entry is therefore only cleared when the record agrees with it **and**
    /// nothing is queued — the two conditions that together mean the value is
    /// really on the record rather than being simulated by the outbox.
    private func applyingAcceptedSettings(
        to incoming: NativeAccountSettings?,
        pendingMutations: Int
    ) -> NativeAccountSettings? {
        guard var result = incoming, !acceptedSettings.isEmpty else { return incoming }
        var stillOutstanding: [String: Any] = [:]
        for (field, value) in acceptedSettings {
            var probe = result
            guard (try? NativeMemorySettingsStore<Repository>.applySettingsPatch(
                [field: value], to: &probe
            )) != nil else { continue }
            if probe == result {
                // The record matches. Only durable if nothing is still queued;
                // otherwise this is the pending overlay wearing the record's face.
                if pendingMutations == 0 { continue }
                stillOutstanding[field] = value
                continue
            }
            result = probe
            stillOutstanding[field] = value
        }
        acceptedSettings = stillOutstanding
        return result
    }

    public func updateSettings(_ patch: NativeSettingsPatch) async {
        _ = await saveSettings(patch)
    }

    /// Writes a settings change and says how it went, for a row's save status.
    ///
    /// Optimistic both ways: the value shows at once, and a refusal puts the
    /// previous one back. The fields the sync outbox accepts go through it —
    /// durable offline, conflict-checked — and the rest through
    /// `PATCH /api/settings` (see ``NativeSettingsPatch/syncedFields``).
    @discardableResult
    public func saveSettings(_ patch: NativeSettingsPatch) async -> NativeSettingsSaveResult {
        guard let accountID, let settings else {
            let message = NativeMemorySettingsError.settingsUnavailable.localizedDescription
            lastErrorDescription = message
            return .failed(message)
        }
        let patchObject = patch.object
        guard validate(patchObject), !patchObject.isEmpty else {
            let message = NativeMemorySettingsError.invalidSettings.localizedDescription
            lastErrorDescription = message
            return .failed(message)
        }
        let direct = patchObject.filter { !NativeSettingsPatch.syncedFields.contains($0.key) }
        let synced = patchObject.filter { NativeSettingsPatch.syncedFields.contains($0.key) }

        if !direct.isEmpty {
            let previous = serverOverlay
            for (field, value) in direct { serverOverlay[field] = value }
            overlayCurrentSettings(direct)
            do {
                guard let body = try patch.directBody() else { return .saved }
                try await serverClient.patch(body: body, for: accountID)
            } catch {
                guard self.accountID == accountID else { return .failed("") }
                serverOverlay = previous
                await reload()
                let message = NativeFailureMessage.presentable(error)
                return .failed(message)
            }
            guard self.accountID == accountID else { return .saved }
        }

        guard !synced.isEmpty else { return .saved }
        // Held from here, not from acknowledgement: the drain inside
        // `enqueueAndDrain` can acknowledge and reload before this function
        // resumes, and the overlay has to already be in place by then.
        for (field, value) in synced { acceptedSettings[field] = value }
        let drained = await enqueueAndDrain(
            operation: "settings.update",
            entity: RecordKey(namespace: "settings", id: settings.id),
            object: ["type": "settings.update", "patch": synced],
            accountID: accountID
        )
        switch drained {
        case .failed(let message):
            for field in synced.keys { acceptedSettings.removeValue(forKey: field) }
            await reload()
            return .failed(message)
        case .conflicted:
            return .failed("Memory or settings changed on another device.")
        case .queued:
            return .queued
        case .acknowledged:
            return .saved
        }
    }

    /// Reads `GET /api/settings` for the fields the sync record does not
    /// carry, and lays them over the record.
    public func refreshServerSettings() async {
        guard let accountID else { return }
        serverSettingsPhase = .loading
        do {
            let fetched = try await serverClient.fetch(for: accountID)
            guard self.accountID == accountID else { return }
            // The server's answer is the truth for every field it sent; a field
            // it did not send keeps what this Mac last wrote.
            var overlay = fetched.overlay
            for (field, value) in serverOverlay where overlay[field] == nil { overlay[field] = value }
            serverOverlay = overlay
            ttsProvider = fetched.ttsProvider
            serverSettingsPhase = .ready
            await reload()
        } catch {
            guard self.accountID == accountID else { return }
            serverSettingsPhase = .failed
        }
    }

    /// The server's own answer for the direct fields, laid over a record.
    private func applyingServerOverlay(to incoming: NativeAccountSettings?) -> NativeAccountSettings? {
        guard var result = incoming, !serverOverlay.isEmpty else { return incoming }
        try? NativeMemorySettingsStore<Repository>.applyDirectFields(serverOverlay, to: &result)
        return result
    }

    private func overlayCurrentSettings(_ patch: [String: Any]) {
        guard var current = settings else { return }
        try? NativeMemorySettingsStore<Repository>.applyDirectFields(patch, to: &current)
        settings = current
    }

    public func eraseAllMemory() async {
        guard let accountID else { return }
        isErasing = true
        defer { isErasing = false }
        do {
            // Flush queued memory edits first so an offline-queued create
            // cannot land after the reset and silently resurrect content.
            await reconcilePendingMutations()
            try await apiClient.eraseAll(for: accountID)
            try await store.persistSummary(
                nil,
                accountID: StorageAccountID(accountID.rawValue)
            )
            guard self.accountID == accountID else { return }
            summary = nil
            memories = []
            await syncModel.refresh()
            await reload()
        } catch {
            guard self.accountID == accountID else { return }
            record(error)
        }
    }

    public func resolveConflicts(keepLocalChanges: Bool) async {
        guard let accountID else { return }
        if keepLocalChanges { await syncModel.refresh() }
        do {
            let storageAccountID = StorageAccountID(accountID.rawValue)
            let mutations = try await outbox.mutations(accountID: storageAccountID)
            for mutation in mutations
                where NativeMemorySettingsStore<Repository>.manages(
                    mutation.draft.entity.namespace
                )
            {
                guard case .conflicted = mutation.state else { continue }
                try await outbox.resolveConflict(
                    id: mutation.draft.id,
                    accountID: storageAccountID,
                    resolution: keepLocalChanges
                        ? .retry : .discard(reason: "use_server_version"),
                    now: Date()
                )
            }
            await reload()
            if keepLocalChanges { await reconcilePendingMutations() }
        } catch {
            guard self.accountID == accountID else { return }
            record(error)
        }
    }

    private func refreshSummary() async {
        guard let accountID, !isRefreshingSummary else { return }
        isRefreshingSummary = true
        defer { isRefreshingSummary = false }
        do {
            let fetched = try await apiClient.summary(for: accountID)
            try await store.persistSummary(
                fetched,
                accountID: StorageAccountID(accountID.rawValue)
            )
            guard self.accountID == accountID else { return }
            summary = fetched
            if conflictedMutationCount == 0 { lastErrorDescription = nil }
            phase = .ready
        } catch {
            guard self.accountID == accountID else { return }
            // A cached summary is not a reason to hide why the refresh failed.
            // Suppressing the description here is exactly what produced
            // "Offline — showing saved settings" on a working network, with a
            // Retry button that re-ran the same doomed request forever.
            lastErrorDescription = NativeFailureMessage.presentable(error)
            phase = NativeSyncModel<Repository>.isConnectivityFailure(error) || syncModel.phase == .offline
                ? .offline
                : .failed
        }
    }

    /// How one enqueue-and-drain ended, for a caller that reports a save.
    private enum DrainOutcome {
        case acknowledged
        case queued
        case conflicted
        case failed(String)
    }

    @discardableResult
    private func enqueueAndDrain(
        operation: String,
        entity: RecordKey,
        object: [String: Any],
        accountID: AccountID
    ) async -> DrainOutcome {
        guard JSONSerialization.isValidJSONObject(object),
            let payload = try? JSONSerialization.data(
                withJSONObject: object,
                options: [.sortedKeys]
            )
        else {
            let message = NativeMemorySettingsError.invalidMutation.localizedDescription
            lastErrorDescription = message
            return .failed(message)
        }
        let draft = MutationDraft(
            id: OutboxMutationID(UUID().uuidString.lowercased()),
            accountID: StorageAccountID(accountID.rawValue),
            idempotencyKey: IdempotencyKey(UUID().uuidString.lowercased()),
            entity: entity,
            operation: operation,
            payload: payload,
            createdAt: Date()
        )
        isMutating = true
        defer { isMutating = false }
        do {
            _ = try await outbox.enqueue(draft)
            await reload()
            guard let result = await reconcilePendingMutations() else { return .queued }
            if result.conflicted > 0 { return .conflicted }
            if result.retryScheduled > 0 { return .queued }
            return .acknowledged
        } catch {
            guard self.accountID == accountID else { return .failed("") }
            record(error)
            return .failed(NativeFailureMessage.presentable(error))
        }
    }

    @discardableResult
    private func reconcilePendingMutations() async -> NativeMutationDrainResult? {
        guard !isReconciling, let accountID else { return nil }
        isReconciling = true
        defer { isReconciling = false }
        do {
            let result = try await drainer.drain(
                for: accountID,
                owner: "memory-settings-ui"
            )
            if result.acknowledged > 0 { await syncModel.refresh() }
            await reload()
            if result.retryScheduled > 0 {
                lastErrorDescription = "Account changes are saved and will sync when Juno reconnects."
                phase = .offline
            } else if result.conflicted > 0 {
                lastErrorDescription = "Memory or settings changed on another device."
                phase = .failed
            }
            return result
        } catch {
            guard self.accountID == accountID else { return nil }
            record(error)
            return nil
        }
    }

    private func validMemory(_ value: String) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= 20_000 else { return nil }
        return trimmed
    }

    private func validate(_ patch: [String: Any]) -> Bool {
        if let accent = patch["accent"] as? String,
            accent.isEmpty || accent.count > 40 { return false }
        if let model = patch["defaultModel"] as? String,
            model.isEmpty || model.count > 200 { return false }
        if let instructions = patch["customInstructions"] as? String,
            instructions.count > 200_000 { return false }
        if let language = patch["responseLanguage"] as? String,
            language.isEmpty || language.count > 80 { return false }
        if let locale = patch["uiLocale"] as? String,
            locale.isEmpty || locale.count > 40 { return false }
        if let personality = patch["personality"] as? String,
            personality.isEmpty || personality.count > 80 { return false }
        if let favorites = patch["favoriteModels"] as? [String],
            favorites.count > 100 || Set(favorites).count != favorites.count
                || favorites.contains(where: { $0.isEmpty || $0.count > 200 })
        { return false }
        if let name = patch["name"] as? String, name.count > 80 { return false }
        if let policy = patch["actionApprovalPolicy"] as? String,
            !NativeSettingsPatch.actionApprovalPolicies.contains(policy) { return false }
        if let blocked = patch["blockedConnectors"] as? [String],
            blocked.count > 200 || blocked.contains(where: { $0.isEmpty || $0.count > 120 })
        { return false }
        if let cap = patch["monthlySpendCapEur"] as? Int, !(0...100_000).contains(cap) { return false }
        if let preference = patch["autoPreference"] as? String,
            !NativeAutoPreference.values.contains(preference) { return false }
        if let boundary = patch["autoDataBoundary"] as? String,
            !NativeAutoDataBoundary.values.contains(boundary) { return false }
        return true
    }

    private func record(_ error: any Error) {
        lastErrorDescription = NativeFailureMessage.presentable(error)
        phase = NativeSyncModel<Repository>.isConnectivityFailure(error) || syncModel.phase == .offline
            ? .offline
            : .failed
    }
}

private struct MemoryWire: Decodable {
    let id: String
    let content: String
    let source: String
    let kind: String
    let sourceRef: String?
    let createdAt: String
    let updatedAt: String
}

private struct SettingsWire: Decodable {
    let id: String
    let theme: String
    let accent: String
    let defaultModel: String
    let customInstructions: String
    let responseLanguage: String
    let uiLocale: String
    let personality: String
    let memoryEnabled: Bool
    let voiceId: String?
    let favoriteModels: [String]
    let emailBudgetAlerts: Bool
    let emailWeeklyDigest: Bool
    // Optional: a server that predates the policy sends neither, and a missing
    // value must resolve to the privacy-preserving default rather than fail
    // the whole settings decode.
    let backgroundProviderMode: String?
    let backgroundProviderSelected: String?
    // Phase 3: decoded when a record carries them; every older payload still
    // decodes, because each is optional.
    let name: String?
    let memoryBackgroundLearning: Bool?
    let memorySensitiveTopics: [String]?
    let actionApprovalPolicy: String?
    let lockdownMode: Bool?
    let blockedConnectors: [String]?
    let monthlySpendCapEur: Int?
    let spendCapDisabled: Bool?
    let autoPreference: String?
    let autoDataBoundary: String?
    let updatedAt: String
}

private struct CachedSummaryWire: Codable {
    let content: String
    let updatedAt: String
    let entryCount: Int
}

private struct MemoryResponseWire: Decodable {
    struct Summary: Decodable {
        let content: String
        let updatedAt: String
        let entryCount: Int
    }

    let summary: Summary?
}

// MARK: - Direct settings (Phase 3)

/// How one settings write ended, for the row that made it.
public enum NativeSettingsSaveResult: Equatable, Sendable {
    /// The server has it.
    case saved
    /// Durably queued on this device, to be sent when Juno reconnects.
    case queued
    /// Refused or lost; the previous value is back. The sentence says why.
    case failed(String)

    public var succeeded: Bool {
        if case .failed = self { return false }
        return true
    }
}

/// `GET /api/settings`: the fields the sync record does not carry.
public struct NativeServerSettings: Equatable, Sendable {
    public var memorySensitiveTopics: [String]?
    public var memoryBackgroundLearning: Bool?
    public var backgroundProviderMode: String?
    public var actionApprovalPolicy: String?
    public var lockdownMode: Bool?
    public var blockedConnectors: [String]?
    public var monthlySpendCapEur: Int?
    public var spendCapDisabled: Bool?
    public var autoPreference: String?
    public var autoDataBoundary: String?
    /// The live speech provider, sent beside the settings.
    public var ttsProvider: NativeTTSProviderStatus

    public init(
        memorySensitiveTopics: [String]? = nil,
        memoryBackgroundLearning: Bool? = nil,
        backgroundProviderMode: String? = nil,
        actionApprovalPolicy: String? = nil,
        lockdownMode: Bool? = nil,
        blockedConnectors: [String]? = nil,
        monthlySpendCapEur: Int? = nil,
        spendCapDisabled: Bool? = nil,
        autoPreference: String? = nil,
        autoDataBoundary: String? = nil,
        ttsProvider: NativeTTSProviderStatus = .unknown
    ) {
        self.memorySensitiveTopics = memorySensitiveTopics
        self.memoryBackgroundLearning = memoryBackgroundLearning
        self.backgroundProviderMode = backgroundProviderMode
        self.actionApprovalPolicy = actionApprovalPolicy
        self.lockdownMode = lockdownMode
        self.blockedConnectors = blockedConnectors
        self.monthlySpendCapEur = monthlySpendCapEur
        self.spendCapDisabled = spendCapDisabled
        self.autoPreference = autoPreference
        self.autoDataBoundary = autoDataBoundary
        self.ttsProvider = ttsProvider
    }

    /// As the raw patch the model lays over the sync record. A ceiling of
    /// `null` is a real answer ("the default") and is kept as one.
    var overlay: [String: Any] {
        var result: [String: Any] = [:]
        if let memorySensitiveTopics { result["memorySensitiveTopics"] = memorySensitiveTopics }
        if let memoryBackgroundLearning { result["memoryBackgroundLearning"] = memoryBackgroundLearning }
        if let backgroundProviderMode { result["backgroundProviderMode"] = backgroundProviderMode }
        if let actionApprovalPolicy { result["actionApprovalPolicy"] = actionApprovalPolicy }
        if let lockdownMode { result["lockdownMode"] = lockdownMode }
        if let blockedConnectors { result["blockedConnectors"] = blockedConnectors }
        result["monthlySpendCapEur"] = monthlySpendCapEur.map { $0 as Any } ?? NSNull()
        if let spendCapDisabled { result["spendCapDisabled"] = spendCapDisabled }
        // An unknown value from a newer server is left out rather than failing
        // the whole overlay; the row then shows the default.
        if let autoPreference, NativeAutoPreference.values.contains(autoPreference) {
            result["autoPreference"] = autoPreference
        }
        if let autoDataBoundary, NativeAutoDataBoundary.values.contains(autoDataBoundary) {
            result["autoDataBoundary"] = autoDataBoundary
        }
        return result
    }
}

/// `GET` and `PATCH /api/settings`, for the settings the sync protocol does
/// not carry. Both accept the native bearer (`getCurrentUser` reads it).
public struct NativeServerSettingsClient: Sendable {
    private let sender: any NativeAuthenticatedRequestSending

    public init(sender: any NativeAuthenticatedRequestSending) {
        self.sender = sender
    }

    public func fetch(for accountID: AccountID) async throws -> NativeServerSettings {
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/settings",
                headers: try HTTPHeaders(["accept": "application/json"])
            ),
            for: accountID
        )
        try Self.requireSuccess(response, fallback: "Juno could not load your settings")
        do {
            return try Self.decode(response.body)
        } catch {
            throw NativeMemoryAPIError.malformedResponse
        }
    }

    /// The `GET /api/settings` body, as ``fetch(for:)`` reads it.
    public static func decode(_ body: Data) throws -> NativeServerSettings {
        do {
            let wire = try JSONDecoder().decode(ServerSettingsResponseWire.self, from: body)
            let s = wire.settings
            return NativeServerSettings(
                memorySensitiveTopics: s.memorySensitiveTopics,
                memoryBackgroundLearning: s.memoryBackgroundLearning,
                backgroundProviderMode: s.backgroundProviderMode,
                actionApprovalPolicy: s.actionApprovalPolicy,
                lockdownMode: s.lockdownMode,
                blockedConnectors: s.blockedConnectors,
                monthlySpendCapEur: s.monthlySpendCapEur,
                spendCapDisabled: s.spendCapDisabled,
                autoPreference: s.autoPreference,
                autoDataBoundary: s.autoDataBoundary,
                ttsProvider: wire.ttsProvider
            )
        }
    }

    /// Sends a JSON body of settings fields, as ``NativeSettingsPatch/directBody()``
    /// builds it.
    public func patch(body: Data, for accountID: AccountID) async throws {
        let response = try await sender.send(
            try NativeBearerRequest(
                path: "/api/settings",
                method: .patch,
                headers: try HTTPHeaders([
                    "accept": "application/json",
                    "content-type": "application/json",
                ]),
                body: body
            ),
            for: accountID
        )
        try Self.requireSuccess(response, fallback: "Juno could not save this setting")
    }

    private static func requireSuccess(_ response: HTTPResponse, fallback: String) throws {
        guard !(200...299).contains(response.statusCode) else { return }
        let object = try? JSONSerialization.jsonObject(with: response.body) as? [String: Any]
        let message = (object?["error"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        throw NativeMemoryAPIError.server(
            statusCode: response.statusCode,
            message: message ?? "\(fallback) (\(response.statusCode)).",
            retryable: response.statusCode == 408 || response.statusCode == 429
                || response.statusCode >= 500
        )
    }
}

private struct ServerSettingsResponseWire: Decodable {
    struct Settings: Decodable {
        let memorySensitiveTopics: [String]?
        let memoryBackgroundLearning: Bool?
        let backgroundProviderMode: String?
        let actionApprovalPolicy: String?
        let lockdownMode: Bool?
        let blockedConnectors: [String]?
        let monthlySpendCapEur: Int?
        let spendCapDisabled: Bool?
        let autoPreference: String?
        let autoDataBoundary: String?
    }

    let settings: Settings
    /// Absent (an older server) is `.unknown`; `null` is `.unavailable`.
    let ttsProvider: NativeTTSProviderStatus

    private enum CodingKeys: String, CodingKey {
        case settings, ttsProvider
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        settings = try container.decode(Settings.self, forKey: .settings)
        if container.contains(.ttsProvider) {
            ttsProvider = NativeTTSProviderStatus(
                serverValue: try container.decodeIfPresent(String.self, forKey: .ttsProvider)
            )
        } else {
            ttsProvider = .unknown
        }
    }
}

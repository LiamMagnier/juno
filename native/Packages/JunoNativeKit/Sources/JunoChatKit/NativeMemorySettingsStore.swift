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
        emailWeeklyDigest: Bool? = nil
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
    }

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
        if let favoriteModels { result["favoriteModels"] = favoriteModels }
        if let emailBudgetAlerts { result["emailBudgetAlerts"] = emailBudgetAlerts }
        if let emailWeeklyDigest { result["emailWeeklyDigest"] = emailWeeklyDigest }
        return result
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
            validString(wire.accent, maximum: 40, allowsEmpty: false),
            validString(wire.defaultModel, maximum: 200, allowsEmpty: false),
            validString(wire.customInstructions, maximum: 200_000, allowsEmpty: true),
            validString(wire.responseLanguage, maximum: 80, allowsEmpty: false),
            validString(wire.uiLocale, maximum: 40, allowsEmpty: false),
            validString(wire.personality, maximum: 80, allowsEmpty: false),
            wire.voiceId.map({ validString($0, maximum: 200, allowsEmpty: true) }) ?? true,
            validFavorites(wire.favoriteModels),
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
            updatedAt: updatedAt,
            revision: record.revision
        )
    }

    private func decodeSummary(_ record: StoredRecord) throws -> NativeMemorySummary {
        guard let payload = record.payload,
            let wire = try? JSONDecoder().decode(CachedSummaryWire.self, from: payload),
            validString(wire.content, maximum: 500_000, allowsEmpty: true),
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
            try applySettingsPatch(patch, to: &current)
            current.updatedAt = mutation.draft.createdAt
            current.isPending = true
            settings = current
        default:
            throw NativeMemorySettingsError.invalidMutation
        }
    }

    private func applySettingsPatch(
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
                validString(value, maximum: 40, allowsEmpty: false)
            else { throw NativeMemorySettingsError.invalidMutation }
            settings.accent = value
        }
        if let raw = patch["defaultModel"] {
            guard let value = raw as? String,
                validString(value, maximum: 200, allowsEmpty: false)
            else { throw NativeMemorySettingsError.invalidMutation }
            settings.defaultModel = value
        }
        if let raw = patch["customInstructions"] {
            guard let value = raw as? String,
                validString(value, maximum: 200_000, allowsEmpty: true)
            else { throw NativeMemorySettingsError.invalidMutation }
            settings.customInstructions = value
        }
        if let raw = patch["responseLanguage"] {
            guard let value = raw as? String,
                validString(value, maximum: 80, allowsEmpty: false)
            else { throw NativeMemorySettingsError.invalidMutation }
            settings.responseLanguage = value
        }
        if let raw = patch["uiLocale"] {
            guard let value = raw as? String,
                validString(value, maximum: 40, allowsEmpty: false)
            else { throw NativeMemorySettingsError.invalidMutation }
            settings.interfaceLocale = value
        }
        if let raw = patch["personality"] {
            guard let value = raw as? String,
                validString(value, maximum: 80, allowsEmpty: false)
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
            guard let value = raw as? [String], validFavorites(value) else {
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
    }

    private func validMemory(_ value: String) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= 20_000,
            validString(trimmed, maximum: 20_000, allowsEmpty: false)
        else { return nil }
        return trimmed
    }

    private func validFavorites(_ values: [String]) -> Bool {
        values.count <= 100
            && Set(values).count == values.count
            && values.allSatisfy {
                validString($0, maximum: 200, allowsEmpty: false)
            }
    }

    private func validString(
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

    private let store: NativeMemorySettingsStore<Repository>
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
            settings = snapshot.settings
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

    public func updateSettings(_ patch: NativeSettingsPatch) async {
        guard let accountID, let settings else {
            lastErrorDescription = NativeMemorySettingsError.settingsUnavailable
                .localizedDescription
            return
        }
        let patchObject = patch.object
        guard validate(patchObject), !patchObject.isEmpty else {
            lastErrorDescription = NativeMemorySettingsError.invalidSettings
                .localizedDescription
            return
        }
        await enqueueAndDrain(
            operation: "settings.update",
            entity: RecordKey(namespace: "settings", id: settings.id),
            object: ["type": "settings.update", "patch": patchObject],
            accountID: accountID
        )
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

    private func enqueueAndDrain(
        operation: String,
        entity: RecordKey,
        object: [String: Any],
        accountID: AccountID
    ) async {
        guard JSONSerialization.isValidJSONObject(object),
            let payload = try? JSONSerialization.data(
                withJSONObject: object,
                options: [.sortedKeys]
            )
        else {
            lastErrorDescription = NativeMemorySettingsError.invalidMutation
                .localizedDescription
            return
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
            await reconcilePendingMutations()
        } catch {
            guard self.accountID == accountID else { return }
            record(error)
        }
    }

    private func reconcilePendingMutations() async {
        guard !isReconciling, let accountID else { return }
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
        } catch {
            guard self.accountID == accountID else { return }
            record(error)
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

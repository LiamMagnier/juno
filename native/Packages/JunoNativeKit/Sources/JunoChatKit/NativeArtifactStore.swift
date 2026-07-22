import Foundation
import JunoAuth
import JunoCore
import JunoStorage
import JunoSync
import Observation

public struct NativeArtifact: Identifiable, Equatable, Sendable {
    public let id: String
    public let conversationID: String
    public var conversationTitle: String
    public let messageID: String?
    public let identifier: String
    public var title: String
    public let kind: NativeArtifactKind
    public let language: String?
    public var currentVersion: Int
    public var versions: [NativeArtifactVersion]
    public let createdAt: Date
    public var updatedAt: Date
    public let revision: UInt64

    public init(
        id: String,
        conversationID: String,
        conversationTitle: String,
        messageID: String?,
        identifier: String,
        title: String,
        kind: NativeArtifactKind,
        language: String?,
        currentVersion: Int,
        versions: [NativeArtifactVersion],
        createdAt: Date,
        updatedAt: Date,
        revision: UInt64
    ) {
        self.id = id
        self.conversationID = conversationID
        self.conversationTitle = conversationTitle
        self.messageID = messageID
        self.identifier = identifier
        self.title = title
        self.kind = kind
        self.language = language
        self.currentVersion = currentVersion
        self.versions = versions
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.revision = revision
    }

    public var currentContent: String? {
        versions.first { $0.version == currentVersion }?.content
    }
}

public struct NativeArtifactSnapshot: Equatable, Sendable {
    public let artifacts: [NativeArtifact]

    public init(artifacts: [NativeArtifact]) {
        self.artifacts = artifacts
    }
}

public enum NativeArtifactStoreError: Error, Equatable, LocalizedError, Sendable {
    case corruptRecord(RecordKey)
    case artifactNotFound(String)

    public var errorDescription: String? {
        switch self {
        case .corruptRecord:
            "Juno could not read the locally stored artifact data."
        case .artifactNotFound:
            "The artifact is no longer available."
        }
    }
}

/// Projects artifact/version entities from the encrypted account database.
/// Content and history remain available while offline and never cross accounts.
public actor NativeArtifactStore<Repository: AccountScopedRepository> {
    private let repository: Repository

    public init(repository: Repository) {
        self.repository = repository
    }

    public func load(accountID: StorageAccountID) async throws -> NativeArtifactSnapshot {
        let snapshot = try await repository.snapshot(for: accountID)
        var conversationTitles: [String: String] = [:]
        var versionsByArtifact: [String: [NativeArtifactVersion]] = [:]
        var artifactRecords: [StoredRecord] = []

        for record in snapshot.records.values where !record.isTombstone {
            switch record.key.namespace {
            case "conversation":
                if let title = decodeConversationTitle(record) {
                    conversationTitles[record.key.id] = title
                }
            case "artifact_version":
                let decoded = try decodeVersion(record)
                versionsByArtifact[decoded.artifactID, default: []].append(decoded.version)
            case "artifact":
                artifactRecords.append(record)
            default:
                break
            }
        }

        let artifacts = try artifactRecords.map { record -> NativeArtifact in
            let decoded = try decodeArtifact(record)
            let versions = (versionsByArtifact[decoded.artifact.id] ?? [])
            return NativeArtifact(
                id: decoded.artifact.id,
                conversationID: decoded.artifact.conversationId,
                conversationTitle: conversationTitles[decoded.artifact.conversationId]
                    ?? "Conversation",
                messageID: decoded.artifact.messageId,
                identifier: decoded.artifact.identifier,
                title: decoded.artifact.title,
                kind: decoded.kind,
                language: decoded.artifact.language,
                currentVersion: decoded.artifact.currentVersion,
                versions: versions.sorted { $0.version < $1.version },
                createdAt: decoded.createdAt,
                updatedAt: decoded.updatedAt,
                revision: record.revision
            )
        }.sorted {
            if $0.updatedAt != $1.updatedAt { return $0.updatedAt > $1.updatedAt }
            return $0.id < $1.id
        }
        return NativeArtifactSnapshot(artifacts: artifacts)
    }

    private func decodeArtifact(
        _ record: StoredRecord
    ) throws -> (artifact: ArtifactWire, kind: NativeArtifactKind, createdAt: Date, updatedAt: Date) {
        guard let payload = record.payload,
            let wire = try? JSONDecoder().decode(ArtifactWire.self, from: payload),
            wire.id == record.key.id, !wire.conversationId.isEmpty,
            !wire.identifier.isEmpty, !wire.title.isEmpty, wire.currentVersion > 0,
            let kind = NativeArtifactKind(rawValue: wire.type),
            let createdAt = parseDate(wire.createdAt),
            let updatedAt = parseDate(wire.updatedAt)
        else { throw NativeArtifactStoreError.corruptRecord(record.key) }
        return (wire, kind, createdAt, updatedAt)
    }

    private func decodeVersion(
        _ record: StoredRecord
    ) throws -> (artifactID: String, version: NativeArtifactVersion) {
        guard let payload = record.payload,
            let wire = try? JSONDecoder().decode(ArtifactVersionWire.self, from: payload),
            wire.id == record.key.id, !wire.artifactId.isEmpty, wire.version > 0,
            wire.content.utf16.count <= 200_000,
            let createdAt = parseDate(wire.createdAt)
        else { throw NativeArtifactStoreError.corruptRecord(record.key) }
        return (
            wire.artifactId,
            NativeArtifactVersion(
                id: wire.id,
                version: wire.version,
                content: wire.content,
                origin: nil,
                createdAt: createdAt
            )
        )
    }

    private func decodeConversationTitle(_ record: StoredRecord) -> String? {
        guard let payload = record.payload,
            let wire = try? JSONDecoder().decode(ConversationTitleWire.self, from: payload),
            wire.id == record.key.id, !wire.title.isEmpty
        else { return nil }
        return wire.title
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
public final class NativeArtifactModel<Repository: AccountScopedRepository> {
    public enum Phase: Equatable, Sendable {
        case idle
        case loading
        case ready
        case offline
        case failed
    }

    public private(set) var phase: Phase = .idle
    public private(set) var artifacts: [NativeArtifact] = []
    public private(set) var lastErrorDescription: String?
    public private(set) var isMutating = false
    public private(set) var isExporting = false
    public private(set) var availableExportFormats: [NativeArtifactExportFormat] = []
    public var selectedArtifactID: String?

    public var selectedArtifact: NativeArtifact? {
        artifacts.first { $0.id == selectedArtifactID }
    }

    private let store: NativeArtifactStore<Repository>
    private let syncModel: NativeSyncModel<Repository>
    private let apiClient: NativeArtifactAPIClient
    private var accountID: AccountID?
    private var lastSynchronizationGeneration = -1

    public init(
        repository: Repository,
        syncModel: NativeSyncModel<Repository>,
        sender: any NativeAuthenticatedRequestSending
    ) {
        store = NativeArtifactStore(repository: repository)
        self.syncModel = syncModel
        apiClient = NativeArtifactAPIClient(sender: sender)
    }

    public func start(for accountID: AccountID) async {
        guard self.accountID != accountID else {
            await reload()
            return
        }
        stop()
        self.accountID = accountID
        phase = .loading
        await reload()
    }

    public func stop() {
        accountID = nil
        artifacts = []
        selectedArtifactID = nil
        availableExportFormats = []
        lastErrorDescription = nil
        isMutating = false
        isExporting = false
        lastSynchronizationGeneration = -1
        phase = .idle
    }

    public func synchronizationDidAdvance(to generation: Int) async {
        guard generation != lastSynchronizationGeneration else { return }
        lastSynchronizationGeneration = generation
        await reload()
    }

    public func reload() async {
        guard let accountID else { return }
        do {
            let snapshot = try await store.load(
                accountID: StorageAccountID(accountID.rawValue)
            )
            guard self.accountID == accountID else { return }
            artifacts = snapshot.artifacts
            if let selectedArtifactID,
                !artifacts.contains(where: { $0.id == selectedArtifactID })
            { self.selectedArtifactID = nil }
            if selectedArtifactID == nil { selectedArtifactID = artifacts.first?.id }
            lastErrorDescription = nil
            switch syncModel.phase {
            case .offline:
                phase = .offline
            case .failed:
                // Same reasoning as NativeMemorySettingsStore.reload(): local
                // data loaded, but synchronization is refusing, so this is not
                // `.ready` with stale content and no explanation.
                phase = .failed
                lastErrorDescription = syncModel.lastErrorDescription
            case .idle, .synchronizing, .live:
                phase = .ready
            }
        } catch {
            guard self.accountID == accountID else { return }
            lastErrorDescription = error.localizedDescription
            phase = .failed
        }
    }

    public func openArtifact(id: String) async {
        selectedArtifactID = id
        availableExportFormats = []
        guard let accountID else { return }
        do {
            let detail = try await apiClient.artifact(id: id, for: accountID)
            guard self.accountID == accountID else { return }
            merge(detail)
            lastErrorDescription = nil
            phase = .ready
            do {
                availableExportFormats = try await apiClient.exportFormats(
                    id: id,
                    for: accountID
                )
            } catch {
                guard self.accountID == accountID else { return }
                availableExportFormats = []
            }
        } catch {
            guard self.accountID == accountID else { return }
            record(error)
        }
    }

    public func renameArtifact(id: String, title: String) async {
        await performMutation(id: id) { client, accountID in
            try await client.rename(id: id, title: title, for: accountID)
        }
    }

    public func saveArtifact(id: String, content: String) async {
        guard let artifact = artifacts.first(where: { $0.id == id }) else {
            lastErrorDescription = NativeArtifactStoreError.artifactNotFound(id)
                .localizedDescription
            return
        }
        await performMutation(id: id) { client, accountID in
            try await client.save(
                id: id,
                content: content,
                baseVersion: artifact.currentVersion,
                origin: .edit,
                for: accountID
            )
        }
    }

    public func restoreArtifact(id: String, version: Int) async {
        guard let artifact = artifacts.first(where: { $0.id == id }),
            let selected = artifact.versions.first(where: { $0.version == version })
        else {
            lastErrorDescription = NativeArtifactStoreError.artifactNotFound(id)
                .localizedDescription
            return
        }
        await performMutation(id: id) { client, accountID in
            try await client.save(
                id: id,
                content: selected.content,
                baseVersion: artifact.currentVersion,
                origin: .restore,
                for: accountID
            )
        }
    }

    public func deleteArtifact(id: String) async {
        guard let accountID else { return }
        isMutating = true
        defer { isMutating = false }
        do {
            try await apiClient.delete(id: id, for: accountID)
            guard self.accountID == accountID else { return }
            artifacts.removeAll { $0.id == id }
            if selectedArtifactID == id { selectedArtifactID = artifacts.first?.id }
            await syncModel.refresh()
            await reload()
        } catch {
            guard self.accountID == accountID else { return }
            record(error)
        }
    }

    public func exportArtifact(
        id: String,
        format: NativeArtifactExportFormat
    ) async -> NativeArtifactExport? {
        guard let accountID,
            let artifact = artifacts.first(where: { $0.id == id })
        else { return nil }
        isExporting = true
        defer { isExporting = false }
        do {
            let result = try await apiClient.export(
                id: id,
                title: artifact.title,
                format: format,
                for: accountID
            )
            guard self.accountID == accountID else { return nil }
            lastErrorDescription = nil
            return result
        } catch {
            guard self.accountID == accountID else { return nil }
            record(error)
            return nil
        }
    }

    private func performMutation(
        id: String,
        action: @escaping @Sendable (
            NativeArtifactAPIClient,
            AccountID
        ) async throws -> NativeArtifactDetail
    ) async {
        guard let accountID,
            artifacts.contains(where: { $0.id == id })
        else {
            lastErrorDescription = NativeArtifactStoreError.artifactNotFound(id)
                .localizedDescription
            return
        }
        isMutating = true
        defer { isMutating = false }
        do {
            let detail = try await action(apiClient, accountID)
            guard self.accountID == accountID else { return }
            merge(detail)
            await syncModel.refresh()
            await reload()
        } catch NativeArtifactAPIError.stale(let latest) {
            guard self.accountID == accountID else { return }
            if let latest { merge(latest) }
            lastErrorDescription = NativeArtifactAPIError.stale(latest).localizedDescription
            phase = .failed
        } catch {
            guard self.accountID == accountID else { return }
            record(error)
        }
    }

    private func merge(_ detail: NativeArtifactDetail) {
        guard let index = artifacts.firstIndex(where: { $0.id == detail.id }) else {
            return
        }
        artifacts[index].title = detail.title
        artifacts[index].currentVersion = detail.currentVersion
        artifacts[index].versions = detail.versions
        artifacts[index].updatedAt = detail.updatedAt
        artifacts.sort {
            if $0.updatedAt != $1.updatedAt { return $0.updatedAt > $1.updatedAt }
            return $0.id < $1.id
        }
    }

    private func record(_ error: any Error) {
        lastErrorDescription = error.localizedDescription
        if error is URLError {
            phase = .offline
        } else {
            phase = .failed
        }
    }
}

private struct ArtifactWire: Decodable {
    let id: String
    let conversationId: String
    let messageId: String?
    let identifier: String
    let title: String
    let type: String
    let language: String?
    let currentVersion: Int
    let createdAt: String
    let updatedAt: String
}

private struct ArtifactVersionWire: Decodable {
    let id: String
    let artifactId: String
    let version: Int
    let content: String
    let createdAt: String
}

private struct ConversationTitleWire: Decodable {
    let id: String
    let title: String
}

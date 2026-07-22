import Foundation
import JunoAuth
import JunoCore
import JunoStorage
import JunoSync
import Observation

public struct NativeProject: Identifiable, Equatable, Sendable {
    public let id: String
    public var name: String
    public var instructions: String
    public var starred: Bool
    public let createdAt: Date
    public var updatedAt: Date
    public let revision: UInt64
    public var isPending: Bool

    public init(
        id: String,
        name: String,
        instructions: String,
        starred: Bool,
        createdAt: Date,
        updatedAt: Date,
        revision: UInt64,
        isPending: Bool = false
    ) {
        self.id = id
        self.name = name
        self.instructions = instructions
        self.starred = starred
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.revision = revision
        self.isPending = isPending
    }
}

public struct NativeProjectFile: Identifiable, Equatable, Sendable {
    public let id: String
    public let projectID: String?
    public let conversationID: String?
    public let messageID: String?
    public var fileName: String
    public let kind: String
    public let mimeType: String
    public let size: Int
    public let width: Int?
    public let height: Int?
    public let createdAt: Date
    public let revision: UInt64

    public init(
        id: String,
        projectID: String?,
        conversationID: String?,
        messageID: String?,
        fileName: String,
        kind: String,
        mimeType: String,
        size: Int,
        width: Int?,
        height: Int?,
        createdAt: Date,
        revision: UInt64
    ) {
        self.id = id
        self.projectID = projectID
        self.conversationID = conversationID
        self.messageID = messageID
        self.fileName = fileName
        self.kind = kind
        self.mimeType = mimeType
        self.size = size
        self.width = width
        self.height = height
        self.createdAt = createdAt
        self.revision = revision
    }
}

public struct NativeProjectConversation: Identifiable, Equatable, Sendable {
    public let id: String
    public let projectID: String
    public var title: String
    public var pinned: Bool
    public var lastMessageAt: Date
    public let revision: UInt64

    public init(
        id: String,
        projectID: String,
        title: String,
        pinned: Bool,
        lastMessageAt: Date,
        revision: UInt64
    ) {
        self.id = id
        self.projectID = projectID
        self.title = title
        self.pinned = pinned
        self.lastMessageAt = lastMessageAt
        self.revision = revision
    }
}

public struct NativeProjectSnapshot: Equatable, Sendable {
    public let projects: [NativeProject]
    public let files: [NativeProjectFile]
    public let filesByProject: [String: [NativeProjectFile]]
    public let conversationsByProject: [String: [NativeProjectConversation]]
    public let pendingMutationCount: Int
    public let conflictedMutationCount: Int

    public init(
        projects: [NativeProject],
        files: [NativeProjectFile],
        filesByProject: [String: [NativeProjectFile]],
        conversationsByProject: [String: [NativeProjectConversation]],
        pendingMutationCount: Int,
        conflictedMutationCount: Int
    ) {
        self.projects = projects
        self.files = files
        self.filesByProject = filesByProject
        self.conversationsByProject = conversationsByProject
        self.pendingMutationCount = pendingMutationCount
        self.conflictedMutationCount = conflictedMutationCount
    }
}

public enum NativeProjectStoreError: Error, Equatable, LocalizedError, Sendable {
    case corruptRecord(RecordKey)
    case invalidMutation
    case invalidName
    case projectNotFound(String)
    case pendingProject(String)

    public var errorDescription: String? {
        switch self {
        case .corruptRecord:
            "Juno could not read the locally stored project data."
        case .invalidMutation:
            "Juno could not save this project change."
        case .invalidName:
            "Enter a project name between 1 and 160 characters."
        case .projectNotFound:
            "The project is no longer available."
        case .pendingProject:
            "Wait for this new project to finish synchronizing."
        }
    }
}

/// Projects the encrypted account cache and durable project outbox into one
/// offline-capable view. Signed attachment URLs are deliberately absent here.
public actor NativeProjectStore<Repository: AccountScopedRepository> {
    private let repository: Repository
    private let outbox: any MutationOutboxRepository

    public init(repository: Repository, outbox: any MutationOutboxRepository) {
        self.repository = repository
        self.outbox = outbox
    }

    public func load(accountID: StorageAccountID) async throws -> NativeProjectSnapshot {
        let snapshot = try await repository.snapshot(for: accountID)
        let mutations = try await outbox.mutations(accountID: accountID)
        var projects: [String: NativeProject] = [:]
        var allFiles: [NativeProjectFile] = []
        var conversations: [String: [NativeProjectConversation]] = [:]

        for record in snapshot.records.values where !record.isTombstone {
            switch record.key.namespace {
            case "project":
                let project = try decodeProject(record)
                projects[project.id] = project
            case "attachment":
                allFiles.append(try decodeFile(record))
            case "conversation":
                if let conversation = try decodeConversation(record) {
                    conversations[conversation.projectID, default: []].append(conversation)
                }
            default:
                break
            }
        }

        var pendingCount = 0
        var conflictCount = 0
        for mutation in mutations where mutation.draft.entity.namespace == "project" {
            switch mutation.state {
            case .pending, .leased, .retryScheduled:
                pendingCount += 1
                try apply(mutation, to: &projects)
            case .conflicted:
                conflictCount += 1
            case .acknowledged, .discarded:
                break
            }
        }

        let visibleProjectIDs = Set(projects.keys)
        allFiles.sort {
            $0.createdAt == $1.createdAt ? $0.id < $1.id : $0.createdAt > $1.createdAt
        }
        let projectFiles: [(String, NativeProjectFile)] = allFiles.compactMap { file in
            guard let projectID = file.projectID,
                visibleProjectIDs.contains(projectID)
            else { return nil }
            return (projectID, file)
        }
        let files = Dictionary(grouping: projectFiles, by: { $0.0 })
            .mapValues { $0.map(\.1) }
        conversations = conversations.reduce(into: [:]) { result, entry in
            guard visibleProjectIDs.contains(entry.key) else { return }
            result[entry.key] = entry.value.sorted {
                if $0.pinned != $1.pinned { return $0.pinned }
                if $0.lastMessageAt != $1.lastMessageAt {
                    return $0.lastMessageAt > $1.lastMessageAt
                }
                return $0.id < $1.id
            }
        }
        return NativeProjectSnapshot(
            projects: projects.values.sorted(by: projectOrder),
            files: allFiles,
            filesByProject: files,
            conversationsByProject: conversations,
            pendingMutationCount: pendingCount,
            conflictedMutationCount: conflictCount
        )
    }

    private func decodeProject(_ record: StoredRecord) throws -> NativeProject {
        guard let payload = record.payload,
            let wire = try? JSONDecoder().decode(ProjectWire.self, from: payload),
            wire.id == record.key.id, !wire.name.isEmpty,
            let createdAt = parseDate(wire.createdAt),
            let updatedAt = parseDate(wire.updatedAt)
        else { throw NativeProjectStoreError.corruptRecord(record.key) }
        return NativeProject(
            id: wire.id,
            name: wire.name,
            instructions: wire.instructions,
            starred: wire.starred,
            createdAt: createdAt,
            updatedAt: updatedAt,
            revision: record.revision
        )
    }

    private func decodeFile(_ record: StoredRecord) throws -> NativeProjectFile {
        guard let payload = record.payload,
            let wire = try? JSONDecoder().decode(AttachmentWire.self, from: payload),
            wire.id == record.key.id, !wire.fileName.isEmpty, !wire.kind.isEmpty,
            !wire.mimeType.isEmpty, wire.size >= 0,
            let createdAt = parseDate(wire.createdAt)
        else { throw NativeProjectStoreError.corruptRecord(record.key) }
        return NativeProjectFile(
            id: wire.id,
            projectID: wire.projectId,
            conversationID: wire.conversationId,
            messageID: wire.messageId,
            fileName: wire.fileName,
            kind: wire.kind,
            mimeType: wire.mimeType,
            size: wire.size,
            width: wire.width,
            height: wire.height,
            createdAt: createdAt,
            revision: record.revision
        )
    }

    private func decodeConversation(_ record: StoredRecord) throws
        -> NativeProjectConversation?
    {
        guard let payload = record.payload,
            let wire = try? JSONDecoder().decode(ProjectConversationWire.self, from: payload),
            wire.id == record.key.id, !wire.title.isEmpty,
            let lastMessageAt = parseDate(wire.lastMessageAt)
        else { throw NativeProjectStoreError.corruptRecord(record.key) }
        guard let projectID = wire.projectId, !projectID.isEmpty else { return nil }
        return NativeProjectConversation(
            id: wire.id,
            projectID: projectID,
            title: wire.title,
            pinned: wire.pinned,
            lastMessageAt: lastMessageAt,
            revision: record.revision
        )
    }

    private func apply(
        _ mutation: QueuedMutation,
        to projects: inout [String: NativeProject]
    ) throws {
        guard let object = try JSONSerialization.jsonObject(
            with: mutation.draft.payload
        ) as? [String: Any], object["type"] as? String == mutation.draft.operation
        else { throw NativeProjectStoreError.invalidMutation }
        switch mutation.draft.operation {
        case "project.create":
            guard let clientID = object["clientEntityId"] as? String,
                clientID == mutation.draft.entity.id,
                let name = object["name"] as? String, !name.isEmpty
            else { throw NativeProjectStoreError.invalidMutation }
            let now = mutation.draft.createdAt
            projects[clientID] = NativeProject(
                id: clientID,
                name: name,
                instructions: object["instructions"] as? String ?? "",
                starred: false,
                createdAt: now,
                updatedAt: now,
                revision: 0,
                isPending: true
            )
        case "project.update":
            let id = mutation.draft.entity.id
            if let name = object["name"] as? String { projects[id]?.name = name }
            if let instructions = object["instructions"] as? String {
                projects[id]?.instructions = instructions
            }
            if let starred = object["starred"] as? Bool { projects[id]?.starred = starred }
            projects[id]?.updatedAt = mutation.draft.createdAt
            projects[id]?.isPending = true
        case "project.delete":
            projects.removeValue(forKey: mutation.draft.entity.id)
        default:
            break
        }
    }

    private func projectOrder(_ lhs: NativeProject, _ rhs: NativeProject) -> Bool {
        if lhs.starred != rhs.starred { return lhs.starred }
        if lhs.updatedAt != rhs.updatedAt { return lhs.updatedAt > rhs.updatedAt }
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
}

@MainActor
@Observable
public final class NativeProjectModel<Repository: AccountScopedRepository> {
    public enum Phase: Equatable, Sendable {
        case idle
        case loading
        case ready
        case offline
        case failed
    }

    public private(set) var phase: Phase = .idle
    public private(set) var projects: [NativeProject] = []
    public private(set) var files: [NativeProjectFile] = []
    public private(set) var filesByProject: [String: [NativeProjectFile]] = [:]
    public private(set) var conversationsByProject: [String: [NativeProjectConversation]] = [:]
    public private(set) var pendingMutationCount = 0
    public private(set) var conflictedMutationCount = 0
    public private(set) var lastErrorDescription: String?
    public private(set) var isMutating = false
    public private(set) var isPerformingFileAction = false
    public var selectedProjectID: String?

    public var selectedProject: NativeProject? {
        projects.first { $0.id == selectedProjectID }
    }

    public var selectedFiles: [NativeProjectFile] {
        selectedProjectID.flatMap { filesByProject[$0] } ?? []
    }

    public var selectedConversations: [NativeProjectConversation] {
        selectedProjectID.flatMap { conversationsByProject[$0] } ?? []
    }

    private let store: NativeProjectStore<Repository>
    private let outbox: any MutationOutboxRepository
    private let drainer: NativeMutationDrainer<Repository>
    private let syncModel: NativeSyncModel<Repository>
    private let apiClient: NativeProjectAPIClient
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
        store = NativeProjectStore(repository: repository, outbox: outbox)
        self.outbox = outbox
        self.drainer = drainer
        self.syncModel = syncModel
        apiClient = NativeProjectAPIClient(sender: sender)
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
        await reconcilePendingMutations()
    }

    public func stop() {
        accountID = nil
        projects = []
        files = []
        filesByProject = [:]
        conversationsByProject = [:]
        pendingMutationCount = 0
        conflictedMutationCount = 0
        lastErrorDescription = nil
        isMutating = false
        isPerformingFileAction = false
        selectedProjectID = nil
        lastSynchronizationGeneration = -1
        phase = .idle
    }

    public func synchronizationDidAdvance(to generation: Int) async {
        guard generation != lastSynchronizationGeneration else { return }
        lastSynchronizationGeneration = generation
        await reconcilePendingMutations()
    }

    public func reload() async {
        guard let accountID else { return }
        do {
            let snapshot = try await store.load(
                accountID: StorageAccountID(accountID.rawValue)
            )
            guard self.accountID == accountID else { return }
            projects = snapshot.projects
            files = snapshot.files
            filesByProject = snapshot.filesByProject
            conversationsByProject = snapshot.conversationsByProject
            pendingMutationCount = snapshot.pendingMutationCount
            conflictedMutationCount = snapshot.conflictedMutationCount
            if let selectedProjectID,
                !projects.contains(where: { $0.id == selectedProjectID })
            { self.selectedProjectID = nil }
            if selectedProjectID == nil { selectedProjectID = projects.first?.id }
            lastErrorDescription = snapshot.conflictedMutationCount == 0
                ? nil : "A project change needs your attention."
            phase = syncModel.phase == .offline ? .offline : .ready
        } catch {
            guard self.accountID == accountID else { return }
            lastErrorDescription = error.localizedDescription
            phase = .failed
        }
    }

    @discardableResult
    public func createProject(name: String, instructions: String = "") async -> String? {
        guard let accountID else { return nil }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= 160 else {
            lastErrorDescription = NativeProjectStoreError.invalidName.localizedDescription
            return nil
        }
        let clientID = UUID().uuidString.lowercased()
        selectedProjectID = clientID
        await enqueueAndDrain(
            operation: "project.create",
            entityID: clientID,
            object: [
                "type": "project.create",
                "clientEntityId": clientID,
                "name": trimmed,
                "instructions": instructions,
            ],
            accountID: accountID
        )
        return clientID
    }

    public func updateProject(
        id: String,
        name: String? = nil,
        instructions: String? = nil,
        starred: Bool? = nil
    ) async {
        var object: [String: Any] = ["type": "project.update", "entityId": id]
        if let name {
            let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty, trimmed.count <= 160 else {
                lastErrorDescription = NativeProjectStoreError.invalidName.localizedDescription
                return
            }
            object["name"] = trimmed
        }
        if let instructions { object["instructions"] = instructions }
        if let starred { object["starred"] = starred }
        guard object.count > 2 else { return }
        await mutateExisting(id: id, operation: "project.update", object: object)
    }

    public func deleteProject(id: String) async {
        await mutateExisting(
            id: id,
            operation: "project.delete",
            object: ["type": "project.delete", "entityId": id]
        )
    }

    public func uploadFile(
        data: Data,
        fileName: String,
        mimeType: String,
        projectID: String
    ) async {
        guard let accountID, canUseServerProject(projectID) else { return }
        isPerformingFileAction = true
        defer { isPerformingFileAction = false }
        do {
            _ = try await apiClient.upload(
                data: data,
                fileName: fileName,
                mimeType: mimeType,
                projectID: projectID,
                for: accountID
            )
            await syncModel.refresh()
            await reload()
        } catch {
            recordFileError(error, accountID: accountID)
        }
    }

    public func renameFile(id: String, fileName: String) async {
        guard let accountID else { return }
        isPerformingFileAction = true
        defer { isPerformingFileAction = false }
        do {
            try await apiClient.renameFile(id: id, fileName: fileName, for: accountID)
            await syncModel.refresh()
            await reload()
        } catch {
            recordFileError(error, accountID: accountID)
        }
    }

    public func deleteFile(id: String) async {
        guard let accountID else { return }
        isPerformingFileAction = true
        defer { isPerformingFileAction = false }
        do {
            try await apiClient.deleteFile(id: id, for: accountID)
            await syncModel.refresh()
            await reload()
        } catch {
            recordFileError(error, accountID: accountID)
        }
    }

    public func accessFile(id: String) async -> NativeProjectFileAccess? {
        guard let accountID else { return nil }
        isPerformingFileAction = true
        defer { isPerformingFileAction = false }
        do {
            let access = try await apiClient.accessFile(id: id, for: accountID)
            guard self.accountID == accountID else { return nil }
            lastErrorDescription = nil
            return access
        } catch {
            recordFileError(error, accountID: accountID)
            return nil
        }
    }

    private func canUseServerProject(_ id: String) -> Bool {
        guard let project = projects.first(where: { $0.id == id }) else {
            lastErrorDescription = NativeProjectStoreError
                .projectNotFound(id).localizedDescription
            return false
        }
        guard !project.isPending else {
            lastErrorDescription = NativeProjectStoreError
                .pendingProject(id).localizedDescription
            return false
        }
        return true
    }

    private func mutateExisting(
        id: String,
        operation: String,
        object: [String: Any]
    ) async {
        guard let accountID, canUseServerProject(id) else { return }
        await enqueueAndDrain(
            operation: operation,
            entityID: id,
            object: object,
            accountID: accountID
        )
    }

    private func enqueueAndDrain(
        operation: String,
        entityID: String,
        object: [String: Any],
        accountID: AccountID
    ) async {
        guard JSONSerialization.isValidJSONObject(object),
            let payload = try? JSONSerialization.data(
                withJSONObject: object,
                options: [.sortedKeys]
            )
        else {
            lastErrorDescription = NativeProjectStoreError.invalidMutation.localizedDescription
            return
        }
        let draft = MutationDraft(
            id: OutboxMutationID(UUID().uuidString.lowercased()),
            accountID: StorageAccountID(accountID.rawValue),
            idempotencyKey: IdempotencyKey(UUID().uuidString.lowercased()),
            entity: RecordKey(namespace: "project", id: entityID),
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
            lastErrorDescription = error.localizedDescription
            phase = .failed
        }
    }

    private func reconcilePendingMutations() async {
        guard !isReconciling, let accountID else { return }
        isReconciling = true
        defer { isReconciling = false }
        do {
            let result = try await drainer.drain(for: accountID, owner: "project-ui")
            if result.acknowledged > 0 { await syncModel.refresh() }
            await reload()
            if result.retryScheduled > 0 {
                lastErrorDescription = "Project changes are saved and will sync when Juno reconnects."
                phase = .offline
            } else if result.conflicted > 0 {
                lastErrorDescription = "A project changed on another device. Refresh before retrying."
                phase = .failed
            }
        } catch {
            guard self.accountID == accountID else { return }
            lastErrorDescription = error.localizedDescription
            phase = .failed
        }
    }

    private func recordFileError(_ error: any Error, accountID: AccountID) {
        guard self.accountID == accountID else { return }
        lastErrorDescription = error.localizedDescription
        if error is URLError { phase = .offline }
    }

    /// Resolves every conflicted project mutation at once: retry replays the
    /// local change against the freshly synced revision, discard keeps the
    /// server version and drops the local edit.
    public func resolveConflicts(keepLocalChanges: Bool) async {
        guard let accountID else { return }
        if keepLocalChanges { await syncModel.refresh() }
        do {
            let storageAccountID = StorageAccountID(accountID.rawValue)
            let mutations = try await outbox.mutations(accountID: storageAccountID)
            for mutation in mutations
                where mutation.draft.entity.namespace == "project"
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
            lastErrorDescription = error.localizedDescription
            phase = .failed
        }
    }
}

private struct ProjectWire: Decodable {
    let id: String
    let name: String
    let instructions: String
    let starred: Bool
    let createdAt: String
    let updatedAt: String
}

private struct AttachmentWire: Decodable {
    let id: String
    let conversationId: String?
    let messageId: String?
    let projectId: String?
    let kind: String
    let fileName: String
    let mimeType: String
    let size: Int
    let width: Int?
    let height: Int?
    let createdAt: String
}

private struct ProjectConversationWire: Decodable {
    let id: String
    let title: String
    let pinned: Bool
    let projectId: String?
    let lastMessageAt: String
}
